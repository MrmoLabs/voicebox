import Schema from '@deepseek-ai/schemastery';
import { VoiceboxProxy } from './proxy.js';
import { VoiceContext } from './voice-context.js';

export const name = 'dsh-voicebox';
export const inject = ['connection', 'systemPrompt', 'sessions', 'agents', 'tools'];
export const Config = Schema.object({
  endpoint: Schema.string().default('http://127.0.0.1:17493').description('Voicebox 后端地址'),
  clientId: Schema.string().default('dsh-voicebox').description('Voicebox 客户端绑定标识'),
  profile: Schema.string().default('').description('音色名称或 ID；留空使用 Voicebox 客户端绑定或默认音色'),
  language: Schema.string().default('').description('语言代码；留空使用音色的语言'),
  modelSize: Schema.union(['0.6B', '1.7B']).default('0.6B').description('Qwen 流式语音模型大小'),
  readingMode: Schema.union(['complete', 'streaming']).default('complete').description('自动播报方式：完整回复或边回答边读'),
  speechMode: Schema.union(['realtime', 'checked']).default('realtime').description('语音输出：低延迟流式或整段检查后播放'),
  recognitionModel: Schema.union(['base', 'small', 'medium', 'large', 'turbo']).default('turbo').description('Whisper 识别模型'),
  recognitionLanguage: Schema.string().default('zh').description('识别语言；留空自动检测'),
  recognitionScript: Schema.union(['simplified', 'original']).default('simplified').description('中文识别文字：简体或保留原样'),
  microphoneId: Schema.string().default('').description('麦克风设备 ID；留空系统默认'),
  patience: Schema.union(['fast', 'balanced', 'patient']).default('balanced').description('等待说完的耐心'),
  allowInterrupt: Schema.boolean().default(false).description('允许说话打断；实验功能，建议佩戴耳机'),
  backgroundListening: Schema.boolean().default(true).description('语音对话期间允许后台监听'),
  sessionIds: Schema.array(Schema.string()).default([]).description('允许播报的会话 ID；留空允许全部普通会话'),
}).volatile();

export function apply(ctx, config) {
  // DSH 0.2 exposes volatile Config fields through its durable config forms.
  // Keep old jobs scoped to their original endpoint/client when settings change.
  const read = () => typeof config?.get === 'function' ? config.get() : config;
  const voiceContext = new VoiceContext(ctx, read);
  voiceContext.install();
  let current = JSON.stringify(read());
  let proxy = new VoiceboxProxy(read());
  let transition = Promise.resolve();
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/voicebox', methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async (request) => {
      if (new URL(request.url).searchParams.get('path') === '/conversation' && request.method === 'POST') return voiceContext.handle(request);
      const update = transition.then(async () => {
        const value = read();
        const next = JSON.stringify(value);
        if (next === current) return;
        const replacement = new VoiceboxProxy(value);
        await proxy.dispose();
        proxy = replacement;
        current = next;
      });
      transition = update.catch(() => {});
      await update;
      return proxy.handle(request);
    },
  }), 'voicebox: desktop and browser transport');
  ctx.effect(() => () => proxy.dispose(), 'voicebox: cancel pending speech');
  ctx.effect(() => () => voiceContext.dispose(), 'voicebox: release conversation state');
}
