import type { AgentSpeechJob } from './agentSpeechQueue';
import { PcmPacketDecoder } from './pcmPackets';

function abortError() {
  return new DOMException('Speech stopped', 'AbortError');
}

function stopReason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : abortError();
}

function interruptible<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(stopReason(signal)); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    task.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

export type SpeechPlaybackTrace =
  | { kind: 'first'; afterMs: number; sampleRate: number }
  | { kind: 'ready'; afterMs: number; bufferedMs: number }
  | { kind: 'started' | 'aborted'; afterMs: number }
  | { kind: 'underrun'; gapMs: number; refillMs: number; bufferedMs?: number }
  | { kind: 'completed'; afterMs: number; audioMs: number }
  | { kind: 'failed'; afterMs: number; state: 'connect' | 'read' | 'decode' | 'schedule' | 'drain' };

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(stopReason(signal)); return; }
    const abort = () => { clearTimeout(timer); reject(stopReason(signal)); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function nextAudio(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { clean(); reject(stopReason(signal)); };
    const timer = setTimeout(() => { clean(); reject(new Error('Speech audio connection timed out')); }, 60_000);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    reader.read().then((result) => { clean(); resolve(result); }, (error) => { clean(); reject(error); });
  });
}

/** Each call owns its audio nodes; abort silences scheduled audio immediately. */
export async function playAgentSpeech(
  job: AgentSpeechJob, baseUrl: string, signal: AbortSignal,
  update: (elapsedMs: number, buffering?: boolean) => void,
  options: { fetch?: typeof fetch; context?: AudioContext; resume?: boolean; initialBufferSeconds?: number; bufferedStartSeconds?: number; trace?: (event: SpeechPlaybackTrace) => void } = {},
) {
  const id = encodeURIComponent(job.generation_id);
  if (!job.stream_audio) {
    await waitForSavedAudio(`${baseUrl}/generate/${id}/status`, signal);
    await playSavedAudio(`${baseUrl}/audio/${id}`, signal, update);
    return;
  }
  if (signal.aborted) throw abortError();
  const startedAt = performance.now();
  const trace = (event: SpeechPlaybackTrace) => { try { options.trace?.(event); } catch { /* Observability must never alter audio. */ } };
  let stage: 'connect' | 'read' | 'decode' | 'schedule' | 'drain' = 'connect';
  const context = options.context ?? new AudioContext();
  const audioAbort = new AbortController();
  const playbackSignal = AbortSignal.any([signal, audioAbort.signal]);
  const checkContext = () => {
    if (context.state === 'closed') audioAbort.abort(new Error('Speech audio context closed; start playback again'));
    playbackSignal.throwIfAborted();
  };
  const stateChanged = () => { if (context.state === 'closed') audioAbort.abort(new Error('Speech audio context closed; start playback again')); };
  const nodes = new Set<AudioBufferSourceNode>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const halt = () => {
    for (const node of nodes) {
      node.onended = null;
      try { node.stop(); } catch { /* already ended */ }
      node.disconnect();
    }
    nodes.clear();
    void reader?.cancel().catch(() => {});
    if (!options.context && context.state !== 'closed') void context.close().catch(() => {});
  };
  playbackSignal.addEventListener('abort', halt, { once: true });
  context.addEventListener?.('statechange', stateChanged);
  try {
    checkContext();
    if (options.resume !== false) await interruptible(context.resume(), playbackSignal);
    checkContext();
    const response = await (options.fetch ?? fetch)(`${baseUrl}/generate/${id}/live`, { signal: playbackSignal });
    checkContext();
    if (!response.ok || !response.body) throw new Error('Live speech is unavailable');
    reader = response.body.getReader();
    const decoder = new PcmPacketDecoder();
    let end = 0;
    let first = 0;
    let played = 0;
    let audioMs = 0;
    let firstPcm = false, playbackStarted = false;
    const observeStart = () => {
      if (!playbackStarted && first && context.currentTime >= first && context.state === 'running' && !playbackSignal.aborted) {
        playbackStarted = true; trace({ kind: 'started', afterMs: performance.now() - startedAt });
      }
    };
    const timeline: Array<{ start: number; duration: number }> = [];
    timer = setInterval(() => {
      const now = context.currentTime;
      if (!first || now < first || playbackSignal.aborted) return;
      observeStart();
      while (timeline.length && now >= timeline[0].start + timeline[0].duration) {
        played += timeline.shift()!.duration;
      }
      const next = timeline[0];
      update(1000 * (played + (next ? Math.max(0, Math.min(now - next.start, next.duration)) : 0)), !next || now < next.start);
    }, 100);
    // Opt-in actual PCM reserve. The legacy scheduling lead is unchanged for
    // other clients; a lead alone cannot protect against a late second packet.
    const reserve = Number.isFinite(options.bufferedStartSeconds) ? Math.max(0, Math.min(3, options.bufferedStartSeconds!)) : 0;
    let pending: ReturnType<PcmPacketDecoder['push']> = [], pendingSeconds = 0, refilling = false;
    const flush = async (complete = false) => {
      if (!pending.length || ((!first || refilling) && pendingSeconds + 1e-6 < reserve && !complete)) return;
      const bufferedMs = Math.round(pendingSeconds * 1000);
      if (!first && reserve) trace({ kind: 'ready', afterMs: performance.now() - startedAt, bufferedMs });
      const packets = pending; pending = []; pendingSeconds = 0; refilling = false;
      for (const packet of packets) {
        stage = 'schedule';
        // Backpressure bounds scheduled nodes and browser memory while the
        // server spools remaining PCM to disk.
        while (end - context.currentTime > 6) await wait(50, playbackSignal);
        checkContext();
        const buffer = context.createBuffer(1, packet.samples.length, packet.sampleRate);
        buffer.getChannelData(0).set(packet.samples);
        const node = context.createBufferSource();
        node.buffer = buffer;
        node.connect(context.destination);
        if (!first) end = context.currentTime + (options.initialBufferSeconds ?? 0.8);
        else if (end < context.currentTime) {
          const lead = reserve ? options.initialBufferSeconds ?? .04 : .3;
          trace({ kind: 'underrun', gapMs: (context.currentTime - end) * 1000, refillMs: lead * 1000, ...(reserve ? { bufferedMs } : {}) });
          end = context.currentTime + lead;
        }
        first ||= end;
        node.start(end);
        timeline.push({ start: end, duration: buffer.duration });
        end += buffer.duration;
        audioMs += buffer.duration * 1000;
        nodes.add(node);
        node.onended = () => { nodes.delete(node); node.disconnect(); };
      }
    };
    while (!playbackSignal.aborted) {
      stage = 'read';
      const { value, done } = await nextAudio(reader, playbackSignal);
      checkContext();
      if (done) break;
      stage = 'decode';
      const packets = decoder.push(value);
      for (const packet of packets) {
        if (!firstPcm) { firstPcm = true; trace({ kind: 'first', afterMs: performance.now() - startedAt, sampleRate: packet.sampleRate }); }
        pending.push(packet); pendingSeconds += packet.samples.length / packet.sampleRate;
      }
      if (reserve && first && end < context.currentTime && context.state === 'running') refilling = true;
      await flush(decoder.ended);
    }
    checkContext();
    stage = 'decode';
    decoder.finish();
    await flush(true);
    if (!first) throw new Error('Speech completed without audio');
    // Completion is the end of playback, not receipt of the final PCM frame.
    stage = 'drain';
    while (context.currentTime < end) { observeStart(); await wait(50, playbackSignal); }
    checkContext();
    observeStart();
    trace({ kind: 'completed', afterMs: performance.now() - startedAt, audioMs });
  } catch (error) {
    trace(signal.aborted ? { kind: 'aborted', afterMs: performance.now() - startedAt }
      : { kind: 'failed', afterMs: performance.now() - startedAt, state: stage });
    throw error;
  } finally {
    if (timer) clearInterval(timer);
    playbackSignal.removeEventListener('abort', halt);
    context.removeEventListener?.('statechange', stateChanged);
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); reader = undefined; }
    halt();
  }
}

function waitForSavedAudio(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const source = new EventSource(url);
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { source.close(); clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const abort = () => fail(abortError());
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error('Speech status connection timed out')), 60_000);
    };
    signal.addEventListener('abort', abort, { once: true });
    armTimeout();
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        armTimeout();
        if (data.status === 'completed') { cleanup(); resolve(); }
        else if (data.status === 'failed' || data.status === 'not_found') fail(new Error(data.error || 'Speech generation failed'));
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    };
  });
}

function playSavedAudio(url: string, signal: AbortSignal, update: (elapsedMs: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const audio = new Audio(url);
    const cleanup = () => {
      audio.onended = audio.onerror = audio.onplaying = audio.ontimeupdate = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      signal.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(abortError()); };
    signal.addEventListener('abort', abort, { once: true });
    audio.onplaying = audio.ontimeupdate = () => update(audio.currentTime * 1000);
    audio.onended = () => { cleanup(); resolve(); };
    audio.onerror = () => { cleanup(); reject(new Error('Speech playback failed')); };
    void audio.play().catch((error) => { cleanup(); reject(error); });
  });
}
