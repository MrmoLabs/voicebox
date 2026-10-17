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
