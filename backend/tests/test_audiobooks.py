import asyncio

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend import models
from backend.database.models import Base, Generation, VoiceProfile
from backend.routes import audiobooks as audiobook_routes
from backend.routes.audiobooks import (
    cancel_audiobook_generation,
    create_sentence,
    create_audiobook,
    create_chapter,
    delete_sentence,
    get_audiobook,
    replace_chapter_sentences,
    split_long_text,
    update_sentence,
)
from backend.services.audiobooks import profile_has_audiobook_references


def test_split_long_text_preserves_paragraphs_and_punctuation():
    sentences, paragraph_count = split_long_text(
        "第一句话。第二句话！\n\n价格是 3.14 元，不应在小数点切开。\nDr. Smith arrived. Then he left."
    )

    assert paragraph_count == 3
    assert [item["text"] for item in sentences] == [
        "第一句话。",
        "第二句话！",
        "价格是 3.14 元，不应在小数点切开。",
        "Dr. Smith arrived.",
        "Then he left.",
    ]
    assert [item["paragraph_index"] for item in sentences] == [0, 0, 1, 2, 2]
    assert [item["position"] for item in sentences] == list(range(5))


def test_audiobook_tables_are_created():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    names = set(engine.dialect.get_table_names(engine.connect()))
    assert {"audiobooks", "audiobook_chapters", "audiobook_sentences"} <= names


def test_audiobook_sentence_can_bind_an_existing_generation():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    profile = VoiceProfile(id="voice-1", name="Narrator", language="zh")
    db.add(profile)
    db.commit()

    book = create_audiobook(models.AudiobookCreate(title="测试图书"), db)
    chapter = create_chapter(
        book.id,
        models.AudiobookChapterCreate(title="第一章", source_text="第一句。第二句。"),
        db,
    )
    chapter = replace_chapter_sentences(
        chapter.id,
        models.AudiobookSplitRequest(text="第一句。第二句。"),
        db,
    )
    generation = Generation(
        id="generation-1",
        profile_id=profile.id,
        text=chapter.sentences[0].text,
        language="zh",
        audio_path="audio/test.wav",
        duration=1.25,
        status="completed",
    )
    db.add(generation)
    db.commit()

    bound = update_sentence(
        chapter.sentences[0].id,
        models.AudiobookSentenceUpdate(generation_id=generation.id),
        db,
    )
    detail = get_audiobook(book.id, db)

    assert bound.generation_id == generation.id
    assert bound.generation_status == "completed"
    assert bound.profile_name == "Narrator"
    assert detail.chapters[0].sentences[0].generation_id == generation.id
    assert detail.sentence_count == 2

    assert profile_has_audiobook_references(profile.id, db) is True
    assert profile_has_audiobook_references("unused-profile", db) is False


def test_sentence_crud_keeps_positions_contiguous_and_unbinds_edited_audio():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    profile = VoiceProfile(id="voice-1", name="Narrator", language="zh")
    db.add(profile)
    db.commit()
    book = create_audiobook(models.AudiobookCreate(title="测试图书"), db)
    chapter = create_chapter(book.id, models.AudiobookChapterCreate(title="第一章"), db)
    chapter = replace_chapter_sentences(
        chapter.id, models.AudiobookSplitRequest(text="第一句。第二句。"), db
    )
    generation = Generation(
        id="generation-1", profile_id=profile.id, text="第一句。", language="zh",
        audio_path="audio/test.wav", status="completed",
    )
    db.add(generation)
    db.commit()
    update_sentence(
        chapter.sentences[0].id,
        models.AudiobookSentenceUpdate(generation_id=generation.id),
        db,
    )

    inserted = create_sentence(
        chapter.id, models.AudiobookSentenceCreate(text="插入句。", position=1), db
    )
    detail = get_audiobook(book.id, db)
    assert [item.text for item in detail.chapters[0].sentences] == ["第一句。", "插入句。", "第二句。"]
    assert [item.position for item in detail.chapters[0].sentences] == [0, 1, 2]

    edited = update_sentence(
        detail.chapters[0].sentences[0].id,
        models.AudiobookSentenceUpdate(text="修改后的第一句。"),
        db,
    )
    assert edited.generation_id is None
    delete_sentence(inserted.id, db)
    detail = get_audiobook(book.id, db)
    assert [item.position for item in detail.chapters[0].sentences] == [0, 1]


def test_cancel_audiobook_generation_covers_all_chapters(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    profile = VoiceProfile(id="voice-1", name="Narrator", language="zh")
    db.add(profile)
    db.commit()
    book = create_audiobook(models.AudiobookCreate(title="测试图书"), db)
    chapters = [
        create_chapter(book.id, models.AudiobookChapterCreate(title=f"第 {index} 章"), db)
        for index in (1, 2)
    ]
    generation_ids = []
    for index, chapter in enumerate(chapters):
        split = replace_chapter_sentences(
            chapter.id, models.AudiobookSplitRequest(text=f"第 {index + 1} 句。"), db
        )
        generation_id = f"generation-{index}"
        generation_ids.append(generation_id)
        db.add(Generation(
            id=generation_id, profile_id=profile.id, text=split.sentences[0].text,
            language="zh", status="generating",
        ))
        db.commit()
        update_sentence(
            split.sentences[0].id,
            models.AudiobookSentenceUpdate(generation_id=generation_id),
            db,
        )

    class TaskManager:
        def complete_generation(self, generation_id):
            pass

    async def mark_failed(generation_id, status, db, error):
        generation = db.query(Generation).filter_by(id=generation_id).one()
        generation.status = status
        generation.error = error
        db.commit()

    monkeypatch.setattr(audiobook_routes, "cancel_generation_job", lambda generation_id: "queued")
    monkeypatch.setattr(audiobook_routes, "get_task_manager", lambda: TaskManager())
    monkeypatch.setattr(audiobook_routes.history, "update_generation_status", mark_failed)

    result = asyncio.run(cancel_audiobook_generation(book.id, db))
    assert result == {"matched": 2, "cancelled": 2, "already_finished": 0}
    assert {
        generation.status for generation in db.query(Generation).filter(Generation.id.in_(generation_ids))
    } == {"failed"}
