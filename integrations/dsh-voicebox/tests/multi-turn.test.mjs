// Coupled controller + microphone + durable/transient event regression.
// Scripted ASR/LLM/TTS; no hardware, credentials or model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesktopSpeechController, speechFetch } from '../src/controller.js';
import { VoiceConversation } from '../src/conversation.js';
import { encodeWav } from '../src/capture.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function store(value) {
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { value = next; for (const fn of listeners) fn(); }, get listenerCount() { return listeners.size; } };
}

test('25 coupled voice turns preserve ordered narration, background playback and bounded diagnostics; unload releases subscriptions', async t => {
  const globals = Object.fromEntries(['window', 'document', 'localStorage', 'AudioContext', '__DSH_TRANSPORT__'].map(key => [key, globalThis[key]]));
  t.after(() => { for (const [key, value] of Object.entries(globals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  globalThis.window = new EventTarget();
  let focused = true, contexts = 0, closedContexts = 0, closedMicrophones = 0, turn = 0, seq = 0, revision = 0;
  globalThis.document = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => focused });
  globalThis.localStorage = { getItem: () => null, setItem() { throw new Error('voice mode must not persist autoplay'); } };
  globalThis.AudioContext = class {
    state = 'running'; constructor() { contexts++; }
    async resume() { this.state = 'running'; } async suspend() { this.state = 'suspended'; }
    async close() { if (this.state !== 'closed') closedContexts++; this.state = 'closed'; }
  };
  const requests = [], played = [], submissions = [], ids = new Set();
  const entries = [], events = store({ revision, entries: [], change: { kind: 'replace', entries: [] } });
  const session = Object.assign(store({ running: false, subagent: null, pendingSubmissions: [] }), {
    beginSubmission() { const requestId = crypto.randomUUID(); assert(!ids.has(requestId)); ids.add(requestId); return { requestId, abandon() { throw new Error('unexpected abandoned submission'); } }; },
    async cancel() { throw new Error('normal turns and window changes must never cancel model output'); },
    async prompt(content, mode, signal, requestId) {
      assert.equal(signal.aborted, false); assert.equal(mode, 'queue'); assert(ids.has(requestId));
      submissions.push(content); session.set({ ...session.getSnapshot(), running: true });
      const n = ++turn, attemptId = `attempt-${n}`;
      const push = (type, data, transient = false) => {
        const entry = { type: transient ? 'transient' : 'event', event: { type, data, seq: ++seq } };
        if (!transient) entries.push(entry);
        events.set({ revision: ++revision, entries: [...entries], change: { kind: 'append', entries: [entry] } });
      };
      push('turn/start', { turn: n }); push('user/message', { source: { kind: 'user' }, content });
      push('assistant/live-chunk', { turn: n, step: 1, attemptId, chunk: { type: 'block-start', index: 0, blockType: 'text' } }, true);
      const text = `这是第${n}轮的第一段完整说明，我们会按顺序把这里的正文读完。\n\n\x60\x60\x60js\nPRIVATE_CODE();\n\x60\x60\x60\n\n| SECRET_TABLE | 数值 |\n| --- | --- |\n| 数据 | 1 |\n\n这是同一轮的第二段说明，我们保留代码和表格供页面查看。`;
      for (let at = 0; at < text.length; at += 7) push('assistant/live-chunk', { turn: n, step: 1, attemptId, chunk: { type: 'text-delta', index: 0, text: text.slice(at, at + 7) } }, true);
      push('assistant/message', { turn: n, step: 1, message: { id: `message-${n}`, content: [{ type: 'text', text }] } });
      push('turn/end', { turn: n, reason: { kind: 'completed' } });
      session.set({ ...session.getSnapshot(), running: false }); return { ok: true };
    },
  });
  const list = store({ byId: { s: {} } }), form = store({ value: { readingMode: 'complete', backgroundListening: true } });
  globalThis.__DSH_TRANSPORT__ = { fetch: async (url, init = {}) => {
    const path = new URL(url, 'http://dsh').searchParams.get('path');
    if (path === '/openapi.json') return Response.json({ paths: { '/speak': { post: {} }, '/speak/cancel': { post: {} }, '/generate/{id}/live': { get: {} } },
      components: { schemas: { SpeakRequest: { properties: { request_id: {}, stream_audio: {}, preview_mode: {}, playback_owner: {} } } } } });
    if (path === '/listen/status') return Response.json({ ready: true, model: 'turbo' });
    if (path === '/listen') return Response.json({ text: `请解释第${turn + 1}个问题。` });
    if (path === '/conversation') return Response.json({ ok: true });
    if (path === '/speak') {
      const body = JSON.parse(init.body); requests.push(body);
      assert.equal(body.playback_owner, 'client'); assert.equal(body.stream_audio, true);
      return Response.json({ id: `job-${requests.length}`, text: body.text });
    }
    if (path === '/speak/cancel') return Response.json({});
    throw new Error(`unexpected path ${path}`);
  } };
  const speaker = new DesktopSpeechController({ sessions: { list, binding: () => ({ session, eventSource: events }) } },
    async (job, _base, signal, update, options) => {
      assert.equal(signal.aborted, false); played.push(job.generation_id);
      options.trace({ kind: 'first', afterMs: 5, sampleRate: 24000 }); update(10, false);
      await tick(); assert.equal(signal.aborted, false); update(100, false);
      options.trace({ kind: 'completed', afterMs: 15, audioMs: 100 });
    }, form);
  const conversation = new VoiceConversation(speaker, form, speechFetch, async () => ({ close() { closedMicrophones++; }, setMuted() {}, echoCancellation: true }));
  speaker.conversation = conversation;
  t.after(() => speaker.dispose());
  speaker.select('s'); await conversation.start();
  const clip = encodeWav([new Float32Array(8000).fill(.1)], 16000);
  for (let n = 0; n < 25; n++) {
    if (n === 8 || n === 18) {
      focused = !focused; document.hidden = !focused;
      window.dispatchEvent(new Event(focused ? 'focus' : 'blur')); document.dispatchEvent(new Event('visibilitychange'));
    }
    await conversation.sendAudio(clip); await speaker.bridge.idle(); await speaker.live.idle(); await tick();
    assert.equal(conversation.state.active, true); assert.equal(conversation.state.phase, 'listening');
    assert.equal(submissions.length, n + 1); assert.equal(form.getSnapshot().value.readingMode, 'complete');
    assert.equal(speaker.diagnostics.snapshot().retained <= 512, true);
  }
  assert.equal(turn, 25); assert.equal(ids.size, 25); assert.equal(played.length, requests.length);
  assert.equal(new Set(played).size, played.length);
  assert(!JSON.stringify(requests).includes('PRIVATE_CODE')); assert(!JSON.stringify(requests).includes('SECRET_TABLE'));
  const diagnostics = speaker.diagnostics.snapshot();
  assert.equal(diagnostics.counts['input.accepted'], 25); assert.equal(diagnostics.counts['turn.end'], 25);
  assert.equal(diagnostics.counts['speech.ready'], played.length); assert.equal(diagnostics.counts['pcm.completed'], played.length);
  assert.equal(diagnostics.counts['pcm.underrun'] || 0, 0); assert.equal(diagnostics.dropped > 0, true);
  assert(!JSON.stringify(diagnostics).includes('PRIVATE_CODE')); assert(!JSON.stringify(diagnostics).includes('请解释'));
  await speaker.dispose();
  assert.equal(closedMicrophones, 1); assert.equal(contexts, 1); assert.equal(closedContexts, 1);
  assert.equal(session.listenerCount, 0); assert.equal(events.listenerCount, 0); assert.equal(form.listenerCount, 0);
});
