import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceDiagnostics } from '../src/telemetry.js';
import { SpeechBridge } from '../src/bridge.js';
import { DesktopSpeechController } from '../src/controller.js';

const schema = { paths: { '/speak': { post: {} }, '/speak/cancel': { post: {} }, '/generate/{id}/live': { get: {} } },
  components: { schemas: { SpeakRequest: { properties: { request_id: {}, stream_audio: {}, preview_mode: {}, playback_owner: {} } } } } };

test('diagnostics are bounded, monotonic and export only known metadata without private content', () => {
  let now = 123456;
  const diagnostics = new VoiceDiagnostics({ clock: () => now, limit: 3 });
  const secret = 'PRIVATE_VOICE_TRANSCRIPT_ENDPOINT';
  diagnostics.record(secret, { text: secret });
  diagnostics.record('speaker.state', { state: secret, text: secret, endpoint: secret });
  diagnostics.record('settings.runtime', { modelSize: '1.7B', speechMode: 'realtime', profile: secret, clientId: secret });
  now += 100;
  diagnostics.record('pcm.first', { afterMs: 12.345, sampleRate: 24000, audio: secret, piece: 1 });
  now -= 50;
  diagnostics.record('pcm.failed', { state: 'decode', afterMs: NaN, gapMs: Infinity, bytes: -1, parts: 1e20 });
  const result = diagnostics.snapshot();
  assert.equal(result.retained, 3); assert.equal(result.dropped, 1);
  assert.equal(result.counts['speaker.state'], 1);
  assert.deepEqual(result.events.map(event => event.ms), [0, 100, 100]);
  assert.equal(result.events[1].afterMs, 12.3);
  assert.deepEqual(result.events[2], { seq: 4, ms: 100, event: 'pcm.failed', state: 'decode' });
  assert(!JSON.stringify(result).includes(secret)); assert(!JSON.stringify(result).includes('123456'));
  result.events[0].modelSize = secret; result.counts['pcm.first'] = 900;
  assert(!JSON.stringify(diagnostics.snapshot()).includes(secret)); assert.equal(diagnostics.snapshot().counts['pcm.first'], 1);
  diagnostics.clear(); assert.equal(diagnostics.snapshot().retained, 0); assert.equal(diagnostics.snapshot().dropped, 0);
  diagnostics.record('call.start'); assert.deepEqual(diagnostics.snapshot().events, [{ seq: 1, ms: 0, event: 'call.start' }]);
  diagnostics.dispose(); diagnostics.record('pcm.aborted', { afterMs: 10 });
  assert.equal(diagnostics.snapshot().retained, 0, 'late audio callbacks cannot resurrect a disposed log');
});

test('speech timings do not export backend identities and a broken observer cannot break speech or cancellation', async () => {
  for (const broken of [false, true]) {
    const diagnostics = new VoiceDiagnostics(), calls = [];
    const bridge = new SpeechBridge({ profile: 'PRIVATE_PROFILE', playbackOwner: 'client' }, {
      trace: (event, values) => { if (broken) throw new Error('observer'); diagnostics.record(event, values); },
      fetch: async (url, init) => { calls.push({ url, body: init.body && JSON.parse(init.body) }); return Response.json(url.endsWith('/openapi.json') ? schema : { id: 'PRIVATE_GENERATION' }); },
    });
    bridge.active = 'PRIVATE_SESSION';
    assert.equal((await bridge.speak('PRIVATE_SESSION', 'PRIVATE_REQUEST', 'PRIVATE_TRANSCRIPT', undefined)).id, 'PRIVATE_GENERATION');
    bridge.interrupt('PRIVATE_SESSION'); await bridge.idle();
    assert.equal(calls.filter(call => call.url.endsWith('/speak')).length, 1);
    assert.equal(calls.find(call => call.url.endsWith('/speak')).body.playback_owner, 'client');
    if (!broken) {
      const result = diagnostics.snapshot();
      assert.equal(result.counts['speech.request'], 1); assert.equal(result.counts['speech.ready'], 1); assert.equal(result.counts['speech.cancelled'], 1);
      assert.equal(result.events.find(event => event.event === 'speech.ready').request, 1);
      assert(!JSON.stringify(result).includes('PRIVATE'));
    }
    await bridge.dispose();
  }
});

test('controller combines PCM and state events while excluding generation text and clears diagnostics on unload', async t => {
  const previous = globalThis.AudioContext;
  t.after(() => { if (previous === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = previous; });
  globalThis.AudioContext = class { state = 'running'; async close() { this.state = 'closed'; } };
  const controller = new DesktopSpeechController({}, async (_job, _base, _signal, update, options) => {
    options.trace({ kind: 'first', afterMs: 32, sampleRate: 24000, text: 'PRIVATE_AUDIO' });
    options.trace({ kind: 'ready', afterMs: 90, bufferedMs: 800, text: 'PRIVATE_AUDIO' });
    options.trace({ kind: 'started', afterMs: 100 }); update(120, false);
    options.trace({ kind: 'underrun', gapMs: 450, refillMs: 300 }); update(120, true);
    options.trace({ kind: 'completed', afterMs: 1000, audioMs: 400 });
  });
  await controller.playGeneration({ id: 'PRIVATE_GENERATION', text: 'PRIVATE_TEXT' });
  const result = controller.diagnostics.snapshot();
  assert.equal(result.counts['pcm.first'], 1); assert.equal(result.counts['pcm.underrun'], 1); assert.equal(result.counts['pcm.completed'], 1);
  assert.equal(result.events.find(event => event.event === 'pcm.first').piece, 1);
  assert.equal(result.events.find(event => event.event === 'pcm.ready').bufferedMs, 800);
  assert(controller.streamReserveSeconds >= 1.2, 'a real underrun raises the next segment reserve');
  assert.deepEqual(result.events.filter(event => event.event === 'speaker.state').map(event => event.state), ['buffering', 'playing', 'buffering', 'idle']);
  assert(!JSON.stringify(result).includes('PRIVATE'));
  await controller.dispose(); assert.equal(controller.diagnostics.snapshot().retained, 0);
});

test('failed speech records scoped cleanup cancellation without serializing the backend error', async () => {
  const diagnostics = new VoiceDiagnostics();
  const bridge = new SpeechBridge({}, {
    trace: (event, values) => diagnostics.record(event, values),
    fetch: async url => url.endsWith('/openapi.json') ? Response.json(schema)
      : url.endsWith('/speak') ? new Response('PRIVATE_ERROR_CONTENT', { status: 500 }) : Response.json({}),
  });
  bridge.active = 'PRIVATE_SESSION';
  await assert.rejects(bridge.speak('PRIVATE_SESSION', 'PRIVATE_REQUEST', 'PRIVATE_TRANSCRIPT', undefined), /PRIVATE_ERROR_CONTENT/);
  const result = diagnostics.snapshot();
  assert.equal(result.counts['speech.failed'], 1); assert.equal(result.counts['speech.cancelled'], 1);
  assert(!JSON.stringify(result).includes('PRIVATE'));
  await bridge.dispose();
});
