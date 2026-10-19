import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransitionAudio } from '../src/transition-audio.js';
import { loadTransition, playTransition, transitionKey } from '../src/transition-speech.js';
import { SentenceQueue } from '../src/sentences.js';
import { DesktopSpeechController } from '../src/controller.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
test('cached waiting clips are bounded, spaced, interruptible and never synthesized in a gap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0; const loads = [], plays = [];
  const player = new TransitionAudio({ now: () => now, eligible: () => true,
    load: async kind => { loads.push(kind); return { kind }; },
    play: async (_clip, kind, signal) => { plays.push({ kind, signal }); },
  }); t.after(() => player.stop()); player.configure('voice-a', true); await player.warm();
  player.begin(); player.wait(true); t.mock.timers.tick(1100); await tick();
  assert.equal(plays.length, 1); assert.equal(plays[0].kind, 'initial');
  player.wait(true); t.mock.timers.tick(5000); await tick(); assert.equal(plays.length, 1);
  player.audioReady(); player.wait(false); t.mock.timers.tick(20000); await tick(); assert.equal(plays.length, 1, 'mid-sentence gaps stay silent');
  now = 16_000; player.wait(true); t.mock.timers.tick(1100); await tick(); assert.equal(plays.length, 2);
  now = 32_000; player.wait(true); t.mock.timers.tick(1100); await tick(); assert.equal(plays.length, 3);
  now = 48_000; player.wait(true); t.mock.timers.tick(20000); await tick(); assert.equal(plays.length, 3, 'three cues per response is the hard cap');
  assert.deepEqual(loads, ['initial', 'gap']);
});

test('real PCM, new input, disabling and voice replacement cancel waiting speech without late replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const plays = [];
  const player = new TransitionAudio({ eligible: () => true, load: async () => ({}),
    play: (_clip, _kind, signal) => { plays.push(signal); return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
  }); t.after(() => player.stop()); player.configure('a', true); await player.warm();
  player.begin(); player.wait(true); t.mock.timers.tick(1100); await tick();
  player.audioReady(); assert.equal(plays[0].aborted, true);
  player.begin(); player.wait(true); player.cancel(); t.mock.timers.tick(30000); await tick(); assert.equal(plays.length, 1);
  player.begin(); player.wait(true); player.configure('b', false); t.mock.timers.tick(30000); await tick();
  assert.equal(player.cache.size, 0); assert.equal(plays.length, 1);
});

test('late warmup completion cannot populate another voice or interfere with answer generation', async t => {
  let release, observed;
  const player = new TransitionAudio({ eligible: () => true, load: (_kind, _key, signal) => { observed = signal; return new Promise(resolve => { release = resolve; }); }, play() {} });
  t.after(() => player.stop()); player.configure('a', true); const warming = player.warm();
  player.begin(); assert.equal(observed.aborted, true); player.configure('b', true);
  release({}); await warming; assert.equal(player.cache.size, 0);
});

function pcm(seconds = .2, value = .05) {
  const count = Math.round(seconds * 8000), bytes = new Uint8Array(8 + count * 4 + 8), view = new DataView(bytes.buffer);
  view.setUint32(0, 8000, true); view.setUint32(4, count, true);
  for (let i = 0; i < count; i++) view.setFloat32(8 + i * 4, value, true);
  return bytes;
}
function storage(t) {
  const previous = globalThis.localStorage, data = new Map();
  globalThis.localStorage = { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
  t.after(() => { globalThis.localStorage = previous; }); return data;
}
test('transition cache persists only bounded audio for the selected voice and does not repeat speech requests', async t => {
  storage(t); const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, body: init?.body && JSON.parse(init.body) });
    return url.endsWith('/speak') ? Response.json({ id: 'fixed-clip' }) : new Response(pcm());
  };
  const key = transitionKey({ profile: 'voice-a', modelSize: '1.7B', language: 'zh' });
  const clip = await loadTransition('initial', key, 's', fetcher, new AbortController().signal);
  assert.equal(clip.samples.length, 1600); assert.equal(requests[0].body.text, '我想想。');
  await loadTransition('initial', key, 'other-session', fetcher, new AbortController().signal);
  assert.equal(requests.length, 2, 'a persisted clip needs neither TTS nor another backend fetch');
  const otherKey = transitionKey({ profile: 'voice-b', modelSize: '1.7B', language: 'zh' });
  await loadTransition('initial', otherKey, 's', fetcher, new AbortController().signal); assert.equal(requests.length, 4);
});

