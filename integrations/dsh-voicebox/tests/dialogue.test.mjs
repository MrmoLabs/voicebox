import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerUnits, NarrationPlan, remainingSpeech, voiceIntent } from '../src/content.js';
import { DeliveryLedger } from '../src/delivery.js';
import { UtteranceDetector, encodeWav, audioBase64 } from '../src/capture.js';
import { SILENCE_MS } from '../src/voice-config.js';
import { VoiceContext } from '../src/voice-context.js';
import { VoiceboxProxy } from '../src/proxy.js';
import { SentenceQueue } from '../src/sentences.js';
import { SpeechBridge } from '../src/bridge.js';
import { LiveNarration } from '../src/live.js';

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

test('explicit return phrases select the original explanation rather than expanding the local answer', () => {
  for (const text of ['继续刚才的讲解', '继续刚才的讲解吧', '请继续之前的内容。', '回到原来的话题', '接着被打断的讲解往下说', '从刚才打断的地方继续讲']) {
    const intent = voiceIntent(text, { busy: true, paused: true });
    assert.equal(intent.kind, 'question', text);
    assert.equal(intent.continuation, true, text);
    assert.equal(intent.resumeOriginal, true, text);
    assert.equal(intent.expandPrevious, true, text);
  }
  for (const text of ['继续解释这个例子', '把刚才的解释详细展开', '不要继续刚才的讲解', '继续刚才的讲解，不过换成天气话题', '从头重新讲一遍']) {
    assert.notEqual(voiceIntent(text).resumeOriginal, true, text);
  }
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

test('voice context projects playback facts without forwarding arbitrary client metadata or implying full delivery', async () => {
  const h = host();
  await h.send('start', { playback: { recent: '只播完了开头。', current: '', pending: 0, completedSteps: ['2:1'], injectedDirective: 'SECRET_UNTRUSTED_DIRECTIVE' } });
  const state = h.context.state('s');
  assert.equal(state.playback.injectedDirective, undefined, 'unknown client fields are not context instructions');
  const plan = new NarrationPlan({ text: '# 一\n甲。\n# 二\n乙。' }, '全部讲');
  plan.cover(['u1'], '2:1'); plan.cover(['u2'], '2:2'); plan.playedSteps.add('2:1'); state.plan = plan;
  const partial = h.context.context(h.agent);
  assert.doesNotMatch(partial, /SECRET_UNTRUSTED_DIRECTIVE|"pending":0|"completedSteps"/);
  assert.match(partial, /只播完了开头/);
  assert.match(partial, /u1.*有完整播放回执/); assert.match(partial, /u2.*未确认完整播放/);
  assert.equal(plan.complete(), false, 'no queued audio is insufficient to complete a plan');
  await h.send('update', { playback: { recent: '乙。', current: '', pending: 0, completedSteps: ['2:1', '2:2'] } });
  const complete = h.context.context(h.agent);
  assert.match(complete, /u2.*有完整播放回执/); assert.equal(plan.complete(), true);
  await h.send('update', { playback: { recent: '', current: '', completedSteps: [] } });
  assert.match(h.context.context(h.agent), /排队数量未知/);
  h.context.dispose();
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

test('a multi-turn local question retains its parent but requires an explicit branch decision', async () => {
  const h = host(); h.context.install(); await h.send('start');
  const plan = new NarrationPlan({ text: '# 一\n甲。\n# 二\n乙。' }, '全部讲');
  plan.cover(['u1'], '2:1'); plan.playedSteps.add('2:1');
  const state = h.context.state('s'); state.plan = plan;
  const user = (text, turn) => {
    const event = { type: 'turn/start', data: { turn } };
    h.session.log.push(event); h.context.observe(h.session, event);
    h.context.observe(h.session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
  };
  const answer = (text, turn) => {
    const event = { type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'text', text }] } } };
    h.session.log.push(event); h.context.observe(h.session, event);
    h.hooks.get('agent/turn-stopping')({ agent: h.agent, signal: new AbortController().signal });
  };
  let wakes = 0; h.agent.status = 'idle'; h.agent.followup = () => wakes++;
  user('第二点详细解释', 3); answer('你想了解定义还是例子？', 3);
  user('先举一个例子', 4);
  assert.equal(state.returnPlan, plan, 'answering a branch question must preserve the original plan');
  answer('例子是这样。', 4);
  const playback = { recent: '', current: '', pending: 0, completedSteps: ['4:1'] };
  await h.send('update', { playback }); assert.equal(wakes, 0, 'a new message may change topics; audio alone cannot decide');
  const tool = h.tools.get('voicebox_branch'); assert.ok(tool);
  await tool.execute({ action: 'resume' }, { agent: h.agent });
  h.hooks.get('agent/turn-stopping')({ agent: h.agent, signal: new AbortController().signal });
  h.hooks.get('agent/status')({ agent: h.agent });
  assert.equal(wakes, 1); assert.equal(state.plan, plan);
  assert.deepEqual(plan.pending().map(unit => unit.id), ['u2']);
  h.hooks.get('agent/status')({ agent: h.agent }); assert.equal(wakes, 1);
  h.context.dispose(); assert.equal(h.tools.size, 0);
});

test('an ordinary first interruption preserves the detailed plan until the model chooses the topic boundary', async () => {
  const h = host(); h.context.install(); await h.send('start');
  const plan = new NarrationPlan({ text: '# 原理\n原理甲。\n# 示例\n示例乙。' }, '全部详细讲');
  plan.cover(['u1'], '2:1'); plan.playedSteps.add('2:1');
  const state = h.context.state('s'); state.plan = plan;
  const start = { type: 'turn/start', data: { turn: 3 } }; h.session.log.push(start); h.context.observe(h.session, start);
  h.context.observe(h.session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '等等，为什么要用这个函数？' }] } });
  assert.equal(state.returnPlan, plan, 'lack of an ordinal keyword must not discard the original explanation');
  assert.equal(state.returnDecision, 'pending', 'an ambiguous interruption requires a semantic decision');
  let wakes = 0; h.agent.status = 'idle'; h.agent.followup = () => wakes++;
  const answer = { type: 'assistant/message', data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '因为这个函数负责转换输入。' }] } } };
  h.session.log.push(answer); h.context.observe(h.session, answer);
  h.hooks.get('agent/turn-stopping')({ agent: h.agent, signal: new AbortController().signal });
  await h.send('update', { playback: { recent: '', current: '', pending: 0, completedSteps: ['3:1'] } });
  assert.equal(wakes, 0, 'playback alone cannot choose whether the user changed topics');
  await h.tools.get('voicebox_branch').execute({ action: 'resume' }, { agent: h.agent });
  h.hooks.get('agent/status')({ agent: h.agent });
  assert.equal(wakes, 1); assert.equal(state.plan, plan);
  assert.deepEqual(plan.pending().map(unit => unit.id), ['u2']); h.context.dispose();
});

