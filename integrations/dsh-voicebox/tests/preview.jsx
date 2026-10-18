// Browser fixture for the actual packaged ModuleLoader entry. No real AI/TTS.
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';

function store(value) {
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, set(next) { value = next; for (const fn of listeners) fn(); } };
}
let revision = 0;
let seq = 0;
const durable = (type, data) => ({ type: 'event', event: { type, data, seq: ++seq } });
const entries = [durable('turn/start', { turn: 0 }), durable('assistant/message', { turn: 0, message: { id: 'preview-0', content: [{ type: 'text', text: '历史回复可手动朗读，默认不自动播放。' }] } }), durable('turn/end', { turn: 0, reason: { kind: 'completed' } })];
const events = store({ revision: ++revision, entries, change: { kind: 'replace', entries } });
const session = store({ pendingSubmissions: [], subagent: null });
const list = store({ byId: { preview: {}, fresh: {} } });
const metrics = store({ cancels: 0, prompts: 0, mode: '' });
const configuration = store({ status: 'ready', writable: true, revision: 1, value: {
  endpoint: window.location.origin, clientId: 'preview', profile: '', language: 'zh', modelSize: '0.6B', readingMode: 'complete', sessionIds: [],
  recognitionModel: 'base', recognitionLanguage: 'zh', microphoneId: '', patience: 'balanced', allowInterrupt: true,
} });
configuration.mutate = async (ops, expected) => {
  const previous = configuration.getSnapshot();
  if (previous.revision !== expected) throw new Error('stale preview configuration');
  const value = { ...previous.value };
  for (const op of ops) value[op.path[0]] = op.value;
  configuration.set({ ...previous, revision: previous.revision + 1, value });
};
let voiceTurn = 0;
Object.assign(session, {
  beginSubmission({ text }) { const requestId = `voice-preview-${++voiceTurn}`; session.set({ ...session.getSnapshot(), pendingSubmissions: [{ text, requestId }] }); return { requestId, abandon() {} }; },
  async prompt(content, mode) {
    metrics.set({ ...metrics.getSnapshot(), prompts: metrics.getSnapshot().prompts + 1, mode });
    const next = ++voiceTurn;
    const delta = [durable('turn/start', { turn: next }), durable('user/message', { source: { kind: 'user' }, content }),
      durable('assistant/message', { turn: next, message: { id: `voice-${next}`, content: [{ type: 'text', text: '已经收到你的语音，我们可以继续对话。' }] } }),
      durable('turn/end', { turn: next, reason: { kind: 'completed' } })];
    session.set({ ...session.getSnapshot(), pendingSubmissions: [], running: true });
    entries.push(...delta); events.set({ revision: ++revision, entries: [...entries], change: { kind: 'append', entries: delta } });
    session.set({ ...session.getSnapshot(), running: false });
    return { ok: true };
  },
  async cancel() { metrics.set({ ...metrics.getSnapshot(), cancels: metrics.getSnapshot().cancels + 1 }); session.set({ ...session.getSnapshot(), running: false }); return { ok: true }; },
});
// Synthetic source exercises real browser audio capture without opening hardware.
let microphoneContext, toneGain;
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
  microphoneContext ??= new AudioContext();
  await microphoneContext.resume();
  if (!toneGain) {
    const oscillator = microphoneContext.createOscillator(); oscillator.frequency.value = 330;
    toneGain = microphoneContext.createGain(); toneGain.gain.value = 0;
    oscillator.connect(toneGain); oscillator.start();
  }
  const destination = microphoneContext.createMediaStreamDestination(); toneGain.connect(destination);
  for (const track of destination.stream.getAudioTracks()) {
    const getSettings = track.getSettings.bind(track);
    track.getSettings = () => ({ ...getSettings(), echoCancellation: true }); // Fixture flag, not a hardware claim.
  }
  return destination.stream;
} });
let plugin;
const seats = {};
const cleanups = [];
window.__DSH_TRANSPORT__ = { fetch: (input, init) => fetch(input, init) };
window.__ModuleLoader__ = { load(spec) {
  if (spec.id !== 'dsh-voicebox') throw new Error('Wrong module id');
  plugin = spec.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return jsx;
    throw new Error(`Unexpected dependency ${name}`);
  });
} };
const clientUrl = '/client.js';
await import(clientUrl);
plugin.apply({
  configForms: { get: () => configuration },
  sessions: { list, binding: () => ({ eventSource: events, session }) },
  effect: (fn) => { cleanups.push(fn()); },
  slots: { inject: (_name, fn) => fn(), register: (spec, component) => { seats[spec.name] = { Component: component, props: spec.inject() }; } },
});
const actions = seats['conversation.chat.assistant-actions'];
const settings = seats['plugins.bundle.config'];
const voiceDock = seats['conversation.input.dock'];
function App() {
  React.useSyncExternalStore(events.subscribe, events.getSnapshot);
  const stats = React.useSyncExternalStore(metrics.subscribe, metrics.getSnapshot);
  const [turn, setTurn] = React.useState(0);
  const [open, setOpen] = React.useState(true);
  const [showSettings, setShowSettings] = React.useState(false);
  const [dark, setDark] = React.useState(false);
  const [narrow, setNarrow] = React.useState(false);
  const [currentSession, setCurrentSession] = React.useState('preview');
  const say = async mode => {
    if (!toneGain) return;
    await fetch('/preview/transcript', { method: 'POST', body: JSON.stringify({ mode }) });
    const now = microphoneContext.currentTime; toneGain.gain.setValueAtTime(.12, now); toneGain.gain.setValueAtTime(0, now + .7);
  };
  return <main style={{ maxWidth: narrow ? 320 : 1080 }}>
    <h1>DSH Voicebox · 客户端验证</h1>
    <p>使用已构建的插件包、合成麦克风和模拟 PCM。此页不访问真实麦克风，不调用真实模型。</p>
    <nav aria-label="外观验证">
      <button type="button" onClick={() => { const next = !dark; setDark(next); document.documentElement.dataset.theme = next ? 'dark' : 'light'; }}>{dark ? '切换浅色' : '切换深色'}</button>
      <button type="button" onClick={() => setNarrow(!narrow)}>{narrow ? '恢复宽屏' : '模拟窄窗口'}</button>
      <button type="button" onClick={() => { entries.length = 0; events.set({ revision: ++revision, entries: [], change: { kind: 'replace', entries: [] } }); session.set({ pendingSubmissions: [], subagent: null }); setCurrentSession('fresh'); }}>新建空白会话</button>
    </nav>
    <header>会话工具栏 · 语音功能位于输入区</header>
    {open && entries.filter(e => e.event.type === 'assistant/message').map(({ event }) => <article key={event.data.message.id} style={{ borderBottom: '1px solid #ddd', padding: '20px 0' }} data-turn-tail={event.data.turn}>
      <p>{event.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')}</p>
      <div data-clock="end" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ fontSize: 12, color: '#737373' }}>复制</span><actions.Component {...actions.props} sessionId={currentSession} messageId={event.data.message.id} /></div>
    </article>)}
    <footer style={{ margin: '20px 0', display: 'grid', gap: 8, '--dsh-composer-side-clearance': '16px', '--dsh-composer-card-max-width': '720px' }}>
      {open && voiceDock && <voiceDock.Component {...voiceDock.props} sessionId={currentSession} />}
      <div style={{ paddingInline: 'var(--dsh-composer-side-clearance)' }}><textarea readOnly aria-label="消息输入区" placeholder="消息输入区 · 语音控件在正文与输入框之间，不覆盖正文" style={{ display: 'block', maxWidth: 'var(--dsh-composer-card-max-width)', marginInline: 'auto', padding: 12, minHeight: 60, resize: 'vertical' }} /></div>
    </footer>
    <section><button type="button" onClick={() => {
      const next = turn + 1; setTurn(next);
      const delta = [durable('turn/start', { turn: next }), durable('user/message', { source: { kind: 'user' } }),
        durable('assistant/message', { turn: next, message: { id: `preview-${next}`, content: [{ type: 'thinking', text: 'Never read this' }, { type: 'text', text: `这是第 ${next} 条回复。测试流式语音播放、暂停和中断。` }] } }),
        durable('turn/end', { turn: next, reason: { kind: 'completed' } })];
      entries.push(...delta);
      events.set({ revision: ++revision, entries: [...entries], change: { kind: 'append', entries: delta } });
    }}>模拟 AI 完整回复</button>
    <button type="button" onClick={() => {
      const next = turn + 1; setTurn(next);
      session.set({ ...session.getSnapshot(), running: true });
      const delta = [durable('turn/start', { turn: next }), durable('user/message', { source: { kind: 'user' } }),
        durable('assistant/message', { turn: next, message: { id: `preview-${next}`, content: [{ type: 'text', text: '这是一段正在持续回答的内容，用来验证插话时先暂停而不立即取消。' }] } })];
      entries.push(...delta); events.set({ revision: ++revision, entries: [...entries], change: { kind: 'append', entries: delta } });
    }}>模拟仍在回答</button>
    <button type="button" onClick={() => void say('new')}>模拟说一句</button>
    <button type="button" onClick={() => void say('echo')}>模拟回声</button>
    <button type="button" onClick={() => void say('empty')}>模拟空识别</button>
    <button type="button" onClick={() => void say('failure')}>模拟识别失败</button>
    <button type="button" onClick={() => { session.set({ subagent: null, pendingSubmissions: [{}] }); session.set({ subagent: null, pendingSubmissions: [] }); }}>模拟发送新消息</button>
    <button type="button" onClick={() => setOpen(!open)}>{open ? '切走会话' : '返回会话'}</button></section>
    <button type="button" onClick={() => setShowSettings(!showSettings)}>{showSettings ? '收起插件设置' : '插件设置'}</button>
    {showSettings && <settings.Component {...settings.props} />}
    <p>手动模拟 {turn} 条回复，语音会话回复 {entries.filter(entry => entry.event.data.message?.id?.startsWith('voice-')).length} 条。</p>
    <p>取消 {stats.cancels} 次；语音提交 {stats.prompts} 次；最后模式 {stats.mode || '无'}。</p>
  </main>;
}
createRoot(document.getElementById('root')).render(<App />);
window.addEventListener('pagehide', () => { for (const cleanup of cleanups) void cleanup?.(); });
