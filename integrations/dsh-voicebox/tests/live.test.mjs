import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SentenceBuffer, SentenceQueue } from '../src/sentences.js';
import { LiveNarration } from '../src/live.js';
import { SpeechBridge } from '../src/bridge.js';
import { DesktopSpeechController } from '../src/controller.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const sentence = n => `这是第${n}段正在逐步生成的正文内容，完整句子出现以后就可以开始朗读。`;
const capabilities = { paths: { '/speak/cancel': {} }, components: { schemas: { SpeakRequest: { properties: { request_id: {}, stream_audio: {} } } } } };

test('sentence cursor survives fragmented fences, links, inline code, comments and decimal numbers', () => {
  const pieces = [];
  const buffer = new SentenceBuffer(text => pieces.push(text));
  const input = `${sentence(1)}\n\`\`\`js\nsecret();\n\`\`\`\n[公开文档](https://example.com/private) 的值是 3.14。\n\`private inline\` <!-- hidden --> ${sentence(2)}\n| private table |`;
  for (const character of input) buffer.append(character);
  buffer.finish(); buffer.finish();
  const result = pieces.join('');
  assert.ok(pieces.length >= 2);
  assert.match(result, /公开文档/);
  assert.match(result, /3\.14/);
  assert.doesNotMatch(result, /secret|private|hidden|https|js/);
  assert.equal(result.match(/第1段/g).length, 1);
  const imagePieces = [];
  const splitImage = new SentenceBuffer(text => imagePieces.push(text));
  splitImage.append('这里是一段用于验证图片标记分片的正文内容，它没有提前结束的标点!');
  splitImage.append('[隐藏图片](https://example.com/private) 现在可以结束这一句了。');
  splitImage.finish();
  assert.doesNotMatch(imagePieces.join(''), /隐藏图片|private|!/);
  assert.throws(() => { const huge = new SentenceBuffer(() => {}); huge.append('x'.repeat(30_001)); }, /过长/);
});

function setup() {
  const requests = [], plays = [], releases = [], states = [];
  const session = { id: 's', header: {}, firstLiveSeq: 0 };
  let live, state = {}, seq = 10, attempt = 'attempt-1';
  const bridge = new SpeechBridge({ playbackOwner: 'client' }, {
    onInterrupt: () => live?.reset(), onSpeech: () => { throw new Error('must not use complete-reply delivery'); },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body && JSON.parse(init.body);
      requests.push({ path, body });
      return Response.json(path === '/openapi.json' ? capabilities : { id: `g-${requests.filter(r => r.path === '/speak').length}` });
    },
  });
  live = new LiveNarration(bridge, {
    update: values => { state = { ...state, ...values }; states.push(state); },
    failed: values => { state = { ...state, ...values }; states.push(state); },
    play: async generation => { plays.push(generation.id); await new Promise(resolve => releases.push(resolve)); },
  });
  const send = (type, data) => live.handle(session, { type, data, seq: ++seq });
  const chunk = value => send('assistant/live-chunk', { turn: 1, step: 1, attemptId: attempt, chunk: value });
  const begin = () => { send('turn/start', { turn: 1 }); send('user/message', { source: { kind: 'user' } }); };
  return { live, bridge, requests, plays, releases, states, send, chunk, begin, state: () => state,
    speech: () => requests.filter(r => r.path === '/speak'), setAttempt: id => { attempt = id; } };
}

