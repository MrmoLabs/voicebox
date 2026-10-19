import { useId, useState, useSyncExternalStore } from 'react';
import { VoiceOrb } from './voice-orb.jsx';
import { voicePresentation } from './voice-presentation.js';
import { inputSignalLabel } from './input-signal.js';

function CallIcon({ kind }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {['mic', 'muted'].includes(kind) && <><path d="M9 9V5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-3 0h6" />{kind === 'muted' && <path d="m3 3 18 18" />}</>}
    {kind === 'send' && <><path d="M12 19V5m-6 6 6-6 6 6" /><path d="M5 21h14" /></>}
    {kind === 'pause' && <path d="M8 6v12M16 6v12" strokeWidth="3" />}
    {kind === 'play' && <path d="m8 5 10 7-10 7z" fill="currentColor" stroke="none" />}
    {kind === 'interrupt' && <path d="M4 9v6M8 5v14M12 8v8M16 10v4M20 8v8" />}
    {kind === 'end' && <path d="M5 16v-4h14v4m-14-4 3-3h8l3 3M5 16h3v-4m8 0v4h3" />}
    {kind === 'close' && <path d="m6 6 12 12M6 18 18 6" />}
    {kind === 'details' && <path d="m7 10 5 5 5-5" />}
  </svg>;
}

function CallButton({ label, kind, ...props }) {
  return <button type="button" className="dsh-voicebox-call-button" title={label} aria-label={label} {...props}><CallIcon kind={kind} /></button>;
}

/** Composer entry remains available before the first message. */
export function ConversationControls({ conversation, sessionId }) {
  const state = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
  return <span className="dsh-voicebox-call"><button type="button" className="dsh-voicebox-call-entry" disabled={!sessionId} aria-pressed={state.active}
    onClick={() => { if (state.active) conversation.end(); else void conversation.start(); }}>
    <CallIcon kind="interrupt" />{state.active ? '结束语音' : '语音对话'}
  </button></span>;
}

export function ConversationDock({ conversation, sessionId }) {
  const state = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
  const speaker = useSyncExternalStore(conversation.speaker.subscribe, conversation.speaker.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const visual = voicePresentation(state, speaker);
  if ((!state.active && !state.error) || (state.active && conversation.id !== sessionId)) return null;
  return <div className="dsh-voicebox-call-seat"><section className="dsh-voicebox-call-dock" aria-label="语音对话" data-expanded={expanded}>
    <div className="dsh-voicebox-call-toolbar">
      <div className="dsh-voicebox-call-presence">
        <VoiceOrb state={visual.orb} paused={visual.paused} speed={visual.speed} />
        <output title={visual.label} aria-live="polite">{visual.label}</output>
      </div>
      <div className="dsh-voicebox-call-actions">
      {state.active && <>
        <CallButton label={state.muted ? '取消静音' : '静音麦克风'} kind={state.muted ? 'muted' : 'mic'} aria-pressed={state.muted} onClick={() => conversation.mute()} />
        {state.phase === 'capturing' && <CallButton label="说完了，发送" kind="send" onClick={() => conversation.finishInput()} />}
        {['playing', 'paused'].includes(speaker.phase) && <CallButton label={conversation.speaker.userPaused ? '继续播放' : '暂停播放'} kind={conversation.speaker.userPaused ? 'play' : 'pause'} disabled={speaker.inputHeld} onClick={() => conversation.speaker.pause()} />}
        <CallButton label="打断并说话" kind="interrupt" disabled={!conversation.canTakeFloor()} onClick={() => conversation.takeFloor()} />
      </>}
      <CallButton label={expanded ? '收起语音详情' : '展开语音详情'} kind="details" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)} />
      {state.active ? <CallButton label="结束语音对话" kind="end" onClick={() => conversation.end()} /> : <CallButton label="关闭" kind="close" onClick={() => conversation.update({ error: '' })} />}
      </div>
    </div>
    {state.error && <p role="alert">{state.error}</p>}
    {state.plan?.limited && <output>讲解尚未完整，自动补充已达到保护限制；可指定需要继续的部分。</output>}
    <div id={detailsId} className="dsh-voicebox-call-details" hidden={!expanded}>
      {state.inputSignal && <div><p>麦克风输入：{inputSignalLabel(state.inputSignal)}</p>
        <meter aria-label="麦克风输入音量" min="0" max="100" value={Math.max(0, Math.min(100, (state.inputSignal.peakDb + 80) * 1.25))} />
      </div>}
      {!state.transcript && <p>转写与语音详情</p>}
      {state.transcript && <p className="dsh-voicebox-call-transcript">你说：{state.transcript}</p>}
      {state.notice && <p>{state.notice}</p>}
      <p>停顿后自动发送；正常短暂停顿会继续等待，也可点“说完了，发送”。</p>
      <p>语音识别：Whisper {state.recognitionModel === 'turbo' ? 'large-v3 turbo' : state.recognitionModel || conversation.settings().recognitionModel}</p>
      {state.plan && <p>当前讲解：{state.plan.total} 个内容单元，{state.plan.remaining} 个待补充解释。解释登记不等于已经播放。</p>}
      {state.active && conversation.settings().allowInterrupt && state.echoCancellation !== true && <p>设备未确认回声消除，播报时请使用“打断并说话”。</p>}
    </div>
  </section></div>;
}

