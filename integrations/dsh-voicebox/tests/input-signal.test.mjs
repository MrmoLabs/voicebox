import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputSignal, inputSignalLabel } from '../src/input-signal.js';
import { VoiceDiagnostics } from '../src/telemetry.js';

test('signal observations distinguish quiet audio, voiced audio and protected input without retaining samples', () => {
  let now = 0;
  const monitor = new InputSignal(() => now), quiet = new Float32Array(320).fill(.003);
  const running = { contextState: 'running', trackEnabled: true, trackMuted: false };
  monitor.observe(quiet, 16000, 'open'); quiet.fill(1);
  let result = monitor.snapshot(running);
  assert.equal(result.state, 'quiet'); assert.equal(result.frames, 1); assert.equal(result.acceptedFrames, 1);
  assert(result.peakDb < result.thresholdDb, 'the measured quiet window stays below the unchanged detector threshold');
  assert.equal(result.voicedMs, 0); assert.equal(result.sampleRate, 16000);
  monitor.observe(new Float32Array(320).fill(.03), 16000, 'busy');
  result = monitor.snapshot(running);
  assert.equal(result.state, 'blocked'); assert.equal(result.gate, 'busy'); assert.equal(result.acceptedFrames, 0);
  assert.equal(result.voicedMs, 20); assert(result.peakDb > result.thresholdDb);
  now = 2101; result = monitor.snapshot(running);
  assert.equal(result.state, 'missing'); assert.equal(result.frames, 0); assert.equal(result.sinceFrameMs, 2101);
  assert(!Object.values(monitor).some(value => ArrayBuffer.isView(value) || Array.isArray(value)), 'only aggregate numbers are retained');
});

test('device suspension, source mute and disabled tracks are distinct from a low microphone level', () => {
  const monitor = new InputSignal(() => 0);
  assert.equal(monitor.snapshot({ contextState: 'running' }).state, 'missing');
  assert.equal(monitor.snapshot({ contextState: 'suspended' }).state, 'suspended');
  assert.equal(monitor.snapshot({ contextState: 'interrupted' }).state, 'suspended');
  assert.equal(monitor.snapshot({ contextState: 'running', trackMuted: true }).state, 'device-muted');
  assert.equal(monitor.snapshot({ contextState: 'running', trackEnabled: false }).state, 'disabled');
  monitor.observe(new Float32Array(320).fill(.04), 16000, 'open');
  assert.equal(monitor.snapshot({ contextState: 'running', trackEnabled: true }).state, 'voiced');
  assert.match(inputSignalLabel({ state: 'missing' }), /尚未收到/);
});

test('signal diagnostics keep bounded numeric evidence and enums but drop arbitrary content and invalid values', () => {
  const log = new VoiceDiagnostics(), privateValue = 'PRIVATE_MICROPHONE_OR_TRANSCRIPT';
  log.record('input.signal', { state: 'quiet', gate: 'open', contextState: 'running', frames: 40, acceptedFrames: 40,
    voicedMs: 0, peakDb: -48.25, thresholdDb: -36.478, sinceFrameMs: 4.5, trackMuted: false, trackEnabled: true,
    samples: [privateValue], transcript: privateValue, deviceName: privateValue });
  const event = log.snapshot().events[0];
  assert.equal(event.peakDb, -48.2); assert.equal(event.thresholdDb, -36.5); assert.equal(event.frames, 40);
  assert.equal(event.gate, 'open'); assert(!JSON.stringify(log.snapshot()).includes(privateValue));
  log.record('input.signal', { state: privateValue, gate: privateValue, contextState: privateValue,
    frames: Infinity, voicedMs: -1, peakDb: NaN, thresholdDb: -500, trackEnabled: privateValue });
  assert.deepEqual(log.snapshot().events[1], { seq: 2, ms: log.snapshot().events[1].ms, event: 'input.signal' });
});
