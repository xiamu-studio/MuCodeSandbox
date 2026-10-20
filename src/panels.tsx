import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Check, Circle, Clock3, Download, Globe, LoaderCircle, Maximize2, Network, Play, RefreshCw, Save, Shield, Square, TerminalSquare, Trash2, Bot, AlertTriangle, Cpu, HardDrive, MemoryStick } from 'lucide-react';
import type { AgentStatus, Environment, Job, LogEntry, Metrics, NetworkResult, Snapshot, NetworkProtection, BrowserInspection, BrowserVersionStatus, NetworkConfig, EgressStatus } from '../shared/types.ts';
import { api, editConfig } from './api.ts';
import { Button, Field, IconButton, Modal, Notice, SectionHeading, Status, dateLabel } from './components.tsx';
import { NetworkWizard } from './NetworkWizard.tsx';
import { IdentityEditor, NetworkEditor, PortsEditor, networkEditorError } from './forms.tsx';
import { BROWSER_HOME_URL, usesBrowserHome } from '../shared/browser-home.ts';
import { logSummary } from '../shared/network-observations.ts';
import { NetworkActivity } from './NetworkActivity.tsx';
import {AccessLatencyPanel} from './AccessLatency.tsx';
import ProtectionEvents from './ProtectionEvents.tsx';
import { EnvironmentHealth } from './EnvironmentStatus.tsx';
import { CleanupScope } from './CleanupScope.tsx';
import { jobRecovery, jobDuration, type StatusDestination } from './environment-status.ts';
const GuestBrowserView = lazy(() => import('./GuestBrowserView.tsx'));

