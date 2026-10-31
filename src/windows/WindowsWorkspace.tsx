import {lazy,Suspense,useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Activity,Bot,Box,Camera,ChevronRight,Cpu,FlaskConical,FolderOpen,Globe,HardDrive,LayoutDashboard,Link2,LockKeyhole,MemoryStick,Monitor,PanelLeftClose,PanelLeftOpen,Play,Plus,RefreshCw,Search,Settings,ShieldCheck,SlidersHorizontal,Square,TerminalSquare,Upload} from 'lucide-react';
import type {Environment,Snapshot} from '../../shared/types.ts';
import type {WindowsSnapshotSummary} from '../../shared/windows-snapshots.ts';
import type {WindowsSnapshotBackupSelection} from '../../shared/windows-backup.ts';
import {api,editConfig,request} from '../api.ts';
import {Button,IconButton,Notice,SectionHeading,Status,dateLabel} from '../components.tsx';
import {WorkspaceHome} from '../WorkspaceHome.tsx';
import {Jobs,LogsPanel,Overview} from '../panels.tsx';
import {EnvironmentStatusProvider,useEnvironmentNetwork} from '../EnvironmentStatus.tsx';
import {windowsGuardSummaryVerified} from '../environment-status.ts';
import ProtectionEvents from '../ProtectionEvents.tsx';
import './windows.css';
import WindowsFilesPanel from './WindowsFilesPanel.tsx';
import WindowsSetupPanel from './WindowsSetupPanel.tsx';
import WindowsHostPanel from './WindowsHostPanel.tsx';
import WindowsStoragePanel from './WindowsStoragePanel.tsx';
import WindowsResourcesPanel from './WindowsResourcesPanel.tsx';
import WindowsPowerPanel from './WindowsPowerPanel.tsx';
import TranslationSettings from '../TranslationSettings.tsx';
import WindowsRecoveryWorkspace from './WindowsRecoveryWorkspace.tsx';
import WindowsDiskPanel from './WindowsDiskPanel.tsx';
import WindowsDiskCompactionPanel from './WindowsDiskCompactionPanel.tsx';
import WindowsBackupPanel from './WindowsBackupPanel.tsx';
import WindowsDeleteDialog from './WindowsDeleteDialog.tsx';
import WindowsBrowserDetails from './WindowsBrowserDetails.tsx';
import WindowsEnvironmentDialog from './WindowsEnvironmentDialog.tsx';
import {WindowsNetworkPanel,WindowsSettingsPanel} from './WindowsEnvironmentPanels.tsx';
import {LatencyBadge} from '../AccessLatency.tsx';
import WindowsHelpPanel from './WindowsHelpPanel.tsx';
import WindowsSnapshotRecoveryPanel from './WindowsSnapshotRecoveryPanel.tsx';
import WindowsSnapshotsPanel from './WindowsSnapshotsPanel.tsx';
import WindowsLabPanel from './WindowsLabPanel.tsx';
import WindowsAgentPanel from './WindowsAgentPanel.tsx';
import WindowsDesktopComponentsPanel from './WindowsDesktopComponentsPanel.tsx';
import WindowsChannelDiagnostics from './WindowsChannelDiagnostics.tsx';
const TerminalPanel=lazy(()=>import('../TerminalPanel.tsx'));
const WindowsBrowserView=lazy(()=>import('./WindowsBrowserView.tsx'));
const displayIssue=(message:string)=>message.replaceAll('Two distinct matching exit receipts are required','未获得两个与批准出口一致的核验结果，请检查代理和出口配置');
const applicationBuild=(info:Snapshot['system']['application'])=>info?.channel==='source-preview'&&info.buildId==='working-tree'?'开发中':/^[a-f0-9]{8,64}$/.test(info?.buildId??'')?info!.buildId:'构建信息不可用';
type Page='workspace'|'environment'|'system'|'activity'|'help'|'lab';
type Tab='overview'|'network'|'browser'|'desktop'|'files'|'terminal'|'agent'|'logs'|'settings'|'snapshots';
const pageLabels:Record<Page,string>={workspace:'工作区',environment:'环境',system:'系统设置',activity:'操作记录',help:'使用指南',lab:'检测实验室'};
const tabs=[{id:'overview',label:'总览',icon:LayoutDashboard,group:'日常使用'},{id:'browser',label:'浏览器',icon:Globe,group:'日常使用'},{id:'desktop',label:'桌面应用',icon:Monitor,group:'日常使用'},{id:'agent',label:'Claude Code',icon:Bot,group:'日常使用'},{id:'terminal',label:'终端',icon:TerminalSquare,group:'日常使用'},{id:'files',label:'文件传输',icon:FolderOpen,group:'线路与文件'},{id:'network',label:'网络',icon:ShieldCheck,group:'线路与文件'},{id:'bridge',label:'宿主授权',icon:Link2,group:'线路与文件',pending:true},{id:'logs',label:'日志',icon:Activity,group:'设置与恢复'},{id:'settings',label:'设置',icon:SlidersHorizontal,group:'设置与恢复'},{id:'snapshots',label:'快照',icon:Camera,group:'设置与恢复'}];

