"""
PyTorch backend implementation for TTS and STT.
"""

from typing import Optional, List, Tuple
import asyncio
import logging
import time
import queue
import threading
from dataclasses import asdict, is_dataclass
import torch
import numpy as np

logger = logging.getLogger(__name__)

WHISPER_SAMPLE_RATE = 16000
# Whisper encodes one 30s window per pass; longer audio needs sequential long-form decoding.
WHISPER_WINDOW_SAMPLES = 30 * WHISPER_SAMPLE_RATE

from . import TTSBackend, STTBackend, LANGUAGE_CODE_TO_NAME, WHISPER_HF_REPOS
from .base import (
    is_model_cached,
    get_torch_device,
    empty_device_cache,
    manual_seed,
    combine_voice_prompts as _combine_voice_prompts,
    model_load_progress,
)
from ..utils.cache import get_cache_key, get_cached_voice_prompt, cache_voice_prompt
from ..utils.audio import load_audio
from ..utils.hf_offline_patch import force_offline_if_cached


class PyTorchTTSBackend:
    """PyTorch-based TTS backend using Qwen3-TTS."""

    def __init__(self, model_size: str = "1.7B"):
        self.model = None
        self.model_size = model_size
        self.device = self._get_device()
        self._current_model_size = None
        self._load_lock = asyncio.Lock()
        self._inference_lock = asyncio.Lock()
        self._inference_warmed = False

    def _get_device(self) -> str:
        """Get the best available device."""
        return get_torch_device(allow_xpu=True, allow_directml=True)

    def is_loaded(self) -> bool:
        """Check if model is loaded."""
        return self.model is not None

    def _get_model_path(self, model_size: str) -> str:
        """
        Get the HuggingFace Hub model ID.

        Args:
            model_size: Model size (1.7B or 0.6B)

        Returns:
            HuggingFace Hub model ID
        """
        hf_model_map = {
            "1.7B": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
            "0.6B": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        }

        if model_size not in hf_model_map:
            raise ValueError(f"Unknown model size: {model_size}")

        return hf_model_map[model_size]

    def _is_model_cached(self, model_size: str) -> bool:
        return is_model_cached(self._get_model_path(model_size))

    async def load_model_async(self, model_size: Optional[str] = None):
        """
        Lazy load the TTS model with automatic downloading from HuggingFace Hub.

        Args:
            model_size: Model size to load (1.7B or 0.6B)
        """
        if model_size is None:
            model_size = self.model_size

        # If already loaded with correct size, return
        if self.model is not None and self._current_model_size == model_size:
            return

        async with self._load_lock:
            if self.model is not None and self._current_model_size == model_size:
                return
            if self.model is not None:
                self.unload_model()
            from ..utils.model_runtime import finish_thread
            try:
                await finish_thread(self._load_model_sync, model_size)
            except BaseException:
                self.unload_model()
                raise

    # Alias for compatibility
    load_model = load_model_async

    def _load_model_sync(self, model_size: str):
        """Synchronous model loading."""
        model_name = f"qwen-tts-{model_size}"
        is_cached = self._is_model_cached(model_size)
        started = time.perf_counter()

        with model_load_progress(model_name, is_cached):
            from qwen_tts import Qwen3TTSModel
            logger.info("Qwen dependencies ready in %.2fs", time.perf_counter() - started)

            model_path = self._get_model_path(model_size)
            logger.info("Loading TTS model %s on %s...", model_size, self.device)

            # Route both HF Hub and Transformers through a single cache root.
            # On Windows local setups, model assets can otherwise split between
            # .hf-cache/hub and .hf-cache/transformers, causing speech_tokenizer
            # and preprocessor_config.json to fail to resolve during load.
            from huggingface_hub import constants as hf_constants
            tts_cache_dir = hf_constants.HF_HUB_CACHE

            # Qwen performs several nested Hub loads (processor, speech tokenizer,
            # generation config) which do not consistently inherit the outer
            # local_files_only argument. Scope offline mode to a complete cached
            # model load so those nested calls cannot issue HEAD requests.
            with force_offline_if_cached(is_cached, model_name):
                if self.device == "cpu":
                    self.model = Qwen3TTSModel.from_pretrained(
                        model_path,
                        cache_dir=tts_cache_dir,
                        local_files_only=is_cached,
                        torch_dtype=torch.float32,
                        low_cpu_mem_usage=False,
                    )
                else:
                    self.model = Qwen3TTSModel.from_pretrained(
                        model_path,
                        cache_dir=tts_cache_dir,
                        local_files_only=is_cached,
                        device_map=self.device,
                        torch_dtype=torch.bfloat16,
                    )

        self._current_model_size = model_size
        self.model_size = model_size
        logger.info("TTS model %s loaded successfully in %.2fs", model_size, time.perf_counter() - started)

    def unload_model(self):
        """Unload the model to free memory."""
        self._inference_warmed = False
        if self.model is not None:
            del self.model
            self.model = None
            self._current_model_size = None

            empty_device_cache(self.device)

            logger.info("TTS model unloaded")

    async def create_voice_prompt(
        self,
        audio_path: str,
        reference_text: str,
        use_cache: bool = True,
    ) -> Tuple[dict, bool]:
        """
        Create voice prompt from reference audio.

        Args:
            audio_path: Path to reference audio file
            reference_text: Transcript of reference audio
            use_cache: Whether to use cached prompt if available

        Returns:
            Tuple of (voice_prompt_dict, was_cached)
        """
        await self.load_model_async(None)

        # Check cache if enabled
        if use_cache:
            cache_key = f"qwen-base-{self.model_size}-" + get_cache_key(audio_path, reference_text)
            cached_prompt = get_cached_voice_prompt(cache_key)
            if cached_prompt is not None:
                # Cache stores as torch.Tensor but actual prompt is dict
                # Convert if needed
                if isinstance(cached_prompt, dict):
                    if "qwen_voice_clone_prompt" in cached_prompt:
                        from qwen_tts.inference.qwen3_tts_model import VoiceClonePromptItem

                        return [VoiceClonePromptItem(**item) for item in cached_prompt["qwen_voice_clone_prompt"]], True
                    # For PyTorch backend, the dict should contain tensors, not file paths
                    # So we can safely return it
                    return cached_prompt, True
                elif isinstance(cached_prompt, torch.Tensor):
                    # Legacy cache format - convert to dict
                    # This shouldn't happen in practice, but handle it
                    return {"prompt": cached_prompt}, True
                elif isinstance(cached_prompt, list):
                    return cached_prompt, True

        def _create_prompt_sync():
            """Run synchronous voice prompt creation in thread pool."""
            # Inference runs with the process's default HF_HUB_OFFLINE
            # state. Forcing offline here (issue #462) regressed online
            # users whose libraries issue legitimate metadata lookups
            # during voice-prompt creation.
            return self.model.create_voice_clone_prompt(
                ref_audio=str(audio_path),
                ref_text=reference_text,
                x_vector_only_mode=False,
            )

        # Run blocking operation in thread pool
        voice_prompt_items = await asyncio.to_thread(_create_prompt_sync)

        # Cache if enabled
        if use_cache:
            cache_key = f"qwen-base-{self.model_size}-" + get_cache_key(audio_path, reference_text)
            # Save plain tensor dictionaries so weights_only=True can reload
            # them across restarts without unpickling a custom Qwen class.
            cached_items = voice_prompt_items
            if isinstance(voice_prompt_items, list) and all(is_dataclass(item) for item in voice_prompt_items):
                cached_items = {"qwen_voice_clone_prompt": [asdict(item) for item in voice_prompt_items]}
            cache_voice_prompt(cache_key, cached_items)

        return voice_prompt_items, False

    async def combine_voice_prompts(
        self,
        audio_paths: List[str],
        reference_texts: List[str],
    ) -> Tuple[np.ndarray, str]:
        return await _combine_voice_prompts(audio_paths, reference_texts)

    async def generate(
        self,
        text: str,
        voice_prompt: dict,
        language: str = "en",
        seed: Optional[int] = None,
        instruct: Optional[str] = None,
    ) -> Tuple[np.ndarray, int]:
        """
        Generate audio from text using voice prompt.

        Args:
            text: Text to synthesize
            voice_prompt: Voice prompt dictionary from create_voice_prompt
            language: Language code (en or zh)
            seed: Random seed for reproducibility
            instruct: Natural language instruction for speech delivery control

        Returns:
            Tuple of (audio_array, sample_rate)
        """
        # Load model
        await self.load_model_async(None)

        def _generate_sync():
            """Run synchronous generation in thread pool."""
            # Set seed if provided
            if seed is not None:
                manual_seed(seed, self.device)

            # See _create_prompt_sync comment — inference runs with the
            # process's default HF_HUB_OFFLINE state (issue #462).
            with torch.inference_mode():
                wavs, sample_rate = self.model.generate_voice_clone(
                    text=text,
                    voice_clone_prompt=voice_prompt,
                    language=LANGUAGE_CODE_TO_NAME.get(language, "auto"),
                    instruct=instruct,
                )
            return wavs[0], sample_rate

        # Run blocking inference in thread pool to avoid blocking event loop
        async with self._inference_lock:
            worker = asyncio.create_task(asyncio.to_thread(_generate_sync))
            try:
                audio, sample_rate = await asyncio.shield(worker)
            finally:
                # Cancelling the await does not stop CUDA work in the thread.
                # Keep ownership until it exits before another request starts.
                while not worker.done():
                    try:
                        await asyncio.shield(worker)
                    except asyncio.CancelledError:
                        continue

        self._inference_warmed = True
        return audio, sample_rate

    async def generate_stream(self, text, voice_prompt, language="en", seed=None, instruct=None):
        """Yield PCM with bounded producer memory and cooperative cancellation."""
        await self.load_model_async(None)
        async with self._inference_lock:
            packets = queue.Queue(maxsize=4)
            stopped = threading.Event()
            end = object()

            def put(item):
                while not stopped.is_set():
                    try:
                        packets.put(item, timeout=0.1)
                        return
                    except queue.Full:
                        pass

            def produce():
                generator = None
                try:
                    if seed is not None:
                        manual_seed(seed, self.device)
                    with torch.inference_mode():
                        generator = self.model.stream_generate_voice_clone(
                            text=text, voice_clone_prompt=voice_prompt,
                            language=LANGUAGE_CODE_TO_NAME.get(language, "auto"),
                            emit_every_frames=8, decode_window_frames=80,
                            use_optimized_decode=False,
                        )
                        for audio, sample_rate in generator:
                            if stopped.is_set():
                                break
                            put((np.asarray(audio, dtype=np.float32).copy(), sample_rate))
                except Exception as error:
                    put(error)
                finally:
                    try:
                        if generator is not None:
                            generator.close()
                    except Exception as error:
                        put(error)
                    finally:
                        put(end)

            worker = asyncio.create_task(asyncio.to_thread(produce))
            try:
                while True:
                    try:
                        item = await asyncio.to_thread(packets.get, True, 0.2)
                    except queue.Empty:
                        continue
                    if item is end:
                        self._inference_warmed = True
                        break
                    if isinstance(item, Exception):
                        raise item
                    yield item
            finally:
                stopped.set()
                while not worker.done():
                    try:
                        await asyncio.shield(worker)
                    except asyncio.CancelledError:
                        continue


