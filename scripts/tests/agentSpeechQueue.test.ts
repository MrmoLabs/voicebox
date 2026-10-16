import { expect, test } from 'bun:test';
import { AgentSpeechQueue, type AgentSpeechState } from '../../app/src/lib/audio/agentSpeechQueue';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const starts: string[] = [], cancels: string[] = [], states: Array<AgentSpeechState | null> = [];
  const releases = new Map<string, () => void>();
  const signals = new Map<string, AbortSignal>();
  const errors: unknown[] = [];
  const queue = new AgentSpeechQueue({
    play: (job, signal) => {
      starts.push(job.generation_id);
      signals.set(job.generation_id, signal);
      return new Promise<void>((resolve, reject) => {
        releases.set(job.generation_id, resolve);
        signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true });
      });
    },
    cancel: async (id) => { cancels.push(id); },
    state: (state) => states.push(state), error: (error) => errors.push(error),
  });
  return { queue, starts, cancels, releases, signals, errors, states };
}

test('FIFO waits for playback completion and ignores duplicate/external-owner events', async () => {
  const { queue, starts, releases } = setup();
  queue.enqueue({ generation_id: 'a' });
  queue.enqueue({ generation_id: 'b' });
  queue.enqueue({ generation_id: 'a' });
  queue.enqueue({ generation_id: 'client', playback_owner: 'client' });
  expect(starts).toEqual(['a']);
  releases.get('a')!(); await flush();
  expect(starts).toEqual(['a', 'b']);
  releases.get('b')!(); await flush();
  queue.enqueue({ generation_id: 'a' });
  expect(starts).toEqual(['a', 'b']);
});

test('batch stop silences active job immediately and removes queued speech', async () => {
  const { queue, starts, signals, states, errors } = setup();
  queue.enqueue({ generation_id: 'a' }); queue.enqueue({ generation_id: 'b' });
  queue.stop(['a', 'b']);
  expect(signals.get('a')!.aborted).toBe(true);
  expect(states.at(-1)).toBe(null);
  await flush();
  expect(starts).toEqual(['a']);
  expect(errors).toEqual([]);
});

test('stop-all cancels inference and a delayed start event cannot resurrect stopped audio', async () => {
  const { queue, starts, cancels } = setup();
  queue.enqueue({ generation_id: 'a' }); queue.enqueue({ generation_id: 'b' });
  queue.stopAll(); await flush();
  expect([...cancels].sort()).toEqual(['a', 'b']);
  queue.stop(['late']); queue.enqueue({ generation_id: 'late' });
  expect(starts).toEqual(['a']);
});

test('queue bounds pending work and rejects overflow without dropping earlier replies', async () => {
  const { queue, starts, cancels, errors } = setup();
  for (let i = 0; i < 18; i++) queue.enqueue({ generation_id: String(i) });
  expect(starts).toEqual(['0']);
  expect(cancels).toEqual(['17']);
  expect(errors.length).toBe(1);
  queue.stopAll(); await flush();
});
