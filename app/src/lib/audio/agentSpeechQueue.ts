export interface AgentSpeechJob {
  generation_id: string;
  stream_audio?: boolean;
  playback_owner?: 'voicebox' | 'client';
}

export interface AgentSpeechState {
  generationId: string;
  playing: boolean;
  elapsedMs: number;
}

interface SpeechQueueOptions {
  play: (job: AgentSpeechJob, signal: AbortSignal, update: (elapsedMs: number) => void) => Promise<void>;
  cancel: (id: string) => Promise<unknown>;
  state: (state: AgentSpeechState | null) => void;
  error: (error: unknown) => void;
}

/** One playback owner, bounded FIFO, and no replay of duplicate SSE events. */
export class AgentSpeechQueue {
  private pending: AgentSpeechJob[] = [];
  private seen = new Set<string>();
  private current: { job: AgentSpeechJob; controller: AbortController } | null = null;

  constructor(private options: SpeechQueueOptions) {}

  enqueue(job: AgentSpeechJob) {
    if (job.playback_owner === 'client' || this.seen.has(job.generation_id)) return;
    this.seen.add(job.generation_id);
    if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!);
    if (this.pending.length >= 16) {
      this.cancel(job.generation_id);
      this.options.error(new Error('Speech queue is full'));
      return;
    }
    this.pending.push(job);
    this.advance();
  }

  stop(ids: string[], cancelGeneration = false) {
    const targets = new Set(ids);
    for (const id of targets) this.seen.add(id);
    while (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!);
    this.pending = this.pending.filter((job) => !targets.has(job.generation_id));
    if (this.current && targets.has(this.current.job.generation_id)) {
      this.current.controller.abort();
      this.options.state(null);
    }
    if (cancelGeneration) for (const id of targets) this.cancel(id);
  }

  stopAll() {
    const ids = this.pending.map((job) => job.generation_id);
    if (this.current) ids.push(this.current.job.generation_id);
    this.stop(ids, true);
  }

  private cancel(id: string) {
    void this.options.cancel(id).catch(() => {});
  }

  private advance() {
    if (this.current) return;
    const job = this.pending.shift();
    if (!job) return;
    const current = { job, controller: new AbortController() };
    this.current = current;
    this.options.state({ generationId: job.generation_id, playing: false, elapsedMs: 0 });
    void this.options.play(job, current.controller.signal, (elapsedMs) => {
      if (!current.controller.signal.aborted) {
        this.options.state({ generationId: job.generation_id, playing: true, elapsedMs });
      }
    }).catch((error) => {
      if (!current.controller.signal.aborted) {
        this.cancel(job.generation_id);
        this.options.error(error);
      }
    }).finally(() => {
      if (this.current !== current) return;
      this.current = null;
      this.options.state(null);
      this.advance();
    });
  }
}
