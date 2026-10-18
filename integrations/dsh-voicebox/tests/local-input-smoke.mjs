// Explicit opt-in: use a known synthetic WAV and already cached local Whisper.
import { readFile, writeFile } from 'node:fs/promises';
import { encodeWav, audioBase64 } from '../src/capture.js';
import { VoiceboxProxy } from '../src/proxy.js';

if (!process.argv[2]) throw new Error('Usage: node tests/local-input-smoke.mjs <synthetic-wav> [result.json]');
const source = await readFile(process.argv[2]);
let rate, format, bits, channels, samples;
for (let offset = 12; offset + 8 <= source.length;) {
  const tag = source.toString('ascii', offset, offset + 4), size = source.readUInt32LE(offset + 4), start = offset + 8;
  if (start + size > source.length) throw new Error('Invalid WAV');
  if (tag === 'fmt ') { format = source.readUInt16LE(start); channels = source.readUInt16LE(start + 2); rate = source.readUInt32LE(start + 4); bits = source.readUInt16LE(start + 14); }
  if (tag === 'data') samples = source.subarray(start, start + size);
  offset = start + size + size % 2;
}
if (channels !== 1 || !samples || !((format === 1 && bits === 16) || (format === 3 && bits === 32))) throw new Error('Expected mono PCM16 or float32 WAV');
const count = Math.min(samples.length / (bits / 8), rate * 20), pcm = new Float32Array(count);
for (let i = 0; i < count; i++) pcm[i] = format === 1 ? samples.readInt16LE(i * 2) / 32768 : samples.readFloatLE(i * 4);
const selectedModel = process.env.VOICEBOX_SMOKE_MODEL || 'turbo';
const proxy = new VoiceboxProxy({ recognitionModel: selectedModel, recognitionLanguage: 'zh', sessionIds: ['voice-input-smoke'] });
try {
  const status = await proxy.handle(new Request('http://dsh/api/voicebox?path=/listen/status'));
  const model = await status.json();
  if (!status.ok || !model.ready) throw new Error(model.error || `Whisper ${selectedModel} is not cached; no download attempted`);
  const started = performance.now();
  const response = await proxy.handle(new Request('http://dsh/api/voicebox?path=/listen', { method: 'POST', body: JSON.stringify({ session_id: 'voice-input-smoke', audio: audioBase64(encodeWav([pcm], rate)) }) }));
  const data = await response.json();
  const result = { status: response.status, model: selectedModel, elapsedMs: Math.round(performance.now() - started), source: process.argv[2], ...data };
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(result, null, 2), 'utf8');
  console.log(result);
  if (!response.ok || !data.text?.trim()) process.exitCode = 1;
} finally { await proxy.dispose(); }
