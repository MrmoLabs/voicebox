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
const list = store({ byId: { preview: {} } });
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
  configForms: { get: () => ({ getSnapshot: () => ({ status: 'unavailable' }), subscribe: () => () => {} }) },
  sessions: { list, binding: () => ({ eventSource: events, session }) },
  effect: (fn) => { cleanups.push(fn()); },
  slots: { inject: (_name, fn) => fn(), register: (spec, component) => { seats[spec.name] = { Component: component, props: spec.inject() }; } },
});
const header = seats['conversation.session.header.utilities'];
const actions = seats['conversation.chat.assistant-actions'];
function App() {
  const [turn, setTurn] = React.useState(0);
  const [open, setOpen] = React.useState(true);
  return <main>
    <h1>DSH Voicebox · 客户端验证</h1>
    <p>使用已构建的插件包和模拟 PCM，验证控件与浏览器播放。此页不调用真实模型。</p>
    <header>{open && <header.Component {...header.props} sessionId="preview" />}</header>
    {open && entries.filter(e => e.event.type === 'assistant/message').map(({ event }) => <article key={event.data.message.id} style={{ borderBottom: '1px solid #ddd', padding: '20px 0' }} data-turn-tail={event.data.turn}>
      <p>{event.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')}</p>
      <div data-clock="end" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ fontSize: 12, color: '#737373' }}>复制</span><actions.Component {...actions.props} sessionId="preview" messageId={event.data.message.id} /></div>
    </article>)}
    <section><button onClick={() => {
      const next = turn + 1; setTurn(next);
      const delta = [durable('turn/start', { turn: next }), durable('user/message', { source: { kind: 'user' } }),
        durable('assistant/message', { turn: next, message: { id: `preview-${next}`, content: [{ type: 'thinking', text: 'Never read this' }, { type: 'text', text: `这是第 ${next} 条回复。测试流式语音播放、暂停和中断。` }] } }),
        durable('turn/end', { turn: next, reason: { kind: 'completed' } })];
      entries.push(...delta);
      events.set({ revision: ++revision, entries: [...entries], change: { kind: 'append', entries: delta } });
    }}>模拟 AI 完整回复</button>
    <button onClick={() => { session.set({ subagent: null, pendingSubmissions: [{}] }); session.set({ subagent: null, pendingSubmissions: [] }); }}>模拟发送新消息</button>
    <button onClick={() => setOpen(!open)}>{open ? '切走会话' : '返回会话'}</button></section>
    <p>已收到 {turn} 条新回复。</p>
  </main>;
}
createRoot(document.getElementById('root')).render(<App />);
window.addEventListener('pagehide', () => { for (const cleanup of cleanups) void cleanup?.(); });
