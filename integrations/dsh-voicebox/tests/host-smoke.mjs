// Run with a built DSH source tree to exercise its real Cordis + SessionStore.
// HTTP is a recording fixture: this does not claim speaker/GPU verification.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SpeechBridge } from '../src/bridge.js';

const root = process.argv[2];
if (!root) throw new Error('Usage: node tests/host-smoke.mjs <built-deepseek-harness-root>');
const entry = path.join(root, 'packages/core/session/lib/index.js');
const dshRequire = createRequire(entry);
// Resolve this unpacked plugin's peer from the supplied host, without
// installing into or changing that host's checkout/profile.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/schemastery' && context.parentURL?.endsWith('/src/index.js')) {
    return next(pathToFileURL(path.join(root, 'vendor/schemastery/lib/index.mjs')).href, context);
  }
  return next(specifier, context);
} });
const { Context } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/cordis')).href);
const { default: SessionStore } = await import(pathToFileURL(entry).href);
const { createMessage, createUserMessage } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-llm')).href);
const { HostConnectionService } = await import(pathToFileURL(path.join(root, 'packages/client/connection/lib/index.js')).href);
const plugin = await import('../lib/index.js');
const requests = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const bytes of req) body += bytes;
  requests.push({ path: req.url, body: body ? JSON.parse(body) : undefined });
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(req.url === '/openapi.json' ? {
    paths: { '/speak/cancel': {} },
    components: { schemas: { SpeakRequest: { properties: { request_id: {}, stream_audio: {} } } } },
  } : { id: 'smoke-generation' }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ctx = new Context();
let bridge;
let pluginFiber;
let connectionFiber;
let sessionsFiber;
try {
  sessionsFiber = ctx.plugin(SessionStore);
  await sessionsFiber.await();
  // Equivalent to the Desktop carrier dispatching an already-trusted request.
  // Browser auth and the physical Electron IPC are outside this smoke test.
  connectionFiber = ctx.plugin((pluginCtx) => { new HostConnectionService(pluginCtx, [], {}); });
  await connectionFiber.await();
  pluginFiber = ctx.plugin(plugin, { ...plugin.Config({}).get(), endpoint: `http://127.0.0.1:${server.address().port}` });
  await pluginFiber.await();
  const shared = ctx.connection.createSharedFetchHandler('/api');
  let generation;
  bridge = new SpeechBridge({ endpoint: 'http://voicebox.invalid', playbackOwner: 'client' }, {
    fetch: (url, init) => shared.fetch(new Request(`http://dsh/api/voicebox?path=${encodeURIComponent(new URL(url).pathname)}`, init)),
    onSpeech: (value) => { generation = value; },
  });
  ctx.on('session/event', (session, event) => bridge.handle(session, event));
  const session = ctx.sessions.create('voicebox-host-smoke');
  session.append('turn/start', { turn: 1 });
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Please answer' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: '真实 Session 事件接入成功。' }],
      source: { kind: 'model', provider: 'smoke', model: 'smoke' } }),
    stream: [],
  }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await bridge.idle();
  const speech = requests.filter((request) => request.path === '/speak');
  assert.equal(speech.length, 1);
  assert.equal(speech[0].body.text, '真实 Session 事件接入成功。');
  assert.equal(speech[0].body.stream_audio, true);
  assert.equal(speech[0].body.personality, false);
  assert.equal(speech[0].body.playback_owner, 'client');
  assert.equal(generation.id, 'smoke-generation');
  const beforeFork = requests.length;
  ctx.sessions.fork(session, undefined, 'voicebox-fork-smoke');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests.length, beforeFork, 'fork seed must not trigger playback');
  await bridge.dispose();
  await pluginFiber.dispose();
  assert.equal((await shared.fetch(new Request('http://dsh/api/voicebox?path=/openapi.json'))).status, 404);
  console.log('PASS: real Cordis plugin + Connection route + Session events; client-owned speech; silent fork; clean unload');
} finally {
  await bridge?.dispose();
  await pluginFiber?.dispose();
  await connectionFiber?.dispose();
  await sessionsFiber?.dispose();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  hooks.deregister();
}
