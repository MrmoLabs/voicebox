import { inputSignalLabel } from './input-signal.js';

/** Visual state only. Never changes microphone, playback, or generation state. */
export function voicePresentation(state, speaker = {}) {
  if (!state.active) return { label: '语音对话已停止', orb: 'breathing', paused: true };
  if (state.confirming) return { label: '正在确认插话…', orb: 'searching' };
  const input = {
    starting: ['正在连接麦克风…', 'connecting'],
    capturing: ['正在听你说话…', 'listening'],
    transcribing: ['正在识别…', 'searching'],
    sending: ['正在发送…', 'connecting'],
  }[state.phase];
  if (input) return { label: input[0], orb: input[1] };
  // A muted/background microphone must not make an active speaker look stopped.
  if (speaker.phase === 'paused') return { label: '播报已暂停', orb: 'composing', paused: true };
  if (speaker.waitingForText) return { label: '等待下一段正文…', orb: 'working' };
  if (speaker.phase === 'playing') return { label: '正在播报', orb: 'composing' };
  if (speaker.phase === 'buffering') return { label: speaker.elapsed > 0 ? '正在补充音频缓冲…' : '正在生成语音…', orb: 'weaving' };
  if (state.phase === 'answering') return { label: '正在回答…', orb: 'working' };
  if (state.phase === 'muted') return { label: '麦克风已静音', orb: 'breathing', paused: true };
  if (state.phase === 'background') return { label: '后台监听已暂停', orb: 'breathing', paused: true };
  if (['missing', 'suspended', 'device-muted'].includes(state.inputSignal?.state)) return { label: inputSignalLabel(state.inputSignal), orb: 'breathing', paused: true };
  return { label: '正在听', orb: 'breathing', speed: .7 };
}
