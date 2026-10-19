import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UtteranceDetector, encodeWav, audioBase64 } from '../src/capture.js';
import { VoiceConversation, VOICE_DEFAULTS } from '../src/conversation.js';
import { VoiceboxProxy } from '../src/proxy.js';
import { DesktopSpeechController } from '../src/controller.js';
import { isPlaybackEcho } from '../src/echo.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const pcm = (value = .1) => new Float32Array(320).fill(value);
const wav = () => encodeWav([new Float32Array(8000).fill(.1)], 16000);
function utterance(feed) { for (let n = 0; n < 25; n++) feed(pcm(), 16000); for (let n = 0; n < 125; n++) feed(pcm(0), 16000); }
function store(value) {
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { value = next; for (const fn of listeners) fn(); } };
}

test('endpointing ignores clicks, retains speech across short pauses and bounds continuous speech', () => {
  let starts = 0;
  const clips = [];
  const detector = new UtteranceDetector({ sampleRate: 16000, silenceMs: 750, started: () => starts++, utterance: bytes => clips.push(bytes) });
  for (let n = 0; n < 4; n++) detector.push(pcm());
  for (let n = 0; n < 40; n++) detector.push(pcm(0));
  assert.equal(starts, 0);
  for (let n = 0; n < 25; n++) detector.push(pcm());
  for (let n = 0; n < 20; n++) detector.push(pcm(0));
  assert.equal(clips.length, 0, 'short hesitation is not a finished turn');
  for (let n = 0; n < 15; n++) detector.push(pcm());
  for (let n = 0; n < 40; n++) detector.push(pcm(0));
  assert.equal(clips.length, 1); assert.equal(starts, 1);
  for (let n = 0; n < 3020; n++) detector.push(pcm());
  assert.equal(clips.length, 2, 'long uninterrupted speech is bounded');
  assert.ok(clips[1].length <= 1_952_044);
  const resampled = encodeWav([new Float32Array(48000).fill(.2)], 48000);
  const view = new DataView(resampled.buffer);
  assert.equal(resampled.length, 32044); assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getInt16(44, true), Math.trunc(.2 * 32767));
});

test('starting capture tolerates normal gaps between voiced syllables without accepting isolated clicks', () => {
  const clips = []; let starts = 0;
  const detector = new UtteranceDetector({ sampleRate: 16000, started: () => starts++, utterance: bytes => clips.push(bytes) });
  // Five short voiced syllables, none individually 250 ms long.
  for (let group = 0; group < 5; group++) {
    for (let n = 0; n < 3; n++) detector.push(pcm());
    for (let n = 0; n < 2; n++) detector.push(pcm(0));
  }
  assert.equal(starts, 1, 'speech onset accumulates across short unvoiced gaps');
  for (let n = 0; n < 125; n++) detector.push(pcm(0));
  assert.equal(clips.length, 1);
  // A short click every 400 ms must not accumulate into speech over time.
  for (let group = 0; group < 10; group++) {
    for (let n = 0; n < 4; n++) detector.push(pcm());
    for (let n = 0; n < 16; n++) detector.push(pcm(0));
  }
  detector.finish(); assert.equal(starts, 1); assert.equal(clips.length, 1);
});

test('barge-in onset also tolerates syllable gaps while keeping its longer noise guard', () => {
  let starts = 0;
  const detector = new UtteranceDetector({ sampleRate: 16000, startMs: 450, started: () => starts++, utterance() {} });
  for (let group = 0; group < 4; group++) {
    for (let n = 0; n < 5; n++) detector.push(pcm());
    for (let n = 0; n < 2; n++) detector.push(pcm(0));
  }
  assert.equal(starts, 0, '400 ms voiced audio still falls below the barge-in threshold');
  for (let n = 0; n < 3; n++) detector.push(pcm());
  assert.equal(starts, 1);
});

