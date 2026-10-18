"""POST /speak — REST wrapper around voicebox_speak for non-MCP callers.

Shell scripts, ACP, A2A, or any agent that doesn't speak MCP can hit this
endpoint to play text through a cloned voice. Uses the same profile
resolution and generation pipeline as the MCP tool, so per-client
bindings (via X-Voicebox-Client-Id) work identically.
"""

from __future__ import annotations

import logging
import hashlib
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from .. import models
from ..database import MCPClientBinding, get_db
from ..database.models import Generation, SpeakDispatch
from ..mcp_server import events as mcp_events
from ..mcp_server.resolve import resolve_profile


logger = logging.getLogger(__name__)

router = APIRouter()


def _client_id(request: Request) -> str:
    client_id = request.headers.get("X-Voicebox-Client-Id", "").strip()
    if not client_id or len(client_id) > 200:
        raise HTTPException(400, "A client id of 1-200 characters is required for scoped speech")
    return client_id


def _dispatch_key(client_id: str, session_id: str, request_id: str) -> str:
    return hashlib.sha256(json.dumps([client_id, session_id, request_id]).encode()).hexdigest()


def _reserve(data: models.SpeakRequest, request: Request, db: Session):
    if data.request_id is None:
        return None, None
    client_id = _client_id(request)
    key = _dispatch_key(client_id, data.session_id, data.request_id)
    fingerprint = hashlib.sha256(data.model_dump_json().encode()).hexdigest()
    row = SpeakDispatch(id=key, client_id=client_id, session_id=data.session_id,
                        request_id=data.request_id, fingerprint=fingerprint)
    db.add(row)
    try:
        db.commit()
        return row, None
    except IntegrityError:
        db.rollback()
    row = db.get(SpeakDispatch, key)
    if row.fingerprint != fingerprint:
        raise HTTPException(409, "request_id was already used with different speech parameters")
    if not row.generation_id:
        raise HTTPException(409, "Speech request is pending or was interrupted; it will not be replayed")
    generation = db.get(Generation, row.generation_id)
    if generation is None:
        raise HTTPException(410, "Speech history was deleted; request_id will not be replayed")
    return row, generation


@router.post("/speak/cancel")
async def cancel_speech(data: models.SpeakCancelRequest, request: Request,
                        db: Session = Depends(get_db)):
    """Silence playback and cancel generation only within this caller's session."""
    query = db.query(SpeakDispatch).filter_by(client_id=_client_id(request), session_id=data.session_id)
    if data.request_id is not None:
        query = query.filter_by(request_id=data.request_id)
    rows = query.filter_by(cancelled=False).all()
    ids = []
    for row in rows:
        row.cancelled = True
        if row.generation_id:
            ids.append(row.generation_id)
    db.commit()
    # Playback may outlive generation. Always tell the player to stop, including
    # completed jobs, before waiting for inference cancellation.
    mcp_events.publish("speak-stop", {"generation_ids": ids})
    from .generations import cancel_generation
    for generation_id in ids:
        generation = db.get(Generation, generation_id)
        if generation and generation.status in ("loading_model", "generating"):
            await cancel_generation(generation_id, db)
    return {"generation_ids": ids}


@router.post("/speak", response_model=models.GenerationResponse)
async def speak(
    data: models.SpeakRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Speak text in a voice profile. Mirrors voicebox_speak (MCP).

    Response shape matches POST /generate — a ``GenerationResponse`` with
    ``status="generating"`` and an ``id`` the caller polls at
    ``GET /generate/{id}/status``.
    """
    client_id = request.headers.get("X-Voicebox-Client-Id", "").strip() or None
    # Reserve before any await. Unique SQLite keys also cover overlapping POSTs
    # and process restarts. Duplicate calls never republish a playback event.
    dispatch, previous = _reserve(data, request, db)
    if previous is not None:
        return previous
    profile = resolve_profile(data.profile, client_id, db)
    if profile is None:
        if dispatch is not None:
            db.delete(dispatch)
            db.commit()
        if data.profile:
            raise HTTPException(
                status_code=404,
                detail=f"Voice profile '{data.profile}' not found.",
            )
        raise HTTPException(
            status_code=400,
            detail=(
                "No voice profile resolved. Pass `profile` (name or id), "
                "or configure a default in Voicebox → Settings → MCP."
            ),
        )

    binding = None
    if client_id:
        binding = (
            db.query(MCPClientBinding)
            .filter(MCPClientBinding.client_id == client_id)
            .first()
        )

    # Resolve per-client personality default when the caller didn't pin it.
    personality_flag = data.personality
    if personality_flag is None and binding is not None:
        personality_flag = bool(binding.default_personality)

    engine = data.engine
    if engine is None and binding is not None:
        engine = binding.default_engine

    from .generations import generate_speech

    try:
        generation = await generate_speech(
            models.GenerationRequest(
                profile_id=profile.id,
                text=data.text,
                language=data.language or profile.language or "en",
                engine=engine,
                personality=bool(personality_flag),
                model_size=data.model_size,
                stream_audio=data.stream_audio,
                preview_mode=data.preview_mode,
                source="rest",
            ),
            db,
        )
    except HTTPException as error:
        if dispatch is not None and error.status_code < 500:
            db.delete(dispatch)
            db.commit()
        raise

    if dispatch is not None:
        db.refresh(dispatch)  # A concurrent cancellation can arrive during rewrite.
        dispatch.generation_id = generation.id
        db.commit()
        if dispatch.cancelled:
            from .generations import cancel_generation
            if generation.status in ("loading_model", "generating"):
                await cancel_generation(generation.id, db)
            return generation

    if data.playback_owner == "voicebox":
        mcp_events.publish(
            "speak-start",
            {
                "generation_id": getattr(generation, "id", None),
                "profile_name": profile.name,
                "source": "rest",
                "client_id": client_id,
                "session_id": data.session_id,
                "stream_audio": data.stream_audio,
                "playback_owner": data.playback_owner,
            },
        )
    return generation
