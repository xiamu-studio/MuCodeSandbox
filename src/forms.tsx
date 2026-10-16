import { useState } from 'react';
import { Box, Globe, FolderPlus, FolderOpen, Trash2, Plus, Save, ArrowRight, ShieldCheck } from 'lucide-react';
import type { Environment, Mount, NetworkConfig, PortForward, SystemInfo, IdentityConfig } from '../shared/types.ts';
import { api, editConfig } from './api.ts';
import { Button, Field, IconButton, Modal, Notice, SectionHeading } from './components.tsx';

export function MountEditor({ mounts, onChange, disabled = false }: { mounts: Mount[]; onChange: (mounts: Mount[]) => void; disabled?: boolean }) {
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);
  const patch = (id: string, update: Partial<Mount>) => onChange(mounts.map(m => m.id === id ? { ...m, ...update } : m));
  const add = () => onChange([...mounts, { id: crypto.randomUUID(), hostPath: '', guestPath: `/workspace/project${mounts.length ? `-${mounts.length + 1}` : ''}`, writable: false }]);
  async function pick(id: string) {
    setPicking(true); setError('');
    try { const result = await api.pickDirectory(); if (result.path) patch(id, { hostPath: result.path }); }
    catch (error) { setError((error as Error).message); }
    finally { setPicking(false); }
  }
  return <div className="mount-editor">
    {mounts.map(m => <div className="mount-row" key={m.id}>
      <div className="mount-fields"><Field label="本机项目目录"><div className="input-action"><input aria-label="本机项目目录" value={m.hostPath} disabled={disabled} placeholder="/Users/你的用户名/Projects/my-project" onChange={e => patch(m.id, { hostPath: e.target.value })} /><IconButton title="选择目录" disabled={disabled || picking} onClick={() => void pick(m.id)}><FolderOpen size={17} /></IconButton></div></Field><span className="mount-arrow"><ArrowRight size={17} /></span><Field label="沙箱目录"><input aria-label="沙箱目录" value={m.guestPath} disabled={disabled} onChange={e => patch(m.id, { guestPath: e.target.value })} /></Field></div>
      <div className="mount-options"><label className="check-label"><input type="checkbox" checked={m.writable} disabled={disabled} onChange={e => patch(m.id, { writable: e.target.checked })} />允许修改本机文件</label><span className={`permission ${m.writable ? 'write' : ''}`}>{m.writable ? '读写' : '只读'}</span><IconButton title="移除目录" disabled={disabled} onClick={() => onChange(mounts.filter(other => other.id !== m.id))}><Trash2 size={15} /></IconButton></div>
    </div>)}
    <Button icon={<FolderPlus size={16} />} disabled={disabled || mounts.length >= 16} onClick={add} className="subtle">添加项目目录</Button>
    {error && <Notice kind="error">{error}</Notice>}
  </div>;
}

export function networkEditorError(value: NetworkConfig, guest: boolean, wireguardKeyConfigured = false) {
  if (value.egressLock && (!guest || !value.strict || !value.transparent || !value.egressLock.expectedIp.trim())) return '出口变化停机需要 Linux 透明代理和明确批准的 IPv4 地址。';
  if (value.mode === 'wireguard') {
    if (!guest) return '整包隧道需要 Linux 沙箱，请切换环境类型或网络模式。';
    if (!value.strict || !value.transparent) return '整包隧道必须启用 Linux 防火墙和受控路由。';
    if (!value.wireguard?.peerPublicKey.trim()) return '请填写隧道对端公钥。';
    if (!value.wireguard.privateKey && !wireguardKeyConfigured) return '请填写隧道私钥。';
    return '';
  }
  if (value.mode !== 'https') return '';
  if (!guest) return 'HTTPS 加密代理需要 Linux 沙箱，请切换环境类型或网络模式。';
  if (!value.strict || !value.transparent) return 'HTTPS 加密代理需要同时启用 Linux 防火墙和透明代理。';
  if (!value.tls?.serverName.trim()) return '请填写代理证书的服务器名称。';
  return '';
}

