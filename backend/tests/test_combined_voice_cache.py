import asyncio
import threading
import numpy as np
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend import backends, config
from backend.database import Base, ProfileSample, VoiceProfile
from backend.services.profiles import create_voice_prompt_for_profile


def test_audio_preparation_runs_off_event_loop(monkeypatch):
    from backend.backends import base

    main_thread = threading.get_ident()
    calls = []

    def load(path, **kwargs):
        assert threading.get_ident() != main_thread
        calls.append((path, kwargs))
        return np.ones(100, dtype=np.float32), 24000

    monkeypatch.setattr(base, "load_audio", load)
    monkeypatch.setattr(base, "normalize_audio", lambda audio: audio)
    audio, text = asyncio.run(base.combine_voice_prompts(["a", "b"], ["Hello", "world"], sample_rate=24000))
    assert len(audio) == 200 and text == "Hello world"
    assert calls == [("a", {"sample_rate": 24000}), ("b", {"sample_rate": 24000})]


def test_combined_audio_reused_and_invalidated_by_content_and_text(tmp_path, monkeypatch):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    db.add(VoiceProfile(id="voice", name="Test", voice_type="cloned"))
    audio_paths = [tmp_path / "a.wav", tmp_path / "b.wav"]
    for index, path in enumerate(audio_paths):
        path.write_bytes(b"reference audio")
        db.add(ProfileSample(id=str(index), profile_id="voice", audio_path=str(path), reference_text=f"sample {index}"))
    db.commit()
    monkeypatch.setattr(config, "get_cache_dir", lambda: tmp_path)
    combinations = []
    prompts = []

    class Backend:
        async def combine_voice_prompts(self, paths, texts):
            combinations.append((paths, texts))
            return np.zeros(2400, dtype=np.float32), " ".join(texts)

        async def create_voice_prompt(self, path, text, **kwargs):
            prompts.append((path, text))
            return {"path": path}, False

    monkeypatch.setattr(backends, "get_tts_backend_for_engine", lambda _: Backend())

    def generate(**kwargs):
        return asyncio.run(create_voice_prompt_for_profile("voice", db, **kwargs))

    try:
        first = generate()
        assert generate() == first
        assert len(combinations) == 1
        audio_paths[0].write_bytes(b"replaced reference")
        assert generate() != first
        assert len(combinations) == 2
        sample = db.query(ProfileSample).filter_by(id="1").one()
        sample.reference_text = "corrected transcript"
        db.commit()
        generate()
        assert len(combinations) == 3
        assert prompts[-1][1] == "sample 0 corrected transcript"
        generate(use_cache=False)
        assert len(combinations) == 4
    finally:
        db.close()
        engine.dispose()
