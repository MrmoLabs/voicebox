import { MAX_RECORDING_MS, SILENCE_MS } from './voice-config.js';

/** Bounded local endpointing. This energy detector is not semantic speech VAD. */
export class UtteranceDetector {
  constructor({ sampleRate, silenceMs = SILENCE_MS.balanced, startMs = 250, started, utterance, quiet }) {
    Object.assign(this, { sampleRate, silenceMs, startMs, started, utterance, quiet });
    this.reset();
  }
  reset() { this.frames = []; this.prefix = []; this.duration = 0; this.speech = 0; this.silence = 0; this.active = false; this.candidate = 0; }
  push(frame) {
    const ms = frame.length * 1000 / this.sampleRate;
    let power = 0;
    for (const value of frame) power += value * value;
    const voiced = Math.sqrt(power / frame.length) >= 0.015;
    if (!this.active) {
      this.prefix.push(frame);
      while (this.prefix.length > 1 && this.prefix.reduce((n, part) => n + part.length, 0) > this.sampleRate * 0.55) this.prefix.shift();
      this.candidate = voiced ? this.candidate + ms : 0;
      if (this.candidate < this.startMs) return;
      this.active = true;
      this.frames = this.prefix; this.prefix = [];
      this.duration = this.frames.reduce((n, part) => n + part.length, 0) * 1000 / this.sampleRate;
      this.speech = this.candidate;
      this.started();
      return;
    }
    this.frames.push(frame); this.duration += ms;
    this.silence = voiced ? 0 : this.silence + ms;
    if (voiced) this.speech += ms;
    if (this.silence >= this.silenceMs || this.duration >= MAX_RECORDING_MS) {
      const frames = this.frames, valid = this.speech >= 300;
      this.reset();
      if (valid) this.utterance(encodeWav(frames, this.sampleRate));
      else this.quiet?.();
    }
  }
  finish() {
    if (!this.active) return;
    const frames = this.frames, valid = this.speech >= 300;
    this.reset();
    if (valid) this.utterance(encodeWav(frames, this.sampleRate));
    else this.quiet?.();
  }
}

/** Browser capture is resampled to a fixed, host-validated 16 kHz mono PCM WAV. */
export function encodeWav(frames, sampleRate) {
  const input = new Float32Array(frames.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const frame of frames) { input.set(frame, offset); offset += frame.length; }
  const count = Math.floor(input.length * 16000 / sampleRate);
  const buffer = new ArrayBuffer(44 + count * 2), view = new DataView(buffer);
  const ascii = (position, value) => { for (let i = 0; i < value.length; i++) view.setUint8(position + i, value.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const position = i * sampleRate / 16000, left = Math.floor(position), fraction = position - left;
    const value = input[left] * (1 - fraction) + (input[left + 1] ?? input[left]) * fraction;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, value)) * 32767, true);
  }
  return new Uint8Array(buffer);
}

export function audioBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

const WORKLET = `class VoiceboxCapture extends AudioWorkletProcessor {
  constructor() { super(); this.parts = []; this.size = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) {
      this.parts.push(input.slice()); this.size += input.length;
      if (this.size >= 1024) {
        const samples = new Float32Array(this.size); let at = 0;
        for (const part of this.parts) { samples.set(part, at); at += part.length; }
        this.port.postMessage(samples, [samples.buffer]); this.parts = []; this.size = 0;
      }
    }
    return true;
  }
} registerProcessor('voicebox-capture', VoiceboxCapture);`;

export async function openMicrophone({ deviceId, signal, frame, failed }) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前窗口无法访问麦克风，请检查 Desktop 麦克风权限');
  let stream, context, source, processor, gain, url, closed = false, failure;
  const ended = new Map();
  const close = () => {
    closed = true;
    signal.removeEventListener('abort', close);
    for (const [track, listener] of ended) track.removeEventListener('ended', listener);
    ended.clear();
    if (processor?.port) processor.port.onmessage = null;
    if (processor) { processor.onaudioprocess = null; processor.onprocessorerror = null; }
    source?.disconnect(); processor?.disconnect(); gain?.disconnect();
    if (context && context.state !== 'closed') void context.close().catch(() => {});
    for (const track of stream?.getTracks() || []) track.stop();
    if (url) { URL.revokeObjectURL(url); url = undefined; }
    stream = context = source = processor = gain = undefined;
  };
  const check = () => {
    signal.throwIfAborted();
    if (closed) throw failure || new Error('录音已关闭，请重新开始语音对话');
  };
  const fail = error => {
    if (closed || signal.aborted) return;
    failure = error; close(); failed(error);
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    check();
    stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    } });
    check();
    for (const track of stream.getAudioTracks()) {
      if (track.readyState === 'ended') throw new Error('麦克风已断开，请重新开始语音对话');
      const listener = () => fail(new Error('麦克风已断开，请重新开始语音对话'));
      track.addEventListener('ended', listener); ended.set(track, listener);
    }
    context = new AudioContext();
    await context.resume();
    check();
    source = context.createMediaStreamSource(stream);
    gain = context.createGain(); gain.gain.value = 0; gain.connect(context.destination);
    if (context.audioWorklet) {
      try {
        url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
        await context.audioWorklet.addModule(url);
        check();
        processor = new AudioWorkletNode(context, 'voicebox-capture', { channelCount: 1, channelCountMode: 'explicit' });
        processor.port.onmessage = event => { if (!closed && !signal.aborted) frame(event.data, context.sampleRate); };
        processor.onprocessorerror = () => fail(new Error('录音处理已中断，请重新开始语音对话'));
      } catch { check(); }
    }
    // Some Desktop CSP policies disallow blob worklet modules.
    if (!processor) {
      processor = context.createScriptProcessor(1024, 1, 1);
      processor.onaudioprocess = event => { if (!closed && !signal.aborted) frame(event.inputBuffer.getChannelData(0).slice(), context.sampleRate); };
    }
    source.connect(processor); processor.connect(gain);
    return { close, setMuted: muted => { for (const track of stream?.getAudioTracks() || []) track.enabled = !muted; },
      echoCancellation: stream.getAudioTracks()[0]?.getSettings().echoCancellation === true };
  } catch (error) { close(); throw error; }
}
