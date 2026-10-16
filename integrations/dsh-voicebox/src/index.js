import Schema from '@deepseek-ai/schemastery';
import { VoiceboxProxy } from './proxy.js';

export const name = 'dsh-voicebox';
export const inject = ['connection'];
export const Config = Schema.object({
  endpoint: Schema.string().default('http://127.0.0.1:17493').description('Voicebox 后端地址'),
  clientId: Schema.string().default('dsh-voicebox').description('Voicebox 客户端绑定标识'),
  profile: Schema.string().default('').description('音色名称或 ID；留空使用 Voicebox 客户端绑定或默认音色'),
  language: Schema.string().default('').description('语言代码；留空使用音色的语言'),
  modelSize: Schema.union(['0.6B', '1.7B']).default('0.6B').description('Qwen 流式语音模型大小'),
  sessionIds: Schema.array(Schema.string()).default([]).description('允许播报的会话 ID；留空允许全部普通会话'),
}).volatile();

export function apply(ctx, config) {
  // DSH 0.2 exposes volatile Config fields through its durable config forms.
  // Keep old jobs scoped to their original endpoint/client when settings change.
  const read = () => typeof config?.get === 'function' ? config.get() : config;
  let current = JSON.stringify(read());
  let proxy = new VoiceboxProxy(read());
  let transition = Promise.resolve();
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/voicebox', methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async (request) => {
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
}
