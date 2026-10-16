import { expect, test } from 'bun:test';
import { isProfileCompatibleWithEngine } from '../../app/src/lib/constants/voiceCompatibility';

test('VoiceDesign accepts description profiles and rejects cloned recordings', () => {
  expect(isProfileCompatibleWithEngine({ voice_type: 'designed' }, 'qwen_voice_design')).toBe(true);
  expect(isProfileCompatibleWithEngine({ voice_type: 'cloned' }, 'qwen_voice_design')).toBe(false);
  expect(isProfileCompatibleWithEngine({ voice_type: 'designed' }, 'qwen')).toBe(false);
  expect(isProfileCompatibleWithEngine({ voice_type: 'cloned' }, 'qwen')).toBe(true);
});

test('preset engines stay matched; legacy profiles and OmniVoice use cloning', () => {
  expect(
    isProfileCompatibleWithEngine(
      { voice_type: 'preset', preset_engine: 'kokoro' },
      'qwen_voice_design',
    ),
  ).toBe(false);
  expect(
    isProfileCompatibleWithEngine({ voice_type: 'preset', preset_engine: 'kokoro' }, 'kokoro'),
  ).toBe(true);
  expect(isProfileCompatibleWithEngine({}, 'omnivoice')).toBe(true);
});