export function NetworkEditor({ value, onChange, disabled = false, passwordConfigured = false, wireguardKeyConfigured = false, guest = false }: { value: NetworkConfig; onChange: (n: NetworkConfig) => void; disabled?: boolean; passwordConfigured?: boolean; wireguardKeyConfigured?: boolean; guest?: boolean }) {
  const patch = (change: Partial<NetworkConfig>) => onChange({ ...value, ...change });
  const dns = value.dns ?? { address: '1.1.1.1', serverName: 'cloudflare-dns.com', port: 443, path: '/dns-query' };
  const encrypted = value.mode === 'https';
  const packet = value.mode === 'wireguard';
  const wireguard = value.wireguard ?? { address: '10.0.0.2/32', peerPublicKey: '', listenPort: 51821, mtu: 1420 };
  const tls = value.tls ?? { serverName: '' };
  function mode(mode: NetworkConfig['mode']) {
    const locked = mode === 'https' || mode === 'wireguard';
    patch({ mode, strict: mode === 'direct' ? false : locked ? true : value.strict,
      transparent: mode === 'direct' ? false : locked ? true : value.transparent,
      noProxy: locked ? 'localhost,127.0.0.1,::1' : value.noProxy,
      ...(mode === 'wireguard' ? { username: '', password: undefined, host: '', port: 51820 } : {}),
      wireguard: mode === 'wireguard' ? wireguard : undefined,
      tls: mode === 'https' ? tls : undefined, egressLock: mode === 'direct' ? undefined : value.egressLock });
  }
  return <div className="network-editor">
    <div className="segmented" aria-label="网络模式" style={{ flexWrap: 'wrap' }}>{([{ mode: 'direct', label: '直连' }, { mode: 'http', label: 'HTTP 代理' }, { mode: 'https', label: 'HTTPS 代理' }, { mode: 'socks5', label: 'SOCKS5 代理' }, { mode: 'wireguard', label: 'WireGuard · 测试' }] as const).map(option => <button key={option.mode} type="button" className={value.mode === option.mode ? 'selected' : ''} disabled={disabled || (['https','wireguard'].includes(option.mode) && !guest)} title={['https','wireguard'].includes(option.mode) && !guest ? '仅支持 Linux 沙箱' : undefined} onClick={() => mode(option.mode)}>{option.label}</button>)}</div>
    {encrypted && !guest && <Notice kind="error">HTTPS 加密代理需要 Linux 沙箱，请切换环境类型或网络模式。</Notice>}
    {packet && !guest && <Notice kind="error">整包隧道需要 Linux 沙箱，请切换环境类型或网络模式。</Notice>}
    {value.mode !== 'direct' && <>
      <div className="form-grid"><Field label={packet ? '隧道端点 IPv4' : '代理服务器'}><input aria-label={packet ? '隧道端点 IPv4' : '代理服务器'} value={value.host} disabled={disabled} placeholder={packet ? '提供商给出的端点 IPv4' : 'proxy.example.com 或 127.0.0.1'} onChange={e => patch({ host: e.target.value })} /></Field><Field label="端口"><input type="number" min="1" max="65535" value={value.port} disabled={disabled} onChange={e => patch({ port: Number(e.target.value) })} /></Field></div>
      {packet ? <><div className="form-grid"><Field label="隧道 IPv4 /32"><input aria-label="隧道 IPv4 /32" value={wireguard.address} disabled={disabled} spellCheck={false} onChange={e => patch({wireguard:{...wireguard,address:e.target.value}})} /></Field><Field label="本地 UDP 端口"><input aria-label="本地 UDP 端口" type="number" min="1" max="65535" value={wireguard.listenPort} disabled={disabled} onChange={e => patch({wireguard:{...wireguard,listenPort:Number(e.target.value)}})} /></Field></div><Field label="对端公钥"><input aria-label="对端公钥" className="mono" value={wireguard.peerPublicKey} disabled={disabled} autoComplete="off" spellCheck={false} onChange={e => patch({wireguard:{...wireguard,peerPublicKey:e.target.value}})} /></Field><Field label="隧道私钥"><input aria-label="隧道私钥" type="password" value={wireguard.privateKey ?? ''} disabled={disabled} autoComplete="new-password" spellCheck={false} placeholder={wireguardKeyConfigured ? '已保存，留空保持原密钥' : '私钥'} onChange={e => patch({wireguard:{...wireguard,privateKey:e.target.value || undefined}})} /></Field><Field label="MTU"><input aria-label="MTU" type="number" min="1280" max="1420" value={wireguard.mtu} disabled={disabled} onChange={e => patch({wireguard:{...wireguard,mtu:Number(e.target.value)}})} /></Field></> : <div className="form-grid"><Field label="用户名"><input autoComplete="off" value={value.username} disabled={disabled} onChange={e => patch({ username: e.target.value })} placeholder="可选" /></Field><Field label="密码"><input type="password" autoComplete="new-password" value={value.password ?? ''} disabled={disabled} onChange={e => patch({ password: e.target.value })} placeholder={passwordConfigured ? '已保存，留空保持原密码' : '可选'} /></Field></div>}
      {encrypted && <><Field label="代理证书服务器名称" hint="代理提供商给出的证书域名"><input aria-label="代理证书服务器名称" required value={tls.serverName} disabled={disabled} autoComplete="off" spellCheck={false} placeholder="proxy.example.com" onChange={e => patch({ tls: { ...tls, serverName: e.target.value } })} /></Field><Field label="自定义可信 CA 证书（可选）" hint="留空使用系统认可的证书"><textarea aria-label="自定义可信 CA 证书（可选）" className="mono" rows={4} maxLength={16384} value={tls.certificate ?? ''} disabled={disabled} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" onChange={e => patch({ tls: { ...tls, certificate: e.target.value || undefined } })} /></Field></>}
      {guest && <label className="check-label"><input type="checkbox" checked={value.strict} disabled={disabled || encrypted || packet} onChange={e => patch({ strict: e.target.checked, transparent: e.target.checked && value.transparent, egressLock: e.target.checked ? value.egressLock : undefined, noProxy: e.target.checked ? 'localhost,127.0.0.1,::1' : value.noProxy })} />{packet ? '强制隧道联网（Linux 防火墙）' : '仅代理联网（Linux 防火墙）'}</label>}
      {guest && value.strict && !packet && <div className="segmented" aria-label="代理接管方式"><button type="button" className={!value.transparent ? 'selected' : ''} disabled={disabled || encrypted} onClick={() => patch({ transparent: false, egressLock: undefined })}>应用代理</button><button type="button" className={value.transparent ? 'selected' : ''} disabled={disabled || encrypted} onClick={() => patch({ transparent: true })}>透明代理</button></div>}
      {guest && value.transparent && <><div className="form-divider"><h3>加密 DNS</h3></div><div className="form-grid"><Field label="DNS 服务地址"><input aria-label="DNS 服务地址" required value={dns.address} disabled={disabled} onChange={e => patch({ dns: { ...dns, address: e.target.value } })} /></Field><Field label="TLS 服务名称"><input aria-label="TLS 服务名称" required maxLength={253} value={dns.serverName} disabled={disabled} onChange={e => patch({ dns: { ...dns, serverName: e.target.value } })} /></Field><Field label="DNS 端口"><input aria-label="DNS 端口" type="number" required min={1} max={65535} step={1} value={dns.port} disabled={disabled} onChange={e => patch({ dns: { ...dns, port: Number(e.target.value) } })} /></Field><Field label="DNS 请求路径"><input aria-label="DNS 请求路径" required maxLength={256} value={dns.path} disabled={disabled} spellCheck={false} onChange={e => patch({ dns: { ...dns, path: e.target.value } })} /></Field></div></>}
      {guest && value.strict && value.transparent && <><div className="form-divider"><h3>出口核验</h3></div><label className="check-label"><input type="checkbox" checked={!!value.egressLock} disabled={disabled} onChange={e => patch({ egressLock: e.target.checked ? { expectedIp: '' } : undefined })} />出口变化时停机</label>{value.egressLock && <Field label="批准的公网 IPv4"><input aria-label="批准的公网 IPv4" value={value.egressLock.expectedIp} disabled={disabled} autoComplete="off" spellCheck={false} placeholder="代理提供商确认的固定出口" onChange={e => patch({ egressLock: { expectedIp: e.target.value } })} /></Field>}</>}
      <Field label="直连地址"><input value={value.noProxy} disabled={disabled || value.strict} onChange={e => patch({ noProxy: e.target.value })} placeholder="localhost,127.0.0.1" /></Field>
    </>}
  </div>;
}

export function IdentityEditor({ value, onChange, disabled = false }: { value: IdentityConfig; onChange: (value: IdentityConfig) => void; disabled?: boolean }) {
  return <div className="form-grid"><Field label="时区"><input aria-label="时区" list="mu-timezones" value={value.timezone} disabled={disabled} onChange={e => onChange({ ...value, timezone: e.target.value })} /><datalist id="mu-timezones">{['Asia/Taipei', 'Asia/Shanghai', 'Asia/Tokyo', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'UTC'].map(zone => <option key={zone} value={zone} />)}</datalist></Field><Field label="语言"><select aria-label="语言" value={value.locale} disabled={disabled} onChange={e => onChange({ ...value, locale: e.target.value as IdentityConfig['locale'] })}><option value="en-US">English (US)</option><option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option><option value="ja-JP">日本語</option><option value="de-DE">Deutsch</option></select></Field></div>;
}

export function CreateDialog({ system, onClose, onCreated }: { system: SystemInfo; onClose: () => void; onCreated: (e: Environment) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<'vm' | 'browser'>('vm');
  const [color, setColor] = useState<Environment['color']>('green');
  const [cpus, setCpus] = useState(Math.min(4, system.cpus));
  const [memory, setMemory] = useState(Math.min(4, Math.floor(system.memoryGiB * .5)));
  const [disk, setDisk] = useState(30);
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [network, setNetwork] = useState<NetworkConfig>({ mode: 'direct', host: '', port: 7890, username: '', noProxy: 'localhost,127.0.0.1', strict: false });
  const [identity, setIdentity] = useState<IdentityConfig>({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: 'en-US' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function create() {
    const invalid = networkEditorError(network, kind === 'vm');
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError('');
    try { onCreated(await api.create({ name, description, kind, color, cpus, memoryGiB: memory, diskGiB: disk, mounts: kind === 'vm' ? mounts : [], ports: [], network: { ...network, strict: kind === 'vm' && network.strict, transparent: kind === 'vm' && Boolean(network.transparent) }, identity, browserUrl: 'https://example.com' })); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <Modal title="新建环境" subtitle="MuCodeSandbox" onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); void create(); }}>
      <div className="modal-body">
        <div className="kind-picker"><button type="button" className={kind === 'vm' ? 'selected' : ''} onClick={() => setKind('vm')}><Box size={22} /><span>Linux 沙箱<small>浏览器 · Claude Code</small></span>{kind === 'vm' && <ShieldCheck size={16} />}</button><button type="button" className={kind === 'browser' ? 'selected' : ''} onClick={() => setKind('browser')}><Globe size={22} /><span>本机浏览器<small>Mac · 独立会话资料</small></span>{kind === 'browser' && <ShieldCheck size={16} />}</button></div>
        <Field label="环境名称"><input autoFocus required maxLength={60} value={name} onChange={e => setName(e.target.value)} placeholder="例如：我的开发环境" /></Field>
        <Field label="备注"><input maxLength={240} value={description} onChange={e => setDescription(e.target.value)} placeholder="可选" /></Field>
        <div className="color-picker"><span>环境标记</span>{['green', 'blue', 'amber', 'rose'].map(c => <button type="button" key={c} aria-label={`${c}标记`} title={c} className={`swatch swatch-${c} ${color === c ? 'selected' : ''}`} onClick={() => setColor(c)} />)}</div>
        {kind === 'vm' && <><div className="form-grid"><Field label="CPU 核心"><input type="number" min="1" max={system.cpus} value={cpus} onChange={e => setCpus(Number(e.target.value))} /></Field><Field label="内存 / GB"><input type="number" min="1" max={Math.floor(system.memoryGiB * .8)} value={memory} onChange={e => setMemory(Number(e.target.value))} /></Field><Field label="磁盘容量 / GiB"><input aria-label="磁盘容量 / GiB" type="number" required min={10} max={256} step={1} value={disk} onChange={e => setDisk(Number(e.target.value))} /></Field></div><div className="form-divider"><h3>项目目录</h3><span className="muted">{mounts.length} 个目录</span></div><MountEditor mounts={mounts} onChange={setMounts} /></>}
        <div className="form-divider"><h3>地区设置</h3></div><IdentityEditor value={identity} onChange={setIdentity} />
        <div className="form-divider"><h3>网络出口</h3></div><NetworkEditor value={network} onChange={setNetwork} guest={kind === 'vm'} />
        {error && <Notice kind="error">{error}</Notice>}
      </div>
      <footer className="modal-footer"><Button type="button" onClick={onClose}>取消</Button><Button type="submit" className="primary" icon={<Plus size={16} />} loading={busy} disabled={kind !== 'vm' && ['https','wireguard'].includes(network.mode)}>创建环境</Button></footer>
    </form>
  </Modal>;
}

export function FoldersPanel({ environment, refresh }: { environment: Environment; refresh: () => Promise<void> }) {
  const [mounts, setMounts] = useState(environment.mounts);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const disabled = environment.state === 'running' || ['starting', 'stopping', 'deleting'].includes(environment.state);
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try { await api.update(environment.id, { ...editConfig(environment), mounts }); await refresh(); setMessage('目录配置已保存'); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="panel-width"><SectionHeading title="共享项目目录" subtitle={`${mounts.length} 个目录 · 默认只读`} action={<Button icon={<Save size={16} />} className="primary" loading={busy} disabled={disabled} onClick={() => void save()}>保存</Button>} />
    {disabled && <Notice>环境运行中，停止后可修改目录</Notice>}
    {!mounts.length && <div className="empty-inline"><FolderOpen size={28} /><h3>尚未共享项目目录</h3></div>}
    <MountEditor mounts={mounts} onChange={setMounts} disabled={disabled} />
    {error && <Notice kind="error">{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}
  </div>;
}

export function PortsEditor({ ports, onChange, disabled }: { ports: PortForward[]; onChange: (ports: PortForward[]) => void; disabled: boolean }) {
  function patch(id: string, data: Partial<PortForward>) { onChange(ports.map(p => p.id === id ? { ...p, ...data } : p)); }
  return <div className="ports-editor">{ports.map(p => <div className="port-row" key={p.id}><Field label="Linux 端口"><input type="number" min={1024} max={65535} value={p.guestPort} disabled={disabled} onChange={e => patch(p.id, { guestPort: Number(e.target.value) })} /></Field><ArrowRight size={16} /><Field label="本机端口"><input type="number" min={1024} max={65535} value={p.hostPort} disabled={disabled} onChange={e => patch(p.id, { hostPort: Number(e.target.value) })} /></Field><IconButton title="移除端口" disabled={disabled} onClick={() => onChange(ports.filter(other => other.id !== p.id))}><Trash2 size={15} /></IconButton></div>)}<Button icon={<Plus size={16} />} disabled={disabled} className="subtle" onClick={() => onChange([...ports, { id: crypto.randomUUID(), guestPort: 3000, hostPort: 3000 + ports.length }])}>添加端口映射</Button></div>;
}
