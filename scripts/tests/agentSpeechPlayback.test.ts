import { expect, test } from 'bun:test';
import { playAgentSpeech } from '../../app/src/lib/audio/agentSpeechPlayback';

test('a queued PCM piece preserves a suspended shared context and abort stops scheduled nodes', async () => {
  let resumed = 0, stopped = 0, started = 0;
  const context = {
    state: 'suspended', currentTime: 0, destination: {},
    async resume() { resumed++; },
    createBuffer(_channels: number, count: number, rate: number) { return { duration: count / rate, getChannelData: () => new Float32Array(count) }; },
    createBufferSource() { return { connect() {}, disconnect() {}, start() { started++; }, stop() { stopped++; } }; },
  } as unknown as AudioContext;
  const pcm = new Uint8Array(8 + 4 + 8);
  const view = new DataView(pcm.buffer); view.setUint32(0, 24000, true); view.setUint32(4, 1, true);
  const abort = new AbortController();
  const task = playAgentSpeech({ generation_id: 'paused-piece', stream_audio: true }, 'http://fixture', abort.signal, () => {}, {
    context, resume: false, fetch: (async () => new Response(pcm)) as typeof fetch,
  });
  const settled = task.catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(resumed).toBe(0);
  expect(started).toBe(1);
  abort.abort();
  expect((await settled).name).toBe('AbortError');
  expect(stopped).toBe(1);
});

test('a prepared continuation starts promptly and reports a real PCM starvation as buffering', async () => {
  const starts: number[] = [], progress: Array<{ elapsed: number; buffering: boolean | undefined }> = [];
  let release: ReadableStreamDefaultController<Uint8Array>;
  const context = {
    state: 'running', currentTime: 10, destination: {},
    createBuffer(_channels: number, count: number, rate: number) { return { duration: count / rate, getChannelData: () => new Float32Array(count) }; },
    createBufferSource() { return { connect() {}, disconnect() {}, start(at: number) { starts.push(at); }, stop() {} }; },
  };
  const packet = new Uint8Array(8 + 240 * 4);
  const view = new DataView(packet.buffer); view.setUint32(0, 24000, true); view.setUint32(4, 240, true);
  const abort = new AbortController();
  const body = new ReadableStream<Uint8Array>({ start(controller) { release = controller; controller.enqueue(packet); } });
  const task = playAgentSpeech({ generation_id: 'next-piece', stream_audio: true }, 'http://fixture', abort.signal,
    (elapsed, buffering) => progress.push({ elapsed, buffering }), {
      context: context as unknown as AudioContext, resume: false, initialBufferSeconds: .04,
      fetch: (async () => new Response(body)) as typeof fetch,
    });
  const settled = task.catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(starts).toEqual([10.04]);
  context.currentTime = 10.045;
  await new Promise(resolve => setTimeout(resolve, 110));
  expect(progress.at(-1)?.buffering).toBe(false);
  context.currentTime = 11;
  await new Promise(resolve => setTimeout(resolve, 110));
  expect(progress.at(-1)?.buffering).toBe(true);
  expect(progress.at(-1)?.elapsed).toBeCloseTo(10);
  abort.abort(); await settled;
  // Keep the source referenced until cancellation has settled.
  expect(release!).toBeDefined();
});
