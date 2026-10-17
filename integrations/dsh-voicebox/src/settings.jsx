import { useEffect, useState, useSyncExternalStore } from 'react';
import { speechFetch } from './controller.js';
import { saveSettings } from './settings.js';

const LANGUAGES = [['', '跟随声音档案'], ['zh', '中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'], ['ru', 'Русский'], ['pt', 'Português'], ['es', 'Español'], ['it', 'Italiano']];
const defaults = { endpoint: 'http://127.0.0.1:17493', clientId: 'dsh-voicebox', profile: '', language: '', modelSize: '0.6B', readingMode: 'complete', sessionIds: [] };

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
      controller.stop();
      await saveSettings(form, draft, revision);
      setDirty(false); setMessage('已保存，下次朗读使用新设置');
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };
  const unavailable = state.status !== 'ready' || !state.writable;
  const unknownProfile = draft.profile && !profiles.some(profile => profile.id === draft.profile);
  return <form className="dsh-voicebox-config" onSubmit={save} aria-label="Voicebox 语音配置">
    <h3>语音播报设置</h3>
    <p>设置保存在 DSH 当前配置中，供各会话的手动朗读和自动播报共用。</p>
    <fieldset disabled={unavailable || busy}>
      <label htmlFor="voicebox-reading-mode">自动播报方式</label>
      <select id="voicebox-reading-mode" value={draft.readingMode} onChange={event => edit('readingMode', event.target.value)}>
        <option value="complete">完整回复后朗读</option>
        <option value="streaming">边回答边读</option>
      </select>
      <small>边回答边读按正文分句播放，跳过推理和工具参数；发生重试时停止本轮播报。会话内仍需开启自动播报。</small>
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
.dsh-voicebox-config fieldset{border:0;padding:0;margin:16px 0;min-width:0}
.dsh-voicebox-config label{display:block;font-size:13px;margin:18px 0 8px}
.dsh-voicebox-config select,.dsh-voicebox-config input,.dsh-voicebox-config textarea{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.4));border-radius:var(--dsw-alias-border-radius-sm,4px);font:inherit;color:inherit;background:var(--dsw-alias-background-primary,transparent)}
.dsh-voicebox-config small{display:block;margin-top:6px}
.dsh-voicebox-config button{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:var(--dsw-alias-border-radius-sm,4px);padding:7px 12px;cursor:pointer;white-space:nowrap}
.dsh-voicebox-config button:disabled{opacity:.4;cursor:default}
.dsh-voicebox-config-row,.dsh-voicebox-config-actions{display:flex;gap:8px;align-items:center}
.dsh-voicebox-config-row select{min-width:0;flex:1}
.dsh-voicebox-config details{margin-top:22px}.dsh-voicebox-config summary{cursor:pointer;font-size:13px}
.dsh-voicebox-config-actions{margin-top:24px}.dsh-voicebox-config-actions button:first-child{font-weight:600}
`;
