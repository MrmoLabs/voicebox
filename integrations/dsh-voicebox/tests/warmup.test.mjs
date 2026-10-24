import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceboxProxy } from '../src/proxy.js';
import { VoiceConversation } from '../src/conversation.js';

const schema = { paths: { '/profiles/{profile_id}/live-warmup': { post: { parameters: [{ name: 'only_if_cold', in: 'query' }] } } } };
function host(overrides = {}, config = {}) {
  const calls = [];
  const metadata = { '/openapi.json': schema, '/health': { status: 'healthy', gpu_available: true, gpu_type: 'CUDA (test)' },
    '/tasks/active': { generations: [], downloads: [] }, '/models/status': { models: [{ model_name: 'qwen-tts-1.7B', downloaded: true }] },
    '/profiles': [{ id: 'selected', name: 'configured voice', voice_type: 'cloned' }, { id: 'default', name: 'fallback' }],
    '/mcp/bindings': { items: [{ client_id: 'dsh-voicebox', profile_id: 'selected' }] }, '/settings/captures': { default_playback_voice_id: 'default' }, ...overrides };
  const proxy = new VoiceboxProxy({ modelSize: '1.7B', profile: 'configured voice', ...config }, async (url, init) => {
    const path = new URL(url).pathname; calls.push({ path, url, init });
    if (Object.hasOwn(metadata, path)) return Response.json(metadata[path]);
    assert.equal(path, '/profiles/selected/live-warmup');
    assert.equal(init.method, 'POST');
    assert.equal(new URL(url).searchParams.get('only_if_cold'), 'true');
    return Response.json({ ready: true });
  });
  const send = (body = { session_id: 's' }) => proxy.handle(new Request('http://host/api/voicebox?path=/warmup', { method: 'POST', body: JSON.stringify(body) }));
  return { proxy, calls, send };
}

test('silent preparation uses only host-selected cached model and voice, with no speech/history request', async () => {
  const h = host(); assert.equal((await (await h.send()).json()).ready, true);
  assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1);
  assert.ok(h.calls.at(-1).url.includes('model_size=1.7B'));
  assert.equal(h.proxy.sessions.size, 0); assert.equal(h.proxy.generations.size, 0);
  await h.proxy.dispose();
});

test('older services without guarded cold preparation remain usable and never receive a warmup POST', async () => {
  const h = host({ '/openapi.json': { paths: { '/profiles/{profile_id}/live-warmup': { post: {} } } } });
  assert.equal((await (await h.send()).json()).skipped, 'unsupported');
  assert.equal(h.calls.length, 1); await h.proxy.dispose();
});

test('busy, unknown, uncached or incompatible backends never start background inference', async () => {
  for (const overrides of [
    { '/tasks/active': { generations: [{}], downloads: [] } },
    { '/tasks/active': { generations: [], downloads: [{}] } },
    { '/tasks/active': {} }, { '/models/status': { models: [] } },
    { '/health': { status: 'healthy', gpu_available: false, gpu_type: 'CPU' } },
    { '/profiles': [{ id: 'selected', name: 'configured voice', voice_type: 'designed' }] },
  ]) {
    const h = host(overrides); assert.equal((await (await h.send()).json()).ready, false);
    assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 0); await h.proxy.dispose();
  }
});

test('default resolution shares binding precedence with speech and does not accept browser model/profile overrides', async () => {
  const h = host({}, { profile: '', sessionIds: ['allowed'] });
  assert.equal((await h.send()).status, 403);
  assert.equal((await h.send({ session_id: 'allowed', profile: 'default' })).status, 400);
  assert.equal((await (await h.send({ session_id: 'allowed' })).json()).ready, true);
  assert.equal(h.calls.at(-1).path, '/profiles/selected/live-warmup'); await h.proxy.dispose();
});

test('concurrent preparations share one owned flight and disposal aborts it without cancelling real speech', async () => {
  const started = Promise.withResolvers(); let requests = 0, sharedSignal;
  const original = host(); const metadata = original.proxy.fetcher;
  original.proxy.fetcher = async (url, init) => {
    if (init.method !== 'POST') return metadata(url, init);
    requests++; sharedSignal = init.signal; started.resolve();
    await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }));
    init.signal.throwIfAborted();
  };
  const first = original.send(), second = original.send(); await started.promise;
  assert.equal(requests, 1); await original.proxy.dispose();
  assert.equal(sharedSignal.aborted, true);
  for (const response of await Promise.all([first, second])) assert.equal((await response.json()).ready, false);
  assert.equal(original.calls.some(call => call.path === '/speak/cancel'), false);
});

test('preparation cannot postpone opening capture or sending the first utterance', async t => {
  const warm = Promise.withResolvers(), submitted = Promise.withResolvers(); let captureOpened = false, preparations = 0, feed;
  const snapshot = { pendingSubmissions: [] };
  const session = { getSnapshot: () => snapshot, beginSubmission: () => ({ requestId: 'first', abandon() {} }),
    async prompt() { submitted.resolve(); return { ok: true }; }, cancel() {}, subscribe: () => () => {} };
  const speaker = { sessionId: 's', state: { phase: 'idle' }, ctx: { sessions: { binding: () => ({ session }) } },
    async unlock() {}, setVoiceActive() {}, subscribe: () => () => {}, stop() {}, warmSpeech() { preparations++; return warm.promise; } };
  const service = new VoiceConversation(speaker, undefined, async url => Response.json(url.endsWith('/status') ? { ready: true }
    : url.endsWith('/listen') ? { text: '你好，请解释这个问题。' } : { ok: true }),
    async options => { captureOpened = true; feed = options.frame; return { close() {}, setMuted() {} }; });
  t.after(() => { service.dispose(); warm.resolve(); });
  await service.start(); assert.equal(captureOpened, true); assert.equal(preparations, 1);
  assert.equal(service.state.phase, 'listening'); assert.equal(service.inputPending(), false);
  for (let index = 0; index < 25; index++) feed(new Float32Array(320).fill(.1), 16000);
  for (let index = 0; index < 125; index++) feed(new Float32Array(320), 16000);
  await submitted.promise;
});
