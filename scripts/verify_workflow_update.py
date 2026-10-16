"""Prepare an isolated fixture, or observe its generation on the installed API."""
import argparse
import concurrent.futures
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['prepare', 'observe', 'switch'])
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--profile-id')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
base = 'http://127.0.0.1:17493'


def request(path, data=None, method=None):
    payload = json.dumps(data, ensure_ascii=False).encode('utf-8') if data is not None else None
    with urllib.request.urlopen(urllib.request.Request(base + path, data=payload, method=method,
            headers={'Content-Type': 'application/json'}), timeout=120) as response:
        return json.load(response)


def save(name, value):
    (args.output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


if args.mode == 'prepare':
    profile = request('/profiles/' + args.profile_id)
    assert profile['voice_type'] == 'designed'
    text = ('这是 VoiceDesign 与有声图书的实际验收，声音来自文字描述。\n'
            '这一句用于测量模型完成预热后的生成速度。\n'
            '接下来检查长句的进度显示，页面应同时展示模型载入、声音准备、语音生成和保存阶段，'
            '在已经获得速度样本以后显示剩余时间预估，编辑区保留足够空间阅读正文，'
            '声音和模型设置放在侧边抽屉，生成完成后可以逐句试听和重新选择保留的版本。')
    book = request('/audiobooks', {'title': '工作流验收', 'author': '本机功能验证'})
    chapter = request(f"/audiobooks/{book['id']}/chapters", {'title': '第一章 · 状态验收', 'source_text': text})
    chapter = request(f"/audiobooks/chapters/{chapter['id']}/split", {'text': text}, 'PUT')
    assert len(chapter['sentences']) == 3
    fixture = dict(book_id=book['id'], chapter_id=chapter['id'], profile_id=args.profile_id, text=text,
                   sentence_ids=[row['id'] for row in chapter['sentences']])
    save('fixture.json', fixture)
    print(json.dumps(fixture, ensure_ascii=True), flush=True)

elif args.mode == 'observe':
    fixture = json.loads((args.output / 'fixture.json').read_text(encoding='utf-8'))
    events, phases, estimate_seen, blocked = [], set(), False, False
    started = time.perf_counter()
    last = None
    while time.perf_counter() - started < 600:
        rows = request(f"/audiobooks/chapters/{fixture['chapter_id']}/sentence-statuses")
        runtime = request('/models/runtime')['models']
        state = next(model for model in runtime if model['model_name'] == 'qwen-voice-design-1.7B')
        for row in rows:
            progress = row.get('generation_progress')
            if progress:
                phases.add(progress['stage'])
                estimate_seen |= progress.get('estimated_remaining_seconds') is not None
                if progress['stage'] == 'generating' and not blocked:
                    try:
                        request('/models/qwen-voice-design-1.7B/unload', {})
                        raise AssertionError('Unloading during inference must be rejected')
                    except urllib.error.HTTPError as error:
                        assert error.code == 409
                        blocked = True
        event = dict(seconds=round(time.perf_counter() - started, 2), rows=rows, runtime=state)
        events.append(event)
        signature = [(row.get('generation_status'), (row.get('generation_progress') or {}).get('stage')) for row in rows]
        if signature != last:
            print(json.dumps(dict(seconds=event['seconds'], status=signature), ensure_ascii=True), flush=True)
            last = signature
        save('book-events.json', events)
        if any(row.get('generation_status') == 'failed' for row in rows):
            raise RuntimeError([row.get('generation_error') for row in rows])
        if rows and all(row.get('generation_status') == 'completed' for row in rows):
            assert all(row.get('duration', 0) > 0 for row in rows)
            assert blocked and estimate_seen
            for index, row in enumerate(rows):
                with urllib.request.urlopen(base + '/audio/' + row['generation_id'], timeout=30) as response:
                    audio = response.read()
                assert audio[:4] == b'RIFF' and len(audio) > 44
                (args.output / f'sentence-{index+1}.wav').write_bytes(audio)
            result = dict(wall_seconds=event['seconds'], phases=sorted(phases), estimate_seen=estimate_seen,
                          unload_during_inference_rejected=blocked,
                          generation_ids=[row['generation_id'] for row in rows],
                          durations=[row['duration'] for row in rows])
            save('book-result.json', result)
            print(json.dumps(result), flush=True)
            break
        time.sleep(.4)
    else:
        raise TimeoutError('Book verification did not finish within 600 seconds')

else:
    results = []
    for name in ('qwen-tts-0.6B', 'qwen-voice-design-1.7B'):
        events = []
        started = time.perf_counter()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(request, '/models/load', {'model_name': name, 'replace_loaded': True})
            while not future.done():
                events.append(request('/models/runtime'))
                time.sleep(.25)
            response = future.result()
        state = request('/models/runtime')
        loaded = [model['model_name'] for model in state['models'] if model['loaded']]
        assert name in loaded
        assert ('qwen-voice-design-1.7B' if name == 'qwen-tts-0.6B' else 'qwen-tts-0.6B') not in loaded
        result = dict(target=name, seconds=round(time.perf_counter()-started, 2), loaded=loaded, response=response,
                      operation_events=events)
        results.append(result)
        print(json.dumps({key:value for key,value in result.items() if key != 'operation_events'}), flush=True)
    save('model-switch.json', results)
