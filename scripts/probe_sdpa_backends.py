"""Compare installed SDPA kernels with synthetic Qwen-sized tensors, no model."""
import argparse
import faulthandler
import json
import os
import site
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', action='store_true', required=True)
    parser.add_argument('--portable-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--varying-keys', action='store_true',
                        help='Measure changing decode shapes on a persistent worker and a new worker')
    parser.add_argument('--expand-gqa', action='store_true',
                        help='Explicitly repeat KV heads before SDPA to test non-GQA fused kernels')
    args = parser.parse_args()
    faulthandler.enable()
    with urllib.request.urlopen('http://127.0.0.1:17493/tasks/active', timeout=8) as response:
        active = json.load(response)
    if active['generations'] or active['downloads']:
        raise RuntimeError('Backend busy; leave current work alone')
    root = args.portable_root
    internal = root.parent / '_internal'
    sys.path[:] = [item for item in sys.path if item != site.getusersitepackages()]
    sys.path.insert(0, str(root / 'performance-site-packages'))
    site.addsitedir(str(root / 'site-packages'))
    site.addsitedir(str(internal))
    handles = [os.add_dll_directory(str(path)) for path in (internal, internal / 'torch/lib') if path.is_dir()]
    import torch
    from torch.nn.attention import SDPBackend, sdpa_kernel
    from torch.nn.functional import scaled_dot_product_attention as attention
    if torch.cuda.mem_get_info()[0] < 1024 ** 3:
        raise RuntimeError('Less than 1 GiB free; skip the synthetic probe')
    backends = {'auto': None, 'flash': SDPBackend.FLASH_ATTENTION,
                'efficient': SDPBackend.EFFICIENT_ATTENTION, 'cudnn': SDPBackend.CUDNN_ATTENTION,
                'math': SDPBackend.MATH,
                'all-enabled': [SDPBackend.CUDNN_ATTENTION, SDPBackend.FLASH_ATTENTION,
                                SDPBackend.EFFICIENT_ATTENTION, SDPBackend.MATH],
                'cudnn-preferred': [SDPBackend.CUDNN_ATTENTION, SDPBackend.FLASH_ATTENTION,
                                    SDPBackend.EFFICIENT_ATTENTION, SDPBackend.MATH]}
    report = {'torch': torch.__version__, 'scope': 'Synthetic BF16 Qwen head shapes; no model, audio or user settings',
              'gpu': torch.cuda.get_device_name(), 'defaultPriority': torch._C._get_sdp_priority_order(),
              'defaultCudnnEnabled': torch.backends.cuda.cudnn_sdp_enabled(),
              'expandGqa': args.expand_gqa, 'results': []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    from contextlib import nullcontext
    if args.varying_keys:
        import threading

        def sequence():
            measurements = []
            with torch.inference_mode():
                for length in range(32, 64):
                    q = torch.randn(1, 16, 1, 128, device='cuda', dtype=torch.bfloat16)
                    k = torch.randn(1, 8, length, 128, device='cuda', dtype=torch.bfloat16)
                    v = torch.randn_like(k)
                    if args.expand_gqa:
                        k, v = k.repeat_interleave(2, dim=1), v.repeat_interleave(2, dim=1)
                    torch.cuda.synchronize()
                    started = time.perf_counter()
                    output = attention(q, k, v, enable_gqa=not args.expand_gqa)
                    torch.cuda.synchronize()
                    measurements.append(time.perf_counter() - started)
                    if not bool(torch.isfinite(output).all()):
                        raise RuntimeError('Non-finite SDPA output')
            return {'thread': threading.get_ident(), 'seconds': sum(measurements),
                    'call_seconds': measurements}

        for name in ('math', 'cudnn'):
            with sdpa_kernel(backends[name]):
                with ThreadPoolExecutor(max_workers=1) as worker:
                    first = worker.submit(sequence).result()
                    repeat = worker.submit(sequence).result()
                    # Keep the first thread alive to guarantee a different native thread.
                    with ThreadPoolExecutor(max_workers=1) as other:
                        fresh = other.submit(sequence).result()
            result = {'backend': name, 'first': first, 'same_worker': repeat, 'new_worker': fresh}
            report['results'].append(result)
            args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
            print(json.dumps({key: value if key == 'backend' else
                              {item: data for item, data in value.items() if item != 'call_seconds'}
                              for key, value in result.items()}), flush=True)
        return
    with torch.inference_mode():
        for label, query_len, key_len, masked in [('decode', 1, 200, False), ('masked-decode', 1, 200, True),
                                                 ('codebook', 1, 8, False), ('prefill', 200, 200, False)]:
            q = torch.randn(1, 16, query_len, 128, device='cuda', dtype=torch.bfloat16)
            k = torch.randn(1, 8, key_len, 128, device='cuda', dtype=torch.bfloat16)
            v = torch.randn_like(k)
            if args.expand_gqa:
                k, v = k.repeat_interleave(2, dim=1), v.repeat_interleave(2, dim=1)
            mask = torch.zeros(1, 1, query_len, key_len, device='cuda', dtype=q.dtype) if masked else None
            def invoke():
                return attention(q, k, v, attn_mask=mask, is_causal=query_len > 1, enable_gqa=not args.expand_gqa)
            with sdpa_kernel(SDPBackend.MATH):
                reference = invoke()
            for name, backend in backends.items():
                result = {'shape': label, 'backend': name}
                try:
                    with sdpa_kernel(backend, set_priority=name == 'cudnn-preferred') if backend is not None else nullcontext():
                        for _ in range(5):
                            invoke()
                        torch.cuda.synchronize()
                        begin, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
                        started = time.perf_counter()
                        begin.record()
                        for _ in range(50):
                            output = invoke()
                        end.record()
                        torch.cuda.synchronize()
                        elapsed = time.perf_counter() - started
                        with torch.profiler.profile(activities=[torch.profiler.ProfilerActivity.CPU]) as profiler:
                            invoke()
                        operations = [item.key for item in profiler.key_averages() if '_scaled_dot_product' in item.key]
                    result.update(supported=True, wallUs=elapsed / 50 * 1e6, cudaUs=begin.elapsed_time(end) / 50 * 1000,
                                  finite=bool(torch.isfinite(output).all()), operations=operations,
                                  maxAbsError=float((output - reference).abs().max()),
                                  agreesWithMath=bool(torch.allclose(output, reference, atol=.02, rtol=.02)))
                except RuntimeError as error:
                    result.update(supported=False, error=str(error)[:300])
                report['results'].append(result)
                args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
                print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