test('returning by the reported phrase restores the suspended source and preserves heard progress without a branch tool decision', async () => {
  const h = host(); h.context.install(); await h.send('start');
  const plan = new NarrationPlan({ turn: 1, text: '# 原理\n原来的原理。\n# 限制\n原来的限制尚未验证。' }, '全部详细讲');
  plan.cover(['u1'], '2:1'); plan.playedSteps.add('2:1');
  plan.cover(['u2'], '2:2');
  const state = h.context.state('s'); state.plan = plan;
  const user = text => h.context.observe(h.session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
  await h.send('update', { playback: { recent: '原理讲完的位置', current: '原限制被打断的位置', pending: 1, completedSteps: ['2:1'] } });
  user('等等，这里没明白，先解释一下');
  assert.equal(state.returnPlan, plan);
  assert.match(h.context.context(h.agent), /挂起讲解定位/);
  assert.match(h.context.context(h.agent), /原来的限制尚未验证/);
  await h.send('update', { playback: { recent: '局部例子讲到这里', current: '', pending: 0, completedSteps: ['3:1'] } });
  user('先解释这个例子');
  assert.equal(state.returnPlayback.current, '原限制被打断的位置', 'later local turns must not overwrite the original cursor');
  user('继续刚才的讲解');
  assert.equal(state.plan, plan, 'must restore the original plan immediately, not extend the branch');
  assert.equal(state.returnPlan, undefined);
  assert.equal(state.returnDecision, undefined);
  assert.equal(state.intent.temporary, false);
  assert.deepEqual(plan.pending().map(unit => unit.id), ['u2']);
  assert.equal(plan.covered.get('u1'), '2:1');
  const prompt = h.context.context(h.agent);
  assert.match(prompt, /明确要求接回.*原讲解/);
  assert.match(prompt, /原来的限制尚未验证/);
  assert.match(prompt, /原限制被打断的位置/);
  assert.doesNotMatch(prompt, /先处理本次局部讨论/);
  h.context.dispose();
});

test('explicit return without a retained plan does not turn the latest local explanation into the original', async () => {
  const h = host(); await h.send('start');
  h.session.log = [{ seq: 1, type: 'assistant/message', data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '局部解释的新例子。' }] } } }];
  h.context.observe(h.session, { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续刚才的讲解' }] } });
  assert.equal(h.context.state('s').plan, undefined);
  assert.match(h.context.context(h.agent), /当前没有保留的详细计划/);
  assert.doesNotMatch(h.context.context(h.agent), /待解释.*局部解释的新例子/);
  h.context.dispose();
});

