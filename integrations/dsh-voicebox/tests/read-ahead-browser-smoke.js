import { SpeechReadAhead } from '/read-ahead.js';
import { playAgentSpeech } from '/playback.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw Error(message); };
function pcm() {
  const bytes = new Uint8Array(8 + 19200 * 4 + 8), view = new DataView(bytes.buffer);
  view.setUint32(0, 24000, true); view.setUint32(4, 19200, true); return bytes;
}
async function handoff(prefetch) {
  const context = new AudioContext(), abort = new AbortController(), events = [];
  let requests = 0, futureRequests = 0, nodes = 0;
  const create = context.createBufferSource.bind(context);
  context.createBufferSource = () => { nodes++; return create(); };
  const fetcher = async input => {
    requests++;
    if (input.includes('/future/')) { futureRequests++; await sleep(300); }
    return new Response(pcm());
  };
  const ahead = new SpeechReadAhead(fetcher);
  try {
    await context.resume();
    if (prefetch) ahead.prepare({ id: 'future' });
    const play = id => playAgentSpeech({ generation_id: id, stream_audio: true }, 'http://fixture', abort.signal, () => {}, {
      context, resume: false, fetch: prefetch ? ahead.fetch : fetcher,
      initialBufferSeconds: .04, bufferedStartSeconds: .6,
      trace: event => events.push({ id, clock: context.currentTime, ...event }),
    });
    await play('current');
    assert(nodes === 1, 'Read-ahead must never schedule the future voice before promotion');
    await play('future');
    assert(requests === 2 && futureRequests === 1 && nodes === 2, 'Each piece must be fetched and played once');
    const end = events.find(event => event.id === 'current' && event.kind === 'completed').clock;
    const start = events.find(event => event.id === 'future' && event.kind === 'started').clock;
    assert(events.filter(event => event.kind === 'completed').every(event => event.audioMs === 800), 'Do not lose or duplicate PCM');
    return { gapMs: Math.round((start - end) * 1000), requests, nodes };
  } finally { abort.abort(); ahead.clear(); await context.close(); }
}
async function cancel() {
  let stopped = 0, signal;
  const ahead = new SpeechReadAhead(async (_input, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel() { stopped++; return new Promise(() => {}); } }, { highWaterMark: 0 }));
  });
  ahead.prepare({ id: 'unused' }); await sleep(20); ahead.clear(); await sleep(20);
  assert(signal.aborted && stopped === 1, 'Stop must release future transport without awaiting a stuck cancellation');
  return { passed: true, stopped };
}
document.querySelector('#read-ahead').onclick = async () => {
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  const report = { browser: navigator.userAgent, scope: 'Native AudioContext and ReadableStream; silent fixed PCM and injected transport delay. No model, microphone, physical output or listening verification' };
  try {
    const before = await handoff(false), after = await handoff(true);
    assert(before.gapMs - after.gapMs >= 180 && after.gapMs < 200, 'Future transport wait should overlap current playback');
    Object.assign(report, { comparison: { before, after }, cancellation: await cancel(), passed: true });
  } catch (error) { report.passed = false; report.error = error.message; }
  const saved = await fetch('/read-ahead-result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
  report.saved = saved.ok;
  document.querySelector('#read-ahead-result').textContent = JSON.stringify(report, null, 2);
  document.querySelectorAll('button').forEach(button => { button.disabled = false; });
};
