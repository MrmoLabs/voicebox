// Explicit opt-in: real local Qwen + Whisper; scripted model replies and a
// silent AudioContext clock. Never opens a microphone or a physical speaker.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopSpeechController, speechFetch } from '../src/controller.js';
import { VoiceConversation } from '../src/conversation.js';
import { VoiceboxProxy } from '../src/proxy.js';
import { encodeWav } from '../src/capture.js';
import { PcmPacketDecoder } from '../../../app/src/lib/audio/pcmPackets.ts';
import { playAgentSpeech } from '../../../app/src/lib/audio/agentSpeechPlayback.ts';

const [permission, destination, roundsText = '10', profile] = process.argv.slice(2);
if (permission !== '--run' || !destination) throw new Error('Opt-in: bun tests/local-roundtrip-smoke.mjs --run <output-directory> [rounds] [voice-name-or-id]');
const rounds = Number(roundsText);
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 30);
const output = path.resolve(destination), base = 'http://127.0.0.1:17493';
await mkdir(output, { recursive: true });
const get = async route => {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200); return response.json();
};
const ownIds = new Set();
async function requireIdle() {
  const tasks = await get('/tasks/active');
  assert.equal(tasks.downloads.length, 0, 'Other downloads are active; leave the user workload alone');
  assert(!tasks.generations.some(task => !ownIds.has(task.task_id)), 'Other generation is active; stop this probe');
}
await requireIdle();
const health = await get('/health');
assert(health.model_loaded && ['0.6B', '1.7B'].includes(health.model_size), 'Use the already loaded Qwen model; do not switch or download models');
const settings = { clientId: 'dsh-voicebox-local-roundtrip', profile, modelSize: health.model_size, speechMode: 'realtime', readingMode: 'complete', transitionSounds: false,
  recognitionModel: 'turbo', recognitionLanguage: 'zh', recognitionScript: 'simplified', backgroundListening: true, allowInterrupt: false };
const proxy = new VoiceboxProxy(settings);
const sessionId = `local-roundtrip-${crypto.randomUUID()}`;
const invoke = (route, body) => proxy.handle(new Request(`http://dsh/api/voicebox?path=${encodeURIComponent(route)}`,
  body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}));
const status = await invoke('/listen/status');
assert((await status.json()).ready, 'Whisper turbo must already be cached');
const diagnostics = await invoke('/diagnostics');
assert.equal((await diagnostics.json()).status, 'pass', 'Saved test defaults must pass installation checks');

