import { afterEach, expect, test } from 'bun:test';
import {
  getStartupPhase,
  isRecoverableStartupError,
  isVoiceboxHealthResponse,
  waitForHealthyServer,
} from '../../app/src/lib/serverStartup';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const healthy = { status: 'healthy', model_loaded: false, gpu_available: true };

test('only accepts a healthy Voicebox payload, without requiring loaded model weights', () => {
  expect(isVoiceboxHealthResponse(healthy)).toBe(true);
  for (const value of [
    null,
    {},
    { status: 'healthy' },
    { ...healthy, gpu_available: 'true' },
    { ...healthy, status: 'starting' },
  ]) {
    expect(isVoiceboxHealthResponse(value)).toBe(false);
  }
});

test('recovers a timeout or occupied port but surfaces actual startup failures', () => {
  for (const error of [
    'Server startup timeout - check Console.app for detailed logs',
    'Port 17493 is already in use',
    'EADDRINUSE',
  ]) {
    expect(isRecoverableStartupError(error)).toBe(true);
  }
  for (const error of [
    'unsupported platform',
    'Failed to spawn: file missing',
    'Server process exited during startup',
    'Server startup wait limit reached after 10 minutes',
  ]) {
    expect(isRecoverableStartupError(new Error(error))).toBe(false);
  }
});

test('phase progress ignores old runs and Ready still means a health check is pending', () => {
  expect(getStartupPhase([{ timestamp: 1, stream: 'stderr', line: 'INFO - Ready' }], 100)).toBe(0);
  expect(getStartupPhase([{ stream: 'stderr', line: 'INFO - Ready' }], 100)).toBe(0);
  const lines = ['Initializing database...', 'Database initialized successfully', 'INFO - Ready'];
  const logs = lines.map((line, index) => ({
    timestamp: 101 + index,
    stream: 'stderr' as const,
    line,
  }));
  expect(getStartupPhase(logs.slice(0, 1), 100)).toBe(1);
  expect(getStartupPhase(logs.slice(0, 2), 100)).toBe(2);
  expect(getStartupPhase([...logs, logs[0]], 100)).toBe(3);
});

test('automatically reconnects after refused connections and unrelated health responses', async () => {
  let probes = 0;
  globalThis.fetch = (async () => {
    probes += 1;
    if (probes === 1) throw new TypeError('Connection refused');
    return Response.json(probes === 2 ? { status: 'healthy' } : healthy);
  }) as typeof fetch;
  await waitForHealthyServer('http://127.0.0.1:17493', new AbortController().signal, {
    intervalMs: 1,
    timeoutMs: 1000,
  });
  expect(probes).toBe(3);
});

test('stops at its wait limit and never overlaps health probes', async () => {
  let active = 0;
  let peak = 0;
  globalThis.fetch = (async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return Response.json({ status: 'starting' });
  }) as typeof fetch;
  await expect(
    waitForHealthyServer('http://localhost', new AbortController().signal, {
      intervalMs: 1,
      timeoutMs: 25,
    }),
  ).rejects.toThrow('Server startup timeout');
  expect(peak).toBe(1);
});

test('unmount cancels an in-flight health request and stops all further probes', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let probes = 0;
  globalThis.fetch = ((_url: unknown, options: RequestInit) =>
    new Promise((_resolve, reject) => {
      probes += 1;
      options.signal?.addEventListener('abort', () => {
        cancelled = true;
        reject(new DOMException('Cancelled', 'AbortError'));
      });
    })) as typeof fetch;
  const pending = waitForHealthyServer('http://localhost', controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('Startup cancelled');
  expect(cancelled).toBe(true);
  expect(probes).toBe(1);
});
