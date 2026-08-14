"""Restart-safe orchestration for long-form audiobook generation."""

import asyncio
import logging

from .. import models
from ..database import AudiobookGenerationPlan, AudiobookSentence, AudiobookSentenceAudio, Generation, get_db
from .task_queue import create_background_task

logger = logging.getLogger(__name__)
_running_plans: set[str] = set()


def start_plan(plan_id: str) -> None:
    if plan_id in _running_plans:
        return
    _running_plans.add(plan_id)
    task = create_background_task(_run_plan(plan_id))
    task.add_done_callback(lambda _task: _running_plans.discard(plan_id))


async def resume_running_plans() -> int:
    db = next(get_db())
    try:
        ids = [row[0] for row in db.query(AudiobookGenerationPlan.id).filter_by(status="running").all()]
    finally:
        db.close()
    for plan_id in ids:
        start_plan(plan_id)
    return len(ids)


async def _wait_for_generation(generation_id: str, plan_id: str) -> str:
    while True:
        await asyncio.sleep(1.0)
        db = next(get_db())
        try:
            plan = db.query(AudiobookGenerationPlan).filter_by(id=plan_id).first()
            if not plan or plan.status != "running":
                return "cancelled"
            generation = db.query(Generation).filter_by(id=generation_id).first()
            if not generation:
                return "missing"
            if generation.status in ("completed", "failed"):
                return generation.status
        finally:
            db.close()


async def _run_plan(plan_id: str) -> None:
    from ..routes.generations import generate_speech

    db = next(get_db())
    try:
        plan = db.query(AudiobookGenerationPlan).filter_by(id=plan_id).first()
        if plan and plan.status == "running" and (plan.request_settings or {}).get("performance_mode") == "fast":
            submitted = dict(plan.submitted_generation_ids or {})
            settings = dict(plan.request_settings or {})
            settings.pop("performance_mode", None)
            settings.pop("plan_error", None)
            for sentence_id in list(plan.sentence_ids or [])[plan.next_index:]:
                if sentence_id in submitted:
                    continue
                sentence = db.query(AudiobookSentence).filter_by(id=sentence_id).first()
                if not sentence:
                    continue
                generation = await generate_speech(
                    models.GenerationRequest(text=sentence.text, source="audiobook", **settings),
                    db,
                )
                generation_row = db.query(Generation).filter_by(id=generation.id).first()
                if generation_row:
                    generation_row.source = "audiobook"
                if sentence.generation_id and not db.query(AudiobookSentenceAudio.id).filter_by(generation_id=sentence.generation_id).first():
                    db.add(AudiobookSentenceAudio(sentence_id=sentence.id, generation_id=sentence.generation_id))
                sentence.generation_id = generation.id
                db.add(AudiobookSentenceAudio(sentence_id=sentence.id, generation_id=generation.id))
                submitted[sentence_id] = generation.id
                plan.submitted_generation_ids = dict(submitted)
                db.commit()
    except Exception:
        db.rollback()
        logger.exception("Could not pre-submit fast audiobook plan %s", plan_id)
    finally:
        db.close()

    while True:
        db = next(get_db())
        try:
            plan = db.query(AudiobookGenerationPlan).filter_by(id=plan_id).first()
            if not plan or plan.status != "running":
                return
            sentence_ids = list(plan.sentence_ids or [])
            if plan.next_index >= len(sentence_ids):
                plan.status = "completed"
                db.commit()
                return
            sentence_id = sentence_ids[plan.next_index]
            sentence = db.query(AudiobookSentence).filter_by(id=sentence_id).first()
            if not sentence:
                plan.next_index += 1
                db.commit()
                continue
            submitted = dict(plan.submitted_generation_ids or {})
            generation_id = submitted.get(sentence_id)
            generation = db.query(Generation).filter_by(id=generation_id).first() if generation_id else None
            if not generation:
                settings = dict(plan.request_settings or {})
                settings.pop("performance_mode", None)
                settings.pop("plan_error", None)
                request = models.GenerationRequest(text=sentence.text, source="audiobook", **settings)
                generation = await generate_speech(request, db)
                generation_row = db.query(Generation).filter_by(id=generation.id).first()
                if generation_row:
                    generation_row.source = "audiobook"
                if sentence.generation_id and not db.query(AudiobookSentenceAudio.id).filter_by(generation_id=sentence.generation_id).first():
                    db.add(AudiobookSentenceAudio(sentence_id=sentence.id, generation_id=sentence.generation_id))
                sentence.generation_id = generation.id
                db.add(AudiobookSentenceAudio(sentence_id=sentence.id, generation_id=generation.id))
                submitted[sentence_id] = generation.id
                plan.submitted_generation_ids = submitted
                db.commit()
            generation_id = generation.id
        except Exception as exc:
            db.rollback()
            plan = db.query(AudiobookGenerationPlan).filter_by(id=plan_id).first()
            if plan:
                plan.status = "failed"
                plan.request_settings = {**dict(plan.request_settings or {}), "plan_error": str(exc)}
                db.commit()
            logger.exception("Audiobook generation plan %s failed", plan_id)
            return
        finally:
            db.close()

        result = await _wait_for_generation(generation_id, plan_id)
        if result == "cancelled":
            return
        db = next(get_db())
        try:
            plan = db.query(AudiobookGenerationPlan).filter_by(id=plan_id).first()
            if not plan or plan.status != "running":
                return
            plan.next_index += 1
            db.commit()
        finally:
            db.close()