export function WindowsGuardSummary({environment,connected,onNetwork}:{environment:Environment;connected:boolean;onNetwork:()=>void}){
 const {protection,protectionError,loading}=useEnvironmentNetwork(),verified=windowsGuardSummaryVerified(environment,protection,connected);
 const [,expire]=useState(0);
 useEffect(()=>{
  if(!protection?.checkedAt)return;
  const deadline=Date.parse(protection.checkedAt)+Math.min(15000,protection.leaseRemainingMs??0),delay=deadline-Date.now();
  if(!Number.isFinite(delay)||delay<=0)return;
  const timer=setTimeout(()=>expire(value=>value+1),delay+1);return()=>clearTimeout(timer);
 },[protection?.checkedAt,protection?.leaseRemainingMs]);
 const summary=verified?'网络规则与限时联网许可已核验。':environment.state==='error'?'环境发生错误，请查看提示；如未确认停止，请先点击“停止”。':environment.state!=='running'?'环境未运行，业务联网未开放。':!connected?'本机服务连接已断开，无法确认防护状态。':protectionError?'防护状态读取失败，正在等待重试。':loading?'正在核验当前防护状态…':protection?'防护读数已过期或未通过，请查看线路并等待重新核验。':'防护状态尚未读取，等待下一次核验。';
 return <><div className={`windows-protection-summary ${verified?'verified':''}`}><ShieldCheck size={18}/><span>{summary}</span><Button onClick={onNetwork}>查看线路</Button></div>{protectionError&&<Notice kind="error">{protectionError==='状态读取超时，请等待重新核验。'?'防护状态读取超时，请等待重新核验。':protectionError}</Notice>}</>;
}

