import { SpeechBridge, spokenText } from './bridge.js';
import { LiveNarration } from './live.js';
import { DeliveryLedger } from './delivery.js';
import { VoiceDiagnostics } from './telemetry.js';

/** Consume only new durable deltas; restored history is available for manual read. */
export class ReplyObserver {
  constructor(onEvent, onReply, onReset, onLive = () => {}) {
    this.onEvent = onEvent;
    this.onReply = onReply;
    this.onReset = onReset;
    this.onLive = onLive;
    this.turns = new Map();
    this.revision = undefined;
  }
  accept(snapshot, initial = false) {
    if (snapshot.revision === this.revision) return;
    this.revision = snapshot.revision;
    const change = snapshot.change;
    const baseline = initial || change.kind === 'replace';
    if (baseline) { this.turns.clear(); this.onReset(); }
    if (change.kind === 'prepend' && !initial) return;
    // DSH 0.2 also removes retained transient rows AFTER publishing a successful
    // durable message. The live reader decides whether this was abandonment.
    if (!baseline && change.kind === 'settle-assistant' && !change.entry) this.onLive({ type: 'assistant/retired', data: { attemptId: change.attemptId } });
    const entries = baseline ? snapshot.entries : change.kind === 'settle-assistant' ? (change.entry ? [change.entry] : []) : change.entries;
    for (const entry of entries || []) {
      if (entry.type !== 'event') { if (!baseline && entry.type === 'transient') this.onLive(entry.event); continue; }
      const event = entry.event;
      if (event.type === 'turn/start') this.turns.set(event.data.turn, {});
      if (event.type === 'assistant/message') {
        const turn = this.turns.get(event.data.turn);
        if (turn) turn.reply = event.data.interrupted ? undefined : spokenText((event.data.message?.content || [])
          .filter((block) => block.type === 'text').map((block) => block.text).join('\n'));
      }
      if (event.type === 'turn/end') {
        const turn = this.turns.get(event.data.turn);
        if (event.data.reason?.kind === 'completed' && turn?.reply) this.onReply(turn.reply);
        this.turns.delete(event.data.turn);
      }
      if (!baseline) this.onEvent(event);
    }
  }
}

export function speechFetch(input, init) {
  const url = new URL(String(input));
  const path = `/api/voicebox?path=${encodeURIComponent(url.pathname)}`;
  const send = globalThis.__DSH_TRANSPORT__?.fetch || globalThis.fetch.bind(globalThis);
  return send(path, init);
}

