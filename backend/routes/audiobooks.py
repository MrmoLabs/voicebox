"""Audiobook project, chapter, and sentence endpoints."""

import re
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models
from ..database import (
    Audiobook,
    AudiobookChapter,
    AudiobookSentence,
    Generation,
    VoiceProfile,
    get_db,
)
from ..services import history
from ..services.task_queue import cancel_generation as cancel_generation_job
from ..utils.tasks import get_task_manager

router = APIRouter(prefix="/audiobooks", tags=["audiobooks"])


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
    return models.AudiobookSentenceResponse(
        id=sentence.id, chapter_id=sentence.chapter_id, generation_id=sentence.generation_id,
        text=sentence.text, paragraph_index=sentence.paragraph_index, position=sentence.position,
        generation_status=(generation.status or "completed") if generation else None,
        generation_error=generation.error if generation else None,
        duration=generation.duration if generation else None,
        profile_id=generation.profile_id if generation else None,
        profile_name=profile_name, engine=generation.engine if generation else None,
        model_size=generation.model_size if generation else None,
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


@router.delete("/{book_id}")
def delete_audiobook(book_id: str, db: Session = Depends(get_db)):
    book = db.query(Audiobook).filter_by(id=book_id).first()
    if not book: raise HTTPException(404, "Audiobook not found")
    chapter_ids = [c.id for c in db.query(AudiobookChapter).filter_by(audiobook_id=book_id).all()]
    if chapter_ids: db.query(AudiobookSentence).filter(AudiobookSentence.chapter_id.in_(chapter_ids)).delete(synchronize_session=False)
    db.query(AudiobookChapter).filter_by(audiobook_id=book_id).delete()
    db.delete(book); db.commit()
    return {"message": "Audiobook deleted"}


@router.post("/{book_id}/cancel-generation", response_model=models.AudiobookCancelResponse)
async def cancel_audiobook_generation(book_id: str, db: Session = Depends(get_db)):
    """Cancel every active generation bound anywhere in this book."""
    book = db.query(Audiobook).filter_by(id=book_id).first()
    if not book:
        raise HTTPException(404, "Audiobook not found")
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
    if "generation_id" in values and values["generation_id"]:
        if not db.query(Generation).filter_by(id=values["generation_id"]).first():
            raise HTTPException(404, "Generation not found")
    if "text" in values and values["text"] != sentence.text:
        sentence.text = values["text"]; sentence.generation_id = None
    if "generation_id" in values: sentence.generation_id = values["generation_id"]
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


@router.delete("/sentences/{sentence_id}")
def delete_sentence(sentence_id: str, db: Session = Depends(get_db)):
    sentence = db.query(AudiobookSentence).filter_by(id=sentence_id).first()
    if not sentence:
        raise HTTPException(404, "Sentence not found")
    chapter_id = sentence.chapter_id
    deleted_position = sentence.position
    db.delete(sentence)
    db.query(AudiobookSentence).filter(
        AudiobookSentence.chapter_id == chapter_id,
        AudiobookSentence.position > deleted_position,
    ).update({AudiobookSentence.position: AudiobookSentence.position - 1}, synchronize_session=False)
    chapter = db.query(AudiobookChapter).filter_by(id=chapter_id).first()
    if chapter:
        chapter.updated_at = datetime.utcnow()
    db.commit()
    return {"message": "Sentence deleted"}
