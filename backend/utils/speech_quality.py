"""Conservative checks before a synthesized preview becomes audible."""

import asyncio
import logging
import re
import tempfile
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np

from .. import config
from .audio import has_tts_runaway, save_audio

logger = logging.getLogger(__name__)


class SpeechQualityError(RuntimeError):
    pass


def preview_seconds_limit(text):
    # A deliberately generous ceiling, not a speaking-rate target. Bounds both
    # the codec loop and its uncommitted PCM buffer, including numeric speech.
    return max(8.0, min(30.0, len(text.strip()) * 0.6 + 3.0))


def check_preview_audio(audio, sample_rate, text):
    if sample_rate <= 0 or audio.ndim != 1 or not len(audio) or not np.isfinite(audio).all():
        raise SpeechQualityError("语音包含无效音频，已拦截")
    if len(audio) / sample_rate > preview_seconds_limit(text):
        raise SpeechQualityError("语音时长异常，可能发生重复生成，已拦截")
    if np.max(np.abs(audio)) < 1e-4 or np.mean(np.abs(audio) > 1.0) > 0.01:
        raise SpeechQualityError("语音静音或严重削波，已拦截")
    if has_tts_runaway(audio, sample_rate):
        raise SpeechQualityError("语音中出现异常长停顿及后续输出，已拦截")


def _normalize(value):
    value = unicodedata.normalize('NFKC', value).casefold()
    return ''.join(char for char in value if char.isalnum())


def _comparable(expected):
    # Very short utterances and number-heavy strings are not reliable ASR
    # comparisons (e.g. 100 may be read as one hundred / 一百).
    letters = re.sub(r'\d', '', expected)
    return len(letters) >= 8 and len(letters) >= len(expected) / 2


def content_matches(expected, observed):
    expected, observed = _normalize(expected), _normalize(observed)
    if not _comparable(expected):
        return True
    matcher = SequenceMatcher(None, expected, observed, autojunk=False)
    matched = sum(block.size for block in matcher.get_matching_blocks())
    return matched / len(expected) >= 0.60 and matcher.ratio() >= 0.55


async def check_preview_content(audio, sample_rate, text, language):
    """Use an already cached local Whisper; never initiate model downloads."""
    if not _comparable(_normalize(text)):
        return
    from ..backends import get_stt_backend

    stt = get_stt_backend()
    candidates = ([stt.model_size] if stt.is_loaded() else []) + ['turbo', 'base']
    model = next((size for size in candidates if stt._is_model_cached(size)), None)
    if model is None:
        logger.warning("Speech preview content check unavailable: no cached Whisper model")
        return
    with tempfile.TemporaryDirectory(prefix='tts-quality-', dir=config.get_cache_dir()) as folder:
        path = Path(folder) / 'preview.wav'
        await asyncio.to_thread(save_audio, audio, str(path), sample_rate)
        observed = await stt.transcribe(str(path), language=language, model_size=model)
    if not content_matches(text, observed):
        logger.warning("Rejected speech preview: model=%s expected_chars=%d observed_chars=%d",
                       model, len(text), len(observed))
        raise SpeechQualityError("合成语音与原文偏差过大，已拦截，请重试")
