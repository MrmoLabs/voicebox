import asyncio
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend import backends, models
from backend.routes import models as routes
from backend.utils import model_runtime as runtime


@pytest.mark.asyncio
async def test_generation_lease_rejects_manual_mutation_and_allows_nested_load():
    async with runtime.runtime_lease('生成语音'):
        async with runtime.runtime_lease('嵌套载入'):
            assert runtime.operation_snapshot('model')['runtime_busy']

        async def mutate():
            with pytest.raises(HTTPException) as error:
                async with runtime.runtime_lease('卸载模型', reject_busy=True):
                    pytest.fail('mutation entered during inference')
            assert error.value.status_code == 409
        await asyncio.create_task(mutate())
    assert not runtime.operation_snapshot('model')['runtime_busy']


@pytest.mark.asyncio
async def test_operation_reports_error_and_can_retry():
    with pytest.raises(RuntimeError):
        async with runtime.model_operation('test-operation', 'loading'):
            assert runtime.operation_snapshot('test-operation')['operation'] == 'loading'
            raise RuntimeError('failed to load')
    assert runtime.operation_snapshot('test-operation')['operation_error'] == 'failed to load'
    async with runtime.model_operation('test-operation', 'loading'):
        pass
    assert runtime.operation_snapshot('test-operation')['operation'] == 'idle'
    assert runtime.operation_snapshot('test-operation')['operation_error'] is None


@pytest.mark.asyncio
async def test_cancelled_loader_does_not_release_runtime_while_thread_mutates():
    entered, release, exited = threading.Event(), threading.Event(), threading.Event()

    def load():
        entered.set()
        release.wait(2)
        exited.set()

    async def run():
        async with runtime.runtime_lease('载入模型'):
            await runtime.finish_thread(load)

    task = asyncio.create_task(run())
    while not entered.is_set():
        await asyncio.sleep(.01)
    task.cancel()
    await asyncio.sleep(.02)
    assert not task.done()
    assert runtime.operation_snapshot('model')['runtime_busy']
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert exited.is_set()
    assert not runtime.operation_snapshot('model')['runtime_busy']


@pytest.mark.asyncio
async def test_load_and_switch_unloads_only_other_loaded_tts_models(monkeypatch):
    previous = SimpleNamespace(model_name='previous')
    target = SimpleNamespace(model_name='target')
    unrelated = SimpleNamespace(model_name='unloaded')
    calls = []
    monkeypatch.setattr(routes, '_resolve_model_config', lambda _: target)
    monkeypatch.setattr(backends, 'get_tts_model_configs', lambda: [previous, target, unrelated])
    monkeypatch.setattr(backends, 'check_model_loaded', lambda config: config is previous)
    monkeypatch.setattr(backends, 'unload_model_by_config', lambda config: calls.append(('unload', config.model_name)))

    async def load():
        calls.append(('load', 'target'))
    monkeypatch.setattr(backends, 'get_model_load_func', lambda _: load)
    await routes.load_model(models.ModelLoadRequest(model_name='target', replace_loaded=True))
    assert calls == [('unload', 'previous'), ('load', 'target')]


@pytest.mark.asyncio
async def test_manual_unload_is_blocked_between_book_sentences(monkeypatch):
    from backend.services import audiobook_generation_plans
    monkeypatch.setattr(audiobook_generation_plans, '_running_plans', {'active-book-plan'})
    with pytest.raises(HTTPException) as error:
        await routes.unload_model_by_name('qwen-tts-1.7B')
    assert error.value.status_code == 409
    assert runtime.operation_snapshot('qwen-tts-1.7B')['runtime_busy']
