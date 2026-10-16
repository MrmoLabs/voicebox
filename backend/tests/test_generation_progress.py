import asyncio

import numpy as np
import pytest

from backend.utils import generation_progress as module
from backend.utils.chunked_tts import generate_chunked
from backend.utils.generation_progress import GenerationProgressTracker


@pytest.fixture
def clock(monkeypatch):
    now = [0.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: now[0])
    return now


def test_queue_and_loading_have_elapsed_but_no_invented_percentage(clock):
    tracker = GenerationProgressTracker()
    tracker.start("a")
    clock[0] = 10
    assert tracker.snapshot("a")["stage"] == "queued"
    assert tracker.snapshot("a")["elapsed_seconds"] == 10
    tracker.stage("a", "loading_model")
    clock[0] = 13
    assert tracker.snapshot("a")["stage_elapsed_seconds"] == 3
    assert tracker.snapshot("a")["percent"] is None
    assert tracker.snapshot("a")["estimated_remaining_seconds"] is None


def test_chunk_estimate_counts_down_without_advancing_real_progress(clock):
    tracker = GenerationProgressTracker()
    tracker.start("a")
    tracker.stage("a", "generating")
    tracker.chunks("a", 0, 2, 0, 100)
    clock[0] = 10
    tracker.chunks("a", 1, 2, 50, 100)
    assert tracker.snapshot("a")["estimated_remaining_seconds"] == 10
    clock[0] = 15
    snapshot = tracker.snapshot("a")
    assert snapshot["estimated_remaining_seconds"] == 5
    assert snapshot["percent"] == 50
    clock[0] = 21
    assert tracker.snapshot("a")["estimate_overdue"]
    assert tracker.snapshot("a")["estimated_remaining_seconds"] is None


def test_estimates_use_matching_warm_runs_only(clock):
    tracker = GenerationProgressTracker()
    key = ("qwen", "1.7B", "zh", "cuda", "codebook-safe")
    tracker.start("cold")
    tracker.stage("cold", "generating", estimate_key=key)
    clock[0] = 100
    tracker.chunks("cold", 1, 1, 50, 50)
    tracker.stage("cold", "finalizing")
    assert tracker.rates == {}
    tracker.start("warm")
    tracker.stage("warm", "generating", estimate_key=key, learn=True)
    clock[0] = 110
    tracker.chunks("warm", 1, 1, 50, 50)
    tracker.stage("warm", "finalizing")
    tracker.start("next")
    tracker.stage("next", "generating", estimate_key=key, learn=True)
    tracker.chunks("next", 0, 1, 0, 100)
    assert tracker.snapshot("next")["estimated_remaining_seconds"] == 20
    tracker.start("other")
    tracker.stage("other", "generating", estimate_key=("qwen", "0.6B"), learn=True)
    tracker.chunks("other", 0, 1, 0, 100)
    assert tracker.snapshot("other")["estimated_remaining_seconds"] is None
    tracker.finish("next")
    assert tracker.snapshot("next") is None


@pytest.mark.parametrize("text,limit,count", [("Hello.", 800, 1), ("Hello. World. Again.", 8, 3)])
def test_callbacks_only_advance_after_audio_is_generated(text, limit, count):
    events = []

    class Backend:
        async def generate(self, *args):
            assert events[-1][0] == len(calls)
            calls.append(args[0])
            return np.zeros(100, dtype=np.float32), 24000

    calls = []
    audio, sample_rate = asyncio.run(generate_chunked(
        Backend(), text, {}, max_chunk_chars=limit,
        progress_callback=lambda *args: events.append(args),
    ))
    assert len(calls) == count
    assert [event[0] for event in events] == list(range(count + 1))
    assert events[-1][2] == events[-1][3]
    assert sample_rate == 24000 and len(audio) > 0


def test_failed_chunk_does_not_report_completion():
    events = []

    class Backend:
        async def generate(self, *args):
            raise RuntimeError("inference failed")

    with pytest.raises(RuntimeError, match="inference failed"):
        asyncio.run(generate_chunked(Backend(), "Hello.", {}, progress_callback=lambda *args: events.append(args)))
    assert events == [(0, 1, 0, 6)]
