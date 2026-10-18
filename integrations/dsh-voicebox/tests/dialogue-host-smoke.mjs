// Real installed Host + AgentLoop + tools; scripted LLM, no paid model or microphone.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { VoiceContext } from '../src/voice-context.js';
import { NarrationPlan } from '../src/content.js';

const root = path.resolve(process.argv[2]);
const require = createRequire(path.join(root, 'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'));
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
const { Context } = await load('cordis');
const { LlmAdapter, createUserMessage } = await load('dsh-llm');
const text = value => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value }, { type: 'block-end', index: 0, block: { type: 'text', text: value } }];
const finish = { type: 'finish', reason: { kind: 'stop' } };
const explain = (id, value) => [...text(value), { type: 'block-start', index: 1, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 1, id: `call-${id}`, name: 'voicebox_progress', argumentsDelta: JSON.stringify({ covered: [id] }) },
  { type: 'block-end', index: 1, block: { type: 'tool-call', id: `call-${id}`, name: 'voicebox_progress', arguments: JSON.stringify({ covered: [id] }) } },
  { type: 'finish', reason: { kind: 'tool-calls' } }];
const script = [[...text('# 成本\n费用为 10 元。\n# 限制\n尚未验证。'), finish],
  [...text('先按两个部分展开。'), finish], explain('u1', '成本是十元，具体包含这些部分。'), explain('u2', '限制是尚未验证，不能当成已经成功。'), [...text('这两部分已经解释。'), finish]];
