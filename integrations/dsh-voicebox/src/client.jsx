import { useLayoutEffect, useSyncExternalStore } from 'react';
import { DesktopSpeechController } from './controller.js';
import { playAgentSpeech } from '../../../app/src/lib/audio/agentSpeechPlayback.ts';
import { VoiceboxSettings, SETTINGS_CSS } from './settings.jsx';
import { speechFetch } from './controller.js';
import { VoiceConversation } from './conversation.js';
import { ConversationControls, ConversationDock, CONVERSATION_CSS } from './conversation.jsx';

export const name = 'dsh-voicebox';
export const inject = ['slots', 'sessions', 'configForms'];

const CSS = `
.dsh-voicebox-inline{display:inline-flex;align-items:center;gap:3px;vertical-align:middle;color:var(--dsw-alias-label-tertiary,#737373)}
.dsh-voicebox-icon{display:inline-flex;align-items:center;justify-content:center;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:0;border-radius:var(--dsw-alias-border-radius-sm,4px);background:transparent;color:inherit;cursor:pointer;flex-shrink:0}
.dsh-voicebox-icon:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,inherit)}
.dsh-voicebox-icon:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.dsh-voicebox-icon:disabled{opacity:.4;cursor:default}
.dsh-voicebox-icon svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}
.dsh-voicebox-inline[data-active=true]{color:var(--dsw-alias-label-primary,inherit)}
.dsh-voicebox-status{font:inherit;font-size:12px;line-height:1.4;white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis}
.dsh-voicebox-spin{animation:dsh-voicebox-spin .85s linear infinite}
@keyframes dsh-voicebox-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.dsh-voicebox-spin{animation:none}}
[data-turn-tail]:has(.dsh-voicebox-inline[data-active=true])>div:has(.dsh-voicebox-inline){opacity:1}
.dsh-voicebox-setting{display:flex;align-items:center;gap:4px;min-width:0;min-height:36px;margin:0;padding:0;border:0;flex-wrap:wrap;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}
.dsh-voicebox-autoread{width:auto;height:32px;gap:6px;padding:5px 8px;font:inherit;white-space:nowrap}
.dsh-voicebox-autoread[aria-pressed=true]{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
`;

