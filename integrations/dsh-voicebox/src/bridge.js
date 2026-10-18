import { supportsSpeech } from './diagnostics.js';

/** Convert already-selected assistant text, never reasoning/tool blocks. */
export function spokenText(text) {
  let fence;
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/).filter((line) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return false;
    }
    return !fence && !/^\s*\|/.test(line) && !/^\s*(?:[-*_]\s*){3,}$/.test(line);
  }).join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s<>]+/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
}

export class SpeechBridge {
  constructor(config = {}, { fetch: fetcher = globalThis.fetch, warn = console.warn, onSpeech, onInterrupt, onPreparing } = {}) {
    const endpoint = new URL(config.endpoint || 'http://127.0.0.1:17493');
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new Error('Voicebox endpoint must be an HTTP(S) URL without credentials');
    }
    this.endpoint = endpoint.href.replace(/\/$/, '');
    this.clientId = config.clientId || 'dsh-voicebox';
    this.config = config;
    this.fetcher = fetcher;
    this.warn = warn;
    this.onSpeech = onSpeech;
    this.onInterrupt = onInterrupt;
    this.onPreparing = onPreparing;
    this.turns = new Map();
    this.epochs = new Map();
    this.barriers = new Map();
    this.tasks = new Set();
    this.active = undefined;
    this.disposed = false;
    this.capabilities = undefined;
  }

  handle(session, event) {
    if (this.disposed || session.header?.origin === 'subagent' || session.header?.delegationDepth > 0) return;
    if (this.config.sessionIds?.length && !this.config.sessionIds.includes(session.id)) return;
    // firstLiveSeq excludes inherited/restored history and synthetic seed closers.
    if (event.seq < (session.firstLiveSeq ?? 0)) return;
    if (event.type === 'turn/start') {
      this.turns.set(session.id, { turn: event.data.turn, human: false });
      if (this.active === session.id) this.interrupt(session.id);
      return;
    }
    const turn = this.turns.get(session.id);
    if (!turn) return;
    const voiceContinuation = event.data.source?.kind === 'dsh-voicebox' && this.config.voiceContinuation?.();
    if (event.type === 'user/message' && (event.data.source?.kind === 'user' || voiceContinuation)) {
      // A next-step notice shares the current queue; a resumed, new turn owns a
      // fresh queue only after the old playback has drained.
      if (voiceContinuation && turn.human) return;
      if (this.active && this.active !== session.id) this.interrupt(this.active);
      this.active = session.id;
      this.interrupt(session.id);
      turn.human = true;
      turn.message = undefined;
    } else if (event.type === 'assistant/message' && event.data.turn === turn.turn) {
      // Keep the final step only. Earlier commentary and tool-call steps are
      // never concatenated into the final answer.
      turn.message = event.data.interrupted ? undefined : {
        id: event.data.message?.id,
        seq: event.seq,
        text: spokenText((event.data.message?.content || [])
          .filter((block) => block.type === 'text').map((block) => block.text).join('\n')),
      };
    } else if (event.type === 'turn/end' && event.data.turn === turn.turn) {
      this.turns.delete(session.id);
      if (event.data.reason?.kind !== 'completed' || !turn.human || !turn.message?.text || this.active !== session.id) return;
      const epoch = this.epochs.get(session.id);
      const requestId = `${turn.turn}:${turn.message.seq}`;
      this.onPreparing?.(turn.message.id);
      this.track(this.speak(session.id, requestId, turn.message.text, epoch));
    }
  }

  track(task) {
    this.tasks.add(task);
    void task.catch((error) => this.warn(error.message || String(error))).finally(() => this.tasks.delete(task));
  }

  interrupt(sessionId) {
    this.onInterrupt?.();
    this.epochs.set(sessionId, (this.epochs.get(sessionId) || 0) + 1);
    const pending = this.post('/speak/cancel', { session_id: sessionId });
    this.barriers.set(sessionId, Promise.allSettled([this.barriers.get(sessionId), pending]));
    this.track(pending);
  }

  async request(path, init = {}) {
    const response = await this.fetcher(`${this.endpoint}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-Voicebox-Client-Id': this.clientId },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Voicebox ${path}: HTTP ${response.status} ${await response.text()}`);
    return response.json();
  }

  post(path, body) {
    return this.request(path, { method: 'POST', body: JSON.stringify(body) });
  }

  async checkCapabilities() {
    this.capabilities ??= this.request('/openapi.json').then((schema) => {
      if (!supportsSpeech(schema)) {
        throw new Error('Update the Voicebox backend and desktop app to the dsh integration build first');
      }
    }).catch((error) => { this.capabilities = undefined; throw error; });
    return this.capabilities;
  }

  async speak(sessionId, requestId, text, epoch, { notify = true } = {}) {
    await this.barriers.get(sessionId);
    await this.checkCapabilities();
    if (this.disposed || this.epochs.get(sessionId) !== epoch || this.active !== sessionId) return;
    if (text.length > 10000) throw new Error('Reply exceeds the 10000-character speech limit; auto-reading skipped');
    try {
      const result = await this.post('/speak', {
        text, session_id: sessionId, request_id: requestId,
        profile: this.config.profile || undefined,
        language: this.config.language || undefined,
        engine: this.config.streamAudio === false ? undefined : 'qwen',
        model_size: this.config.modelSize || '0.6B',
        personality: false,
        stream_audio: this.config.streamAudio !== false,
        preview_mode: this.config.speechMode || 'realtime',
        playback_owner: this.config.playbackOwner || 'voicebox',
      });
      if (!this.disposed && this.epochs.get(sessionId) === epoch && this.active === sessionId) {
        if (notify) this.onSpeech?.(result);
        return result;
      }
    } catch (error) {
      // A timeout can hide a successful POST. Cancel by stable request id;
      // never issue an unkeyed retry that might create duplicate speech.
      await this.post('/speak/cancel', { session_id: sessionId, request_id: requestId }).catch(() => {});
      throw error;
    }
    if (this.disposed || this.epochs.get(sessionId) !== epoch || this.active !== sessionId) {
      await this.post('/speak/cancel', { session_id: sessionId, request_id: requestId });
    }
  }

  forget(sessionId) {
    this.turns.delete(sessionId);
    if (this.active === sessionId) { this.interrupt(sessionId); this.active = undefined; }
  }

  async idle() {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }

  async dispose() {
    if (this.disposed) { await this.idle(); return; }
    this.disposed = true;
    if (this.active) this.interrupt(this.active);
    await this.idle();
    this.turns.clear();
    this.epochs.clear();
    this.barriers.clear();
  }
}
