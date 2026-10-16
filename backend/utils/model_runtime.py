"""Serialize model mutations with inference, and expose real operation state."""
import asyncio
import functools
import time
from contextlib import asynccontextmanager

from fastapi import HTTPException

_loop = None
_lock = None
_owner = None
_label = None
_operations = {}


def current_activity():
    if _label:
        return _label
    from ..services.audiobook_generation_plans import _running_plans
    if _running_plans:
        return "生成有声图书"
    from .tasks import get_task_manager
    if get_task_manager().get_active_generations():
        return "等待语音生成任务"
    return None


@asynccontextmanager
async def runtime_lease(label, *, reject_busy=False):
    global _loop, _lock, _owner, _label
    loop = asyncio.get_running_loop()
    if _loop is not loop:
        _loop, _lock, _owner, _label = loop, asyncio.Lock(), None, None
    task = asyncio.current_task()
    if _owner is task:
        yield
        return
    activity = current_activity() if reject_busy else None
    if reject_busy and (_lock.locked() or activity):
        raise HTTPException(409, f"正在{activity or '使用模型'}，请等待完成或先停止生成，再加载、切换或卸载模型。")
    await _lock.acquire()
    _owner, _label = task, label
    try:
        yield
    finally:
        _owner, _label = None, None
        _lock.release()


def runtime_guard(label, *, reject_busy=False):
    def decorate(function):
        @functools.wraps(function)
        async def wrapped(*args, **kwargs):
            async with runtime_lease(label, reject_busy=reject_busy):
                return await function(*args, **kwargs)
        return wrapped
    return decorate


@asynccontextmanager
async def model_operation(model_name, phase):
    state = {'phase': phase, 'started': time.monotonic(), 'error': None}
    _operations[model_name] = state
    try:
        yield
    except BaseException as error:
        state.update(phase='error', error=str(error) or '操作已取消')
        raise
    else:
        state.update(phase='idle', error=None)


async def finish_thread(function, *args):
    """Cancellation cannot release the lease while its worker still mutates CUDA."""
    return await finish_awaitable(asyncio.to_thread(function, *args))


async def finish_awaitable(awaitable):
    worker = asyncio.ensure_future(awaitable)
    try:
        return await asyncio.shield(worker)
    finally:
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                continue


def operation_snapshot(model_name):
    state = _operations.get(model_name)
    return dict(operation=state['phase'] if state else 'idle',
                operation_elapsed_seconds=round(time.monotonic() - state['started'], 1)
                if state and state['phase'] in ('loading', 'unloading') else None,
                operation_error=state['error'] if state else None,
                runtime_busy=bool(current_activity()), runtime_activity=current_activity())
