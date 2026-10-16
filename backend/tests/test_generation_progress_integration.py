import asyncio
import json

import numpy as np
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend import backends
from backend.database import Base, Generation, VoiceProfile
from backend.routes.generations import get_generation_status
from backend.services import generation, profiles
from backend.utils import tasks
from backend.utils.generation_progress import generation_progress


@pytest.mark.parametrize("fail", [False, True])
@pytest.mark.parametrize("stream_audio", [False, True])
def test_orchestration_stages_reach_sse_and_cleanup(monkeypatch, fail, stream_audio, tmp_path):
    from backend import config
    from backend.utils import live_audio
    monkeypatch.setattr(config, "get_cache_dir", lambda: tmp_path)
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    db.add(VoiceProfile(id="voice", name="Test"))
    db.add(Generation(id="job", profile_id="voice", text="Hello.", audio_path="", status="generating"))
    db.commit()
    monkeypatch.setattr(generation, "get_db", lambda: iter([db]))
    manager = tasks.TaskManager()
    monkeypatch.setattr(tasks, "_task_manager", manager)
    observed = []

    async def read_stage():
        response = await get_generation_status("job", db)
        try:
            event = await anext(response.body_iterator)
            return json.loads(event.removeprefix("data: ").strip())
        finally:
            await response.body_iterator.aclose()

    async def load(*args):
        observed.append((await read_stage())["progress"]["stage"])

    async def prepare(*args, **kwargs):
        observed.append((await read_stage())["progress"]["stage"])
        return {}

    class Backend:
        device = "cpu"
        model_size = "1.7B"

        def is_loaded(self):
            return False

        async def generate(self, *args):
            event = await read_stage()
            observed.append(event["progress"]["stage"])
            assert event["progress"]["completed_chunks"] == 0
            if fail:
                raise RuntimeError("test failure")
            return np.zeros(2400, dtype=np.float32), 24000

        async def generate_stream(self, *args):
            pcm, sr = await self.generate(*args)
            yield pcm, sr

    def save(**kwargs):
        observed.append(generation_progress.snapshot("job")["stage"])
        if stream_audio:
            assert live_audio.get_live_audio("job").samples > 0
            assert live_audio.get_live_audio("job").terminal is None
        return "generations/test.wav"

    monkeypatch.setattr(backends, "get_tts_backend_for_engine", lambda _: Backend())
    monkeypatch.setattr(backends, "load_engine_model", load)
    monkeypatch.setattr(profiles, "create_voice_prompt_for_profile", prepare)
    monkeypatch.setattr(generation, "_save_generate", save)
    monkeypatch.setattr(generation, "release_generation_memory", lambda _: None)
    monkeypatch.setattr(generation, "_notify_speak_end", lambda *args, **kwargs: None)

    async def run():
        if stream_audio:
            live_audio.create_live_audio("job")
        manager.start_generation("job", "voice", "Hello.")
        assert (await read_stage())["progress"]["stage"] == "queued"
        await generation.run_generation(
            generation_id="job", profile_id="voice", text="Hello.", language="en",
            engine="qwen", model_size="1.7B", seed=None, mode="generate",
            stream_audio=stream_audio,
        )
        event = await read_stage()
        assert event["status"] == ("failed" if fail else "completed")
        assert event["progress"] is None
        assert not manager.is_generation_active("job")
        if stream_audio:
            assert live_audio.get_live_audio("job").terminal == ("failed" if fail else "completed")

    try:
        asyncio.run(run())
        assert observed == ["loading_model", "preparing_voice", "generating"] + ([] if fail else ["finalizing"])
    finally:
        generation_progress.finish("job")
        live_audio._live.pop("job", None)
        db.close()
        engine.dispose()