function SpeechIcon({ kind }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={kind === 'loading' ? 'dsh-voicebox-spin' : undefined}>
    {kind === 'speaker' && <><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" /></>}
    {kind === 'loading' && <path d="M20 12a8 8 0 1 1-5.5-7.6" />}
    {kind === 'stop' && <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />}
    {kind === 'play' && <path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none" />}
    {kind === 'pause' && <path d="M8 5v14M16 5v14" strokeWidth="3" />}
  </svg>;
}

export function VoiceControls({ controller, sessionId }) {
  // The composer exists on blank and active sessions; header utilities do not.
  useLayoutEffect(() => {
    controller.select(sessionId);
    return () => controller.select(undefined);
  }, [controller, sessionId]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const call = useSyncExternalStore(controller.conversation.subscribe, controller.conversation.getSnapshot);
  return <>
    {!call.active && <div className="dsh-voicebox-call-seat"><fieldset className="dsh-voicebox-setting" aria-label="语音功能">
    <ConversationControls conversation={controller.conversation} sessionId={sessionId} />
    <button type="button" className="dsh-voicebox-icon dsh-voicebox-autoread" disabled={!sessionId} aria-pressed={state.enabled} onClick={() => controller.toggle()}
      aria-label={`自动朗读：${state.enabled ? '开' : '关'}`} title={`${state.enabled ? '关闭' : '开启'}自动朗读当前会话的新回复`}><SpeechIcon kind="speaker" /><span>自动朗读：{state.enabled ? '开' : '关'}</span></button>
    {!state.voiceActive && state.live && !state.turnFinished && state.activeTurn !== undefined && <span className="dsh-voicebox-inline">
      <button type="button" className="dsh-voicebox-icon" aria-label="停止本轮播报" title="停止本轮播报" onClick={() => controller.stop()}><SpeechIcon kind="stop" /></button>
      {['playing', 'paused'].includes(state.phase) && <button type="button" disabled={state.inputHeld} className="dsh-voicebox-icon" aria-label={state.phase === 'paused' ? '继续朗读' : '暂停朗读'} title={state.inputHeld ? '正在确认插话' : state.phase === 'paused' ? '继续朗读' : '暂停朗读'} onClick={() => controller.pause()}><SpeechIcon kind={state.phase === 'paused' ? 'play' : 'pause'} /></button>}
      <output className="dsh-voicebox-status" title={state.error || '回复完成后，播放控制移至回复下方'}>{state.phase === 'error' ? '本轮播报已停止' : state.phase === 'paused' ? '已暂停' : state.waitingForText ? '等待下一段正文…' : state.phase === 'buffering' ? (state.elapsed > 0 ? '正在补充音频缓冲…' : '正在生成语音…') : `边回答边读 ${Math.floor(state.elapsed / 1000)}s`}</output>
    </span>}
    {state.phase === 'error' && !state.activeMessageId && <output title={state.error}>语音不可用</output>}
    </fieldset></div>}
    <ConversationDock conversation={controller.conversation} sessionId={sessionId} />
  </>;
}

/** Official finalized-assistant action slot, immediately after the copy action. */
export function MessageVoiceControls({ controller, sessionId, messageId }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const owns = controller.sessionId === sessionId && state.activeMessageId === messageId;
  const phase = owns ? state.phase : 'idle';
  const active = ['buffering', 'playing', 'paused'].includes(phase);
  const label = phase === 'buffering' ? '取消语音生成' : phase === 'playing' ? '停止朗读' : phase === 'paused' ? '继续朗读' : phase === 'error' ? '重试朗读' : '朗读';
  const kind = phase === 'buffering' ? 'loading' : phase === 'playing' ? 'stop' : phase === 'paused' ? 'play' : 'speaker';
  const elapsed = `${Math.floor(state.elapsed / 60_000)}:${String(Math.floor(state.elapsed / 1000) % 60).padStart(2, '0')}`;
  const status = phase === 'buffering' ? (state.elapsed > 0 ? '正在补充音频缓冲…' : '正在生成语音…') : phase === 'playing' ? `播放中 ${elapsed}` : phase === 'paused' ? `已暂停 ${elapsed}` : phase === 'error' ? '朗读失败' : '';
  const primary = () => {
    if (phase === 'buffering' || phase === 'playing') controller.stop();
    else if (phase === 'paused') controller.pause();
    else controller.read(messageId);
  };
  return <span className="dsh-voicebox-inline" data-active={active}>
    <button type="button" className="dsh-voicebox-icon" aria-label={label} title={label} aria-busy={phase === 'buffering' || undefined}
      disabled={controller.sessionId !== sessionId || !controller.messageText(messageId) || (state.inputHeld && phase === 'paused')} onClick={primary}>
      <SpeechIcon kind={kind} />
    </button>
    {phase === 'playing' && <button type="button" className="dsh-voicebox-icon" aria-label="暂停朗读" title="暂停朗读" onClick={() => controller.pause()}><SpeechIcon kind="pause" /></button>}
    {phase === 'paused' && <button type="button" className="dsh-voicebox-icon" aria-label="停止朗读" title="停止朗读" onClick={() => controller.stop()}><SpeechIcon kind="stop" /></button>}
    {status && <output className="dsh-voicebox-status" title={phase === 'error' ? state.error : status}>{status}</output>}
  </span>;
}

export function apply(ctx) {
  const form = ctx.configForms.get('voicebox');
  const controller = new DesktopSpeechController(ctx, playAgentSpeech, form);
  controller.conversation = new VoiceConversation(controller, form, speechFetch);
  ctx.effect(() => () => controller.dispose(), 'voicebox: client playback');
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = CSS + SETTINGS_CSS + CONVERSATION_CSS; document.head.appendChild(style);
    return () => style.remove();
  }, 'voicebox: reply action styles');
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions', id: 'voicebox', order: 0,
    inject: () => ({ controller }),
  }, MessageVoiceControls));
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'voicebox-conversation', order: 40,
    inject: () => ({ controller }),
  }, VoiceControls));
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: 'dsh-voicebox',
    inject: () => ({ form, controller }),
  }, VoiceboxSettings));
}
