import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { speechFetch } from './controller.js';
import { saveSettings } from './settings.js';
import { VOICE_DEFAULTS } from './conversation.js';

const LANGUAGES = [['', '跟随声音档案'], ['zh', '中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'], ['ru', 'Русский'], ['pt', 'Português'], ['es', 'Español'], ['it', 'Italiano']];
const defaults = { endpoint: 'http://127.0.0.1:17493', clientId: 'dsh-voicebox', profile: '', language: '', modelSize: '0.6B', readingMode: 'complete', speechMode: 'realtime', sessionIds: [], ...VOICE_DEFAULTS };

export function VoiceboxSettings({ form, controller, view }) {
  const state = useSyncExternalStore(fn => form.subscribe(fn), () => form.getSnapshot());
  const [draft, setDraft] = useState(() => ({ ...defaults, ...state.value }));
  const [sessionText, setSessionText] = useState(() => (state.value?.sessionIds || []).join('\n'));
  const [revision, setRevision] = useState(state.revision);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [profiles, setProfiles] = useState([]);
  const [profileError, setProfileError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [microphones, setMicrophones] = useState([]);
  const [checking, setChecking] = useState(false);
  const [diagnostics, setDiagnostics] = useState(null);
  const installationCheck = useRef(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a saved revision invalidates every check against the previous configuration.
  useEffect(() => {
    installationCheck.current?.abort(); setChecking(false); setDiagnostics(null);
    return () => installationCheck.current?.abort();
  }, [state.revision, view]);
  useEffect(() => {
    if (view === 'summary' || !navigator.mediaDevices?.enumerateDevices) return;
    let disposed = false;
    const refreshDevices = () => { void navigator.mediaDevices.enumerateDevices().then(devices => { if (!disposed) setMicrophones(devices.filter(device => device.kind === 'audioinput')); }).catch(() => {}); };
    refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    return () => { disposed = true; navigator.mediaDevices.removeEventListener('devicechange', refreshDevices); };
  }, [view]);
  useEffect(() => {
    if (!dirty && !busy && state.value) { setDraft({ ...defaults, ...state.value }); setSessionText((state.value.sessionIds || []).join('\n')); setRevision(state.revision); }
  }, [state.value, state.revision, dirty, busy]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh and the saved endpoint intentionally invalidate the host-proxied request.
  useEffect(() => {
    if (view === 'summary') return;
    const abort = new AbortController();
    setLoadingProfiles(true); setProfileError('');
    speechFetch('http://voicebox.invalid/profiles', { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || '读取声音档案失败'); return data; })
      .then(data => { if (!abort.signal.aborted) setProfiles(data); })
      .catch(error => { if (!abort.signal.aborted) { setProfiles([]); setProfileError(error.message); } })
      .finally(() => { if (!abort.signal.aborted) setLoadingProfiles(false); });
    return () => abort.abort();
  }, [refresh, state.value?.endpoint, view]);
  if (view === 'summary') return <p>使用本地 Voicebox 模型和声音档案朗读 AI 回复。</p>;
  const edit = (field, value) => { setDraft(previous => ({ ...previous, [field]: value })); setDirty(true); setMessage(''); };
  const discard = () => { setDirty(false); setDraft({ ...defaults, ...state.value }); setSessionText((state.value?.sessionIds || []).join('\n')); setRevision(state.revision); setMessage(''); };
  const save = async event => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      controller.conversation?.end();
      controller.stop();
      await saveSettings(form, draft, revision);
      setDirty(false); setMessage('已保存，下次朗读使用新设置');
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };
  const unavailable = state.status !== 'ready' || !state.writable;
  const unknownProfile = draft.profile && !profiles.some(profile => profile.id === draft.profile);
  const check = async () => {
    installationCheck.current?.abort();
    const abort = new AbortController(); installationCheck.current = abort;
    setChecking(true); setDiagnostics(null);
    try {
      const response = await speechFetch('http://voicebox.invalid/diagnostics', { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(16_000)]) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '安装检查失败，请稍后重试。');
      if (!abort.signal.aborted) setDiagnostics(data);
    } catch (error) {
      if (!abort.signal.aborted) setDiagnostics({ status: 'error', checks: [{ id: 'connection', status: 'error', message: error.message }] });
    } finally { if (!abort.signal.aborted) setChecking(false); }
  };
  const exportDiagnostics = () => {
    const snapshot = controller.diagnostics.snapshot();
    const data = JSON.stringify(snapshot, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'dsh-voicebox-diagnostics.json';
    try {
      document.body.append(link); link.click();
      setMessage(`已请求导出 ${snapshot.retained} 条诊断记录${snapshot.dropped ? `，省略 ${snapshot.dropped} 条较早记录` : ''}。自上次清空以来，完成 ${snapshot.counts['pcm.completed'] || 0} 段播放，检测到 ${snapshot.counts['pcm.underrun'] || 0} 次已恢复的音频空档。`);
    }
    finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  };
  return <form className="dsh-voicebox-config" onSubmit={save} aria-label="Voicebox 语音配置">
    <h3>语音播报设置</h3>
    <p>设置保存在 DSH 当前配置中，供各会话的手动朗读和自动播报共用。</p>
    <div className="dsh-voicebox-installation">
      <button type="button" onClick={check} disabled={unavailable || busy || dirty || checking}>{checking ? '检查中…' : '检查安装条件'}</button>
      <small>{dirty ? '请先保存设置，再检查新配置。' : '检查已保存设置；不会开启麦克风、合成语音或下载模型。'}</small>
      {diagnostics && <div aria-live="polite" aria-atomic="true"><p>{diagnostics.status === 'pass' ? '安装条件检查通过，接下来可试播并测试麦克风。' : diagnostics.status === 'warning' ? '检查完成，以下条件需要确认。' : '以下条件需要处理。'}</p>
        <ul>{diagnostics.checks.map(item => <li key={item.id}><strong>{item.status === 'pass' ? '通过' : item.status === 'warning' ? '待确认' : '需处理'}</strong>：{item.message}</li>)}</ul>
      </div>}
    </div>
    <fieldset disabled={unavailable || busy}>
      <label htmlFor="voicebox-reading-mode">自动播报方式</label>
      <select id="voicebox-reading-mode" value={draft.readingMode} onChange={event => edit('readingMode', event.target.value)}>
        <option value="complete">完整回复后朗读</option>
        <option value="streaming">边回答边读</option>
      </select>
      <small>边回答边读按正文分句播放，跳过推理和工具参数；发生重试时停止本轮播报。会话内仍需开启自动播报。</small>
      <label htmlFor="voicebox-speech-mode">语音输出策略</label>
      <select id="voicebox-speech-mode" value={draft.speechMode} onChange={event => edit('speechMode', event.target.value)}>
        <option value="realtime">低延迟流式（默认）</option>
        <option value="checked">整段检查后播放</option>
      </select>
      <small>低延迟模式边合成边播，保留采样、时长和重复控制，但不能提前排除全部变形。整段检查额外核对音频与原文，需要等待，可能增加首声延迟和段间停顿。</small>
      <label htmlFor="voicebox-model">语音模型</label>
      <select id="voicebox-model" value={draft.modelSize} onChange={event => edit('modelSize', event.target.value)}>
        <option value="0.6B">Qwen3-TTS Base · 0.6B（响应更快）</option>
        <option value="1.7B">Qwen3-TTS Base · 1.7B（更大模型）</option>
      </select>
      <small>使用 Voicebox 已配置的 Qwen Base 流式引擎；模型须在 Voicebox 中下载完成。</small>
      <label htmlFor="voicebox-profile">声音档案</label>
      <div className="dsh-voicebox-config-row"><select id="voicebox-profile" value={draft.profile} onChange={event => edit('profile', event.target.value)}>
        <option value="">跟随 Voicebox 客户端绑定 / 默认声音</option>
        {unknownProfile && <option value={draft.profile}>{draft.profile}（当前配置，未在列表中找到）</option>}
        {profiles.map(profile => <option key={profile.id} value={profile.id} disabled={!profile.compatible}>{profile.name} · {profile.language}{!profile.compatible ? '（不适用 Qwen Base）' : ''}</option>)}
      </select><button type="button" disabled={loadingProfiles} onClick={() => setRefresh(value => value + 1)}>{loadingProfiles ? '读取中…' : '刷新档案'}</button></div>
      <small>档案来自已保存的后端地址；克隆声音可用于当前引擎。</small>
      {profileError && <p role="alert">声音档案读取失败：{profileError}</p>}
      <label htmlFor="voicebox-language">朗读语言</label>
      <select id="voicebox-language" value={draft.language} onChange={event => edit('language', event.target.value)}>
        {draft.language && !LANGUAGES.some(([code]) => code === draft.language) && <option value={draft.language}>{draft.language}</option>}
        {LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
      </select>
      <details><summary>语音对话与麦克风</summary>
        <label htmlFor="voicebox-recognition-model">识别模型</label>
        <select id="voicebox-recognition-model" value={draft.recognitionModel} onChange={event => edit('recognitionModel', event.target.value)}>
          <option value="turbo">Whisper large-v3 turbo（默认）</option>
          <option value="large">Whisper large-v3</option>
          <option value="medium">Whisper medium</option><option value="small">Whisper small</option>
          <option value="base">Whisper base（小模型，优先节省资源）</option>
        </select>
        <small>请先在 Voicebox 下载模型。语音模式等待停顿后自动发送，每段最长约 60 秒；说话中的短暂停顿会继续等待，尚不提供边说边显示转写。</small>
        <label htmlFor="voicebox-recognition-language">识别语言</label>
        <select id="voicebox-recognition-language" value={draft.recognitionLanguage} onChange={event => edit('recognitionLanguage', event.target.value)}>
          {draft.recognitionLanguage && !LANGUAGES.some(([code]) => code === draft.recognitionLanguage) && <option value={draft.recognitionLanguage}>{draft.recognitionLanguage}</option>}
          {LANGUAGES.map(([code, label]) => <option key={code} value={code}>{code ? label : '自动检测'}</option>)}
        </select>
        <label htmlFor="voicebox-recognition-script">中文识别文字</label>
        <select id="voicebox-recognition-script" value={draft.recognitionScript} onChange={event => edit('recognitionScript', event.target.value)}>
          <option value="simplified">简体中文</option><option value="original">保留识别原样</option>
        </select>
        <small>识别语言为中文时，发送给 AI 前统一简繁体；不会改写听错的词。其他语言与自动检测保留原样。</small>
        <label htmlFor="voicebox-microphone">麦克风</label>
        <select id="voicebox-microphone" value={draft.microphoneId} onChange={event => edit('microphoneId', event.target.value)}>
          <option value="">系统默认麦克风</option>
          {draft.microphoneId && !microphones.some(device => device.deviceId === draft.microphoneId) && <option value={draft.microphoneId}>已保存的麦克风（当前不可见）</option>}
          {microphones.filter(device => device.deviceId && device.deviceId !== 'default').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `麦克风 ${index + 1}`}</option>)}
        </select>
        <label htmlFor="voicebox-patience">停顿耐心</label>
        <select id="voicebox-patience" value={draft.patience} onChange={event => edit('patience', event.target.value)}>
          <option value="fast">响应快 · 约 1.2 秒</option><option value="balanced">均衡 · 约 2.4 秒</option><option value="patient">耐心 · 约 4 秒</option>
        </select>
        <label className="dsh-voicebox-config-check"><input type="checkbox" checked={draft.allowInterrupt} onChange={event => edit('allowInterrupt', event.target.checked)} />允许说话打断（实验）</label>
        <small>开口后先暂停播报，识别到新内容再取消旧回答；空识别或明确匹配的回声保留原回答。设备未确认回声消除时，播报期间使用“打断并说话”。回声判断并不可靠，建议使用耳机；已执行的工具操作不会因停止回答而撤销。</small>
        <label className="dsh-voicebox-config-check"><input type="checkbox" checked={draft.backgroundListening} onChange={event => edit('backgroundListening', event.target.checked)} />允许后台监听</label>
        <small>开启后，切换窗口仍可继续对话。关闭时，窗口失焦只暂停麦克风输入，已有播报仍会继续。结束语音会话会释放麦克风。</small>
      </details>
      <details><summary>连接与会话范围</summary>
        <label htmlFor="voicebox-endpoint">Voicebox 后端地址</label>
        <input id="voicebox-endpoint" type="url" required value={draft.endpoint} onChange={event => edit('endpoint', event.target.value)} />
        <label htmlFor="voicebox-client">客户端标识</label>
        <input id="voicebox-client" required value={draft.clientId} onChange={event => edit('clientId', event.target.value)} />
        <small>用于解析 Voicebox 中绑定的默认声音。</small>
        <label htmlFor="voicebox-sessions">会话白名单</label>
        <textarea id="voicebox-sessions" rows={2} value={sessionText} onChange={event => { setSessionText(event.target.value); edit('sessionIds', event.target.value.split('\n').map(id => id.trim()).filter(Boolean)); }} placeholder="留空允许全部普通会话；每行一个会话 ID" />
      </details>
      <div className="dsh-voicebox-config-actions"><button type="submit" disabled={!dirty || loadingProfiles || profiles.some(profile => profile.id === draft.profile && !profile.compatible)}>{busy ? '保存中…' : '保存设置'}</button><button type="button" disabled={!dirty} onClick={discard}>放弃修改</button></div>
    </fieldset>
    <details><summary>本地语音诊断</summary>
      <p>记录首包、播放、缓冲、识别与插话的技术时序，最近最多保留 512 条，仅存在当前窗口内存中。清空、刷新或退出后移除。</p>
      <small>不含录音、转写、回复正文、会话与声音标识、设备名称或服务地址。导出后由你决定是否分享；播放时序不等于扬声器实际出声时间。</small>
      <div className="dsh-voicebox-config-actions"><button type="button" onClick={exportDiagnostics}>导出诊断</button><button type="button" onClick={() => { controller.diagnostics.clear(); controller.recordSettings(); setMessage('本地诊断已清空。'); }}>清空诊断</button></div>
    </details>
    {unavailable && <output>{state.status === 'loading' ? '正在读取插件配置…' : '当前配置不可写，请先启用 Voicebox 插件。'}</output>}
    {dirty && state.revision !== revision && <p role="alert">配置已在其他位置更新，请放弃修改后重新编辑。</p>}
    {message && <output>{message}</output>}
  </form>;
}

