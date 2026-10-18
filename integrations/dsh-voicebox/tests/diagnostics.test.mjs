import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceboxProxy } from '../src/proxy.js';
import { SpeechBridge } from '../src/bridge.js';

function metadata() {
  return {
    '/health': { status: 'healthy', gpu_available: true, gpu_type: 'CUDA (test)' },
    '/openapi.json': { paths: { '/speak': { post: {} }, '/speak/cancel': { post: {} }, '/generate/{generation_id}/live': { get: {} } },
      components: { schemas: { SpeakRequest: { properties: { request_id: {}, stream_audio: {}, preview_mode: {}, playback_owner: {} } } } } },
    '/models/status': { models: [{ model_name: 'qwen-tts-1.7B', downloaded: true }, { model_name: 'whisper-turbo', downloaded: true }] },
    '/profiles': [{ id: 'voice', name: '声音', voice_type: 'cloned', reference_audio: '/private/audio', avatar_path: '/private/avatar' }],
    '/mcp/bindings': { items: [{ client_id: 'test-client', profile_id: 'voice' }] },
    '/settings/captures': { default_playback_voice_id: null, private_settings: 'private' },
  };
}
async function check(data, config = {}) {
  const calls = [];
  const proxy = new VoiceboxProxy({ modelSize: '1.7B', clientId: 'test-client', ...config }, async (url, init) => {
    calls.push({ path: new URL(url).pathname, ...init });
    const value = data[new URL(url).pathname];
    if (value instanceof Error) throw value;
    return value === undefined ? new Response('', { status: 404 }) : Response.json(value);
  });
  const response = await proxy.handle(new Request('http://dsh/api/voicebox?path=/diagnostics&profile=untrusted'));
  return { result: await response.json(), calls };
}

test('installation check resolves client/default/explicit voices, uses saved model and only reads metadata', async () => {
  for (const source of ['binding', 'default', 'id', 'name']) {
    const data = metadata();
    if (source === 'default') {
      data['/mcp/bindings'].items[0].profile_id = 'deleted';
      data['/settings/captures'].default_playback_voice_id = 'voice';
    }
    const { result, calls } = await check(data, { profile: source === 'id' ? 'voice' : source === 'name' ? '声音' : '' });
    assert.equal(result.status, 'pass'); assert.equal(result.checks.length, 6);
    assert(calls.every(call => call.method === 'GET' && call.headers['X-Voicebox-Client-Id'] === 'test-client'));
    assert(!JSON.stringify(result).includes('/private/')); assert(!JSON.stringify(result).includes('private_settings'));
    assert(!calls.some(call => /speak|transcribe|download|load/.test(call.path)));
    if (source === 'id' || source === 'name') assert(!calls.some(call => call.path === '/settings/captures'));
  }
});

test('installation check reports CPU, uncached selected models, incompatible and missing profiles', async () => {
  const data = metadata();
  data['/health'].gpu_type = 'MPS';
  data['/profiles'][0].voice_type = 'designed';
  let result = (await check(data, { modelSize: '0.6B', recognitionModel: 'base' })).result;
  assert.equal(result.status, 'error');
  for (const id of ['hardware', 'tts', 'asr', 'profile']) assert.equal(result.checks.find(item => item.id === id).status, 'error');
  result = (await check(metadata(), { profile: 'deleted' })).result;
  assert.equal(result.checks.find(item => item.id === 'profile').status, 'error', 'explicit selection never falls back to a default');
});

test('unavailable service and incomplete default metadata never produce a false pass', async () => {
  const data = metadata();
  data['/health'] = new Error('offline');
  const offline = await check(data);
  assert.equal(offline.result.status, 'error'); assert.equal(offline.calls.length, 1);
  const partial = metadata(); delete partial['/mcp/bindings']; delete partial['/settings/captures'];
  assert.equal((await check(partial)).result.status, 'warning');
  partial['/settings/captures'] = { default_playback_voice_id: 'voice' };
  assert.equal((await check(partial)).result.status, 'warning', 'unknown client binding can override an otherwise valid global default');
  const bound = metadata(); delete bound['/settings/captures'];
  assert.equal((await check(bound)).result.status, 'pass', 'a valid client binding takes precedence over unavailable global defaults');
  partial['/mcp/bindings'] = { items: [] }; partial['/settings/captures'] = {};
  assert.equal((await check(partial)).result.status, 'error');
});

test('old backend cannot silently use server-owned playback; diagnostics and bridge share the capability guard', async () => {
  for (const missing of ['owner', 'speak', 'live', 'method']) {
    const data = metadata();
    const schema = data['/openapi.json'];
    if (missing === 'owner') delete schema.components.schemas.SpeakRequest.properties.playback_owner;
    if (missing === 'speak') delete schema.paths['/speak'];
    if (missing === 'live') delete schema.paths['/generate/{generation_id}/live'];
    if (missing === 'method') schema.paths['/speak/cancel'] = { get: {} };
    assert.equal((await check(data)).result.checks.find(item => item.id === 'contract').status, 'error');
    const bridge = new SpeechBridge({}, { fetch: async () => Response.json(schema) });
    await assert.rejects(bridge.checkCapabilities(), /Update the Voicebox/);
  }
});

test('aborted installation checks propagate cancellation to all metadata requests', async () => {
  const controller = new AbortController();
  const seen = [];
  const proxy = new VoiceboxProxy({}, async (_url, init) => {
    seen.push(init.signal); controller.abort();
    throw new DOMException('Aborted', 'AbortError');
  });
  const response = await proxy.handle(new Request('http://dsh/api/voicebox?path=/diagnostics', { signal: controller.signal }));
  assert.equal(response.status, 502); assert(seen.every(signal => signal.aborted));
});