export const CONVERSATION_CSS = `
.dsh-voicebox-call{display:inline-flex;align-items:center}
.dsh-voicebox-call-entry{display:inline-flex;align-items:center;gap:6px;height:32px;padding:5px 8px;font:inherit;color:inherit;border:0;border-radius:var(--dsw-alias-border-radius-sm,4px);background:transparent;cursor:pointer}
.dsh-voicebox-call-entry svg{width:18px;height:18px}
.dsh-voicebox-call-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-voicebox-call-entry:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.dsh-voicebox-call-seat{box-sizing:border-box;min-width:0;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px));max-width:var(--dsh-composer-card-max-width,100%);margin:0 auto}
.dsh-voicebox-call-dock{box-sizing:border-box;min-width:0;width:fit-content;max-width:100%;margin:0;padding:0;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;line-height:1.5}
.dsh-voicebox-call-toolbar{display:flex;align-items:center;gap:12px;min-height:44px;max-width:100%}
.dsh-voicebox-call-presence{display:flex;align-items:center;gap:6px;min-width:0;flex:1}
.dsh-voicebox-orb{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;flex:none;pointer-events:none}
.dsh-voicebox-call-presence>output{min-width:0;max-width:170px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-voicebox-call-dock p{margin:6px 0;overflow-wrap:anywhere}
.dsh-voicebox-call-actions{display:flex;align-items:center;gap:2px;flex:none}
.dsh-voicebox-call-actions .dsh-voicebox-call-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;margin:0;padding:7px;font:inherit;color:inherit;background:transparent;border:0;border-radius:var(--dsw-alias-border-radius-sm,4px);cursor:pointer}
.dsh-voicebox-call-button svg{width:18px;height:18px}
.dsh-voicebox-call-button[aria-expanded=true] svg{transform:rotate(180deg)}
.dsh-voicebox-call-button:hover,.dsh-voicebox-call-button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-voicebox-call-actions button:disabled{opacity:.45;cursor:default}
.dsh-voicebox-call-actions button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.dsh-voicebox-call-dock[data-expanded=true]{width:min(480px,100%)}
.dsh-voicebox-call-details{margin:4px 0 0 10px;padding:2px 0 2px 12px;border-left:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.3));max-height:180px;overflow:auto;color:var(--dsw-alias-label-secondary,inherit);overflow-wrap:anywhere}
.dsh-voicebox-call-transcript{max-height:100px;overflow:auto}
`;