function harness({ allowInterrupt = false, listen, capture, context } = {}) {
  const submissions = [], cancels = [], calls = [], closed = [], modes = [], holds = [], contexts = [];
  let feed;
  const session = Object.assign(store({ subagent: null, pendingSubmissions: [], running: false }), {
    beginSubmission(input) { submissions.push(input); return { requestId: 'rpc-voice', abandon() { submissions.push('abandoned'); } }; },
    async prompt(content, mode, signal, requestId) {
      assert.equal(requestId, 'rpc-voice'); assert.equal(signal.aborted, false);
      calls.push({ content, mode }); session.set({ ...session.getSnapshot(), running: true });
      return { ok: true };
    },
    async cancel() { cancels.push(true); session.set({ ...session.getSnapshot(), running: false }); return { ok: true }; },
  });
  const speakerStore = store({ phase: 'idle', elapsed: 0 });
  const speaker = {
    sessionId: 's', state: speakerStore.getSnapshot(), subscribe: speakerStore.subscribe,
    ctx: { sessions: { binding: () => ({ session }) } },
    async unlock() {}, stop() { for (const hold of holds) hold.current = false; this.state = { ...this.state, phase: 'idle' }; speakerStore.set(this.state); },
    async setPaused(paused) { this.userPaused = paused; this.state = { ...this.state, phase: paused ? 'paused' : 'playing' }; speakerStore.set(this.state); },
    holdPlayback() {
      const hold = { current: true, phase: this.state.phase, released: false }; holds.push(hold);
      this.state = { ...this.state, phase: 'paused' }; speakerStore.set(this.state);
      return { isCurrent: () => hold.current, release: () => {
        hold.released = true;
        if (!hold.current) return;
        hold.current = false; this.state = { ...this.state, phase: hold.phase }; speakerStore.set(this.state);
      } };
    },
    setVoiceActive(active) { modes.push(active); this.stop(); },
  };
  const form = store({ value: { ...VOICE_DEFAULTS, allowInterrupt } });
  const service = new VoiceConversation(speaker, form, async (url, init) => {
    if (url.endsWith('/conversation')) { contexts.push(JSON.parse(init.body)); return context ? context(contexts.at(-1)) : Response.json({ ok: true }); }
    if (url.endsWith('/status')) return Response.json({ ready: true });
    assert.equal(JSON.parse(init.body).session_id, 's');
    return listen ? listen(init) : Response.json({ text: '请解释这段代码。' });
  }, capture || (async options => { feed = options.frame; return { echoCancellation: true, close: () => closed.push(true), setMuted() {} }; }));
  return { service, session, speaker, form, submissions, cancels, calls, closed, modes, holds, contexts, feed: (...args) => feed(...args) };
}

test('a newly ready idle call accepts its first fragmented utterance without a hidden cooldown', async t => {
  const h = harness(); t.after(() => h.service.dispose());
  await h.service.start();
  assert.equal(h.service.state.phase, 'listening');
  for (let group = 0; group < 5; group++) {
    for (let n = 0; n < 3; n++) h.feed(pcm(), 16000);
    for (let n = 0; n < 2; n++) h.feed(pcm(0), 16000);
  }
  assert.equal(h.service.state.phase, 'capturing');
  for (let n = 0; n < 125; n++) h.feed(pcm(0), 16000);
  await tick(); assert.equal(h.calls.length, 1); assert.equal(h.submissions.length, 1);
});

test('live input observations expose threshold and busy gates without submitting audio or changing the call', async t => {
  const h = harness(), traces = []; t.after(() => h.service.dispose());
  h.speaker.trace = (event, values) => traces.push({ event, values });
  await h.service.start();
  h.feed(pcm(.003), 16000); h.service.publishInputSignal();
  assert.equal(h.service.state.inputSignal.state, 'quiet'); assert.equal(h.service.state.phase, 'listening');
  h.session.set({ ...h.session.getSnapshot(), running: true });
  h.feed(pcm(.03), 16000); h.service.publishInputSignal();
  assert.equal(h.service.state.inputSignal.state, 'blocked'); assert.equal(h.service.state.inputSignal.gate, 'busy');
  assert.equal(h.calls.length, 0); assert.equal(h.cancels.length, 0);
  assert.equal(traces.filter(item => item.event === 'input.signal').length, 2);
  h.service.end(); assert.equal(h.service.signalTimer, undefined); assert.equal(h.service.signal, undefined);
  assert.equal(h.service.state.inputSignal, undefined);
  const count = traces.length; h.service.publishInputSignal(); h.feed(pcm(), 16000);
  assert.equal(traces.length, count, 'late frames and samples cannot revive diagnostics after ending');
});

