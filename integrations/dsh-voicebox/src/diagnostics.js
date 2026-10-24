import { VOICE_DEFAULTS } from './voice-config.js';

export function supportsSpeech(schema) {
  const properties = schema?.components?.schemas?.SpeakRequest?.properties;
  return ['request_id', 'stream_audio', 'preview_mode', 'playback_owner'].every(key => properties?.[key])
    && !!schema?.paths?.['/speak']?.post && !!schema?.paths?.['/speak/cancel']?.post
    && Object.entries(schema?.paths || {}).some(([path, methods]) => /^\/generate\/\{[^}]+\}\/live$/.test(path) && methods?.get);
}

export function configuredProfile(config, profiles, bindings, captures) {
  if (!Array.isArray(profiles)) return;
  const find = value => value ? profiles.find(item => item.id === value) || profiles.find(item => item.name === value) : undefined;
  if (config.profile) return find(config.profile);
  if (!Array.isArray(bindings?.items)) return;
  const binding = bindings.items.find(item => item.client_id === (config.clientId || 'dsh-voicebox'));
  return find(binding?.profile_id) || find(captures?.default_playback_voice_id);
}

/** Read-only metadata checks. Never load a model, download weights or open audio. */
export async function checkInstallation(config, endpoint, fetcher, signal) {
  const checks = [];
  const add = (id, status, message) => checks.push({ id, status, message });
  const get = async path => {
    const response = await fetcher(`${endpoint}${path}`, { method: 'GET', signal,
      headers: { 'X-Voicebox-Client-Id': config.clientId || 'dsh-voicebox' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  let health;
  try { health = await get('/health'); }
  catch {
    signal.throwIfAborted();
    add('service', 'error', '无法连接 Voicebox，请启动服务并检查已保存的地址。');
    return { status: 'error', checks };
  }
  if (health?.status !== 'healthy') {
    add('service', 'error', 'Voicebox 尚未就绪，请在主界面检查服务状态。');
  } else add('service', 'pass', 'Voicebox 服务可连接。');
  const results = await Promise.allSettled(['/openapi.json', '/models/status', '/profiles',
    ...(config.profile ? [] : ['/mcp/bindings', '/settings/captures'])].map(get));
  signal.throwIfAborted();
  const [schema, models, profiles, bindings, captures] = results.map(result => result.status === 'fulfilled' ? result.value : undefined);
  add('contract', supportsSpeech(schema) ? 'pass' : 'error', supportsSpeech(schema)
    ? '后端支持请求去重、取消和客户端流式播放。'
    : '后端缺少本插件所需的语音接口，请更新配套 Voicebox 构建。');
  const cuda = health?.gpu_available === true && /^CUDA\b/i.test(health?.gpu_type || '');
  add('hardware', cuda ? (health?.gpu_compatibility_warning ? 'warning' : 'pass') : 'error', cuda
    ? (health?.gpu_compatibility_warning ? '已检测到 CUDA，但后端报告兼容性提醒，请在 Voicebox 检查。' : '已检测到 CUDA；实际合成仍需试播确认。')
    : '当前未检测到 CUDA；本预览版的 Qwen 流式播放需要 NVIDIA CUDA 后端。');
  for (const [id, model, label] of [['tts', `qwen-tts-${config.modelSize || '0.6B'}`, 'Qwen Base'],
    ['asr', `whisper-${config.recognitionModel || VOICE_DEFAULTS.recognitionModel}`, 'Whisper']]) {
    const cached = Array.isArray(models?.models) ? models.models.find(item => item.model_name === model) : undefined;
    add(id, cached?.downloaded === true ? 'pass' : 'error', cached?.downloaded === true
      ? `${label} 所选模型已缓存。` : `无法确认 ${label} 所选模型已缓存，请在 Voicebox 模型页检查并下载。`);
  }
  if (!Array.isArray(profiles)) add('profile', 'error', '无法读取声音档案，请在 Voicebox 检查。');
  else {
    const bindingAvailable = Array.isArray(bindings?.items);
    const selected = configuredProfile(config, profiles, bindings, captures);
    if (selected) add('profile', !selected.voice_type || selected.voice_type === 'cloned' ? 'pass' : 'error',
      !selected.voice_type || selected.voice_type === 'cloned' ? '所选或默认声音档案可用于 Qwen Base。' : '当前声音档案不适用于 Qwen Base，请选择克隆声音。');
    else if (!config.profile && (!bindingAvailable || !captures)) add('profile', 'warning', '默认声音未能确认，请选择一个明确的声音档案后重新检查。');
    else add('profile', 'error', '没有找到可用的声音档案，请选择声音或在 Voicebox 绑定默认声音。');
  }
  return { status: checks.some(item => item.status === 'error') ? 'error' : checks.some(item => item.status === 'warning') ? 'warning' : 'pass', checks };
}
