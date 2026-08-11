from contextlib import nullcontext

from backend.backends import pytorch_backend as qwen_base


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
    monkeypatch.setattr(qwen_base, "model_load_progress", lambda *_args: nullcontext())
    offline_calls = []
    monkeypatch.setattr(
        qwen_base,
        "force_offline_if_cached",
        lambda is_cached, label: offline_calls.append((is_cached, label)) or nullcontext(),
    )

    backend = qwen_base.PyTorchTTSBackend("1.7B")
    backend.device = "cuda"
    monkeypatch.setattr(backend, "_is_model_cached", lambda _size: cached)
    backend._load_model_sync("1.7B")
    return _FakeQwenModel.calls[0], offline_calls


def test_missing_base_model_is_allowed_to_download(monkeypatch):
    (_path, kwargs), offline_calls = _load(monkeypatch, cached=False)

    assert kwargs["local_files_only"] is False
    assert kwargs["cache_dir"]
    assert offline_calls == [(False, "qwen-tts-1.7B")]


def test_cached_base_model_forces_nested_loads_offline(monkeypatch):
    (_path, kwargs), offline_calls = _load(monkeypatch, cached=True)

    assert kwargs["local_files_only"] is True
    assert offline_calls == [(True, "qwen-tts-1.7B")]
