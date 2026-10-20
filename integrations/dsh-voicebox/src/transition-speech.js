import { PcmPacketDecoder } from '../../../app/src/lib/audio/pcmPackets.ts';

export const TRANSITION_TEXT = { initial: '我想想。', gap: '嗯……' };
const STORAGE = 'dsh-voicebox:transition-clips:v1';
const MAX_SECONDS = 4;

export function transitionKey(settings) {
  return JSON.stringify(['v1', settings.endpoint, settings.clientId, settings.profile, settings.modelSize, settings.language]);
}
function validClip(clip) {
  return clip && Number.isInteger(clip.rate) && clip.rate >= 8000 && clip.rate <= 48000 && clip.samples instanceof Float32Array
    && clip.samples.length >= clip.rate * .1 && clip.samples.length <= clip.rate * MAX_SECONDS
    && clip.samples.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 1.1)
    && clip.samples.some(sample => Math.abs(sample) > .001);
}
function savedClip(key, kind) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE));
    if (saved?.key !== key || !saved[kind] || saved[kind].data.length > 1_024_000) return;
    const binary = atob(saved[kind].data), bytes = Uint8Array.from(binary, value => value.charCodeAt(0));
    if (bytes.length % 4) return;
    const clip = { rate: saved[kind].rate, samples: new Float32Array(bytes.buffer) };
    if (validClip(clip)) return clip;
  } catch { /* Optional local cache must not block a voice conversation. */ }
}
function saveClip(key, kind, clip) {
  try {
    let saved = JSON.parse(localStorage.getItem(STORAGE));
    if (saved?.key !== key) saved = { key };
    const bytes = new Uint8Array(clip.samples.buffer, clip.samples.byteOffset, clip.samples.byteLength);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    saved[kind] = { rate: clip.rate, data: btoa(binary) };
    localStorage.setItem(STORAGE, JSON.stringify(saved));
  } catch { /* Quota, privacy mode and non-browser hosts simply use memory. */ }
}

/** Only called while the voice session is idle, never as a buffering fallback. */
export async function loadTransition(kind, key, sessionId, fetcher, signal, persist = true) {
  if (!Object.hasOwn(TRANSITION_TEXT, kind)) throw new Error('Unknown transition clip');
  const cached = persist && savedClip(key, kind);
  if (cached) return cached;
  const requestId = `transition:${kind}:${crypto.randomUUID()}`;
  const identity = { session_id: sessionId, request_id: requestId };
  let reader, complete = false;
  const abortRead = () => { void reader?.cancel().catch(() => {}); };
  try {
    const response = await fetcher('http://voicebox.invalid/speak', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...identity, text: TRANSITION_TEXT[kind] }) });
    if (!response.ok) throw new Error('Transition speech unavailable');
    const generation = await response.json(); signal.throwIfAborted();
    if (typeof generation.id !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(generation.id)) throw new Error('Invalid transition generation');
    const stream = await fetcher(`http://voicebox.invalid/generate/${encodeURIComponent(generation.id)}/live`, { signal });
    if (!stream.ok || !stream.body) throw new Error('Transition audio unavailable');
    reader = stream.body.getReader();
    signal.addEventListener('abort', abortRead, { once: true });
    const decoder = new PcmPacketDecoder(), parts = [];
    let rate = 0, count = 0, bytes = 0;
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length; if (bytes > 1_024_000) throw new Error('Transition audio is too large');
      for (const packet of decoder.push(value)) {
        if (rate && rate !== packet.sampleRate) throw new Error('Transition audio rate changed');
        rate = packet.sampleRate; count += packet.samples.length;
        if (count > rate * MAX_SECONDS) throw new Error('Transition audio is too long');
        parts.push(packet.samples);
      }
    }
    decoder.finish(); signal.throwIfAborted();
    const samples = new Float32Array(count); let offset = 0;
    for (const part of parts) { samples.set(part, offset); offset += part.length; }
    const clip = { rate, samples };
    if (!validClip(clip)) throw new Error('Invalid transition audio');
    if (persist) saveClip(key, kind, clip);
    complete = true; return clip;
  } finally {
    signal.removeEventListener('abort', abortRead);
    void reader?.cancel().catch(() => {});
    if (!complete) void fetcher('http://voicebox.invalid/speak/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(identity), signal: AbortSignal.timeout(3000) }).catch(() => {});
  }
}

export function playTransition(context, clip, signal) {
  return new Promise(resolve => {
    if (signal.aborted || context.state !== 'running') { resolve(); return; }
    const buffer = context.createBuffer(1, clip.samples.length, clip.rate);
    buffer.getChannelData(0).set(clip.samples);
    const node = context.createBufferSource(), gain = context.createGain();
    node.buffer = buffer; node.connect(gain); gain.connect(context.destination);
    let finished = false, stopTimer;
    const finish = () => { if (finished) return; finished = true; clearTimeout(stopTimer); signal.removeEventListener('abort', abort); context.removeEventListener?.('statechange', stateChanged); node.onended = null; node.disconnect(); gain.disconnect(); resolve(); };
    const stateChanged = () => {
      if (context.state !== 'closed') return;
      // Closing Web Audio does not guarantee a source's ended event.
      try { node.stop(); } catch { /* The closed context may have stopped it already. */ }
      finish();
    };
    const abort = () => {
      const now = context.currentTime;
      gain.gain.cancelScheduledValues(now); gain.gain.setValueAtTime(gain.gain.value, now); gain.gain.linearRampToValueAtTime(0, now + .02);
      try { node.stop(now + .02); } catch { finish(); }
      // Wall-clock cleanup also covers a context suspended immediately after abort.
      stopTimer = setTimeout(() => { try { node.stop(); } catch { /* already ended */ } finish(); }, 25);
    };
    signal.addEventListener('abort', abort, { once: true }); context.addEventListener?.('statechange', stateChanged); node.onended = finish;
    gain.gain.setValueAtTime(0, context.currentTime); gain.gain.linearRampToValueAtTime(.8, context.currentTime + .025);
    node.start();
  });
}
