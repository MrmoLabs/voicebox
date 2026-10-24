import asyncio
import struct
import threading
from types import SimpleNamespace

import numpy as np
import pytest

from backend import config
from backend.backends.pytorch_backend import PyTorchTTSBackend
from backend.utils import live_audio
from backend.utils.audio import normalize_audio


@pytest.mark.asyncio
async def test_reader_receives_audio_before_completion_and_can_resume(tmp_path):
    path = tmp_path / 'audio.f32'
    path.touch()
    state = live_audio.LiveAudio(path)
    reader = state.packets()
    pending = asyncio.create_task(anext(reader))
    await asyncio.sleep(0)
    assert not pending.done()
    await state.append(np.array([0.25, -0.5], dtype=np.float32), 24000)
    packet = await asyncio.wait_for(pending, 1)
    assert struct.unpack('<II', packet[:8]) == (24000, 2)
    assert state.terminal is None
    resumed = state.packets(1)
    assert (await anext(resumed))[8:] == np.array([-0.5], dtype='<f4').tobytes()
    state.finish('completed')
    assert await anext(reader) == struct.pack('<II', 0, 0)
    assert await anext(resumed) == struct.pack('<II', 0, 0)
    await reader.aclose()
    await resumed.aclose()


@pytest.mark.asyncio
async def test_failure_is_not_a_successful_eof_and_rate_changes_rejected(tmp_path):
    path = tmp_path / 'audio.f32'
    path.touch()
    state = live_audio.LiveAudio(path)
    await state.append(np.ones(2), 24000)
    with pytest.raises(ValueError, match='rate changed'):
        await state.append(np.ones(2), 16000)
    state.finish('failed')
    packets = [packet async for packet in state.packets()]
    assert packets[-1] == struct.pack('<II', 1, 0)


@pytest.mark.asyncio
async def test_long_text_streams_before_next_segment_and_spool_matches_crossfade(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'get_cache_dir', lambda: tmp_path)
    state = live_audio.create_live_audio('job')
    text = ('这是第一句话。我们需要很长的一段文字来验证增量输出。' * 10)
    segments = live_audio.live_text_chunks(text)
    assert len(segments) > 1
    assert ''.join(segments) == text
    calls = []

    class Backend:
        async def generate_stream(self, text, prompt, language, seed, instruct):
            if calls:
                assert state.samples > 0
            calls.append((text, seed))
            for _ in range(2):
                yield np.ones(1000, dtype=np.float32), 24000

    audio, rate = await live_audio.generate_live_audio(Backend(), 'job', text, {},
        language='zh', seed=10, instruct=None, crossfade_ms=10, max_chunk_chars=800)
    assert isinstance(audio, np.memmap)
    assert rate == 24000
    assert len(audio) == len(segments) * 2000 - (len(segments) - 1) * 240
    assert calls == [(segment, 10 + index) for index, segment in enumerate(segments)]
    assert all(len(segment) <= 80 for segment, _ in calls)
    np.testing.assert_allclose(audio, 1, atol=1e-6)
    normalized = live_audio.normalize_spooled_audio(audio, tmp_path / 'normalized.f32')
    np.testing.assert_allclose(normalized, normalize_audio(np.asarray(audio)), atol=1e-6)
    np.testing.assert_allclose(audio, 1, atol=1e-6)  # Preview remains immutable.
    del audio, normalized
    live_audio._live.pop('job')


def test_checked_short_sentences_are_not_split_into_a_tiny_opener_and_a_long_tail():
    text = '短开头。后面的正文还在同一句语音请求内，不应先播完短开头，再等待剩下的内容生成。'
    assert len(text) < 80
    assert live_audio.live_text_chunks(text) == [text]


@pytest.mark.asyncio
async def test_cancel_joins_producer_before_next_inference(monkeypatch):
    from unittest.mock import AsyncMock
    monkeypatch.setattr('backend.backends.pytorch_backend.check_preview_content', AsyncMock())
    backend = PyTorchTTSBackend()
    backend.device = 'cpu'
    backend._current_model_size = backend.model_size
    exited = threading.Event()
    running = threading.Event()
    calls = []

    class Model:
        def stream_generate_voice_clone(self, **kwargs):
            assert not running.is_set()
            running.set()
            calls.append(kwargs['text'])
            try:
                for _ in range(100):
                    yield np.full(100, .1, dtype=np.float32), 24000
            finally:
                running.clear()
                exited.set()

    backend.model = Model()
    stream = backend.generate_stream('first', {})
    await asyncio.wait_for(anext(stream), 2)
    await asyncio.wait_for(stream.aclose(), 2)
    assert exited.is_set() and not running.is_set()
    second = backend.generate_stream('second', {})
    await asyncio.wait_for(anext(second), 2)
    await asyncio.wait_for(second.aclose(), 2)
    assert calls == ['first', 'second']