test('first sentence starts before turn end; only one ahead is prepared; final settlement never replays text', async () => {
  const h = setup(); h.begin();
  h.chunk({ type: 'reasoning-delta', index: 0, text: 'private reasoning' });
  h.chunk({ type: 'tool-call-delta', index: 1, argumentsDelta: 'private arguments' });
  h.chunk({ type: 'text-delta', index: 2, text: sentence(1) });
  await tick();
  assert.equal(h.speech().length, 1, 'speech starts without turn/end');
  assert.deepEqual(h.plays, ['g-1']);
  h.chunk({ type: 'text-delta', index: 2, text: sentence(2) });
  h.chunk({ type: 'text-delta', index: 2, text: sentence(3) });
  await tick();
  assert.equal(h.speech().length, 2, 'one playing + one prepared, remaining text waits');
  h.send('assistant/message', { turn: 1, step: 1, message: { id: 'final', content: [{ type: 'text', text: sentence(1) + sentence(2) + sentence(3) }] } });
  h.send('assistant/retired', { attemptId: 'attempt-1' });
  h.send('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(h.state().activeMessageId, 'final');
  for (let n = 0; n < 3; n++) { h.releases.shift()(); await tick(); }
  await h.live.idle();
  assert.deepEqual(h.speech().map(r => r.body.text), [sentence(1), sentence(2), sentence(3)]);
  assert.deepEqual(h.plays, ['g-1', 'g-2', 'g-3']);
  assert.equal(h.state().phase, 'idle');
  assert.equal(new Set(h.speech().map(r => r.body.request_id)).size, 3);
  await h.bridge.dispose();
});

test('retry discards queued text, cancels accepted jobs, and does not read the retried answer again', async () => {
  const h = setup(); h.begin();
  h.chunk({ type: 'text-delta', index: 0, text: sentence(1) });
  await tick();
  h.chunk({ type: 'text-delta', index: 0, text: sentence(2) });
  await tick();
  h.send('llm/retry', { turn: 1, step: 1 });
  h.setAttempt('retry-2');
  h.chunk({ type: 'text-delta', index: 0, text: sentence(1) });
  h.send('assistant/message', { turn: 1, step: 1, message: { id: 'retried', content: [{ type: 'text', text: sentence(1) }] } });
  h.send('turn/end', { turn: 1, reason: { kind: 'completed' } });
  h.releases.shift()(); await tick();
  assert.equal(h.speech().length, 2);
  assert.equal(h.plays.length, 1);
  assert.equal(h.state().phase, 'error');
  assert.equal(h.state().turnFinished, true);
  assert.equal(h.state().activeMessageId, 'retried');
  assert.ok(h.requests.some(r => r.path === '/speak/cancel'));
  await h.bridge.dispose();
});

test('a host without transient frames falls back to the settled text even without a step field', async () => {
  const h = setup(); h.begin();
  h.send('assistant/message', { turn: 1, message: { id: 'fallback', content: [{ type: 'text', text: sentence(1) }] } });
  h.send('turn/end', { turn: 1, reason: { kind: 'completed' } }); await tick();
  assert.equal(h.speech().length, 1);
  assert.equal(h.speech()[0].body.text, sentence(1));
  h.releases.shift()(); await h.live.idle();
  assert.equal(h.state().phase, 'idle');
  await h.bridge.dispose();
});

test('long backlog is bounded and prepared failures are caught while the previous job is playing', async () => {
  let release, caught;
  const queue = new SentenceQueue({
    prepare: async item => { if (item.id === 'fail') throw new Error('prepare failed'); return item; },
    play: async () => new Promise(resolve => { release = resolve; }), waiting() {}, drained() {}, error: error => { caught = error; },
  });
  queue.enqueue('first', 'ok'); await tick();
  queue.enqueue('next', 'fail');
  for (let n = 0; n < 30; n++) queue.enqueue('pending', `p-${n}`);
  assert.ok(queue.pending.length <= 8);
  assert.equal(queue.characters, 'first'.length + 'next'.length + 30 * 'pending'.length + 22, 'coalesced newlines count toward the backend character limit');
  await tick(); release(); await queue.idle();
  assert.match(caught.message, /prepare failed/);
  assert.equal(queue.cancelled, true);
});

test('abandoned frames, failed finish and authoritative rewrites stop the current attempt without replay', async () => {
  for (const failure of ['abandoned', 'retired', 'error', 'rewrite']) {
    const h = setup(); h.begin();
    h.chunk({ type: 'text-delta', index: 0, text: sentence(1) }); await tick();
    if (failure === 'abandoned' || failure === 'retired') h.send(`assistant/${failure}`, { attemptId: 'attempt-1' });
    else if (failure === 'error') h.chunk({ type: 'finish', reason: { kind: 'error', failure: { message: 'provider error' } } });
    else h.send('assistant/message', { turn: 1, step: 1, message: { id: 'rewritten', content: [{ type: 'text', text: '替换为完全不同的内容。' }] } });
    h.releases.shift()(); await tick();
    assert.equal(h.state().phase, 'error');
    assert.equal(h.speech().length, 1);
    await h.bridge.dispose();
  }
});

function store(value) {
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, set(next) { value = next; for (const fn of listeners) fn(); } };
}