test('claimed input previews the first model prompt while durable plans and playback receipts remain unchanged', async () => {
  const h = host(); h.context.install(); await h.send('start');
  const plan = new NarrationPlan({ text: '# 原理\n原理甲。\n# 限制\n限制乙。' }, '全部讲');
  plan.cover(['u1'], '2:1'); plan.playedSteps.add('2:1'); plan.cover(['u2'], '2:2');
  const state = h.context.state('s'); state.returnPlan = plan; state.returnDecision = 'wait'; state.waiting = true;
  const message = { id: 'return-original', source: { kind: 'user' }, content: [{ type: 'text', text: '继续刚才的讲解' }] };
  h.hooks.get('agent/inbox/claimed')({ agent: h.agent, message });
  const prompt = h.context.context(h.agent);
  assert.match(prompt, /明确要求接回.*原讲解/);
  assert.match(prompt, /未确认播完 u2/);
  assert.equal(state.plan, undefined); assert.equal(state.returnPlan, plan); assert.equal(state.waiting, true);
  assert.deepEqual([...plan.reopened], [], 'prompt previews cannot mutate pending playback state');
  const signal = new AbortController().signal;
  await h.hooks.get('agent/pre-step')({ agent: h.agent, signal }, async () => ({ kind: 'enter', messages: [message] }));
  h.context.observe(h.session, { type: 'user/message', data: message });
  assert.equal(state.plan, plan); assert.equal(state.returnPlan, undefined); assert.equal(state.waiting, false);
  assert.equal(state.claimed.length, 0); assert.deepEqual([...plan.reopened], ['u2']);
  h.context.dispose();
});

test('rejected, removed or aborted inbox proposals cannot change the continuation target', async () => {
  for (const outcome of ['reject', 'removed', 'aborted']) {
    const h = host(); h.context.install(); await h.send('start');
    const plan = new NarrationPlan({ text: '# 一\n原讲解。' }, '全部讲');
    const state = h.context.state('s'); state.plan = plan;
    const message = { id: 'proposal', source: { kind: 'user' }, content: [{ type: 'text', text: '等等，先解释一下' }] };
    h.hooks.get('agent/inbox/claimed')({ agent: h.agent, message });
    assert.match(h.context.context(h.agent), /挂起讲解定位/);
    const abort = new AbortController(); if (outcome === 'aborted') abort.abort();
    await h.hooks.get('agent/pre-step')({ agent: h.agent, signal: abort.signal }, async () => outcome === 'reject' ? { kind: 'reject' } : { kind: 'enter', messages: outcome === 'removed' ? [] : [message] });
    assert.equal(state.plan, plan); assert.equal(state.returnPlan, undefined); assert.equal(state.claimed.length, 0);
    assert.doesNotMatch(h.context.context(h.agent), /挂起讲解定位/);
    h.context.dispose();
  }
});

