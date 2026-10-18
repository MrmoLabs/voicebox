import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveSettings, validateSettings } from '../src/settings.js';
import { VoiceboxProxy } from '../src/proxy.js';
import { VOICE_DEFAULTS } from '../src/conversation.js';

const settings = { endpoint: 'http://127.0.0.1:17493', clientId: 'dsh-voicebox', profile: 'voice-2', language: 'zh', modelSize: '1.7B', readingMode: 'streaming', speechMode: 'checked', sessionIds: [], ...VOICE_DEFAULTS };

test('configuration is saved atomically at the editing revision; stale rejection is not reported as success', async () => {
  let snapshot = { status: 'ready', value: settings };
  const form = { async mutate(ops, revision) {
    assert.equal(revision, 5);
    assert.equal(ops.length, 15);
    assert.equal(ops.find(op => op.path[0] === 'modelSize').value, '1.7B');
  }, getSnapshot: () => snapshot };
  await saveSettings(form, settings, 5);
  snapshot = { status: 'ready', value: { ...settings, profile: 'newer-edit' } };
  await assert.rejects(saveSettings(form, settings, 5), /设置未生效/);
  assert.throws(() => validateSettings({ ...settings, endpoint: 'http://user:pass@localhost' }), /HTTP/);
  assert.throws(() => validateSettings({ ...settings, modelSize: 'unsupported' }), /模型/);
  assert.throws(() => validateSettings({ ...settings, recognitionScript: 'unsupported' }), /文字格式/);
});

test('voice directory only exposes profile metadata and marks incompatible voices', async () => {
  const proxy = new VoiceboxProxy({}, async () => Response.json([
    { id: 'clone', name: '克隆声音', language: 'zh', voice_type: 'cloned', avatar_path: '/private/path', design_prompt: 'private' },
    { id: 'design', name: '设计声音', language: 'en', voice_type: 'designed' },
  ]));
  const response = await proxy.handle(new Request('http://dsh/api/voicebox?path=/profiles'));
  assert.deepEqual(await response.json(), [
    { id: 'clone', name: '克隆声音', language: 'zh', voiceType: 'cloned', compatible: true },
    { id: 'design', name: '设计声音', language: 'en', voiceType: 'designed', compatible: false },
  ]);
});

test('selected model, profile and language are used by the host, overriding browser payload', async () => {
  let body;
  const proxy = new VoiceboxProxy(settings, async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ id: 'selected-settings' });
  });
  const result = await proxy.handle(new Request('http://dsh/api/voicebox?path=/speak', {
    method: 'POST', body: JSON.stringify({ session_id: 's', request_id: 'r', text: '设置测试', model_size: '0.6B', profile: 'browser-value', language: 'en' }),
  }));
  assert.equal(result.status, 200);
  assert.equal(body.model_size, '1.7B');
  assert.equal(body.profile, 'voice-2');
  assert.equal(body.language, 'zh');
  assert.equal(body.preview_mode, 'checked');
});
