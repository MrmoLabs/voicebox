"""Entry point for the portable, non-frozen CUDA backend."""

from __future__ import annotations

import os
import runpy
import site
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
CUDA_INTERNAL = ROOT.parent / "_internal"
SOURCE_ROOT = ROOT / "app"
DEPENDENCIES = ROOT / "site-packages"
PERFORMANCE_DEPENDENCIES = ROOT / "performance-site-packages"
QWEN_SOURCE = ROOT / "qwen-source"

os.environ.setdefault("VOICEBOX_BACKEND_VARIANT", "cuda")
os.environ.setdefault("VOICEBOX_TTS_OPTIMIZE", "codebook-safe")
# Voicebox 0.5.1 desktop builds passed these process-wide flags to the
# portable backend. Clear them before importing HuggingFace so explicit model
# downloads remain online; cached loads use local_files_only in each backend.
os.environ.pop("HF_HUB_OFFLINE", None)
os.environ.pop("TRANSFORMERS_OFFLINE", None)
bundled_cc = PERFORMANCE_DEPENDENCIES / "triton" / "runtime" / "tcc" / "tcc.exe"
if bundled_cc.is_file():
    os.environ.setdefault("CC", str(bundled_cc))

sys.path[:0] = [str(QWEN_SOURCE), str(SOURCE_ROOT), str(PERFORMANCE_DEPENDENCIES)]
site.addsitedir(str(DEPENDENCIES))
site.addsitedir(str(CUDA_INTERNAL))

for relative in ("win32", "win32/lib", "pywin32_system32", "win32com", "win32comext"):
    candidate = DEPENDENCIES / relative
    if candidate.exists():
        sys.path.append(str(candidate))

for dll_dir in (
    CUDA_INTERNAL,
    CUDA_INTERNAL / "torch" / "lib",
    DEPENDENCIES / "pywin32_system32",
):
    if dll_dir.is_dir():
        os.add_dll_directory(str(dll_dir))

runpy.run_path(str(SOURCE_ROOT / "backend" / "server.py"), run_name="__main__")
