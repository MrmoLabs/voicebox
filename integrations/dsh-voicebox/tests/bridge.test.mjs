import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpeechBridge, spokenText } from '../src/bridge.js';

const schema = { paths: { '/speak/cancel': {} }, components: { schemas: {
  SpeakRequest: { properties: { request_id: {}, stream_audio: {}, preview_mode: {} } },
} } };

function setup(config = {}, intercept) {
  const requests = [], errors = [];
  const bridge = new SpeechBridge(config, { warn: (message) => errors.push(message), fetch: async (url, init) => {
    const path = new URL(url).pathname;
    const data = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, data, headers: init.headers });
    if (intercept) await intercept(path, data);
    return Response.json(path === '/openapi.json' ? schema : { id: 'generation' });
  } });
  return { bridge, requests, errors, speech: () => requests.filter((request) => request.path === '/speak') };
}

const session = { id: 'session-a', header: {}, firstLiveSeq: 10 };
const event = (type, data, seq = 20) => ({ type, data, seq });
function begin(bridge, target = session, turn = 1) {
  bridge.handle(target, event('turn/start', { turn }));
  bridge.handle(target, event('user/message', { source: { kind: 'user' } }));
}
function answer(bridge, text, target = session, turn = 1, seq = 30) {
  bridge.handle(target, event('assistant/message', { turn, message: { content: [
    { type: 'reasoning', text: 'private reasoning' }, { type: 'text', text },
    { type: 'tool-call', name: 'shell', arguments: 'secret' },
  ] } }, seq));
}
function end(bridge, target = session, kind = 'completed', turn = 1) {
  bridge.handle(target, event('turn/end', { turn, reason: { kind } }));
}

test('reads final assistant text once with stable identity and no personality rewrite', async () => {
  const { bridge, speech } = setup();
  begin(bridge);
  answer(bridge, 'Working on tools.');
  answer(bridge, '# 完成\n可以使用了。', session, 1, 31);
  end(bridge);
  end(bridge);
  await bridge.idle();
  assert.equal(speech().length, 1);
  assert.deepEqual(speech()[0].data, {
    text: '完成\n可以使用了。', session_id: 'session-a', request_id: '1:31',
    engine: 'qwen', model_size: '0.6B', personality: false,
    stream_audio: true, playback_owner: 'voicebox', preview_mode: 'realtime',
  });
});

test('restored events, subagents, synthetic input, and failed turns are silent', async () => {
  const { bridge, speech } = setup();
  bridge.handle(session, event('turn/start', { turn: 1 }, 9));
  answer(bridge, 'History'); end(bridge);
  const child = { id: 'child', header: { origin: 'subagent' } };
  begin(bridge, child); answer(bridge, 'Child', child); end(bridge, child);
  bridge.handle(session, event('turn/start', { turn: 2 }));
  bridge.handle(session, event('user/message', { source: { kind: 'plugin' } }));
  answer(bridge, 'Automated', session, 2); end(bridge, session, 'completed', 2);
  begin(bridge); answer(bridge, 'Failed'); end(bridge, session, 'error');
  await bridge.idle();
  assert.equal(speech().length, 0);
});

test('last directly used conversation owns speech and allowlist filters others', async () => {
  const { bridge, speech } = setup();
  const other = { id: 'session-b', header: {} };
  begin(bridge); answer(bridge, 'Background');
  begin(bridge, other); answer(bridge, 'Foreground', other);
  end(bridge); end(bridge, other);
  await bridge.idle();
  assert.deepEqual(speech().map((request) => request.data.text), ['Foreground']);
  const filtered = setup({ sessionIds: ['session-a'] });
  begin(filtered.bridge, other); answer(filtered.bridge, 'Ignored', other); end(filtered.bridge, other);
  await filtered.bridge.idle();
  assert.equal(filtered.speech().length, 0);
});

test('pending cancellation completes before a new speech POST can be sent', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { bridge, speech } = setup({}, async (path) => { if (path === '/speak/cancel') await gate; });
  begin(bridge); answer(bridge, 'Wait for cancellation'); end(bridge);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(speech().length, 0);
  release();
  await bridge.idle();
  assert.equal(speech().length, 1);
});

test('new input during an accepted POST issues request-specific cancellation', async () => {
  let release, accepted;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { accepted = resolve; });
  const { bridge, requests } = setup({}, async (path) => {
    if (path === '/speak') { accepted(); await gate; }
  });
  begin(bridge); answer(bridge, 'Stale answer'); end(bridge);
  await entered;
  begin(bridge, session, 2);
  release();
  await bridge.idle();
  assert.ok(requests.some((request) => request.path === '/speak/cancel' && request.data.request_id === '1:30'));
});

test('old Voicebox build fails visibly without submitting speech', async () => {
  const errors = [], paths = [];
  const bridge = new SpeechBridge({}, { warn: (error) => errors.push(error), fetch: async (url) => {
    paths.push(new URL(url).pathname);
    return Response.json({});
  } });
  begin(bridge); answer(bridge, 'No old API'); end(bridge);
  await bridge.idle();
  assert.equal(paths.includes('/speak'), false);
  assert.match(errors[0], /Update the Voicebox/);
});

test('fenced code, URLs, images, tables, and comments are excluded', () => {
  assert.equal(spokenText('说明。\n```python\nprint("secret")\n```\n[文档](https://example.com)\n![图](img.png)\n| a | b |\n<!-- secret -->\n完成。'),
    '说明。\n文档\n\n完成。');
  assert.equal(spokenText('开始。\n~~~js\nunfinished secret'), '开始。');
});
