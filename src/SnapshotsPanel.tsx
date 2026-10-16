import { useCallback, useEffect, useState } from 'react';
import { Camera, Download, History, RefreshCw, Trash2 } from 'lucide-react';
import type { Environment, EnvironmentSnapshot } from '../shared/types.ts';
import { api } from './api.ts';
import { Button, Field, IconButton, Modal, Notice, SectionHeading, dateLabel } from './components.tsx';
import { BackupDialog } from './BackupDialog.tsx';
export function SnapshotsPanel({ environment, active, refresh }: { environment: Environment; active: boolean; refresh: () => Promise<void> }) {
  const [records, setRecords] = useState<EnvironmentSnapshot[]>([]);
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [restore, setRestore] = useState<EnvironmentSnapshot | null>(null);
  const [exporting, setExporting] = useState<EnvironmentSnapshot | null>(null);
  const update = useCallback(async () => setRecords(await api.snapshots(environment.id)), [environment.id]);
  useEffect(() => { void update().catch(e => setError(e.message)); const timer = setInterval(() => void update().catch(e => setError(e.message)), 3000); return () => clearInterval(timer); }, [update]);
  const disabled = busy || active || environment.browserRunning || !['stopped', 'error'].includes(environment.state);
  async function perform(action: 'create' | 'restore' | 'delete', record?: EnvironmentSnapshot) {
    setBusy(true); setError('');
    try {
      if (action === 'create') { await api.createSnapshot(environment.id, name.trim()); setName(''); }
      else if (action === 'restore') { await api.restoreSnapshot(environment.id, record!.id); setRestore(null); }
      else await api.deleteSnapshot(environment.id, record!.id);
      await update(); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="panel-width"><SectionHeading title="Linux 快照" action={<IconButton title="刷新快照" onClick={() => void update()}><RefreshCw size={17} /></IconButton>} />
    <Field label="快照名称"><div className="input-action"><input value={name} maxLength={60} disabled={disabled} onChange={e => setName(e.target.value)} /><Button icon={<Camera size={16} />} className="primary" disabled={disabled || !name.trim()} onClick={() => void perform('create')}>创建快照</Button></div></Field>
    <dl className="facts"><div><dt>保存范围</dt><dd>Linux 磁盘与环境配置</dd></div><div><dt>共享项目文件</dt><dd>保留本机当前内容</dd></div><div><dt>Linux 浏览器资料</dt><dd>随磁盘保存</dd></div><div><dt>旧本机浏览器资料</dt><dd>不包含</dd></div></dl>
    <section className="network-test">{records.length ? records.map(record => <div className="job-row" key={record.id}><Camera size={18} /><div className="job-main"><strong>{record.name}</strong><small>{dateLabel(record.createdAt)} · {(record.bytes / 2 ** 30).toFixed(1)} GB 逻辑大小</small></div><IconButton title={`导出 ${record.name}`} disabled={busy || active} onClick={() => setExporting(record)}><Download size={17} /></IconButton><IconButton title={`恢复 ${record.name}`} disabled={disabled} onClick={() => setRestore(record)}><History size={17} /></IconButton><IconButton title={`删除快照 ${record.name}`} disabled={busy || active} onClick={() => void perform('delete', record)}><Trash2 size={16} /></IconButton></div>) : <div className="log-empty">暂无快照</div>}</section>
    {error && <Notice kind="error">{error}</Notice>}
    {restore && <Modal title={`恢复「${restore.name}」？`} narrow onClose={() => setRestore(null)}><div className="modal-body"><Notice>Linux 磁盘和配置将恢复到此快照。共享项目文件保持当前内容。</Notice></div><footer className="modal-footer"><Button onClick={() => setRestore(null)}>取消</Button><Button icon={<History size={16} />} className="primary" loading={busy} onClick={() => void perform('restore', restore)}>恢复</Button></footer></Modal>}
    {exporting && <BackupDialog snapshot={exporting} onClose={() => setExporting(null)} onSubmitted={refresh} />}
  </div>;
}
