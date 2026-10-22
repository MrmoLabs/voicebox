// Real local synthesis + production sentence queue, with a silent virtual
// playback clock. Measures scheduling gaps, not sound leaving a speaker.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SentenceBuffer, SentenceQueue } from '../src/sentences.js';
import { PcmPacketDecoder } from '../../../app/src/lib/audio/pcmPackets.ts';

const [profile, output, model = '1.7B', flow = 'streaming', length = '170'] = process.argv.slice(2);
if (!profile || !output) throw new Error('Usage: node tests/continuity-smoke.mjs <profile-id> <output.json> [model-size] [streaming|voice] [characters]');
const characters = Number(length);
assert(Number.isInteger(characters) && characters >= 1 && characters <= 1000, 'Choose 1–1000 fixed test characters');
const endpoint = 'http://127.0.0.1:17493';
const paragraph = '这是流式语音的实际验收。文字可以一次输入，声音会在后面的内容生成完成以前开始返回。我们检查每一段声音的顺序和长度，观察长文本是否需要持续等待。如果模型暂时跟不上播放，播放器会显示缓冲状态；任务成功以后，完整音频仍然保存在历史记录中。';
const text = paragraph.repeat(Math.ceil(characters / paragraph.length)).slice(0, characters);
const pieces = [], jobs = [];
let failure, end = 0, totalGap = 0;
const started = performance.now();
const seconds = () => (performance.now() - started) / 1000;
const queue = new SentenceQueue({
  longForm: flow === 'voice',
  async prepare(item) {
    const response = await fetch(`${endpoint}/speak`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Voicebox-Client-Id': 'continuity-queue-check' },
      body: JSON.stringify({ text: item.text, profile, model_size: model, engine: 'qwen', language: 'zh',
        stream_audio: true, preview_mode: 'realtime', playback_owner: 'client', personality: false, session_id: 'continuity-check', request_id: crypto.randomUUID() }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`Speech request failed: ${response.status}`);
    return { ...await response.json(), text: item.text };
  },
  async play(generation) {
    const response = await fetch(`${endpoint}/generate/${generation.id}/live`, { signal: AbortSignal.timeout(180_000) });
    assert.equal(response.status, 200);
    const decoder = new PcmPacketDecoder();
    const previousEnd = end;
    const job = { id: generation.id, chars: generation.text.length, audio_seconds: 0, internal_gap_seconds: 0 };
    for await (const bytes of response.body) {
      for (const packet of decoder.push(bytes)) {
        const now = seconds();
        if (job.first_pcm === undefined) {
          job.first_pcm = now;
          end = now + (jobs.length ? .04 : .8);
          job.scheduled_start = end;
          job.boundary_gap_seconds = previousEnd ? Math.max(0, end - previousEnd) : 0;
          totalGap += job.boundary_gap_seconds;
        } else if (end < now) {
          const gap = now + .3 - end;
          job.internal_gap_seconds += gap; totalGap += gap; end = now + .3;
        }
        const duration = packet.samples.length / packet.sampleRate;
        end += duration; job.audio_seconds += duration;
      }
    }
    decoder.finish();
    assert.ok(job.audio_seconds > 0);
    jobs.push(job);
    console.log(JSON.stringify(job));
    await delay(Math.max(0, (end - seconds()) * 1000));
  },
  waiting() {}, drained() {}, error(error) { failure = error; },
});
const buffer = new SentenceBuffer(piece => { pieces.push(piece); queue.enqueue(piece, `piece-${pieces.length}`, {turn:1,step:1}); });
for (const character of text) buffer.append(character);
buffer.finish(); queue.finish(); await queue.idle();
if (failure) throw failure;
assert.equal(pieces.join(''), text);
const result = { characters: text.length, model, flow, first_pcm_seconds: jobs[0].first_pcm,
  first_scheduled_sound_seconds: jobs[0].scheduled_start, total_simulated_gap_seconds: totalGap,
  wall_seconds: seconds(), pieces, jobs,
  note: 'Real /speak PCM and production sentence queue; legacy 0.8s/0.04s scheduling simulation, not the current reserve-aware scheduler. All answer text supplied upfront. No microphone or physical speaker measurement.' };
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({ ...result, pieces: undefined, jobs: undefined }));
