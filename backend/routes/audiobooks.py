"""Audiobook project, chapter, and sentence endpoints."""

import io
import re
import uuid
from datetime import datetime
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models
from .. import config
from ..database import (
    Audiobook,
    AudiobookChapter,
    AudiobookDeletedSentence,
    AudiobookGenerationPlan,
    AudiobookSentence,
    AudiobookSentenceAudio,
    Generation,
    VoiceProfile,
    get_db,
)
from ..services import history
from ..services.audiobook_generation_plans import start_plan
from ..services.task_queue import cancel_generation as cancel_generation_job
from ..utils.tasks import get_task_manager

router = APIRouter(prefix="/audiobooks", tags=["audiobooks"])


def _remember_sentence_audio(sentence_id: str, generation_id: str | None, db: Session) -> None:
    if generation_id and not db.query(AudiobookSentenceAudio.id).filter_by(generation_id=generation_id).first():
        db.add(AudiobookSentenceAudio(
            id=str(uuid.uuid4()), sentence_id=sentence_id, generation_id=generation_id,
        ))


def _audio_takes(sentence_id: str, selected_id: str | None, db: Session) -> list[dict]:
    _remember_sentence_audio(sentence_id, selected_id, db)
    links = db.query(AudiobookSentenceAudio).filter_by(sentence_id=sentence_id).order_by(AudiobookSentenceAudio.created_at).all()
    generation_ids = [link.generation_id for link in links]
    generations = {row.id: row for row in db.query(Generation).filter(Generation.id.in_(generation_ids)).all()} if generation_ids else {}
    profile_ids = {row.profile_id for row in generations.values() if row.profile_id}
    profiles = {row.id: row.name for row in db.query(VoiceProfile).filter(VoiceProfile.id.in_(profile_ids)).all()} if profile_ids else {}
    return [{
        "generation_id": generation.id, "status": generation.status or "completed",
        "error": generation.error, "duration": generation.duration,
        "audio_path": generation.audio_path, "profile_id": generation.profile_id,
        "profile_name": profiles.get(generation.profile_id), "engine": generation.engine,
        "model_size": generation.model_size, "created_at": generation.created_at,
        "selected": generation.id == selected_id,
    } for link in links if (generation := generations.get(link.generation_id))]


def _deleted_response(row: AudiobookDeletedSentence) -> dict:
    return {
        "deletion_id": row.id,
        "original_sentence_id": row.original_sentence_id,
        "chapter_id": row.chapter_id,
        "text": row.text,
        "paragraph_index": row.paragraph_index,
        "position": row.position,
        "generation_id": row.generation_id,
        "deleted_at": row.deleted_at,
    }


def _soft_delete_sentence(sentence: AudiobookSentence, db: Session) -> AudiobookDeletedSentence:
    deleted = AudiobookDeletedSentence(
        id=str(uuid.uuid4()),
        original_sentence_id=sentence.id,
        chapter_id=sentence.chapter_id,
        generation_id=sentence.generation_id,
        text=sentence.text,
        paragraph_index=sentence.paragraph_index,
        position=sentence.position,
        deleted_at=datetime.utcnow(),
    )
    db.add(deleted)
    db.delete(sentence)
    db.query(AudiobookSentence).filter(
        AudiobookSentence.chapter_id == sentence.chapter_id,
        AudiobookSentence.position > sentence.position,
    ).update({AudiobookSentence.position: AudiobookSentence.position - 1}, synchronize_session=False)
    return deleted


async def _delete_generation_if_unreferenced(generation_id: str | None, db: Session) -> bool:
    """Remove an audiobook generation only after every sentence snapshot lets go of it."""
    if not generation_id:
        return False
    active_reference = db.query(AudiobookSentence.id).filter_by(generation_id=generation_id).first()
    deleted_reference = db.query(AudiobookDeletedSentence.id).filter_by(generation_id=generation_id).first()
    take_reference = db.query(AudiobookSentenceAudio.id).filter_by(generation_id=generation_id).first()
    if active_reference or deleted_reference or take_reference:
        return False
    return await history.delete_generation(generation_id, db)


