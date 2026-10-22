"""Probe the bundled Qwen PCM generator without changing the running server."""

import argparse
import asyncio
import json
import os
import site
import sqlite3
import sys
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--portable-root", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--profile-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
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
    parser.add_argument("--require-free-gb", type=float, default=0,
                        help="Refuse a second model when GPU free memory is below this limit")
    parser.add_argument("--precisions", nargs="+", choices=["highest", "high"], default=["high"],
                        help="Float32 matmul modes to compare; production uses PyTorch's default highest")
    parser.add_argument("--paths", nargs="+", choices=["direct", "backend"], default=["direct"],
                        help="Compare direct iteration with the actual threaded PyTorch backend")
    args = parser.parse_args()
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
    os.environ["TORCHINDUCTOR_CACHE_DIR"] = str(args.output / "inductor")
    os.environ["TRITON_CACHE_DIR"] = str(args.output / "triton")
    os.environ["NUMBA_CACHE_DIR"] = str(args.output / "numba")
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
    prompt = model.create_voice_clone_prompt(ref_audio=str(reference), ref_text=transcript)
    from backend.backends.pytorch_backend import PyTorchTTSBackend
    backend = PyTorchTTSBackend(args.model_size)
    backend.model, backend._current_model_size = model, args.model_size
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
    results = []
    modes = [False, True] if args.compare_codebook else [args.fast_codebook]
    tests = [(fast, frames, steady, precision, route, run) for fast in modes for frames in args.frames
             for run in range(args.runs) for precision in args.precisions
             for steady in args.steady_frames for route in args.paths]
    for index, (fast, frames, steady, precision, route, run) in enumerate(tests):
        torch.set_float32_matmul_precision(precision)
        model.model.talker.enable_fast_codebook_gen(fast)
        decode_times.clear()
        text = args.text
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
                  "precision": precision, "path": route, "decode_calls": len(decode_times), "decode_wall_seconds": sum(decode_times),
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
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({key: value for key, value in result.items() if key != "packets"}), flush=True)


if __name__ == "__main__":
    main()