export default function WindowsWorkspace(){
 if(window.__MU_CONFIG__?.windowsMode==='recovery')return <WindowsRecoveryWorkspace/>;
 return <WindowsNormalWorkspace/>;
}
function WindowsNormalWorkspace(){
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[selectedId,select]=useState<string|null>(null),[page,setPage]=useState<Page>('workspace'),[tab,setTab]=useState<Tab>('overview'),[search,setSearch]=useState('');
 const [error,setError]=useState(''),[connected,setConnected]=useState(true),[dialog,setDialog]=useState<'new'|Environment|null>(null),[deleting,setDeleting]=useState<Environment|null>(null);
 const [browserRequest,setBrowserRequest]=useState<{id:string;action:'open'|'close'}|null>(null),browserRequestRef=useRef(false);
 const [shellEnvironment,setShellEnvironment]=useState<string|null>(null);
 const [sidebarCollapsed,setSidebarCollapsed]=useState(()=>{try{return localStorage.getItem('mu-windows-sidebar-collapsed')==='true';}catch{return false;}});
 useEffect(()=>{try{localStorage.setItem('mu-windows-sidebar-collapsed',String(sidebarCollapsed));}catch{/* Layout remains usable when storage is unavailable. */}},[sidebarCollapsed]);
 const [backupRequest,setBackupRequest]=useState(0),[backupMode,setBackupMode]=useState<'export'|'restore'>('restore');
 const [backupSnapshot,setBackupSnapshot]=useState<WindowsSnapshotBackupSelection|null>(null);
 const live=useRef(false),pending=useRef<Promise<void>|null>(null),refreshError=useRef<Error|null>(null),content=useRef<HTMLDivElement>(null);
 const refresh=useCallback(()=>{
  if(pending.current)return pending.current;
  return pending.current=api.snapshot().then(value=>{refreshError.current=null;if(live.current){setSnapshot(value);setConnected(true);}}).catch(e=>{refreshError.current=e as Error;if(live.current){setConnected(false);setError((e as Error).message);}}).finally(()=>{pending.current=null;});
 },[]);
 useEffect(()=>{live.current=true;void refresh();const timer=setInterval(()=>void refresh(),3000);return()=>{live.current=false;clearInterval(timer);};},[refresh]);
 useLayoutEffect(()=>{if(content.current){content.current.scrollTop=0;content.current.scrollLeft=0;}},[page,selectedId,tab]);
 const selected=snapshot?.environments.find(e=>e.id===selectedId),active=snapshot?.jobs.find(j=>j.environmentId===selectedId&&j.status==='running'),caps=window.__MU_CONFIG__.capabilities;
 const environmentJobs=snapshot?.jobs.filter(j=>j.environmentId===selectedId&&j.status==='running')??[];
 const browserOperation=environmentJobs.find(job=>job.action==='open-browser'||job.action==='close-browser')?.action??(browserRequest?.id===selectedId?`${browserRequest.action}-browser`:undefined);
 const passiveDeletion=selected?.state==='running'&&environmentJobs.length>0&&environmentJobs.every(job=>job.action==='snapshot-delete-live'||job.action==='snapshot-export'||job.action==='install-agent'||job.action==='install-desktop'||job.action==='desktop-start'||job.action==='desktop-stop'),accessBusy=!!active&&!passiveDeletion;
 const browserViewBusy=selected?.state==='running'&&environmentJobs.length>0&&environmentJobs.every(job=>job.action==='open-browser'||job.action==='close-browser');
 useEffect(()=>{if(!selected||selected.state!=='running'||accessBusy&&!browserViewBusy)setShellEnvironment(null);else if(page==='environment'&&tab==='terminal'&&selectedId&&!accessBusy)setShellEnvironment(selectedId);},[page,tab,selectedId,selected?.state,accessBusy,browserViewBusy]);
 const logId=page==='environment'?selectedId:null;
 function visit(id:string,next:Tab='overview'){select(id);setPage('environment');setTab(next);setError('');}
 function create(){if(!snapshot?.system.runtime.available){setPage('system');return;}setDialog('new');}
 function backup(mode:'export'|'restore',record?:WindowsSnapshotSummary){setBackupSnapshot(record?{environmentId:record.environmentId,snapshotId:record.id,name:record.name,createdAt:record.createdAt}:null);setBackupMode(mode);setBackupRequest(value=>value+1);}
 async function action(name:'start'|'stop'|'restart'){
  if(!selected)return;setError('');try{await api.action(selected.id,name);await pending.current;await refresh();}catch(e){setError((e as Error).message);}
 }
 async function browserAction(action:'open'|'close'){
  if(!selected||browserRequestRef.current)return;browserRequestRef.current=true;setBrowserRequest({id:selected.id,action});setError('');try{await request(`/environments/${selected.id}/browser/${action}`,{method:'POST',body:JSON.stringify(action==='open'&&caps?.browserStartup?{startup:'configured'}:{})});await pending.current;await refresh();}catch(e){setError((e as Error).message);}finally{browserRequestRef.current=false;setBrowserRequest(null);}
 }
 async function refreshBrowserSettings(){await pending.current;const previous=refreshError.current;await refresh();if(refreshError.current)throw refreshError.current;if(previous)setError(value=>value===previous.message?'':value);}
 async function retryProtection(){if(!selected)throw Error('请选择一个环境。');await api.action(selected.id,'start');await pending.current;await refresh();}
 const filtered=snapshot?.environments.filter(e=>`${e.name} ${e.description}`.toLowerCase().includes(search.toLowerCase()))??[];
 const logPanel=<><LogsPanel key={logId??'workspace'} environmentId={logId??undefined} environment={page==='environment'?selected:undefined} environments={!logId?snapshot?.environments:undefined} onConfigure={()=>setTab('network')} onRetry={retryProtection} active={!!active} hostLabel="Windows" networkActivity={!!caps?.networkObservations}/><WindowsChannelDiagnostics/></>;
 return <div className={`application windows-preview ${sidebarCollapsed?'sidebar-collapsed':''}`}>
  <aside className="sidebar" id="windows-sidebar" aria-label="工作区导航">
   <button className="brand" title="MuCodeSandbox 工作区" aria-label="MuCodeSandbox 工作区" onClick={()=>setPage('workspace')}><span className="brand-mark"><TerminalSquare size={23}/></span><span>MuCodeSandbox<small>LOCAL ENVIRONMENTS</small></span></button>
   <nav className="primary-nav"><button aria-label="工作区" className={page==='workspace'?'active':''} onClick={()=>setPage('workspace')}><LayoutDashboard size={17}/><span>工作区</span></button><button aria-label="检测实验室" disabled={!caps?.localChecks} title={caps?.localChecks?'检测实验室':'Windows 检测实验室尚未提供'} className={page==='lab'?'active':''} onClick={()=>setPage('lab')}><FlaskConical size={17}/><span>检测实验室</span></button><button aria-label="操作记录" className={page==='activity'?'active':''} onClick={()=>setPage('activity')}><Activity size={17}/><span>操作记录</span>{snapshot?.jobs.some(j=>j.status==='running')&&<span className="live-dot"/>}</button></nav>
   <div className="sidebar-section-heading"><span>环境</span><span>{snapshot?.environments.length??0}</span><IconButton title="新建环境" disabled={!snapshot||!connected} onClick={create}><Plus size={16}/></IconButton></div>
   <div className="sidebar-search"><Search size={14}/><input aria-label="搜索环境" placeholder="搜索环境" value={search} onChange={e=>setSearch(e.target.value)}/></div>
   <div className="sidebar-environments">{filtered.map(e=><button key={e.id} title={e.name} aria-label={`${e.name} Linux 沙箱`} className={`sidebar-env ${page==='environment'&&selectedId===e.id?'selected':''}`} onClick={()=>visit(e.id)}><span className={`small-env-symbol color-${e.color}`}><Box size={16}/></span><span><strong>{e.name}</strong><small>Linux 沙箱</small></span><span className={`sidebar-status dot-${e.state}`}/></button>)}{snapshot&&!filtered.length&&<span className="sidebar-empty">{search?'没有匹配的环境':'暂无环境'}</span>}</div>
   <div className="sidebar-bottom"><button className={page==='help'?'active':''} onClick={()=>setPage('help')}><FolderOpen size={17}/><span>使用指南</span></button><button className={page==='system'?'active':''} onClick={()=>setPage('system')}><Settings size={17}/><span>系统设置</span></button><div className="local-health"><span className={connected?'live-dot':'offline-dot'}/><span>{connected?'本机服务已连接':'连接已断开'}</span><small>v{snapshot?.system.version??window.__MU_CONFIG__.version}</small></div></div>
  </aside>
  <main className="main"><div className="topbar"><div className="windows-topbar-location"><button type="button" className="icon-button sidebar-toggle" title={sidebarCollapsed?'展开侧栏':'收起侧栏'} aria-label={sidebarCollapsed?'展开侧栏':'收起侧栏'} aria-expanded={!sidebarCollapsed} aria-controls="windows-sidebar" onClick={()=>setSidebarCollapsed(value=>!value)}>{sidebarCollapsed?<PanelLeftOpen size={17}/>:<PanelLeftClose size={17}/>}</button><div className="breadcrumbs"><span>MuCodeSandbox</span><ChevronRight size={13}/><strong>{page==='environment'?selected?.name??'环境':pageLabels[page]}</strong></div></div><span className="local-badge"><LockKeyhole size={12}/>Windows 开发预览{snapshot&&<span className="build-label">{applicationBuild(snapshot.system.application).slice(0,8)}</span>}</span></div>
   <div className="main-content" ref={content}>
    {error&&<Notice kind="error">{error}</Notice>}
    {snapshot?.system.hostNetwork?.issue&&<Notice kind="error">{snapshot.system.hostNetwork.issue}。请退出并重新打开预览后再启动环境。</Notice>}
    {snapshot?.system.hostResourceIssue&&<Notice kind="error">{snapshot.system.hostResourceIssue}。请处理资源压力后重新打开软件。</Notice>}
    {snapshot?.system.hostPowerIssue&&<Notice kind="error">{snapshot.system.hostPowerIssue}。请重新打开软件后再启动。</Notice>}
    {snapshot?.system.hostSnapshotIssue&&<Notice kind="error">{snapshot.system.hostSnapshotIssue}。<Button onClick={()=>setPage('system')}>查看快照恢复状态</Button></Notice>}
    {!snapshot?<div className="loading-view">连接本机服务…</div>:page==='workspace'?<WorkspaceHome requireSandboxStart snapshot={snapshot} onCreate={create} onImport={()=>backup('restore')} onSelect={id=>visit(id)} onSystem={()=>setPage('system')} onNetwork={id=>visit(id,'network')} onBrowser={id=>visit(id,'browser')} onHelp={()=>setPage('help')} search={search} platformLabel="Windows · x64" createDisabled={!connected} importDisabled={!caps?.backups||!connected} hostAccess="文件按需传输" hostAccessDetail="手动上传与下载，不持续共享">
     {caps?.hostSetup&&<WindowsHostPanel showReady={false} onChange={refresh}/>}
     {caps?.setup&&!snapshot.system.runtime.available&&<WindowsSetupPanel onReady={refresh}/>}
    </WorkspaceHome>:page==='lab'&&caps?.localChecks?<WindowsLabPanel snapshot={snapshot} disabled={!connected} onConfigure={id=>visit(id,'network')} onJobs={refreshBrowserSettings}/>:page==='system'?<>
     <header className="page-header"><div><div className="eyebrow">本机配置</div><h1>系统设置</h1><p>MuCodeSandbox <span>·</span> v{snapshot.system.version}</p></div></header>
     {caps?.hostSetup&&<WindowsHostPanel showReady onChange={refresh}/>}
     {caps?.setup&&!snapshot.system.runtime.available&&<WindowsSetupPanel onReady={refresh}/>}
     {caps?.snapshotRecovery&&<WindowsSnapshotRecoveryPanel environments={snapshot.environments} onChange={refresh} disabled={!connected||snapshot.jobs.some(job=>job.status==='running')}/>}
     <div className="panel-width"><SectionHeading title="Linux 运行组件"/><dl className="facts"><div><dt>安装状态</dt><dd>{snapshot.system.runtime.available?'已就绪':'需要准备'}</dd></div><div><dt>虚拟化后端</dt><dd>Windows Hyper-V</dd></div><div><dt>运行组件路径</dt><dd className="path-text">{snapshot.system.runtime.path??'--'}</dd></div><div><dt>应用构建标识</dt><dd className="mono">{applicationBuild(snapshot.system.application)}</dd></div><div><dt>应用构建时间</dt><dd>{snapshot.system.application?.builtAt?new Date(snapshot.system.application.builtAt).toLocaleString():'未提供'}</dd></div><div><dt>设备</dt><dd>{snapshot.system.hostname}</dd></div><div><dt>CPU</dt><dd>{snapshot.system.cpus} 核心</dd></div><div><dt>内存</dt><dd>{snapshot.system.memoryGiB} GB</dd></div><div><dt>数据目录</dt><dd className="path-text">{snapshot.system.dataDir}</dd></div></dl>
      {snapshot.system.runtime.error&&snapshot.system.runtime.error!=='请先准备空白受保护基盘'&&<Notice kind="error">{snapshot.system.runtime.error}</Notice>}
      {caps?.backups&&<><SectionHeading title="加密备份与恢复"/><div className="button-row"><Button onClick={()=>backup('restore')} icon={<Upload size={15}/>}>导入备份</Button><Button onClick={()=>backup('export')}>保存备份</Button></div></>}
      <section className="windows-system-translation"><SectionHeading title="中文输入与翻译"/><p>配置翻译所需的 DeepSeek Key 后，可在环境的中文输入小窗中主动使用翻译。</p>{connected?<TranslationSettings hostName="Windows"/>:<Notice>本机服务连接后可配置翻译。</Notice>}</section>
      {caps?.storage&&<><WindowsStoragePanel/><WindowsResourcesPanel/><WindowsPowerPanel/></>}
     </div>
    </>:page==='activity'?<><header className="page-header"><div><div className="eyebrow">本地工作区</div><h1>操作记录</h1><p>{snapshot.jobs.length} 条记录</p></div><IconButton title="刷新记录" onClick={()=>void refresh()}><RefreshCw size={18}/></IconButton></header><Jobs jobs={snapshot.jobs} refresh={refresh} canCancel={job=>job.action!=='delete'}/><div className="form-divider"/>{logPanel}</>:page==='help'?<WindowsHelpPanel onCreate={create} onSystem={()=>setPage('system')} onNetwork={()=>{const environment=snapshot.environments[0];if(environment)visit(environment.id,'network');else create();}} onBackup={()=>backup('restore')}/>:selected?<EnvironmentStatusProvider key={selected.id} environment={selected} busy={accessBusy||browserRequest?.id===selected.id}>
     <header className="page-header environment-header"><div className="environment-title"><span className={`environment-symbol large color-${selected.color}`}><Box size={26}/></span><div><div className="eyebrow">LINUX SANDBOX</div><div className="environment-title-line"><h1>{selected.name}</h1>{!accessBusy&&<LatencyBadge environment={selected}/>}</div></div></div><div className="environment-header-actions"><Status state={selected.state}/><Button title="重启环境" aria-label="重启环境" disabled={!connected||!!active||selected.state!=='running'} onClick={()=>void action('restart')} icon={<RefreshCw size={15}/>}>重启</Button><Button icon={<Square size={15}/>} className="environment-stop" disabled={!connected||accessBusy||!['running','error'].includes(selected.state)} onClick={()=>void action('stop')}>停止</Button><Button icon={<Play size={15}/>} className="environment-start primary" loading={accessBusy} disabled={!connected||selected.state==='running'||!['stopped','error','not_created'].includes(selected.state)} onClick={()=>void action('start')}>{accessBusy?'处理中':'启动'}</Button></div></header>
     {selected.lastError&&<Notice kind="error">{displayIssue(selected.lastError)}</Notice>}
     <WindowsGuardSummary environment={selected} connected={connected} onNetwork={()=>setTab('network')}/>
     {tab!=='logs'&&<ProtectionEvents key={`protection-${selected.id}`} environmentId={selected.id} environment={selected} compact active={!!active} onConfigure={()=>setTab('network')} onRetry={retryProtection}/>}
     <nav className="tabs grouped-tabs" aria-label="环境页面">{['日常使用','线路与文件','设置与恢复'].map((name,index)=><div className={`tab-group ${index===0?'primary-tabs':'secondary-tabs'}`} key={name}><small>{name}</small><div>{tabs.filter(t=>t.group===name).map(t=>{const unsupported=!!t.pending||t.id==='desktop'&&!caps?.desktopComponents||t.id==='agent'&&!caps?.agent||t.id==='snapshots'&&!caps?.snapshots||t.id==='terminal'&&!caps?.terminal||t.id==='browser'&&!caps?.browser||t.id==='files'&&!caps?.files;return <button key={t.id} disabled={unsupported} title={unsupported?'此功能尚未在 Windows 提供':undefined} className={tab===t.id?'active':''} onClick={()=>setTab(t.id as Tab)}><t.icon size={15}/>{t.label}</button>;})}</div></div>)}</nav>
     <div className="tab-content" key={selected.id} hidden={tab==='terminal'}>
      {tab==='overview'&&<Overview environment={selected} snapshot={snapshot} refresh={refresh} platform="windows" onNavigate={next=>next==='system'?setPage('system'):setTab(next==='network'||next==='browser'||next==='logs'?next:'settings')}/>}
      {tab==='network'&&<WindowsNetworkPanel environment={selected} refresh={refresh} disabled={!connected||!!active}/>}
      {tab==='browser'&&<><SectionHeading title="浏览器" action={<Button disabled={!connected||selected.state!=='running'||!!active||browserRequestRef.current} onClick={()=>void browserAction(selected.browserRunning?'close':'open')}>{browserOperation==='open-browser'?'正在打开…':browserOperation==='close-browser'?'正在关闭…':selected.browserRunning?'关闭浏览器':'打开浏览器'}</Button>}/>{browserOperation==='close-browser'&&<Notice>正在关闭浏览器，请稍候。</Notice>}{selected.state==='running'&&selected.browserRunning?<Suspense fallback={<p>加载画面…</p>}><WindowsBrowserView key={selected.id} environment={selected}/></Suspense>:<div className="terminal-stopped" aria-live="polite"><Globe size={32}/><h3>{selected.state!=='running'?'环境尚未运行':browserOperation==='open-browser'?'正在打开浏览器…':browserOperation==='close-browser'?'正在关闭浏览器…':'浏览器尚未打开'}</h3><p>{browserOperation==='open-browser'?'正在准备浏览器并核验网络保护，请稍候。':'浏览器在独立 Linux 环境中运行。'}</p></div>}</>}
      {tab==='browser'&&caps?.browserDetails&&<WindowsBrowserDetails environment={selected} disabled={!connected||!!active} startupEnabled={!!caps?.browserStartup} resetEnabled={!!caps?.browserReset} repairEnabled={!!caps?.browserRepair} jobs={snapshot.jobs} onChange={refreshBrowserSettings}/>}
      {caps?.agent&&<div hidden={tab!=='agent'}><WindowsAgentPanel key={selected.id} environment={selected} jobs={snapshot.jobs} disabled={!connected||accessBusy} visible={tab==='agent'} onShell={()=>setTab('terminal')} onChange={refresh}/></div>}
      {caps?.desktopComponents&&<div hidden={tab!=='desktop'}><WindowsDesktopComponentsPanel key={selected.id} environment={selected} jobs={snapshot.jobs} disabled={!connected||accessBusy} visible={tab==='desktop'} onConfigure={()=>setTab('network')} onChange={refresh}/></div>}
      {tab==='files'&&(selected.state==='running'&&!accessBusy?<WindowsFilesPanel key={selected.id} id={selected.id} environment={selected} independentView={!!caps?.independentFileView} canCreateDirectories={!!caps?.fileDirectories} canOpenFolder={!!caps?.fileManager} viewerReady={!!selected.browserRunning} onShowFolder={()=>setTab('browser')} onUploadInterrupted={()=>setError('离开文件页面时上传已中断，保存结果尚未确认；请返回下载目录核对后再决定是否重试。')}/>:<><SectionHeading title="文件传输"/><Notice>启动环境后，可以手动上传、下载和管理 Linux 中的文件。持续共享目录尚未提供。</Notice></>)}
      {tab==='settings'&&<WindowsSettingsPanel environment={selected} refresh={refresh} disabled={!connected||!!active}>
       {caps?.diskGrowth&&<WindowsDiskPanel key={selected.id+':'+selected.diskGiB+':'+selected.state} environment={selected} disabled={!connected||!!active} onChange={refresh}/>}
       {caps?.diskCompaction&&<WindowsDiskCompactionPanel key={selected.id} environment={selected} disabled={!connected||!!active} onChange={refresh}/>}
       <div className="form-divider"><h3>加密备份</h3></div>{caps?.backups&&<Button disabled={!connected||!!active||selected.state!=='stopped'} onClick={()=>backup('export')}>保存加密备份</Button>}
       {caps?.remove&&<section className="windows-danger-zone"><SectionHeading title="删除环境" action={<Button className="danger" disabled={!connected||!!active||['running','starting','creating'].includes(selected.state)} onClick={()=>setDeleting(selected)}>删除环境</Button>}/><p>永久删除此环境的虚拟磁盘和管理密钥。已单独保存的加密备份由你自行保管。</p></section>}
      </WindowsSettingsPanel>}
      {tab==='snapshots'&&caps?.snapshots&&<WindowsSnapshotsPanel key={selected.id} environment={selected} jobs={snapshot.jobs} disabled={!connected} refresh={refresh} onRecovery={()=>setPage('system')} onCleanup={caps.backups?()=>backup('restore'):undefined} onExport={caps.backups?record=>backup('export',record):undefined}/>}
      {tab==='logs'&&logPanel}
     </div>
    </EnvironmentStatusProvider>:<div className="workspace-empty"><Box size={32}/><h2>环境已删除</h2><Button onClick={()=>setPage('workspace')}>返回工作区</Button></div>}
    {snapshot&&selected&&(page==='environment'&&tab==='terminal'||shellEnvironment===selected.id)&&<div className="tab-content windows-terminal-content" hidden={page!=='environment'||tab!=='terminal'}>{selected.state==='running'&&(!accessBusy||browserViewBusy&&shellEnvironment===selected.id)?<Suspense fallback={<p>加载终端…</p>}><TerminalPanel key={selected.id} environment={selected} active={page==='environment'&&tab==='terminal'} quickTools="text"/></Suspense>:<div className="terminal-stopped"><TerminalSquare size={32}/><h3>环境尚未运行或正在处理操作</h3><Button className="primary" disabled={!connected||!!active} onClick={()=>void action('start')}>启动环境</Button></div>}</div>}
   </div><footer className="app-footer"><span>MuCodeSandbox</span><span><ShieldCheck size={12}/>{snapshot?.environments.filter(e=>e.state==='running').length??0} 个环境运行中</span></footer>
  </main>
  {snapshot&&caps?.backups&&<WindowsBackupPanel environments={snapshot.environments} onChange={refresh} showHeading={false} requestOpen={backupRequest} defaultMode={backupMode} preferredEnvironmentId={selectedId} historicalSnapshot={backupSnapshot}/>}
  {dialog&&snapshot&&<WindowsEnvironmentDialog environment={dialog==='new'?undefined:dialog} system={snapshot.system} onClose={()=>setDialog(null)} onSave={async id=>{await pending.current;await refresh();setDialog(null);visit(id);}}/>}
  {deleting&&<WindowsDeleteDialog environment={deleting} onClose={()=>setDeleting(null)} onDeleted={async()=>{await pending.current;await refresh();if(refreshError.current)throw refreshError.current;if(live.current){setError('');setDeleting(null);setPage('workspace');}}}/>}
 </div>;
}