test('recording, delayed recognition and official submission report pending input until the turn is accepted', async t => {
  let recognize, accept;
  const h = harness({ listen: () => new Promise(resolve => { recognize = resolve; }) });
  t.after(() => { recognize?.(Response.json({ text: '' })); accept?.(); h.service.dispose(); });
  const original = h.session.prompt;
  h.session.prompt = async (...args) => { await original(...args); await new Promise(resolve => { accept = resolve; }); return { ok: true }; };
  await h.service.start(); await tick(); h.service.coolUntil = 0;
  assert.equal(h.contexts.at(-1).inputPending, false);
  for (let n = 0; n < 25; n++) h.feed(pcm(), 16000);
  await tick(); assert.equal(h.service.state.phase, 'capturing'); assert.equal(h.contexts.at(-1).inputPending, true);
  h.service.finishInput(); await tick(); assert.equal(h.service.state.phase, 'transcribing');
  assert.equal(h.contexts.at(-1).inputPending, true);
  recognize(Response.json({ text: '第二点详细解释。' })); await tick(); await tick();
  assert.equal(h.calls.length, 1); assert.equal(h.service.state.phase, 'sending'); assert.equal(h.contexts.at(-1).inputPending, true);
  accept(); await tick(); await tick();
  assert.equal(h.contexts.at(-1).inputPending, false); assert.equal(h.calls.length, 1);
});

test('normal hesitation stays in one recording and explicit finish submits once', async () => {
  const h = harness(); await h.service.start(); h.service.coolUntil = 0;
  for (let n = 0; n < 25; n++) h.feed(pcm(), 16000);
  for (let n = 0; n < 100; n++) h.feed(pcm(0), 16000);
  await tick(); assert.equal(h.calls.length, 0); assert.equal(h.service.state.phase, 'capturing');
  for (let n = 0; n < 25; n++) h.feed(pcm(), 16000);
  h.service.finishInput(); await tick();
  assert.equal(h.calls.length, 1);
  h.service.finishInput(); await tick(); assert.equal(h.calls.length, 1);
  h.service.dispose();
});

test('spoken backchannels and pause/resume preserve the answer without new model submissions', async () => {
  let text = '嗯';
  const h = harness({ allowInterrupt: true, listen: () => Response.json({ text }) });
  await h.service.start(); h.service.coolUntil = 0;
  h.session.set({ ...h.session.getSnapshot(), running: true });
  h.speaker.state = { phase: 'playing', playbackText: '下面继续说明实现方式。' };
  utterance(h.feed); await tick();
  assert.equal(h.holds[0].released, true); assert.equal(h.calls.length, 0); assert.equal(h.cancels.length, 0);
  text = '继续讲'; utterance(h.feed); await tick();
  assert.equal(h.calls.length, 0); assert.equal(h.cancels.length, 0, 'continue during playback keeps the existing queue');
  text = '暂停'; utterance(h.feed); await tick();
  assert.equal(h.speaker.userPaused, true); assert.equal(h.speaker.state.phase, 'paused');
  text = '继续'; utterance(h.feed); await tick();
  assert.equal(h.speaker.userPaused, false); assert.equal(h.speaker.state.phase, 'playing');
  assert.equal(h.calls.length, 0); assert.equal(h.cancels.length, 0);
  text = '嗯，不对'; utterance(h.feed); await tick();
  assert.equal(h.calls.length, 1); assert.equal(h.cancels.length, 1, 'a real correction still interrupts');
  h.service.dispose();
});