def split_long_text(text: str) -> tuple[list[dict], int]:
    """Split prose by paragraph and sentence-ending punctuation.

    Closing quotes/brackets stay attached to the sentence. Decimal points and
    common English abbreviations are protected from accidental splitting.
    """
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n|\n", normalized) if p.strip()]
    result: list[dict] = []
    position = 0
    abbreviations = {"mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "vs.", "etc."}
    for paragraph_index, paragraph in enumerate(paragraphs):
        start = 0
        for match in re.finditer(r"[。！？!?；;]+|…{2,}|\.(?=(?:[\"'”’）)】》]|\s|$))", paragraph):
            end = match.end()
            candidate = paragraph[start:end].strip()
            lower = candidate.lower()
            if match.group() == "." and (re.search(r"\d\.\d$", candidate) or any(lower.endswith(a) for a in abbreviations)):
                continue
            closing = re.match(r"[\"'”’）)】》]+", paragraph[end:])
            if closing:
                end += closing.end()
            candidate = paragraph[start:end].strip()
            if candidate:
                result.append({"text": candidate, "paragraph_index": paragraph_index, "position": position})
                position += 1
            start = end
        tail = paragraph[start:].strip()
        if tail:
            result.append({"text": tail, "paragraph_index": paragraph_index, "position": position})
            position += 1
    return result, len(paragraphs)


def _sentence_response(sentence: AudiobookSentence, db: Session) -> models.AudiobookSentenceResponse:
    generation = db.query(Generation).filter_by(id=sentence.generation_id).first() if sentence.generation_id else None
    profile_name = None
    if generation:
        profile = db.query(VoiceProfile).filter_by(id=generation.profile_id).first()
        profile_name = profile.name if profile else None
    error_category = None
    if generation and generation.error:
        lowered = generation.error.lower()
        if "profile not found" in lowered:
            error_category = "声音不存在"
        elif "out of memory" in lowered or "cuda oom" in lowered:
            error_category = "显存不足"
        elif "cancel" in lowered or "中止" in lowered:
            error_category = "主动取消"
        else:
            error_category = "模型错误"
    return models.AudiobookSentenceResponse(
        id=sentence.id, chapter_id=sentence.chapter_id, generation_id=sentence.generation_id,
        text=sentence.text, paragraph_index=sentence.paragraph_index, position=sentence.position,
        generation_status=(generation.status or "completed") if generation else None,
        generation_error=generation.error if generation else None,
        duration=generation.duration if generation else None,
        audio_path=generation.audio_path if generation else None,
        profile_id=generation.profile_id if generation else None,
        profile_name=profile_name, engine=generation.engine if generation else None,
        model_size=generation.model_size if generation else None,
        error_category=error_category,
        audio_takes=_audio_takes(sentence.id, sentence.generation_id, db),
    )


def _chapter_response(chapter: AudiobookChapter, db: Session) -> models.AudiobookChapterResponse:
    rows = db.query(AudiobookSentence).filter_by(chapter_id=chapter.id).order_by(AudiobookSentence.position).all()
    return models.AudiobookChapterResponse(
        id=chapter.id, audiobook_id=chapter.audiobook_id, title=chapter.title,
        source_text=chapter.source_text, position=chapter.position,
        sentences=[_sentence_response(row, db) for row in rows],
        created_at=chapter.created_at, updated_at=chapter.updated_at,
    )


def _book_response(book: Audiobook, db: Session, detail: bool = False):
    chapters = db.query(AudiobookChapter).filter_by(audiobook_id=book.id).order_by(AudiobookChapter.position).all()
    sentence_count = 0
    if chapters:
        sentence_count = db.query(func.count(AudiobookSentence.id)).filter(AudiobookSentence.chapter_id.in_([c.id for c in chapters])).scalar() or 0
    base = dict(id=book.id, title=book.title, author=book.author, description=book.description,
                chapter_count=len(chapters), sentence_count=sentence_count,
                created_at=book.created_at, updated_at=book.updated_at)
    if detail:
        return models.AudiobookDetailResponse(**base, chapters=[_chapter_response(c, db) for c in chapters])
    return models.AudiobookResponse(**base)


@router.post("/split", response_model=models.AudiobookSplitResponse)
def preview_split(data: models.AudiobookSplitRequest):
    sentences, paragraph_count = split_long_text(data.text)
    return {"sentences": sentences, "paragraph_count": paragraph_count}


@router.get("", response_model=list[models.AudiobookResponse])
def list_audiobooks(db: Session = Depends(get_db)):
    return [_book_response(book, db) for book in db.query(Audiobook).order_by(Audiobook.updated_at.desc()).all()]


@router.post("", response_model=models.AudiobookDetailResponse)
def create_audiobook(data: models.AudiobookCreate, db: Session = Depends(get_db)):
    book = Audiobook(id=str(uuid.uuid4()), **data.model_dump())
    db.add(book); db.commit(); db.refresh(book)
    return _book_response(book, db, True)


@router.get("/{book_id}", response_model=models.AudiobookDetailResponse)
def get_audiobook(book_id: str, db: Session = Depends(get_db)):
    book = db.query(Audiobook).filter_by(id=book_id).first()
    if not book: raise HTTPException(404, "Audiobook not found")
    return _book_response(book, db, True)


def _plan_response(plan: AudiobookGenerationPlan) -> dict:
    return {
        "id": plan.id,
        "audiobook_id": plan.audiobook_id,
        "chapter_id": plan.chapter_id,
        "sentence_count": len(plan.sentence_ids or []),
        "next_index": plan.next_index,
        "status": plan.status,
        "performance_mode": (plan.request_settings or {}).get("performance_mode", "stable"),
    }


@router.post("/{book_id}/generation-plans", response_model=models.AudiobookGenerationPlanResponse)
async def create_generation_plan(
    book_id: str,
    data: models.AudiobookGenerationPlanCreate,
    db: Session = Depends(get_db),
):
    chapter = db.query(AudiobookChapter).filter_by(id=data.chapter_id, audiobook_id=book_id).first()
    if not chapter:
        raise HTTPException(404, "Chapter not found")
    rows = db.query(AudiobookSentence).filter(
        AudiobookSentence.chapter_id == data.chapter_id,
        AudiobookSentence.id.in_(data.sentence_ids),
    ).all()
    if len(rows) != len(set(data.sentence_ids)):
        raise HTTPException(404, "One or more sentences were not found")
    if not db.query(VoiceProfile).filter_by(id=data.profile_id).first():
        raise HTTPException(404, "Profile not found")
    active = db.query(AudiobookGenerationPlan).filter_by(audiobook_id=book_id, status="running").first()
    if active:
        raise HTTPException(409, "This audiobook already has an active generation plan")
    settings = {
        "profile_id": data.profile_id,
        "language": data.language,
        "engine": data.engine,
        "model_size": data.model_size,
        "instruct": data.instruct,
        "performance_mode": data.performance_mode,
    }
    generation_settings = {key: value for key, value in settings.items() if key != "performance_mode" and value is not None}
    generation_settings["performance_mode"] = data.performance_mode
    plan = AudiobookGenerationPlan(
        id=str(uuid.uuid4()),
        audiobook_id=book_id,
        chapter_id=data.chapter_id,
        sentence_ids=data.sentence_ids,
        request_settings=generation_settings,
        submitted_generation_ids={},
        status="running",
        next_index=0,
    )
    db.add(plan)
    db.commit()
    db.refresh(plan)
    start_plan(plan.id)
    return _plan_response(plan)


@router.get("/{book_id}/generation-plans/active", response_model=models.AudiobookGenerationPlanResponse | None)
def get_active_generation_plan(book_id: str, db: Session = Depends(get_db)):
    plan = (
        db.query(AudiobookGenerationPlan)
        .filter(AudiobookGenerationPlan.audiobook_id == book_id, AudiobookGenerationPlan.status == "running")
        .order_by(AudiobookGenerationPlan.created_at.desc())
        .first()
    )
    return _plan_response(plan) if plan else None


@router.delete("/{book_id}")
def delete_audiobook(book_id: str, db: Session = Depends(get_db)):
    book = db.query(Audiobook).filter_by(id=book_id).first()
    if not book: raise HTTPException(404, "Audiobook not found")
    chapter_ids = [c.id for c in db.query(AudiobookChapter).filter_by(audiobook_id=book_id).all()]
    db.query(AudiobookGenerationPlan).filter_by(audiobook_id=book_id).delete(synchronize_session=False)
    if chapter_ids:
        db.query(AudiobookDeletedSentence).filter(AudiobookDeletedSentence.chapter_id.in_(chapter_ids)).delete(synchronize_session=False)
        db.query(AudiobookSentence).filter(AudiobookSentence.chapter_id.in_(chapter_ids)).delete(synchronize_session=False)
    db.query(AudiobookChapter).filter_by(audiobook_id=book_id).delete()
    db.delete(book); db.commit()
    return {"message": "Audiobook deleted"}


@router.post("/{book_id}/cancel-generation", response_model=models.AudiobookCancelResponse)
async def cancel_audiobook_generation(book_id: str, db: Session = Depends(get_db)):
    """Cancel every active generation bound anywhere in this book."""
    book = db.query(Audiobook).filter_by(id=book_id).first()
    if not book:
        raise HTTPException(404, "Audiobook not found")
    db.query(AudiobookGenerationPlan).filter_by(audiobook_id=book_id, status="running").update(
        {AudiobookGenerationPlan.status: "cancelled"}, synchronize_session=False
    )
    db.commit()
    chapter_ids = [row.id for row in db.query(AudiobookChapter.id).filter_by(audiobook_id=book_id).all()]
    if not chapter_ids:
        return {"matched": 0, "cancelled": 0, "already_finished": 0}
    generation_ids = [
        row[0]
        for row in db.query(AudiobookSentence.generation_id)
        .filter(
            AudiobookSentence.chapter_id.in_(chapter_ids),
            AudiobookSentence.generation_id.isnot(None),
        )
        .distinct()
        .all()
    ]
    task_manager = get_task_manager()
    cancelled = 0
    already_finished = 0
    for generation_id in generation_ids:
        generation = db.query(Generation).filter_by(id=generation_id).first()
        if not generation or (generation.status or "completed") not in ("loading_model", "generating"):
            already_finished += 1
            continue
        cancellation_state = cancel_generation_job(generation_id)
        if cancellation_state == "running":
            cancelled += 1
            continue
        task_manager.complete_generation(generation_id)
        error = "Audiobook generation cancelled" if cancellation_state == "queued" else "Audiobook generation was orphaned and cancelled"
        await history.update_generation_status(
            generation_id=generation_id,
            status="failed",
            db=db,
            error=error,
        )
        cancelled += 1
    return {"matched": len(generation_ids), "cancelled": cancelled, "already_finished": already_finished}


@router.post("/{book_id}/chapters", response_model=models.AudiobookChapterResponse)
def create_chapter(book_id: str, data: models.AudiobookChapterCreate, db: Session = Depends(get_db)):
    book = db.query(Audiobook).filter_by(id=book_id).first()
    if not book: raise HTTPException(404, "Audiobook not found")
    position = db.query(func.count(AudiobookChapter.id)).filter_by(audiobook_id=book_id).scalar() or 0
    chapter = AudiobookChapter(id=str(uuid.uuid4()), audiobook_id=book_id, title=data.title,
                               source_text=data.source_text, position=position)
    db.add(chapter); book.updated_at = datetime.utcnow(); db.commit(); db.refresh(chapter)
    return _chapter_response(chapter, db)


@router.put("/chapters/{chapter_id}/split", response_model=models.AudiobookChapterResponse)
def replace_chapter_sentences(chapter_id: str, data: models.AudiobookSplitRequest, db: Session = Depends(get_db)):
    chapter = db.query(AudiobookChapter).filter_by(id=chapter_id).first()
    if not chapter: raise HTTPException(404, "Chapter not found")
    sentences, _ = split_long_text(data.text)
    if not sentences: raise HTTPException(400, "No readable sentences found")
    db.query(AudiobookSentence).filter_by(chapter_id=chapter_id).delete()
    for item in sentences:
        db.add(AudiobookSentence(id=str(uuid.uuid4()), chapter_id=chapter_id, **item))
    chapter.source_text = data.text; chapter.updated_at = datetime.utcnow()
    db.commit(); db.refresh(chapter)
    return _chapter_response(chapter, db)


@router.patch("/sentences/{sentence_id}", response_model=models.AudiobookSentenceResponse)
def update_sentence(sentence_id: str, data: models.AudiobookSentenceUpdate, db: Session = Depends(get_db)):
    sentence = db.query(AudiobookSentence).filter_by(id=sentence_id).first()
    if not sentence: raise HTTPException(404, "Sentence not found")
    values = data.model_dump(exclude_unset=True)
    previous_generation_id = sentence.generation_id
    if "generation_id" in values and values["generation_id"]:
        if not db.query(Generation).filter_by(id=values["generation_id"]).first():
            raise HTTPException(404, "Generation not found")
    if "text" in values and values["text"] != sentence.text:
        sentence.text = values["text"]; sentence.generation_id = None
    if "generation_id" in values:
        _remember_sentence_audio(sentence.id, previous_generation_id, db)
        sentence.generation_id = values["generation_id"]
    _remember_sentence_audio(sentence.id, sentence.generation_id, db)
    sentence.updated_at = datetime.utcnow(); db.commit(); db.refresh(sentence)
    return _sentence_response(sentence, db)


@router.post("/chapters/{chapter_id}/sentences", response_model=models.AudiobookSentenceResponse)
def create_sentence(chapter_id: str, data: models.AudiobookSentenceCreate, db: Session = Depends(get_db)):
    chapter = db.query(AudiobookChapter).filter_by(id=chapter_id).first()
    if not chapter:
        raise HTTPException(404, "Chapter not found")
    count = db.query(func.count(AudiobookSentence.id)).filter_by(chapter_id=chapter_id).scalar() or 0
    position = min(data.position if data.position is not None else count, count)
    db.query(AudiobookSentence).filter(
        AudiobookSentence.chapter_id == chapter_id,
        AudiobookSentence.position >= position,
    ).update({AudiobookSentence.position: AudiobookSentence.position + 1}, synchronize_session=False)
    if data.paragraph_index is None:
        previous = (
            db.query(AudiobookSentence)
            .filter(AudiobookSentence.chapter_id == chapter_id, AudiobookSentence.position < position)
            .order_by(AudiobookSentence.position.desc())
            .first()
        )
        paragraph_index = previous.paragraph_index if previous else 0
    else:
        paragraph_index = data.paragraph_index
    sentence = AudiobookSentence(
        id=str(uuid.uuid4()), chapter_id=chapter_id, text=data.text.strip(),
        paragraph_index=paragraph_index, position=position,
    )
    db.add(sentence); chapter.updated_at = datetime.utcnow(); db.commit(); db.refresh(sentence)
    return _sentence_response(sentence, db)


@router.put("/chapters/{chapter_id}/sentences/reorder", response_model=models.AudiobookChapterResponse)
def reorder_sentences(chapter_id: str, data: models.AudiobookSentenceReorder, db: Session = Depends(get_db)):
    chapter = db.query(AudiobookChapter).filter_by(id=chapter_id).first()
    if not chapter:
        raise HTTPException(404, "Chapter not found")
    rows = db.query(AudiobookSentence).filter_by(chapter_id=chapter_id).all()
    by_id = {row.id: row for row in rows}
    if len(data.sentence_ids) != len(rows) or set(data.sentence_ids) != set(by_id):
        raise HTTPException(400, "Reorder list must contain every sentence in this chapter exactly once")
    for position, sentence_id in enumerate(data.sentence_ids):
        by_id[sentence_id].position = position
    chapter.updated_at = datetime.utcnow()
    db.commit(); db.refresh(chapter)
    return _chapter_response(chapter, db)


@router.post("/chapters/{chapter_id}/sentences/restore", response_model=models.AudiobookSentenceResponse)
def restore_sentence(chapter_id: str, data: models.AudiobookSentenceRestore, db: Session = Depends(get_db)):
    chapter = db.query(AudiobookChapter).filter_by(id=chapter_id).first()
    if not chapter:
        raise HTTPException(404, "Chapter not found")
    deleted = None
    if data.deletion_id:
        deleted = db.query(AudiobookDeletedSentence).filter_by(id=data.deletion_id, chapter_id=chapter_id).first()
        if not deleted:
            raise HTTPException(404, "Deleted sentence not found")
    generation_id = deleted.generation_id if deleted else data.generation_id
    count = db.query(func.count(AudiobookSentence.id)).filter_by(chapter_id=chapter_id).scalar() or 0
    position = min(deleted.position if deleted else data.position, count)
    if generation_id and not db.query(Generation).filter_by(id=generation_id).first():
        raise HTTPException(404, "Generation not found")
    db.query(AudiobookSentence).filter(
        AudiobookSentence.chapter_id == chapter_id,
        AudiobookSentence.position >= position,
    ).update({AudiobookSentence.position: AudiobookSentence.position + 1}, synchronize_session=False)
    sentence = AudiobookSentence(
        id=(deleted.original_sentence_id if deleted else str(uuid.uuid4())),
        chapter_id=chapter_id,
        text=(deleted.text if deleted else data.text),
        paragraph_index=(deleted.paragraph_index if deleted else data.paragraph_index),
        position=position,
        generation_id=generation_id,
    )
    db.add(sentence)
    if deleted:
        db.delete(deleted)
    chapter.updated_at = datetime.utcnow(); db.commit(); db.refresh(sentence)
    return _sentence_response(sentence, db)


@router.get(
    "/chapters/{chapter_id}/deleted-sentences",
    response_model=list[models.AudiobookDeletedSentenceResponse],
)
def list_deleted_sentences(chapter_id: str, db: Session = Depends(get_db)):
    if not db.query(AudiobookChapter).filter_by(id=chapter_id).first():
        raise HTTPException(404, "Chapter not found")
    rows = (
        db.query(AudiobookDeletedSentence)
        .filter_by(chapter_id=chapter_id)
        .order_by(AudiobookDeletedSentence.deleted_at.desc())
        .all()
    )
    return [_deleted_response(row) for row in rows]


@router.get(
    "/chapters/{chapter_id}/sentence-statuses",
    response_model=list[models.AudiobookSentenceStatusResponse],
)
def get_sentence_statuses(chapter_id: str, db: Session = Depends(get_db)):
    from ..utils.generation_progress import generation_progress
    if not db.query(AudiobookChapter).filter_by(id=chapter_id).first():
        raise HTTPException(404, "Chapter not found")
    rows = db.query(AudiobookSentence).filter_by(chapter_id=chapter_id).all()
    generation_ids = [row.generation_id for row in rows if row.generation_id]
    generations = {
        generation.id: generation
        for generation in db.query(Generation).filter(Generation.id.in_(generation_ids)).all()
    } if generation_ids else {}
    profile_ids = {generation.profile_id for generation in generations.values() if generation.profile_id}
    profile_names = {
        profile.id: profile.name
        for profile in db.query(VoiceProfile).filter(VoiceProfile.id.in_(profile_ids)).all()
    } if profile_ids else {}
    result = []
    for row in rows:
        generation = generations.get(row.generation_id)
        error_category = None
        if generation and generation.error:
            lowered = generation.error.lower()
            if "profile not found" in lowered:
                error_category = "声音不存在"
            elif "out of memory" in lowered or "cuda oom" in lowered:
                error_category = "显存不足"
            elif "cancel" in lowered or "中止" in lowered:
                error_category = "主动取消"
            else:
                error_category = "模型错误"
        result.append({
            "id": row.id,
            "generation_id": row.generation_id,
            "generation_status": (generation.status or "completed") if generation else None,
            "generation_progress": generation_progress.snapshot(generation.id) if generation and generation.status in ("loading_model", "generating") else None,
            "generation_error": generation.error if generation else None,
            "error_category": error_category,
            "duration": generation.duration if generation else None,
            "audio_path": generation.audio_path if generation else None,
            "profile_id": generation.profile_id if generation else None,
            "profile_name": profile_names.get(generation.profile_id) if generation else None,
            "engine": generation.engine if generation else None,
            "model_size": generation.model_size if generation else None,
            "audio_takes": _audio_takes(row.id, row.generation_id, db),
        })
    return result


@router.post(
    "/chapters/{chapter_id}/sentences/batch-restore",
    response_model=list[models.AudiobookSentenceResponse],
)
def batch_restore_sentences(
    chapter_id: str,
    data: models.AudiobookSentenceBatchRestoreRequest,
    db: Session = Depends(get_db),
):
    chapter = db.query(AudiobookChapter).filter_by(id=chapter_id).first()
    if not chapter:
        raise HTTPException(404, "Chapter not found")
    rows = db.query(AudiobookDeletedSentence).filter(
        AudiobookDeletedSentence.chapter_id == chapter_id,
        AudiobookDeletedSentence.id.in_(data.deletion_ids),
    ).all()
    if len(rows) != len(set(data.deletion_ids)):
        raise HTTPException(404, "One or more deleted sentences were not found")
    restored = []
    for deleted in sorted(rows, key=lambda row: row.position):
        count = db.query(func.count(AudiobookSentence.id)).filter_by(chapter_id=chapter_id).scalar() or 0
        position = min(deleted.position, count)
        db.query(AudiobookSentence).filter(
            AudiobookSentence.chapter_id == chapter_id,
            AudiobookSentence.position >= position,
        ).update({AudiobookSentence.position: AudiobookSentence.position + 1}, synchronize_session=False)
        sentence = AudiobookSentence(
            id=deleted.original_sentence_id,
            chapter_id=chapter_id,
            generation_id=deleted.generation_id,
            text=deleted.text,
            paragraph_index=deleted.paragraph_index,
            position=position,
        )
        db.add(sentence)
        db.delete(deleted)
        restored.append(sentence)
    chapter.updated_at = datetime.utcnow()
    db.commit()
    return [_sentence_response(sentence, db) for sentence in restored]


@router.get("/chapters/{chapter_id}/export-audio")
def export_chapter_audio(chapter_id: str, pause_ms: int = 300, db: Session = Depends(get_db)):
    import numpy as np
    import soundfile as sf
    if pause_ms < 0 or pause_ms > 10000:
        raise HTTPException(400, "pause_ms must be between 0 and 10000")
    chapter = db.query(AudiobookChapter).filter_by(id=chapter_id).first()
    if not chapter:
        raise HTTPException(404, "Chapter not found")
    rows = db.query(AudiobookSentence).filter_by(chapter_id=chapter_id).order_by(AudiobookSentence.position).all()
    chunks = []
    sample_rate = None
    for sentence in rows:
        generation = db.query(Generation).filter_by(id=sentence.generation_id).first() if sentence.generation_id else None
        path = config.resolve_storage_path(generation.audio_path) if generation and generation.audio_path else None
        if not path or not path.is_file():
            continue
        audio, rate = sf.read(path, dtype="float32", always_2d=False)
        if sample_rate is None:
            sample_rate = rate
        if rate != sample_rate:
            raise HTTPException(400, "Chapter contains audio with different sample rates")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        chunks.append(audio)
    if not chunks or sample_rate is None:
        raise HTTPException(400, "Chapter has no generated audio")
    silence = np.zeros(int(sample_rate * pause_ms / 1000), dtype=np.float32)
    combined_parts = []
    for index, chunk in enumerate(chunks):
        if index and silence.size:
            combined_parts.append(silence)
        combined_parts.append(chunk)
    output = io.BytesIO()
    sf.write(output, np.concatenate(combined_parts), sample_rate, format="WAV", subtype="PCM_16")
    output.seek(0)
    filename = f"{chapter.title}.wav"
    return StreamingResponse(output, media_type="audio/wav", headers={
        "Content-Disposition": f"attachment; filename=chapter.wav; filename*=UTF-8''{quote(filename, safe='')}"
    })


@router.delete("/sentences/{sentence_id}")
@router.post("/sentences/{sentence_id}/delete")
def delete_sentence(sentence_id: str, db: Session = Depends(get_db)):
    sentence = db.query(AudiobookSentence).filter_by(id=sentence_id).first()
    if not sentence:
        raise HTTPException(404, "Sentence not found")
    deleted = _soft_delete_sentence(sentence, db)
    chapter = db.query(AudiobookChapter).filter_by(id=deleted.chapter_id).first()
    if chapter:
        chapter.updated_at = datetime.utcnow()
    db.commit()
    return {"message": "Sentence deleted", "snapshot": _deleted_response(deleted)}


@router.post("/sentences/batch-delete")
def batch_delete_sentences(data: models.AudiobookSentenceBatchRequest, db: Session = Depends(get_db)):
    rows = db.query(AudiobookSentence).filter(AudiobookSentence.id.in_(data.sentence_ids)).all()
    if len(rows) != len(set(data.sentence_ids)):
        raise HTTPException(404, "One or more sentences were not found")
    chapter_ids = {row.chapter_id for row in rows}
    if len(chapter_ids) != 1:
        raise HTTPException(400, "Batch delete must target one chapter")
    deleted_rows = []
    for sentence in sorted(rows, key=lambda row: row.position, reverse=True):
        deleted_rows.append(_soft_delete_sentence(sentence, db))
    chapter = db.query(AudiobookChapter).filter_by(id=next(iter(chapter_ids))).first()
    if chapter:
        chapter.updated_at = datetime.utcnow()
    db.commit()
    return {
        "message": f"Deleted {len(deleted_rows)} sentences",
        "snapshots": [_deleted_response(row) for row in deleted_rows],
    }


@router.post("/sentences/{sentence_id}/audio/delete")
async def delete_sentence_audio(sentence_id: str, db: Session = Depends(get_db)):
    """Detach and permanently remove the audio currently bound to one sentence."""
    sentence = db.query(AudiobookSentence).filter_by(id=sentence_id).first()
    if not sentence:
        raise HTTPException(404, "Sentence not found")
    generation_id = sentence.generation_id
    if not generation_id:
        raise HTTPException(400, "Sentence has no generated audio")
    sentence.generation_id = None
    db.query(AudiobookSentenceAudio).filter_by(generation_id=generation_id).delete()
    sentence.updated_at = datetime.utcnow()
    db.commit()
    removed = await _delete_generation_if_unreferenced(generation_id, db)
    return {"message": "Sentence audio deleted", "generation_id": generation_id, "removed": removed}


@router.post("/sentences/{sentence_id}/obsolete-audio/{generation_id}/delete")
async def delete_obsolete_sentence_audio(
    sentence_id: str,
    generation_id: str,
    db: Session = Depends(get_db),
):
    """Clean up the previous generation after a sentence was rebound successfully."""
    sentence = db.query(AudiobookSentence).filter_by(id=sentence_id).first()
    if not sentence:
        raise HTTPException(404, "Sentence not found")
    if sentence.generation_id == generation_id:
        raise HTTPException(409, "Cannot delete the audio currently bound to the sentence")
    generation = db.query(Generation).filter_by(id=generation_id).first()
    if not generation:
        return {"message": "Obsolete audio already deleted", "generation_id": generation_id, "removed": False}
    if generation.source != "audiobook" or generation.text != sentence.text:
        raise HTTPException(400, "Generation does not belong to this audiobook sentence")
    db.query(AudiobookSentenceAudio).filter_by(sentence_id=sentence_id, generation_id=generation_id).delete()
    db.commit()
    removed = await _delete_generation_if_unreferenced(generation_id, db)
    return {"message": "Obsolete sentence audio deleted", "generation_id": generation_id, "removed": removed}


@router.post("/deleted-sentences/{deletion_id}/delete")
async def permanently_delete_sentence(deletion_id: str, db: Session = Depends(get_db)):
    """Permanently remove a recycle-bin snapshot and its now-unused audio."""
    deleted = db.query(AudiobookDeletedSentence).filter_by(id=deletion_id).first()
    if not deleted:
        raise HTTPException(404, "Deleted sentence not found")
    generation_ids = [row[0] for row in db.query(AudiobookSentenceAudio.generation_id).filter_by(
        sentence_id=deleted.original_sentence_id,
    ).all()]
    if deleted.generation_id and deleted.generation_id not in generation_ids:
        generation_ids.append(deleted.generation_id)
    db.query(AudiobookSentenceAudio).filter_by(sentence_id=deleted.original_sentence_id).delete()
    db.delete(deleted)
    db.commit()
    removed = 0
    for generation_id in generation_ids:
        removed += int(await _delete_generation_if_unreferenced(generation_id, db))
    return {"message": "Deleted sentence permanently removed", "audio_removed": removed}


@router.post("/sentences/{sentence_id}/audio/{generation_id}/select")
def select_sentence_audio(sentence_id: str, generation_id: str, db: Session = Depends(get_db)):
    sentence = db.query(AudiobookSentence).filter_by(id=sentence_id).first()
    if not sentence:
        raise HTTPException(404, "Sentence not found")
    _remember_sentence_audio(sentence.id, sentence.generation_id, db)
    db.flush()
    if not db.query(AudiobookSentenceAudio.id).filter_by(sentence_id=sentence_id, generation_id=generation_id).first():
        raise HTTPException(404, "Sentence audio take not found")
    generation = db.query(Generation).filter_by(id=generation_id).first()
    if not generation or (generation.status or "completed") != "completed":
        raise HTTPException(400, "Only completed audio can be selected")
    sentence.generation_id = generation_id
    sentence.updated_at = datetime.utcnow()
    db.commit()
    return _sentence_response(sentence, db)


@router.post("/sentences/{sentence_id}/audio/{generation_id}/delete")
async def delete_sentence_audio_take(sentence_id: str, generation_id: str, db: Session = Depends(get_db)):
    sentence = db.query(AudiobookSentence).filter_by(id=sentence_id).first()
    if sentence:
        _remember_sentence_audio(sentence.id, sentence.generation_id, db)
        db.flush()
    link = db.query(AudiobookSentenceAudio).filter_by(sentence_id=sentence_id, generation_id=generation_id).first()
    if not sentence or not link:
        raise HTTPException(404, "Sentence audio take not found")
    db.delete(link)
    if sentence.generation_id == generation_id:
        replacement = db.query(AudiobookSentenceAudio).filter(
            AudiobookSentenceAudio.sentence_id == sentence_id,
            AudiobookSentenceAudio.generation_id != generation_id,
        ).order_by(AudiobookSentenceAudio.created_at.desc()).first()
        sentence.generation_id = replacement.generation_id if replacement else None
    db.commit()
    removed = await _delete_generation_if_unreferenced(generation_id, db)
    return {"message": "Sentence audio take deleted", "removed": removed}
