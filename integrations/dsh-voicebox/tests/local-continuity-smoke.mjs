// Explicit opt-in. Fixed test text, the loaded Qwen model and selected voice;
// read PCM at full speed without opening an AudioContext or hardware devices.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VoiceboxProxy } from '../src/proxy.js';
import { PcmPacketDecoder } from '../../../app/src/lib/audio/pcmPackets.ts';

const [permission, destination, profile] = process.argv.slice(2);
if (permission !== '--run' || !destination || !profile) throw Error('Usage: node tests/local-continuity-smoke.mjs --run <output-directory> <voice-name-or-id>');
const output = path.resolve(destination), base = 'http://127.0.0.1:17493';
const get = async route => {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(10_000) });
  assert(response.ok, `Readiness request failed: ${response.status}`); return response.json();
};
const active = await get('/tasks/active');
assert(active.generations.length === 0 && active.downloads.length === 0, 'Voicebox is busy; leave existing work alone');
const health = await get('/health');
assert(health.model_loaded && ['0.6B', '1.7B'].includes(health.model_size), 'Use the already loaded model without switching or downloading');
const profiles = await get('/profiles');
assert(profiles.some(item => item.id === profile || item.name === profile), 'The selected voice must already exist');
const proxy = new VoiceboxProxy({ clientId: 'dsh-voicebox-continuity-probe', profile, modelSize: health.model_size, speechMode: 'realtime' });
const signal = AbortSignal.timeout(120_000), session = `continuity-probe-${crypto.randomUUID()}`;
const invoke = (route, body) => proxy.handle(new Request(`http://dsh/api/voicebox?path=${encodeURIComponent(route)}`, {
  signal, ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
}));
const report = { scope: 'Fixed synthetic test text; direct local backend PCM through the production proxy, no DSH IPC, playback clock, microphone, speaker, ASR or remote LLM',
  modelSize: health.model_size, packets: [], probeCompleted: false };
let reader;
try {
  const started = performance.now();
  const response = await invoke('/speak', { session_id: session, request_id: 'fixed-text-once', text: '这是一段用于核对语音连续性的测试。请保持原来的音色和语速，我们观察每一段声音是否能够及时生成。' });
  assert(response.ok, `Speech request failed: ${response.status}`);
  const job = await response.json(); assert(typeof job.id === 'string' && /^[A-Za-z0-9_-]+$/u.test(job.id));
  const stream = await invoke(`/generate/${job.id}/live`); assert(stream.ok && stream.body, 'Live audio must be available');
  reader = stream.body.getReader();
  const decoder = new PcmPacketDecoder();
  let audioMs = 0, firstAt, minimumStartDelayMs = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    const atMs = performance.now() - started;
    for (const packet of decoder.push(value)) {
      firstAt ??= atMs;
      const durationMs = packet.samples.length / packet.sampleRate * 1000;
      // No playback clock: cumulative PCM and real arrival time determine the
      // start delay a continuous reader would have needed for this exact trace.
      // This is wall time after first arrival, not the PCM reserve at that time.
      minimumStartDelayMs = Math.max(minimumStartDelayMs, atMs - firstAt - audioMs);
      audioMs += durationMs;
      report.packets.push({ atMs: Math.round(atMs), audioMs: Math.round(durationMs), cumulativeMs: Math.round(audioMs) });
    }
  }
  decoder.finish(); assert(report.packets.length > 1, 'Expected several real PCM packets');
  Object.assign(report, { probeCompleted: true, totalMs: Math.round(performance.now() - started), firstPcmMs: Math.round(firstAt), audioMs: Math.round(audioMs),
    minimumStartDelayMs: Math.round(minimumStartDelayMs), steadyRealtimeFactor: +((report.packets.at(-1).atMs - firstAt) / (audioMs - report.packets[0].audioMs)).toFixed(3) });
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  void reader?.cancel().catch(() => {});
  await proxy.dispose();
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report));
}
