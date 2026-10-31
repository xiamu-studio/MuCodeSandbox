import { useRef, useState } from 'react';
import { Button, Notice } from './components.tsx';
import { request } from './api.ts';
import type { TranslationSettingsStatus } from '../shared/translation.ts';

export default function TranslationSettings({onSaved,hostName='Mac'}:{onSaved?:()=>void;hostName?:'Mac'|'Windows'}) {
  const [open,setOpen] = useState(false);
  const [status, setStatus] = useState<TranslationSettingsStatus | null>(null);
  const [key, setKey] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const working = useRef(false);
  const deadline = () => hostName === 'Windows' ? AbortSignal.timeout(10000) : undefined;
  async function load() {
    if (working.current) return;
    working.current=true; setBusy(true); setError('');
    try { setStatus(await request<TranslationSettingsStatus>('/translation-settings',{signal:deadline()})); }
    catch { setStatus(null); setError('无法读取翻译设置，请重新展开重试。'); }
    finally { working.current=false; setBusy(false); }
  }
  async function save(clear = false) {
    if (working.current) return;
    if (!clear && !/^[A-Za-z0-9_-]{20,256}$/.test(key.trim())) { setError('请输入有效的 DeepSeek API Key。'); return; }
    working.current=true; setBusy(true); setError(''); setMessage('');
    try {
      const next = await request<TranslationSettingsStatus>('/translation-settings', clear ? { method: 'DELETE',signal:deadline() } : { method: 'POST', body: JSON.stringify({ apiKey: key.trim() }),signal:deadline() });
      setStatus(next); setKey('');
      if(clear)setMessage('已移除本机翻译 Key。');
      else{setMessage('');setOpen(false);onSaved?.();}
    } catch { setStatus(null); setError('翻译设置结果未确认，请收起后重新展开以核对状态。'); }
    finally { working.current=false; setBusy(false); }
  }
  return <details className="guest-translation-settings" open={open} onToggle={event => { setOpen(event.currentTarget.open);if (event.currentTarget.open) void load(); else setKey(''); }}>
    <summary>翻译设置{status ? status.configured ? ' · 已配置' : ' · 未配置' : ''}</summary>
    <div className="guest-translation-settings-body">
      <label>DeepSeek API Key<input aria-label="DeepSeek API Key" type="password" autoComplete="off" spellCheck={false} maxLength={256} value={key} disabled={busy} placeholder={status?.configured ? '已保存，填写新 Key 可替换' : '仅在本机填写，不要发聊天'} onChange={event => setKey(event.target.value)} /></label>
      <div className="guest-input-actions"><Button disabled={busy || !key.trim()} onClick={() => void save()}>保存 Key</Button><Button disabled={busy || !status?.configured} onClick={() => void save(true)}>移除 Key</Button></div>
      <p>使用你的 API 额度，Flash 非思考模式。Key 加密保存在此 {hostName}，供本应用的翻译工具使用，不随环境备份导出；不会回显或自动测试。请求经过当前沙箱网络。</p>
      {error && <Notice kind="error">{error}</Notice>}{message && <p role="status">{message}</p>}
    </div>
  </details>;
}