@pytest.mark.asyncio
async def test_model_error_reaches_consumer_without_hanging():
    backend = PyTorchTTSBackend()
    backend.device = 'cpu'
    backend._current_model_size = backend.model_size

    def fail(**kwargs):
        raise RuntimeError('model failed')

    backend.model = SimpleNamespace(stream_generate_voice_clone=fail)
    with pytest.raises(RuntimeError, match='model failed'):
        await asyncio.wait_for(anext(backend.generate_stream('text', {})), 2)


@pytest.mark.asyncio
async def test_warmup_uses_serial_worker_without_creating_history(monkeypatch):
    from unittest.mock import MagicMock, AsyncMock
    from backend import backends
    from backend.routes import generations

    profile = SimpleNamespace(language='zh')
    monkeypatch.setattr(generations.profiles, 'get_profile', AsyncMock(return_value=profile))
    monkeypatch.setattr(generations.profiles, 'validate_profile_engine', lambda *_: None)
    monkeypatch.setattr(generations.profiles, 'create_voice_prompt_for_profile', AsyncMock(return_value={}))
    monkeypatch.setattr(backends, 'load_engine_model', AsyncMock())
    db = MagicMock()
    monkeypatch.setattr(generations, 'get_db', lambda: iter([db]))
    jobs = []

    class Backend:
        device = 'cuda:0'

        async def generate_stream(self, *args):
            yield np.zeros(100), 24000

    monkeypatch.setattr(backends, 'get_tts_backend_for_engine', lambda _: Backend())

    def enqueue(job_id, coro):
        jobs.append(job_id)
        asyncio.create_task(coro)

    monkeypatch.setattr(generations, 'enqueue_generation', enqueue)
    result = await generations.warm_live_preview('voice', '0.6B', db)
    assert result == {'ready': True, 'model_size': '0.6B'}
    assert len(jobs) == 1 and jobs[0].startswith('live-warmup-')
    assert not db.add.called and not db.commit.called
    db.close.assert_called_once()


@pytest.mark.asyncio
@pytest.mark.parametrize('condition,expected', [
    ('hot', {'ready': True, 'model_size': '1.7B'}),
    ('different', {'ready': False, 'skipped': 'different-model'}),
    ('uncached', {'ready': False, 'skipped': 'not-cached'}),
    ('busy', {'ready': False, 'skipped': 'busy'}),
])
async def test_cold_only_warmup_skips_existing_work_and_never_downloads(monkeypatch, condition, expected):
    from unittest.mock import MagicMock, AsyncMock
    from backend import backends
    from backend.routes import generations

    backend = SimpleNamespace(device='cuda:0', _current_model_size='0.6B' if condition == 'different' else '1.7B',
                              _inference_warmed=condition == 'hot', _is_model_cached=lambda _: condition != 'uncached')
    monkeypatch.setattr(backends, 'get_tts_backend_for_engine', lambda _: backend)
    monkeypatch.setattr(generations.profiles, 'get_profile', AsyncMock(return_value=SimpleNamespace(language='zh')))
    monkeypatch.setattr(generations.profiles, 'validate_profile_engine', lambda *_: None)
    monkeypatch.setattr(generations, 'current_activity', lambda: 'real speech' if condition == 'busy' else None)
    enqueue = MagicMock()
    monkeypatch.setattr(generations, 'enqueue_generation', enqueue)
    assert await generations.warm_live_preview('voice', '1.7B', MagicMock(), only_if_cold=True) == expected
    enqueue.assert_not_called()


@pytest.mark.asyncio
async def test_cold_warmup_coalesces_callers_and_keeps_worker_after_one_waiter_leaves(monkeypatch):
    from unittest.mock import MagicMock, AsyncMock
    from backend import backends
    from backend.routes import generations

    entered, release = asyncio.Event(), asyncio.Event()
    class Backend:
        device = 'cuda:0'
        _current_model_size = '1.7B'
        _inference_warmed = False
        def _is_model_cached(self, _):
            return True
        async def generate_stream(self, *args):
            entered.set()
            await release.wait()
            yield np.zeros(100), 24000
            self._inference_warmed = True

    backend = Backend()
    monkeypatch.setattr(backends, 'get_tts_backend_for_engine', lambda _: backend)
    monkeypatch.setattr(backends, 'load_engine_model', AsyncMock())
    monkeypatch.setattr(generations.profiles, 'get_profile', AsyncMock(return_value=SimpleNamespace(language='zh')))
    monkeypatch.setattr(generations.profiles, 'validate_profile_engine', lambda *_: None)
    prompt = AsyncMock(return_value={})
    monkeypatch.setattr(generations.profiles, 'create_voice_prompt_for_profile', prompt)
    db = MagicMock()
    monkeypatch.setattr(generations, 'get_db', lambda: iter([db]))
    work = []
    monkeypatch.setattr(generations, 'enqueue_generation', lambda _, coro: work.append(asyncio.create_task(coro)))
    first = asyncio.create_task(generations.warm_live_preview('voice', '1.7B', db, only_if_cold=True))
    await asyncio.wait_for(entered.wait(), 2)
    second = asyncio.create_task(generations.warm_live_preview('voice', '1.7B', db, only_if_cold=True))
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert len(work) == 1 and not work[0].done()
    release.set()
    assert await second == {'ready': True, 'model_size': '1.7B'}
    await asyncio.gather(*work)
    assert not generations._live_warmup_flights
    prompt.assert_awaited_once()
    assert not db.add.called and not db.commit.called
    assert await generations.warm_live_preview('voice', '1.7B', db, only_if_cold=True) == {'ready': True, 'model_size': '1.7B'}
    assert len(work) == 1, 'a warmed backend must not synthesize a second preparation clip'


