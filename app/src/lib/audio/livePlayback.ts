import { PcmPacketDecoder } from '@/lib/audio/pcmPackets';
import { useLivePlaybackStore } from '@/stores/livePlaybackStore';
import { usePlayerStore } from '@/stores/playerStore';
import { useServerStore } from '@/stores/serverStore';

/** Prototype player: schedule bounded PCM buffers on the Web Audio clock. */
class LivePlayback {
  private context: AudioContext | null = null;
  private abort: AbortController | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private endTime = 0;
  private startTime = 0;
  private received = 0;
  private started = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private generationDone = false;
  private timeline: Array<{ start: number; duration: number }> = [];
  private completedSeconds = 0;

  prepare() {
    this.context ??= new AudioContext();
    return this.context.resume();
  }

  start(id: string) {
    this.stop(false);
    usePlayerStore.getState().reset();
    const handled = new Set(useLivePlaybackStore.getState().handledIds);
    handled.add(id);
    if (handled.size > 100) handled.delete(handled.values().next().value!);
    useLivePlaybackStore.setState({ id, status: 'buffering', receivedSeconds: 0,
      playedSeconds: 0, firstPlaybackMs: null, underruns: 0, error: null, handledIds: handled });
    const controller = new AbortController();
    this.abort = controller;
    this.started = performance.now();
    this.received = 0;
    this.endTime = 0;
    this.startTime = 0;
    this.generationDone = false;
    this.timeline = [];
    this.completedSeconds = 0;
    this.timer = setInterval(() => {
      if (!this.context || !this.startTime || controller.signal.aborted) return;
      const state = useLivePlaybackStore.getState();
      if (state.status === 'paused' || state.status === 'failed') return;
      const now = this.context.currentTime;
      while (this.timeline.length && now >= this.timeline[0].start + this.timeline[0].duration) {
        this.completedSeconds += this.timeline.shift()!.duration;
      }
      const next = this.timeline[0];
      const played = this.completedSeconds + (next ? Math.max(0, Math.min(next.duration, now - next.start)) : 0);
      const playing = this.context.state === 'running' && !!next && now >= next.start;
      if (state.firstPlaybackMs === null && now >= this.startTime) {
        useLivePlaybackStore.setState({ firstPlaybackMs: performance.now() - this.started });
      }
      useLivePlaybackStore.setState({ playedSeconds: played,
        status: this.generationDone && this.context.currentTime >= this.endTime ? 'finished' : playing ? 'playing' : 'buffering' });
    }, 100);
    void this.consume(id, controller).catch((error) => {
      if (!controller.signal.aborted) {
        this.haltSources();
        useLivePlaybackStore.setState({ status: 'failed', error: String(error.message || error) });
      }
    });
  }

  private async consume(id: string, controller: AbortController) {
    await this.prepare();
    const response = await fetch(`${useServerStore.getState().serverUrl}/generate/${id}/live`, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('Live preview unavailable; saved audio can be played when ready');
    const reader = response.body.getReader();
    const decoder = new PcmPacketDecoder();
    try {
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const packet of decoder.push(value)) {
          // Do not accumulate the entire text's audio in scheduled nodes.
          while (!controller.signal.aborted && this.context && this.endTime - this.context.currentTime > 6) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (controller.signal.aborted) return;
          this.schedule(packet.samples, packet.sampleRate);
        }
      }
      decoder.finish();
      this.generationDone = true;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private schedule(samples: Float32Array, rate: number) {
    const context = this.context!;
    const buffer = context.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = usePlayerStore.getState().volume;
    source.connect(gain).connect(context.destination);
    if (!this.startTime) {
      this.startTime = context.currentTime + 0.8;
      this.endTime = this.startTime;
    } else if (context.currentTime > this.endTime + 0.02) {
      useLivePlaybackStore.setState((state) => ({ underruns: state.underruns + 1 }));
      this.endTime = context.currentTime + 0.3;
    }
    source.start(this.endTime);
    this.timeline.push({ start: this.endTime, duration: samples.length / rate });
    this.endTime += samples.length / rate;
    this.received += samples.length / rate;
    this.sources.add(source);
    source.onended = () => { this.sources.delete(source); source.disconnect(); gain.disconnect(); };
    useLivePlaybackStore.setState({ receivedSeconds: this.received });
  }

  async togglePause() {
    if (!this.context) return;
    if (useLivePlaybackStore.getState().status === 'paused') {
      await this.context.resume();
      useLivePlaybackStore.setState({ status: 'buffering' });
    } else {
      await this.context.suspend();
      useLivePlaybackStore.setState({ status: 'paused' });
    }
  }

  private haltSources() {
    for (const source of this.sources) { try { source.stop(); } catch {} source.disconnect(); }
    this.sources.clear();
  }

  stop(cancelGeneration = true) {
    const id = useLivePlaybackStore.getState().id;
    const terminal = this.generationDone;
    this.abort?.abort();
    this.abort = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.haltSources();
    useLivePlaybackStore.setState({ id: null });
    if (cancelGeneration && id && !terminal) {
      void fetch(`${useServerStore.getState().serverUrl}/generate/${id}/cancel`, { method: 'POST' }).catch(() => {});
    }
  }
}

export const livePlayback = new LivePlayback();
