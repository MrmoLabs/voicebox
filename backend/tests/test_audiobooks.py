import asyncio

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend import models
from backend.database.models import Base, AudiobookSentenceAudio, Generation, VoiceProfile
from backend.routes import audiobooks as audiobook_routes
from backend.routes.audiobooks import (
    cancel_audiobook_generation,
    create_sentence,
    create_audiobook,
    create_chapter,
    create_generation_plan,
    delete_obsolete_sentence_audio,
    delete_sentence_audio,
    delete_sentence,
    batch_delete_sentences,
    batch_restore_sentences,
    get_audiobook,
    get_active_generation_plan,
    list_deleted_sentences,
    permanently_delete_sentence,
    select_sentence_audio,
    delete_sentence_audio_take,
    replace_chapter_sentences,
    reorder_sentences,
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


def test_sentence_reorder_persists_the_complete_chapter_order():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    book = create_audiobook(models.AudiobookCreate(title="测试图书"), db)
    chapter = create_chapter(book.id, models.AudiobookChapterCreate(title="第一章"), db)
    chapter = replace_chapter_sentences(
        chapter.id, models.AudiobookSplitRequest(text="第一句。第二句。第三句。"), db
    )
    reversed_ids = [item.id for item in reversed(chapter.sentences)]
    reordered = reorder_sentences(
        chapter.id, models.AudiobookSentenceReorder(sentence_ids=reversed_ids), db
    )
    assert [item.id for item in reordered.sentences] == reversed_ids
    assert [item.position for item in reordered.sentences] == [0, 1, 2]


def test_batch_delete_is_persistent_and_batch_restore_preserves_order():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    book = create_audiobook(models.AudiobookCreate(title="Recycle bin"), db)
    chapter = create_chapter(book.id, models.AudiobookChapterCreate(title="Chapter"), db)
    chapter = replace_chapter_sentences(
        chapter.id, models.AudiobookSplitRequest(text="One. Two. Three."), db
    )
    targets = [chapter.sentences[0].id, chapter.sentences[1].id]

    result = batch_delete_sentences(models.AudiobookSentenceBatchRequest(sentence_ids=targets), db)
    assert len(result["snapshots"]) == 2
    assert [item.text for item in get_audiobook(book.id, db).chapters[0].sentences] == ["Three."]
    deleted = list_deleted_sentences(chapter.id, db)
    assert len(deleted) == 2

    restored = batch_restore_sentences(
        chapter.id,
        models.AudiobookSentenceBatchRestoreRequest(
            deletion_ids=[item["deletion_id"] for item in deleted]
        ),
        db,
    )
    assert len(restored) == 2
    detail = get_audiobook(book.id, db)
    assert [item.text for item in detail.chapters[0].sentences] == ["One.", "Two.", "Three."]
    assert list_deleted_sentences(chapter.id, db) == []


def test_audio_delete_and_recycle_bin_permanent_delete_cleanup_generations(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    profile = VoiceProfile(id="voice-cleanup", name="Narrator", language="zh")
    db.add(profile)
    db.commit()
    book = create_audiobook(models.AudiobookCreate(title="Cleanup"), db)
    chapter = create_chapter(book.id, models.AudiobookChapterCreate(title="Chapter"), db)
    chapter = replace_chapter_sentences(
        chapter.id, models.AudiobookSplitRequest(text="One. Two."), db
    )
    generations = [
        Generation(
            id=f"generation-{index}", profile_id=profile.id, text=sentence.text,
            language="zh", audio_path=f"audio/{index}.wav", status="completed",
            source="audiobook",
        )
        for index, sentence in enumerate(chapter.sentences)
    ]
    db.add_all(generations)
    db.commit()
    for sentence, generation in zip(chapter.sentences, generations):
        update_sentence(sentence.id, models.AudiobookSentenceUpdate(generation_id=generation.id), db)

    removed = []

    async def fake_delete_generation(generation_id, _db):
        removed.append(generation_id)
        generation = _db.query(Generation).filter_by(id=generation_id).first()
        if generation:
            _db.delete(generation)
            _db.commit()
        return generation is not None

    monkeypatch.setattr(audiobook_routes.history, "delete_generation", fake_delete_generation)

    asyncio.run(delete_sentence_audio(chapter.sentences[0].id, db))
    assert get_audiobook(book.id, db).chapters[0].sentences[0].generation_id is None
    assert removed == ["generation-0"]

    snapshot = delete_sentence(chapter.sentences[1].id, db)["snapshot"]
    asyncio.run(permanently_delete_sentence(snapshot["deletion_id"], db))
    assert list_deleted_sentences(chapter.id, db) == []
    assert removed == ["generation-0", "generation-1"]


def test_obsolete_audio_is_deleted_only_after_sentence_rebind(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    profile = VoiceProfile(id="voice-rebind", name="Narrator", language="zh")
    db.add(profile)
    db.commit()
    book = create_audiobook(models.AudiobookCreate(title="Rebind"), db)
    chapter = create_chapter(book.id, models.AudiobookChapterCreate(title="Chapter"), db)
    chapter = replace_chapter_sentences(chapter.id, models.AudiobookSplitRequest(text="One."), db)
    sentence = chapter.sentences[0]
    old = Generation(
        id="generation-old", profile_id=profile.id, text=sentence.text, language="zh",
        audio_path="audio/old.wav", status="completed", source="audiobook",
    )
    new = Generation(
        id="generation-new", profile_id=profile.id, text=sentence.text, language="zh",
        audio_path="audio/new.wav", status="completed", source="audiobook",
    )
    db.add_all([old, new])
    db.commit()
    update_sentence(sentence.id, models.AudiobookSentenceUpdate(generation_id=new.id), db)

    removed = []
    async def fake_delete_generation(generation_id, _db):
        removed.append(generation_id)
        return True
    monkeypatch.setattr(audiobook_routes.history, "delete_generation", fake_delete_generation)

    asyncio.run(delete_obsolete_sentence_audio(sentence.id, old.id, db))
    assert removed == [old.id]


def test_sentence_retains_multiple_audio_takes_and_can_select_or_delete(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    profile = VoiceProfile(id="voice-takes", name="Narrator", language="zh")
    db.add(profile)
    db.commit()
    book = create_audiobook(models.AudiobookCreate(title="Takes"), db)
    chapter = create_chapter(book.id, models.AudiobookChapterCreate(title="Chapter"), db)
    chapter = replace_chapter_sentences(chapter.id, models.AudiobookSplitRequest(text="One."), db)
    sentence = chapter.sentences[0]
    first = Generation(
        id="take-1", profile_id=profile.id, text=sentence.text, language="zh",
        audio_path="audio/one.wav", duration=1.0, status="completed", source="audiobook",
    )
    second = Generation(
        id="take-2", profile_id=profile.id, text=sentence.text, language="zh",
        audio_path="audio/two.wav", duration=1.2, status="completed", source="audiobook",
    )
    db.add_all([first, second])
    db.commit()
    update_sentence(sentence.id, models.AudiobookSentenceUpdate(generation_id=first.id), db)
    update_sentence(sentence.id, models.AudiobookSentenceUpdate(generation_id=second.id), db)

    detail = get_audiobook(book.id, db).chapters[0].sentences[0]
    assert [take.generation_id for take in detail.audio_takes] == [first.id, second.id]
    assert [take.selected for take in detail.audio_takes] == [False, True]

    selected = select_sentence_audio(sentence.id, first.id, db)
    assert selected.generation_id == first.id

    async def fake_delete_generation(generation_id, _db):
        generation = _db.query(Generation).filter_by(id=generation_id).first()
        if generation:
            _db.delete(generation)
            _db.commit()
        return generation is not None
    monkeypatch.setattr(audiobook_routes.history, "delete_generation", fake_delete_generation)
    asyncio.run(delete_sentence_audio_take(sentence.id, first.id, db))
    current = get_audiobook(book.id, db).chapters[0].sentences[0]
    assert current.generation_id == second.id
    assert [take.generation_id for take in current.audio_takes] == [second.id]
    assert db.query(AudiobookSentenceAudio).count() == 1


def test_generation_plan_persists_the_full_sentence_schedule(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    profile = VoiceProfile(id="voice-plan", name="Narrator", language="zh")
    db.add(profile)
    db.commit()
    book = create_audiobook(models.AudiobookCreate(title="Planned book"), db)
    chapter = create_chapter(book.id, models.AudiobookChapterCreate(title="Chapter"), db)
    chapter = replace_chapter_sentences(
        chapter.id, models.AudiobookSplitRequest(text="One. Two. Three."), db
    )
    started = []
    monkeypatch.setattr(audiobook_routes, "start_plan", started.append)

    plan = asyncio.run(
        create_generation_plan(
            book.id,
            models.AudiobookGenerationPlanCreate(
                chapter_id=chapter.id,
                sentence_ids=[item.id for item in chapter.sentences],
                profile_id=profile.id,
                language="zh",
                engine="qwen",
                model_size="1.7B",
                performance_mode="stable",
            ),
            db,
        )
    )

    assert plan["sentence_count"] == 3
    assert plan["next_index"] == 0
    assert plan["status"] == "running"
    assert started == [plan["id"]]
    assert get_active_generation_plan(book.id, db)["id"] == plan["id"]


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
