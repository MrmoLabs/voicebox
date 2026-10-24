"""Probe the bundled Qwen PCM generator without changing the running server."""

import argparse
import atexit
import asyncio
import contextvars
import faulthandler
import json
import logging
import os
import site
import sqlite3
import sys
import time
from pathlib import Path
from contextlib import ExitStack
from concurrent.futures import ThreadPoolExecutor
from functools import partial


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--portable-root", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--profile-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--compile-cache-root", type=Path,
                        help="Reuse a prior isolated compiler cache without overwriting its measurements")
    parser.add_argument("--optimization", default="0")
    parser.add_argument("--frames", type=int, nargs="+", default=[8])
    parser.add_argument("--steady-frames", type=int, nargs="+", default=[0],
                        help="Post-first-packet cadence; 0 keeps the fixed --frames cadence")
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument("--decoder-compile", action="store_true")
    parser.add_argument("--window", type=int, default=80)
    parser.add_argument("--model-size", choices=["1.7B", "0.6B"], default="1.7B")
    parser.add_argument("--fast-codebook", action="store_true")
    parser.add_argument("--full-text", action="store_true", help="Match production complete-text conditioning")
    parser.add_argument("--compare-codebook", action="store_true", help="Compare both codebook loops with one loaded model")
    parser.add_argument("--text", default="这是流式语音验证，我们要在整段生成完成以前开始播放声音。")
    parser.add_argument("--texts", nargs="+", help="Several fixed sentences in one model process; repeat each before changing context length")
    parser.add_argument("--require-free-gb", type=float, default=0,
                        help="Refuse a second model when GPU free memory is below this limit")
    parser.add_argument("--precisions", nargs="+", choices=["highest", "high"], default=["high"],
                        help="Float32 matmul modes to compare; production uses PyTorch's default highest")
    parser.add_argument("--paths", nargs="+", choices=["direct", "backend"], default=["direct"],
                        help="Compare direct iteration with the actual threaded PyTorch backend")
    parser.add_argument("--threads", nargs="+", type=int, default=[0],
                        help="Intra-op thread counts to compare in this isolated process; 0 keeps the original count")
    parser.add_argument("--talker-compile", action="store_true",
                        help="Experimental dynamic Talker compilation without CUDA graphs, isolated process only")
    parser.add_argument("--talker-pointwise-compile", action="store_true",
                        help="Compile only stateless Talker MLP/norm math, keeping attention and KV cache eager")
    parser.add_argument("--sdpa-backend", choices=["auto", "cudnn"], default="auto",
                        help="Prefer built-in cuDNN SDPA with ordinary kernels retained as fallback; isolated process only")
    parser.add_argument("--persistent-inference-worker", action="store_true",
                        help="Isolated experiment: retain one producer thread across backend utterances")
    parser.add_argument("--expand-gqa", action="store_true",
                        help="Isolated experiment: use Transformers' explicit KV repetition before SDPA")
    parser.add_argument("--prewarm", action="store_true",
                        help="Finish one silent production warmup before timing the first reply")
    args = parser.parse_args()
    if any(count < 0 or count > 64 for count in args.threads):
        parser.error("--threads must be between 0 and 64")
    if args.runs < 1:
        parser.error("--runs must be positive")
    if args.talker_compile and args.talker_pointwise_compile:
        parser.error("Choose one Talker compilation experiment")
    if args.persistent_inference_worker and args.paths != ['backend']:
        parser.error("--persistent-inference-worker requires --paths backend")
    if args.prewarm and args.paths != ['backend']:
        parser.error("--prewarm requires --paths backend")
    if args.prewarm and (len(args.threads) != 1 or len(args.precisions) != 1):
        parser.error("--prewarm requires one thread count and precision per process")
    if len(set(args.threads)) > 1 and (args.optimization != "0" or args.talker_compile or args.talker_pointwise_compile or args.decoder_compile):
        parser.error("Compiled thread comparisons require a fresh process per thread count to avoid compiler cache exhaustion")
    faulthandler.enable()
    if args.prewarm:
        faulthandler.dump_traceback_later(90, repeat=True)
        atexit.register(faulthandler.cancel_dump_traceback_later)
    args.output.mkdir(parents=True, exist_ok=True)
    workspace = Path(__file__).resolve().parents[1]
    portable = args.portable_root
    internal = portable.parent / "_internal"
    performance = portable / "performance-site-packages"
    # Match the bundled launcher rather than mixing arbitrary per-user NumPy /
    # SciPy / Transformers installations into this controlled comparison.
    user_site = site.getusersitepackages()
    sys.path[:] = [entry for entry in sys.path if entry != user_site]
    sys.path[:0] = [str(workspace / "backend/vendor"), str(workspace), str(performance)]
    site.addsitedir(str(portable / "site-packages"))
    site.addsitedir(str(internal))
    dll_handles = [os.add_dll_directory(str(path)) for path in (internal, internal / "torch/lib") if path.is_dir()]
    os.environ["HF_HUB_CACHE"] = str(args.model_cache)
    os.environ["VOICEBOX_TTS_OPTIMIZE"] = args.optimization
    compile_cache = args.compile_cache_root or args.output
    compile_cache.mkdir(parents=True, exist_ok=True)
    os.environ["TORCHINDUCTOR_CACHE_DIR"] = str(compile_cache / "inductor")
    os.environ["TRITON_CACHE_DIR"] = str(compile_cache / "triton")
    os.environ["NUMBA_CACHE_DIR"] = str(compile_cache / "numba")
    cc = performance / "triton/runtime/tcc/tcc.exe"
    if cc.is_file():
        os.environ["CC"] = str(cc)
    cuda = performance / "triton/backends/nvidia"
    if (cuda / "include/cuda.h").is_file():
        os.environ["CUDA_PATH"] = str(cuda)

    import numpy as np
    import soundfile as sf
    import torch
    from backend.utils import hf_offline_patch  # noqa: F401
    from qwen_tts import Qwen3TTSModel
    attention_scope = ExitStack()
    atexit.register(attention_scope.close)
    if args.expand_gqa:
        from transformers.integrations import sdpa_attention
        original_gqa = sdpa_attention.use_gqa_in_sdpa
        sdpa_attention.use_gqa_in_sdpa = lambda attention_mask, key: False
        attention_scope.callback(setattr, sdpa_attention, 'use_gqa_in_sdpa', original_gqa)
    if args.sdpa_backend == "cudnn":
        from torch.nn.attention import SDPBackend, sdpa_kernel
        attention_scope.enter_context(sdpa_kernel([
            SDPBackend.CUDNN_ATTENTION, SDPBackend.FLASH_ATTENTION,
            SDPBackend.EFFICIENT_ATTENTION, SDPBackend.MATH,
        ], set_priority=True))
    native_threads = torch.get_num_threads()
    if args.prewarm:
        torch.set_num_threads(args.threads[0] or native_threads)
        torch.set_float32_matmul_precision(args.precisions[0])
    class CompilerLimits(logging.Handler):
        count = 0

        def emit(self, record):
            message = record.getMessage()
            if "hit config." in message and ("recompile_limit" in message or "cache_size_limit" in message):
                self.count += 1

    compiler_limits = CompilerLimits()
    logging.getLogger("torch._dynamo").addHandler(compiler_limits)
    if args.require_free_gb and torch.cuda.mem_get_info()[0] < args.require_free_gb * 1024 ** 3:
        raise RuntimeError("Insufficient free GPU memory for an isolated benchmark; leave other models alone")

    with sqlite3.connect(f"{(args.data_dir / 'voicebox.db').as_uri()}?mode=ro", uri=True) as db:
        samples = db.execute(
            "SELECT audio_path, reference_text FROM profile_samples WHERE profile_id=?",
            (args.profile_id,),
        ).fetchall()
    if len(samples) != 1:
        raise ValueError("This benchmark requires a single-sample voice; do not silently substitute one sample of a combined voice")
    reference, transcript = samples[0]
    reference = Path(reference)
    if not reference.is_absolute():
        reference = args.data_dir / reference
    started = time.perf_counter()
    model = Qwen3TTSModel.from_pretrained(
        f"Qwen/Qwen3-TTS-12Hz-{args.model_size}-Base", device_map="cuda:0",
        dtype=torch.bfloat16, local_files_only=True,
    )
    load_seconds = time.perf_counter() - started
    if args.fast_codebook:
        model.model.talker.enable_fast_codebook_gen(True)
    if args.decoder_compile:
        model.model.speech_tokenizer.enable_streaming_optimizations(
            decode_window_frames=80, use_compile=True, use_cuda_graphs=False, compile_mode="default",
        )
    if args.talker_compile:
        model.model.talker.model.forward = torch.compile(
            model.model.talker.model.forward, fullgraph=False, dynamic=True,
            options={"triton.cudagraphs": False},
        )
    compiled_pointwise = 0
    if args.talker_pointwise_compile:
        from qwen_tts.core.models.modeling_qwen3_tts import Qwen3TTSTalkerTextMLP, Qwen3TTSRMSNorm
        for module in model.model.talker.model.modules():
            if isinstance(module, (Qwen3TTSTalkerTextMLP, Qwen3TTSRMSNorm)):
                module.forward = torch.compile(module.forward, fullgraph=True, dynamic=True,
                                               options={"triton.cudagraphs": False})
                compiled_pointwise += 1
    prompt = model.create_voice_clone_prompt(ref_audio=str(reference), ref_text=transcript)
    from backend.backends.pytorch_backend import PyTorchTTSBackend
    from qwen_tts.core.models.sdpa import _WINDOWS_WITHOUT_FLASH
    if args.persistent_inference_worker:
        from backend.backends import pytorch_backend
        executor = attention_scope.enter_context(ThreadPoolExecutor(max_workers=1))
        original_asyncio = pytorch_backend.asyncio

        class ProducerAsyncio:
            """Redirect only this backend's producer, without mutating stdlib asyncio."""

            def __getattr__(self, name):
                return getattr(original_asyncio, name)

            async def to_thread(self, function, *positional, **keywords):
                if function.__qualname__ == 'PyTorchTTSBackend.generate_stream.<locals>.produce':
                    call = partial(contextvars.copy_context().run, function, *positional, **keywords)
                    return await asyncio.get_running_loop().run_in_executor(executor, call)
                return await original_asyncio.to_thread(function, *positional, **keywords)

        pytorch_backend.asyncio = ProducerAsyncio()
        attention_scope.callback(setattr, pytorch_backend, 'asyncio', original_asyncio)
    backend = PyTorchTTSBackend(args.model_size)
    backend.model, backend._current_model_size = model, args.model_size
    preparation_seconds = 0.0
    if args.prewarm:
        async def prepare():
            async for _ in backend.generate_stream("语音预热测试。", prompt, language='zh', seed=42):
                pass
        preparation_started = time.perf_counter()
        asyncio.run(prepare())
        preparation_seconds = time.perf_counter() - preparation_started
        print(f"silent preparation: {preparation_seconds:.3f}s", flush=True)
    stream_call = model.stream_generate_voice_clone

    def configured_stream(*positional, **keywords):
        keywords.setdefault('steady_emit_every_frames', steady or None)
        return stream_call(*positional, **keywords)

    model.stream_generate_voice_clone = configured_stream
    decode_call = model.model.speech_tokenizer.decode
    decode_times = []

    def timed_decode(*positional, **keywords):
        decode_started = time.perf_counter()
        try:
            return decode_call(*positional, **keywords)
        finally:
            decode_times.append(time.perf_counter() - decode_started)

    model.model.speech_tokenizer.decode = timed_decode
    codebook_call = model.model.talker.code_predictor.generate_fast
    codebook_times = []

    def timed_codebook(*positional, **keywords):
        codebook_started = time.perf_counter()
        try:
            return codebook_call(*positional, **keywords)
        finally:
            codebook_times.append(time.perf_counter() - codebook_started)

    model.model.talker.code_predictor.generate_fast = timed_codebook
    results = []
    modes = [False, True] if args.compare_codebook else [args.fast_codebook]
    texts = args.texts or [args.text]
    tests = [(fast, frames, steady, precision, route, threads or native_threads, text_index, text, run) for fast in modes for frames in args.frames
             for text_index, text in enumerate(texts) for run in range(args.runs) for precision in args.precisions
             for steady in args.steady_frames for route in args.paths for threads in args.threads]
    for index, (fast, frames, steady, precision, route, threads, text_index, text, run) in enumerate(tests):
        # Do not reset the CPU pool after inference has already used workers.
        if torch.get_num_threads() != threads:
            torch.set_num_threads(threads)
        if torch.get_float32_matmul_precision() != precision:
            torch.set_float32_matmul_precision(precision)
        model.model.talker.enable_fast_codebook_gen(fast)
        decode_times.clear()
        codebook_times.clear()
        torch.manual_seed(42)
        torch.cuda.synchronize()
        started = time.perf_counter()
        chunks, packets = [], []
        sample_rate = 0

        def observe(pcm, sr):
            nonlocal sample_rate
            sample_rate = sr
            pcm = np.asarray(pcm, dtype=np.float32)
            assert pcm.ndim == 1 and np.isfinite(pcm).all() and len(pcm)
            chunks.append(pcm.copy())
            packets.append({"seconds": round(time.perf_counter() - started, 4), "samples": len(pcm)})
            if len(packets) == 1:
                print(f"run {index}: first PCM at {packets[0]['seconds']}s", flush=True)

        if route == 'backend':
            if (frames, args.window, args.decoder_compile, args.full_text) != (8, 80, False, True):
                raise ValueError('Backend comparison requires production frames=8, window=80, eager decode and full text')

            async def consume():
                async for pcm, sr in backend.generate_stream(text, prompt, language='zh', seed=42):
                    observe(pcm, sr)

            asyncio.run(consume())
        else:
            with torch.inference_mode():
                for pcm, sr in model.stream_generate_voice_clone(
                    text=text, language="Chinese", voice_clone_prompt=prompt,
                    emit_every_frames=frames, decode_window_frames=args.window,
                    steady_emit_every_frames=steady or None,
                    use_optimized_decode=args.decoder_compile,
                    non_streaming_mode=args.full_text,
                ):
                    observe(pcm, sr)
        sr = sample_rate
        elapsed = time.perf_counter() - started
        audio = np.concatenate(chunks)
        sf.write(args.output / f"run-{index}.wav", audio, sr)
        before_seconds, minimum_reserve = 0.0, 0.0
        for packet in packets:
            minimum_reserve = max(minimum_reserve, packet['seconds'] - packets[0]['seconds'] - before_seconds)
            before_seconds += packet['samples'] / sr
        result = {"run": run, "frames": frames, "steady_frames": steady or frames, "fast_codebook": fast, "seconds": elapsed, "first_pcm_seconds": packets[0]["seconds"],
                  "precision": precision, "path": route, "threads": threads,
                  "text_index": text_index, "text_characters": len(text),
                  "compiler_limit_events": compiler_limits.count,
                  "decode_calls": len(decode_times), "decode_wall_seconds": sum(decode_times),
                  "codebook_calls": len(codebook_times), "codebook_wall_seconds": sum(codebook_times),
                  "minimum_start_delay_seconds": minimum_reserve,
                  "audio_seconds": len(audio) / sr, "rtf": elapsed / (len(audio) / sr), "packets": packets}
        results.append(result)
        (args.output / "result.json").write_text(json.dumps({
            "torch": torch.__version__, "gpu": torch.cuda.get_device_name(),
            "optimization": args.optimization, "frames": args.frames,
            "steady_frames": args.steady_frames,
            "model_size": args.model_size, "decode_window": args.window,
            "fast_codebook": args.fast_codebook, "full_text": args.full_text,
            "load_seconds": load_seconds, "runs": results,
            "precisions": args.precisions, "decoder_dtype": str(model.model.speech_tokenizer.model.dtype),
            "paths": args.paths,
            "native_threads": native_threads, "threads": args.threads,
            "talker_compile": args.talker_compile,
            "talker_pointwise_compile": args.talker_pointwise_compile,
            "sdpa_backend": args.sdpa_backend,
            "persistent_inference_worker": args.persistent_inference_worker,
            "expand_gqa": args.expand_gqa,
            "prewarm": args.prewarm, "preparation_seconds": preparation_seconds,
            "windows_fused_sdpa_policy": _WINDOWS_WITHOUT_FLASH,
            "sdpa_priority": torch._C._get_sdp_priority_order(),
            "cudnn_sdpa_enabled": torch.backends.cuda.cudnn_sdp_enabled(),
            "compiled_pointwise_modules": compiled_pointwise,
            "compile_cache_root": str(compile_cache),
            "texts": texts,
            "attention": {
                "talker": model.model.talker.model.config._attn_implementation,
                "codebook": model.model.talker.code_predictor.model.config._attn_implementation,
            },
            "peak_cuda_allocated_mb": torch.cuda.max_memory_allocated() / 1024 ** 2,
            "peak_cuda_reserved_mb": torch.cuda.max_memory_reserved() / 1024 ** 2,
            "timing_scope": "Synchronous Python call wall time; CUDA work may overlap, not a GPU kernel profile",
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({key: value for key, value in result.items() if key != "packets"}), flush=True)


if __name__ == "__main__":
    main()
