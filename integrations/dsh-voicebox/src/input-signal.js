import { diagnosticNow } from './telemetry.js';

export const INPUT_RMS_THRESHOLD = 0.015;
const db = rms => Math.max(-120, Math.min(0, 20 * Math.log10(rms || 1e-6)));

/** Aggregate signal metadata only. Never retain samples, transcripts or device identifiers. */
export class InputSignal {
  constructor(clock = diagnosticNow) { this.clock = clock; this.lastFrame = undefined; this.resetWindow(); }
  resetWindow() { this.frames = 0; this.acceptedFrames = 0; this.voicedMs = 0; this.peak = 0; }
  observe(samples, sampleRate, gate) {
    if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return;
    let power = 0;
    for (const value of samples) power += value * value;
    const rms = Math.sqrt(power / samples.length);
    if (!Number.isFinite(rms)) return;
    this.lastFrame = this.clock(); this.frames++;
    if (gate === 'open') this.acceptedFrames++;
    this.gate = gate; this.peak = Math.max(this.peak, rms); this.sampleRate = sampleRate;
    if (rms >= INPUT_RMS_THRESHOLD) this.voicedMs += samples.length * 1000 / sampleRate;
  }
  snapshot(device = {}) {
    const now = this.clock();
    const contextState = ['running', 'suspended', 'interrupted', 'closed'].includes(device.contextState) ? device.contextState : 'unknown';
    const sinceFrameMs = this.lastFrame === undefined ? undefined : Math.max(0, now - this.lastFrame);
    const state = contextState === 'suspended' || contextState === 'interrupted' ? 'suspended'
      : device.trackMuted === true ? 'device-muted'
      : device.trackEnabled === false ? 'disabled'
      : sinceFrameMs === undefined || sinceFrameMs > 2000 ? 'missing'
      : this.gate !== 'open' ? 'blocked'
      : this.voicedMs > 0 ? 'voiced' : 'quiet';
    const result = { state, frames: this.frames, acceptedFrames: this.acceptedFrames, voicedMs: this.voicedMs,
      peakDb: db(this.peak), thresholdDb: db(INPUT_RMS_THRESHOLD), gate: this.gate || 'unknown',
      sampleRate: this.sampleRate, sinceFrameMs, contextState,
      trackMuted: device.trackMuted === true, trackEnabled: device.trackEnabled };
    this.resetWindow(); return result;
  }
}

export function inputSignalLabel(signal) {
  return { suspended: '录音输入已暂停', 'device-muted': '麦克风被设备暂时静音', disabled: '麦克风输入已关闭',
    missing: '尚未收到麦克风音频', blocked: '输入正在等待当前状态结束',
    voiced: '已收到声音', quiet: '已收到音频，输入音量较低' }[signal?.state] || '等待输入状态';
}
