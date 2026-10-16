import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Activity, ArrowLeft, ArrowRight, Box, Camera, ChevronRight, Circle, Clock3, Cpu, FlaskConical, FolderOpen, Globe, LayoutDashboard, Link2, LoaderCircle, LockKeyhole, MemoryStick, Monitor, MoreHorizontal, Network, Play, Plus, RefreshCw, Search, Settings, ShieldCheck, SlidersHorizontal, Square, TerminalSquare, Trash2, X, Bot, Upload } from 'lucide-react';
import type { Environment, Snapshot } from '../shared/types.ts';
import { VERSION } from '../shared/version.ts';
import { api } from './api.ts';
import type { BrowserState } from './api.ts';
import { Button, IconButton, Modal, Notice, SectionHeading, Status, dateLabel } from './components.tsx';
import { CreateDialog, FoldersPanel } from './forms.tsx';
import { AgentPanel, BrowserPanel, Jobs, LogsPanel, NetworkPanel, Overview, SettingsPanel } from './panels.tsx';
import { LabPanel } from './LabPanel.tsx';
import { SnapshotsPanel } from './SnapshotsPanel.tsx';
import { BridgePanel } from './BridgePanel.tsx';
import { BackupDialog } from './BackupDialog.tsx';
import { HelpPanel } from './HelpPanel.tsx';
import { SetupChecklist } from './SetupChecklist.tsx';
import { ProtectionBanner } from './ProtectionBanner.tsx';
import { EnvironmentStatusProvider } from './EnvironmentStatus.tsx';
import { CleanupScope } from './CleanupScope.tsx';
import ProtectionEvents from './ProtectionEvents.tsx';
import { LatencyBadge } from './AccessLatency.tsx';
const TerminalPanel = lazy(() => import('./TerminalPanel.tsx'));
const GuestBrowserView = lazy(() => import('./GuestBrowserView.tsx'));
const DesktopPanel = lazy(() => import('./DesktopPanel.tsx'));

type Tab = 'overview' | 'folders' | 'network' | 'browser' | 'desktop' | 'agent' | 'terminal' | 'logs' | 'settings' | 'snapshots' | 'bridge';
const tabs = [
  { id: 'overview', label: '总览', icon: LayoutDashboard }, { id: 'folders', label: '项目目录', icon: FolderOpen, vm: true },
  { id: 'network', label: '网络', icon: Network }, { id: 'browser', label: '浏览器', icon: Globe },
  { id: 'desktop', label: '桌面应用', icon: Monitor, vm: true },
  { id: 'agent', label: 'Claude Code', icon: Bot, vm: true }, { id: 'terminal', label: '终端', icon: TerminalSquare, vm: true },
  { id: 'logs', label: '日志', icon: Activity }, { id: 'settings', label: '设置', icon: SlidersHorizontal },
  { id: 'snapshots', label: '快照', icon: Camera, vm: true },
  { id: 'bridge', label: '宿主授权', icon: Link2, vm: true },
] as const;

