"""Live generation stages and conservative, session-local inference estimates.

All updates run on the event loop. Percentages measure completed text chunks,
never a timer pretending to be model progress. The first generation after a
model load does not train the warm-inference estimator.
"""

import logging
import time
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class GenerationProgress:
    started: float = field(default_factory=lambda: time.monotonic())
    stage_started: float = field(default_factory=lambda: time.monotonic())
    stage: str = "queued"
    completed_chunks: int = 0
    total_chunks: int = 0
    completed_chars: int = 0
    measured_seconds: float = 0
    total_chars: int = 0
    estimate_key: tuple | None = None
    learn: bool = False


class GenerationProgressTracker:
    def __init__(self):
        self.active: dict[str, GenerationProgress] = {}
        self.rates: dict[tuple, float] = {}

    def start(self, generation_id: str) -> None:
        self.active[generation_id] = GenerationProgress()

    def stage(self, generation_id: str, stage: str, *, estimate_key=None, learn=False) -> None:
        progress = self.active.get(generation_id)
        if progress is None:
            return
        now = time.monotonic()
        logger.info("Generation %s: %s took %.2fs; entering %s", generation_id,
                    progress.stage, now - progress.stage_started, stage)
        if progress.stage == "generating" and progress.learn and progress.completed_chars:
            rate = (now - progress.stage_started) / progress.completed_chars
            key = progress.estimate_key
            if key not in self.rates and len(self.rates) >= 128:
                self.rates.pop(next(iter(self.rates)))
            previous = self.rates.get(key, rate)
            self.rates[key] = previous * 0.7 + rate * 0.3
        progress.stage = stage
        progress.stage_started = now
        progress.estimate_key = estimate_key
        progress.learn = learn

    def chunks(self, generation_id: str, completed: int, total: int, chars: int, total_chars: int) -> None:
        progress = self.active.get(generation_id)
        if progress:
            progress.completed_chunks = completed
            progress.total_chunks = total
            progress.completed_chars = chars
            progress.measured_seconds = time.monotonic() - progress.stage_started
            progress.total_chars = total_chars

    def snapshot(self, generation_id: str) -> dict | None:
        progress = self.active.get(generation_id)
        if progress is None:
            return None
        now = time.monotonic()
        remaining = None
        overdue = False
        if progress.stage == "generating" and progress.total_chars:
            elapsed = now - progress.stage_started
            rate = self.rates.get(progress.estimate_key) if progress.learn else None
            # A completed chunk gives us a measurement even on a cold run.
            if progress.completed_chars:
                rate = progress.measured_seconds / progress.completed_chars
            if rate is not None:
                remaining = rate * progress.total_chars - elapsed
                overdue = remaining <= 0 and progress.completed_chunks < progress.total_chunks
                remaining = None if overdue else round(max(0, remaining), 1)
        return {
            "stage": progress.stage,
            "elapsed_seconds": round(now - progress.started, 1),
            "stage_elapsed_seconds": round(now - progress.stage_started, 1),
            "completed_chunks": progress.completed_chunks,
            "total_chunks": progress.total_chunks,
            "percent": (round(100 * progress.completed_chars / progress.total_chars, 1)
                        if progress.total_chars else None),
            "estimated_remaining_seconds": remaining,
            "estimate_overdue": overdue,
        }

    def finish(self, generation_id: str) -> None:
        progress = self.active.pop(generation_id, None)
        if progress:
            logger.info("Generation %s: total %.2fs", generation_id, time.monotonic() - progress.started)


generation_progress = GenerationProgressTracker()
