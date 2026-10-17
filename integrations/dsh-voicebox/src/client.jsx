import { useLayoutEffect, useSyncExternalStore } from 'react';
import { DesktopSpeechController } from './controller.js';
import { playAgentSpeech } from '../../../app/src/lib/audio/agentSpeechPlayback.ts';
import { VoiceboxSettings, SETTINGS_CSS } from './settings.jsx';

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
.dsh-voicebox-setting{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12px;color:inherit}
.dsh-voicebox-setting button{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:var(--dsw-alias-border-radius-sm,4px);padding:3px 7px;cursor:pointer}
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
  // Keep only the session preference/lifecycle in the header.
  useLayoutEffect(() => {
    controller.select(sessionId);
    return () => controller.select(undefined);
  }, [controller, sessionId]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return <div className="dsh-voicebox-setting">
    <button type="button" disabled={!sessionId} aria-pressed={state.enabled} onClick={() => controller.toggle()}
      title="自动朗读当前会话的新回复；播放控制位于对应回复下方">自动播报{state.enabled ? '：开' : '：关'}</button>
    {state.live && !state.turnFinished && state.activeTurn !== undefined && <span className="dsh-voicebox-inline">
      <button type="button" className="dsh-voicebox-icon" aria-label="停止本轮播报" title="停止本轮播报" onClick={() => controller.stop()}><SpeechIcon kind="stop" /></button>
      {['playing', 'paused'].includes(state.phase) && <button type="button" className="dsh-voicebox-icon" aria-label={state.phase === 'paused' ? '继续朗读' : '暂停朗读'} title={state.phase === 'paused' ? '继续朗读' : '暂停朗读'} onClick={() => controller.pause()}><SpeechIcon kind={state.phase === 'paused' ? 'play' : 'pause'} /></button>}
      <output className="dsh-voicebox-status" title={state.error || '回复完成后，播放控制移至回复下方'}>{state.phase === 'error' ? '本轮播报已停止' : state.phase === 'paused' ? '已暂停' : state.waitingForText ? '等待下一段正文…' : state.phase === 'buffering' ? '正在生成语音…' : `边回答边读 ${Math.floor(state.elapsed / 1000)}s`}</output>
    </span>}
    {state.phase === 'error' && !state.activeMessageId && <output title={state.error}>语音不可用</output>}
  </div>;
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
  const status = phase === 'buffering' ? '正在生成语音…' : phase === 'playing' ? `播放中 ${elapsed}` : phase === 'paused' ? `已暂停 ${elapsed}` : phase === 'error' ? '朗读失败' : '';
  const primary = () => {
    if (phase === 'buffering' || phase === 'playing') controller.stop();
    else if (phase === 'paused') controller.pause();
    else controller.read(messageId);
  };
  return <span className="dsh-voicebox-inline" data-active={active}>
    <button type="button" className="dsh-voicebox-icon" aria-label={label} title={label} aria-busy={phase === 'buffering' || undefined}
      disabled={controller.sessionId !== sessionId || !controller.messageText(messageId)} onClick={primary}>
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
  ctx.effect(() => () => controller.dispose(), 'voicebox: client playback');
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = CSS + SETTINGS_CSS; document.head.appendChild(style);
    return () => style.remove();
  }, 'voicebox: reply action styles');
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'voicebox', order: 40,
    inject: () => ({ controller }),
  }, VoiceControls));
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions', id: 'voicebox', order: 0,
    inject: () => ({ controller }),
  }, MessageVoiceControls));
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: 'dsh-voicebox',
    inject: () => ({ form, controller }),
  }, VoiceboxSettings));
}
