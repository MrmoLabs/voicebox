import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerUnits, NarrationPlan, voiceIntent } from '../src/content.js';
import { DeliveryLedger } from '../src/delivery.js';
import { UtteranceDetector, encodeWav, audioBase64 } from '../src/capture.js';
import { SILENCE_MS } from '../src/voice-config.js';
import { VoiceContext } from '../src/voice-context.js';
import { VoiceboxProxy } from '../src/proxy.js';
import { SentenceQueue } from '../src/sentences.js';
import { SpeechBridge } from '../src/bridge.js';

const frame = value => new Float32Array(320).fill(value);
test('normal 2-second hesitations and the old 20-second limit no longer send a turn', () => {
  const clips = [];
  const detector = new UtteranceDetector({ sampleRate: 16000, started() {}, utterance: bytes => clips.push(bytes) });
  for (let n = 0; n < 50; n++) detector.push(frame(.1));
  for (let n = 0; n < 100; n++) detector.push(frame(0));
  assert.equal(clips.length, 0);
  for (let n = 0; n < 1100; n++) detector.push(frame(.1));
  assert.equal(clips.length, 0);
  detector.finish();
  assert.equal(clips.length, 1);
  assert.ok(clips[0].length > 20 * 32000);
  assert.equal(SILENCE_MS.balanced, 2400);
  const auto = new UtteranceDetector({ sampleRate: 16000, started() {}, utterance: bytes => clips.push(bytes) });
  for (let n = 0; n < 25; n++) auto.push(frame(.1));
  for (let n = 0; n < 121; n++) auto.push(frame(0));
  assert.equal(clips.length, 2, 'a real final pause still automatically sends');
});

test('host accepts a longer recording but still rejects malformed and over-limit WAV', async () => {
  let transcribed = 0;
  const proxy = new VoiceboxProxy({}, async url => {
    if (url.endsWith('/models/status')) return Response.json({ models: [{ model_name: 'whisper-turbo', downloaded: true }] });
    transcribed++; return Response.json({ text: '一段较长的完整提问' });
  });
  const send = samples => proxy.handle(new Request('http://host/api/voicebox?path=/listen', {
    method: 'POST', body: JSON.stringify({ session_id: 's', audio: audioBase64(encodeWav([samples], 16000)) }),
  }));
  assert.equal((await send(new Float32Array(30 * 16000))).status, 200);
  assert.equal((await send(new Float32Array(62 * 16000))).status, 413);
  assert.equal(transcribed, 1); await proxy.dispose();
});

test('answer units preserve mixed artifacts, distinguish coverage from playback and bound large units', () => {
  const source = '# 结论\n可实施。\n# 比较\n|项目|值|\n|a|1|\n# 代码\n```js\nconst n = 42;\n```\n# 限制\n尚未验证。';
  const units = answerUnits(source);
  assert.equal(units.length, 4); assert.equal(units[1].artifacts, true);
  assert.match(units[2].text, /const n = 42/);
  const plan = new NarrationPlan({ text: source }, '全部详细讲');
  plan.cover(['u1'], '2:1');
  assert.equal(plan.pending().length, 3); assert.equal(plan.complete(), false);
  assert.throws(() => plan.cover(['invented'], '2:1'), /未知/);
  plan.cover(['u2', 'u3', 'u4'], '2:2');
  assert.equal(plan.complete(), false, 'model claims are not playback receipts');
  plan.playedSteps.add('2:1'); plan.playedSteps.add('2:2');
  assert.equal(plan.complete(), true);
  const large = 'x'.repeat(40000);
  const chunks = answerUnits(large);
  assert.equal(chunks.map(unit => unit.text).join(''), large);
  assert.ok(chunks.every(unit => unit.text.length <= 12000));
});

test('continuation distinguishes pause, detail, backchannel, correction and local scope', () => {
  assert.equal(voiceIntent('继续', { paused: true }).kind, 'resume');
  assert.equal(voiceIntent('继续').detailed, true);
  assert.equal(voiceIntent('把全部内容详细讲一遍').scope, 'answer');
  assert.equal(voiceIntent('把全部内容详细讲一遍').expandPrevious, true);
  assert.equal(voiceIntent('请详细设计一个新的图书系统').expandPrevious, false);
  assert.equal(voiceIntent('第二点详细解释').scope, 'target');
  assert.equal(voiceIntent('嗯', { busy: true }).kind, 'ack');
  assert.equal(voiceIntent('嗯，不对', { busy: true }).kind, 'question');
  assert.equal(voiceIntent('好', { busy: true, awaitingAnswer: true }).kind, 'question');
  assert.equal(voiceIntent('停止').kind, 'stop');
});