function BrowserControls({ id }: { id: string }) {
  const [state, setState] = useState<BrowserState>({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false });
  const [address, setAddress] = useState('');
  const [name, setName] = useState('浏览器');
  const [error, setError] = useState('');
  useEffect(() => window.muDesktop?.onBrowserState(s => { setState(s); setAddress(s.url); }), []);
  useEffect(() => { void api.snapshot().then(s => setName(s.environments.find(e => e.id === id)?.name ?? '浏览器')); }, [id]);
  async function action(value: string, url?: string) { try { await window.muDesktop?.browserAction({ id, action: value, url }); setError(''); } catch (error) { setError((error as Error).message); } }
  return <div className="browser-controls"><div className="browser-control-brand"><Box size={19} /><span>{name}</span></div><IconButton title="后退" disabled={!state.canGoBack} onClick={() => void action('back')}><ArrowLeft size={17} /></IconButton><IconButton title="前进" disabled={!state.canGoForward} onClick={() => void action('forward')}><ArrowRight size={17} /></IconButton><IconButton title="刷新" onClick={() => void action('reload')}>{state.loading ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />}</IconButton><form onSubmit={e => { e.preventDefault(); void action('navigate', /^https?:\/\//.test(address) ? address : `https://${address}`); }}><LockKeyhole size={14} /><input aria-label="浏览器地址" value={address} onChange={e => setAddress(e.target.value)} /></form><span className="browser-private"><ShieldCheck size={16} />独立会话</span>{error && <span className="browser-control-error">{error}</span>}</div>;
}

function WorkspaceHome({ snapshot, onCreate, onImport, onSelect, onSystem, onNetwork, onBrowser, onHelp, search }: { snapshot: Snapshot; onCreate: () => void; onImport: () => void; onSelect: (id: string) => void; onSystem:()=>void;onNetwork:(id:string)=>void;onBrowser:(id:string)=>void;onHelp:()=>void; search: string }) {
  const environments = snapshot.environments.filter(e => `${e.name} ${e.description}`.toLowerCase().includes(search.toLowerCase()));
  const running = snapshot.environments.filter(e => e.state === 'running');
  const allocated = running.filter(e => e.kind === 'vm').reduce((sum, e) => sum + e.memoryGiB, 0);
  return <><header className="page-header workspace-header"><div><div className="eyebrow">本地工作区</div><h1>MuCodeSandbox</h1><p>{snapshot.system.hostname} <span>·</span> Apple Silicon <span>·</span> 本地运行</p></div><Button className="primary" icon={<Plus size={16} />} onClick={onCreate}>新建环境</Button></header>
    <div className="workspace-stats"><div><span>全部环境</span><strong>{snapshot.environments.length}<small>个</small></strong></div><div><span><Circle size={7} fill="#3c8c70" />运行中</span><strong>{running.length}<small>个</small></strong></div><div><span>已分配内存</span><strong>{allocated}<small>/ {snapshot.system.memoryGiB} GB</small></strong></div><div><span>虚拟机运行组件</span><strong className="runtime-stat">{snapshot.system.runtime.available ? <><ShieldCheck size={17} />已就绪</> : <><Circle size={9} />未安装</>}</strong></div></div>
    <SetupChecklist snapshot={snapshot} onCreate={onCreate} onSystem={onSystem} onNetwork={onNetwork} onBrowser={onBrowser} onHelp={onHelp}/>
    <section className="environment-list"><SectionHeading title="我的环境" subtitle={`${environments.length} 个环境`} action={<Button icon={<Upload size={16} />} disabled={snapshot.jobs.some(job => job.environmentId === null && job.status === 'running')} onClick={onImport}>导入备份</Button>} />
      {environments.length ? <div className="env-table"><div className="env-table-header"><span>环境</span><span>状态</span><span>资源</span><span>网络</span><span>最近更新</span><span /></div>{environments.map(e => <button className="env-table-row" key={e.id} onClick={() => onSelect(e.id)}><span className="env-table-name"><span className={`environment-symbol color-${e.color}`}>{e.kind === 'vm' ? <Box size={21} /> : <Globe size={21} />}</span><span><strong>{e.name}</strong><small>{e.description || (e.kind === 'vm' ? 'Ubuntu 24.04 LTS' : '独立浏览器会话')}</small></span></span><Status state={e.state} /><span className="env-table-resource">{e.kind === 'vm' ? `${e.cpus} CPU · ${e.memoryGiB} GB` : 'Chromium'}</span><span className="env-table-network">{e.network.mode === 'direct' ? '直连' : e.network.mode.toUpperCase()}</span><time>{dateLabel(e.updatedAt)}</time><ChevronRight size={17} /></button>)}</div> : <div className="workspace-empty"><div className="empty-icon"><Box size={36} strokeWidth={1.5} /></div><h2>{search ? '没有匹配的环境' : '还没有环境'}</h2>{!search && <Button icon={<Plus size={16} />} className="primary" onClick={onCreate}>新建环境</Button>}</div>}
    </section>
    <div className="host-band"><div><span className="host-symbol"><Cpu size={22} /></span><span><strong>{snapshot.system.cpus} 核心</strong><small>本机 CPU</small></span></div><div><span className="host-symbol"><MemoryStick size={22} /></span><span><strong>{snapshot.system.memoryGiB} GB</strong><small>本机内存</small></span></div><div><span className="host-symbol"><ShieldCheck size={22} /></span><span><strong>宿主权限按需授权</strong><small>目录与命令分别批准</small></span></div></div>
  </>;
}

export default function App() {
  const guestBrowserId = new URLSearchParams(location.search).get('guestBrowser');
  if (guestBrowserId) return <Suspense fallback={<div className="loading-view"><LoaderCircle className="spin" size={28} /></div>}><GuestBrowserView id={guestBrowserId} /></Suspense>;
  const browserId = new URLSearchParams(location.search).get('browser');
  if (browserId) return <BrowserControls id={browserId} />;
  return <Workspace />;
}

function Workspace() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem('mu-selected'));
  const [page, setPage] = useState<'workspace' | 'environment' | 'system' | 'activity' | 'lab' | 'help'>('workspace');
  const [tab, setTab] = useState<Tab>('overview');
  const [retained,setRetained]=useState<{id:string|null;tabs:Tab[]}>({id:null,tabs:[]});
  useEffect(()=>{if(['browser','desktop','terminal'].includes(tab))setRetained(value=>({id:selectedId,tabs:value.id===selectedId?[...new Set([...value.tabs,tab])]:[tab]}));},[selectedId,tab]);
  const keeps=(name:Tab)=>tab===name||retained.id===selectedId&&retained.tabs.includes(name);
  const [handoff,setHandoff]=useState<{id:string;application?:'grok-bot'|'claude-desktop'}|null>(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Environment | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [error, setError] = useState('');
  const [command, setCommand] = useState<'shell' | 'claude'>('shell');
  const [terminalKinds,setTerminalKinds]=useState<{id:string|null;kinds:('shell'|'claude')[]}>({id:null,kinds:[]});
  useEffect(()=>{if(tab==='terminal')setTerminalKinds(value=>({id:selectedId,kinds:value.id===selectedId?[...new Set([...value.kinds,command])]:[command]}));},[tab,selectedId,command]);
  const [connected, setConnected] = useState(true);
  const [connectionError, setConnectionError] = useState('');
  const snapshotRead = useRef<Promise<void> | null>(null);
  const workspaceLive = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (content.current) { content.current.scrollTop = 0; content.current.scrollLeft = 0; }
  }, [page, selectedId, tab]);
  const readSnapshot = useCallback(() => {
    if (snapshotRead.current) return snapshotRead.current;
    const request = api.snapshot().then(result => {
      if (workspaceLive.current) { setSnapshot(result); setConnected(true); setConnectionError(''); }
    }).catch(error => {
      if (workspaceLive.current) { setConnected(false); setConnectionError((error as Error).message); }
      throw error;
    }).finally(() => { snapshotRead.current = null; });
    snapshotRead.current = request;
    return request;
  }, []);
  const refresh = useCallback(async () => {
    // An action needs a fresh read after any older, in-flight snapshot finishes.
    await snapshotRead.current?.catch(() => {});
    await readSnapshot();
  }, [readSnapshot]);
  useEffect(() => {
    workspaceLive.current = true;
    const update = () => { if (!snapshotRead.current) void readSnapshot().catch(() => {}); };
    void update(); const timer = setInterval(() => void update(), 3000);
    return () => { workspaceLive.current = false; clearInterval(timer); };
  }, [readSnapshot]);
  const selected = snapshot?.environments.find(e => e.id === selectedId) ?? null;
  useEffect(()=>window.muDesktop?.onGuestApplication?.(value=>{
    setHandoff({id:value.id,application:['grok-bot','claude-desktop'].includes(value.application??'')?value.application as 'grok-bot'|'claude-desktop':undefined});
    visit(value.id,value.target==='browser'?'browser':'desktop');
    window.dispatchEvent(new CustomEvent('mu-desktop-focus',{detail:value}));
    void refresh();
  }),[refresh]);
  useEffect(()=>{if(page==='environment'&&selected?.state==='running'&&tab==='browser'&&selected.browserRunning)void api.focusGuest(selected.id,'browser').catch(()=>{});},[page,selected?.id,selected?.state,selected?.browserRunning,tab]);
  const active = snapshot?.jobs.find(j => j.environmentId === selected?.id && j.status === 'running');
  const systemJob = snapshot?.jobs.find(j => j.environmentId === null && j.status === 'running');
  function select(id: string) { setSelectedId(id); localStorage.setItem('mu-selected', id); setPage('environment'); setTab('overview'); setError(''); }
  function visit(id:string,next:Tab){select(id);setTab(next);}
  async function perform(action: string) {
    if (!selected) return;
    setError('');
    try { await api.action(selected.id, action); await refresh(); if (action === 'install-agent') setTab('logs'); }
    catch (error) { setError((error as Error).message); }
  }
  async function deleteEnvironment() {
    if (!deleteTarget) return;
    setDeleteBusy(true); setDeleteError('');
    try { await api.action(deleteTarget.id, 'delete'); setDeleteTarget(null); setPage('workspace'); await refresh(); }
    catch (error) { setDeleteError((error as Error).message); }
    finally { setDeleteBusy(false); }
  }
  async function installRuntime() { setError(''); try { await api.installRuntime(); await refresh(); } catch (error) { setError((error as Error).message); } }
  const stopped = !selected || selected.state !== 'running';
  const lifecycleLabel=active?({start:'启动中',stop:'停止中',restart:'重启中'} as Record<string,string>)[active.action]:undefined;
  return <div className="application">
    <aside className="sidebar"><button className="brand" title="MuCodeSandbox 工作区" aria-label="MuCodeSandbox 工作区" onClick={() => setPage('workspace')}><span className="brand-mark"><TerminalSquare size={23} /></span><span>MuCodeSandbox<small>LOCAL ENVIRONMENTS</small></span></button>
      <nav className="primary-nav"><button aria-label="工作区" title="工作区" className={page === 'workspace' ? 'active' : ''} onClick={() => setPage('workspace')}><LayoutDashboard size={17} /><span>工作区</span></button><button aria-label="检测实验室" title="检测实验室" className={page === 'lab' ? 'active' : ''} onClick={() => setPage('lab')}><FlaskConical size={17} /><span>检测实验室</span></button><button aria-label="操作记录" title="操作记录" className={page === 'activity' ? 'active' : ''} onClick={() => setPage('activity')}><Activity size={17} /><span>操作记录</span>{snapshot?.jobs.some(j => j.status === 'running') && <span className="live-dot" />}</button></nav>
      <div className="sidebar-section-heading"><span>环境</span><span>{snapshot?.environments.length ?? 0}</span><IconButton title="新建环境" disabled={!snapshot} onClick={() => setCreating(true)}><Plus size={16} /></IconButton></div>
      <div className="sidebar-search"><Search size={14} /><input aria-label="搜索环境" placeholder="搜索环境" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <div className="sidebar-environments">{snapshot?.environments.filter(e => `${e.name} ${e.description}`.toLowerCase().includes(search.toLowerCase())).map(e => <button key={e.id} title={e.name} aria-label={`${e.name} ${e.kind === 'vm' ? 'Linux 沙箱' : '浏览器环境'}`} className={`sidebar-env ${page === 'environment' && selectedId === e.id ? 'selected' : ''}`} onClick={() => select(e.id)}><span className={`small-env-symbol color-${e.color}`}>{e.kind === 'vm' ? <Box size={16} /> : <Globe size={16} />}</span><span><strong>{e.name}</strong><small>{e.kind === 'vm' ? 'Linux 沙箱' : '浏览器环境'}</small></span><span className={`sidebar-status dot-${e.state}`} /></button>)}{snapshot && !snapshot.environments.length && <span className="sidebar-empty">暂无环境</span>}</div>
      <div className="sidebar-bottom"><button aria-label="使用指南" title="使用指南" className={page==='help'?'active':''} onClick={()=>setPage('help')}><FolderOpen size={17}/><span>使用指南</span></button><button aria-label="系统设置" title="系统设置" className={page === 'system' ? 'active' : ''} onClick={() => setPage('system')}><Settings size={17} /><span>系统设置</span></button><div className="local-health"><span className={connected ? 'live-dot' : 'offline-dot'} /><span>{connected ? '本机服务已连接' : '连接已断开'}</span><small>v{snapshot?.system.version ?? VERSION}</small></div></div>
    </aside>
    <main className="main"><div className="topbar"><div className="breadcrumbs"><span>MuCodeSandbox</span><ChevronRight size={13} /><strong>{page === 'workspace' ? '工作区' : page === 'system' ? '系统设置' : page === 'activity' ? '操作记录' : page === 'lab' ? '检测实验室' : page==='help'?'使用指南':selected?.name ?? '环境'}</strong></div><span className="local-badge"><LockKeyhole size={12} /><span>{snapshot?.system.application?.channel==='desktop-test'?'桌面测试版':'源码预览'}</span><span className="build-label">{snapshot?.system.application?.buildId==='working-tree'?'开发中':snapshot?.system.application?.buildId.slice(0,8)}</span></span></div>
      <div className="main-content" ref={content}>{connectionError && <Notice kind="error">本机服务连接失败：{connectionError}；正在自动重试。</Notice>}{error && <div className="global-error"><Notice kind="error">{error}</Notice><IconButton title="关闭提示" onClick={() => setError('')}><X size={15} /></IconButton></div>}
        {snapshot?.system.hostNetwork?.state === 'failed' && <Notice kind="error">{snapshot.system.hostNetwork.issue}</Notice>}
        {!snapshot ? <div className="loading-view"><LoaderCircle className="spin" size={28} /><span>{connected ? '连接本机服务' : '服务连接失败'}</span></div> : page === 'workspace' ? <WorkspaceHome snapshot={snapshot} onCreate={() => setCreating(true)} onImport={() => setImporting(true)} onSelect={select} onSystem={()=>setPage('system')} onNetwork={id=>visit(id,'network')} onBrowser={id=>visit(id,'browser')} onHelp={()=>setPage('help')} search={search} />
          : page === 'system' ? <><header className="page-header"><div><div className="eyebrow">本机配置</div><h1>系统设置</h1><p>MuCodeSandbox <span>·</span> v{snapshot.system.version}</p></div></header><div className="panel-width"><SectionHeading title="Lima 运行组件" action={<Button className="primary" icon={<ArrowRight size={16} />} loading={Boolean(systemJob)} disabled={snapshot.system.runtime.available} onClick={() => void installRuntime()}>{snapshot.system.runtime.available ? '已安装' : '安装运行组件'}</Button>} /><dl className="facts"><div><dt>安装状态</dt><dd>{snapshot.system.runtime.available ? '已就绪' : '未安装'}</dd></div><div><dt>版本</dt><dd className="mono">{snapshot.system.runtime.version ?? '--'}</dd></div><div><dt>虚拟化后端</dt><dd>Apple Virtualization.framework</dd></div><div><dt>运行组件路径</dt><dd className="mono path-text">{snapshot.system.runtime.path ?? '--'}</dd></div></dl>{snapshot.system.runtime.error && <Notice kind="error">{snapshot.system.runtime.error}</Notice>}<div className="form-divider"><h3>本机信息</h3></div><dl className="facts"><div><dt>设备</dt><dd>{snapshot.system.hostname}</dd></div><div><dt>CPU</dt><dd>{snapshot.system.cpus} 核心</dd></div><div><dt>内存</dt><dd>{snapshot.system.memoryGiB} GB</dd></div><div><dt>数据目录</dt><dd className="mono path-text">{snapshot.system.dataDir}</dd></div><div><dt>浏览器</dt><dd>{snapshot.system.browser.engine}</dd></div></dl><SectionHeading title="组件安装记录" /><Jobs jobs={snapshot.jobs.filter(j => !j.environmentId)} refresh={refresh} /></div></>
          : page === 'activity' ? <><header className="page-header"><div><div className="eyebrow">本地工作区</div><h1>操作记录</h1><p>{snapshot.jobs.length} 条记录</p></div><IconButton title="刷新记录" onClick={() => void refresh()}><RefreshCw size={18} /></IconButton></header><Jobs jobs={snapshot.jobs} refresh={refresh} canNavigate={job=>snapshot.environments.some(e=>e.id===job.environmentId)} onNavigate={(job,next)=>{if(snapshot.environments.some(e=>e.id===job.environmentId))visit(job.environmentId!,next);}} /><div className="form-divider" /><LogsPanel /></>
          : page === 'lab' ? <LabPanel snapshot={snapshot} refresh={refresh} onConfigure={id=>visit(id,'network')} />
          : page === 'help' ? <HelpPanel onCreate={()=>setCreating(true)} onNetwork={()=>{const e=snapshot.environments.find(e=>e.kind==='vm');if(e)visit(e.id,'network');else setCreating(true);}} onLab={()=>setPage('lab')}/>
          : selected ? <EnvironmentStatusProvider environment={selected}><header className="page-header environment-header"><div className="environment-title"><span className={`environment-symbol large color-${selected.color}`}>{selected.kind === 'vm' ? <Box size={26} /> : <Globe size={26} />}</span><div><div className="eyebrow">{selected.kind === 'vm' ? 'LINUX SANDBOX' : 'BROWSER SESSION'}</div><div className="environment-title-line"><h1>{selected.name}</h1><LatencyBadge environment={selected}/></div></div></div><div className="environment-header-actions"><Status state={selected.state} /><Button className="environment-restart" title="重启环境" aria-label="重启环境" icon={<RefreshCw size={15}/>} disabled={stopped || Boolean(active)} onClick={() => void perform('restart')}>重启</Button><Button icon={lifecycleLabel?undefined:selected.state === 'running' ? <Square size={15} /> : <Play size={15} />} className={`environment-toggle ${selected.state === 'running' ? '' : 'primary'}`} disabled={Boolean(active)} onClick={() => void perform(selected.state === 'running' ? 'stop' : 'start')}>{lifecycleLabel??(selected.state === 'running' ? '停止' : '启动')}</Button></div></header>
            <ProtectionBanner environment={selected} onConfigure={()=>setTab('network')}/>
            {tab!=='logs'&&<ProtectionEvents key={`protection-${selected.id}`} environmentId={selected.id} environment={selected} compact active={Boolean(active)} onConfigure={()=>setTab('network')} onRetry={async()=>{await api.retryProtection(selected.id);await refresh();}}/>}
            <nav className="tabs grouped-tabs" aria-label="环境页面">{[{name:'日常使用',primary:true,ids:['overview','browser','desktop','agent','terminal']},{name:'线路与文件',primary:false,ids:['network','folders','bridge']},{name:'设置与恢复',primary:false,ids:['snapshots','settings','logs']}].map(group=><div className={`tab-group ${group.primary?'primary-tabs':'secondary-tabs'}`} key={group.name}><small>{group.name}</small><div>{tabs.filter(t=>group.ids.includes(t.id)&&(!('vm' in t)||selected.kind==='vm')).map(t=><button key={t.id} className={tab===t.id?'active':''} onClick={()=>{if(t.id==='terminal')setCommand('shell');setTab(t.id);}}><t.icon size={15}/>{t.label}</button>)}</div></div>)}</nav>
            {active && !(selected.kind==='vm'&&tab==='browser'&&active.action==='open-browser') && <div className="operation-banner"><LoaderCircle size={16} className="spin" /><span>{({ start: '正在启动环境', stop: '正在停止环境', restart: '正在重启环境', 'install-agent': '正在安装 Claude Code', 'open-browser': '正在打开浏览器', 'open-external-link':'正在打开客户端网页 / 返回客户端', delete: '正在删除环境' } as Record<string, string>)[active.action] ?? '正在执行操作'}</span><button onClick={() => setTab('logs')}>查看日志<ChevronRight size={13} /></button></div>}
            <div className="tab-content" key={selected.id}>
              {tab === 'overview' && <Overview environment={selected} snapshot={snapshot} refresh={refresh} onNavigate={setTab} />}
              {tab === 'folders' && <FoldersPanel environment={selected} refresh={refresh} />}
              {tab === 'network' && <NetworkPanel environment={selected} refresh={refresh} />}
              {keeps('browser') && <div className="retained-page" hidden={tab!=='browser'}><BrowserPanel environment={selected} snapshot={snapshot} refresh={refresh} onShowLogs={()=>setTab('logs')} visible={tab==='browser'} /></div>}
              {keeps('desktop') && <div className="retained-page" hidden={tab!=='desktop'}><Suspense fallback={<LoaderCircle className="spin" size={28}/>}><DesktopPanel environment={selected} snapshot={snapshot} refresh={refresh} onConfigure={()=>setTab('network')} visible={tab==='desktop'} preferredApplication={handoff?.id===selected.id?handoff.application:undefined}/></Suspense></div>}
              {tab === 'agent' && <AgentPanel environment={selected} onInstall={() => void perform('install-agent')} onTerminal={c => { setCommand(c); setTab('terminal'); }} />}
              {keeps('terminal') && <div className="retained-page" hidden={tab!=='terminal'}>{(selected.state === 'running' ? <Suspense fallback={<div className="loading-view"><LoaderCircle className="spin" size={24} /></div>}>{(['shell','claude'] as const).filter(kind=>kind===command||terminalKinds.id===selected.id&&terminalKinds.kinds.includes(kind)).map(kind=><div className="retained-page" key={`${selected.id}:${kind}`} hidden={command!==kind}><TerminalPanel environment={selected} command={kind} active={tab==='terminal'&&command===kind}/></div>)}</Suspense> : <div className="terminal-stopped"><TerminalSquare size={32} strokeWidth={1.4} /><h3>环境尚未运行</h3><Button icon={<Play size={14} />} className="primary" disabled={Boolean(active)} onClick={() => void perform('start')}>启动环境</Button></div>)}</div>}
              {tab === 'logs' && <LogsPanel environmentId={selected.id} environment={selected} onConfigure={()=>setTab('network')} />}
              {tab === 'snapshots' && <SnapshotsPanel environment={selected} active={Boolean(active)} refresh={refresh} />}
              {tab === 'bridge' && <BridgePanel environment={selected} active={Boolean(active)} refresh={refresh} />}
              {tab === 'settings' && <SettingsPanel environment={selected} system={snapshot.system} active={Boolean(active)} refresh={refresh} onDelete={() => {setDeleteError('');setDeleteTarget(selected);}} onRebuilt={id=>visit(id,'overview')} />}
            </div>
          </EnvironmentStatusProvider> : <div className="workspace-empty"><Box size={32} /><h2>环境已删除</h2><Button onClick={() => setPage('workspace')}>返回工作区</Button></div>}
      </div><footer className="app-footer"><span>MuCodeSandbox</span><span><ShieldCheck size={12} />{snapshot?.environments.filter(e => e.state === 'running').length ?? 0} 个环境运行中</span></footer>
    </main>
    {creating && snapshot && <CreateDialog system={snapshot.system} onClose={() => setCreating(false)} onCreated={e => { setCreating(false); void refresh(); select(e.id); }} />}
    {importing && <BackupDialog onClose={() => setImporting(false)} onSubmitted={async () => { await refresh(); setPage('activity'); }} />}
    {deleteTarget && <Modal title={`删除「${deleteTarget.name}」？`} onClose={() => {if(!deleteBusy)setDeleteTarget(null);}} narrow><div className="modal-body"><CleanupScope operation="delete" kind={deleteTarget.kind}/>{deleteError&&<Notice kind="error">{deleteError}</Notice>}</div><footer className="modal-footer"><Button disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>取消</Button><Button icon={<Trash2 size={16} />} className="danger-filled" loading={deleteBusy} onClick={() => void deleteEnvironment()}>删除环境</Button></footer></Modal>}
  </div>;
}