test('a semantic wait from the host preserves a short answer while branch audio is still playing', async t => {
  let release, pending = false, awaitingAnswer = false;
  const h = harness({ allowInterrupt: true, listen: () => Response.json({ text: '好' }), context: body => {
    if (body.inputPending && pending) return new Promise(resolve => { release = () => { awaitingAnswer = true; resolve(Response.json({ ok: true, awaitingAnswer })); }; });
    return Response.json({ ok: true, awaitingAnswer });
  } });
  t.after(() => { release?.(); h.service.dispose(); });
  await h.service.start(); h.service.coolUntil = 0;
  h.speaker.state = { phase: 'playing', playbackText: '请确认你希望我先举例。' };
  pending = true; utterance(h.feed); await tick();
  assert.equal(h.calls.length, 0, 'recognition waits for its existing capture state sync');
  assert.equal(h.service.state.phase, 'transcribing');
  pending = false; release(); await tick(); await tick();
  assert.equal(h.calls.length, 1, 'the answer is submitted, not filtered as an acknowledgement');
  assert.equal(h.calls[0].content[0].text, '好');
  assert.equal(h.calls[0].mode, 'queue');
  assert.equal(h.cancels.length, 0, 'completed model output does not need cancellation');
});

test('hands-free speech uses official submission identity and supports repeated turns without persisting autoplay', async () => {
  const h = harness(); await h.service.start();
  h.service.coolUntil = undefined;
  utterance(h.feed); await tick();
  assert.deepEqual(h.calls, [{ content: [{ type: 'text', text: '请解释这段代码。' }], mode: 'queue' }]);
  assert.equal(h.submissions[0].attachments.length, 0);
  assert.equal(h.service.state.phase, 'answering');
  utterance(h.feed); await tick();
  assert.equal(h.calls.length, 1, 'default mode does not transcribe the assistant output');
  h.session.set({ ...h.session.getSnapshot(), running: false });
  h.service.coolUntil = undefined;
  utterance(h.feed); await tick();
  assert.equal(h.calls.length, 2);
  h.service.mute(); h.session.set({ ...h.session.getSnapshot(), running: false });
  utterance(h.feed); await tick(); assert.equal(h.calls.length, 2);
  h.service.end();
  assert.equal(h.closed.length, 1); assert.deepEqual(h.modes, [true, false]);
  h.service.dispose();
});

test('opt-in barge-in cancels the old turn and steers only once the new transcription is final', async () => {
  let resolve;
  const h = harness({ allowInterrupt: true, listen: () => new Promise(done => { resolve = done; }) }); await h.service.start();
  h.session.set({ ...h.session.getSnapshot(), running: true });
  h.speaker.state = { phase: 'playing', activeMessageId: 'old', elapsed: 1200 };
  h.service.coolUntil = undefined;
  utterance(h.feed); await tick();
  assert.equal(h.cancels.length, 0); assert.equal(h.calls.length, 0);
  assert.equal(h.speaker.state.phase, 'paused');
  assert.equal(h.service.state.confirming, true);
  resolve(Response.json({ text: '请解释这段代码。' })); await tick();
  assert.equal(h.cancels.length, 1); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].mode, 'steer');
  assert.equal(h.service.state.heard.messageId, 'old');
  assert.equal(h.service.state.heard.elapsedMs, 1200);
  h.service.dispose();
});

test('empty input, matching playback echo and ASR failure preserve the old answer without cancellation', async () => {
  for (const response of [Response.json({ text: '' }), Response.json({ text: '这是一句正在播放的测试语音' }), Response.json({ error: 'ASR disconnected' }, { status: 503 })]) {
    const h = harness({ allowInterrupt: true, listen: () => response });
    await h.service.start(); h.service.coolUntil = 0;
    h.session.set({ ...h.session.getSnapshot(), running: true });
    h.speaker.state = { phase: 'playing', playbackText: '这是一句正在播放的测试语音。', elapsed: 2300 };
    utterance(h.feed); await tick();
    assert.equal(h.cancels.length, 0); assert.equal(h.calls.length, 0);
    assert.equal(h.speaker.state.phase, 'playing'); assert.equal(h.speaker.state.elapsed, 2300);
    assert.equal(h.holds[0].released, true); assert.equal(h.service.state.active, true);
    assert.match(h.service.state.notice, /保留原回答/);
    h.service.dispose();
  }
  assert.equal(isPlaybackEcho('不对，这是一句正在播放的测试语音', '这是一句正在播放的测试语音。'), false);
  assert.equal(isPlaybackEcho('好的', '好的，我会继续回答。'), false);
  assert.equal(isPlaybackEcho('Ｔｈｉｓ is A test phrase', 'This is a test phrase.'), true);
});

