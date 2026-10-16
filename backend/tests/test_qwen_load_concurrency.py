import asyncio
import time

from backend.backends.pytorch_backend import PyTorchTTSBackend


def test_concurrent_requests_share_one_model_load(monkeypatch):
    backend = PyTorchTTSBackend("1.7B")
    calls = []

    def load(size):
        calls.append(size)
        time.sleep(0.03)
        backend.model = object()
        backend._current_model_size = size

    monkeypatch.setattr(backend, "_load_model_sync", load)

    async def requests():
        await asyncio.gather(*(backend.load_model_async("1.7B") for _ in range(4)))

    asyncio.run(requests())
    assert calls == ["1.7B"]


def test_qwen_prompt_cache_survives_memory_clear(tmp_path, monkeypatch):
    import torch
    from qwen_tts.inference.qwen3_tts_model import VoiceClonePromptItem
    from backend import config
    from backend.utils.cache import clear_voice_prompt_memory_cache

    monkeypatch.setattr(config, "get_cache_dir", lambda: tmp_path)
    audio = tmp_path / "voice.wav"
    audio.write_bytes(b"test reference audio")
    calls = []
    item = VoiceClonePromptItem(torch.ones(2, 2), torch.ones(4), False, True, "reference")

    class Model:
        def create_voice_clone_prompt(self, **kwargs):
            calls.append(kwargs)
            return [item]

    backend = PyTorchTTSBackend("1.7B")
    backend.model = Model()
    backend._current_model_size = "1.7B"

    async def requests():
        first, hit = await backend.create_voice_prompt(str(audio), "reference")
        assert not hit
        clear_voice_prompt_memory_cache()
        second, hit = await backend.create_voice_prompt(str(audio), "reference")
        assert hit
        assert second[0].ref_text == first[0].ref_text
        assert torch.equal(second[0].ref_code, first[0].ref_code)

    try:
        asyncio.run(requests())
        assert len(calls) == 1
    finally:
        clear_voice_prompt_memory_cache()
