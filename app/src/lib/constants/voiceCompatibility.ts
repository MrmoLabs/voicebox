import type { VoiceProfileResponse } from '@/lib/api/types';

export function isProfileCompatibleWithEngine(
  profile: Pick<VoiceProfileResponse, 'voice_type' | 'preset_engine'>,
  engine: string,
): boolean {
  const type = profile.voice_type || 'cloned';
  if (type === 'preset') return profile.preset_engine === engine;
  if (type === 'designed') return engine === 'qwen_voice_design';
  return ['qwen', 'luxtts', 'chatterbox', 'chatterbox_turbo', 'tada', 'omnivoice'].includes(engine);
}
