import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock

import numpy as np
import pytest

from backend import config, backends
from backend.backends.pytorch_backend import PyTorchTTSBackend
from backend.utils import speech_quality as quality


def test_content_check_rejects_noise_repetition_and_missing_text_but_allows_small_asr_errors():
    target = '三个可以叠加的控制方式：主要开关，预设音色用这个。'
    assert quality.content_matches(target, '三个可以叠加的控制方式主要开关预设音色用这个')
    assert quality.content_matches('这个 Web GUI 的交互行为，修改代码写测试。', '这个web GUI的交互行为修改代码写测试')
    assert not quality.content_matches(target, '三个可以叠加的控制方式' + '呦' * 120)
    assert not quality.content_matches(target, '好')
    assert not quality.content_matches('这是前半句。这里是很长的后半句话，不能仅仅读前面。', '这是前半句')
    assert quality.content_matches('你好', '妳好')
    assert quality.content_matches('1,698,969,835', '十六亿九千八百九十六万九千八百三十五')


@pytest.mark.parametrize('kind', ['nan', 'empty', 'long', 'gap', 'silent', 'clipped'])
def test_invalid_preview_is_rejected_before_publication(kind):
    audio = np.full(1000, .1)
    if kind == 'nan':
        audio[10] = np.nan
    elif kind == 'empty':
        audio = np.empty(0)
    elif kind == 'long':
        audio = np.full(9000, .1)
    elif kind == 'gap':
        audio = np.concatenate([audio, np.zeros(2500), audio])
    elif kind == 'silent':
        audio[:] = 0
    elif kind == 'clipped':
        audio[:] = 2
    with pytest.raises(quality.SpeechQualityError):
        quality.check_preview_audio(audio, 1000, 'hi')


@pytest.mark.asyncio
async def test_cached_local_recognizer_only_and_temporary_audio_is_removed(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'get_cache_dir', lambda: tmp_path)
    observed = []

    async def transcribe(path, **kwargs):
        from pathlib import Path
        assert Path(path).is_file()
        observed.append((path, kwargs))
        return '我听到了完全不同的内容'

    stt = SimpleNamespace(model_size='base', is_loaded=lambda: False,
        _is_model_cached=lambda size: size == 'turbo', transcribe=transcribe)
    monkeypatch.setattr(backends, 'get_stt_backend', lambda: stt)
    with pytest.raises(quality.SpeechQualityError, match='偏差过大'):
        await quality.check_preview_content(np.full(2400, .1), 24000, '请按这段原文生成清楚的语音。', 'zh')
    assert observed[0][1] == {'language': 'zh', 'model_size': 'turbo'}
    assert not list(tmp_path.iterdir())
    stt._is_model_cached = lambda size: False
    await quality.check_preview_content(np.full(2400, .1), 24000, '请按这段原文生成清楚的语音。', 'zh')
    assert len(observed) == 1  # No attempt to download or load a missing model.


@pytest.mark.asyncio
async def test_bad_clause_is_retried_before_any_audio_is_committed(monkeypatch):
    calls = []
    backend = PyTorchTTSBackend()
    backend.device = 'cpu'
    backend._current_model_size = backend.model_size

    def synthesize(**kwargs):
        calls.append(kwargs)
        yield np.full(2400, .1), 24000

    backend.model = SimpleNamespace(stream_generate_voice_clone=synthesize)
    check = AsyncMock(side_effect=[quality.SpeechQualityError('bad speech'), None])
    monkeypatch.setattr('backend.backends.pytorch_backend.check_preview_content', check)
    result = [item async for item in backend.generate_stream_checked('完整的测试短句', {}, seed=10)]
    assert len(result) == 1 and len(calls) == 2
    assert all(call['non_streaming_mode'] is True for call in calls)
    assert all(call['max_frames'] <= 750 for call in calls)
    assert check.await_count == 2
    check.side_effect = quality.SpeechQualityError('bad speech')
    exposed = []
    with pytest.raises(quality.SpeechQualityError):
        async for item in backend.generate_stream_checked('仍然不能播出的短句', {}):
            exposed.append(item)
    assert exposed == [] and len(calls) == 4


@pytest.mark.asyncio
async def test_realtime_publishes_before_completion_and_never_retries_audible_output(monkeypatch):
    release = threading.Event()
    calls = []
    backend = PyTorchTTSBackend()
    backend.device = 'cpu'
    backend._current_model_size = backend.model_size

    def synthesize(**kwargs):
        calls.append(kwargs)
        yield np.full(2400, .1), 24000
        release.wait(2)
        yield np.full(2400, np.nan), 24000

    backend.model = SimpleNamespace(stream_generate_voice_clone=synthesize)
    check = AsyncMock()
    monkeypatch.setattr('backend.backends.pytorch_backend.check_preview_content', check)
    stream = backend.generate_stream('边生成边播报的测试短句', {})
    try:
        packet = await asyncio.wait_for(anext(stream), 1)
        assert len(packet[0]) == 2400 and not release.is_set()
    finally:
        release.set()
    with pytest.raises(quality.SpeechQualityError, match='无效采样'):
        await asyncio.wait_for(anext(stream), 2)
    assert len(calls) == 1 and check.await_count == 0
    assert calls[0]['non_streaming_mode'] is True
    assert calls[0]['max_frames'] <= 375
    await stream.aclose()


@pytest.mark.asyncio
async def test_cancellation_during_collection_closes_worker_and_publishes_nothing(monkeypatch):
    started, exited = threading.Event(), threading.Event()
    backend = PyTorchTTSBackend()
    backend.device = 'cpu'
    backend._current_model_size = backend.model_size

    def synthesize(**kwargs):
        started.set()
        try:
            for _ in range(1000):
                threading.Event().wait(.005)
                yield np.full(100, .1), 24000
        finally:
            exited.set()

    backend.model = SimpleNamespace(stream_generate_voice_clone=synthesize)
    check = AsyncMock()
    monkeypatch.setattr('backend.backends.pytorch_backend.check_preview_content', check)
    stream = backend.generate_stream_checked('等待生成完整的短句', {})
    pending = asyncio.create_task(anext(stream))
    await asyncio.to_thread(started.wait, 2)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(pending, 2)
    assert exited.is_set() and check.await_count == 0
    await stream.aclose()


@pytest.mark.asyncio
async def test_cancelled_stt_keeps_model_ownership_until_worker_finishes(monkeypatch):
    from backend.backends.pytorch_backend import PyTorchSTTBackend
    started, release = threading.Event(), threading.Event()
    model_calls = []

    class Inputs(dict):
        def to(self, device):
            return self

    def generate(*args, **kwargs):
        model_calls.append(True)
        started.set()
        release.wait(2)
        return [[1]]

    class Processor:
        def __call__(self, *args, **kwargs):
            return Inputs(input_features=None)

        def batch_decode(self, *args, **kwargs):
            return ['voice']

    stt = PyTorchSTTBackend()
    stt.model = SimpleNamespace(generate=generate)
    stt.processor = Processor()
    stt.device = 'cpu'
    monkeypatch.setattr(stt, 'load_model_async', AsyncMock())
    monkeypatch.setattr('backend.backends.pytorch_backend.load_audio', lambda *args, **kwargs: (np.zeros(1600), 16000))
    first = asyncio.create_task(stt.transcribe('first.wav', 'zh'))
    await asyncio.to_thread(started.wait, 2)
    first.cancel()
    second = asyncio.create_task(stt.transcribe('second.wav', 'zh'))
    try:
        await asyncio.sleep(.02)
        assert not first.done() and len(model_calls) == 1
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert await second == 'voice'
    assert len(model_calls) == 2
