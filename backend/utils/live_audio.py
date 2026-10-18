"""Disk-backed PCM preview. One producer; bounded readers independent of playback.

Wire format: repeated little-endian uint32 (sample_rate, sample_count), then
sample_count float32 samples. (0, 0) commits success; (1, 0) signals failure.
An EOF without a terminal frame is a disconnected stream, never success.
"""

import asyncio
import logging
import struct
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .. import config
from .chunked_tts import concatenate_audio_chunks, split_text_into_chunks
from .generation_progress import generation_progress

logger = logging.getLogger(__name__)


@dataclass
class LiveAudio:
    path: Path
    sample_rate: int = 0
    samples: int = 0
    terminal: str | None = None
    updated: asyncio.Event = field(default_factory=asyncio.Event)
    started: float = field(default_factory=time.monotonic)
    first_pcm_seconds: float | None = None

    async def append(self, audio, sample_rate):
        audio = np.asarray(audio, dtype="<f4")
        if audio.ndim != 1 or not np.isfinite(audio).all():
            raise ValueError("Invalid streaming audio")
        if not len(audio):
            return
        if self.sample_rate and self.sample_rate != sample_rate:
            raise ValueError("Streaming sample rate changed")

        def write():
            with self.path.open("ab") as output:
                output.write(audio.tobytes())

        await asyncio.to_thread(write)
        self.sample_rate = int(sample_rate)
        self.samples += len(audio)
        if self.first_pcm_seconds is None:
            self.first_pcm_seconds = time.monotonic() - self.started
            logger.info("Live audio %s: first PCM after %.3fs", self.path.stem, self.first_pcm_seconds)
        self.updated.set()

    def finish(self, status):
        self.terminal = status
        self.updated.set()

    async def packets(self, from_sample=0):
        offset = from_sample
        while True:
            available = self.samples - offset
            if available > 0:
                count = min(available, 24000)  # At most 96 KB per reader buffer.

                def read():
                    with self.path.open("rb") as source:
                        source.seek(offset * 4)
                        return source.read(count * 4)

                data = await asyncio.to_thread(read)
                if len(data) != count * 4:
                    raise OSError("Incomplete PCM spool")
                yield struct.pack("<II", self.sample_rate, count) + data
                offset += count
            elif self.terminal is not None:
                yield struct.pack("<II", 0 if self.terminal == "completed" else 1, 0)
                return
            else:
                self.updated.clear()
                await self.updated.wait()


_live: dict[str, LiveAudio] = {}


def create_live_audio(generation_id):
    directory = config.get_cache_dir() / "live-audio"
    directory.mkdir(parents=True, exist_ok=True)
    # Only server-generated UUIDs reach this function.
    path = directory / f"{generation_id}.f32"
    path.touch()
    state = LiveAudio(path)
    _live[generation_id] = state
    return state


def get_live_audio(generation_id):
    return _live.get(generation_id)


def finish_live_audio(generation_id, status):
    state = _live.get(generation_id)
    if state is None:
        return
    state.finish(status)

    async def expire():
        await asyncio.sleep(3600)
        if _live.get(generation_id) is state:
            _live.pop(generation_id, None)
            state.path.unlink(missing_ok=True)
            state.path.with_suffix(".normalized.f32").unlink(missing_ok=True)

    from ..services.task_queue import create_background_task
    create_background_task(expire())


def live_text_chunks(text, max_chars=80):
    text = text.strip()
    if not text:
        raise ValueError("Text cannot be empty")
    # The caller already sends short sentences for incremental narration.
    # Splitting every request into a tiny opener and a much longer next clause
    # drains the opener before the next checked clause can become available.
    return split_text_into_chunks(text, max_chars)


async def generate_live_audio(backend, generation_id, text, prompt, *, language, seed,
                              instruct, crossfade_ms=50, max_chunk_chars=80, preview_mode="realtime"):
    state = get_live_audio(generation_id)
    # Callers may still pass the ordinary-generation chunk preference (800 or
    # more); a checked preview must keep its own, smaller publication boundary.
    chunks = live_text_chunks(text, min(max_chunk_chars, 80))
    total_chars = sum(map(len, chunks))
    completed_chars = 0
    tail = np.empty(0, dtype=np.float32)
    generation_progress.chunks(generation_id, 0, len(chunks), 0, total_chars)
    for index, chunk_text in enumerate(chunks):
        first_packet = True
        generate = backend.generate_stream_checked if preview_mode == "checked" else backend.generate_stream
        stream = generate(chunk_text, prompt, language,
                                         seed + index if seed is not None else None, instruct)
        try:
            async for pcm, sr in stream:
                if not len(pcm):
                    continue
                if index and first_packet and len(tail):
                    pcm = concatenate_audio_chunks([tail, pcm], sr, crossfade_ms)
                else:
                    pcm = np.concatenate([tail, pcm])
                first_packet = False
                keep = min(int(sr * crossfade_ms / 1000), len(pcm))
                if keep:
                    tail = pcm[-keep:].copy()
                    pcm = pcm[:-keep]
                else:
                    tail = np.empty(0, dtype=np.float32)
                await state.append(pcm, sr)
        finally:
            await stream.aclose()
        if first_packet:
            raise RuntimeError("Model returned no streaming audio")
        completed_chars += len(chunk_text)
        generation_progress.chunks(generation_id, index + 1, len(chunks), completed_chars, total_chars)
    if len(tail):
        await state.append(tail, sr)
    if not state.samples:
        raise RuntimeError("Model returned no streaming audio")
    return np.memmap(state.path, dtype="<f4", mode="r", shape=(state.samples,)), state.sample_rate


def normalize_spooled_audio(audio, path):
    """Two passes with fixed memory; preview PCM stays immutable for readers."""
    size = 24000 * 10
    sum_squares = sum(float(np.sum(np.square(audio[i:i + size], dtype=np.float64)))
                      for i in range(0, len(audio), size))
    rms = np.sqrt(sum_squares / len(audio))
    gain = 0.1 / rms if rms > 0 else 1.0  # Existing -20 dB target.
    output = np.memmap(path, dtype="<f4", mode="w+", shape=audio.shape)
    for i in range(0, len(audio), size):
        output[i:i + size] = np.clip(audio[i:i + size] * gain, -0.85, 0.85)
    output.flush()
    return output