class PyTorchSTTBackend:
    """PyTorch-based STT backend using Whisper."""

    def __init__(self, model_size: str = "base"):
        self.model = None
        self.processor = None
        self.model_size = model_size
        self.device = self._get_device()

    def _get_device(self) -> str:
        """Get the best available device."""
        return get_torch_device(allow_xpu=True, allow_directml=True)

    def is_loaded(self) -> bool:
        """Check if model is loaded."""
        return self.model is not None

    def _is_model_cached(self, model_size: str) -> bool:
        hf_repo = WHISPER_HF_REPOS.get(model_size, f"openai/whisper-{model_size}")
        return is_model_cached(hf_repo)

    async def load_model_async(self, model_size: Optional[str] = None):
        """
        Lazy load the Whisper model.

        Args:
            model_size: Model size (tiny, base, small, medium, large)
        """
        if model_size is None:
            model_size = self.model_size

        if self.model is not None and self.model_size == model_size:
            return

        await asyncio.to_thread(self._load_model_sync, model_size)

    # Alias for compatibility
    load_model = load_model_async

    def _load_model_sync(self, model_size: str):
        """Synchronous model loading."""
        progress_model_name = f"whisper-{model_size}"
        is_cached = self._is_model_cached(model_size)

        with model_load_progress(progress_model_name, is_cached):
            from transformers import WhisperProcessor, WhisperForConditionalGeneration

            model_name = WHISPER_HF_REPOS.get(model_size, f"openai/whisper-{model_size}")
            logger.info("Loading Whisper model %s on %s...", model_size, self.device)

            # Avoid HuggingFace revision/update checks when the selected model
            # is already complete in the local cache. Missing models still use
            # the normal online download path.
            self.processor = WhisperProcessor.from_pretrained(
                model_name,
                local_files_only=is_cached,
            )
            self.model = WhisperForConditionalGeneration.from_pretrained(
                model_name,
                local_files_only=is_cached,
            )

        self.model.to(self.device)
        self.model_size = model_size
        logger.info("Whisper model %s loaded successfully", model_size)

    def unload_model(self):
        """Unload the model to free memory."""
        if self.model is not None:
            del self.model
            del self.processor
            self.model = None
            self.processor = None

            empty_device_cache(self.device)

            logger.info("Whisper model unloaded")

    async def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
        model_size: Optional[str] = None,
    ) -> str:
        """
        Transcribe audio to text.

        Args:
            audio_path: Path to audio file
            language: Optional language hint
            model_size: Optional model size override

        Returns:
            Transcribed text
        """
        await self.load_model_async(model_size)

        def _transcribe_sync():
            """Run synchronous transcription in thread pool."""
            # Load audio
            audio, _sr = load_audio(audio_path, sample_rate=WHISPER_SAMPLE_RATE)

            # Inference runs with the process's default HF_HUB_OFFLINE
            # state — forcing offline here (issue #462) broke online users
            # whose `get_decoder_prompt_ids` / tokenizer calls issue
            # legitimate metadata lookups.
            # Process audio.
            # truncation=False + padding="longest" + return_attention_mask=True
            # are required for long-form transcription. Without them the
            # feature extractor silently truncates to 30s (Whisper's native
            # window) and audio past that point is dropped.
            #
            # Only use them for audio longer than one 30s window. For shorter
            # clips the default pad-to-30s path is needed: with
            # padding="longest" the encoder rejects the shorter mel input
            # ("expects the mel input features to be of length 3000") when
            # generate() runs language detection, i.e. whenever no language
            # is forced.
            is_long_form = len(audio) > WHISPER_WINDOW_SAMPLES
            processor_kwargs = (
                {"truncation": False, "padding": "longest", "return_attention_mask": True}
                if is_long_form
                else {}
            )
            inputs = self.processor(
                audio,
                sampling_rate=WHISPER_SAMPLE_RATE,
                return_tensors="pt",
                **processor_kwargs,
            )
            inputs = inputs.to(self.device)

            # Generate transcription.
            # If language is provided, force it; otherwise let Whisper
            # auto-detect. Pass language/task directly to generate() instead
            # of building forced_decoder_ids — get_decoder_prompt_ids defaults
            # to no_timestamps=True, which injects <|notimestamps|> and
            # disables the timestamp tokens that return_timestamps=True (and
            # therefore long-form decoding) depend on.
            generate_kwargs = {}
            if language:
                generate_kwargs["language"] = language
                generate_kwargs["task"] = "transcribe"
            if is_long_form:
                generate_kwargs["attention_mask"] = inputs["attention_mask"]
                generate_kwargs["return_timestamps"] = True

            with torch.no_grad():
                predicted_ids = self.model.generate(
                    inputs["input_features"],
                    **generate_kwargs,
                )

            # Decode
            transcription = self.processor.batch_decode(
                predicted_ids,
                skip_special_tokens=True,
            )[0]

            return transcription.strip()

        # Run blocking transcription in thread pool
        return await asyncio.to_thread(_transcribe_sync)