test('delivery completes only sealed, actually played steps and never an interrupted segment', () => {
  const ledger = new DeliveryLedger();
  ledger.enqueue({ id: 'a', turn: 1, step: 1, text: '刚才这一句。' });
  ledger.played('a'); assert.deepEqual(ledger.snapshot().completedSteps, []);
  ledger.playing('a'); ledger.played('a');
  assert.deepEqual(ledger.snapshot().completedSteps, []);
  ledger.seal(1, 1); assert.deepEqual(ledger.snapshot().completedSteps, ['1:1']);
  ledger.enqueue({ id: 'b', turn: 1, step: 2, text: '未讲完。' });
  ledger.seal(1, 2); ledger.playing('b'); ledger.interrupt(); ledger.played('b');
  assert.equal(ledger.snapshot().recent, '刚才这一句。');
  assert.deepEqual(ledger.snapshot().completedSteps, ['1:1']);
  ledger.playing('b'); ledger.played('b');
  assert.equal(ledger.snapshot().pending, 0, 'stale callbacks cannot revive interrupted audio');
});

test('resumed plugin turns can narrate only during an active voice call', async () => {
  for (const active of [false, true]) {
    const bridge = new SpeechBridge({ voiceContinuation: () => active }, { fetch: async () => Response.json({}) });
    const session = { id: 's', header: {} };
    bridge.handle(session, { seq: 1, type: 'turn/start', data: { turn: 2 } });
    bridge.handle(session, { seq: 2, type: 'user/message', data: { source: { kind: 'dsh-voicebox' } } });
    assert.equal(bridge.turns.get('s').human, active);
    await bridge.dispose();
  }
});

test('resume waits for queued audio to drain before waking the idle model', async () => {
  const h = host(); await h.send('start');
  const state = h.context.state('s'); state.plan = new NarrationPlan({ text: '# 一\n甲。\n# 二\n乙。' }, '全部讲');
  let wakes = 0; h.agent.status = 'idle'; h.agent.followup = () => wakes++;
  const playback = { recent: '', current: '甲。', pending: 2, completedSteps: [] };
  await h.send('update', { paused: true, playback });
  await h.send('update', { paused: false, playback }); assert.equal(wakes, 0);
  await h.send('update', { paused: false, playback: { ...playback, current: '', pending: 0 } }); assert.equal(wakes, 1);
  await h.send('update', { paused: false, playback: { ...playback, current: '', pending: 0 } }); assert.equal(wakes, 1);
  h.context.dispose();
});

test('long-form narration retains bounded speech pieces beyond the old total-character cutoff', async () => {
  const sizes = [], played = [], queue = new SentenceQueue({ longForm: true,
    prepare: async item => { sizes.push(item.text.length); return item; },
    play: async () => {}, played: item => played.push(item.id), waiting() {}, drained() {}, error(error) { throw error; },
  });
  for (let n = 0; n < 220; n++) queue.enqueue('字'.repeat(60), `piece-${n}`);
  queue.finish(); await queue.idle();
  assert.equal(played.length, 220); assert.ok(sizes.every(size => size === 60));
});

test('backlogged voice clauses share bounded synthesis without delaying first sound or merging model steps', async () => {
  const ledger = new DeliveryLedger(), prepared = [], finished = [];
  let release;
  const queue = new SentenceQueue({longForm:true,
    prepare: async item => { prepared.push(item); return item; },
    play: async item => { if (item.id === 'first') await new Promise(resolve => {release = resolve;}); },
    queued: item => ledger.enqueue(item), playing: item => ledger.playing(item),
    played: item => { ledger.played(item); finished.push(item); }, waiting() {}, drained() {}, error(error) { throw error; },
  });
  queue.enqueue('字'.repeat(25), 'first', {turn:1,step:1});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prepared.length, 1, 'first piece starts without waiting for more text');
  for (const id of ['a','b','c','d']) queue.enqueue('词'.repeat(25), id, {turn:1,step:1});
  queue.enqueue('下一个步骤。', 'next-step', {turn:1,step:2});
  ledger.seal(1,1); ledger.seal(1,2);
  assert.deepEqual(ledger.snapshot().completedSteps, []);
  release(); queue.finish(); await queue.idle();
  assert.ok(prepared.every(item => item.text.length <= 80));
  assert.ok(prepared.some(item => item.parts?.length > 1));
  assert.equal(prepared.at(-1).id, 'next-step');
  assert.deepEqual(ledger.snapshot().completedSteps, ['1:1','1:2']);
  assert.equal(ledger.snapshot().pending, 0);
  assert.equal(finished.length, prepared.length);
});

