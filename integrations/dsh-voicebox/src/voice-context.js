import { randomUUID } from 'node:crypto';
import { NarrationPlan, voiceIntent } from './content.js';
import { spokenText } from './bridge.js';

const POLICY = `当前会话处于语音对话。回答正文要适合自然口头表达，同时保留可复制的表格、代码、命令和出处。
完整回答所有明确子问题；表格或代码必须配有足够理解的口头说明，保留数字、单位、否定、限制、失败和未验证状态。
根据问题决定详略，不限制在半分钟，不用每讲一节就问要不要继续。用户要求详细或全部展开时，连续完整解释所选范围。
解释与精确原文朗读不同：逐行解释代码不等于逐字念符号。不得仅说“看屏幕”而省去必要信息。
播放状态仅代表设备报告的已播放，不代表用户听清或理解。指代优先关联正在播放或最近播放的内容，而不是尚未播到的后文。
临时局部追问解释完后自然接回原话题；纠正、换题、停止、待用户回答或主动暂停时不要擅自接回。
用户没有要求展开时不强行长篇报告；不能编造原答复没有的依据。`;

const notice = text => Object.freeze({ id: randomUUID(), role: 'user',
  content: Object.freeze([Object.freeze({ type: 'text', text })]),
  source: Object.freeze({ kind: 'dsh-voicebox', form: 'notice', summary: '继续用户已要求的详细语音讲解' }) });

