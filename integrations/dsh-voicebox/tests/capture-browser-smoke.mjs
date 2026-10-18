// Explicit opt-in browser check using silent synthetic MediaStreams, never hardware.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

if (process.argv[2] !== '--serve') throw new Error('Usage: node tests/capture-browser-smoke.mjs --serve');
const output = new URL('../../../release/self-check/capture-browser/result.json', import.meta.url);
const routes = new Map([
  ['/', new URL('./capture-browser-smoke.html', import.meta.url)],
  ['/capture.js', new URL('../src/capture.js', import.meta.url)],
  ['/voice-config.js', new URL('../src/voice-config.js', import.meta.url)],
]);
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/result' && req.headers.origin === 'http://127.0.0.1:17782') {
      let body = ''; for await (const bytes of req) { body += bytes; if (body.length > 32000) throw new Error('Result too large'); }
      const result = JSON.parse(body);
      await mkdir(new URL('./', output), { recursive: true });
      await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      res.end('saved'); return;
    }
    const file = routes.get(req.url);
    if (req.method !== 'GET' || !file) { res.writeHead(404); res.end('not found'); return; }
    res.setHeader('content-type', req.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript');
    res.end(await readFile(file));
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
server.listen(17782, '127.0.0.1', () => console.log('Capture check http://127.0.0.1:17782 — silent synthetic streams only'));
