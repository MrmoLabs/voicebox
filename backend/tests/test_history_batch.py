import io
import zipfile

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from starlette.testclient import TestClient

from backend import config
from backend.app import app
from backend.database import Base, Generation, VoiceProfile, get_db


@pytest.fixture
def batch_client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "_data_dir", tmp_path)
    generations_dir = tmp_path / "generations"
    generations_dir.mkdir()
    (generations_dir / "one.wav").write_bytes(b"RIFF-one")
    (generations_dir / "two.wav").write_bytes(b"RIFF-two")

    engine = create_engine(
        f"sqlite:///{tmp_path / 'test.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session = session_factory()
    session.add(VoiceProfile(id="profile-1", name="Test Profile"))
    session.add_all(
        [
            Generation(
                id="gen-1",
                profile_id="profile-1",
                text="First clip",
                audio_path="generations/one.wav",
                status="completed",
            ),
            Generation(
                id="gen-2",
                profile_id="profile-1",
                text="Second clip",
                audio_path="generations/two.wav",
                status="completed",
            ),
        ]
    )
    session.commit()
    session.close()

    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    yield TestClient(app), session_factory, tmp_path
    app.dependency_overrides.pop(get_db, None)


def test_batch_favorite_export_and_delete(batch_client):
    client, session_factory, data_dir = batch_client
    ids = ["gen-1", "gen-2"]

    favorite = client.post(
        "/history/batch/favorite",
        json={"generation_ids": ids, "is_favorited": True},
    )
    assert favorite.status_code == 200
    assert favorite.json() == {"updated": 2}

    export = client.post("/history/batch/export-audio", json={"generation_ids": ids})
    assert export.status_code == 200
    with zipfile.ZipFile(io.BytesIO(export.content)) as archive:
        assert sorted(archive.namelist()) == ["First clip-gen-1.wav", "Second clip-gen-2.wav"]

    delete = client.post("/history/batch/delete", json={"generation_ids": ids})
    assert delete.status_code == 200
    assert delete.json() == {"deleted": 2}
    assert not (data_dir / "generations" / "one.wav").exists()
    assert not (data_dir / "generations" / "two.wav").exists()

    session = session_factory()
    try:
        assert session.query(Generation).count() == 0
    finally:
        session.close()
