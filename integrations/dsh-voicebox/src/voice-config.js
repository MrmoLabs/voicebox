export const VOICE_DEFAULTS = {
  recognitionModel: 'turbo', recognitionLanguage: 'zh', recognitionScript: 'simplified',
  microphoneId: '', patience: 'balanced', allowInterrupt: false, backgroundListening: true,
};

export const SILENCE_MS = { fast: 1200, balanced: 2400, patient: 4000 };
export const MAX_RECORDING_MS = 60_000;
export const MAX_WAV_BYTES = 44 + 16000 * 2 * (MAX_RECORDING_MS / 1000 + 1);
