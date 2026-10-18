import { Converter } from 'opencc-js/t2cn';
import { VOICE_DEFAULTS, MAX_WAV_BYTES } from './voice-config.js';

const MODELS = new Set(['base', 'small', 'medium', 'large', 'turbo']);
const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
let simplify;

export function normalizeTranscript(text, config) {
  const language = config.recognitionLanguage ?? VOICE_DEFAULTS.recognitionLanguage;
  const script = config.recognitionScript ?? VOICE_DEFAULTS.recognitionScript;
  if (script !== 'simplified' || !/^zh(?:-|$)/i.test(language)) return text;
  simplify ??= Converter({ from: 't', to: 'cn' });
  return simplify(text);
}

/** Only bounded microphone WAVs; backend model/language are pinned by host config. */
export class WhisperInput {
  constructor(config, endpoint, fetcher, signal) { Object.assign(this, { config, endpoint, fetcher, signal }); }
  async status(signal) {
    const model = this.config.recognitionModel || VOICE_DEFAULTS.recognitionModel;
    if (!MODELS.has(model)) throw new Error('不支持的 Whisper 模型');
    if (this.readyUntil > Date.now()) return { ready: true, model };
    const response = await this.fetcher(`${this.endpoint}/models/status`, { signal });
    if (!response.ok) throw new Error('无法读取 Voicebox 模型状态');
    const data = await response.json();
    const ready = data.models?.some(item => item.model_name === `whisper-${model}` && item.downloaded === true);
    if (ready) this.readyUntil = Date.now() + 20_000;
    return { ready: !!ready, model, ...(!ready ? { error: `请先在 Voicebox 下载 Whisper ${model} 模型，再开始语音对话` } : {}) };
  }
  async handle(request) {
    const signal = AbortSignal.any([request.signal, this.signal, AbortSignal.timeout(request.method === 'POST' ? 90_000 : 15_000)]);
    try {
      if (request.method === 'GET') return json(await this.status(signal));
      if (this.running) return json({ error: '上一段语音仍在识别，请稍后再说' }, 409);
      const reader = request.body?.getReader();
      if (!reader) return json({ error: '缺少录音' }, 400);
      const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > Math.ceil(MAX_WAV_BYTES * 4 / 3) + 4096) { await reader.cancel(); return json({ error: '录音过大，每段最长约 60 秒' }, 413); }
        chunks.push(value);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json({ error: '无效的录音请求' }, 400); }
      if (!body || typeof body.session_id !== 'string' || !body.session_id || body.session_id.length > 200) return json({ error: '无效的会话' }, 400);
      if (this.config.sessionIds?.length && !this.config.sessionIds.includes(body.session_id)) return json({ error: '当前会话不在语音白名单中' }, 403);
      if (typeof body.audio !== 'string' || body.audio.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio)) return json({ error: '无效的录音编码' }, 400);
      const wav = Buffer.from(body.audio, 'base64');
      if (wav.length < 44 || wav.length > MAX_WAV_BYTES || wav.length % 2 || wav.toString('ascii', 0, 4) !== 'RIFF'
        || wav.toString('ascii', 8, 16) !== 'WAVEfmt ' || wav.readUInt32LE(4) !== wav.length - 8
        || wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1
        || wav.readUInt32LE(24) !== 16000 || wav.readUInt32LE(28) !== 32000 || wav.readUInt16LE(32) !== 2
        || wav.readUInt16LE(34) !== 16 || wav.toString('ascii', 36, 40) !== 'data' || wav.readUInt32LE(40) !== wav.length - 44) {
        return json({ error: '录音须为不超过 61 秒的 16 kHz 单声道 PCM WAV' }, 400);
      }
      // Do not implicitly start a potentially large model download from microphone input.
      if (this.running) return json({ error: '上一段语音仍在识别，请稍后再说' }, 409);
      this.running = true;
      try {
        const status = await this.status(signal);
        if (!status.ready) return json(status, 409);
        const form = new FormData();
        form.set('file', new Blob([wav], { type: 'audio/wav' }), 'microphone.wav');
        form.set('model', status.model);
        const language = this.config.recognitionLanguage ?? VOICE_DEFAULTS.recognitionLanguage;
        if (language) form.set('language', language);
        const response = await this.fetcher(`${this.endpoint}/transcribe`, { method: 'POST', body: form, signal,
          headers: { 'X-Voicebox-Client-Id': this.config.clientId || 'dsh-voicebox' },
        });
        const data = await response.json();
        if (response.status !== 200) return json({ error: data.detail?.message || (typeof data.detail === 'string' ? data.detail : '语音识别失败，请检查 Voicebox 模型状态') }, response.status === 202 ? 409 : response.status);
        if (typeof data.text !== 'string' || data.text.length > 10000) return json({ error: '无效的转写结果' }, 502);
        return json({ text: normalizeTranscript(data.text, this.config), duration: data.duration });
      } finally { this.running = false; }
    } catch (error) { return json({ error: `Voicebox 语音输入不可用：${error.message || error}` }, 502); }
  }
}
