// Read the next job through the same authenticated host transport while the
// preceding job plays. No AudioContext, new synthesis request or playback receipt.
function bufferedAudio(fetcher, id, highWaterMark) {
  const abort = new AbortController();
  let reader, finished = false, offSignal = () => {};
  const stop = reason => {
    abort.abort(reason); offSignal(); offSignal = () => {};
    if (reader) {
      void reader.cancel(reason).catch(() => {});
      try { reader.releaseLock(); } catch { /* A pending read will reject on abort. */ }
      reader = undefined;
    }
  };
  const source = Promise.resolve().then(async () => {
    abort.signal.throwIfAborted();
    const response = await fetcher(`http://voicebox.invalid/generate/${encodeURIComponent(id)}/live`, { signal: abort.signal });
    if (abort.signal.aborted || !response.ok || !response.body) {
      void response.body?.cancel().catch(() => {});
      abort.signal.throwIfAborted();
      throw new Error(`Live speech is unavailable (HTTP ${response.status})`);
    }
    return response;
  });
  // Cancellation can precede the first pull. Future errors belong to the next
  // piece, so they must never reject an unobserved Promise during current audio.
  void source.catch(() => {});
  const body = new ReadableStream({
    async pull(controller) {
      try {
        if (!reader) {
          const response = await source;
          abort.signal.throwIfAborted();
          reader = response.body.getReader();
        }
        const result = await reader.read();
        abort.signal.throwIfAborted();
        if (result.done) {
          finished = true; reader.releaseLock(); reader = undefined;
          offSignal(); offSignal = () => {}; controller.close();
        } else controller.enqueue(result.value);
      } catch (error) { finished = true; stop(error); controller.error(error); }
    },
    cancel: reason => stop(reason),
  }, new ByteLengthQueuingStrategy({ highWaterMark }));
  return {
    body,
    bind(signal) {
      if (!signal || finished) return;
      const cancel = () => stop(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      offSignal = () => signal.removeEventListener('abort', cancel);
    },
    dispose(reason) { stop(reason); void body.cancel(reason).catch(() => {}); },
  };
}

/** At most the current handoff and one future stream, 256 KiB per queue.
 * Streams backpressure the carrier; one carrier chunk may exceed the watermark.
 */
export class SpeechReadAhead {
  constructor(fetcher) { this.fetcher = fetcher; this.entries = new Map(); }
  prepare(generation) {
    const id = generation?.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(id) || this.entries.has(id) || this.entries.size >= 2) return;
    this.entries.set(id, bufferedAudio(this.fetcher, id, 256 * 1024));
  }
  fetch = (input, init = {}) => {
    const match = new URL(String(input)).pathname.match(/^\/generate\/([A-Za-z0-9_-]+)\/live$/u);
    const entry = (!init.method || init.method === 'GET') && this.entries.get(match?.[1]);
    if (!entry) return this.fetcher(input, init);
    this.entries.delete(match[1]);
    if (init.signal?.aborted) { entry.dispose(init.signal.reason); return Promise.reject(init.signal.reason); }
    entry.bind(init.signal);
    return Promise.resolve(new Response(entry.body, { headers: { 'content-type': 'application/octet-stream' } }));
  };
  clear() { for (const entry of this.entries.values()) entry.dispose(); this.entries.clear(); }
}
