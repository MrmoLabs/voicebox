// Explicit opt-in: real scoped cancellation and recovery. No physical playback,
// microphone, user configuration writes, model downloads or history deletion.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { VoiceboxProxy } from '../src/proxy.js';
import { PcmPacketDecoder } from '../../../app/src/lib/audio/pcmPackets.ts';

const [permission, destination] = process.argv.slice(2);
if (permission !== '--run' || !destination) throw new Error('Opt-in: bun tests/local-recovery-smoke.mjs --run <output-directory>');
const output = path.resolve(destination), base = 'http://127.0.0.1:17493';
await mkdir(output, { recursive: true });
const get = async route => {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(10_000) });
  assert(response.ok); return response.json();
};
const tasks = await get('/tasks/active');
assert.equal(tasks.downloads.length + tasks.generations.length, 0, 'Leave active user workloads alone');
const health = await get('/health');
assert(health.model_loaded && ['0.6B', '1.7B'].includes(health.model_size), 'Use an already loaded Qwen model');
const proxy = new VoiceboxProxy({ clientId: 'dsh-voicebox', modelSize: health.model_size, speechMode: 'realtime' });
const sessionId = `local-recovery-${crypto.randomUUID()}`, ownIds = new Set();
const result = { completed: false, modelSize: health.model_size, checks: {}, createdGenerations: [],
  scope: 'Real Qwen live PCM, duplicate/conflicting request identities, session-scoped cancellation and recovery. No microphone, physical sound, LLM, user config changes or history deletion.' };
const invoke = (route, body) => proxy.handle(new Request(`http://dsh/api/voicebox?path=${encodeURIComponent(route)}`,
  { signal: AbortSignal.timeout(120_000), ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }));
async function speak(requestId, text) {
  const response = await invoke('/speak', { session_id: sessionId, request_id: requestId, text });
  assert(response.ok); const generation = await response.json(); ownIds.add(generation.id); return generation;
}
async function terminal(id, wanted) {
  assert(ownIds.has(id));
  for (let n = 0; n < 100; n++) {
    const item = await get(`/history/${encodeURIComponent(id)}`);
    if (item.status === wanted) return item;
    await delay(100);
  }
  throw new Error('Generation did not reach its expected terminal state');
}
async function consume(id, { onFirst, expectCancelled = false } = {}) {
  assert(ownIds.has(id));
  const response = await invoke(`/generate/${id}/live`); assert(response.ok);
  const reader = response.body.getReader(), decoder = new PcmPacketDecoder();
  let packets = 0, failedTerminal = false, audioMs = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const packet of decoder.push(value)) {
        audioMs += packet.samples.length * 1000 / packet.sampleRate;
        if (++packets === 1) await onFirst?.();
      }
    }
    decoder.finish();
  } catch (error) {
    if (!expectCancelled || error.message !== 'Speech generation stopped before completing') throw error;
    failedTerminal = true;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  assert(packets > 0); assert.equal(failedTerminal, expectCancelled);
  return { packets, audioMs, failureTerminator: failedTerminal };
}
try {
  const longText = '这是正在推理的停止恢复验收。收到第一段声音以后只取消这个测试会话，不影响其他会话。'.repeat(8);
  const first = await speak('cancel-running', longText);
  const duplicate = await speak('cancel-running', longText);
  assert.equal(duplicate.id, first.id); result.checks.duplicateSameGeneration = true;
  const conflicting = await invoke('/speak', { session_id: sessionId, request_id: 'cancel-running', text: `${longText}内容已改变。` });
  assert.equal(conflicting.status, 409); result.checks.conflictingRequestRejected = true;
  let cancelledAt;
  const cancelled = await consume(first.id, { expectCancelled: true, onFirst: async () => {
    const wrong = await invoke('/speak/cancel', { session_id: `${sessionId}-other` }); assert(wrong.ok);
    assert.deepEqual((await wrong.json()).generation_ids, []);
    assert((await get('/tasks/active')).generations.some(task => task.task_id === first.id));
    result.checks.unrelatedSessionPreserved = true;
    cancelledAt = performance.now();
    const stop = await invoke('/speak/cancel', { session_id: sessionId, request_id: 'cancel-running' }); assert(stop.ok);
    assert.deepEqual((await stop.json()).generation_ids, [first.id]);
  } });
  result.cancelToObservedFailureMs = Math.round(performance.now() - cancelledAt);
  result.cancelledStream = cancelled;
  const failed = await terminal(first.id, 'failed'); assert.equal(failed.error, 'Generation cancelled');
  result.checks.cancelledStatusMatchesStream = true;
  const replay = await speak('cancel-running', longText); assert.equal(replay.id, first.id); assert.equal(replay.status, 'failed');
  assert(!(await get('/tasks/active')).generations.some(task => task.task_id === first.id));
  result.checks.cancelledIdentityNeverRegenerated = true;
  assert(!(await get('/tasks/active')).generations.some(task => !ownIds.has(task.task_id)), 'Other work started; stop this probe');
  const recovered = await speak('fresh-after-cancel', '取消测试已经结束，新的语音可以正常完成。');
  result.recoveredStream = await consume(recovered.id); await terminal(recovered.id, 'completed');
  result.checks.newRequestCompleted = true;
  for (const id of ownIds) {
    const cancel = await fetch(`${base}/generate/${encodeURIComponent(id)}/cancel`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
    assert(cancel.ok); const data = await cancel.json();
    assert.equal(data.status, id === first.id ? 'failed' : 'completed');
  }
  result.checks.terminalCancelIdempotent = true;
  const repeated = await invoke('/speak/cancel', { session_id: sessionId }); assert(repeated.ok);
  assert((await repeated.json()).generation_ids.every(id => ownIds.has(id)));
  assert(!(await get('/tasks/active')).generations.some(task => ownIds.has(task.task_id)));
  result.checks.noOwnWorkerRemaining = true; result.completed = true;
} finally {
  await proxy.dispose(); result.createdGenerations = [...ownIds];
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({ completed: result.completed, checks: result.checks, cancelToObservedFailureMs: result.cancelToObservedFailureMs }));
}
