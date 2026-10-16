import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { VoiceboxProxy } from '../src/proxy.js';

const port = Number(process.env.VOICEBOX_PREVIEW_PORT || 17781);
const proxy = new VoiceboxProxy({ endpoint: `http://127.0.0.1:${port}/fixture` });
let nextId = 0;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/fixture/')) {
      for await (const _chunk of req) { /* consume JSON request */ }
      if (url.pathname.endsWith('/live')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        let chunks = 0;
        const timer = setInterval(() => {
          if (++chunks > 80) { clearInterval(timer); res.end(Buffer.alloc(8)); return; }
          const pcm = Buffer.alloc(8 + 6000 * 4);
          pcm.writeUInt32LE(24000, 0); pcm.writeUInt32LE(6000, 4);
          // Quiet test tone; no model or user voice data.
          for (let i = 0; i < 6000; i++) pcm.writeFloatLE(0.015 * Math.sin(2 * Math.PI * 220 * i / 24000), 8 + i * 4);
          res.write(pcm);
        }, 100);
        res.on('close', () => clearInterval(timer));
        return;
      }
      const data = url.pathname.endsWith('/openapi.json') ? {
        paths: { '/speak/cancel': {} }, components: { schemas: { SpeakRequest: { properties: { request_id: {}, stream_audio: {} } } } },
      } : { id: `fixture-${++nextId}` };
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
    res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>DSH Voicebox verification</title><style>body{font:15px system-ui;margin:40px;background:#f5f5f4;color:#292524}main{max-width:1080px;margin:auto}header{border:1px solid #aaa;padding:16px;min-height:34px;display:flex;align-items:center}button{padding:8px 12px;cursor:pointer;margin-right:6px}section{margin-top:24px}</style><div id="root"></div><script type="module" src="/preview.js"></script></html>');
  } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
});
server.listen(port, '127.0.0.1', () => console.log(`Preview http://127.0.0.1:${port} (fixture audio only)`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await proxy.dispose(); server.close(() => process.exit()); });