test('no confirmed AEC suppresses automatic barge-in during playback; the explicit button still works', async () => {
  const h = harness({ allowInterrupt: true }); await h.service.start(); h.service.coolUntil = 0;
  h.service.update({ echoCancellation: false });
  h.session.set({ ...h.session.getSnapshot(), running: true });
  h.speaker.state = { phase: 'playing' };
  utterance(h.feed); await tick();
  assert.equal(h.holds.length, 0); assert.equal(h.cancels.length, 0);
  h.service.mute();
  h.service.takeFloor(); await tick();
  assert.equal(h.service.state.muted, false); assert.equal(h.cancels.length, 1);
  h.service.coolUntil = 0; utterance(h.feed); await tick();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].mode, 'steer');
  h.service.dispose();
});

test('completed AI turns only stop remaining speech and submit a new queued turn', async () => {
  const h = harness({ allowInterrupt: true }); await h.service.start(); h.service.coolUntil = 0;
  h.speaker.state = { phase: 'playing', elapsed: 1000 };
  utterance(h.feed); await tick();
  assert.equal(h.cancels.length, 0); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].mode, 'queue'); h.service.dispose();
});

test('brief playback noise does not pause or cancel the current answer', async () => {
  const h = harness({ allowInterrupt: true }); await h.service.start(); h.service.coolUntil = 0;
  h.session.set({ ...h.session.getSnapshot(), running: true });
  h.speaker.state = { phase: 'playing', elapsed: 2500 };
  for (let n = 0; n < 20; n++) h.feed(pcm(), 16000);
  for (let n = 0; n < 45; n++) h.feed(pcm(0), 16000);
  await tick();
  assert.equal(h.holds.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.cancels.length, 0);
  assert.equal(h.speaker.state.phase, 'playing');
  h.service.dispose();
});

test('a rejected cancellation never submits the new question or retries it', async () => {
  const h = harness({ allowInterrupt: true }); await h.service.start(); h.service.coolUntil = 0;
  h.session.set({ ...h.session.getSnapshot(), running: true });
  h.speaker.state = { phase: 'playing' };
  let attempts = 0;
  h.session.cancel = async () => { attempts++; return { ok: false, error: { message: 'cancel refused' } }; };
  utterance(h.feed); await tick(); await tick();
  assert.equal(attempts, 1); assert.equal(h.calls.length, 0); assert.equal(h.submissions.length, 0);
  assert.equal(h.service.state.active, false); assert.match(h.service.state.error, /cancel refused/);
  utterance(h.feed); await tick(); assert.equal(attempts, 1);
  h.service.dispose();
});

test('muting, ending, or replacing a reply drops delayed barge-in recognition without resuming a new reply', async () => {
  for (const action of ['mute', 'end', 'replace']) {
    let resolve;
    const h = harness({ allowInterrupt: true, listen: () => new Promise(done => { resolve = done; }) });
    await h.service.start(); h.service.coolUntil = 0;
    h.session.set({ ...h.session.getSnapshot(), running: true });
    h.speaker.state = { phase: 'playing', elapsed: 3100 };
    utterance(h.feed); await tick();
    if (action === 'mute') h.service.mute();
    else if (action === 'end') h.service.end();
    else { h.speaker.stop(); h.speaker.state = { phase: 'playing', elapsed: 10, activeTurn: 'new' }; }
    resolve(Response.json({ text: '迟到的识别结果不应该发送' })); await tick();
    assert.equal(h.calls.length, 0); assert.equal(h.cancels.length, 0);
    if (action === 'replace') assert.equal(h.speaker.state.elapsed, 10);
    if (action === 'mute') assert.equal(h.service.state.phase, 'muted');
    h.service.dispose();
  }
});

