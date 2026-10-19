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
const branch = (action, value) => [...text(value), { type: 'block-start', index: 1, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 1, id: `branch-${action}`, name: 'voicebox_branch', argumentsDelta: JSON.stringify({ action }) },
  { type: 'block-end', index: 1, block: { type: 'tool-call', id: `branch-${action}`, name: 'voicebox_branch', arguments: JSON.stringify({ action }) } },
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
  const state = await voice.handle(new Request('http://host', { method: 'POST', body: JSON.stringify({ action: 'start', session_id: agent.session.id, epoch: 'owner',
    playback: { recent: '已播完的片段。', current: '', pending: 0, completedSteps: [], extraMetadata: 'DO_NOT_FORWARD_CLIENT_METADATA' },
  }) }));
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
  const voiceText = scoped.contexts.find(part => part.name === 'voicebox:conversation').text;
  assert.doesNotMatch(voiceText, /DO_NOT_FORWARD_CLIENT_METADATA|"pending":0|"completedSteps"/);
  assert.match(voiceText, /u1.*未确认完整播放/);
  assert.match(voiceText, /当前没有排队片段.*不能证明/);
  assert.ok(scoped.tools.some(tool => tool.name === 'voicebox_progress'));
  assert.ok(!scoped.tools.some(tool => tool.name === 'voicebox_branch'), 'ordinary voice turns do not expose a branch control');
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
      playback: { recent: '局部解释。', current: '', pending: 0, completedSteps: [cost, ...[key].flat()] },
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

  const multiParent = setupParent();
  script.push(branch('wait', '请先说明你想了解定义还是例子。'), [...text('我先等你说明需求。'), finish]);
  await send('第二点详细解释');
  assert.equal(voice.state(agent.session.id).waiting, true, 'explicit wait survives a punctuation-free final answer');
  const inBranch = await ctx.systemPrompt.assemble({ agent, scope: agent });
  assert.ok(inBranch.tools.some(tool => tool.name === 'voicebox_branch'));
  script.push(branch('resume', '例子说明如下：这个结果还需要实际测试。'), [...text('局部讨论说明结束。'), finish]);
  await send('先举一个例子');
  assert.equal(voice.state(agent.session.id).returnPlan, multiParent);
  const decisionStep = stepOf('例子说明如下'), lastStep = stepOf('局部讨论说明结束');
  await update(decisionStep); assert.equal(voice.state(agent.session.id).returnPlan, multiParent, 'one of two spoken branch steps is insufficient');
  script.push(explain('u2', '多轮追问后接续原限制：还没有验证。'), [...text('原讲解已接回。'), finish]);
  await update([decisionStep, lastStep]); await agent.whenIdle();
  assert.equal(script.length, 0); assert.equal(voice.state(agent.session.id).plan, multiParent);
  assert.equal(multiParent.covered.get('u1'), cost);

  const plainParent = setupParent();
  script.push(branch('resume', '这个函数用于转换输入格式。'), [...text('这个局部问题已解释。'), finish]);
  await send('等等，为什么要用这个函数？');
  assert.equal(voice.state(agent.session.id).returnPlan, plainParent, 'ordinary first interruption retains the original plan');
  const plainDecision = stepOf('这个函数用于'), plainLast = stepOf('这个局部问题已解释');
  await update(plainDecision); assert.equal(voice.state(agent.session.id).returnPlan, plainParent);
  script.push(explain('u2', '普通插话后接回限制：仍需实际验证。'), [...text('原讲解接续完成。'), finish]);
  await update([plainDecision, plainLast]); await agent.whenIdle();
  assert.equal(script.length, 0); assert.equal(voice.state(agent.session.id).plan, plainParent);
  assert.equal(plainParent.covered.get('u1'), cost);

  const explicitParent = setupParent();
  script.push([...text('先解释局部例子：这里只说明输入转换。'), finish]);
  await send('等等，这里没明白，先解释一下');
  assert.equal(voice.state(agent.session.id).returnPlan, explicitParent);
  const returnRequest = requests.length;
  script.push(explain('u2', '接回原讲解的限制：尚未验证，不能当成已经成功。'), [...text('原限制继续说明完毕。'), finish]);
  await send('继续刚才的讲解吧');
  assert.equal(script.length, 0, 'explicit return must not need a branch tool choice');
  assert.equal(voice.state(agent.session.id).plan, explicitParent);
  assert.equal(voice.state(agent.session.id).returnPlan, undefined);
  assert.equal(explicitParent.covered.get('u1'), cost);
  const returnContext = requests[returnRequest].messages.filter(message => message.source?.kind === 'runtime-context').at(-1)?.source.sections.find(section => section.name === 'voicebox:conversation')?.text || '';
  assert.match(returnContext, /明确要求接回.*原讲解/);
  assert.match(returnContext, /尚未验证/);
  assert.doesNotMatch(returnContext, /先处理本次局部讨论/);

  Object.assign(voice.state(agent.session.id), { plan: undefined, returnPlan: undefined, returnDecision: undefined, waiting: false });
  script.push([...text('# 成本\n需要十元预算。\n# 限制\n结果尚未验证。'), finish]);
  await send('讲讲方案成本和限制，简短一些');
  assert.equal(voice.state(agent.session.id).plan, undefined, 'ordinary answers need no prior expansion plan');
  await voice.handle(new Request('http://host', { method: 'POST', body: JSON.stringify({ action: 'update', session_id: agent.session.id, epoch: 'owner',
    interruption: { sequence: 1, playback: { recent: '需要十元预算。', current: '结果尚未验证。', pending: 1, completedSteps: [] } },
  }) }));
  script.push([...text('先说明预算：这是示例金额。'), finish]); await send('等等，你说一下这个预算的问题');
  const ordinaryParent = voice.state(agent.session.id).returnPlan;
  assert.equal(ordinaryParent.mode, 'resume');
  const ordinaryRequest = requests.length;
  script.push(explain('u2', '接回原方案的限制：结果尚未验证。'), [...text('本次原回答接续结束。'), finish]);
  await send('继续刚才的讲解吧');
  assert.equal(voice.state(agent.session.id).plan, ordinaryParent);
  const ordinaryContext = requests[ordinaryRequest].messages.filter(message => message.source?.kind === 'runtime-context').at(-1)?.source.sections.find(section => section.name === 'voicebox:conversation')?.text || '';
  assert.match(ordinaryContext, /接续被打断的普通回答/);
  assert.match(ordinaryContext, /讲讲方案成本和限制，简短一些/);
  assert.match(ordinaryContext, /结果尚未验证/);

  setupParent();
  script.push([...text('需要哪一种例子？'), finish]); await send('第二点详细解释');
  script.push(branch('abandon', '现在换成新问题，先讨论你的新需求。'), [...text('旧讲解不再继续。'), finish]);
  await send('换个话题，介绍另一个项目');
  assert.equal(voice.state(agent.session.id).returnPlan, undefined);
  await update(stepOf('旧讲解不再继续')); assert.equal(script.length, 0);
  assert.ok(!agent.session.log.some(event => event.type === 'tool/result' && event.data.error), 'all scoped progress and branch tools must execute successfully');
  voice.close(agent.session.id);
  const released = await ctx.systemPrompt.assemble({ agent, scope: agent });
  assert.ok(!released.tools.some(tool => ['voicebox_progress', 'voicebox_branch'].includes(tool.name)));
  console.log(`PASS: installed AgentLoop, scoped voice tool, ${requests.length} scripted model calls, durable plugin continuation, no false playback completion, clean release`);
} finally {
  await voiceFiber?.dispose();
  for (const fiber of fibers.reverse()) await fiber.dispose();
}