test('interruption of a combined audio batch never reports its component clauses as heard', () => {
  const ledger = new DeliveryLedger();
  const parts = [{id:'a',text:'第一句',turn:1,step:1},{id:'b',text:'第二句',turn:1,step:1}];
  for (const item of parts) ledger.enqueue(item);
  ledger.seal(1,1);
  const batch = {...parts[0],text:'第一句 第二句',parts};
  ledger.playing(batch); assert.equal(ledger.snapshot().current, batch.text);
  ledger.interrupt(); ledger.played(batch);
  assert.deepEqual(ledger.snapshot().completedSteps, []); assert.equal(ledger.snapshot().recent, '');
});

function host() {
  const tools = new Map(), hooks = new Map();
  const session = { id: 's', header: {}, log: [] };
  const agent = { session, ctx: { tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } }, inject() {} };
  const ctx = { sessions: { get: id => id === 's' ? session : undefined }, agents: { get: () => agent },
    effect() {}, on(name, handler) { hooks.set(name, handler); } };
  const context = new VoiceContext(ctx);
  const send = (action, extra = {}) => context.handle(new Request('http://host', { method: 'POST', body: JSON.stringify({ action, session_id: 's', epoch: 'one', ...extra }) }));
  return { context, agent, session, send, tools, hooks };
}

test('continuing after interrupted narration preserves heard units and reopens only unfinished playback', async () => {
  const h = host(); await h.send('start');
  const plan = new NarrationPlan({ text: '# 一\n甲。\n# 二\n乙。' }, '全部讲');
  plan.cover(['u1'], '2:1'); plan.cover(['u2'], '2:2'); plan.playedSteps.add('2:1');
  h.context.state('s').plan = plan;
  h.context.observe(h.session, { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续讲' }] } });
  assert.equal(h.context.state('s').plan, plan, 'resume must not rebuild the original answer');
  assert.deepEqual(plan.pending().map(unit => unit.id), ['u2']);
  assert.match(h.context.context(h.agent), /未确认.*播完/);
  plan.cover(['u2'], '3:1'); plan.playedSteps.add('3:1'); assert(plan.complete());
  plan.cover(['u1', 'u2'], '3:2'); assert(plan.complete(), 'redundant coverage must not invalidate heard units');
  h.context.observe(h.session, { seq: 4, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续讲' }] } });
  assert.equal(h.context.state('s').plan, plan); assert.deepEqual(plan.pending(), []);
  h.context.dispose();
});

test('a temporary answer cannot resume its parent until sealed audio drains and pending input finishes', async () => {
  const h = host(); h.context.install(); await h.send('start');
  const plan = new NarrationPlan({ text: '# 一\n甲。\n# 二\n乙。\n# 三\n丙。' }, '全部讲');
  plan.cover(['u1'], '2:1'); plan.cover(['u2'], '2:2'); plan.playedSteps.add('2:1');
  h.context.state('s').plan = plan;
  const start = { type: 'turn/start', data: { turn: 3 } };
  h.session.log.push(start); h.context.observe(h.session, start);
  h.context.observe(h.session, { seq: 4, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二点详细解释' }] } });
  const branch = { type: 'assistant/message', data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '这里的意思是乙。' }] } } };
  h.session.log.push(branch); h.context.observe(h.session, branch);
  let injected = 0, wakes = 0;
  h.agent.inject = () => injected++; h.agent.followup = () => wakes++; h.agent.status = 'running';
  h.hooks.get('agent/turn-stopping')({ agent: h.agent, signal: new AbortController().signal });
  assert.equal(injected, 0, 'model completion must not inject the parent while branch audio is queued');
  assert.equal(h.context.state('s').returnPlan, plan);
  const playback = { recent: '', current: '这里的意思是乙。', pending: 1, completedSteps: ['2:1'] };
  await h.send('update', { playback }); h.agent.status = 'idle';
  h.hooks.get('agent/status')({ agent: h.agent }); assert.equal(wakes, 0);
  await h.send('update', { playback: { ...playback, current: '', pending: 0 } });
  assert.equal(wakes, 0, 'an empty queue without a sealed playback receipt is insufficient');
  await h.send('update', { inputPending: true, playback: { ...playback, current: '', pending: 0, completedSteps: ['2:1', '3:1'] } });
  assert.equal(wakes, 0, 'capture/transcription blocks automatic parent resumption');
  await h.send('update', { inputPending: false, playback: { ...playback, current: '', pending: 0, completedSteps: ['2:1', '3:1'] } });
  assert.equal(wakes, 1); assert.equal(h.context.state('s').plan, plan);
  assert.deepEqual(plan.pending().map(unit => unit.id), ['u2', 'u3']);
  await h.send('update', { playback: { ...playback, current: '', pending: 0, completedSteps: ['3:1'] } });
  h.hooks.get('agent/status')({ agent: h.agent }); assert.equal(wakes, 1);
  h.context.dispose();
});

test('late receipts reconcile reopened units and an idle transition wakes a drained resume once', async () => {
  const plan = new NarrationPlan({ text: '# 一\n甲。\n# 二\n乙。' }, '全部讲');
  plan.cover(['u1'], '2:1'); plan.resumeUnheard();
  assert.deepEqual(plan.pending().map(unit => unit.id), ['u1', 'u2']);
  plan.playedSteps.add('2:1'); assert.deepEqual(plan.pending().map(unit => unit.id), ['u2']);
  const h = host(); h.context.install(); await h.send('start'); h.context.state('s').plan = plan;
  let wakes = 0; h.agent.status = 'running'; h.agent.followup = () => wakes++;
  await h.send('update', { paused: true, playback: { recent: '', current: '', pending: 0, completedSteps: ['2:1'] } });
  await h.send('update', { paused: false }); assert.equal(wakes, 0);
  h.agent.status = 'idle'; h.hooks.get('agent/status')({ agent: h.agent }); assert.equal(wakes, 1);
  h.hooks.get('agent/status')({ agent: h.agent }); assert.equal(wakes, 1);
  assert.equal((await h.send('update', { inputPending: 'yes' })).status, 400);
  h.context.dispose();
});

test('waiting, pausing, stopping and a replacement question block late branch receipts', async () => {
  for (const action of ['waiting', 'paused', 'stopped', 'replacement']) {
    const h = host(); h.context.install(); await h.send('start');
    const plan = new NarrationPlan({ text: '# 一\n甲。\n# 二\n乙。' }, '全部讲');
    const state = h.context.state('s'); Object.assign(state, { returnPlan: plan, returnPending: true, returnSteps: new Set(['3:1']) });
    let wakes = 0; h.agent.status = 'idle'; h.agent.followup = () => wakes++;
    if (action === 'waiting') state.waiting = true;
    if (action === 'replacement') h.context.observe(h.session, { seq: 5, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '换个话题，讨论天气' }] } });
    await h.send('update', { paused: action === 'paused', stopped: action === 'stopped', playback: { recent: '', current: '', pending: 0, completedSteps: ['3:1'] } });
    h.hooks.get('agent/status')({ agent: h.agent }); assert.equal(wakes, 0, action);
    h.context.dispose();
  }
});

