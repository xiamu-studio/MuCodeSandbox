import { useState } from 'react';
import { Download, FolderOpen, Upload } from 'lucide-react';
import type { EnvironmentSnapshot } from '../shared/types.ts';
import { api } from './api.ts';
import { Button, Field, IconButton, Modal, Notice } from './components.tsx';

export function BackupDialog({ snapshot, onClose, onSubmitted }: { snapshot?: EnvironmentSnapshot; onClose: () => void; onSubmitted: () => Promise<void> }) {
  const exporting = Boolean(snapshot);
  const [file, setFile] = useState('');
  const [name, setName] = useState('导入的环境');
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function pick() {
    try { const result = await api.pickBackup(exporting ? 'save' : 'open'); if (result.path) setFile(result.path); }
    catch (e) { setError((e as Error).message); }
  }
  async function submit() {
    setBusy(true); setError('');
    try {
      if (snapshot) await api.exportBackup(snapshot.environmentId, snapshot.id, file, password);
      else await api.importBackup(file, password, name.trim());
      setPassword(''); setConfirmation('');
      await onSubmitted(); onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const valid = file.startsWith('/') && file.endsWith('.mu-backup') && password.length >= 12 && password.length <= 256 && (exporting ? password === confirmation : Boolean(name.trim()));
  return <Modal title={exporting ? '导出加密备份' : '导入加密备份'} narrow onClose={() => { if (!busy) onClose(); }}>
    <div className="modal-body">
      {snapshot && <dl className="facts"><div><dt>快照</dt><dd>{snapshot.name}</dd></div></dl>}
      <Field label="备份文件"><div className="input-action"><input aria-label="备份文件路径" value={file} disabled={busy} onChange={event => setFile(event.target.value)} placeholder="/Users/.../environment.mu-backup" /><IconButton title={exporting ? '选择保存位置' : '选择备份文件'} disabled={busy} onClick={() => void pick()}><FolderOpen size={18} /></IconButton></div></Field>
      {!exporting && <Field label="新环境名称"><input value={name} maxLength={60} disabled={busy} onChange={event => setName(event.target.value)} /></Field>}
      <Field label="备份密码（至少 12 个字符）"><input aria-label="备份密码" type="password" autoComplete={exporting ? 'new-password' : 'off'} value={password} maxLength={256} disabled={busy} onChange={event => setPassword(event.target.value)} /></Field>
      {exporting && <Field label="确认密码"><input type="password" autoComplete="new-password" value={confirmation} maxLength={256} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></Field>}
      <Notice>{exporting ? '包含 Linux 磁盘、浏览器资料及网络凭据。密码无法找回。' : '创建独立的新环境；原电脑的目录共享、端口映射及宿主授权不会继承。'}</Notice>
      {error && <Notice kind="error">{error}</Notice>}
    </div>
    <footer className="modal-footer"><Button disabled={busy} onClick={onClose}>取消</Button><Button className="primary" icon={exporting ? <Download size={16} /> : <Upload size={16} />} loading={busy} disabled={!valid} onClick={() => void submit()}>{exporting ? '导出备份' : '导入备份'}</Button></footer>
  </Modal>;
}
