import { configuredProfile } from './diagnostics.js';

/** Optional, silent startup work. It never downloads models or changes voices. */
export async function warmSpeech(config, endpoint, fetcher, signal) {
  const get = async path => {
    const response = await fetcher(endpoint + path, { method: 'GET', signal,
      headers: { 'X-Voicebox-Client-Id': config.clientId || 'dsh-voicebox' } });
    if (!response.ok) throw Error('Warmup metadata unavailable');
    return response.json();
  };
  const schema = await get('/openapi.json');
  const route = Object.entries(schema?.paths || {}).find(([path]) => /^\/profiles\/\{[^}]+\}\/live-warmup$/u.test(path));
  if (!route?.[1]?.post?.parameters?.some(parameter => parameter.name === 'only_if_cold')) return { ready: false, skipped: 'unsupported' };
  const [health, active, models, profiles, bindings, captures] = await Promise.all([
    get('/health'), get('/tasks/active'), get('/models/status'), get('/profiles'),
    ...(config.profile ? [] : [get('/mcp/bindings'), get('/settings/captures')]),
  ]);
  signal.throwIfAborted();
  if (!Array.isArray(active?.generations) || !Array.isArray(active?.downloads)) return { ready: false, skipped: 'not-ready' };
  if (active?.generations?.length || active?.downloads?.length) return { ready: false, skipped: 'busy' };
  const size = config.modelSize || '0.6B';
  if (!['0.6B', '1.7B'].includes(size) || health?.status !== 'healthy' || health?.gpu_available !== true
    || !/^CUDA\b/iu.test(health?.gpu_type || '')
    || !models?.models?.some(model => model.model_name === `qwen-tts-${size}` && model.downloaded === true)) return { ready: false, skipped: 'not-ready' };
  const profile = configuredProfile(config, profiles, bindings, captures);
  if (!profile?.id || profile.voice_type && profile.voice_type !== 'cloned') return { ready: false, skipped: 'profile' };
  const response = await fetcher(`${endpoint}/profiles/${encodeURIComponent(profile.id)}/live-warmup?model_size=${size}&only_if_cold=true`, {
    method: 'POST', signal, headers: { 'X-Voicebox-Client-Id': config.clientId || 'dsh-voicebox' },
  });
  if (!response.ok) throw Error('Speech warmup unavailable');
  const result = await response.json();
  return { ready: result?.ready === true };
}
