"""Cancel real running CUDA inference and verify an explicit failure terminator."""
import argparse
import json
import struct
import time
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--profile-id', required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
base = 'http://127.0.0.1:17493'


def request(path, data=None):
    return urllib.request.urlopen(urllib.request.Request(base + path,
        data=json.dumps(data).encode('utf-8') if data is not None else None,
        headers={'Content-Type': 'application/json'}), timeout=60)


with request('/generate', dict(profile_id=args.profile_id,
        text='这是正在推理的停止验收任务。生成第一段声音后立即取消，剩余文字不应继续生成。' * 10,
        language='zh', engine='qwen', model_size='0.6B', seed=42, stream_audio=True)) as response:
    generation_id = json.load(response)['id']
cancelled = False
try:
    with request(f'/generate/{generation_id}/live') as response:
        rate, count = struct.unpack('<II', response.read(8))
        assert count > 0 and len(response.read(count * 4)) == count * 4
        started = time.perf_counter()
        with request(f'/generate/{generation_id}/cancel', {}) as cancel_response:
            cancel_result = json.load(cancel_response)
        cancelled = True
        while True:
            rate, count = struct.unpack('<II', response.read(8))
            if not count:
                assert rate == 1, 'Cancelled job must not signal successful completion'
                break
            assert len(response.read(count * 4)) == count * 4
        terminal_seconds = time.perf_counter() - started
    with request(f'/generate/{generation_id}/status') as response:
        event = next(json.loads(line[6:]) for line in response if line.startswith(b'data: '))
        assert event['status'] == 'failed' and event['error'] == 'Generation cancelled', event
    with request('/tasks/active') as response:
        assert generation_id not in [job['task_id'] for job in json.load(response)['generations']]
    result = dict(generation_id=generation_id, cancel_response=cancel_result,
        cancel_to_server_terminal_seconds=terminal_seconds, status=event['status'], error=event['error'],
        note='Measures server inference cleanup; not hardware output stopping latency.')
    args.output.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result), flush=True)
finally:
    if not cancelled:
        with request(f'/generate/{generation_id}/cancel', {}) as response:
            response.read()