test('invalid, oversized or cancelled hint audio is never cached and uses request-scoped cancellation', async t => {
  const saved = storage(t), requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, body: init?.body && JSON.parse(init.body) });
    return url.endsWith('/speak') ? Response.json({ id: 'bad-clip' }) : url.endsWith('/live') ? new Response(pcm(4.1)) : Response.json({});
  };
  await assert.rejects(loadTransition('gap', 'key', 's', fetcher, new AbortController().signal), /too long/);
  assert.equal(saved.size, 0);
  const cancel = requests.find(request => request.url.endsWith('/cancel'));
  assert.equal(cancel.body.request_id, requests[0].body.request_id); assert.equal(cancel.body.session_id, 's');
});

test('cached hint nodes share the granted context and release even when pause prevents onended', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let disconnected = 0, started = 0;
  const context = { state: 'running', currentTime: 1, destination: {},
    createBuffer: (_channels, count) => ({ getChannelData: () => new Float32Array(count) }),
    createBufferSource: () => ({ connect() {}, start() { started++; }, stop() {}, disconnect() { disconnected++; } }),
    createGain: () => ({ connect() {}, disconnect() { disconnected++; }, gain: { value: .8, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} } }),
  };
  const abort = new AbortController();
  const playing = playTransition(context, { rate: 8000, samples: new Float32Array(1600) }, abort.signal);
  abort.abort(); context.state = 'suspended'; t.mock.timers.tick(25); await playing;
  assert.equal(started, 1); assert.equal(disconnected, 2);
});

test('waiting boundaries are published only after the preceding answer audio has finished', async () => {
  const boundaries = []; let release;
  const queue = new SentenceQueue({ prepare: async item => item,
    play: async item => { if (item.id === 'first') await new Promise(resolve => { release = resolve; }); },
    preparing: previous => boundaries.push(previous?.text), waiting() {}, drained() {}, error(error) { throw error; },
  });
  queue.enqueue('逗号处还有下半句，', 'first'); queue.enqueue('到这里才是句末。', 'second');
  await tick(); assert.deepEqual(boundaries, [undefined]); release(); queue.finish(); await queue.idle();
  assert.deepEqual(boundaries, [undefined, '逗号处还有下半句，']);
});