/** Official host context and next-step inbox; no hidden browser/user submission. */
export class VoiceContext {
  constructor(ctx, config = () => ({})) { this.ctx = ctx; this.config = config; this.active = new Map(); }
  state(id) {
    const state = this.active.get(id);
    if (state && state.expires < Date.now()) { this.close(id); return; }
    return state;
  }
  close(id, epoch) {
    const state = this.active.get(id);
    if (!state || (epoch && epoch !== state.epoch)) return;
    state.offTool?.(); this.active.delete(id);
  }
  install() {
    this.ctx.effect(() => {
      const timer = setInterval(() => { for (const id of this.active.keys()) this.state(id); }, 30_000);
      timer.unref?.();
      return () => clearInterval(timer);
    }, 'voicebox: expire disconnected voice clients');
    this.ctx.effect(() => this.ctx.systemPrompt.context({ name: 'voicebox:conversation', order: 700,
      text: context => this.context(context.agent), interpolate: false }), 'voicebox: session voice context');
    this.ctx.on('agent/status', ({ agent }) => { this.attachTool(agent); this.maybeResume(agent); });
    this.ctx.on('session/event', (session, event) => this.observe(session, event));
    this.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next();
      const state = context.agent?.session?.header.origin !== 'subagent' && this.state(context.agent?.session?.id);
      return { ...assembly, tools: assembly.tools.filter(tool => tool.name === 'voicebox_progress' ? !!state
        : tool.name === 'voicebox_branch' ? !!state?.returnPlan : true) };
    });
    this.ctx.on('agent/turn-stopping', ({ agent, signal }) => {
      const state = this.state(agent.session.id);
      if (state?.waiting) return;
      if (state?.plan && state.paused && state.plan.pending().length) state.resumePending = true;
      if (state?.artifactGap && !state.paused && !signal.aborted && (state.artifactRetries || 0) < 1) {
        state.artifactRetries = (state.artifactRetries || 0) + 1;
        agent.inject(notice('本轮回复只有代码、表格等工件，尚未提供可理解的口头解释。请直接补充其用途、关键内容、结果和限制，不重贴原工件，不要求用户看屏幕。'));
        return;
      }
      if (state?.returnPlan && !signal.aborted) {
        state.returnPending = true;
        return;
      }
      if (!state?.plan || state.paused || signal.aborted || !state.plan.advance()) return;
      agent.inject(notice(`继续用户已要求的详细讲解，补充未解释或未确认播完的单元 ${state.plan.pending().map(unit => unit.id).join('、')}。不要重讲已经完整播放的内容。已解释的单元用 voicebox_progress 登记。`));
    });
  }
  maybeResume(agent) {
    const state = this.state(agent?.session?.id);
    if (!state || state.paused || state.waiting || state.inputPending || state.playback?.pending !== 0 || agent.status !== 'idle'
      || this.ctx.agents.get(agent.session.id) !== agent) return;
    if (state.returnPending && state.returnPlan) {
      if (state.returnDecision && !['auto', 'resume'].includes(state.returnDecision)) return;
      if (!state.returnSteps?.size || [...state.returnSteps].some(key => !state.returnPlan.playedSteps.has(key))) return;
      state.plan = state.returnPlan; state.returnPlan = undefined; state.returnPending = false; state.returnSteps = undefined;
      state.returnDecision = undefined;
      state.intent = { ...state.intent, temporary: false }; state.resumePending = true;
    }
    if (!state.resumePending || !state.plan) return;
    state.resumePending = false;
    if (state.plan.advance()) agent.followup(notice('恢复用户已请求的详细讲解，接续未解释或未确认播完的单元，不重复已完整播放部分。'));
  }
  attachTool(agent) {
    const state = this.state(agent?.session?.id);
    if (!state || state.agent === agent || !agent.ctx?.tools) return;
    state.offTool?.(); state.agent = agent;
    const offProgress = agent.ctx.tools.register({ name: 'voicebox_progress',
      description: 'Register sections already explained in visible assistant text for the current detailed voice plan. This tracks model coverage claims, not playback or correctness. Call after a section, not each sentence.',
      parameters: { type: 'object', properties: { covered: { type: 'array', items: { type: 'string' } } }, required: ['covered'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { pending: { type: 'array', items: { type: 'string' } } }, required: ['pending'], additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        if (this.state(agent.session.id) !== state || exec.agent !== agent || !state.plan || !args || Object.keys(args).some(key => key !== 'covered')) throw new Error('当前没有对应的详细语音计划');
        const last = [...agent.session.log].reverse().find(event => event.type === 'assistant/message' && !event.data.interrupted);
        if (last?.data.turn !== state.explanationTurn || !last?.data.message.content.some(block => block.type === 'text' && block.text.trim())) throw new Error('请先在当前轮次的可见回复中解释，再登记进度');
        state.plan.cover(args.covered, `${last.data.turn}:${last.data.step}`);
        return { pending: state.plan.pending().map(unit => unit.id) };
      },
    });
    const offBranch = agent.ctx.tools.register({ name: 'voicebox_branch',
      description: 'After a visible answer in a temporary voice discussion, decide whether to wait for a user answer, resume the suspended detailed explanation after playback, or abandon it for a new topic. Never reports audio as played.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['wait', 'resume', 'abandon'] } }, required: ['action'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        if (this.state(agent.session.id) !== state || exec.agent !== agent || this.ctx.agents.get(agent.session.id) !== agent || !state.returnPlan) throw new Error('当前没有对应的局部追问');
        if (!args || Object.keys(args).some(key => key !== 'action') || !['wait', 'resume', 'abandon'].includes(args.action)) throw new Error('无效的追问接续操作');
        const last = [...agent.session.log].reverse().find(event => event.type === 'assistant/message' && !event.data.interrupted);
        if (last?.data.turn !== state.explanationTurn || !last?.data.message.content.some(block => block.type === 'text' && block.text.trim())) throw new Error('请先给出当前轮次的可见回答');
        state.returnDecision = args.action;
        state.waiting = args.action === 'wait';
        if (args.action === 'abandon') {
          state.returnPlan = undefined; state.returnPending = false; state.returnSteps = undefined;
          state.resumePending = false; state.intent = { ...state.intent, temporary: false };
        }
        return { action: args.action };
      },
    });
    state.offTool = () => { offBranch(); offProgress(); };
  }
  observe(session, event) {
    const state = this.state(session.id);
    if (!state) return;
    if (event.type === 'turn/start') state.explanationTurn = event.data.turn;
    if (event.type === 'assistant/message' && !event.data.interrupted) {
      const text = (event.data.message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
      state.waiting = state.returnDecision === 'wait' || /[？?]\s*$|(?:吗|呢)[。！]?\s*$/u.test(text) && !/(?:要不要继续|是否继续|继续吗)/u.test(text);
      if (text) state.artifactGap = !spokenText(text.replace(/^\s{0,3}#{1,6}\s+.*$/gm, '')).trim();
      if (state.returnPlan && text && !state.artifactGap) state.returnSteps?.add(`${event.data.turn}:${event.data.step ?? 0}`);
    }
    if (event.type === 'user/message' && event.data.source?.kind === 'user') {
      const text = (event.data.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      const intent = voiceIntent(text);
      const parent = state.plan || state.returnPlan;
      const continuing = intent.continuation && parent;
      const previous = intent.expandPrevious && state.plan ? state.plan.answer : this.answer(session, event.seq);
      const carriedBranch = state.returnPlan && !continuing && !intent.restart && (!intent.expandPrevious || intent.scope === 'target');
      state.returnPlan = !continuing && (intent.temporary || carriedBranch) ? parent : undefined;
      state.returnDecision = state.returnPlan ? carriedBranch ? 'pending' : 'auto' : undefined;
      state.returnPlan?.resumeUnheard();
      state.returnSteps = state.returnPlan ? new Set() : undefined; state.returnPending = false;
      state.plan = continuing ? parent : intent.expandPrevious && intent.scope === 'answer' && previous?.text ? new NarrationPlan(previous, text) : undefined;
      if (continuing) { state.plan.resumeUnheard(); state.plan.rounds = 0; state.plan.stalled = 0; state.plan.lastMissing = undefined; }
      state.intent = { ...intent, temporary: !!state.returnPlan || intent.temporary }; state.paused = false; state.resumePending = false;
      state.waiting = false;
      state.artifactRetries = 0; state.artifactGap = false;
      state.explanationTurn = session.log.filter(entry => entry.type === 'turn/start').at(-1)?.data.turn;
    }
  }
  answer(session, before = Infinity) {
    const events = session.log.filter(event => event.seq < before && event.type === 'assistant/message');
    const last = events.at(-1);
    if (!last) return;
    const text = events.filter(event => event.data.turn === last.data.turn).map(event =>
      (event.data.message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')).join('\n\n');
    return { turn: last.data.turn, text };
  }
  context(agent) {
    const state = this.state(agent?.session?.id);
    if (!state || agent.session.header.origin === 'subagent' || (this.config().sessionIds?.length && !this.config().sessionIds.includes(agent.session.id))) return '';
    this.attachTool(agent);
    const plan = state.plan;
    const parts = [POLICY, `实际播放状态：${JSON.stringify(state.playback || {})}`];
    if (state.intent?.temporary) parts.push(state.returnPlan
      ? `当前有挂起的原详细讲解。先处理本次局部讨论，不重讲原答复。可见回答之后用 voicebox_branch 登记：需要用户补充就 wait；局部问题已解决、应接回原讲解就 resume；用户换题、纠正或不再需要原讲解就 abandon。登记不会宣称声音已播放，接回仍等待播放完成与录入结束。${state.returnDecision === 'pending' ? '用户的新发言可能是回答、进一步追问或换题，请按上下文判断；登记前插件不会自动接回。' : ''}`
      : '本次是局部追问。先解释目标，再自然接回原答复未讲内容；需要用户回答时先等待。');
    if (plan) {
      parts.push(`用户要求详细展开上一答复。当前源答复范围：${plan.units.map(unit => `${unit.id} ${unit.title}`).join('；')}。这不是新任务或新的用户发言。`);
      if (plan.pending().some(unit => plan.reopened.has(unit.id))) parts.push('部分单元此前已经写出解释，但未确认完整播完。参考实际播放位置接续，必要时简短回顾；不能声称用户完整听过，也不要重头重复整篇。');
      if (plan.complete() && state.intent?.continuation) parts.push('原详细计划已完整播放。根据用户当前的继续请求推进相关内容，不要重头重复原计划；没有后续材料时如实说明。');
      for (const unit of plan.pending().slice(0, 6)) parts.push(`${plan.reopened.has(unit.id) ? '未确认播完' : '待解释'} ${unit.id} ${unit.title}：\n${unit.text.slice(0, 16000)}${unit.text.length > 16000 ? '\n[本单元原文较长，此处为节选；完整原文在会话记录中，不可声称已完整提供。]' : ''}`);
      parts.push('按这些单元连续详细解释，每完成一个或几个章节调用 voicebox_progress(covered=[对应ID])，仅登记已在可见正文解释的内容；不要先调用工具再省去解释。未列出的剩余单元将在下一步提供。');
      if (plan.stalled >= 2 || plan.rounds >= 8) parts.push('自动补充已达到无进展或轮次保护，计划仍未完整，不得宣称全部讲完。');
    }
    return parts.join('\n\n');
  }
  async handle(request) {
    const json = (body, status = 200) => Response.json(body, { status });
    try {
      const raw = await request.text();
      if (raw.length > 16000) return json({ error: '语音状态过大' }, 413);
      const body = JSON.parse(raw);
      if (!body || typeof body.session_id !== 'string' || body.session_id.length > 200 || typeof body.epoch !== 'string' || !body.epoch || body.epoch.length > 100 || !['start', 'update', 'end'].includes(body.action)) return json({ error: '无效的语音会话状态' }, 400);
      if (body.inputPending !== undefined && typeof body.inputPending !== 'boolean') return json({ error: '无效的语音录入状态' }, 400);
      const session = this.ctx.sessions.get(body.session_id);
      if (!session || session.header.origin === 'subagent') return json({ error: '会话不可用于语音对话' }, 404);
      if (body.action === 'end') { this.close(session.id, body.epoch); return json({ ok: true }); }
      const allowed = this.config().sessionIds;
      if (allowed?.length && !allowed.includes(session.id)) return json({ error: '当前会话不在语音白名单中' }, 403);
      if (body.playback) {
        const p = body.playback;
        if (typeof p.recent !== 'string' || typeof p.current !== 'string' || p.recent.length > 500 || p.current.length > 500 || (p.pending !== undefined && (!Number.isInteger(p.pending) || p.pending < 0 || p.pending > 10000)) || !Array.isArray(p.completedSteps) || p.completedSteps.length > 64 || p.completedSteps.some(key => typeof key !== 'string' || !/^\d+:\d+$/.test(key))) return json({ error: '无效的播放位置' }, 400);
      }
      let state = this.state(session.id);
      if (body.action === 'start') {
        if (this.active.size >= 32 && !state) return json({ error: '活跃语音会话过多' }, 429);
        this.close(session.id); state = { epoch: body.epoch }; this.active.set(session.id, state);
      }
      if (!state || state.epoch !== body.epoch) return json({ error: '语音会话已变更' }, 409);
      state.expires = Date.now() + 90_000;
      if (body.playback) {
        const p = body.playback;
        state.playback = p;
        for (const plan of new Set([state.plan, state.returnPlan])) if (plan) for (const key of p.completedSteps) plan.playedSteps.add(key);
      }
      if (body.stopped === true) { state.plan = undefined; state.returnPlan = undefined; state.resumePending = false; state.returnPending = false; state.returnSteps = undefined; state.returnDecision = undefined; }
      const resume = state.paused && body.paused !== true;
      state.paused = body.paused === true;
      state.inputPending = body.inputPending === true;
      this.attachTool(this.ctx.agents.get(session.id));
      const agent = this.ctx.agents.get(session.id);
      if (resume && state.plan?.pending().length) state.resumePending = true;
      this.maybeResume(agent);
      return json({ ok: true, awaitingAnswer: state.waiting === true, plan: state.plan ? { total: state.plan.units.length, remaining: state.plan.pending().length, completed: state.plan.complete(),
        limited: state.plan.pending().length > 0 && (state.plan.stalled >= 2 || state.plan.rounds >= 8) } : null });
    } catch (error) { return json({ error: error.message || String(error) }, 400); }
  }
  dispose() { for (const id of [...this.active.keys()]) this.close(id); }
}
