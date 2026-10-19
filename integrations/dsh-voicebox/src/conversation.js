import { UtteranceDetector, audioBase64, openMicrophone } from './capture.js';
import { VOICE_DEFAULTS, SILENCE_MS } from './voice-config.js';
import { isPlaybackEcho } from './echo.js';
import { voiceIntent } from './content.js';
import { diagnosticNow } from './telemetry.js';
import { InputSignal } from './input-signal.js';

export { VOICE_DEFAULTS } from './voice-config.js';

/** One explicit microphone grant, one frozen DSH session, no automatic resend. */
export class VoiceConversation {
  constructor(speaker, form, fetcher, capture = openMicrophone) {
    Object.assign(this, { speaker, form, fetcher, capture });
    this.listeners = new Set();
    this.state = { active: false, phase: 'idle', muted: false, transcript: '', error: '' };
    this.onPageHide = () => this.end();
    this.onVisibility = () => {
      if (!this.state.active) return;
      const blocked = this.backgroundBlocked();
      const visibility = `${globalThis.document?.hidden}:${globalThis.document?.hasFocus?.()}`;
      if (visibility !== this.lastVisibility) {
        this.lastVisibility = visibility;
        this.speaker.trace?.('window.state', { hidden: globalThis.document?.hidden, focused: globalThis.document?.hasFocus?.() });
      }
      if (blocked && this.state.phase === 'capturing') this.discardInput();
      this.microphone?.setMuted?.(this.state.muted || blocked);
      this.refresh();
    };
    globalThis.window?.addEventListener('pagehide', this.onPageHide);
    globalThis.window?.addEventListener('focus', this.onVisibility);
    globalThis.window?.addEventListener('blur', this.onVisibility);
    globalThis.document?.addEventListener('visibilitychange', this.onVisibility);
  }
  getSnapshot = () => this.state;
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  inputPending() { return ['starting', 'capturing', 'transcribing', 'sending'].includes(this.state.phase); }
  update(value) {
    const pending = this.inputPending();
    if (value.phase && value.phase !== this.state.phase) this.speaker.trace?.('input.state', { state: value.phase });
    this.state = { ...this.state, ...value }; for (const fn of this.listeners) fn();
    if (this.contextEpoch && this.state.active && pending !== this.inputPending()) void this.syncContext().catch(error => this.update({ notice: error.message }));
  }
  settings() { return { ...VOICE_DEFAULTS, ...this.form?.getSnapshot().value }; }
  backgroundBlocked() { return !this.settings().backgroundListening && !!(globalThis.document?.hidden || globalThis.document?.hasFocus?.() === false); }
  busy() {
    return !!this.session?.getSnapshot().running || !!this.session?.getSnapshot().awaitingFirstTurn || !!this.session?.getSnapshot().pendingSubmissions?.length
      || ['buffering', 'playing', 'paused'].includes(this.speaker.state.phase);
  }
  generating() {
    const snapshot = this.session?.getSnapshot();
    return !!(snapshot?.running || snapshot?.awaitingFirstTurn || snapshot?.pendingSubmissions?.length);
  }
  canAutoInterrupt() {
    return this.settings().allowInterrupt && (this.state.echoCancellation === true
      || !['playing', 'buffering'].includes(this.speaker.state.phase));
  }
  canTakeFloor() { return this.state.active && this.busy() && !['starting', 'capturing', 'transcribing', 'sending'].includes(this.state.phase) && !this.cancelPending; }
  heard() { return { messageId: this.speaker.state.activeMessageId, turn: this.speaker.state.activeTurn, elapsedMs: this.speaker.state.elapsed }; }
  syncContext(action = 'update') {
    const epoch = this.contextEpoch, id = this.id;
    if (!epoch) return Promise.resolve();
    const playback = this.speaker.delivery?.snapshot() || { recent: '', current: '', completedSteps: [] };
    const send = async () => {
      if (action !== 'end' && (this.contextEpoch !== epoch || !this.state.active)) return;
      const response = await this.fetcher('http://voicebox.invalid/conversation', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ action, session_id: id, epoch, playback, paused: this.speaker.userPaused === true, stopped: this.contextStopped === true, inputPending: this.inputPending() }),
      });
      const data = await response.json();
      if (!response.ok || data.ok !== true) throw new Error(data.error || '无法同步会话语音上下文，请更新 DSH 插件');
      if (this.contextEpoch === epoch && this.state.active) this.update({ plan: data.plan, awaitingAnswer: data.awaitingAnswer === true });
    };
    this.contextFlight = (this.contextFlight || Promise.resolve()).catch(() => {}).then(send);
    return this.contextFlight;
  }
  finishInput() { if (this.state.phase === 'capturing') this.detector?.finish(); }
  publishInputSignal() {
    if (!this.state.active || !this.signal) return;
    let device;
    try { device = this.microphone?.getStatus?.(); } catch { /* Diagnostics cannot interrupt capture. */ }
    const inputSignal = this.signal.snapshot(device);
    this.update({ inputSignal });
    const key = `${inputSignal.state}:${inputSignal.gate}:${inputSignal.contextState}`;
    if (this.signalSamples++ < 30 || key !== this.lastSignalKey) this.speaker.trace?.('input.signal', inputSignal);
    this.lastSignalKey = key;
  }
  beginCandidate() {
    if (this.candidate || !this.busy()) return;
    const candidate = { heard: this.heard(), reference: this.speaker.state.phase === 'playing' ? this.speaker.state.playbackText : '' };
    this.candidate = candidate;
    this.speaker.trace?.('input.candidate');
    candidate.hold = this.speaker.holdPlayback();
  }
  releaseCandidate() {
    const candidate = this.candidate; this.candidate = undefined;
    candidate?.hold?.release();
  }
  discardInput() {
    this.speaker.trace?.('input.discarded');
    this.input?.abort.abort(); this.input = undefined;
    this.detector?.reset(); this.releaseCandidate();
    this.update({ phase: 'listening', confirming: false });
  }
  takeFloor() {
    if (!this.canTakeFloor()) return;
    this.manualFloor = true;
    this.detector?.reset();
    this.coolUntil = Date.now() + 350;
    this.microphone?.setMuted?.(this.backgroundBlocked());
    this.update({ muted: false, phase: 'listening', notice: '已停止回答，请说话', error: '' });
    this.interrupt();
  }
  async start() {
    if (this.state.active) return;
    const id = this.speaker.sessionId;
    if (!id) return;
    const session = this.speaker.ctx.sessions.binding(id).session;
    if (session.getSnapshot().subagent || session.getSnapshot().removed || this.speaker.ctx.sessions.list?.getSnapshot().byId[id]?.origin === 'subagent'
      || typeof session.prompt !== 'function' || typeof session.beginSubmission !== 'function' || typeof session.cancel !== 'function') {
      this.update({ error: '当前会话不支持语音对话，请打开普通聊天会话' }); return;
    }
    const allowed = this.settings().sessionIds;
    if (allowed?.length && !allowed.includes(id)) { this.update({ error: '当前会话不在 Voicebox 白名单中' }); return; }
    const abort = new AbortController(); this.abort = abort; this.session = session; this.id = id;
    const startedBusy = this.busy();
    this.speaker.trace?.('call.start'); this.lastVisibility = undefined;
    this.update({ active: true, phase: 'starting', transcript: '', error: '', notice: '', confirming: false, muted: false, heard: undefined, awaitingAnswer: false });
    // Resume playback directly from this user gesture before awaiting network I/O.
    const unlock = this.speaker.unlock();
    try {
      await unlock;
      const response = await this.fetcher('http://voicebox.invalid/listen/status', { signal: abort.signal });
      const status = await response.json();
      if (!response.ok || !status.ready) throw new Error(status.error || '请先在 Voicebox 下载所选 Whisper 模型');
      abort.signal.throwIfAborted();
      this.contextEpoch = crypto.randomUUID();
      this.contextStopped = false;
      await this.syncContext('start');
      abort.signal.throwIfAborted();
      this.contextHeartbeat = setInterval(() => { void this.syncContext().catch(error => {
        if (!abort.signal.aborted) this.update({ error: error.message });
      }); }, 25_000);
      this.contextHeartbeat.unref?.();
      this.speaker.setVoiceActive(true);
      this.offSettings = this.form?.subscribe(() => this.end());
      this.offSession = session.subscribe(() => {
        if (session.getSnapshot().removed || session.getSnapshot().subagent) this.end();
        else this.refresh();
      });
      this.offSpeaker = this.speaker.subscribe(() => this.refresh());
      this.signal = new InputSignal(); this.signalSamples = 0; this.lastSignalKey = undefined;
      const microphone = await this.capture({ deviceId: this.settings().microphoneId, signal: abort.signal,
        frame: (samples, rate) => this.frame(samples, rate), failed: error => this.fail(error, abort),
      });
      if (abort.signal.aborted) { microphone.close(); return; }
      this.microphone = microphone;
      this.signalTimer = setInterval(() => this.publishInputSignal(), 1000); this.signalTimer.unref?.();
      this.update({ phase: 'listening', echoCancellation: this.microphone.echoCancellation, recognitionModel: status.model || this.settings().recognitionModel });
      this.onVisibility();
      // A fresh idle call has no outgoing answer echo to drain. Once it says
      // listening, accept the first words rather than discarding them for 350 ms.
      if (!startedBusy && !this.busy()) this.coolUntil = undefined;
    } catch (error) { if (!abort.signal.aborted) this.fail(error, abort); }
  }
  refresh() {
    if (!this.state.active) return;
    if (this.speaker.state.phase === 'error' && this.state.phase !== 'starting') {
      this.fail(new Error(this.speaker.state.error || '语音播放失败，请检查 Voicebox 连接和声音档案'), this.abort); return;
    }
    if (['starting', 'transcribing', 'sending', 'capturing'].includes(this.state.phase)) return;
    const phase = this.state.muted ? 'muted' : this.backgroundBlocked() ? 'background' : this.busy() ? 'answering' : 'listening';
    if (phase !== this.state.phase) this.update({ phase });
    if (!this.busy()) this.coolUntil ??= Date.now() + 350;
    else this.coolUntil = undefined;
  }
  frame(samples, sampleRate) {
    if (!this.state.active || this.abort?.signal.aborted) return;
    const settings = this.settings(), busy = this.busy();
    const gate = this.state.muted ? 'muted' : this.backgroundBlocked() ? 'background'
      : ['starting', 'transcribing', 'sending'].includes(this.state.phase) ? this.state.phase
      : busy && !this.manualFloor && !this.candidate && !this.canAutoInterrupt() ? 'busy'
      : this.coolUntil && Date.now() < this.coolUntil ? 'cooldown' : 'open';
    this.signal?.observe(samples, sampleRate, gate);
    if (gate !== 'open') {
      this.detector?.reset();
      if (this.state.phase === 'capturing') { this.discardInput(); this.refresh(); }
      return;
    }
    if (!this.detector || this.detector.sampleRate !== sampleRate) this.detector = new UtteranceDetector({
      sampleRate, silenceMs: SILENCE_MS[settings.patience] || SILENCE_MS.balanced,
      started: () => {
        this.update({ phase: 'capturing', notice: '', error: '' });
        if (!this.manualFloor) this.beginCandidate();
      },
      utterance: bytes => { void this.sendAudio(bytes); },
      quiet: () => { this.releaseCandidate(); this.update({ phase: 'listening' }); this.refresh(); },
    });
    this.detector.startMs = busy && !this.manualFloor ? 450 : 250;
    if (this.detector.active && busy && !this.manualFloor) this.beginCandidate();
    this.detector.push(samples);
  }
  interrupt(heard = this.heard()) {
    if (!this.state.active || !this.busy()) return;
    const abort = this.abort, session = this.session;
    const generating = this.generating();
    this.speaker.stop();
    this.update({ heard });
    this.interrupted = generating;
    if (generating && !this.cancelPending) {
      const pending = Promise.resolve().then(() => session.cancel()).then(result => {
        if (!result.ok) throw new Error(result.error?.message || '停止旧回答失败');
      });
      this.cancelPending = pending;
      void pending.catch(error => { if (!abort.signal.aborted) this.fail(error, abort); }).finally(() => {
        if (this.cancelPending === pending) this.cancelPending = undefined;
      });
    }
  }
  async sendAudio(bytes) {
    const abort = this.abort, session = this.session;
    if (!this.state.active || abort.signal.aborted || this.state.phase === 'transcribing' || this.state.phase === 'sending') return;
    const input = { abort: new AbortController(), candidate: this.candidate };
    this.inputSequence = (this.inputSequence || 0) + 1;
    const started = diagnosticNow(), operation = this.inputSequence;
    this.speaker.trace?.('input.asr-start', { input: operation, bytes: bytes.length });
    this.input = input;
    const signal = AbortSignal.any([abort.signal, input.abort.signal, AbortSignal.timeout(90_000)]);
    const recognitionSignal = input.candidate ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : signal;
    this.update({ phase: 'transcribing', error: '', confirming: !!input.candidate });
    try {
      const response = await this.fetcher('http://voicebox.invalid/listen', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: this.id, audio: audioBase64(bytes) }),
        signal: recognitionSignal,
      });
      const data = await response.json();
      if (response.status !== 200) throw new Error(data.error || data.detail?.message || '语音识别失败');
      if (this.input !== input || abort.signal.aborted || input.abort.signal.aborted) return;
      recognitionSignal.throwIfAborted();
      if (typeof data.text !== 'string' || data.text.length > 10000) throw new Error('语音识别返回了无效文字');
      const text = data.text.trim();
      this.speaker.trace?.('input.asr-ready', { input: operation, durationMs: diagnosticNow() - started });
      // Reuse the state sync already sent when capture began; its semantic wait
      // signal prevents a short answer from being discarded as a backchannel.
      await this.contextFlight;
      signal.throwIfAborted();
      if (this.input !== input) return;
      if (input.candidate && !input.candidate.hold.isCurrent()) {
        this.releaseCandidate(); this.update({ phase: 'listening', notice: '回答已变更，本段插话未发送', confirming: false }); this.refresh(); return;
      }
      if (!text || (input.candidate && isPlaybackEcho(text, input.candidate.reference))) {
        this.speaker.trace?.(text ? 'input.echo' : 'input.empty', { input: operation });
        this.releaseCandidate();
        this.update({ phase: 'listening', confirming: false, notice: input.candidate ? (text ? '已忽略疑似播报回声，保留原回答' : '未识别到新内容，保留原回答') : '' });
        this.refresh(); return;
      }
      const playback = this.speaker.delivery?.snapshot();
      const reference = playback?.current || playback?.recent || this.speaker.state.playbackText || '';
      const intent = voiceIntent(text, { busy: this.busy(), paused: this.speaker.userPaused === true,
        awaitingAnswer: this.state.awaitingAnswer === true || /[？?]\s*$|(?:吗|呢)[。！]?\s*$/u.test(reference) });
      this.speaker.trace?.('input.intent', { input: operation, state: intent.kind });
      if (intent.kind !== 'question' && (intent.kind !== 'resume' || this.speaker.userPaused)) {
        this.releaseCandidate();
        if (intent.kind === 'stop') {
          this.contextStopped = true;
          this.interrupt();
          await this.cancelPending;
          this.speaker.stop();
        } else if (intent.kind === 'pause' || intent.kind === 'resume') {
          await this.speaker.setPaused?.(intent.kind === 'pause');
        }
        this.update({ transcript: text, phase: 'listening', confirming: false,
          notice: intent.kind === 'ack' ? '继续讲解' : intent.kind === 'stop' ? '已停止讲解' : intent.kind === 'pause' ? '播报已暂停，仍在听' : '继续播放' });
        await this.syncContext(); this.refresh(); return;
      }
      input.committed = true;
      this.contextStopped = false;
      if (input.candidate) { this.interrupt(input.candidate.heard); this.releaseCandidate(); }
      this.update({ transcript: text, phase: 'sending', confirming: false });
      await this.cancelPending;
      signal.throwIfAborted();
      if (this.speaker.sessionId !== this.id) return;
      const mode = this.interrupted ? 'steer' : 'queue';
      await this.syncContext();
      signal.throwIfAborted();
      const submission = session.beginSubmission({ text, mode, attachments: [] });
      const submitting = diagnosticNow();
      this.speaker.trace?.('input.submit', { input: operation });
      try {
        const result = await session.prompt([{ type: 'text', text }], mode, signal, submission.requestId);
        if (!result.ok) throw new Error(result.error?.message || 'DSH 未接受语音消息');
        this.speaker.trace?.('input.accepted', { input: operation, durationMs: diagnosticNow() - submitting });
      } catch (error) { submission.abandon(); throw error; }
      abort.signal.throwIfAborted();
      this.interrupted = false; this.manualFloor = false; this.detector?.reset();
      this.update({ phase: 'listening', confirming: false }); this.refresh();
    } catch (error) {
      if (this.input !== input || abort.signal.aborted || input.abort.signal.aborted) return;
      this.speaker.trace?.(this.state.phase === 'transcribing' ? 'input.asr-failed' : 'input.failed', { input: operation, durationMs: diagnosticNow() - started });
      if (input.candidate && !input.committed) {
        this.releaseCandidate(); this.update({ phase: 'listening', confirming: false, notice: '插话未发送，保留原回答', error: error.message || String(error) }); this.refresh();
      } else this.fail(error, abort);
    } finally { if (this.input === input) this.input = undefined; }
  }
  mute() {
    const muted = !this.state.muted;
    if (muted && ['capturing', 'transcribing'].includes(this.state.phase)) this.discardInput();
    else this.detector?.reset();
    this.microphone?.setMuted?.(muted || this.backgroundBlocked());
    this.update({ muted, ...(!['starting', 'transcribing', 'sending'].includes(this.state.phase) ? { phase: 'listening' } : {}) }); this.refresh();
  }
  fail(error, owner) {
    if (this.abort !== owner) return;
    this.end(); this.update({ phase: 'error', error: error.message || String(error) });
  }
  end() {
    const active = this.state.active;
    if (active) this.publishInputSignal();
    clearInterval(this.signalTimer); this.signalTimer = undefined; this.signal = undefined;
    if (active) this.speaker.trace?.('call.end');
    clearInterval(this.contextHeartbeat); this.contextHeartbeat = undefined;
    void this.syncContext('end').catch(() => {}); this.contextEpoch = undefined;
    this.abort?.abort(); this.microphone?.close(); this.microphone = undefined;
    this.offSettings?.(); this.offSession?.(); this.offSpeaker?.();
    this.offSettings = this.offSession = this.offSpeaker = undefined;
    this.detector?.reset(); this.detector = undefined; this.coolUntil = undefined;
    this.input?.abort.abort(); this.input = undefined;
    this.interrupted = false; this.manualFloor = false; this.cancelPending = undefined;
    this.update({ active: false, phase: 'idle', muted: false, confirming: false, plan: undefined, inputSignal: undefined });
    if (active) this.speaker.setVoiceActive(false);
    this.releaseCandidate();
  }
  dispose() {
    this.end(); globalThis.window?.removeEventListener('pagehide', this.onPageHide);
    globalThis.window?.removeEventListener('focus', this.onVisibility); globalThis.window?.removeEventListener('blur', this.onVisibility);
    globalThis.document?.removeEventListener('visibilitychange', this.onVisibility); this.listeners.clear();
  }
}
