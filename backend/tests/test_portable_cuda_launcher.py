import os
from pathlib import Path
import runpy
import site
import sys


def test_portable_launcher_normalizes_compile_caches_and_finds_bundled_cuda(tmp_path, monkeypatch):
    root = tmp_path / "portable"
    cuda = root / "performance-site-packages/triton/backends/nvidia"
    (cuda / "include").mkdir(parents=True)
    (cuda / "include/cuda.h").touch()
    cache = tmp_path / "cache"
    monkeypatch.setenv("TORCHINDUCTOR_CACHE_DIR", str(cache / ".." / "cache" / "inductor"))
    monkeypatch.setenv("TRITON_CACHE_DIR", str(cache / "triton"))
    monkeypatch.delenv("CUDA_PATH", raising=False)
    monkeypatch.setattr(sys, "path", sys.path.copy())
    monkeypatch.setattr(site, "addsitedir", lambda _path: None)
    calls = []
    monkeypatch.setattr(runpy, "run_path", lambda path, **kwargs: calls.append(path))
    source = Path(__file__).parents[1] / "portable_cuda_launcher.py"
    exec(compile(source.read_text(encoding="utf-8"), str(source), "exec"), {"__file__": str(root / "launcher.py")})
    assert os.environ["TORCHINDUCTOR_CACHE_DIR"] == str((cache / "inductor").resolve())
    assert (cache / "inductor").is_dir()
    assert (cache / "triton").is_dir()
    assert Path(os.environ["CUDA_PATH"]) == cuda
    assert calls == [str(root / "app/backend/server.py")]
