import { VOICE_DEFAULTS } from './voice-config.js';

export const SETTING_FIELDS = ['endpoint', 'clientId', 'profile', 'language', 'modelSize', 'readingMode', 'speechMode', 'sessionIds', ...Object.keys(VOICE_DEFAULTS)];

export function validateSettings(value) {
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { throw new Error('请输入有效的 Voicebox 后端地址'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('后端地址须为 HTTP(S)，不能包含账户、查询参数或片段');
  }
  if (!value.clientId?.trim()) throw new Error('客户端标识不能为空');
  if (!['0.6B', '1.7B'].includes(value.modelSize)) throw new Error('请选择受支持的 Qwen Base 模型');
  if (!['complete', 'streaming'].includes(value.readingMode)) throw new Error('请选择自动播报方式');
  if (!['realtime', 'checked'].includes(value.speechMode)) throw new Error('请选择语音输出策略');
  if (!['base', 'small', 'medium', 'large', 'turbo'].includes(value.recognitionModel)) throw new Error('请选择 Whisper 识别模型');
  if (!['simplified', 'original'].includes(value.recognitionScript)) throw new Error('请选择中文识别文字格式');
  if (!['fast', 'balanced', 'patient'].includes(value.patience)) throw new Error('请选择停顿耐心');
  if (typeof value.allowInterrupt !== 'boolean' || typeof value.backgroundListening !== 'boolean' || typeof value.microphoneId !== 'string' || typeof value.recognitionLanguage !== 'string') throw new Error('语音输入设置无效');
  if (typeof value.transitionSounds !== 'boolean') throw new Error('请选择是否使用语音过渡提示');
  if (!Array.isArray(value.sessionIds) || value.sessionIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)) throw new Error('会话白名单中存在无效 ID');
  return value;
}

/** One atomic official form write, fenced by the revision where editing began. */
export async function saveSettings(form, value, revision) {
  validateSettings(value);
  await form.mutate(SETTING_FIELDS.map(field => ({ op: 'set', path: [field], value: value[field] })), revision);
  const saved = form.getSnapshot();
  if (saved.status !== 'ready' || SETTING_FIELDS.some(field => JSON.stringify(saved.value?.[field]) !== JSON.stringify(value[field]))) {
    throw new Error('设置未生效，配置可能已在其他窗口修改。请重新载入后再保存');
  }
}
