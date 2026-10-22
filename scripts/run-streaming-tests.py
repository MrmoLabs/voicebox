"""Run voice contracts in CI or with this machine's optional portable deps."""
import os
import site
import sys
from pathlib import Path

workspace = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(workspace / 'backend/vendor'), str(workspace)]
handles = []
if os.name == 'nt' and os.environ.get('VOICEBOX_TEST_PORTABLE', '1') != '0':
    portable = Path(os.environ['APPDATA']) / 'sh.voicebox.app/backends/cuda/python-backend'
    if portable.is_dir():
        internal = portable.parent / '_internal'
        sys.path.insert(0, str(portable / 'performance-site-packages'))
        site.addsitedir(str(portable / 'site-packages'))
        site.addsitedir(str(internal))
        site.addsitedir(str(Path(os.environ['APPDATA']) / 'Python/Python312/site-packages'))
        handles = [os.add_dll_directory(str(path)) for path in (internal, internal / 'torch/lib') if path.is_dir()]
# CLI subprocesses need the same installed dependencies as the test process.
os.environ['PYTHONPATH'] = os.pathsep.join(sys.path)
numba_cache = workspace / '.tmp-stream-test-numba'
numba_cache.mkdir(exist_ok=True)
os.environ['NUMBA_CACHE_DIR'] = str(numba_cache)
os.environ['PYTEST_DISABLE_PLUGIN_AUTOLOAD'] = '1'

import pytest

tests = ['test_live_audio', 'test_generation_progress', 'test_generation_progress_integration',
         'test_combined_voice_cache', 'test_task_queue_cancellation',
         'test_generation_engine_resolution', 'test_voice_prompt_cache_unload', 'test_qwen_load_concurrency',
         'test_models_load_by_name', 'test_model_runtime', 'test_audiobooks', 'test_designed_profiles']
tests += ['test_speak_dispatch', 'test_speak_language', 'test_mcp_speak']
tests += ['test_qwen_stream_sampling']
tests += ['test_qwen_fast_codebook']
tests += ['test_qwen_sdpa']
tests += ['test_speech_quality', 'test_generation_cancel']
if __name__ == '__main__':
    sys.exit(pytest.main((sys.argv[1:] or [f'backend/tests/{test}.py' for test in tests]) +
        ['-q', '-p', 'no:cacheprovider', '-p', 'pytest_asyncio.plugin', '--asyncio-mode=auto', '--disable-warnings', '--tb=short']))
