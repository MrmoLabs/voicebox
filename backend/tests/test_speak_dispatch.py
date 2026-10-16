"""REST contract tests with real SQLite and stubbed inference, no model loads."""
import asyncio
import uuid
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend import models
from backend.database import Base, get_db
from backend.database.models import Generation, SpeakDispatch, VoiceProfile
from backend.routes import generations, speak


@pytest.fixture
def api(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'dispatch.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as db:
        db.add(VoiceProfile(id="voice", name="Test", language="zh"))
        db.commit()
    calls, events, cancellations = [], [], []

    async def generate(data, db):
        calls.append(data)
        row = Generation(id=str(uuid.uuid4()), profile_id=data.profile_id, text=data.text,
                         language=data.language, source=data.source, status="generating")
        db.add(row)
        db.commit()
        return models.GenerationResponse.model_validate(row)

    async def cancel(generation_id, db):
        cancellations.append(generation_id)
        row = db.get(Generation, generation_id)
        row.status = "failed"
        db.commit()

    monkeypatch.setattr(generations, "generate_speech", generate)
    monkeypatch.setattr(generations, "cancel_generation", cancel)
    monkeypatch.setattr(speak.mcp_events, "publish", lambda kind, data: events.append((kind, data)))
    app = FastAPI()
    app.include_router(speak.router)

    def sessions():
        with factory() as db:
            yield db

    app.dependency_overrides[get_db] = sessions
    yield SimpleNamespace(app=app, factory=factory, calls=calls, events=events,
                          cancellations=cancellations, generate=generate)
    engine.dispose()


def body(**kwargs):
    return {"text": "你好。", "profile": "Test", "session_id": "session-a", "request_id": "turn-1", **kwargs}


def client(api, identity="dsh-a"):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test",
                            headers={"X-Voicebox-Client-Id": identity})


@pytest.mark.asyncio
async def test_stream_options_source_and_persistent_idempotence(api):
    data = body(stream_audio=True, model_size="0.6B", personality=False)
    async with client(api) as http:
        first = await http.post("/speak", json=data)
    # Fresh HTTP and database sessions simulate a disconnected caller retry.
    async with client(api) as http:
        second = await http.post("/speak", json=data)
    assert first.status_code == second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    assert len(api.calls) == len(api.events) == 1
    request = api.calls[0]
    assert (request.source, request.stream_audio, request.model_size, request.personality) == ("rest", True, "0.6B", False)
    assert api.events[0][1]["stream_audio"] is True
    assert api.events[0][1]["session_id"] == "session-a"


@pytest.mark.asyncio
async def test_conflict_deleted_history_and_client_playback_never_replay(api):
    async with client(api) as http:
        first = await http.post("/speak", json=body(playback_owner="client"))
        conflict = await http.post("/speak", json=body(text="Different"))
        with api.factory() as db:
            db.delete(db.get(Generation, first.json()["id"]))
            db.commit()
        deleted = await http.post("/speak", json=body(playback_owner="client"))
    assert conflict.status_code == 409
    assert deleted.status_code == 410
    assert len(api.calls) == 1 and not api.events


@pytest.mark.asyncio
async def test_cancel_scopes_to_client_session_and_also_stops_completed_audio(api):
    async with client(api) as a, client(api, "dsh-b") as b:
        first = await a.post("/speak", json=body())
        second = await a.post("/speak", json=body(session_id="session-b"))
        third = await b.post("/speak", json=body())
        with api.factory() as db:
            db.get(Generation, first.json()["id"]).status = "completed"
            db.commit()
        cancelled = await a.post("/speak/cancel", json={"session_id": "session-a"})
    assert cancelled.json()["generation_ids"] == [first.json()["id"]]
    assert api.events[-1] == ("speak-stop", {"generation_ids": [first.json()["id"]]})
    assert not api.cancellations
    assert second.json()["id"] != third.json()["id"]


@pytest.mark.asyncio
async def test_cancel_during_request_creation_prevents_late_playback(api, monkeypatch):
    entered, resume = asyncio.Event(), asyncio.Event()

    async def delayed(data, db):
        entered.set()
        await resume.wait()
        return await api.generate(data, db)

    monkeypatch.setattr(generations, "generate_speech", delayed)
    async with client(api) as http:
        pending = asyncio.create_task(http.post("/speak", json=body()))
        await entered.wait()
        await http.post("/speak/cancel", json={"session_id": "session-a"})
        resume.set()
        result = await pending
    assert result.status_code == 200
    assert api.cancellations == [result.json()["id"]]
    assert not any(kind == "speak-start" for kind, _ in api.events)


@pytest.mark.asyncio
async def test_overlapping_same_key_reserves_only_one_job(api, monkeypatch):
    entered, resume = asyncio.Event(), asyncio.Event()

    async def delayed(data, db):
        entered.set()
        await resume.wait()
        return await api.generate(data, db)

    monkeypatch.setattr(generations, "generate_speech", delayed)
    async with client(api) as http:
        pending = asyncio.create_task(http.post("/speak", json=body()))
        await entered.wait()
        duplicate = await http.post("/speak", json=body())
        resume.set()
        assert (await pending).status_code == 200
    assert duplicate.status_code == 409
    assert len(api.calls) == len(api.events) == 1


@pytest.mark.asyncio
async def test_legacy_requests_and_validation(api):
    async with client(api) as http:
        legacy = await http.post("/speak", json={"text": "Legacy", "profile": "Test"})
        invalid = await http.post("/speak", json={"text": "Missing request", "session_id": "session-a"})
        missing_profile = await http.post("/speak", json=body(profile="missing"))
        corrected = await http.post("/speak", json=body())
    assert legacy.status_code == corrected.status_code == 200
    assert invalid.status_code == 422 and missing_profile.status_code == 404
    with api.factory() as db:
        assert db.query(SpeakDispatch).count() == 1


@pytest.mark.asyncio
async def test_scoped_requests_require_client_identity(api):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as http:
        assert (await http.post("/speak", json=body())).status_code == 400
        assert (await http.post("/speak/cancel", json={"session_id": "session-a"})).status_code == 400
