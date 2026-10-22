import { expect, mock, test } from 'bun:test';
import { playAgentSpeech, type SpeechPlaybackTrace } from '../../app/src/lib/audio/agentSpeechPlayback';

let playerState: Record<string, unknown> = {};
mock.module('@/stores/livePlaybackStore', () => ({ useLivePlaybackStore: {
  getState: () => playerState,
  setState(value: Record<string, unknown> | ((state: Record<string, unknown>) => Record<string, unknown>)) { Object.assign(playerState, typeof value === 'function' ? value(playerState) : value); },
} }));
mock.module('@/stores/playerStore', () => ({ usePlayerStore: { getState: () => ({ reset() {}, volume: 0 }) } }));
mock.module('@/stores/serverStore', () => ({ useServerStore: { getState: () => ({ serverUrl: 'http://fixture' }) } }));
const { livePlayback } = await import('../../app/src/lib/audio/livePlayback');

function pcm(seconds: number) {
  const bytes = new Uint8Array(8 + Math.round(seconds * 8000) * 4), view = new DataView(bytes.buffer);
  view.setUint32(0, 8000, true); view.setUint32(4, (bytes.length - 8) / 4, true); return bytes;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

// The same PCM arrivals feed both actual production players. The manual audio
// clock measures scheduling differences only, without a model or output device.
test('the same slightly late PCM stays continuous in Voicebox and does not trigger a long DSH refill', async () => {
  const oldFetch = globalThis.fetch, oldContext = globalThis.AudioContext;
  const starts: number[][] = [[], []], contexts: Context[] = [], streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  class Context extends EventTarget {
    currentTime = 10; state = 'running'; destination = {}; index = contexts.length;
    constructor() { super(); contexts.push(this); }
    async resume() {} async close() { this.state = 'closed'; }
    createGain() { return { gain: { value: 0 }, connect() { return this; }, disconnect() {} }; }
    createBuffer(_channels: number, count: number, rate: number) { return { duration: count / rate, getChannelData: () => new Float32Array(count) }; }
    createBufferSource() { return { buffer: null, connect() { return this; }, disconnect() {}, stop() {}, start: (at: number) => starts[this.index].push(at) }; }
  }
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(controller) { streams.push(controller); } }))) as typeof fetch;
  playerState = { handledIds: new Set(), volume: 0 };
  const abort = new AbortController(), trace: SpeechPlaybackTrace[] = [];
  let task: Promise<void> | undefined;
  try {
    livePlayback.start('voicebox'); await tick();
    const context = new Context();
    task = playAgentSpeech({ generation_id: 'dsh', stream_audio: true }, 'http://fixture', abort.signal, () => {}, {
      context: context as unknown as AudioContext, resume: false, initialBufferSeconds: .04, bufferedStartSeconds: .8,
      trace: event => trace.push(event),
    });
    await tick(); expect(streams).toHaveLength(2);
    for (const [at, seconds] of [[0, .64], [.6, .64], [1.93, .64], [2.5, .64]]) {
      for (const c of contexts) c.currentTime = 10 + at;
      for (const stream of streams) stream.enqueue(pcm(seconds));
      await tick();
    }
    for (const stream of streams) { stream.enqueue(new Uint8Array(8)); stream.close(); }
    await tick();
    expect(playerState.underruns).toBe(0);
    expect(starts[0][2]).toBeCloseTo(starts[0][1] + .64);
    expect(trace.filter(event => event.kind === 'underrun')).toHaveLength(0);
    expect(starts[1][2] - starts[1][1] - .64).toBeCloseTo(.01);
    for (const c of contexts) c.currentTime = 20;
    await task;
    expect(trace.at(-1)).toMatchObject({ kind: 'completed', audioMs: 2560 });
  } finally {
    abort.abort(); livePlayback.stop(false); await task?.catch(() => {});
    globalThis.fetch = oldFetch; globalThis.AudioContext = oldContext;
  }
});