test('an idle transition discards uncommitted inbox previews without reviving a closed voice lease', async () => {
  const h = host(); h.context.install(); await h.send('start');
  const message = { id: 'proposal', source: { kind: 'user' }, content: [{ type: 'text', text: '继续刚才的讲解' }] };
  h.hooks.get('agent/inbox/claimed')({ agent: h.agent, message });
  assert.match(h.context.context(h.agent), /明确要求接回/);
  h.agent.status = 'idle'; h.hooks.get('agent/status')({ agent: h.agent });
  assert.doesNotMatch(h.context.context(h.agent), /明确要求接回/);
  h.context.close('s'); h.hooks.get('agent/inbox/claimed')({ agent: h.agent, message });
  assert.equal(h.context.state('s'), undefined);
  h.context.dispose();
});

test('ordinary speech interruptions retain the original question and cursor without requiring a prior detail plan', async () => {
  const h = host(); h.context.install(); await h.send('start');
  h.session.log = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '讲讲方案成本和限制，简短一些。' }] } },
    { seq: 3, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '# 成本\n需要预算。\n# 限制\n尚未验证。' }] } } },
  ];
  const interruption = { sequence: 1, playback: { recent: '需要预算。', current: '尚未验证。', pending: 1, completedSteps: [] } };
  await h.send('update', { interruption });
  const user = text => h.context.observe(h.session, { seq: 4, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
  user('等等，你说一下这个预算的问题');
  const state = h.context.state('s'), original = state.returnPlan;
  assert.equal(original.mode, 'resume'); assert.equal(original.request, '讲讲方案成本和限制，简短一些。');
  assert.equal(state.returnPlayback.current, '尚未验证。');
  assert.equal(state.returnDecision, 'pending');
  await h.send('update', { interruption });
  assert.equal(state.interruption, undefined, 'repeated heartbeat cannot re-arm a consumed interruption');
  user('继续刚才的讲解吧');
  assert.equal(state.plan, original); assert.equal(state.returnPlan, undefined);
  const prompt = h.context.context(h.agent);
  assert.match(prompt, /接续被打断的普通回答.*保持原问题的详略/);
  assert.match(prompt, /讲讲方案成本和限制，简短一些/);
  assert.match(prompt, /尚未验证/);
  assert.doesNotMatch(prompt, /用户要求详细展开上一答复/);
  h.context.dispose();
});

test('ordinary return selects the unheard paragraphs before the post-tool model step instead of jumping to the ending question', async () => {
  const h = host(); h.context.install(); await h.send('start');
  const intro = 'GitHub 本质上就是“基于 Git 的代码托管平台加开发者社交网络”。';
  const source = `${intro}后面还有仓库和协作流程的说明。\n\n接着介绍个人用途。\n\n最后再问你想从哪个方向聊？`;
  h.session.log = [{ seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: source }] } } }];
  await h.send('update', { interruption: { sequence: 1, playback: { recent: intro, current: '', pending: 3, completedSteps: [] } } });
  h.context.observe(h.session, { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '开发者社交网络怎么理解？' }] } });
  h.context.observe(h.session, { type: 'turn/start', data: { turn: 2 } });
  const event = { type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '先解释社交网络这个概念。' }] } } };
  h.session.log.push(event); h.context.observe(h.session, event);
  const parent = h.context.state('s').returnPlan;
  assert.deepEqual(parent.units.map(unit => unit.text), ['后面还有仓库和协作流程的说明。', '接着介绍个人用途。', '最后再问你想从哪个方向聊？']);
  await h.tools.get('voicebox_branch').execute({ action: 'resume' }, { agent: h.agent });
  assert.equal(h.context.state('s').plan, parent); assert.equal(h.context.state('s').returnPlan, undefined);
  const prompt = h.context.context(h.agent);
  assert.match(prompt, /待解释 u1.*后面还有仓库和协作流程/s);
  assert.doesNotMatch(prompt, /待解释 u2|最后再问你想从哪个方向聊/);
  assert.throws(() => parent.cover(['u3'], '2:2'), /不能跳到/);
  h.context.observe(h.session, { type: 'assistant/message', data: { turn: 2, step: 2, message: { content: [{ type: 'text', text: '你想从哪个方向聊？' }] } } });
  assert.equal(h.context.state('s').waiting, false, 'a premature ending question cannot suppress the missing original content');
  parent.cover(['u1'], '2:2');
  assert.match(h.context.context(h.agent), /待解释 u2.*接着介绍个人用途/s);
  h.context.dispose();
});

