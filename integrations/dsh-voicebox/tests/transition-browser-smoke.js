// Explicit button activation only. Native Web Audio, silent buffers, no devices or TTS.
import { playTransition } from '/transition.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw Error(message); };
async function until(predicate) {
  for (let n = 0; n < 150; n++) { if (predicate()) return; await sleep(20); }
  throw Error('Transition audio did not settle within three seconds');
}
async function scenario(mode) {
  const context = new AudioContext(), abort = new AbortController(), nodes = new Set(), listeners = new Set();
  let created = 0, settled = false;
  for (const factory of ['createBufferSource', 'createGain']) {
    const create = context[factory].bind(context);
    context[factory] = (...args) => {
      const node = create(...args), disconnect = node.disconnect.bind(node);
      nodes.add(node); created++;
      node.disconnect = (...values) => { const result = disconnect(...values); nodes.delete(node); return result; };
      return node;
    };
  }
  const add = context.addEventListener.bind(context), remove = context.removeEventListener.bind(context);
  context.addEventListener = (type, callback, ...args) => { if (type === 'statechange') listeners.add(callback); return add(type, callback, ...args); };
  context.removeEventListener = (type, callback, ...args) => { if (type === 'statechange') listeners.delete(callback); return remove(type, callback, ...args); };
  try {
    await context.resume();
    if (mode === 'already-closed') await context.close();
    if (mode === 'already-cancelled') abort.abort();
    const clip = { rate: 24000, samples: new Float32Array(mode === 'normal-end' || mode === 'pause-resume' ? 4800 : 24000) };
    const playing = playTransition(context, clip, abort.signal).finally(() => { settled = true; });
    if (mode === 'close-during-cue') { await sleep(20); await context.close(); }
    if (mode === 'pause-resume' || mode === 'cancel-while-paused') {
      await context.suspend(); await sleep(100);
      assert(!settled && context.state === 'suspended', 'Pause must preserve the cue without forcing resume');
      if (mode === 'pause-resume') await context.resume();
      else abort.abort();
    }
    await until(() => settled); await playing;
    assert(nodes.size === 0 && listeners.size === 0, 'Cue must release its nodes and context listener');
    if (['already-closed', 'already-cancelled'].includes(mode)) assert(created === 0, 'Inactive playback must not create nodes');
    if (mode === 'cancel-while-paused') assert(context.state === 'suspended', 'Cancelling must not resume the shared context');
    if (['normal-end', 'pause-resume'].includes(mode)) assert(context.state === 'running', 'Cue must not close the shared context');
    return { mode, passed: true, createdNodes: created, activeNodes: nodes.size, stateListeners: listeners.size, contextState: context.state };
  } finally {
    abort.abort();
    if (context.state !== 'closed') await context.close();
  }
}

document.querySelector('#transition').onclick = async () => {
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  const report = { browser: navigator.userAgent, scope: 'Native AudioContext and silent zero buffers; no hardware permission, TTS, ASR, LLM or audible naturalness validation', results: [] };
  try {
    for (const mode of ['normal-end', 'close-during-cue', 'pause-resume', 'cancel-while-paused', 'already-closed', 'already-cancelled']) {
      document.querySelector('#transition-result').textContent = `正在检查：${mode}`;
      report.results.push(await scenario(mode));
    }
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; }
  try {
    const saved = await fetch('/transition-result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    report.saved = saved.ok;
  } catch { report.saved = false; }
  document.querySelector('#transition-result').textContent = JSON.stringify(report, null, 2);
  document.querySelectorAll('button').forEach(button => { button.disabled = false; });
};
