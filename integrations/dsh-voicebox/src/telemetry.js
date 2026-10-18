const EVENTS = new Set([
  'settings.runtime', 'call.start', 'call.end', 'session.changed', 'turn.start', 'turn.end', 'text.first', 'text.queued', 'text.wait',
  'speaker.state', 'play.pause', 'play.cancel', 'play.request', 'play.hold', 'play.release',
  'speech.request', 'speech.ready', 'speech.failed', 'speech.cancel', 'speech.cancelled', 'speech.cancel-failed',
  'pcm.first', 'pcm.started', 'pcm.underrun', 'pcm.completed', 'pcm.aborted', 'pcm.failed',
  'input.state', 'input.candidate', 'input.discarded', 'input.asr-start', 'input.asr-ready', 'input.asr-failed',
  'input.empty', 'input.echo', 'input.intent', 'input.submit', 'input.accepted', 'input.failed', 'window.state',
]);
const NUMBERS = ['request', 'piece', 'input', 'durationMs', 'afterMs', 'audioMs', 'sampleRate', 'gapMs', 'refillMs', 'bytes', 'characters', 'parts'];
const BOOLEANS = ['waiting', 'paused', 'hidden', 'focused', 'aborted'];
const STATES = {
  'speaker.state': ['idle', 'buffering', 'playing', 'paused', 'error'],
  'input.state': ['idle', 'starting', 'listening', 'capturing', 'transcribing', 'sending', 'answering', 'muted', 'background', 'error'],
  'input.intent': ['ack', 'pause', 'resume', 'stop', 'question'],
  'pcm.failed': ['connect', 'read', 'decode', 'schedule', 'drain'],
};
const SETTINGS = { modelSize: ['0.6B', '1.7B'], speechMode: ['realtime', 'checked'], readingMode: ['complete', 'streaming'],
  recognitionModel: ['base', 'small', 'medium', 'large', 'turbo'], patience: ['fast', 'balanced', 'patient'] };

export const diagnosticNow = () => globalThis.performance?.now() ?? Date.now();

/** Bounded, memory-only event metadata. No free-form strings or user identities. */
export class VoiceDiagnostics {
  constructor({ clock = diagnosticNow, limit = 512 } = {}) {
    this.clock = clock;
    this.limit = Math.max(1, Math.min(2048, Math.floor(limit) || 512));
    this.clear();
  }
  clear() { this.events = []; this.counts = {}; this.dropped = 0; this.sequence = 0; this.origin = this.clock(); this.lastMs = 0; }
  record(event, values = {}) {
    if (this.closed || !EVENTS.has(event)) return;
    const elapsed = this.clock() - this.origin;
    const ms = Math.max(this.lastMs, Number.isFinite(elapsed) ? Math.round(elapsed) : 0);
    this.lastMs = ms;
    const entry = { seq: ++this.sequence, ms, event };
    for (const field of NUMBERS) {
      const value = values[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9) entry[field] = Math.round(value * 10) / 10;
    }
    for (const field of BOOLEANS) if (typeof values[field] === 'boolean') entry[field] = values[field];
    if (STATES[event]?.includes(values.state)) entry.state = values.state;
    if (event === 'settings.runtime') {
      for (const [key, choices] of Object.entries(SETTINGS)) if (choices.includes(values[key])) entry[key] = values[key];
      for (const key of ['allowInterrupt', 'backgroundListening']) if (typeof values[key] === 'boolean') entry[key] = values[key];
    }
    this.counts[event] = (this.counts[event] || 0) + 1;
    this.events.push(entry);
    if (this.events.length > this.limit) { this.events.shift(); this.dropped++; }
  }
  snapshot() {
    return { format: 'dsh-voicebox-diagnostics', version: 1,
      scope: 'Window memory; relative milliseconds; independent local request/piece/input counters. No audio, text, session/profile/generation IDs, endpoints or device names. PCM timing does not measure speaker sound.',
      retained: this.events.length, dropped: this.dropped, counts: { ...this.counts }, events: this.events.map(event => ({ ...event })) };
  }
  dispose() { this.closed = true; this.clear(); }
}