test('ending or changing configuration drops delayed transcription instead of posting into a different session', async () => {
  for (const reason of ['end', 'config']) {
    let release;
    const h = harness({ listen: () => new Promise(resolve => { release = resolve; }) });
    await h.service.start(); h.service.coolUntil = undefined;
    utterance(h.feed); await tick();
    assert.equal(h.service.state.phase, 'transcribing');
    if (reason === 'end') { h.service.end(); h.speaker.sessionId = 'other'; }
    else h.form.set({ value: { ...VOICE_DEFAULTS, recognitionLanguage: 'en' } });
    release(Response.json({ text: 'stale microphone result' })); await tick();
    assert.equal(h.calls.length, 0); assert.equal(h.service.state.active, false);
    h.service.dispose();
  }
});

test('late microphone grants are closed; empty speech is ignored; rejected sends are never retried', async () => {
  let grant;
  const late = harness({ capture: () => new Promise(resolve => { grant = resolve; }) });
  const pending = late.service.start(); await tick(); late.service.end();
  let closed = false; grant({ close: () => { closed = true; } }); await pending;
  assert.equal(closed, true); assert.equal(late.service.state.active, false); late.service.dispose();
  const empty = harness({ listen: () => Response.json({ text: '  ' }) });
  await empty.service.start(); empty.service.coolUntil = undefined;
  utterance(empty.feed); await tick(); assert.equal(empty.calls.length, 0); empty.service.dispose();
  const rejected = harness();
  rejected.session.prompt = async () => ({ ok: false, error: { message: 'rejected by host' } });
  await rejected.service.start(); rejected.service.coolUntil = undefined;
  utterance(rejected.feed); await tick();
  assert.equal(rejected.service.state.active, false);
  assert.match(rejected.service.state.error, /rejected/);
  assert.equal(rejected.submissions.filter(item => item === 'abandoned').length, 1);
  utterance(rejected.feed); await tick(); assert.equal(rejected.submissions.length, 2);
  rejected.service.dispose();
  const broken = harness(); await broken.service.start();
  broken.speaker.state = { phase: 'error', error: 'TTS disconnected' };
  broken.service.refresh();
  assert.equal(broken.service.state.active, false); assert.equal(broken.closed.length, 1);
  assert.match(broken.service.state.error, /TTS disconnected/); broken.service.dispose();
});

test('microphone failure can restart cleanly while old recognition and device callbacks arrive late', async t => {
  const owners = [], closed = [];
  let lateRecognition, listens = 0;
  const h = harness({
    capture: async options => { const owner = owners.length; owners.push(options); return { echoCancellation: true, close: () => closed.push(owner), setMuted() {} }; },
    listen: () => ++listens === 1 ? new Promise(resolve => { lateRecognition = resolve; }) : Response.json({ text: '新的问题。' }),
  });
  t.after(() => { lateRecognition?.(Response.json({ text: '' })); h.service.dispose(); });
  await h.service.start(); const oldEpoch = h.service.contextEpoch;
  const oldInput = h.service.sendAudio(wav()); await tick();
  owners[0].failed(new Error('麦克风已断开'));
  assert.equal(h.service.state.active, false); assert.equal(h.service.state.phase, 'error');
  assert.equal(h.service.contextHeartbeat, undefined); assert.equal(h.service.input, undefined);
  assert.deepEqual(closed, [0]); assert.equal(h.calls.length, 0);
  await h.service.start(); assert.notEqual(h.service.contextEpoch, oldEpoch);
  assert.equal(h.service.state.active, true); assert.equal(h.service.state.error, '');
  owners[0].failed(new Error('旧设备迟到的错误'));
  lateRecognition(Response.json({ text: '旧录音不可发送。' })); await oldInput;
  assert.equal(h.service.state.active, true); assert.equal(h.calls.length, 0);
  await h.service.sendAudio(wav());
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].content[0].text, '新的问题。');
  h.service.end(); assert.deepEqual(closed, [0, 1]);
});

test('an unavailable transcription service ends capture and a deliberate restart sends only a new recording', async t => {
  let available = false;
  const h = harness({ listen: () => available ? Response.json({ text: '恢复后的提问。' }) : Response.json({ error: 'ASR unavailable' }, { status: 503 }) });
  t.after(() => h.service.dispose());
  await h.service.start(); await h.service.sendAudio(wav());
  assert.equal(h.service.state.active, false); assert.match(h.service.state.error, /ASR unavailable/);
  assert.equal(h.closed.length, 1); assert.equal(h.calls.length, 0); assert.equal(h.service.contextHeartbeat, undefined);
  available = true; await h.service.start();
  assert.equal(h.calls.length, 0, 'a failed recording must not be retried on reconnection');
  await h.service.sendAudio(wav());
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].content[0].text, '恢复后的提问。');
  h.service.end(); assert.equal(h.closed.length, 2);
});