const requests = [];
class Fixture extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async *stream(options) { requests.push(options); const result = script.shift(); assert.ok(result, 'unexpected model loop'); for (const chunk of result) yield chunk; }
}
const ctx = new Context();
const fibers = [];
let voice;
let voiceFiber;
try {
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop']) {
    const Service = (await load(name)).default;
    const fiber = ctx.plugin(Service, name === 'dsh-agent-loop' ? { agents: [] } : {});
    fibers.push(fiber); await fiber.await();
  }
  ctx.llm.registerAdapter(['fixture'], new Fixture());
  const agent = await ctx.agentLoop.create('voice-contract', { provider: 'fixture', model: 'fixture' });
  voiceFiber = ctx.plugin({ inject: ['systemPrompt', 'sessions', 'agents', 'tools'], apply(pluginCtx) {
    voice = new VoiceContext(pluginCtx); voice.install();
    pluginCtx.effect(() => () => voice.dispose(), 'test voice lifecycle');
  } });
  await voiceFiber.await();
  const state = await voice.handle(new Request('http://host', { method: 'POST', body: JSON.stringify({ action: 'start', session_id: agent.session.id, epoch: 'owner' }) }));
  assert.equal(state.status, 200);
  const send = async value => { agent.followup(createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } })); await agent.whenIdle(); };
  await send('讲讲成本和限制');
  await send('全部详细讲一遍');
  assert.equal(script.length, 0);
  assert.equal(voice.state(agent.session.id).plan.pending().length, 0);
  assert.equal(voice.state(agent.session.id).plan.complete(), false, 'no simulated audio receipts');
  const messages = agent.session.log.filter(event => event.type === 'user/message');
  assert.equal(messages.filter(event => event.data.source.kind === 'user').length, 2, 'no fake human continuation');
  assert.ok(messages.some(event => event.data.source.kind === 'dsh-voicebox'));
  assert.ok(requests.some(request => JSON.stringify(request).includes('尚未验证')));
  assert.ok(agent.session.log.some(event => event.type === 'tool/result' && !event.data.error));
  const scoped = await ctx.systemPrompt.assemble({ agent, scope: agent });
  assert.ok(scoped.tools.some(tool => tool.name === 'voicebox_progress'));
  const paused = voice.state(agent.session.id);
  paused.plan.covered.delete('u2'); paused.paused = true;
  script.push(explain('u2', '接续尚未解释的限制：这一点仍然没有验证。'), [...text('限制已经说明。'), finish]);
  await voice.handle(new Request('http://host', { method: 'POST', body: JSON.stringify({ action: 'update', session_id: agent.session.id, epoch: 'owner', paused: false,
    playback: { recent: '成本已经说明。', current: '', pending: 0, completedSteps: [] } }) }));
  await agent.whenIdle();
  assert.equal(script.length, 0, 'idle resume runs a plugin-origin turn');
  assert.equal(paused.plan.pending().length, 0, 'progress tool accepts the new explanation turn');
  script.push([...text('```js\nconst result = 42;\n```'), finish], [...text('这段代码把结果设为四十二，还没有执行验证。'), finish]);
  await send('写一个简单例子');
  assert.equal(script.length, 0, 'artifact-only reply triggers one explanatory continuation');
  script.push([...text('你希望先比较哪一种方案？'), finish]);
  await send('全部详细讲一遍');
  assert.equal(script.length, 0);
  assert.equal(voice.state(agent.session.id).waiting, true, 'a real question waits for the user');
  const original = '# 成本\n费用为 10 元。\n# 限制\n尚未验证。';
  const stepOf = fragment => {
    const event = agent.session.log.filter(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text.includes(fragment))).at(-1);
    assert(event); return `${event.data.turn}:${event.data.step}`;
  };
  const cost = stepOf('成本是十元'), limit = stepOf('限制是尚未验证');
  const setupParent = () => {
    const plan = new NarrationPlan({ turn: 1, text: original }, '全部详细讲');
    plan.cover(['u1'], cost); plan.cover(['u2'], limit); plan.playedSteps.add(cost);
    Object.assign(voice.state(agent.session.id), { plan, waiting: false }); return plan;
  };
  const update = async (key, inputPending = false) => {
    const response = await voice.handle(new Request('http://host', { method: 'POST', body: JSON.stringify({
      action: 'update', session_id: agent.session.id, epoch: 'owner', inputPending,
      playback: { recent: '局部解释。', current: '', pending: 0, completedSteps: [cost, key] },
    }) })); assert.equal(response.status, 200);
  };
  const parent = setupParent();
  script.push([...text('局部解释：尚未验证意味着现在不能保证结果。'), finish]);
  await send('第二点详细解释');
  assert.equal(voice.state(agent.session.id).returnPlan, parent, 'the parent stays suspended while audio has no receipt');
  const branchStep = stepOf('局部解释：尚未验证');
  await update(branchStep, true); assert.equal(voice.state(agent.session.id).returnPlan, parent);
  script.push(explain('u2', '接回未确认播完的限制：仍需实际验证。'), [...text('这部分已经接续。'), finish]);
  await update(branchStep); await agent.whenIdle();
  assert.equal(script.length, 0); assert.equal(voice.state(agent.session.id).plan, parent);
  assert.equal(parent.covered.get('u1'), cost); assert.equal(parent.complete(), false);
  await update(stepOf('接回未确认播完')); assert(parent.complete());

  // Deliver a branch receipt inside turn-stopping while the real AgentLoop is
  // still running. Its subsequent idle status must resume without a heartbeat.
  const idleParent = setupParent();
  let earlyReceipt = false, deliverEarly = true;
  const offEarly = ctx.on('agent/turn-stopping', async ({ agent: current }) => {
    if (current !== agent || !deliverEarly || !voice.state(agent.session.id)?.returnPlan) return;
    deliverEarly = false;
    assert.notEqual(agent.status, 'idle');
    await update(stepOf('提前送达的局部解释'));
    earlyReceipt = true;
  });
  script.push([...text('提前送达的局部解释：这里仍然表示尚未验证。'), finish],
    explain('u2', '空闲后接续限制：仍需实际验证。'), [...text('接续结束。'), finish]);
  await send('第二点详细解释');
  for (let attempt = 0; attempt < 100 && (script.length || agent.status !== 'idle'); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert(earlyReceipt); assert.equal(script.length, 0, 'idle transition must wake the pending parent exactly once');
  assert.equal(voice.state(agent.session.id).plan, idleParent); assert.equal(idleParent.covered.get('u1'), cost);
  offEarly();
  voice.close(agent.session.id);
  const released = await ctx.systemPrompt.assemble({ agent, scope: agent });
  assert.ok(!released.tools.some(tool => tool.name === 'voicebox_progress'));
  console.log(`PASS: installed AgentLoop, scoped voice tool, ${requests.length} scripted model calls, durable plugin continuation, no false playback completion, clean release`);
} finally {
  await voiceFiber?.dispose();
  for (const fiber of fibers.reverse()) await fiber.dispose();
}
