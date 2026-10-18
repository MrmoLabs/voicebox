import { expect, test } from 'bun:test';
import { QueryClient, QueryObserver } from '../../app/node_modules/@tanstack/react-query';
import type { GenerationResponse, HistoryResponse } from '../../app/src/lib/api/types';
import {
  generationSnapshots,
  isActiveGeneration,
  isCancelledGeneration,
  mergeHistoryPage,
  reconcileHistory,
} from '../../app/src/lib/utils/history';

const row = (id: string, status: GenerationResponse['status']): HistoryResponse => ({
  id,
  status,
  profile_id: 'voice',
  profile_name: 'My voice',
  text: id,
  language: 'zh',
  created_at: '2026-10-17T00:00:00',
  duration: 0,
});

test('refreshing a later page updates existing status and keeps earlier rows and order', () => {
  const rows = mergeHistoryPage(
    [row('first', 'completed'), row('second', 'generating')],
    [row('second', 'failed'), row('third', 'completed')],
  );
  expect(rows.map(({ id, status }) => [id, status])).toEqual([
    ['first', 'completed'],
    ['second', 'failed'],
    ['third', 'completed'],
  ]);
});

test('external generation completion reconciles an earlier page without losing voice metadata', () => {
  const pending = row('rest-job', 'generating');
  const { profile_name: _, ...snapshot } = pending;
  const history = reconcileHistory(
    [pending, row('older', 'completed')],
    [{ ...snapshot, status: 'completed', audio_path: 'result.wav', duration: 4.2 }],
  );
  expect(history[0]).toMatchObject({
    status: 'completed',
    profile_name: 'My voice',
    duration: 4.2,
  });
  expect(history.filter(isActiveGeneration)).toEqual([]);
  expect(history[1].id).toBe('older');
});

test('cancelled and still-running snapshots retain their authoritative status', () => {
  const history = reconcileHistory(
    [row('cancelled', 'loading_model'), row('running', 'generating')],
    [{ ...row('cancelled', 'failed'), error: 'Generation cancelled' }],
  );
  expect(history[0].error).toBe('Generation cancelled');
  expect(isCancelledGeneration(history[0])).toBe(true);
  expect(isCancelledGeneration({ status: 'failed', error: 'CUDA out of memory' })).toBe(false);
  expect(history.filter(isActiveGeneration).map(({ id }) => id)).toEqual(['running']);
});

test('retrying the same ID ignores its cached failure until a fresh response arrives', async () => {
  const client = new QueryClient();
  const key = ['history', 'retry-job'];
  client.setQueryData(key, row('retry-job', 'failed'));
  let resolve!: (value: HistoryResponse) => void;
  const response = new Promise<HistoryResponse>((done) => {
    resolve = done;
  });
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: () => response,
    staleTime: 0,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    expect(generationSnapshots([observer.getCurrentResult()])).toEqual([]);
    const fresh = observer.refetch();
    resolve(row('retry-job', 'generating'));
    await fresh;
    const snapshots = generationSnapshots([observer.getCurrentResult()]);
    expect(snapshots.map(({ status }) => status)).toEqual(['generating']);
    expect(reconcileHistory([row('retry-job', 'generating')], snapshots)[0].status).toBe(
      'generating',
    );
  } finally {
    unsubscribe();
    client.clear();
  }
});