test('host forwards only validated microphone WAV and pins Whisper settings without implicit downloads', async () => {
  const requests = [];
  const proxy = new VoiceboxProxy({ recognitionModel: 'small', recognitionLanguage: 'zh', sessionIds: ['s'] }, async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/models/status')) return Response.json({ models: [{ model_name: 'whisper-small', downloaded: true }] });
    assert.equal(init.body.get('model'), 'small'); assert.equal(init.body.get('language'), 'zh');
    assert.equal(init.body.get('file').size, wav().length);
    return Response.json({ text: '转写成功', duration: .5 });
  });
  const request = body => proxy.handle(new Request('http://dsh/api/voicebox?path=/listen', { method: 'POST', body: JSON.stringify(body) }));
  assert.equal((await request({ session_id: 'other', audio: audioBase64(wav()) })).status, 403);
  assert.equal((await request({ session_id: 's', audio: audioBase64(new Uint8Array(45)) })).status, 400);
  assert.equal(requests.length, 0);
  const valid = await request({ session_id: 's', audio: audioBase64(wav()), model: 'large', language: 'en' });
  assert.equal(valid.status, 200); assert.equal((await valid.json()).text, '转写成功');
  const absent = new VoiceboxProxy({}, async () => Response.json({ models: [] }));
  assert.equal((await absent.handle(new Request('http://dsh/api/voicebox?path=/listen', { method: 'POST', body: JSON.stringify({ session_id: 's', audio: audioBase64(wav()) }) }))).status, 409);
  await proxy.dispose(); await absent.dispose();
});

test('Desktop voice mode forces streaming only for the call and closes the microphone on session navigation', async t => {
  const keys = ['window', 'document', 'localStorage', 'AudioContext', '__DSH_TRANSPORT__'];
  const before = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  t.after(() => { for (const key of keys) { if (before[key] === undefined) delete globalThis[key]; else globalThis[key] = before[key]; } });
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  let stored = false;
  globalThis.localStorage = { getItem: () => 'off', setItem() { stored = true; } };
  globalThis.AudioContext = class { state = 'running'; async resume() {} async close() {} };
  let revision = 0, seq = 0, turn = 0, feed, release;
  const played = [], requests = [];
  const events = store({ revision, entries: [], change: { kind: 'replace', entries: [] } });
  const session = Object.assign(store({ pendingSubmissions: [], subagent: null, running: false }), {
    beginSubmission() { session.set({ ...session.getSnapshot(), pendingSubmissions: [{}] }); return { requestId: 'identified', abandon() {} }; },
    async prompt(_content, _mode, _signal, requestId) {
      assert.equal(requestId, 'identified');
      session.set({ ...session.getSnapshot(), pendingSubmissions: [], running: true });
      turn++;
      const event = (type, data, transient = false) => ({ type: transient ? 'transient' : 'event', event: { type, data, seq: ++seq } });
      const text = '这是一句足够长的流式回复，用于验证语音模式无需持久开启自动播报。';
      const entries = [event('turn/start', { turn }), event('user/message', { source: { kind: 'user' } }),
        event('assistant/live-chunk', { turn, step: 1, attemptId: `a-${turn}`, chunk: { type: 'text-delta', index: 0, text } }, true),
        event('assistant/message', { turn, step: 1, message: { id: `m-${turn}`, content: [{ type: 'text', text }] } }),
        event('turn/end', { turn, reason: { kind: 'completed' } })];
      events.set({ revision: ++revision, entries, change: { kind: 'append', entries } });
      session.set({ ...session.getSnapshot(), running: false });
      return { ok: true };
    }, async cancel() { return { ok: true }; },
  });
  globalThis.__DSH_TRANSPORT__ = { fetch: async (url, _init) => {
    const path = new URL(url, 'http://dsh').searchParams.get('path'); requests.push(path);
    if (path === '/listen/status') return Response.json({ ready: true });
    if (path === '/conversation') return Response.json({ ok: true });
    if (path === '/listen') return Response.json({ text: '测试语音提问' });
    if (path === '/openapi.json') return Response.json({ paths: { '/speak': { post: {} }, '/speak/cancel': { post: {} }, '/generate/{generation_id}/live': { get: {} } }, components: { schemas: { SpeakRequest: { properties: { request_id: {}, stream_audio: {}, preview_mode: {}, playback_owner: {} } } } } });
    return Response.json({ id: `g-${turn}` });
  } };
  const form = store({ value: { ...VOICE_DEFAULTS, readingMode: 'complete' } });
  const controller = new DesktopSpeechController({ sessions: { list: store({ byId: { s: {}, other: {} } }), binding: () => ({ session, eventSource: events }) } }, async (job, _base, signal, update) => {
    played.push(job); update(500);
    await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }); });
  }, form);
  let closed = false;
  const call = new VoiceConversation(controller, form, async (url, init) => globalThis.__DSH_TRANSPORT__.fetch(`/api/voicebox?path=${new URL(url).pathname}`, init), async options => {
    feed = options.frame; return { close() { closed = true; } };
  });
  controller.conversation = call;
  controller.select('s'); await call.start(); call.coolUntil = undefined;
  utterance(feed); await tick(); await controller.bridge.idle();
  assert.equal(played.length, 1); assert.equal(requests.filter(path => path === '/speak').length, 1);
  assert.equal(controller.state.enabled, false); assert.equal(controller.state.voiceActive, true);
  release(); await controller.live.idle();
  call.coolUntil = undefined; utterance(feed); await tick(); await controller.bridge.idle();
  assert.equal(played.length, 2);
  controller.select('other');
  assert.equal(call.state.active, false); assert.equal(closed, true); assert.equal(controller.state.voiceActive, false);
  assert.equal(stored, false, 'voice mode must not rewrite the session autoplay preference');
  await controller.dispose();
});