export class DesktopSpeechController {
  constructor(ctx, play, form) {
    this.ctx = ctx;
    this.play = play;
    this.listeners = new Set();
    this.playbackHolds = new Set();
    this.audioEpoch = 0;
    this.delivery = new DeliveryLedger();
    this.diagnostics = new VoiceDiagnostics();
    this.playSequence = 0;
    this.state = { enabled: false, voiceActive: false, phase: 'idle', elapsed: 0, latest: '', activeMessageId: undefined, error: '' };
    this.messages = new Map();
    this.readingMode = form?.getSnapshot().value?.readingMode || 'complete';
    this.recordSettings = () => this.trace('settings.runtime', {
      modelSize: '0.6B', speechMode: 'realtime', readingMode: this.readingMode, recognitionModel: 'turbo',
      patience: 'balanced', allowInterrupt: false, backgroundListening: true, ...form?.getSnapshot().value,
    });
    this.recordSettings();
    this.offSettings = form?.subscribe(() => {
      const mode = form.getSnapshot().value?.readingMode || 'complete';
      if (mode !== this.readingMode) { this.stop(); this.readingMode = mode; }
      this.recordSettings();
    });
    this.bridge = new SpeechBridge({ endpoint: 'http://voicebox.invalid', playbackOwner: 'client', voiceContinuation: () => this.state.voiceActive }, {
      fetch: speechFetch,
      trace: (event, values) => this.trace(event, values),
      warn: (error) => this.update({ phase: 'error', error }),
      onInterrupt: () => this.silence(),
      onPreparing: (activeMessageId) => this.update({ activeMessageId, phase: 'buffering', error: '', elapsed: 0 }),
      onSpeech: (generation) => { void this.playGeneration(generation); },
    });
    this.live = new LiveNarration(this.bridge, {
      play: generation => this.playGeneration(generation, true),
      update: values => this.update({ ...values, ...(this.userPaused && values.phase === 'buffering' ? { phase: 'paused' } : {}) }),
      failed: values => this.update(values),
      voiceMode: () => this.state.voiceActive,
      trace: (event, values) => this.trace(event, values),
      delivery: {
        enqueue: item => this.delivery.enqueue(item),
        playing: id => this.delivery.playing(id),
        played: id => { this.delivery.played(id); void this.conversation?.syncContext?.().catch(() => {}); },
        seal: (turn, step) => { this.delivery.seal(turn, step); void this.conversation?.syncContext?.().catch(() => {}); },
      },
    });
  }
  getSnapshot = () => this.state;
  trace(event, values) { this.diagnostics.record(event, values); }
  subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  playbackPaused() { return this.userPaused || this.playbackHolds.size > 0; }
  update(values) {
    if (this.playbackPaused() && ['buffering', 'playing'].includes(values.phase)) values = { ...values, phase: 'paused' };
    if (values.phase && values.phase !== this.state.phase) this.trace('speaker.state', { state: values.phase });
    if (values.waitingForText !== undefined && values.waitingForText !== this.state.waitingForText) this.trace('text.wait', { waiting: values.waitingForText });
    this.state = { ...this.state, ...values }; for (const listener of this.listeners) listener();
  }
  select(id) {
    const list = this.ctx.sessions.list.getSnapshot();
    if (id === this.sessionId) return;
    this.trace('session.changed');
    this.conversation?.end();
    this.stop();
    this.offEvents?.(); this.offSession?.();
    this.sessionId = id;
    this.delivery.reset();
    this.messages.clear();
    this.update({ latest: '', enabled: id ? localStorage.getItem(`dsh-voicebox:${id}`) === 'on' : false });
    if (!id) return;
    const binding = this.ctx.sessions.binding(id);
    const origin = list.byId[id]?.origin;
    const session = { id, header: { origin } };
    const handleAuto = (event) => {
      // The selected session keeps narrating when Desktop loses focus or is minimized.
      // Dropping background deltas would also break the streaming sentence cursor.
      if ((this.state.enabled || this.state.voiceActive) && !binding.session.getSnapshot().subagent) {
        if (event.type === 'turn/start') this.trace('turn.start');
        if (event.type === 'turn/end') this.trace('turn.end');
        if (this.readingMode === 'streaming' || this.state.voiceActive) this.live.handle(session, event);
        else this.bridge.handle(session, event);
      }
    };
    const observer = new ReplyObserver(handleAuto, (latest) => this.update({ latest }), () => {
      this.conversation?.end();
      this.stop();
      this.update({ latest: '' });
    }, event => { if (this.readingMode === 'streaming' || this.state.voiceActive) handleAuto(event); });
    const accept = (initial = false) => {
      const snapshot = binding.eventSource.getSnapshot();
      const change = snapshot.change;
      if (initial || change.kind === 'replace') this.messages.clear();
      const entries = initial || change.kind === 'replace' ? snapshot.entries
        : change.kind === 'settle-assistant' ? (change.entry ? [change.entry] : []) : change.entries;
      let changed = false;
      for (const entry of entries || []) {
        const event = entry.event;
        if (entry.type !== 'event' || event.type !== 'assistant/message' || !event.data.message?.id) continue;
        const text = event.data.interrupted ? '' : spokenText((event.data.message.content || [])
          .filter((block) => block.type === 'text').map((block) => block.text).join('\n'));
        this.messages.set(event.data.message.id, text);
        changed = true;
      }
      observer.accept(snapshot, initial);
      if (changed) this.update({});
    };
    accept(true);
    this.offEvents = binding.eventSource.subscribe(() => accept());
    this.offSession = binding.session.subscribe(() => {
      if (binding.session.getSnapshot().pendingSubmissions.length) this.stop();
    });
  }
  unlock() {
    this.audio ??= new AudioContext();
    const context = this.audio;
    return context.resume().then(() => { if (this.audio === context) this.audioUnlocked = true; });
  }
  toggle() {
    const enabled = !this.state.enabled;
    if (enabled) void this.unlock().catch((error) => this.update({ phase: 'error', error: error.message }));
    else this.stop();
    localStorage.setItem(`dsh-voicebox:${this.sessionId}`, enabled ? 'on' : 'off');
    this.update({ enabled });
  }
  messageText(messageId) { return this.messages.get(messageId) || ''; }
  setVoiceActive(active) { this.stop(); this.update({ voiceActive: active }); }
  read(messageId) {
    const text = messageId === undefined ? this.state.latest : this.messageText(messageId);
    if (!this.sessionId || !text) return;
    void this.unlock().catch((error) => this.update({ phase: 'error', error: error.message }));
    this.stop();
    this.bridge.active = this.sessionId;
    this.update({ activeMessageId: messageId, phase: 'buffering', error: '', elapsed: 0 });
    this.bridge.track(this.bridge.speak(this.sessionId, `manual:${crypto.randomUUID()}`, text, this.bridge.epochs.get(this.sessionId)));
  }
  silence() {
    if (['buffering', 'playing', 'paused'].includes(this.state.phase)) this.trace('play.cancel');
    this.delivery.interrupt();
    this.audioEpoch++;
    this.live?.reset();
    this.playAbort?.abort(); this.playAbort = undefined;
    this.userPaused = false;
    this.playbackHolds.clear();
    this.update({ activeMessageId: undefined, activeTurn: undefined, playbackText: '', inputHeld: false, live: false, waitingForText: false, phase: 'idle', elapsed: 0, error: '' });
  }
  stop() {
    this.silence();
    if (this.bridge.active) this.bridge.forget(this.bridge.active);
    this.bridge.turns.clear();
  }
  async playGeneration(generation, continuation = false) {
    this.playAbort?.abort();
    const abort = new AbortController();
    this.playAbort = abort;
    const piece = ++this.playSequence;
    this.trace('play.request', { piece });
    const offset = continuation ? this.state.elapsed : 0;
    this.hasPlaybackProgress = false;
    this.update({ phase: this.playbackPaused() ? 'paused' : 'buffering', waitingForText: false, playbackText: generation.text || '' });
    try {
      this.audio ??= new AudioContext();
      // A paused reply suspends the shared context. The next reply starts
      // afresh after prior nodes have been stopped, using the existing grant.
      await this.syncPlaybackPause();
      if (abort.signal.aborted) return;
      if (this.audio.state !== 'running' && !this.playbackPaused()) throw new Error('请点击回复下方的“朗读”启用音频播放');
      await this.play({ generation_id: generation.id, stream_audio: true }, 'http://voicebox.invalid', abort.signal,
        (elapsed, buffering = false) => { if (!abort.signal.aborted) { this.hasPlaybackProgress = true; this.update({ elapsed: offset + elapsed, phase: this.audio.state === 'suspended' ? 'paused' : buffering ? 'buffering' : 'playing' }); } },
        { fetch: speechFetch, context: this.audio, resume: false, initialBufferSeconds: continuation && offset > 0 ? 0.04 : 0.8,
          trace: event => this.trace(`pcm.${event.kind}`, { ...event, piece }) });
      if (!abort.signal.aborted && !continuation) this.update({ activeMessageId: undefined, phase: 'idle', elapsed: 0 });
    } catch (error) {
      if (!abort.signal.aborted) {
        if (continuation) throw error;
        const activeMessageId = this.state.activeMessageId;
        if (this.bridge.active) this.bridge.interrupt(this.bridge.active);
        this.update({ activeMessageId, phase: 'error', error: error.message || String(error) });
      }
    }
  }
  pause() {
    if (!this.audio || !this.playAbort || this.playAbort.signal.aborted || this.playbackHolds.size) return;
    void this.setPaused(!this.userPaused);
  }
  async setPaused(paused) {
    if (paused !== this.userPaused) this.trace('play.pause', { paused });
    this.userPaused = paused;
    await this.syncPlaybackPause();
    await this.conversation?.syncContext?.().catch(error => this.update({ notice: error.message }));
  }
  // A temporary input hold preserves scheduled nodes and the user's own pause.
  // Stop invalidates the lease, so a late ASR result cannot resume a new reply.
  holdPlayback() {
    const lease = Symbol('voice input');
    this.playbackHolds.add(lease);
    this.trace('play.hold');
    this.update({ inputHeld: true });
    void this.syncPlaybackPause();
    return {
      isCurrent: () => this.playbackHolds.has(lease),
      release: () => {
        if (!this.playbackHolds.delete(lease)) return;
        this.trace('play.release');
        this.update({ inputHeld: this.playbackHolds.size > 0 });
        void this.syncPlaybackPause();
      },
    };
  }
  syncPlaybackPause() {
    const context = this.audio, epoch = this.audioEpoch;
    this.audioTransition = (this.audioTransition || Promise.resolve()).then(async () => {
      if (!context || this.audio !== context || epoch !== this.audioEpoch || context.state === 'closed') return;
      const owner = this.playAbort;
      if (this.playbackPaused()) await context.suspend();
      else if (owner && !owner.signal.aborted && this.audioUnlocked) await context.resume();
      if (epoch === this.audioEpoch && owner && this.playAbort === owner && !owner.signal.aborted) {
        this.update({ phase: this.playbackPaused() ? 'paused' : this.state.waitingForText || !this.hasPlaybackProgress ? 'buffering' : 'playing' });
      }
    }).catch(error => { if (epoch === this.audioEpoch) this.update({ phase: 'error', error: error.message || String(error) }); });
    return this.audioTransition;
  }
  async dispose() {
    this.conversation?.dispose();
    this.stop(); this.offEvents?.(); this.offSession?.(); this.offSettings?.();
    await this.bridge.dispose();
    await this.audio?.close();
    this.listeners.clear();
    this.diagnostics.dispose();
  }
}
