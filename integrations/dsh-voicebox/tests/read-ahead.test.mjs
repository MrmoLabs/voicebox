import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { SpeechReadAhead } from '../src/read-ahead.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const url = id => `http://voicebox.invalid/generate/${id}/live`;

test('the future response is read before promotion and consumed once without another GET', async () => {
  let calls = 0, releaseHeaders, source;
  const ahead = new SpeechReadAhead(async () => {
    calls++;
    await new Promise(resolve => { releaseHeaders = resolve; });
    return new Response(new ReadableStream({ start(controller) { source = controller; } }));
  });
  ahead.prepare({ id: 'future' }); await tick();
  assert.equal(calls, 1, 'Open transport while the previous piece still plays');
  releaseHeaders(); await tick();
  source.enqueue(new Uint8Array([11, 12])); await tick();
  source.enqueue(new Uint8Array([13, 14, 15])); source.close(); await tick();
  const signal = new AbortController();
  const response = await ahead.fetch(url('future'), { signal: signal.signal });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [11, 12, 13, 14, 15]);
  assert.equal(calls, 1); assert.equal(getEventListeners(signal.signal, 'abort').length, 0);
  ahead.clear();
});

test('unconsumed future streams apply byte backpressure and bound the number of requests', async () => {
  const calls = [], pulls = {}, cancelled = [];
  const ahead = new SpeechReadAhead(async input => {
    const id = new URL(input).pathname.split('/')[2]; calls.push(id); pulls[id] = 0;
    return new Response(new ReadableStream({
      pull(controller) { pulls[id]++; controller.enqueue(new Uint8Array(64 * 1024)); },
      cancel() { cancelled.push(id); },
    }, { highWaterMark: 0 }));
  });
  ahead.prepare({ id: 'one' }); ahead.prepare({ id: 'two' }); ahead.prepare({ id: 'three' });
  await tick(); await tick();
  assert.deepEqual(calls, ['one', 'two']);
  assert(pulls.one > 0 && pulls.one <= 4 && pulls.two > 0 && pulls.two <= 4, 'Read bounded PCM instead of the entire future utterance');
  const previous = { ...pulls }; await tick(); assert.deepEqual(pulls, previous);
  ahead.clear(); await tick(); assert.deepEqual(cancelled.sort(), ['one', 'two']);
});

test('a prefetched network failure stays with the future piece and does not fail current audio', async () => {
  const ahead = new SpeechReadAhead(async input => {
    if (input === url('bad')) throw Error('injected future network error');
    return new Response(new Uint8Array([7, 8]));
  });
  ahead.prepare({ id: 'good' }); ahead.prepare({ id: 'bad' }); await tick();
  assert.deepEqual([...new Uint8Array(await (await ahead.fetch(url('good'))).arrayBuffer())], [7, 8]);
  await assert.rejects((await ahead.fetch(url('bad'))).arrayBuffer(), /future network error/);
  ahead.clear();
});

test('cancellation before headers releases a late source and never revives stopped read-ahead', async () => {
  let release, cancelled = 0, requestSignal;
  const ahead = new SpeechReadAhead(async (_url, init) => {
    requestSignal = init.signal;
    return new Promise(resolve => { release = resolve; });
  });
  ahead.prepare({ id: 'late' }); await tick(); ahead.clear();
  assert(requestSignal.aborted);
  release(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await tick(); assert.equal(cancelled, 1);
});

test('aborting active playback stops its source without cancelling the next piece', async () => {
  const sources = {}, stopped = [], signals = {};
  const ahead = new SpeechReadAhead(async (input, init) => {
    const id = new URL(input).pathname.split('/')[2]; signals[id] = init.signal;
    return new Response(new ReadableStream({ start(controller) { sources[id] = controller; }, cancel() { stopped.push(id); } }));
  });
  ahead.prepare({ id: 'active' }); ahead.prepare({ id: 'next' }); await tick();
  const abort = new AbortController();
  const reader = (await ahead.fetch(url('active'), { signal: abort.signal })).body.getReader();
  const pending = reader.read(); abort.abort(Error('interrupted'));
  await assert.rejects(pending, /interrupted|released/);
  await reader.cancel().catch(() => {});
  assert(signals.active.aborted); assert(!signals.next.aborted);
  sources.next.enqueue(new Uint8Array([22])); sources.next.close();
  assert.deepEqual([...new Uint8Array(await (await ahead.fetch(url('next'))).arrayBuffer())], [22]);
  assert.deepEqual(stopped, ['active']); assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  ahead.clear();
});

test('an HTTP error cancels its body, and an already aborted consumer receives no old bytes', async () => {
  let cancelled = 0;
  const ahead = new SpeechReadAhead(async input => input === url('http-error')
    ? new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 })
    : new Response(new Uint8Array([1])));
  ahead.prepare({ id: 'http-error' }); await tick();
  await assert.rejects((await ahead.fetch(url('http-error'))).arrayBuffer(), /HTTP 503/);
  assert.equal(cancelled, 1);
  ahead.prepare({ id: 'unused' }); await tick();
  const abort = new AbortController(); abort.abort(Error('stopped before handoff'));
  await assert.rejects(ahead.fetch(url('unused'), { signal: abort.signal }), /stopped before handoff/);
  ahead.clear();
});

test('finishing an active source detaches its playback abort listener', async () => {
  let source;
  const ahead = new SpeechReadAhead(async () => new Response(new ReadableStream({ start(controller) { source = controller; } })));
  ahead.prepare({ id: 'finishing' }); await tick();
  const abort = new AbortController();
  const response = await ahead.fetch(url('finishing'), { signal: abort.signal });
  assert.equal(getEventListeners(abort.signal, 'abort').length, 1);
  source.enqueue(new Uint8Array([4])); source.close();
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [4]);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0); ahead.clear();
});