test('Desktop keeps streaming deltas in the background, preserves pause between pieces, and stops the live stream on submission', async t => {
  const keys = ['window', 'document', 'localStorage', 'AudioContext', '__DSH_TRANSPORT__'];
  const before = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  t.after(() => { for (const key of keys) { if (before[key] === undefined) delete globalThis[key]; else globalThis[key] = before[key]; } });
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => true });
  globalThis.localStorage = { getItem: () => 'on', setItem() {} };
  globalThis.AudioContext = class { state = 'running'; async resume() { this.state = 'running'; } async suspend() { this.state = 'suspended'; } async close() {} };
  const calls = [], plays = [], releases = [];
  globalThis.__DSH_TRANSPORT__ = { fetch: async (url, init) => {
    const path = new URL(url, 'http://dsh').searchParams.get('path');
    calls.push({ path, body: init.body && JSON.parse(init.body) });
    return Response.json(path === '/openapi.json' ? capabilities : { id: `g-${calls.length}` });
  } };
  let revision = 1, seq = 1;
  const events = store({ revision, entries: [], change: { kind: 'replace', entries: [] } });
  const session = store({ pendingSubmissions: [], subagent: null });
  const form = store({ value: { readingMode: 'streaming' } });
  const controller = new DesktopSpeechController({ sessions: { list: store({ byId: { s: {} } }), binding: () => ({ eventSource: events, session }) } }, async (job, _base, signal, update, options) => {
    plays.push({ job, signal, options }); update(500);
    await new Promise(resolve => { releases.push(resolve); signal.addEventListener('abort', resolve, { once: true }); });
  }, form);
  controller.select('s'); await controller.unlock();
  const append = (type, data, transient = false) => {
    const entry = { type: transient ? 'transient' : 'event', event: { type, data, seq: ++seq } };
    events.set({ revision: ++revision, entries: [], change: { kind: 'append', entries: [entry] } });
  };
  append('turn/start', { turn: 1 }); append('user/message', { source: { kind: 'user' } });
  const chunk = text => append('assistant/live-chunk', { attemptId: 'a', turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } }, true);
  chunk(sentence(1)); await tick();
  const cancelledBeforeBlur = calls.filter(call => call.path === '/speak/cancel').length;
  window.dispatchEvent(new Event('blur'));
  document.hidden = true;
  document.hasFocus = () => false;
  document.dispatchEvent(new Event('visibilitychange'));
  await tick();
  assert.equal(plays[0].signal.aborted, false, 'changing windows or minimizing must not cancel live playback');
  assert.equal(calls.filter(call => call.path === '/speak/cancel').length, cancelledBeforeBlur);
  controller.pause(); await tick();
  assert.equal(controller.state.phase, 'paused');
  chunk(sentence(2)); await tick();
  releases.shift()(); await tick();
  assert.equal(plays.length, 2);
  assert.equal(plays[1].options.resume, false, 'PCM player must not resume a user-paused context for the next sentence');
  assert.equal(controller.audio.state, 'suspended');
  assert.equal(controller.state.phase, 'paused');
  append('assistant/message', { turn: 1, step: 1, message: { id: 'complete', content: [{ type: 'text', text: sentence(1) + sentence(2) }] } });
  events.set({ revision: ++revision, entries: [], change: { kind: 'settle-assistant', attemptId: 'a' } });
  assert.equal(controller.state.phase, 'paused', 'DSH 0.2 successful-settlement cleanup must not cancel queued audio');
  assert.equal(controller.state.activeMessageId, 'complete', 'background settlement still binds the reply controls');
  document.hidden = false;
  document.hasFocus = () => true;
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
  await tick();
  assert.equal(plays.length, 2, 'returning to Desktop must not restart already consumed live pieces');
  const count = calls.filter(call => call.path === '/speak').length;
  session.set({ pendingSubmissions: [{}], subagent: null });
  assert.equal(plays[1].signal.aborted, true);
  session.set({ pendingSubmissions: [], subagent: null });
  chunk(sentence(3));
  append('turn/end', { turn: 1, reason: { kind: 'completed' } }); await tick();
  assert.equal(calls.filter(call => call.path === '/speak').length, count);
  assert.equal(controller.state.phase, 'idle');
  await controller.dispose();
});
