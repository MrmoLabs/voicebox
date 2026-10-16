import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyObserver, DesktopSpeechController } from '../src/controller.js';
import { VoiceboxProxy } from '../src/proxy.js';

const event = (type, data, seq = 1) => ({ type: 'event', event: { type, data, seq } });
const reply = (text, seq = 3) => event('assistant/message', { turn: 1, message: { id: `message-${text}`, content: [{ type: 'thinking', text: 'secret' }, { type: 'text', text }] } }, seq);
const start = event('turn/start', { turn: 1 });
const user = event('user/message', { source: { kind: 'user' } }, 2);
const end = event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4);
const snapshot = (revision, entries, kind = 'append') => ({ revision, entries, change: { kind, entries } });

test('history is manual-only; transient reasoning and prepend never autoplay; settlement is consumed once', () => {
  const seen = [], replies = [];
  const reader = new ReplyObserver((e) => seen.push(e), (text) => replies.push(text), () => {});
  reader.accept(snapshot(1, [start, user, reply('Old'), end], 'replace'), true);
  assert.deepEqual(replies, ['Old']); assert.equal(seen.length, 0);
  reader.accept(snapshot(2, [start, user]));
  reader.accept({ revision: 3, entries: [], change: { kind: 'settle-assistant', entry: reply('Final') } });
  reader.accept(snapshot(4, [end]));
  reader.accept(snapshot(4, [end]));
  reader.accept(snapshot(5, [reply('Earlier')], 'prepend'));
  assert.deepEqual(replies, ['Old', 'Final']);
  assert.equal(seen.length, 4);
  reader.accept(snapshot(6, [start, reply('Restored'), end], 'replace'));
  assert.equal(seen.length, 4);
});

test('proxy pins playback owner, voice configuration and client id; live bytes are scoped to issued jobs', async () => {
  const calls = [];
  const proxy = new VoiceboxProxy({ endpoint: 'http://127.0.0.1:17493', profile: 'Narrator', clientId: 'desktop' }, async (url, init) => {
    calls.push({ url, ...init, body: init.body && JSON.parse(init.body) });
    return url.endsWith('/live') ? new Response(new Uint8Array([1, 2, 3])) : Response.json({ id: 'gen-1' });
  });
  const request = (path, body) => proxy.handle(new Request(`http://dsh/api/voicebox?path=${encodeURIComponent(path)}`, body ? { method: 'POST', body: JSON.stringify(body) } : {}));
  assert.equal((await request('/generate/stolen/live')).status, 404);
  assert.equal((await request('http://external.invalid')).status, 404);
  assert.equal((await request('/speak', { session_id: 's', text: 'missing identity' })).status, 400);
  assert.equal((await request('/speak', { session_id: 's', request_id: 'r', text: 'Hello', playback_owner: 'voicebox', profile: 'Other' })).status, 200);
  assert.equal(calls[0].body.playback_owner, 'client');
  assert.equal(calls[0].body.profile, 'Narrator');
  assert.equal(calls[0].body.stream_audio, true);
  assert.equal(calls[0].headers['X-Voicebox-Client-Id'], 'desktop');
  assert.deepEqual([...new Uint8Array(await (await request('/generate/gen-1/live')).arrayBuffer())], [1, 2, 3]);
  await proxy.dispose();
  assert.equal(calls.at(-1).body.session_id, 's');
});

function store(value) {
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, set(next) { value = next; for (const fn of listeners) fn(); } };
}

test('Desktop controls use the shell fetch bridge, stop on submit and switch, and never replay restored replies', async (t) => {
  const previous = Object.fromEntries(['window', 'document', 'localStorage', 'AudioContext', '__DSH_TRANSPORT__'].map((key) => [key, globalThis[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => true });
  globalThis.localStorage = { getItem: () => 'on', setItem() {} };
  globalThis.AudioContext = class { state = 'running'; async resume() { this.state = 'running'; } async suspend() { this.state = 'suspended'; } async close() { this.state = 'closed'; } };
  const calls = [], plays = [];
  globalThis.__DSH_TRANSPORT__ = { fetch: async (url, init) => {
    const path = new URL(url, 'http://dsh').searchParams.get('path');
    calls.push({ path, body: init.body && JSON.parse(init.body) });
    return Response.json(path === '/openapi.json' ? { paths: { '/speak/cancel': {} }, components: { schemas: { SpeakRequest: { properties: { request_id: {}, stream_audio: {} } } } } } : { id: 'gen-1' });
  } };
  const events = store(snapshot(1, [start, user, reply('History'), end], 'replace'));
  const session = store({ subagent: null, pendingSubmissions: [] });
  const list = store({ current: 's1', byId: { s1: {}, s2: {} } });
  const controller = new DesktopSpeechController({ sessions: { list, binding: () => ({ eventSource: events, session }) } }, async (job, base, signal) => {
    plays.push({ job, signal });
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  });
  controller.select('s1');
  assert.equal(controller.state.latest, 'History'); assert.equal(calls.length, 0);
  assert.equal(controller.messageText('message-History'), 'History');
  controller.audio = new AudioContext();
  events.set(snapshot(2, [start, user, reply('Fresh'), end]));
  await controller.bridge.idle();
  assert.equal(calls.filter((c) => c.path === '/speak').length, 1);
  assert.equal(plays.length, 1); assert.equal(plays[0].job.stream_audio, true);
  assert.equal(controller.state.activeMessageId, 'message-Fresh');
  assert.equal(controller.messageText('message-History'), 'History');
  events.set({ ...snapshot(3, [reply('Ancient')], 'prepend'), entries: [reply('Ancient'), start, user, reply('Fresh'), end] });
  assert.equal(controller.messageText('message-Ancient'), 'Ancient');
  assert.equal(controller.state.activeMessageId, 'message-Fresh');
  assert.equal(controller.state.latest, 'Fresh');
  controller.read('message-History');
  await controller.bridge.idle();
  assert.equal(calls.filter(c => c.path === '/speak').at(-1).body.text, 'History');
  assert.equal(controller.state.activeMessageId, 'message-History');
  assert.equal(plays[0].signal.aborted, true);
  await controller.unlock();
  controller.pause();
  await Promise.resolve();
  assert.equal(controller.state.phase, 'paused');
  session.set({ subagent: null, pendingSubmissions: [{}] });
  assert.equal(plays[1].signal.aborted, true);
  assert.equal(controller.state.activeMessageId, undefined);
  session.set({ subagent: null, pendingSubmissions: [] });
  events.set(snapshot(4, [
    event('turn/start', { turn: 2 }, 8), event('user/message', { source: { kind: 'user' } }, 9),
    event('assistant/message', { turn: 2, message: { id: 'message-AfterPause', content: [{ type: 'text', text: 'After pause' }] } }, 10),
    event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 11),
  ]));
  await controller.bridge.idle();
  assert.equal(controller.audio.state, 'running');
  assert.equal(controller.state.activeMessageId, 'message-AfterPause');
  assert.equal(plays.length, 3, 'autoplay resumes the previously unlocked context after stopping a paused reply');
  list.set({ current: 's2', byId: { s1: {}, s2: {} } });
  controller.select('s2');
  assert.equal(controller.state.latest, 'After pause');
  assert.equal(calls.filter((c) => c.path === '/speak').length, 3);
  document.hidden = true;
  events.set(snapshot(5, [start, user, reply('Background'), end]));
  await controller.bridge.idle();
  assert.equal(calls.filter((c) => c.path === '/speak').length, 3);
  await controller.dispose();
});
