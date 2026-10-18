import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { VoiceboxProxy } from '../src/proxy.js';

const port = Number(process.env.VOICEBOX_PREVIEW_PORT || 17781);
const proxy = new VoiceboxProxy({ endpoint: `http://127.0.0.1:${port}/fixture` });
let nextId = 0;
let nextTranscript = 'new', lastSpeech = '';
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/voicebox' && url.searchParams.get('path') === '/conversation') {
      for await (const _chunk of req) { /* Drain fixture state without hardware or models. */ }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, plan: null })); return;
    }
    if (url.pathname === '/preview/transcript' && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      nextTranscript = JSON.parse(Buffer.concat(chunks)).mode;
      res.end('{}'); return;
    }
    if (url.pathname.startsWith('/fixture/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      if (url.pathname.endsWith('/speak')) lastSpeech = JSON.parse(Buffer.concat(chunks)).text;
      if (url.pathname.endsWith('/transcribe')) {
        const mode = nextTranscript; nextTranscript = 'new';
        await new Promise(resolve => setTimeout(resolve, 1200));
        res.setHeader('content-type', 'application/json');
        if (mode === 'failure') { res.writeHead(503); res.end(JSON.stringify({ error: '模拟识别失败' })); return; }
        res.end(JSON.stringify({ text: mode === 'echo' ? lastSpeech : mode === 'empty' ? '' : '请换一个角度解释这个问题。', duration: .7 })); return;
      }
      if (url.pathname.endsWith('/live')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        let chunks = 0;
        const timer = setInterval(() => {
          if (++chunks > 48) { clearInterval(timer); res.end(Buffer.alloc(8)); return; }
          const pcm = Buffer.alloc(8 + 6000 * 4);
          pcm.writeUInt32LE(24000, 0); pcm.writeUInt32LE(6000, 4);
          // Silent PCM exercises playback scheduling without speaker output.
          res.write(pcm);
        }, 100);
        res.on('close', () => clearInterval(timer));
        return;
      }
      const data = url.pathname.endsWith('/health') ? { status: 'healthy', gpu_available: true, gpu_type: 'CUDA (fixture)' }
        : url.pathname.endsWith('/mcp/bindings') ? { items: [] }
        : url.pathname.endsWith('/settings/captures') ? { default_playback_voice_id: 'preview-voice' }
        : url.pathname.endsWith('/models/status') ? { models: [{ model_name: 'whisper-base', downloaded: true }, { model_name: 'whisper-turbo', downloaded: true }, { model_name: 'qwen-tts-0.6B', downloaded: true }] }
        : url.pathname.endsWith('/profiles') ? [{ id: 'preview-voice', name: '模拟声音', language: 'zh', voice_type: 'cloned' }]
        : url.pathname.endsWith('/transcribe') ? { text: '这是一句模拟语音输入。', duration: .7 }
        : url.pathname.endsWith('/openapi.json') ? {
        paths: { '/speak': { post: {} }, '/speak/cancel': { post: {} }, '/generate/{generation_id}/live': { get: {} } }, components: { schemas: { SpeakRequest: { properties: { request_id: {}, stream_audio: {}, preview_mode: {}, playback_owner: {} } } } },
      } : { id: `fixture-${++nextId}`, text: lastSpeech };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); return;
    }
    if (url.pathname === '/api/voicebox') {
      const buffers = []; for await (const chunk of req) buffers.push(chunk);
      const abort = new AbortController(); res.on('close', () => abort.abort());
      const response = await proxy.handle(new Request(url, { method: req.method, signal: abort.signal,
        ...(req.method === 'POST' ? { body: Buffer.concat(buffers) } : {}) }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end(); return;
    }
    if (url.pathname === '/preview.js' || url.pathname === '/client.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(await readFile(url.pathname === '/client.js' ? new URL('../lib/client.js', import.meta.url) : new URL('../../../.tmp-dsh-preview/preview.js', import.meta.url))); return;
    }
    if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>DSH Voicebox verification</title><style>:root{color-scheme:light;--dsw-alias-label-primary:#292524;--dsw-alias-label-secondary:#57534e}body{font:15px system-ui;margin:40px;background:#f5f5f4;color:var(--dsw-alias-label-primary)}:root[data-theme=dark]{color-scheme:dark;--dsw-alias-label-primary:#e7e5e4;--dsw-alias-label-secondary:#a8a29e}:root[data-theme=dark] body{background:#1c1917}main{max-width:1080px;margin:auto}header{border:1px solid #aaa;padding:16px;min-height:34px;display:flex;align-items:center;flex-wrap:wrap}button{padding:8px 12px;cursor:pointer;margin-right:6px}section{margin-top:24px}nav{display:flex;gap:8px;margin-bottom:16px}textarea{box-sizing:border-box;width:100%;font:inherit}button:focus-visible{outline:2px solid currentColor}</style><div id="root"></div><script type="module" src="/preview.js"></script></html>');
  } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
});
server.listen(port, '127.0.0.1', () => console.log(`Preview http://127.0.0.1:${port} (fixture audio only)`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await proxy.dispose(); server.close(() => process.exit()); });
