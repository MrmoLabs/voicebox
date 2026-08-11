from contextlib import nullcontext

from backend.backends import qwen_custom_voice_backend as custom_voice


class _FakeQwenModel:
    calls = []

    @classmethod
    def from_pretrained(cls, model_path, **kwargs):
        cls.calls.append((model_path, kwargs))
        return object()


def _load(monkeypatch, *, cached: bool):
    import qwen_tts

    _FakeQwenModel.calls.clear()
    monkeypatch.setattr(qwen_tts, "Qwen3TTSModel", _FakeQwenModel)
    monkeypatch.setattr(custom_voice, "model_load_progress", lambda *_args: nullcontext())
    offline_calls = []
    monkeypatch.setattr(
        custom_voice,
        "force_offline_if_cached",
        lambda is_cached, label: offline_calls.append((is_cached, label)) or nullcontext(),
    )

    backend = custom_voice.QwenCustomVoiceBackend("1.7B")
    backend.device = "cuda"
    monkeypatch.setattr(backend, "_is_model_cached", lambda _size: cached)
    backend._load_model_sync("1.7B")
    return _FakeQwenModel.calls[0], offline_calls


def test_missing_custom_voice_model_is_allowed_to_download(monkeypatch):
    (_path, kwargs), offline_calls = _load(monkeypatch, cached=False)

    assert kwargs["local_files_only"] is False
    assert kwargs["cache_dir"]
    assert offline_calls == [(False, "qwen-custom-voice-1.7B")]


def test_cached_custom_voice_model_does_not_check_the_network(monkeypatch):
    (_path, kwargs), offline_calls = _load(monkeypatch, cached=True)

    assert kwargs["local_files_only"] is True
    assert offline_calls == [(True, "qwen-custom-voice-1.7B")]
