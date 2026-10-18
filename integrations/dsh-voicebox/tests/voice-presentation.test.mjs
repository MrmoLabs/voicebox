import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voicePresentation } from '../src/voice-presentation.js';

test('active playback remains visible with a muted/background microphone', () => {
  for (const phase of ['muted', 'background', 'answering']) {
    assert.equal(voicePresentation({ active: true, phase }, { phase: 'playing' }).label, '正在播报');
    assert.equal(voicePresentation({ active: true, phase }, { phase: 'playing' }).paused, undefined);
  }
});

test('input and confirmed interruption take precedence over held playback', () => {
  const speaker = { phase: 'paused', inputHeld: true };
  assert.equal(voicePresentation({ active: true, phase: 'capturing' }, speaker).label, '正在听你说话…');
  assert.equal(voicePresentation({ active: true, phase: 'transcribing', confirming: true }, speaker).label, '正在确认插话…');
  assert.equal(voicePresentation({ active: true, phase: 'answering' }, speaker).paused, true);
});

test('distinguish first synthesis, audio starvation and late model text', () => {
  const state = { active: true, phase: 'answering' };
  assert.equal(voicePresentation(state, { phase: 'buffering', elapsed: 0 }).label, '正在生成语音…');
  assert.equal(voicePresentation(state, { phase: 'buffering', elapsed: 1200 }).label, '正在补充音频缓冲…');
  assert.equal(voicePresentation(state, { phase: 'buffering', waitingForText: true, elapsed: 1200 }).label, '等待下一段正文…');
  assert.equal(voicePresentation({ active: false }, { phase: 'playing' }).paused, true);
});
