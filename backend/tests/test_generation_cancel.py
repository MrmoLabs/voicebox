"""Cancellation contract: stale clients, repeated clicks and completion races."""
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.database import Base, get_db
from backend.database.models import Generation, VoiceProfile
from backend.routes import generations


@pytest.fixture
def api(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'cancel.db'}", connect_args={"check_same_thread": False})
    factory = sessionmaker(bind=engine)
    Base.metadata.create_all(engine)
    with factory() as db:
        db.add(VoiceProfile(id="voice", name="Test", language="zh"))
        for status in ("generating", "completed", "failed"):
            db.add(Generation(id=status, profile_id="voice", text="Test", language="zh",
                              status=status, audio_path="preserved.wav", duration=2.5,
                              error="Generation cancelled" if status == "failed" else None))
        db.commit()
    calls = []
    monkeypatch.setattr(generations, "cancel_generation_job", lambda id: calls.append(id) or "queued")
    app = FastAPI()
    app.include_router(generations.router)

    def sessions():
        with factory() as db:
            yield db

    app.dependency_overrides[get_db] = sessions
    yield SimpleNamespace(app=app, factory=factory, calls=calls)
    engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["completed", "failed"])
async def test_terminal_cancel_is_repeatable_and_preserves_result(api, status):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as http:
        for _ in range(2):
            response = await http.post(f"/generate/{status}/cancel")
            assert response.status_code == 200
            assert response.json()["status"] == status
    assert not api.calls
    with api.factory() as db:
        row = db.get(Generation, status)
        assert (row.status, row.audio_path, row.duration) == (status, "preserved.wav", 2.5)
        assert row.error == ("Generation cancelled" if status == "failed" else None)


@pytest.mark.asyncio
async def test_queued_cancel_then_repeat_and_unknown_id(api):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as http:
        first = await http.post("/generate/generating/cancel")
        second = await http.post("/generate/generating/cancel")
        missing = await http.post("/generate/missing/cancel")
    assert first.status_code == second.status_code == 200
    assert first.json()["status"] == second.json()["status"] == "failed"
    assert api.calls == ["generating"]
    assert missing.status_code == 404
    with api.factory() as db:
        assert db.get(Generation, "generating").error == "Generation cancelled"


@pytest.mark.asyncio
async def test_completion_wins_worker_removal_race(api, monkeypatch):
    def finish(id):
        with api.factory() as db:
            db.get(Generation, id).status = "completed"
            db.commit()
        return None

    monkeypatch.setattr(generations, "cancel_generation_job", finish)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as http:
        response = await http.post("/generate/generating/cancel")
    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    with api.factory() as db:
        row = db.get(Generation, "generating")
        assert (row.status, row.audio_path, row.error) == ("completed", "preserved.wav", None)


@pytest.mark.asyncio
@pytest.mark.parametrize("worker_state,expected", [("running", "generating"), (None, "failed")])
async def test_running_and_orphaned_generation(api, monkeypatch, worker_state, expected):
    monkeypatch.setattr(generations, "cancel_generation_job", lambda id: worker_state)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as http:
        response = await http.post("/generate/generating/cancel")
    assert response.status_code == 200
    assert response.json()["status"] == expected
    with api.factory() as db:
        row = db.get(Generation, "generating")
        assert row.status == expected
        if worker_state is None:
            assert row.error == "Generation orphaned by worker"