test('the production controller warms idle audio, yields hints to PCM and input, and never counts a hint as delivered content', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  storage(t); localStorage.setItem('dsh-voicebox:s', 'on');
  const priorAudio = globalThis.AudioContext, priorTransport = globalThis.__DSH_TRANSPORT__;
  let activeNodes = 0, hintStarts = 0, pendingInput = false, releaseBody;
  globalThis.AudioContext = class {
    state = 'running'; currentTime = 1; destination = {};
    async resume() {} async close() { this.state = 'closed'; }
    createBuffer(_channels, count) { return { getChannelData: () => new Float32Array(count) }; }
    createBufferSource() { let connected = true; activeNodes++; return { connect() {}, start() { hintStarts++; }, stop() {}, disconnect() { if (connected) { connected = false; activeNodes--; } } }; }
    createGain() { return { connect() {}, disconnect() {}, gain: { value: .8, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} } }; }
  };
  t.after(() => { globalThis.AudioContext = priorAudio; globalThis.__DSH_TRANSPORT__ = priorTransport; });
  const speech = [];
  globalThis.__DSH_TRANSPORT__ = { fetch: async (url, init) => {
    const operation = new URL(url, 'http://fixture').searchParams.get('path');
    if (operation === '/speak') { const body = JSON.parse(init.body); speech.push(body); return Response.json({ id: `generation-${speech.length}`, text: body.text }); }
    if (operation?.endsWith('/live')) return new Response(pcm());
    if (operation === '/openapi.json') return Response.json({ paths: { '/speak': { post: {} }, '/speak/cancel': { post: {} }, '/generate/{generation_id}/live': { get: {} } }, components: { schemas: { SpeakRequest: { properties: { request_id: {}, stream_audio: {}, preview_mode: {}, playback_owner: {} } } } } });
    return Response.json({});
  } };
  const store = initial => {
    let value = initial; const listeners = new Set();
    return { getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, set(next) { value = next; for (const fn of listeners) fn(); } };
  };
  const session = store({ running: false, pendingSubmissions: [], subagent: null });
  const source = store({ revision: 0, entries: [], change: { kind: 'replace' } });
  const ctx = { sessions: { list: store({ byId: { s: {} } }), binding: () => ({ session, eventSource: source }) } };
  const form = store({ value: { profile: 'voice-a', modelSize: '1.7B', recognitionLanguage: 'zh', readingMode: 'streaming', transitionSounds: true } });
  const controller = new DesktopSpeechController(ctx, async (_job, _url, _signal, update, options) => {
    options.trace({ kind: 'first', afterMs: 1, sampleRate: 8000 }); update(1, false);
    await new Promise(resolve => { releaseBody = resolve; });
  }, form);
  controller.select('s'); await controller.unlock();
  t.mock.timers.tick(500); await tick();
  assert.equal(controller.transitions.cache.size, 2);
  controller.conversation = { inputPending: () => pendingInput, generating: () => session.getSnapshot().running, end() {}, dispose() {} };
  controller.setVoiceActive(true); controller.transitions.delay = 30; controller.transitions.cooldown = 0;
  let seq = 0, revision = 0; const entries = [];
  const emit = (type, data) => { const entry = { type: 'event', event: { type, data, seq: ++seq } }; entries.push(entry); source.set({ revision: ++revision, entries: [...entries], change: { kind: 'append', entries: [entry] } }); };
  session.set({ ...session.getSnapshot(), running: true });
  emit('turn/start', { turn: 1 }); emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '普通问题' }] });
  t.mock.timers.tick(30); await tick(); assert.equal(hintStarts, 1);
  assert.equal(controller.delivery.snapshot().pending, 0); assert.deepEqual(controller.delivery.snapshot().completedSteps, []);
  const cachedRequests = speech.length;
  emit('assistant/message', { turn: 1, step: 1, message: { id: 'answer', content: [{ type: 'text', text: '这是一段用于测试正文优先播放并且不被等待提示打断的完整回答。' }] } });
  await tick(); t.mock.timers.tick(25); await tick();
  assert.equal(activeNodes, 0); assert.equal(controller.state.transitionPlaying, false);
  controller.update({ phase: 'buffering' }); t.mock.timers.tick(3000); await tick();
  assert.equal(hintStarts, 1, 'PCM starvation inside a sentence cannot insert a filler');
  releaseBody(); await tick(); t.mock.timers.tick(30); await tick();
  assert.equal(hintStarts, 2, 'a waiting sentence boundary may use the cached hum');
  assert.equal(speech.length, cachedRequests + 1, 'only real answer text was synthesized during the response');
  pendingInput = true; controller.reconcileTransitions(); t.mock.timers.tick(25); await tick(); assert.equal(activeNodes, 0);
  assert.equal(controller.delivery.snapshot().recent.includes('我想想'), false);
  await controller.dispose(); t.mock.timers.tick(2000); await tick();
  assert.equal(activeNodes, 0); assert.equal(controller.audio.state, 'closed');
});
