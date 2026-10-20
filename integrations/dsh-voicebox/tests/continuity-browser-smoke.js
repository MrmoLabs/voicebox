import { playAgentSpeech } from '/playback.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw Error(message); };
function packet(seconds) {
  const bytes = new Uint8Array(8 + Math.round(seconds * 24000) * 4), view = new DataView(bytes.buffer);
  view.setUint32(0, 24000, true); view.setUint32(4, (bytes.length - 8) / 4, true); return bytes;
}
async function delayed(reserve) {
  const context = new AudioContext(), abort = new AbortController(), trace = [], timers = [];
  try {
    await context.resume();
    const body = new ReadableStream({ start(stream) {
      stream.enqueue(packet(.2));
      timers.push(setTimeout(() => stream.enqueue(packet(.6)), 350));
      timers.push(setTimeout(() => { stream.enqueue(packet(.6)); stream.enqueue(new Uint8Array(8)); stream.close(); }, 600));
    }, cancel() { timers.forEach(clearTimeout); } });
    await playAgentSpeech({ generation_id: 'silent-continuity', stream_audio: true }, location.origin, abort.signal, () => {}, {
      context, resume: false, initialBufferSeconds: .04, bufferedStartSeconds: reserve,
      fetch: async () => new Response(body), trace: event => trace.push(event),
    });
    assert(trace.at(-1)?.kind === 'completed' && Math.abs(trace.at(-1).audioMs - 1400) < 1, 'All input audio must play exactly once');
    return { underruns: trace.filter(event => event.kind === 'underrun').length, firstMs: trace.find(event => event.kind === 'first')?.afterMs,
      readyMs: trace.find(event => event.kind === 'ready')?.afterMs, startedMs: trace.find(event => event.kind === 'started')?.afterMs, bufferedMs: trace.find(event => event.kind === 'ready')?.bufferedMs };
  } finally { timers.forEach(clearTimeout); abort.abort(); await context.close(); }
}
async function cancellation() {
  const context = new AudioContext(), abort = new AbortController(), trace = [];
  let cancelled = 0, nodes = 0;
  const create = context.createBufferSource.bind(context);
  context.createBufferSource = () => { nodes++; return create(); };
  try {
    await context.resume();
    const body = new ReadableStream({ start(stream) { stream.enqueue(packet(.2)); }, cancel() { cancelled++; } });
    const task = playAgentSpeech({ generation_id: 'silent-pending', stream_audio: true }, location.origin, abort.signal, () => {}, {
      context, resume: false, bufferedStartSeconds: .8, initialBufferSeconds: .04, fetch: async () => new Response(body), trace: event => trace.push(event),
    }).then(() => '', error => error.message);
    await sleep(60); assert(!trace.some(event => event.kind === 'ready') && nodes === 0, 'A partial first packet must not start playback');
    await context.close(); const error = await task;
    assert(error.includes('audio context closed') && cancelled === 1 && nodes === 0, 'Closing during preroll must cancel the read without scheduling audio');
    return { mode: 'close-during-preroll', passed: true, cancelled, createdNodes: nodes };
  } finally { abort.abort(); if (context.state !== 'closed') await context.close(); }
}
async function short() {
  const context = new AudioContext(), abort = new AbortController(), trace = [];
  try {
    await context.resume();
    const body = new ReadableStream({ start(stream) { stream.enqueue(packet(.2)); stream.enqueue(new Uint8Array(8)); stream.close(); } });
    await playAgentSpeech({ generation_id: 'silent-short', stream_audio: true }, location.origin, abort.signal, () => {}, {
      context, resume: false, bufferedStartSeconds: .8, initialBufferSeconds: .04, fetch: async () => new Response(body), trace: event => trace.push(event),
    });
    assert(trace.some(event => event.kind === 'ready' && event.bufferedMs === 200), 'A valid short utterance must flush below reserve at EOF');
    assert(trace.at(-1)?.kind === 'completed', 'The short utterance must complete');
    return { mode: 'short-completed-audio', passed: true, bufferedMs: 200 };
  } finally { abort.abort(); await context.close(); }
}
document.querySelector('#continuity').onclick = async () => {
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  const report = { browser: navigator.userAgent, scope: 'Native AudioContext, silent PCM, injected packet delays; no hardware permission, inference, user audio or listening verification', results: [] };
  try {
    document.querySelector('#continuity-result').textContent = '正在对比相同的延迟音频流…';
    const before = await delayed(0), after = await delayed(.6);
    assert(before.underruns > 0 && after.underruns === 0, 'Actual PCM reserve must eliminate the reproduced first-packet starvation');
    report.results.push({ mode: 'delayed-packet-comparison', passed: true, before, after });
    report.results.push(await cancellation()); report.results.push(await short()); report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; }
  try {
    const saved = await fetch('/continuity-result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) }); report.saved = saved.ok;
  } catch { report.saved = false; }
  document.querySelector('#continuity-result').textContent = JSON.stringify(report, null, 2);
  document.querySelectorAll('button').forEach(button => { button.disabled = false; });
};
