"""Generation history endpoints."""

import io
import zipfile

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from .. import config, models
from ..services import export_import, history
from ..app import safe_content_disposition
from ..database import Generation as DBGeneration, VoiceProfile as DBVoiceProfile, get_db

router = APIRouter()


@router.get("/history", response_model=models.HistoryListResponse)
async def list_history(
    profile_id: str | None = None,
    search: str | None = None,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    """List generation history with optional filters."""
    query = models.HistoryQuery(
        profile_id=profile_id,
        search=search,
        limit=limit,
        offset=offset,
    )
    return await history.list_generations(query, db)


@router.get("/history/stats")
async def get_stats(db: Session = Depends(get_db)):
    """Get generation statistics."""
    return await history.get_generation_stats(db)


@router.post("/history/import")
async def import_generation(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Import a generation from a ZIP archive."""
    MAX_FILE_SIZE = 50 * 1024 * 1024

    content = await file.read()

    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400, detail=f"File too large. Maximum size is {MAX_FILE_SIZE / (1024 * 1024)}MB"
        )

    try:
        result = await export_import.import_generation_from_zip(content, db)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/history/failed")
async def clear_failed_generations(db: Session = Depends(get_db)):
    """Delete every generation with status='failed'. Used by the UI's 'Clear failed' button (#410)."""
    count = await history.delete_failed_generations(db)
    return {"deleted": count}


@router.post("/history/batch/favorite")
async def set_batch_favorite(
    request: models.GenerationBatchFavoriteRequest,
    db: Session = Depends(get_db),
):
    """Set a consistent favorite state for multiple generations."""
    updated = (
        db.query(DBGeneration)
        .filter(DBGeneration.id.in_(request.generation_ids))
        .update({DBGeneration.is_favorited: request.is_favorited}, synchronize_session=False)
    )
    db.commit()
    return {"updated": updated}


@router.post("/history/batch/delete")
async def delete_batch_generations(
    request: models.GenerationBatchRequest,
    db: Session = Depends(get_db),
):
    """Delete multiple generations and their stored audio."""
    deleted = 0
    for generation_id in request.generation_ids:
        if await history.delete_generation(generation_id, db):
            deleted += 1
    return {"deleted": deleted}


@router.post("/history/batch/export-audio")
async def export_batch_audio(
    request: models.GenerationBatchRequest,
    db: Session = Depends(get_db),
):
    """Export the available audio for selected generations as one ZIP."""
    generations = (
        db.query(DBGeneration)
        .filter(DBGeneration.id.in_(request.generation_ids))
        .all()
    )
    by_id = {generation.id: generation for generation in generations}
    archive = io.BytesIO()
    exported = 0
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for generation_id in request.generation_ids:
            generation = by_id.get(generation_id)
            if generation is None or not generation.audio_path:
                continue
            audio_path = config.resolve_storage_path(generation.audio_path)
            if audio_path is None or not audio_path.is_file():
                continue
            safe_text = "".join(
                c for c in generation.text[:30] if c.isalnum() or c in (" ", "-", "_")
            ).strip() or "generation"
            bundle.write(audio_path, f"{safe_text}-{generation.id[:8]}.wav")
            exported += 1

    if exported == 0:
        raise HTTPException(status_code=400, detail="None of the selected generations has audio")
    archive.seek(0)
    return StreamingResponse(
        archive,
        media_type="application/zip",
        headers={
            "Content-Disposition": safe_content_disposition(
                "attachment", f"voicebox-audio-{exported}-items.zip"
            )
        },
    )


@router.get("/history/{generation_id}", response_model=models.HistoryResponse)
async def get_generation(
    generation_id: str,
    db: Session = Depends(get_db),
):
    """Get a generation by ID."""
    result = (
        db.query(DBGeneration, DBVoiceProfile.name.label("profile_name"))
        .join(DBVoiceProfile, DBGeneration.profile_id == DBVoiceProfile.id)
        .filter(DBGeneration.id == generation_id)
        .first()
    )

    if not result:
        raise HTTPException(status_code=404, detail="Generation not found")

    gen, profile_name = result
    return models.HistoryResponse(
        id=gen.id,
        profile_id=gen.profile_id,
        profile_name=profile_name,
        text=gen.text,
        language=gen.language,
        audio_path=gen.audio_path,
        duration=gen.duration,
        seed=gen.seed,
        instruct=gen.instruct,
        engine=gen.engine or "qwen",
        model_size=gen.model_size,
        status=gen.status or "completed",
        error=gen.error,
        is_favorited=bool(gen.is_favorited),
        created_at=gen.created_at,
    )


@router.post("/history/{generation_id}/favorite")
async def toggle_favorite(
    generation_id: str,
    db: Session = Depends(get_db),
):
    """Toggle the favorite status of a generation."""
    gen = db.query(DBGeneration).filter_by(id=generation_id).first()
    if not gen:
        raise HTTPException(status_code=404, detail="Generation not found")
    gen.is_favorited = not gen.is_favorited
    db.commit()
    return {"is_favorited": gen.is_favorited}


@router.delete("/history/{generation_id}")
async def delete_generation(
    generation_id: str,
    db: Session = Depends(get_db),
):
    """Delete a generation."""
    success = await history.delete_generation(generation_id, db)
    if not success:
        raise HTTPException(status_code=404, detail="Generation not found")
    return {"message": "Generation deleted successfully"}


@router.get("/history/{generation_id}/export")
async def export_generation(
    generation_id: str,
    db: Session = Depends(get_db),
):
    """Export a generation as a ZIP archive."""
    generation = db.query(DBGeneration).filter_by(id=generation_id).first()
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")

    try:
        zip_bytes = export_import.export_generation_to_zip(generation_id, db)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    safe_text = "".join(c for c in generation.text[:30] if c.isalnum() or c in (" ", "-", "_")).strip()
    if not safe_text:
        safe_text = "generation"
    # Append a short id so exports of similarly-worded generations don't collide
    # on the same filename (the first 30 chars are frequently identical).
    filename = f"generation-{safe_text}-{generation_id[:8]}.voicebox.zip"

    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": safe_content_disposition("attachment", filename)},
    )


@router.get("/history/{generation_id}/export-audio")
async def export_generation_audio(
    generation_id: str,
    db: Session = Depends(get_db),
):
    """Export only the audio file from a generation."""
    generation = db.query(DBGeneration).filter_by(id=generation_id).first()
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")

    if not generation.audio_path:
        raise HTTPException(status_code=404, detail="Generation has no audio file")

    audio_path = config.resolve_storage_path(generation.audio_path)
    if audio_path is None or not audio_path.is_file():
        raise HTTPException(status_code=404, detail="Audio file not found")

    safe_text = "".join(c for c in generation.text[:30] if c.isalnum() or c in (" ", "-", "_")).strip()
    if not safe_text:
        safe_text = "generation"
    # Append a short id so exports of similarly-worded generations don't collide
    # on the same filename (the first 30 chars are frequently identical).
    filename = f"{safe_text}-{generation_id[:8]}.wav"

    return FileResponse(
        audio_path,
        media_type="audio/wav",
        headers={"Content-Disposition": safe_content_disposition("attachment", filename)},
    )
