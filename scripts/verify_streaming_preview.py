"""Exercise the installed API, record real packet timing, and validate saved WAV."""
import argparse
import io
import json
import math
import struct
import time
import urllib.request
import wave
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', default='http://127.0.0.1:17493')
    parser.add_argument('--profile-id', required=True)
    parser.add_argument('--model-size', default='0.6B')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--characters', type=int, default=200)
    parser.add_argument('--client-owned', action='store_true', help='Use /speak without automatic Voicebox playback')
    parser.add_argument('--preview-mode', choices=['realtime', 'checked'], default='realtime')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    def request(path, data=None, timeout=600):
        payload = json.dumps(data).encode('utf-8') if data is not None else None
        return urllib.request.urlopen(urllib.request.Request(args.base + path, data=payload,
            headers={'Content-Type': 'application/json', 'X-Voicebox-Client-Id': 'continuity-check'}), timeout=timeout)

    for attempt in range(30):
        try:
            with request('/health', timeout=2) as response:
                assert json.load(response)['backend_variant'] == 'cuda'
            break
        except OSError:
            if attempt == 29:
                raise
            time.sleep(1)

    warm_start = time.perf_counter()
    with request(f'/profiles/{args.profile_id}/live-warmup?model_size={args.model_size}', {}) as response:
        assert json.load(response)['ready']
    warm_seconds = time.perf_counter() - warm_start
    print(f'warmup {warm_seconds:.2f}s', flush=True)
    paragraph = ('这是流式语音的实际验收。文字可以一次输入，声音会在后面的内容生成完成以前开始返回。'
                 '我们检查每一段声音的顺序和长度，观察长文本是否需要持续等待。'
                 '如果模型暂时跟不上播放，播放器会显示缓冲状态；任务成功以后，完整音频仍然保存在历史记录中。')
    text = (paragraph * math.ceil(args.characters / len(paragraph)))[:args.characters]
    started = time.perf_counter()
    payload = (dict(profile=args.profile_id, text=text, language='zh', engine='qwen',
                    model_size=args.model_size, stream_audio=True, playback_owner='client', personality=False, preview_mode=args.preview_mode)
               if args.client_owned else dict(profile_id=args.profile_id, text=text, language='zh',
                    engine='qwen', model_size=args.model_size, seed=42, normalize=True,
                    max_chunk_chars=160, crossfade_ms=50, stream_audio=True, preview_mode=args.preview_mode))
    with request('/speak' if args.client_owned else '/generate', payload) as response:
        generation_id = json.load(response)['id']
    (args.output / 'generation-id.txt').write_text(generation_id, encoding='utf-8')
    packets = []
    sample_rate, sample_count = 0, 0
    end_time, underruns, total_gap = 0., 0, 0.
    last_log = 0
    with request(f'/generate/{generation_id}/live') as response, (args.output / 'preview.f32').open('wb') as output:
        while True:
            header = response.read(8)
            assert len(header) == 8, 'EOF before terminal packet'
            rate, count = struct.unpack('<II', header)
            if not count:
                assert rate == 0, 'Generation failed'
                break
            assert 8000 <= rate <= 192000 and 0 < count <= 24000
            data = response.read(count * 4)
            assert len(data) == count * 4
            assert all(math.isfinite(value[0]) for value in struct.iter_unpack('<f', data))
            now = time.perf_counter() - started
            packets.append(dict(seconds=round(now, 4), samples=count))
            output.write(data)
            sample_rate = rate
            sample_count += count
            if not end_time:
                end_time = now + .8
                print(f'first PCM {now:.3f}s', flush=True)
            elif now > end_time + .02:
                underruns += 1
                total_gap += now + .3 - end_time
                end_time = now + .3
            end_time += count / rate
            if now - last_log >= 15:
                print(f'{now:.1f}s elapsed; {sample_count/rate:.1f}s audio; simulated underruns {underruns}', flush=True)
                last_log = now
    elapsed = time.perf_counter() - started
    with request(f'/audio/{generation_id}', timeout=30) as response:
        saved = response.read()
    (args.output / 'saved.wav').write_bytes(saved)
    with wave.open(io.BytesIO(saved), 'rb') as audio:
        assert audio.getframerate() == sample_rate
        assert audio.getnframes() == sample_count, 'Saved file differs in length from preview'
    with request(f'/generate/{generation_id}/status', timeout=30) as response:
        event = next(json.loads(line[6:]) for line in response if line.startswith(b'data: '))
        assert event['status'] == 'completed'
    result = dict(generation_id=generation_id, characters=len(text), model_size=args.model_size,
        warmup_seconds=warm_seconds, wall_seconds=elapsed, audio_seconds=sample_count/sample_rate,
        first_pcm_seconds=packets[0]['seconds'], rtf=elapsed/(sample_count/sample_rate),
        simulated_underruns=underruns, simulated_gap_seconds=total_gap,
        note='Buffer simulation, not a measurement of sound leaving the speaker. Initial buffer 0.8s; rebuffer 0.3s.',
        packets=packets)
    (args.output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k != 'packets'}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