test('speech anchors retain an unfinished batch and remain conservative for missing or repeated text', () => {
  const source = '开头。\n尚未完整播出的片段。\n后面的内容。';
  const selected = remainingSpeech(source, { recent: '开头。', current: '尚未完整播出的片段。' });
  assert.equal(selected.matched, true); assert.equal(selected.units[0].text, '尚未完整播出的片段。');
  assert.equal(remainingSpeech('重复。重复。后文。', { recent: '重复。' }).text, '重复。重复。后文。');
  assert.equal(remainingSpeech(source, { current: '不属于原答复' }).text, source);
  assert.equal(remainingSpeech('甲。\n乙。', { recent: '甲。', current: '乙。' }).text, '乙。');
});

test('a generated answer interrupted inside a merged playback batch resumes its actual unheard tail', { timeout: 3000 }, async t => {
  const h = host(); h.context.install(); await h.send('start');
  const delivery = new DeliveryLedger(), entered = [], releases = [];
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  let live, sequence = 0;
  const schema = { paths: { '/speak': { post: {} }, '/speak/cancel': { post: {} }, '/generate/{generation_id}/live': { get: {} } },
    components: { schemas: { SpeakRequest: { properties: { request_id: {}, stream_audio: {}, preview_mode: {}, playback_owner: {} } } } } };
  const bridge = new SpeechBridge({}, {
    onInterrupt: () => live?.reset(),
    fetch: async url => Response.json(url.endsWith('/openapi.json') ? schema : { id: `generation-${sequence++}` }),
  });
  live = new LiveNarration(bridge, {
    delivery, update() {}, failed: state => assert.fail(state.error),
    play: generation => {
      const release = Promise.withResolvers(); releases.push(release);
      entered.push(generation); (entered.length === 1 ? first : second).resolve();
      return release.promise;
    },
  });
  t.after(async () => { live.reset(); for (const release of releases) release.resolve(); h.context.dispose(); await bridge.dispose(); });
  const intro = '先说明这个平台的基本用途，它把代码管理和开发者之间的协作联系在一起。';
  const repository = '接下来介绍仓库的用途，它会保存文件和修改历史，方便之后查看和维护。';
  const collaboration = '然后说明协作流程，参与者先提交自己的改动，再通过审查讨论合并方案。';
  const personal = '最后介绍个人用途，你可以用它管理项目，也可以学习其他人的实现方法。';
  const ending = '这些用途已经介绍完毕，你现在更想从哪个方向继续深入了解呢？';
  const source = `**${intro}**\n\n${repository}\n\n${collaboration}\n\n${personal}\n\n${ending}`;
  const emit = (type, data) => {
    const event = { seq: h.session.log.length + 1, type, data };
    h.session.log.push(event); h.context.observe(h.session, event); live.handle(h.session, event);
  };
  emit('turn/start', { turn: 1 });
  emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '简单介绍这个平台的用途。' }] });
  emit('assistant/message', { turn: 1, step: 1, message: { id: 'original', content: [{ type: 'text', text: source }] } });
  emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await first.promise; releases[0].resolve(); await second.promise;
  const interruption = delivery.snapshot();
  assert.match(interruption.recent, /先说明这个平台/);
  assert.match(interruption.current, /介绍仓库/);
  assert.match(interruption.current, /说明协作流程/);
  assert.ok([...delivery.segments.values()].filter(item => item.status === 'playing').length > 1);
  assert.deepEqual(interruption.completedSteps, [], 'generated and sealed does not mean played');
  const interruptedQueue = live.queue;
  live.reset(); delivery.interrupt(); releases[1].resolve();
  await interruptedQueue.idle();
  await h.send('update', { playback: delivery.snapshot(), interruption: { sequence: 1, playback: interruption } });
  h.context.observe(h.session, { seq: h.session.log.length + 1, type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '等等，修改历史是什么意思？' }] } });
  const plan = h.context.state('s').returnPlan;
  assert.deepEqual(plan.units.map(unit => unit.text), [repository, collaboration, personal, ending]);
  assert.equal(plan.mode, 'resume');
  h.context.observe(h.session, { type: 'turn/start', data: { turn: 2 } });
  const local = { type: 'assistant/message', data: { turn: 2, step: 1,
    message: { content: [{ type: 'text', text: '修改历史就是每次变更的记录。' }] } } };
  h.session.log.push(local); h.context.observe(h.session, local);
  await h.tools.get('voicebox_branch').execute({ action: 'resume' }, { agent: h.agent });
  const prompt = h.context.context(h.agent);
  assert.match(prompt, /待解释 u1.*接下来介绍仓库/s);
  assert.doesNotMatch(prompt, /待解释 u2|现在更想从哪个方向/);
  assert.equal(plan.complete(), false);
  assert.deepEqual(delivery.snapshot().completedSteps, [], 'late player completion cannot acknowledge cancelled batches');
});

