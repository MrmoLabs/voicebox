/** Engine capability sets shared across the generation UI and its form hook. */

/**
 * Engines whose model actually honours the `instruct` field.
 *
 * Base Qwen3-TTS accepts the kwarg and silently ignores it, so it stays out.
 *
 * The members read the field differently: Qwen CustomVoice and Qwen
 * VoiceDesign take free-form prose ("speak in an angry tone"; VoiceDesign
 * layers it on top of the profile's stored design prompt), while OmniVoice
 * takes a closed vocabulary of attributes ("female, low pitch, british
 * accent") and raises on anything outside it.
 */
export const INSTRUCT_ENGINES: ReadonlySet<string> = new Set([
  'qwen_custom_voice',
  'qwen_voice_design',
  'omnivoice',
]);

/** Whether the given engine should show and forward the instruct field. */
export function engineSupportsInstruct(engine: string | undefined): boolean {
  return engine !== undefined && INSTRUCT_ENGINES.has(engine);
}
