// Explicit opt-in browser check using silent synthetic MediaStreams, never hardware.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

if (process.argv[2] !== '--serve') throw new Error('Usage: node tests/capture-browser-smoke.mjs --serve');
const output = new URL('../../../release/self-check/capture-browser/result.json', import.meta.url);
const playbackOutput = new URL('../../../release/self-check/playback-browser/result.json', import.meta.url);
const routes = new Map([
  ['/', new URL('./capture-browser-smoke.html', import.meta.url)],
  ['/capture.js', new URL('../src/capture.js', import.meta.url)],
  ['/voice-config.js', new URL('../src/voice-config.js', import.meta.url)],
  ['/input-signal.js', new URL('../src/input-signal.js', import.meta.url)],
  ['/telemetry.js', new URL('../src/telemetry.js', import.meta.url)],
]);
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && ['/result', '/playback-result'].includes(req.url) && req.headers.origin === 'http://127.0.0.1:17782') {
      let body = ''; for await (const bytes of req) { body += bytes; if (body.length > 32000) throw new Error('Result too large'); }
      const result = JSON.parse(body);
      const destination = req.url === '/result' ? output : playbackOutput;
      await mkdir(new URL('./', destination), { recursive: true });
      await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      res.end('saved'); return;
    }
    if (req.method === 'GET' && req.url === '/playback.js') {
      if (typeof Bun === 'undefined') { res.writeHead(501); res.end('Run this browser check server with Bun for playback verification'); return; }
      const build = await Bun.build({ entrypoints: [fileURLToPath(new URL('../../../app/src/lib/audio/agentSpeechPlayback.ts', import.meta.url))], target: 'browser', format: 'esm' });
      if (!build.success) throw new Error('Cannot compile playback check entrypoint');
      res.setHeader('content-type', 'text/javascript'); res.end(await build.outputs[0].text()); return;
    }
    const file = routes.get(req.url);
    if (req.method !== 'GET' || !file) { res.writeHead(404); res.end('not found'); return; }
    res.setHeader('content-type', req.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript');
    res.end(await readFile(file));
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
server.listen(17782, '127.0.0.1', () => console.log('Capture check http://127.0.0.1:17782 — silent synthetic streams only'));