@pytest.mark.asyncio
@pytest.mark.parametrize('changed_size,warmed,expected', [
    ('0.6B', False, {'ready': False, 'skipped': 'different-model'}),
    ('1.7B', True, {'ready': True, 'model_size': '1.7B'}),
])
async def test_queued_cold_preparation_rechecks_model_ownership(monkeypatch, changed_size, warmed, expected):
    from unittest.mock import MagicMock, AsyncMock
    from backend import backends
    from backend.routes import generations

    backend = SimpleNamespace(device='cuda:0', _current_model_size='1.7B',
                              _inference_warmed=False, _is_model_cached=lambda _: True)
    monkeypatch.setattr(backends, 'get_tts_backend_for_engine', lambda _: backend)
    load = AsyncMock()
    monkeypatch.setattr(backends, 'load_engine_model', load)
    monkeypatch.setattr(generations.profiles, 'get_profile', AsyncMock(return_value=SimpleNamespace(language='zh')))
    monkeypatch.setattr(generations.profiles, 'validate_profile_engine', lambda *_: None)
    db = MagicMock()
    monkeypatch.setattr(generations, 'get_db', lambda: iter([db]))
    queued = []
    monkeypatch.setattr(generations, 'enqueue_generation', lambda _, coro: queued.append(coro))
    caller = asyncio.create_task(generations.warm_live_preview('voice', '1.7B', db, only_if_cold=True))
    await asyncio.sleep(0)
    assert len(queued) == 1
    backend._current_model_size, backend._inference_warmed = changed_size, warmed
    await queued[0]
    assert await caller == expected
    load.assert_not_awaited()
    db.close.assert_called_once()
    assert not generations._live_warmup_flights


@pytest.mark.asyncio
@pytest.mark.parametrize('custom_device,allowed', [(False, True), (True, False)])
async def test_default_channel_allows_live_preview_custom_device_rejected(monkeypatch, custom_device, allowed):
    from unittest.mock import AsyncMock, MagicMock
    from fastapi import HTTPException
    from backend import backends, models
    from backend.routes import generations
    from backend.services import channels

    profile = SimpleNamespace(effects_chain=[], personality=None)
    monkeypatch.setattr(generations.profiles, 'get_profile', AsyncMock(return_value=profile))
    monkeypatch.setattr(generations.profiles, 'validate_profile_engine', lambda *_: None)
    monkeypatch.setattr(backends, 'get_tts_backend_for_engine', lambda _: SimpleNamespace(device='cuda'))
    monkeypatch.setattr(channels, 'get_profile_channels', AsyncMock(return_value=['output']))
    monkeypatch.setattr(channels, 'list_channels', AsyncMock(return_value=[SimpleNamespace(
        id='output', is_default=not custom_device, device_ids=['device'] if custom_device else [])]))
    # Reaching persistence proves validation accepted the default channel.
    monkeypatch.setattr(generations.history, 'create_generation', AsyncMock(side_effect=RuntimeError('accepted')))
    request = models.GenerationRequest(profile_id='voice', text='hello', engine='qwen', stream_audio=True)
    if allowed:
        with pytest.raises(RuntimeError, match='accepted'):
            await generations.generate_speech(request, MagicMock())
    else:
        with pytest.raises(HTTPException) as error:
            await generations.generate_speech(request, MagicMock())
        assert error.value.status_code == 400


@pytest.mark.asyncio
async def test_voice_prompt_cache_isolated_between_qwen_model_sizes(tmp_path, monkeypatch):
    import torch
    from backend.utils.cache import clear_voice_prompt_memory_cache
    monkeypatch.setattr(config, 'get_cache_dir', lambda: tmp_path)
    reference = tmp_path / 'reference.wav'
    reference.write_bytes(b'reference')
    calls = []
    backend = PyTorchTTSBackend()
    backend.device = 'cpu'

    class Model:
        def create_voice_clone_prompt(self, **kwargs):
            calls.append(backend.model_size)
            return {'embedding': torch.zeros(2048 if backend.model_size == '1.7B' else 1024)}

    backend.model = Model()
    try:
        for size, expected, cached in [('1.7B', 2048, False), ('0.6B', 1024, False), ('1.7B', 2048, True)]:
            backend.model_size = backend._current_model_size = size
            prompt, hit = await backend.create_voice_prompt(str(reference), 'reference')
            assert len(prompt['embedding']) == expected and hit == cached
            clear_voice_prompt_memory_cache()  # Also exercises disk round trips.
        assert calls == ['1.7B', '0.6B']
        assert len(list(tmp_path.glob('*.prompt'))) == 2
    finally:
        clear_voice_prompt_memory_cache()