test('background microphone policy preserves an utterance by default and suppresses it when disabled', async t => {
  const before = { window: globalThis.window, document: globalThis.document };
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  for (const backgroundListening of [true, false]) {
    globalThis.window = new EventTarget();
    let focused = true;
    globalThis.document = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => focused });
    const h = harness();
    h.form.set({ value: { ...VOICE_DEFAULTS, backgroundListening } });
    await h.service.start(); h.service.coolUntil = 0;
    for (let n = 0; n < 10; n++) h.feed(pcm(), 16000);
    focused = false; window.dispatchEvent(new Event('blur'));
    for (let n = 0; n < 15; n++) h.feed(pcm(), 16000);
    for (let n = 0; n < 125; n++) h.feed(pcm(0), 16000);
    await tick();
    assert.equal(h.calls.length, backgroundListening ? 1 : 0);
    if (!backgroundListening) {
      assert.equal(h.service.state.phase, 'background');
      focused = true; window.dispatchEvent(new Event('focus'));
      h.service.coolUntil = 0; utterance(h.feed); await tick();
      assert.equal(h.calls.length, 1);
    }
    h.service.dispose();
  }
});

test('simplified host transcription is the exact text submitted to the AI, not merely a UI label', async () => {
  const proxy = new VoiceboxProxy({}, async url => url.endsWith('/models/status')
    ? Response.json({ models: [{ model_name: 'whisper-turbo', downloaded: true }] })
    : Response.json({ text: '請將語音辨識結果交給 AI，不要修改 API 名稱。' }));
  const h = harness({ listen: init => proxy.handle(new Request('http://dsh/api/voicebox?path=/listen', init)) });
  await h.service.start(); h.service.coolUntil = 0;
  utterance(h.feed); await tick(); await tick();
  const expected = '请将语音辨识结果交给 AI，不要修改 API 名称。';
  assert.equal(h.service.state.transcript, expected);
  assert.equal(h.calls[0].content[0].text, expected);
  h.service.dispose(); await proxy.dispose();
});