export const actionLabels: Record<string, string> = { start: '启动环境', stop: '停止环境', restart: '重启环境', delete: '删除环境', 'install-runtime': '安装 Lima', 'install-agent': '安装 Claude Code', 'open-browser': '打开浏览器', 'browser-update':'更新浏览器', 'browser-recover':'恢复浏览器', 'prepare-network': '准备网络防护', quarantine: '防护异常停机', 'snapshot-create': '创建快照', 'snapshot-restore': '恢复快照', 'backup-export': '导出加密备份', 'backup-import': '导入加密备份', 'disk-grow': '扩容磁盘' };
const jobLabels: Record<Job['status'], string> = { running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
actionLabels['browser-reset']='重置浏览器资料';actionLabels['lab-check']='无账号检测';
actionLabels['desktop-install']='安装桌面客户端';actionLabels['desktop-start']='打开桌面客户端';actionLabels['desktop-stop']='关闭桌面客户端';actionLabels['environment-rebuild']='彻底重建环境';

export function Jobs({ jobs, refresh, compact = false, onNavigate, canNavigate }: { jobs: Job[]; refresh: () => Promise<void>; compact?: boolean; onNavigate?: (job: Job, tab: StatusDestination) => void; canNavigate?: (job: Job) => boolean }) {
  const [error, setError] = useState('');
  async function cancel(id: string) { try { await api.cancel(id); await refresh(); } catch (error) { setError((error as Error).message); } }
  return <div className="jobs-list">{!jobs.length && <div className="quiet-empty"><Clock3 size={22} /><span>暂无操作记录</span></div>}{jobs.slice(0, compact ? 6 : 40).map(job => {
    const recovery = jobRecovery(job);
    return <div className={`job-row ${recovery ? 'job-needs-attention' : ''}`} key={job.id}>
      <span className={`job-indicator job-${job.status}`}>{job.status === 'running' ? <LoaderCircle size={16} className="spin" /> : job.status === 'succeeded' ? <Check size={16} /> : <AlertTriangle size={16} />}</span>
      <div className="job-main"><strong>{actionLabels[job.action] ?? job.action}</strong>{(!compact || recovery) && job.message && <small className="job-message" title={job.message}>{logSummary(job.message)}</small>}
        {recovery && <div className="job-recovery"><p>{recovery.detail}</p>{onNavigate && job.environmentId && (!canNavigate || canNavigate(job)) && <button onClick={() => onNavigate(job, recovery.destination)}>{recovery.label}</button>}</div>}
      </div><div className="job-outcome"><span className={`job-status job-status-${job.status}`}>{jobLabels[job.status]}</span><small>{job.status === 'running' ? '已用时' : '耗时'} {jobDuration(job)}</small></div><time>{dateLabel(job.createdAt)}</time>{job.status === 'running' && <IconButton title="取消操作" onClick={() => void cancel(job.id)}><Square size={13} /></IconButton>}
    </div>;
  })}{error && <Notice kind="error">{error}</Notice>}</div>;
}

export function Overview({ environment, snapshot, refresh, onNavigate }: { environment: Environment; snapshot: Snapshot; refresh: () => Promise<void>; onNavigate: (tab: StatusDestination) => void }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  useEffect(() => {
    let live = true, pending = false;
    setMetrics(null);
    if (environment.kind !== 'vm' || environment.state !== 'running') return;
    const update = () => {
      if (pending) return;
      pending = true;
      void api.metrics(environment.id).then(m => { if (live) setMetrics(m); }).catch(() => { if (live) setMetrics(null); }).finally(() => { pending = false; });
    };
    update(); const timer = setInterval(update, 6000);
    return () => { live = false; clearInterval(timer); };
  }, [environment.id, environment.kind, environment.state]);
  const e = environment;
  const stats = e.kind === 'vm' ? [
    { icon: <Cpu size={18} />, name: 'CPU', value: metrics ? `${metrics.cpuPercent.toFixed(1)}%` : '--', sub: `${e.cpus} 个核心`, fraction: metrics?.cpuPercent ?? 0, color: 'green' },
    { icon: <MemoryStick size={18} />, name: '内存', value: metrics ? `${(metrics.memoryUsedMiB / 1024).toFixed(1)} GB` : '--', sub: `${e.memoryGiB} GB 已分配`, fraction: metrics ? metrics.memoryUsedMiB / metrics.memoryTotalMiB * 100 : 0, color: 'blue' },
    { icon: <HardDrive size={18} />, name: '磁盘', value: metrics ? `${metrics.diskUsedGiB.toFixed(1)} GB` : '--', sub: `${e.diskGiB} GB 容量`, fraction: metrics ? metrics.diskUsedGiB / metrics.diskTotalGiB * 100 : 0, color: 'amber' },
    { icon: <Clock3 size={18} />, name: '运行时间', value: metrics ? `${Math.floor(metrics.uptimeSeconds / 3600)}h ${Math.floor(metrics.uptimeSeconds % 3600 / 60)}m` : '--', sub: metrics ? '本次启动' : e.state === 'running' ? '等待运行数据' : '环境未运行', fraction: 0, color: 'neutral' },
  ] : [
    { icon: <Globe size={18} />, name: '浏览器', value: e.browserRunning ? '已打开' : '已关闭', sub: snapshot.system.browser.engine, fraction: 0, color: 'green' },
    { icon: <Network size={18} />, name: '网络模式', value: e.network.mode === 'direct' ? '直连' : e.network.mode.toUpperCase(), sub: e.network.mode === 'direct' ? '本机网络出口' : `${e.network.host}:${e.network.port}`, fraction: 0, color: 'blue' },
  ];
  return <>
    {e.lastError && (/隔离停机未能确认完成/.test(e.lastError)?<details className="protection-technical"><summary>上次关闭记录</summary><Notice kind="error">{e.lastError}</Notice></details>:<Notice kind="error">{e.lastError}</Notice>)}
    {e.kind === 'vm' && !snapshot.system.runtime.available && <Notice>Lima 运行组件尚未安装</Notice>}
    <div className={`metric-strip ${e.kind === 'browser' ? 'two' : ''}`}>{stats.map(stat => <div className="metric" key={stat.name}><div className="metric-label">{stat.icon}<span>{stat.name}</span></div><strong>{stat.value}</strong><div className="metric-foot"><span>{stat.sub}</span></div><div className={`meter meter-${stat.color}`}><span style={{ width: `${Math.min(100, Math.max(0, stat.fraction))}%` }} /></div></div>)}</div>
    {e.kind==='vm'&&<EnvironmentHealth environment={e} busy={snapshot.jobs.some(j=>j.environmentId===e.id&&j.status==='running')} onNavigate={onNavigate}/>}
    <div className="overview-columns"><section><SectionHeading title="环境信息" /><dl className="facts"><div><dt>运行状态</dt><dd><Status state={e.state} /></dd></div><div><dt>系统</dt><dd>{e.kind === 'vm' ? 'Ubuntu 24.04 LTS · ARM64' : snapshot.system.browser.engine}</dd></div><div><dt>环境标识</dt><dd className="mono">{e.instanceName}</dd></div><div><dt>共享目录</dt><dd>{e.mounts.length} 个 <span className="muted">/ {e.mounts.filter(m => m.writable).length} 个可写</span></dd></div><div><dt>配置的上游</dt><dd>{e.network.mode === 'direct' ? '直连' : `${e.network.mode.toUpperCase()} · ${e.network.host}`}</dd></div><div><dt>创建时间</dt><dd>{dateLabel(e.createdAt)}</dd></div></dl></section><section><SectionHeading title="最近操作" /><Jobs jobs={snapshot.jobs.filter(j => j.environmentId === e.id)} refresh={refresh} compact onNavigate={(_job,tab)=>onNavigate(tab)} /></section></div>
    <section className="boundary-band"><div className="boundary-title"><Shield size={18} /><h3>访问边界</h3></div><div className="boundary-facts"><div><span>本机文件</span><strong>{e.kind === 'vm' ? '仅共享项目目录' : '无目录映射'}</strong></div><div><span>本机命令桥接</span><strong>{e.kind==='vm'?'按有效授权开放':'无命令桥接'}</strong></div><div><span>网络策略</span><strong>{e.network.strict ? '仅代理联网 · Linux' : e.network.mode === 'direct' ? '直接联网' : e.kind === 'vm' ? '应用代理' : '浏览器代理'}</strong></div></div></section>
  </>;
}

export function NetworkPanel({ environment, refresh }: { environment: Environment; refresh: () => Promise<void> }) {
  const [wizard,setWizard]=useState(false);
  const [network, setNetwork] = useState<NetworkConfig>(editConfig(environment).network);
  const [ports, setPorts] = useState(environment.ports);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<NetworkResult | null>(null);
  const [egress, setEgress] = useState<EgressStatus | null>(null);
  const [protection, setProtection] = useState<NetworkProtection | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    setProtection(null); setResult(null);
    setNetwork(editConfig(environment).network); setPorts(environment.ports);
  }, [environment.id, environment.state, environment.updatedAt]);
  useEffect(() => {
    let live = true; setEgress(null);
    if (!environment.network.egressLock) return;
    const update = () => void api.egress(environment.id).then(value => { if(live)setEgress(value); }).catch(() => { if(live)setEgress(null); });
    update(); const timer = setInterval(update,4000);
    return () => { live = false; clearInterval(timer); };
  },[environment.id,environment.state,environment.updatedAt]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const disabled = environment.state === 'running' || environment.browserRunning || ['starting', 'stopping', 'deleting'].includes(environment.state);
  async function save() {
    const invalid = networkEditorError(network, environment.kind === 'vm', environment.network.wireguard?.privateKeyConfigured);
    if (invalid) { setError(invalid); setMessage(''); return; }
    setBusy(true); setError(''); setMessage('');
    try { await api.update(environment.id, { ...editConfig(environment), network, ports }); await refresh(); setMessage('网络配置已保存'); setResult(null); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function test() { setTesting(true); setError(''); try { setResult(await api.testNetwork(environment.id)); } catch (error) { setError((error as Error).message); } finally { setTesting(false); } }
  async function inspect() { setChecking(true); setError(''); try { setProtection(await api.protection(environment.id)); } catch (error) { setError((error as Error).message); } finally { setChecking(false); } }
  async function prepare() { setChecking(true); setError(''); try { await api.action(environment.id, 'prepare-network'); await refresh(); setMessage('防护准备任务已提交，完成后环境会停止'); } catch (error) { setError((error as Error).message); } finally { setChecking(false); } }
  return <div className="panel-width network-panel"><SectionHeading title="网络出口" subtitle="先配置线路，再检查防护和实际出口" action={<div className="button-row">{environment.kind==='vm'&&<Button disabled={disabled||busy} onClick={()=>setWizard(true)}>线路设置向导</Button>}<Button icon={<Save size={16} />} className="primary" disabled={disabled} loading={busy} onClick={() => void save()}>保存</Button></div>} />
    {environment.kind==='vm'&&<AccessLatencyPanel environment={environment}/>}
    {wizard&&<NetworkWizard environment={environment} onClose={()=>setWizard(false)} onSaved={refresh}/>}
    {disabled && <Notice>环境或浏览器运行中，停止后可修改网络</Notice>}
    <NetworkEditor value={network} onChange={setNetwork} disabled={disabled} passwordConfigured={environment.network.passwordConfigured} wireguardKeyConfigured={environment.network.wireguard?.privateKeyConfigured} guest={environment.kind === 'vm'} />
    {environment.network.egressLock && <section className="network-test"><SectionHeading title="出口核验状态" /><dl className="facts"><div><dt>批准出口</dt><dd className="mono">{environment.network.egressLock.expectedIp}</dd></div><div><dt>最近检测</dt><dd>{egress ? { disabled:'未启用',unverified:'尚未核验',verified:'检测一致',changed:'出口已变化',unavailable:'无法确认出口' }[egress.status] : '尚未核验'}</dd></div><div><dt>检测出口</dt><dd className="mono">{egress?.actualIp ?? '--'}</dd></div><div><dt>检测时间</dt><dd>{egress?.checkedAt ? dateLabel(egress.checkedAt) : '--'}</dd></div><div><dt>独立回执</dt><dd>{egress?.verification?`${egress.verification.receipts.length} 处一致 · ${egress.verification.receipts.map(value=>value.receiver).join(' / ')}`:'--'}</dd></div></dl>{!!egress?.verification?.timedOutReceivers.length&&<Notice>{egress.verification.timedOutReceivers.join(' / ')} 本次查询超时，另外两处有效回执一致。</Notice>}{egress?.issue && <Notice kind="error">{egress.issue}</Notice>}</section>}
    {protection && <section className="network-test"><SectionHeading title="防护完整性" /><dl className="facts"><div><dt>整体状态</dt><dd>{protection.active ? '检测通过' : '未通过 / 环境已停止'}</dd></div><div><dt>规则完整性</dt><dd>{{ verified: '与已批准规则一致', changed: '规则已发生变化', unverified: '无法确认', inactive: '环境已停止' }[protection.integrity ?? 'unverified']}</dd></div>{environment.network.transparent && <><div><dt>透明路由</dt><dd>{protection.routingReady ? '已生效' : '未生效'}</dd></div><div><dt>受控 DNS</dt><dd>{protection.dnsGuardActive ? '已生效' : '未生效'}</dd></div></>}</dl>{protection.issues?.map(issue => <Notice key={issue} kind="error">{issue}</Notice>)}</section>}
    {environment.kind === 'vm' ? <section className="network-test"><SectionHeading title="Linux 网络防护" action={<Button icon={<Shield size={16} />} loading={checking} disabled={['starting', 'stopping', 'deleting'].includes(environment.state)} onClick={() => void inspect()}>检测防护</Button>} /><dl className="facts"><div><dt>防火墙</dt><dd>{protection ? protection.firewallActive ? '已生效' : '未生效 / 环境已停止' : '尚未检测'}</dd></div>{environment.network.transparent && <div><dt>{environment.network.mode === 'wireguard' ? '整包隧道' : '透明代理'}</dt><dd>{protection ? protection.transparentActive ? '已运行' : '未运行 / 环境已停止' : '尚未检测'}</dd></div>}{environment.network.mode === 'wireguard' && <div><dt>对端握手</dt><dd>{protection?.wireguardHandshakeAge !== undefined && protection.wireguardHandshakeAge >= 0 ? `${protection.wireguardHandshakeAge} 秒前` : '尚未确认'}</dd></div>}<div><dt>开机防护</dt><dd>{protection ? protection.bootArmed ? '已启用' : '未启用' : '--'}</dd></div><div><dt>放行端点</dt><dd className="mono path-text">{protection?.proxyEndpoints.join(', ') || '--'}</dd></div><div><dt>拦截数据包</dt><dd>{protection?.blockedPackets ?? '--'}</dd></div><div><dt>检测时间</dt><dd>{protection ? dateLabel(protection.checkedAt) : '--'}</dd></div></dl>{environment.state === 'running' && !environment.network.strict && <Button icon={<Shield size={16} />} loading={checking} onClick={() => void prepare()}>准备防护并停止</Button>}{network.strict && <Notice>{network.mode === 'wireguard' ? '防护范围：当前 Linux 环境。IPv4 TCP 与加密 DNS 通过隧道；其他 UDP 和 IPv6 已阻断。' : network.transparent ? '仅覆盖 Linux。TCP 与 DNS 经代理转发，其他 UDP 和 IPv6 阻断；本机应用不在此防护范围。' : '仅覆盖 Linux 环境。不使用代理的程序会连接失败；本机应用不在此防护范围。'}</Notice>}</section> : <Notice>此浏览器在 Mac 本机运行，不受 Linux 防火墙约束。</Notice>}
    <section className="network-test"><SectionHeading title="实际出口" action={<Button icon={<RefreshCw size={16} />} loading={testing} disabled={environment.kind === 'vm' && environment.state !== 'running'} onClick={() => void test()}>检测出口</Button>} />
      <dl className="facts"><div><dt>公网 IP</dt><dd className="mono">{result?.ip ?? '尚未检测'}</dd></div><div><dt>位置</dt><dd>{result ? `${result.country} · ${result.city}` : '--'}</dd></div><div><dt>出口核验耗时</dt><dd>{result ? `${result.latencyMs} ms` : '--'}</dd></div><div><dt>检测来源</dt><dd>{environment.kind === 'vm' ? 'Linux 环境内' : '本机 · 当前代理配置'}</dd></div></dl>
    </section>
    {environment.kind === 'vm' && <section className="network-test"><SectionHeading title="端口映射" subtitle="本机绑定地址：127.0.0.1" /><PortsEditor ports={ports} onChange={setPorts} disabled={disabled} /></section>}
    {error && <Notice kind="error">{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}
  </div>;
}

export function BrowserPanel({ environment, snapshot, refresh, onShowLogs,visible=true }: { environment: Environment; snapshot: Snapshot; refresh: () => Promise<void>; onShowLogs?:()=>void;visible?:boolean }) {
  const [resetting,setResetting]=useState(false);
  const [url, setUrl] = useState(environment.browserUrl);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestedAction,setRequestedAction] = useState<'open'|'close'|null>(null);
  const [message, setMessage] = useState('');
  const [inspection, setInspection] = useState<BrowserInspection | null>(null);
  const [version, setVersion] = useState<BrowserVersionStatus | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => { setInspection(null); }, [environment.browserRunning, environment.updatedAt]);
  const vm = environment.kind === 'vm';
  const opening = snapshot.jobs.some(job => job.environmentId === environment.id && job.status === 'running');
  const browserJob=snapshot.jobs.find(job=>job.environmentId===environment.id&&job.action==='open-browser');
  const browserOpening=(busy&&requestedAction==='open')||browserJob?.status==='running';
  const maintenance=snapshot.jobs.find(job=>job.environmentId===environment.id&&['browser-update','browser-recover','browser-reset'].includes(job.action));
  useEffect(() => {
    if(!visible)return;
    let live=true;
    if(vm&&environment.state==='running'&&!opening)void api.browserVersion(environment.id).then(value=>{if(live)setVersion(value);}).catch(error=>{if(live)setError(error.message);});
    return ()=>{live=false;};
  },[environment.id,environment.state,environment.browserRunning,opening,vm,maintenance?.id,maintenance?.status,visible]);
  const blockedNetwork = environment.network.strict && (!vm || !environment.network.transparent);
  const disabled = environment.state === 'running' || environment.browserRunning;
  async function open() { const action=environment.browserRunning?'close':'open';setRequestedAction(action);setBusy(true); setError(''); try { await api.browser(environment.id, action,!vm); await refresh(); } catch (error) { setError((error as Error).message); } finally { setBusy(false);setRequestedAction(null); } }
  async function showWindow() { setBusy(true); setError(''); try { await api.browser(environment.id, 'open'); await refresh(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }
  async function start() { setBusy(true); setError(''); try { await api.action(environment.id, 'start'); await refresh(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }
  async function save() { setBusy(true); setError(''); try { await api.update(environment.id, { ...editConfig(environment), browserUrl: url }); await refresh(); setMessage('启动页已保存'); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }
  async function inspect() { setChecking(true); setError(''); try { setInspection(await api.inspectBrowser(environment.id)); } catch (error) { setError((error as Error).message); } finally { setChecking(false); } }
  async function maintain(action:'update'|'recover'){setBusy(true);setError('');try{await api.maintainBrowser(environment.id,action);await refresh();}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
  return <div className={vm ? 'vm-browser-panel' : 'panel-width'}><SectionHeading title={vm ? '沙箱浏览器' : '本机浏览器'} action={<div className="button-row">{vm && environment.state === 'running' && environment.browserRunning && <Button icon={<Maximize2 size={15}/>} disabled={blockedNetwork || busy || opening} onClick={() => void showWindow()}>独立窗口</Button>}<Button icon={environment.browserRunning ? <Square size={15} /> : <Globe size={16} />} className="primary" loading={busy || opening} disabled={blockedNetwork || (vm ? environment.state !== 'running' : !snapshot.system.browser.available)} onClick={() => void open()}>{environment.browserRunning ? '关闭浏览器' : '打开浏览器'}</Button></div>} />
    {blockedNetwork && <Notice>{vm ? '当前网络会阻止浏览器直接联网。请停止环境，在网络页启用透明代理。' : '此浏览器在 Mac 本机运行，不能使用 Linux 防护。请改用 Linux 沙箱中的浏览器。'}</Notice>}
    {maintenance?.status==='failed'&&<Notice kind="error">{maintenance.message}</Notice>}
    {vm ? browserOpening&&!environment.browserRunning ? <div className="guest-browser-empty browser-starting" role="status" aria-live="polite" aria-busy="true"><LoaderCircle className="spin" size={40}/><h3>正在打开沙箱浏览器</h3><p>正在准备浏览器并检查防护，完成后将连接画面</p><div className="browser-starting-track" aria-hidden="true"><span/></div>{onShowLogs&&<Button onClick={onShowLogs}>查看打开日志</Button>}</div> : environment.state !== 'running' ? <div className="guest-browser-empty"><Globe size={35} strokeWidth={1.4} /><h3>环境尚未运行</h3><Button icon={<Play size={14} />} className="primary" loading={busy || opening} onClick={() => void start()}>启动环境</Button></div> : environment.browserRunning ? <Suspense fallback={<div className="guest-browser-empty"><LoaderCircle className="spin" size={28} /><span>连接浏览器画面</span></div>}><GuestBrowserView id={environment.id} name={environment.name} timezone={environment.identity.timezone} embedded active={visible} starting={browserOpening} /></Suspense> : <div className="guest-browser-empty"><Globe size={35} strokeWidth={1.4} /><h3>{browserJob?.status==='failed'?'浏览器打开失败':'浏览器已关闭'}</h3><span className="browser-state">{browserJob?.status==='failed'?browserJob.message:`Linux · ${environment.identity.locale} · ${environment.identity.timezone}`}</span>{browserJob?.status==='failed'&&onShowLogs&&<Button onClick={onShowLogs}>查看打开日志</Button>}</div> : <div className="browser-surface"><div className="browser-window-bar"><span /><span /><span /><div>{usesBrowserHome(environment.browserUrl)?'浏览器首页':environment.browserUrl}</div></div><div className="browser-window-body"><Globe size={46} strokeWidth={1.25} /><h3>{environment.name}</h3><span className="browser-state"><Circle size={7} fill={environment.browserRunning ? '#388466' : '#9ba5a0'} />{environment.browserRunning ? '浏览器已打开' : '浏览器已关闭'}</span></div></div>}
    <div className={vm ? 'panel-width vm-browser-details' : undefined}><dl className="facts"><div><dt>运行位置</dt><dd>{vm ? 'Linux 虚拟机内' : 'Mac 本机'}</dd></div><div><dt>浏览器引擎</dt><dd>{vm ? 'Chromium · Linux ARM64' : snapshot.system.browser.engine}</dd></div><div><dt>会话存储</dt><dd>{vm ? '当前虚拟机磁盘' : '独立 Cookie 与站点数据'}</dd></div><div><dt>网络</dt><dd>{environment.network.mode === 'wireguard' ? 'Linux 防火墙 · 整包隧道' : environment.network.strict && environment.network.transparent ? 'Linux 防火墙 · 透明代理' : environment.network.mode === 'direct' ? '直连 · 未启用强制网络防护' : environment.network.mode.toUpperCase()}</dd></div></dl>
    {vm&&<section className="network-test"><SectionHeading title="浏览器版本" action={<IconButton title="检测浏览器版本" disabled={environment.state!=='running'||opening||busy} onClick={()=>void api.browserVersion(environment.id).then(setVersion).catch(error=>setError(error.message))}><RefreshCw size={16}/></IconButton>}/><dl className="facts"><div><dt>已安装</dt><dd className="mono">{version?.installedVersion??(version?'尚未安装':'--')}{version?.installedChannel&&` · ${version.installedChannel==='stable'?'正式稳定版':'测试版'}`}</dd></div><div><dt>可用版本</dt><dd className="mono">{version?.availableVersion??'--'}{version?.availableChannel&&` · ${version.availableChannel==='stable'?'正式稳定版':'测试版'}`}</dd></div><div><dt>升级状态</dt><dd>{version?version.recoveryRequired?'等待恢复':version.requiresFreshProfile?'需要空白资料':version.updateAvailable?'可更新':version.installedVersion?'当前版本':'等待安装':'--'}</dd></div></dl><div>{version?.requiresFreshProfile&&<Notice>正式稳定版低于现有测试版，请新建空白环境使用。现有浏览器与资料保持保留，不能直接降级打开。</Notice>}</div><div className="button-row"><Button icon={<Download size={16}/>} disabled={!version?.updateAvailable||version.recoveryRequired||opening||busy||blockedNetwork} onClick={()=>void maintain('update')}>更新浏览器</Button><Button icon={<RefreshCw size={16}/>} disabled={!version?.recoveryRequired||opening||busy} onClick={()=>void maintain('recover')}>恢复浏览器</Button></div></section>}
    <section className="network-test"><SectionHeading title="实际环境特征" action={<Button icon={<RefreshCw size={16} />} loading={checking} disabled={!environment.browserRunning || (!vm && !snapshot.system.browser.native)} onClick={() => void inspect()}>检测特征</Button>} /><dl className="facts"><div><dt>时区</dt><dd>{inspection?.timezone ?? '--'}</dd></div><div><dt>页面语言</dt><dd>{inspection?.language ?? '--'}</dd></div><div><dt>区域格式</dt><dd>{inspection?.locale ?? '--'}</dd></div><div><dt>操作系统</dt><dd>{inspection?.platform ?? '--'}</dd></div><div><dt>CPU 线程</dt><dd>{inspection?.hardwareConcurrency ?? '--'}</dd></div><div><dt>屏幕尺寸</dt><dd>{inspection ? `${inspection.screenWidth} × ${inspection.screenHeight}` : '--'}</dd></div><div><dt>WebRTC 策略</dt><dd className="mono path-text">{inspection?.webRtcPolicy ?? '--'}</dd></div><div><dt>与地区配置一致</dt><dd>{inspection ? inspection.matchesConfiguration ? '是' : '否' : '--'}</dd></div></dl></section>
    <div className="form-divider"><h3>启动页</h3></div><div className="segmented"><button type="button" className={usesBrowserHome(url)?'selected':''} disabled={disabled||busy} onClick={()=>setUrl(BROWSER_HOME_URL)}>浏览器首页</button><button type="button" className={!usesBrowserHome(url)?'selected':''} disabled={disabled||busy} onClick={()=>setUrl('https://')}>指定网页</button></div>{usesBrowserHome(url)?<div className="browser-home-setting"><p>本地首页显示实际出口 IP、地区和浏览器时区，并提供网址输入框。</p><Button icon={<Save size={15}/>} disabled={disabled||busy} onClick={()=>void save()}>保存启动页</Button></div>:<Field label="页面地址"><div className="input-action"><input type="url" value={url} onChange={e => setUrl(e.target.value)} disabled={disabled} /><Button icon={<Save size={15} />} disabled={disabled || busy} onClick={() => void save()}>保存</Button></div></Field>}
    {vm&&<section className="profile-reset-card"><div><h3>空白浏览器资料</h3><p>清除网站登录、缓存、历史、密码和扩展。保留虚拟机、项目文件与线路。</p></div><Button disabled={environment.state!=='running'||opening||busy} onClick={()=>setResetting(true)}>重置浏览器资料</Button></section>}
    {resetting&&<Modal title="重置浏览器资料？" subtitle={environment.name} narrow onClose={busy?()=>{}:()=>setResetting(false)}><div className="modal-body"><CleanupScope operation="browser"/>{error&&<Notice kind="error">{error}</Notice>}</div><footer className="modal-footer"><Button disabled={busy} onClick={()=>setResetting(false)}>取消</Button><Button className="danger-filled" loading={busy} onClick={()=>{setBusy(true);setError('');void api.resetBrowser(environment.id).then(async()=>{setResetting(false);setInspection(null);setMessage('重置任务已提交，完成后请重新打开浏览器');await refresh();}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>确认清除浏览器资料</Button></footer></Modal>}
    {error && <Notice kind="error">{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}</div>
  </div>;
}

export function AgentPanel({ environment, onInstall, onTerminal }: { environment: Environment; onInstall: () => void; onTerminal: (command: 'shell' | 'claude') => void }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true; setStatus(null); setError('');
    if (environment.state !== 'running') return;
    void api.agent(environment.id).then(s => { if (live) setStatus(s); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [environment.id, environment.state, environment.updatedAt]);
  return <div className="panel-width"><SectionHeading title="Claude Code" /><div className="agent-heading"><div className="agent-icon"><Bot size={28} /></div><div><h3>Claude Code</h3><p>{environment.state !== 'running' ? '环境已停止' : status?.installed ? status.version : status ? '尚未安装' : '检测中'}</p></div><span className={`permission ${status?.installed ? '' : 'neutral'}`}>{status?.installed ? '已安装' : '未就绪'}</span></div><dl className="facts"><div><dt>执行位置</dt><dd>Linux 沙箱</dd></div><div><dt>Node.js</dt><dd className="mono">{status?.nodeVersion ?? '--'}</dd></div><div><dt>本机访问</dt><dd>仅共享项目目录</dd></div><div><dt>登录状态</dt><dd>在 Claude 终端内管理</dd></div></dl><div className="button-row"><Button icon={<Download size={16} />} disabled={environment.state !== 'running'} onClick={onInstall}>{status?.installed ? '更新 Claude Code' : '安装 Claude Code'}</Button><Button className="primary" icon={<Bot size={16} />} disabled={!status?.installed} onClick={() => onTerminal('claude')}>打开 Claude</Button><Button icon={<TerminalSquare size={16} />} disabled={environment.state !== 'running'} onClick={() => onTerminal('shell')}>打开终端</Button></div>{error && <Notice kind="error">{error}</Notice>}</div>;
}

export function LogsPanel({ environmentId,environment,onConfigure }: { environmentId?: string;environment?:Environment;onConfigure?:()=>void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const tail = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    let live = true, pending = false;
    setLogs([]); setError('');
    const update = () => {
      if (pending) return;
      pending = true;
      void api.logs(environmentId).then(result => { if (live) {
        // Stored log entries are append-only; preserve the array when no entry changed.
        setLogs(previous => previous.length === result.length && previous.every((entry, index) => entry.id === result[index].id) ? previous : result);
        setError('');
      } }).catch(error => { if (live) setError(error.message); }).finally(() => { pending = false; });
    };
    update(); const timer = setInterval(update, 2500);
    return () => { live = false; clearInterval(timer); };
  }, [environmentId]);
  useEffect(() => { if (follow && tail.current?.parentElement) tail.current.parentElement.scrollTop=tail.current.parentElement.scrollHeight; }, [logs, follow]);
  const shown = logs.filter(log => filter === 'all' || log.level === 'error');
  function download() { const blob = new Blob([shown.map(log => `[${log.createdAt}] [${log.level}] ${log.message}`).join('\n')], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'MuCodeSandbox.log'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return <section className="logs-panel">{environmentId&&<><ProtectionEvents environmentId={environmentId} environment={environment} onConfigure={onConfigure}/><NetworkActivity key={environmentId} environmentId={environmentId}/></>}<SectionHeading title="运行事件" action={<div className="log-actions"><div className="segmented compact"><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>全部</button><button className={filter === 'error' ? 'selected' : ''} onClick={() => setFilter('error')}>错误</button></div><label className="check-label"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />跟随</label><IconButton title="下载运行日志" onClick={download}><ArrowDownToLine size={17} /></IconButton></div>} />
    {error && <Notice kind="error">{error}</Notice>}<div className="log-surface readable-logs">{!shown.length && <div className="log-empty">暂无运行事件</div>}{shown.map(log => <div className={`log-entry log-${log.level}`} key={log.id}><time>{new Date(log.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>{log.level==='error'?'异常':'信息'}</span><div className="log-description"><p>{logSummary(log.message)}</p>{logSummary(log.message)!==log.message.trim()&&<details><summary>原始诊断详情</summary><pre>{log.message}</pre></details>}</div></div>)}<div ref={tail} /></div>
  </section>;
}

export function SettingsPanel({ environment, system, active, refresh, onDelete,onRebuilt }: { environment: Environment; system: Snapshot['system']; active: boolean; refresh: () => Promise<void>; onDelete: () => void;onRebuilt?:(id:string)=>void }) {
  const [name, setName] = useState(environment.name); const [description, setDescription] = useState(environment.description);
  const [cpu, setCpu] = useState(environment.cpus); const [memory, setMemory] = useState(environment.memoryGiB);
  const [identity, setIdentity] = useState(environment.identity);
  const [diskTarget, setDiskTarget] = useState(Math.min(256, environment.diskGiB + 5));
  const [diskStatus, setDiskStatus] = useState<{ pending: boolean; targetGiB: number | null } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [rebuilding,setRebuilding]=useState(false);
  const disabled = busy || active || environment.state === 'running' || environment.browserRunning || ['starting', 'stopping', 'deleting'].includes(environment.state);
  useEffect(() => {
    let live = true;
    setDiskStatus(null);
    if (environment.kind === 'vm') void api.diskStatus(environment.id).then(status => {
      if (live) { setDiskStatus(status); setDiskTarget(status.targetGiB ?? Math.min(256, environment.diskGiB + 5)); }
    }).catch(error => { if (live) setError(error.message); });
    return () => { live = false; };
  }, [environment.id, environment.diskGiB, environment.kind, active]);
  async function growDisk() {
    setBusy(true); setError(''); setMessage('');
    try { await api.growDisk(environment.id, diskTarget); await refresh(); setMessage('扩容任务已提交'); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function save() { setBusy(true); setError(''); setMessage(''); try { await api.update(environment.id, { ...editConfig(environment), name, description, cpus: cpu, memoryGiB: memory, identity }); await refresh(); setMessage('环境设置已保存'); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }
  async function rebuild(){setBusy(true);setError('');try{const result=await api.cleanRebuild(environment.id);let complete=false;for(let i=0;i<240;i++){const state=await api.snapshot();const job=state.jobs.find(j=>j.id===result.job.id);if(job&&job.status!=='running'){if(job.status!=='succeeded')throw new Error(job.message);complete=true;break;}await new Promise(r=>setTimeout(r,500));}if(!complete)throw new Error('重建仍在进行，请查看日志；未确认完成前不要启动替代环境');await refresh();setRebuilding(false);onRebuilt?.(result.replacementEnvironmentId);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <div className="panel-width">
    <SectionHeading title="环境设置" action={<Button className="primary" icon={<Save size={16} />} disabled={disabled} loading={busy} onClick={() => void save()}>保存</Button>} />
    {disabled && <Notice>{active || busy ? '正在处理环境操作' : '环境运行中，停止后可修改配置'}</Notice>}
    <Field label="环境名称"><input value={name} maxLength={60} disabled={disabled} onChange={e => setName(e.target.value)} /></Field>
    <Field label="备注"><textarea value={description} maxLength={240} disabled={disabled} onChange={e => setDescription(e.target.value)} rows={3} /></Field>
    <div className="form-divider"><h3>地区设置</h3></div><IdentityEditor value={identity} onChange={setIdentity} disabled={disabled} />
    {environment.kind === 'vm' && <><div className="form-divider"><h3>资源分配</h3></div><div className="form-grid"><Field label="CPU 核心"><input type="number" value={cpu} min={1} max={system.cpus} disabled={disabled} onChange={e => setCpu(Number(e.target.value))} /></Field><Field label="内存 / GB"><input type="number" value={memory} min={1} max={Math.floor(system.memoryGiB * .8)} disabled={disabled} onChange={e => setMemory(Number(e.target.value))} /></Field></div><dl className="facts"><div><dt>磁盘容量</dt><dd>{environment.diskGiB} GB</dd></div></dl></>}
    {environment.kind === 'vm' && environment.network.strict && environment.state !== 'not_created' && (environment.diskGiB < 256 || diskStatus?.pending) && <>
      {diskStatus?.pending && <Notice kind="error">上次扩容尚未完成，需要重试至 {diskStatus.targetGiB} GiB</Notice>}
      <Field label="扩容至 / GiB"><div className="input-action"><input type="number" value={diskTarget} min={environment.diskGiB + (diskStatus?.pending ? 0 : 1)} max={256} disabled={disabled || !diskStatus || Boolean(diskStatus.pending)} onChange={event => setDiskTarget(Number(event.target.value))} /><Button icon={<HardDrive size={16} />} disabled={disabled || !diskStatus || !Number.isInteger(diskTarget) || diskTarget > 256 || diskTarget < environment.diskGiB || (!diskStatus.pending && diskTarget === environment.diskGiB)} onClick={() => void growDisk()}>{diskStatus?.pending ? '重试扩容' : '扩容磁盘'}</Button></div></Field>
    </>}
    {error && <Notice kind="error">{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}
    {environment.kind==='vm'&&<section className="danger-section"><SectionHeading title="彻底重建环境" action={<Button icon={<RefreshCw size={16}/>} className="danger" disabled={busy||active} onClick={()=>setRebuilding(true)}>彻底重建环境</Button>}/><p className="reset-note">清除旧虚拟机所有客户端资料、凭据、缓存、本地文件和本应用保存的快照，创建新的空白环境。保留所选线路与地区；取消共享和桥接。</p></section>}
    <section className="danger-section"><SectionHeading title="删除环境" action={<Button icon={<Trash2 size={16} />} className="danger" disabled={busy || active} onClick={onDelete}>删除环境</Button>} /></section>
    {rebuilding&&<Modal title="彻底重建环境" onClose={busy?()=>{}:()=>setRebuilding(false)} narrow><div className="modal-body"><CleanupScope operation="rebuild"/>{error&&<Notice kind="error">{error}</Notice>}</div><footer className="modal-footer"><Button disabled={busy} onClick={()=>setRebuilding(false)}>取消</Button><Button className="danger-filled" loading={busy} onClick={()=>void rebuild()}>确认清除并创建全新环境</Button></footer></Modal>}
  </div>;
}