test('interruption positions reject malformed metadata and stop discards the pending target', async () => {
  const h = host(); await h.send('start');
  const playback = { recent: '', current: '原回答。', pending: 1, completedSteps: [] };
  for (const interruption of [null, { sequence: 0, playback }, { sequence: 1, playback: { ...playback, current: 'x'.repeat(501) } }, { sequence: 1, playback: { ...playback, completedSteps: ['invented'] } }]) {
    assert.equal((await h.send('update', { interruption })).status, 400);
    assert.equal(h.context.state('s').interruption, undefined);
  }
  await h.send('update', { interruption: { sequence: 2, playback } });
  await h.send('update', { interruption: { sequence: 1, playback: { ...playback, current: '迟到的旧位置' } } });
  assert.equal(h.context.state('s').interruption.playback.current, '原回答。');
  await h.send('update', { stopped: true }); assert.equal(h.context.state('s').interruption, undefined);
  h.context.dispose();
});

test('branch wait and abandon are scoped and cannot be overridden by later playback receipts', async () => {
  for (const action of ['wait', 'abandon']) {
    const h = host(); h.context.install(); await h.send('start');
    const state = h.context.state('s');
    state.returnPlan = new NarrationPlan({ text: '# 一\n甲。' }, '全部讲');
    state.returnSteps = new Set(['3:1']); state.returnPending = true;
    let wakes = 0; h.agent.status = 'idle'; h.agent.followup = () => wakes++;
    const tool = h.tools.get('voicebox_branch'); assert.ok(tool);
    await assert.rejects(tool.execute({ action }, { agent: {} }), /对应/);
    await assert.rejects(tool.execute({ action: 'invented' }, { agent: h.agent }), /无效/);
    await assert.rejects(tool.execute({ action }, { agent: h.agent }), /可见/);
    h.context.observe(h.session, { type: 'turn/start', data: { turn: 3 } });
    const event = { type: 'assistant/message', data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '请先描述你的需求。' }] } } };
    h.session.log.push(event); h.context.observe(h.session, event);
    await tool.execute({ action }, { agent: h.agent });
    const response = await h.send('update', { playback: { recent: '', current: '', pending: 0, completedSteps: ['3:1'] } });
    assert.equal((await response.json()).awaitingAnswer, action === 'wait');
    h.hooks.get('agent/status')({ agent: h.agent }); assert.equal(wakes, 0);
    if (action === 'wait') { assert.equal(state.waiting, true); assert.ok(state.returnPlan); }
    else assert.equal(state.returnPlan, undefined);
    h.context.close('s'); await assert.rejects(tool.execute({ action }, { agent: h.agent }), /对应/);
  }
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
