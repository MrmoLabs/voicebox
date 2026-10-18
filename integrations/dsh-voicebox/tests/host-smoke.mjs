// Run with a built DSH source tree or extracted installed runtime.
// HTTP is a recording fixture: this does not claim speaker/GPU verification.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SpeechBridge } from '../src/bridge.js';
import { encodeWav, audioBase64 } from '../src/capture.js';

const root = process.argv[2];
if (!root) throw new Error('Usage: node tests/host-smoke.mjs <built-harness-or-extracted-runtime-root>');
const packaged = existsSync(path.join(root, 'node_modules/@deepseek-ai/dsh-session/lib/index.js'));
const entry = path.join(root, packaged ? 'node_modules/@deepseek-ai/dsh-session/lib/index.js' : 'packages/core/session/lib/index.js');
const dshRequire = createRequire(entry);
// Resolve this unpacked plugin's peer from the supplied host, without
// installing into or changing that host's checkout/profile.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/schemastery' && context.parentURL?.endsWith('/src/index.js')) {
    return next(pathToFileURL(packaged ? dshRequire.resolve('@deepseek-ai/schemastery') : path.join(root, 'vendor/schemastery/lib/index.mjs')).href, context);
  }
  return next(specifier, context);
} });
const { Context } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/cordis')).href);
const { default: SessionStore } = await import(pathToFileURL(entry).href);
const { createMessage, createUserMessage } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-llm')).href);
const { HostConnectionService } = await import(pathToFileURL(packaged ? dshRequire.resolve('@deepseek-ai/dsh-client-connection') : path.join(root, 'packages/client/connection/lib/index.js')).href);
const plugin = await import(process.argv[3] ? pathToFileURL(path.resolve(process.argv[3])).href : '../lib/index.js');
const requests = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const bytes of req) body += bytes;
  requests.push({ path: req.url, body: req.url === '/transcribe' ? { multipart: true } : body ? JSON.parse(body) : undefined });
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(req.url === '/models/status' ? { models: [{ model_name: 'whisper-turbo', downloaded: true }] }
    : req.url === '/transcribe' ? { text: '真实宿主代理录音转写测试', duration: 60 }
    : req.url === '/openapi.json' ? {
    paths: { '/speak': { post: {} }, '/speak/cancel': { post: {} }, '/generate/{generation_id}/live': { get: {} } },
    components: { schemas: { SpeakRequest: { properties: { request_id: {}, stream_audio: {}, preview_mode: {}, playback_owner: {} } } } },
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
  for (const name of ['dsh-system-prompt', 'dsh-agent', 'dsh-tools']) {
    const Service = (await import(pathToFileURL(dshRequire.resolve(`@deepseek-ai/${name}`)).href)).default;
    await ctx.plugin(Service).await();
  }
  // Equivalent to the Desktop carrier dispatching an already-trusted request.
  // Browser auth and the physical Electron IPC are outside this smoke test.
  connectionFiber = ctx.plugin((pluginCtx) => { new HostConnectionService(pluginCtx, [], {}); });
  await connectionFiber.await();
  pluginFiber = ctx.plugin(plugin, { ...plugin.Config({}).get(), endpoint: `http://127.0.0.1:${server.address().port}` });
  await pluginFiber.await();
  const shared = ctx.connection.createSharedFetchHandler('/api');
  const trustedFetch = (request) => shared.fetch(request, ctx.connection.browserPeer);
  if (ctx.connection.browserPeer) {
    const denied = await shared.fetch(new Request('http://dsh/api/voicebox?path=/openapi.json'), { principal: { kind: 'remote' } });
    assert.equal(denied.status, 403, 'non-owner requests must not reach the plugin route');
  }
  let generation;
  bridge = new SpeechBridge({ endpoint: 'http://voicebox.invalid', playbackOwner: 'client' }, {
    fetch: (url, init) => trustedFetch(new Request(`http://dsh/api/voicebox?path=${encodeURIComponent(new URL(url).pathname)}`, init)),
    onSpeech: (value) => { generation = value; },
  });
  ctx.on('session/event', (session, event) => bridge.handle(session, event));
  const session = ctx.sessions.create('voicebox-host-smoke');
  const voiceState = action => trustedFetch(new Request('http://dsh/api/voicebox?path=/conversation', {
    method: 'POST', body: JSON.stringify({ session_id: session.id, epoch: 'smoke-voice', action }),
  }));
  assert.equal((await voiceState('start')).status, 200);
  const voiceAssembly = await ctx.systemPrompt.assemble({ agent: { session }, scope: { agent: 'voice-smoke' } });
  assert.match(voiceAssembly.contexts.find(part => part.name === 'voicebox:conversation').text, /完整回答/);
  const otherSession = ctx.sessions.create('not-voice');
  const otherAssembly = await ctx.systemPrompt.assemble({ agent: { session: otherSession }, scope: { agent: 'other-smoke' } });
  assert.equal(otherAssembly.contexts.find(part => part.name === 'voicebox:conversation')?.text || '', '');
  assert.equal((await voiceState('end')).status, 200);
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
  const input = await trustedFetch(new Request('http://dsh/api/voicebox?path=/listen', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      session_id: session.id, audio: audioBase64(encodeWav([new Float32Array(60 * 16000)], 16000)),
    }),
  }));
  assert.equal(input.status, 200);
  assert.equal((await input.json()).text, '真实宿主代理录音转写测试');
  const beforeFork = requests.length;
  ctx.sessions.fork(session, undefined, 'voicebox-fork-smoke');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests.length, beforeFork, 'fork seed must not trigger playback');
  await bridge.dispose();
  await pluginFiber.dispose();
  assert.equal((await trustedFetch(new Request('http://dsh/api/voicebox?path=/openapi.json'))).status, 404);
  console.log('PASS: real Cordis + Connection + Session events; scoped speech; 60-second microphone WAV proxy; silent fork; clean unload');
} finally {
  await bridge?.dispose();
  await pluginFiber?.dispose();
  await connectionFiber?.dispose();
  await sessionsFiber?.dispose();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  hooks.deregister();
}