test('voice leases isolate sessions, reject stale updates and remove scoped tools on end', async () => {
  const h = host();
  assert.equal((await h.send('start')).status, 200);
  assert.match(h.context.context(h.agent), /完整回答/);
  assert.equal(h.context.context({ session: { id: 'other', header: {} } }), '');
  assert.ok(h.tools.has('voicebox_progress'));
  assert.equal((await h.send('start', { epoch: 'two' })).status, 200);
  await h.send('end');
  assert.ok(h.context.state('s'), 'old client end cannot clear the replacement lease');
  assert.equal((await h.send('update')).status, 409);
  await h.send('end', { epoch: 'two' });
  assert.equal(h.context.state('s'), undefined); assert.equal(h.tools.size, 0);
  assert.equal((await h.send('start', { playback: { recent: 'x', current: 'y', completedSteps: ['invented'] } })).status, 400);
  assert.equal(h.context.state('s'), undefined);
});

test('detail plan uses original visible text, stops non-progress and preserves unknown facts', async () => {
  const h = host(); await h.send('start');
  h.session.log = [{ seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '# 结论\n可以尝试。\n# 限制\n尚未验证。' }] } } }];
  h.context.observe(h.session, { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '全部详细讲一遍' }] } });
  assert.match(h.context.context(h.agent), /尚未验证/);
  const plan = h.context.state('s').plan;
  assert.equal(plan.units.length, 2);
  assert.equal(plan.advance(), true); assert.equal(plan.advance(), true); assert.equal(plan.advance(), false);
  assert.equal(plan.complete(), false); h.context.dispose();
});

test('explicit continuation retains fully played sections instead of restarting from the beginning', async () => {
  const h = host(); await h.send('start');
  const plan = new NarrationPlan({ text: '# 一\n甲。\n# 二\n乙。' }, '全部讲');
  plan.cover(['u1'], '2:1'); plan.playedSteps.add('2:1'); plan.stalled = 2; plan.rounds = 8;
  h.context.state('s').plan = plan;
  h.context.observe(h.session, { seq: 3, type: 'user/message', data: { source: {kind:'user'}, content: [{type:'text',text:'继续讲'}] } });
  assert.equal(h.context.state('s').plan, plan);
  assert.deepEqual(plan.pending().map(unit => unit.id), ['u2']); assert.equal(plan.advance(), true);
  h.context.dispose();
});