export const SETTINGS_CSS = `
.dsh-voicebox-config{max-width:680px;color:inherit;font:inherit}
.dsh-voicebox-config h3{margin:0 0 8px;font-size:16px}
.dsh-voicebox-config p,.dsh-voicebox-config small{font-size:12px;line-height:1.6;opacity:.8}
.dsh-voicebox-config>output{display:block;margin:12px 0;font-size:12px;line-height:1.6}
.dsh-voicebox-installation{margin:16px 0;padding-block:12px;border-block:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.4))}
.dsh-voicebox-installation ul{padding-left:20px;font-size:12px;line-height:1.8}
.dsh-voicebox-config fieldset{border:0;padding:0;margin:16px 0;min-width:0}
.dsh-voicebox-config label{display:block;font-size:13px;margin:18px 0 8px}
.dsh-voicebox-config select,.dsh-voicebox-config input,.dsh-voicebox-config textarea{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.4));border-radius:var(--dsw-alias-border-radius-sm,4px);font:inherit;color:inherit;background:var(--dsw-alias-background-primary,transparent)}
.dsh-voicebox-config small{display:block;margin-top:6px}
.dsh-voicebox-config .dsh-voicebox-config-check{display:flex;gap:8px;align-items:center}.dsh-voicebox-config-check input[type=checkbox]{width:auto}
.dsh-voicebox-config button{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:var(--dsw-alias-border-radius-sm,4px);padding:7px 12px;cursor:pointer;white-space:nowrap}
.dsh-voicebox-config button:disabled{opacity:.4;cursor:default}
.dsh-voicebox-config-row,.dsh-voicebox-config-actions{display:flex;gap:8px;align-items:center}
.dsh-voicebox-config-row select{min-width:0;flex:1}
.dsh-voicebox-config details{margin-top:22px}.dsh-voicebox-config summary{cursor:pointer;font-size:13px}
.dsh-voicebox-config-actions{margin-top:24px}.dsh-voicebox-config-actions button:first-child{font-weight:600}
`;
