// Browser API fixtures only: no physical microphone or OS permission changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMicrophone } from '../src/capture.js';

function browser(t, { acquire, module, resume, worklet = true } = {}) {
  const saved = new Map(['navigator', 'AudioContext', 'AudioWorkletNode'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const contexts = [], processors = [], failures = [], frames = [];
  class Track extends EventTarget {
    readyState = 'live'; stops = 0; listeners = new Set(); enabled = true;
    addEventListener(type, fn, options) { if (type === 'ended') this.listeners.add(fn); super.addEventListener(type, fn, options); }
    removeEventListener(type, fn, options) { if (type === 'ended') this.listeners.delete(fn); super.removeEventListener(type, fn, options); }
    stop() { this.stops++; this.readyState = 'ended'; }
    getSettings() { return { echoCancellation: true }; }
    unplug() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
  }
  const track = new Track(), stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const node = () => ({ connect() {}, disconnect() {} });
  class AudioContext extends EventTarget {
    state = 'running'; sampleRate = 48000; destination = {}; closes = 0;
    constructor() { super(); contexts.push(this); if (worklet) this.audioWorklet = { addModule: () => module ? module() : Promise.resolve() }; }
    async resume() { await resume?.(); }
    async close() { this.closes++; this.transition('closed'); }
    transition(state) { this.state = state; this.dispatchEvent(new Event('statechange')); }
    createMediaStreamSource() { return node(); }
    createGain() { return { ...node(), gain: { value: 1 } }; }
    createScriptProcessor() { const processor = node(); processors.push(processor); return processor; }
  }
  class AudioWorkletNode {
    port = { onmessage: null };
    constructor() { processors.push(this); }
    connect() {}
    disconnect() {}
  }
  for (const [key, value] of Object.entries({ navigator: { mediaDevices: { getUserMedia: () => acquire ? acquire(stream) : Promise.resolve(stream) } }, AudioContext, AudioWorkletNode })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const abort = new AbortController(); t.after(() => abort.abort());
  const open = () => openMicrophone({ signal: abort.signal, frame: (...args) => frames.push(args), failed: error => failures.push(error) });
  return { open, track, stream, contexts, processors, failures, frames, abort };
}

test('unplugging during worklet initialization rejects instead of returning a dead microphone', async t => {
  let release;
  const h = browser(t, { module: () => new Promise(resolve => { release = resolve; }) });
  const opening = h.open(); await new Promise(resolve => setImmediate(resolve));
  h.track.unplug(); release();
  const outcome = await opening.then(handle => { handle.close(); return {}; }, error => ({ error }));
  assert.match(outcome.error?.message || '', /麦克风已断开/);
  assert.equal(h.failures.length, 1); assert.equal(h.processors.length, 0);
  assert.equal(h.track.stops, 1); assert.equal(h.contexts[0].closes, 1); assert.equal(h.track.listeners.size, 0);
});

test('a failed capture worklet releases resources once and suppresses stale frames and failures', async t => {
  const h = browser(t), handle = await h.open(), processor = h.processors[0];
  const frame = processor.port.onmessage;
  assert.equal(typeof processor.onprocessorerror, 'function');
  const failed = processor.onprocessorerror;
  failed(new Event('processorerror')); failed(new Event('processorerror'));
  frame({ data: new Float32Array(1024) }); h.track.unplug(); handle.close(); handle.close(); h.abort.abort();
  assert.equal(h.failures.length, 1); assert.match(h.failures[0].message, /录音处理/);
  assert.equal(h.frames.length, 0); assert.equal(h.track.listeners.size, 0);
  assert.equal(h.track.stops, 1); assert.equal(h.contexts[0].closes, 1);
});

test('an aborted acquisition stops the later stream without constructing an audio context', async t => {
  let grant;
  const h = browser(t, { acquire: stream => new Promise(resolve => { grant = () => resolve(stream); }) });
  const opening = h.open(); h.abort.abort(); grant();
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(h.track.stops, 1); assert.equal(h.contexts.length, 0); assert.equal(h.failures.length, 0);
});

test('CSP fallback closes idempotently and cannot deliver captured data after normal close', async t => {
  const h = browser(t, { module: () => Promise.reject(new Error('CSP denied blob worklet')) });
  const handle = await h.open(), processor = h.processors[0], frame = processor.onaudioprocess;
  assert.equal(typeof frame, 'function'); assert.equal(handle.echoCancellation, true);
  handle.close(); handle.close();
  frame({ inputBuffer: { getChannelData: () => new Float32Array(1024) } }); h.track.unplug(); h.abort.abort();
  assert.equal(h.frames.length, 0); assert.equal(h.failures.length, 0);
  assert.equal(h.track.stops, 1); assert.equal(h.contexts[0].closes, 1); assert.equal(h.track.listeners.size, 0);
});

test('a stream already ended at acquisition cannot enter the listening state', async t => {
  const h = browser(t); h.track.readyState = 'ended';
  const outcome = await h.open().then(handle => { handle.close(); return {}; }, error => ({ error }));
  assert.match(outcome.error?.message || '', /麦克风已断开/);
  assert.equal(h.contexts.length, 0); assert.equal(h.track.stops, 1);
});

test('an unexpectedly closed recording context stops capture once without accepting late frames', async t => {
  const h = browser(t), handle = await h.open(), context = h.contexts[0], lateFrame = h.processors[0].port.onmessage;
  context.transition('closed'); context.transition('closed');
  lateFrame({ data: new Float32Array(1024) }); handle.close(); h.abort.abort();
  assert.equal(h.failures.length, 1); assert.match(h.failures[0].message, /录音.*关闭/);
  assert.equal(h.track.stops, 1); assert.equal(h.track.listeners.size, 0); assert.equal(h.frames.length, 0);
  assert.equal(context.closes, 0, 'already closed contexts are not closed again');
});

test('normal suspension does not end recording or force the context to resume', async t => {
  const h = browser(t), handle = await h.open();
  assert.deepEqual(handle.getStatus(), { contextState: 'running', trackMuted: false, trackEnabled: true });
  h.contexts[0].transition('suspended'); h.contexts[0].transition('running');
  assert.equal(h.failures.length, 0); assert.equal(h.track.stops, 0);
  handle.close(); assert.equal(h.failures.length, 0); assert.equal(h.track.stops, 1);
  assert.equal(handle.getStatus().contextState, 'closed');
});

test('aborting a pending resume settles initialization without waiting for the browser promise', { timeout: 1500 }, async t => {
  const h = browser(t, { resume: () => new Promise(() => {}) });
  const opening = h.open(); await new Promise(resolve => setImmediate(resolve)); h.abort.abort();
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(h.failures.length, 0); assert.equal(h.contexts[0].closes, 1); assert.equal(h.track.stops, 1);
});

test('closing the context during a stalled module load rejects without falling back', { timeout: 1500 }, async t => {
  const h = browser(t, { module: () => new Promise(() => {}) });
  const opening = h.open(); await new Promise(resolve => setImmediate(resolve)); h.contexts[0].transition('closed');
  await assert.rejects(opening, /录音.*关闭/);
  assert.equal(h.failures.length, 1); assert.equal(h.processors.length, 0); assert.equal(h.track.stops, 1);
});