function store(value) {
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { value = next; for (const fn of listeners) fn(); }, get listenerCount() { return listeners.size; } };
}
let contexts = 0, closedContexts = 0, closedInputs = 0;
class SilentContext {
  state = 'running'; elapsed = 0; origin = performance.now(); sources = new Set();
  constructor() { contexts++; }
  get currentTime() { return this.elapsed + (this.state === 'running' ? (performance.now() - this.origin) / 1000 : 0); }
  async suspend() { this.elapsed = this.currentTime; this.state = 'suspended'; }
  async resume() { if (this.state !== 'running') { this.origin = performance.now(); this.state = 'running'; } }
  async close() { if (this.state === 'closed') return; this.elapsed = this.currentTime; this.state = 'closed'; closedContexts++; for (const source of this.sources) source.stop(); }
  createBuffer(_channels, count, rate) { const pcm = new Float32Array(count); return { duration: count / rate, getChannelData: () => pcm }; }
  createBufferSource() {
    const context = this;
    const source = { connect() {}, disconnect() { clearInterval(this.timer); context.sources.delete(this); },
      stop() { this.disconnect(); this.onended?.(); },
      start(at) {
        const end = at + this.buffer.duration;
        this.timer = setInterval(() => { if (context.currentTime >= end) { this.disconnect(); this.onended?.(); } }, 25);
      } };
    this.sources.add(source); return source;
  }
}
globalThis.window = new EventTarget();
let focused = true;
globalThis.document = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => focused });
globalThis.localStorage = { getItem: () => null, setItem() { throw new Error('No persistent preference writes in probe'); } };
globalThis.AudioContext = SilentContext;
let turn = 0, seq = 0, revision = 0, submissions = 0;
const submissionIds = new Set(), summaries = [], entries = [];
const events = store({ revision, entries: [], change: { kind: 'replace', entries: [] } });
const push = (type, data, transient = false) => {
  const entry = { type: transient ? 'transient' : 'event', event: { type, data, seq: ++seq } };
  if (!transient) entries.push(entry);
  events.set({ revision: ++revision, entries: [...entries], change: { kind: 'append', entries: [entry] } });
};
const session = Object.assign(store({ running: false, subagent: null, pendingSubmissions: [] }), {
  beginSubmission() { const requestId = crypto.randomUUID(); assert(!submissionIds.has(requestId)); submissionIds.add(requestId); return { requestId, abandon() {} }; },
  async cancel() { throw new Error('Normal probes must not cancel a scripted model turn'); },
  async prompt(content, mode, signal, requestId) {
    assert.equal(mode, 'queue'); assert(!signal.aborted); assert(submissionIds.has(requestId));
    submissions++; session.set({ ...session.getSnapshot(), running: true });
    const n = ++turn, attemptId = `attempt-${n}`;
    push('turn/start', { turn: n }); push('user/message', { source: { kind: 'user' }, content });
    const text = `这是第${n}轮的说明。连续语音应该保持顺序，切换窗口以后也要继续读完。\n\n\x60\x60\x60js\nUNSPOKEN_CODE();\n\x60\x60\x60\n| UNSPOKEN_TABLE | 内容 |\n| --- | --- |\n| 项目 | 一 |`;
    push('assistant/live-chunk', { turn: n, step: 1, attemptId, chunk: { type: 'block-start', index: 0, blockType: 'text' } }, true);
    for (let at = 0; at < text.length; at += 7) {
      push('assistant/live-chunk', { turn: n, step: 1, attemptId, chunk: { type: 'text-delta', index: 0, text: text.slice(at, at + 7) } }, true);
      await delay(40);
    }
    push('assistant/message', { turn: n, step: 1, message: { id: `message-${n}`, content: [{ type: 'text', text }] } });
    push('turn/end', { turn: n, reason: { kind: 'completed' } });
    session.set({ ...session.getSnapshot(), running: false }); return { ok: true };
  },
});
globalThis.__DSH_TRANSPORT__ = { fetch: async (url, init = {}) => {
  const route = new URL(url, 'http://dsh').searchParams.get('path');
  if (route === '/conversation') return Response.json({ ok: true }); // Scripted host context, not the real AgentLoop.
  if (route === '/speak') assert(!/UNSPOKEN_/.test(JSON.parse(init.body).text));
  const response = await proxy.handle(new Request(new URL(url, 'http://dsh'), init));
  if (route === '/speak' && response.ok) ownIds.add((await response.clone().json()).id);
  return response;
} };
const form = store({ value: settings });
const speaker = new DesktopSpeechController({ sessions: { list: store({ byId: { [sessionId]: {} } }), binding: () => ({ session, eventSource: events }) } }, playAgentSpeech, form);
const conversation = new VoiceConversation(speaker, form, speechFetch, async () => ({ close() { closedInputs++; }, setMuted() {}, echoCancellation: false }));
speaker.conversation = conversation;
let completed = false;
try {
  // One generic synthetic utterance is reused to stress repeated ASR/submission.
  const response = await invoke('/speak', { session_id: sessionId, request_id: 'synthetic-input', text: '请解释这段内容的主要意思。' });
  assert(response.ok); const bootstrap = await response.json(); ownIds.add(bootstrap.id);
  const stream = await invoke(`/generate/${bootstrap.id}/live`); assert(stream.ok);
  const decoder = new PcmPacketDecoder(), frames = []; let rate;
  for await (const bytes of stream.body) for (const packet of decoder.push(bytes)) { rate = packet.sampleRate; frames.push(packet.samples); }
  decoder.finish(); assert(frames.length); const clip = encodeWav(frames, rate);
  speaker.select(sessionId); await conversation.start(); assert(conversation.state.active);
  for (let n = 0; n < rounds; n++) {
    await requireIdle();
    if (n === 3 || n === 7) { focused = !focused; document.hidden = !focused; window.dispatchEvent(new Event(focused ? 'focus' : 'blur')); document.dispatchEvent(new Event('visibilitychange')); }
    const started = performance.now();
    await conversation.sendAudio(clip); await speaker.bridge.idle(); await speaker.live.idle(); await delay(0);
    assert.equal(submissions, n + 1); assert.equal(speaker.state.error, ''); assert.equal(conversation.state.error, '');
    assert.equal(conversation.state.phase, 'listening'); assert.equal(form.getSnapshot().value.readingMode, 'complete');
    const trace = speaker.diagnostics.snapshot();
    const summary = { round: n + 1, wallMs: Math.round(performance.now() - started), transcriptCharacters: conversation.state.transcript.length,
      completedPieces: trace.counts['pcm.completed'] || 0, recoveredUnderruns: trace.counts['pcm.underrun'] || 0 };
    summaries.push(summary); console.log(JSON.stringify(summary));
    await writeFile(path.join(output, 'diagnostics.json'), JSON.stringify(trace, null, 2), 'utf8');
  }
  completed = true;
} finally {
  const trace = speaker.diagnostics.snapshot(), pieceWaits = [];
  let withinTurn = false, previousEnd;
  for (const event of trace.events) {
    if (event.event === 'turn.start') { withinTurn = true; previousEnd = undefined; }
    if (withinTurn && event.event === 'pcm.started' && previousEnd !== undefined) pieceWaits.push(event.ms - previousEnd);
    if (withinTurn && event.event === 'pcm.completed') previousEnd = event.ms;
  }
  await writeFile(path.join(output, 'diagnostics.json'), JSON.stringify(trace, null, 2), 'utf8');
  await speaker.dispose(); await proxy.dispose();
  const result = { completed, requestedRounds: rounds, finishedRounds: summaries.length, modelSize: settings.modelSize,
    submissions, uniqueSubmissionIds: submissionIds.size, contexts, closedContexts, closedInputs, remainingSubscriptions: session.listenerCount + events.listenerCount + form.listenerCount,
    diagnosticCounts: trace.counts, diagnosticRecordsDropped: trace.dropped, observedPieceWaitsMs: pieceWaits,
    timingCaveat: 'Adjacent pieces within a turn, inferred from started/completed observations; includes 50-100ms observer granularity. Not physical speaker timing.',
    rounds: summaries, createdGenerations: [...ownIds],
    scope: 'Real local Qwen PCM and Whisper; one synthetic utterance reused. Production controller, narration queue and PCM scheduler with silent simulated AudioContext. Scripted replies/context, no real LLM/AgentLoop, microphone, speaker, Bluetooth or subjective quality measurement. No user config changes.' };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  // Preserve all history and copy our successful synthetic output for listening.
  // This probe never deletes application history or audio.
  if (completed) {
    result.audioFiles = [];
    for (const [index, id] of [...ownIds].entries()) {
      const audio = await fetch(`${base}/audio/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) });
      assert(audio.ok);
      const file = `synthetic-${String(index).padStart(2, '0')}.wav`;
      await writeFile(path.join(output, file), new Uint8Array(await audio.arrayBuffer())); result.audioFiles.push(file);
    }
  }
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({ completed, finishedRounds: summaries.length, submissions, remainingSubscriptions: result.remainingSubscriptions }));
}
assert.equal(closedContexts, contexts); assert.equal(closedInputs, 1);
assert.equal(session.listenerCount + events.listenerCount + form.listenerCount, 0);
