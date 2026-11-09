import type { ServerLogEntry } from '../platform/types';

export const STARTUP_SLOW_MS = 120_000;
export const STARTUP_RECOVERY_MS = 600_000;

export function isVoiceboxHealthResponse(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const health = value as Record<string, unknown>;
  return (
    health.status === 'healthy' &&
    typeof health.model_loaded === 'boolean' &&
    typeof health.gpu_available === 'boolean'
  );
}

export function isRecoverableStartupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /startup timeout|already in use|EADDRINUSE|address.*in use/i.test(message);
}

// Persistent logs contain older runs. Never use those to advance this startup.
export function getStartupPhase(entries: ServerLogEntry[], startedAt: number): number {
  let phase = 0;
  for (const entry of entries) {
    if (entry.timestamp === undefined || entry.timestamp < startedAt) continue;
    if (/Initializing database/.test(entry.line)) phase = Math.max(phase, 1);
    if (/Database initialized successfully|Voicebox v.*starting up/.test(entry.line)) {
      phase = Math.max(phase, 2);
    }
    if (/ - Ready$|Application startup complete|Uvicorn running/.test(entry.line.trim())) {
      phase = 3;
    }
  }
  return phase;
}

/** Bounded, non-overlapping health probes, including cancellation of in-flight fetches. */
export async function waitForHealthyServer(
  url: string,
  signal: AbortSignal,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? STARTUP_RECOVERY_MS;
  const intervalMs = options.intervalMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    const request = new AbortController();
    const abort = () => request.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(3000, deadline - Date.now()));
    try {
      const response = await fetch(`${url}/health`, { signal: request.signal });
      if (response.ok && isVoiceboxHealthResponse(await response.json()) && !signal.aborted) {
        return;
      }
    } catch {
      // A cold backend can refuse connections until its imports have finished.
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(sleepTimer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const sleepTimer = setTimeout(done, Math.min(intervalMs, Math.max(0, deadline - Date.now())));
      signal.addEventListener('abort', done, { once: true });
    });
  }
  if (signal.aborted) throw new DOMException('Startup cancelled', 'AbortError');
  throw new Error('Server startup timeout');
}
