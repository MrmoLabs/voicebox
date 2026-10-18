import type { GenerationResponse, HistoryResponse } from '@/lib/api/types';

export function isActiveGeneration(generation: Pick<GenerationResponse, 'status'>) {
  return generation.status === 'loading_model' || generation.status === 'generating';
}

export function isCancelledGeneration(generation: { status: string; error?: string }) {
  return generation.status === 'failed' && generation.error === 'Generation cancelled';
}

// A retried job keeps its ID. Ignore a cached terminal result until this
// observer has received a fresh response for the current attempt.
export function generationSnapshots(
  results: {
    data: GenerationResponse | undefined;
    isFetchedAfterMount: boolean;
  }[],
) {
  return results.flatMap((result) =>
    result.isFetchedAfterMount && result.data ? [result.data] : [],
  );
}

// Refresh existing rows in place as well as appending newly loaded pages.
export function mergeHistoryPage(previous: HistoryResponse[], incoming: HistoryResponse[]) {
  const updates = new Map(incoming.map((item) => [item.id, item]));
  const existing = new Set(previous.map((item) => item.id));
  return [
    ...previous.map((item) => updates.get(item.id) ?? item),
    ...incoming.filter((item) => !existing.has(item.id)),
  ];
}

export function reconcileHistory(previous: HistoryResponse[], updates: GenerationResponse[]) {
  const byId = new Map(updates.map((item) => [item.id, item]));
  return previous.map((item) => {
    const update = byId.get(item.id);
    return update ? { ...item, ...update } : item;
  });
}
