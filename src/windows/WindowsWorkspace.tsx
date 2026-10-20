import {useCallback,useEffect,useRef,useState} from 'react';
import {Box,LockKeyhole,Plus,RefreshCw,Settings,ShieldCheck,TerminalSquare} from 'lucide-react';
import type {Environment,LogEntry,NetworkProtection,Snapshot} from '../../shared/types.ts';
import {api,editConfig} from '../api.ts';
import {Button,Field,Modal,Notice,SectionHeading,Status,dateLabel} from '../components.tsx';
import './windows.css';

const displayIssue=(message:string)=>message.replaceAll('Two distinct matching exit receipts are required','未获得两个与批准出口一致的核验结果，请检查代理和出口配置');

export default function WindowsWorkspace(){
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[selectedId,select]=useState<string|null>(null),[system,showSystem]=useState(false);
 const [error,setError]=useState(''),[connected,setConnected]=useState(true),[dialog,setDialog]=useState<'new'|Environment|null>(null);
 const [protection,setProtection]=useState<NetworkProtection|null>(null),[guardError,setGuardError]=useState(''),[logs,setLogs]=useState<LogEntry[]>([]);
 const live=useRef(false),pending=useRef<Promise<void>|null>(null);
 const refresh=useCallback(()=>{
  if(pending.current)return pending.current;
  return pending.current=api.snapshot().then(value=>{if(live.current){setSnapshot(value);setConnected(true);}}).catch(e=>{if(live.current){setConnected(false);setError((e as Error).message);}}).finally(()=>{pending.current=null;});
 },[]);
 useEffect(()=>{live.current=true;void refresh();const timer=setInterval(()=>void refresh(),3000);return()=>{live.current=false;clearInterval(timer);};},[refresh]);
 const selected=snapshot?.environments.find(e=>e.id===selectedId),active=snapshot?.jobs.find(j=>j.environmentId===selectedId&&j.status==='running');
 useEffect(()=>{
  let disposed=false,busy=false;setProtection(null);setGuardError('');setLogs([]);
  const update=async()=>{
   if(busy)return;busy=true;
   try{const rows=await api.logs(selectedId??undefined);if(!disposed)setLogs(rows);}
   catch(e){if(!disposed)setError((e as Error).message);}
   if(selectedId&&selected?.state==='running'){
    try{const value=await api.protection(selectedId);if(!disposed){setProtection(value);setGuardError('');}}
    catch(e){if(!disposed){setProtection(null);setGuardError((e as Error).message);}}
   }busy=false;
  };
  void update();const timer=setInterval(()=>void update(),10000);return()=>{disposed=true;clearInterval(timer);};
 },[selectedId,selected?.state]);
 async function action(name:'start'|'stop'|'restart'){
  if(!selected)return;setError('');try{await api.action(selected.id,name);await pending.current;await refresh();}catch(e){setError((e as Error).message);}
 }
 const verified=connected&&selected?.state==='running'&&protection?.active&&protection.integrity==='verified'&&Date.now()-Date.parse(protection.checkedAt)<15000;
 return <div className="application windows-preview">
  <aside className="sidebar">
   <button className="brand" onClick={()=>{showSystem(false);select(null);}}><span className="brand-mark"><TerminalSquare size={23}/></span><span>MuCodeSandbox<small>WINDOWS PREVIEW</small></span></button>
   <nav className="primary-nav"><button onClick={()=>{showSystem(false);select(null);}}><Box size={17}/><span>工作区</span></button><button onClick={()=>showSystem(true)}><Settings size={17}/><span>系统状态</span></button></nav>
   <div className="sidebar-section-heading"><span>Linux 环境</span><Button aria-label="新建环境" disabled={!snapshot} onClick={()=>setDialog('new')} icon={<Plus size={15}/>}/></div>
   <div className="sidebar-environments">{snapshot?.environments.map(e=><button key={e.id} className={`sidebar-env ${selectedId===e.id&&!system?'selected':''}`} onClick={()=>{showSystem(false);select(e.id);}}><span className={`small-env-symbol color-${e.color}`}><Box size={16}/></span><span><strong>{e.name}</strong><small>Hyper-V · Linux</small></span><span className={`sidebar-status dot-${e.state}`}/></button>)}</div>
   <div className="sidebar-bottom"><div className="local-health"><span className={connected?'live-dot':'offline-dot'}/><span>{connected?'本机服务已连接':'连接已断开'}</span></div></div>
  </aside>
  <main className="main"><div className="topbar"><div className="breadcrumbs"><strong>MuCodeSandbox · Windows</strong></div><span className="local-badge"><LockKeyhole size={12}/>开发预览</span></div>
   <div className="main-content">
    {error&&<Notice kind="error">{error}</Notice>}
    {snapshot?.system.hostNetwork?.issue&&<Notice kind="error">{snapshot.system.hostNetwork.issue}。请退出并重新打开预览后再启动环境。</Notice>}
    {!snapshot?<div className="loading-view">连接 Windows 本机服务…</div>:system?<>
     <header className="page-header"><div><div className="eyebrow">WINDOWS</div><h1>系统状态</h1><p>Hyper-V 管理预览</p></div></header>
     <dl className="facts"><div><dt>运行组件</dt><dd>{snapshot.system.runtime.available?'已就绪':'需要处理'}</dd></div><div><dt>虚拟化后端</dt><dd>Windows Hyper-V</dd></div><div><dt>设备资源</dt><dd>{snapshot.system.cpus} 核心 · {snapshot.system.memoryGiB} GiB</dd></div><div><dt>数据目录</dt><dd className="path-text">{snapshot.system.dataDir}</dd></div><div><dt>版本</dt><dd>{snapshot.system.version}</dd></div></dl>
     {snapshot.system.runtime.error&&<Notice kind="error">{snapshot.system.runtime.error}</Notice>}
     <Notice>当前可创建、启动、停止和核验 Linux 环境。浏览器、终端、文件传输、共享、快照和安装包仍在开发。</Notice>
    </>:selected?<>
     <header className="page-header environment-header"><div><div className="eyebrow">HYPER-V · LINUX</div><h1>{selected.name}</h1><p>{selected.description}</p></div><div className="environment-header-actions"><Status state={selected.state}/><Button disabled={!connected||!!active||selected.state!=='running'} onClick={()=>void action('restart')} icon={<RefreshCw size={15}/>}>重启</Button><Button className="primary" loading={!!active} disabled={!connected} onClick={()=>void action(selected.state==='running'?'stop':'start')}>{active?'处理中':selected.state==='running'?'停止':'启动'}</Button></div></header>
     {selected.lastError&&<Notice kind="error">{displayIssue(selected.lastError)}</Notice>}
     <Notice kind={verified?'success':'info'}>{verified?'网络规则与限时联网许可已核验。':selected.state==='running'?'正在核验当前防护状态…':selected.state==='error'?'环境未通过核验，请处理错误后重新启动。':'环境未运行，业务联网未开放。'}</Notice>
     {guardError&&<Notice kind="error">{guardError}</Notice>}
     <SectionHeading title="环境配置" action={<Button disabled={!!active||selected.state==='running'} onClick={()=>setDialog(selected)}>编辑配置</Button>}/>
     <dl className="facts"><div><dt>资源</dt><dd>{selected.cpus} 核心 · {selected.memoryGiB} GiB 内存 · {selected.diskGiB} GiB 磁盘</dd></div><div><dt>代理</dt><dd>{selected.network.mode.toUpperCase()} · {selected.network.host}:{selected.network.port}</dd></div><div><dt>批准的出口</dt><dd>{selected.network.egressLock?.expectedIp}</dd></div><div><dt>时区</dt><dd>{selected.identity.timezone}</dd></div><div><dt>凭据</dt><dd>{selected.network.passwordConfigured?'已加密保存':'未设置密码'}</dd></div></dl>
    </>:<>
     <header className="page-header"><div><div className="eyebrow">WINDOWS PREVIEW</div><h1>工作区</h1><p>独立 Linux 环境 · 严格代理联网</p></div><Button className="primary" disabled={!connected} onClick={()=>setDialog('new')} icon={<Plus size={16}/>}>新建环境</Button></header>
     <Notice>先配置代理和明确批准的出口 IPv4。启动时核验出口，核验失败或连接中断会关闭环境。</Notice>
     {snapshot.system.runtime.error&&<Notice kind="error">{snapshot.system.runtime.error}</Notice>}
     <div className="env-table">{snapshot.environments.map(e=><button key={e.id} className="windows-environment-row" onClick={()=>select(e.id)}><span className="env-table-name"><ShieldCheck size={20}/><strong>{e.name}</strong></span><span>{e.cpus} 核心 · {e.memoryGiB} GiB</span><Status state={e.state}/></button>)}</div>
     {!snapshot.environments.length&&<div className="workspace-empty"><Box size={32}/><h2>创建第一个 Windows Linux 环境</h2></div>}
    </>}
    {snapshot&&<><SectionHeading title="操作记录"/>{snapshot.jobs.filter(j=>!selectedId||j.environmentId===selectedId).slice(0,8).map(j=><div className="windows-job" key={j.id}><strong>{({start:'启动',stop:'停止',restart:'重启'} as Record<string,string>)[j.action]??j.action}</strong><span>{({running:'进行中',succeeded:'完成',failed:'失败',cancelled:'已取消'} as Record<string,string>)[j.status]} {displayIssue(j.message)}</span>{j.status==='running'&&<Button onClick={()=>void api.cancel(j.id).catch(e=>setError(e.message))}>取消</Button>}<time>{dateLabel(j.createdAt)}</time></div>)}
     <SectionHeading title="本地日志"/><div className="log-surface">{logs.length?logs.map(row=><div className="log-entry" key={row.id}><time>{dateLabel(row.createdAt)}</time><span>{row.level}</span><p>{row.message}</p></div>):<p>暂无日志</p>}</div></>}
   </div>
  </main>
  {dialog&&snapshot&&<WindowsEnvironmentDialog environment={dialog==='new'?undefined:dialog} system={snapshot.system} onClose={()=>setDialog(null)} onSave={async id=>{setDialog(null);showSystem(false);select(id);await pending.current;await refresh();}}/>}
 </div>;
}

type EnvironmentDraft=Omit<Environment,'id'|'instanceName'|'state'|'browserRunning'|'lastError'|'createdAt'|'updatedAt'>;
function WindowsEnvironmentDialog({environment,system,onClose,onSave}:{environment?:Environment;system:Snapshot['system'];onClose:()=>void;onSave:(id:string)=>Promise<void>}){
 const [draft,setDraft]=useState<EnvironmentDraft>(()=>environment?editConfig(environment):{name:'',description:'',kind:'vm',color:'green',cpus:Math.min(2,system.cpus),memoryGiB:2,diskGiB:24,mounts:[],ports:[],identity:{timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:'en-US'},network:{mode:'http',host:'127.0.0.1',port:7890,username:'',strict:true,transparent:true,noProxy:'localhost,127.0.0.1',egressLock:{expectedIp:''}},browserUrl:'https://example.org'});
 const [password,setPassword]=useState(''),[passwordChanged,setPasswordChanged]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const resourcesLocked=!!environment&&environment.state!=='not_created';
 function network(patch:Partial<typeof draft.network>){setDraft(d=>({...d,network:{...d.network,...patch}}));}
 async function save(event:React.SubmitEvent<HTMLFormElement>){
  event.preventDefault();setBusy(true);setError('');
  try{const body={...draft,network:{...draft.network,...(passwordChanged?{password}:{}),tls:draft.network.mode==='https'?draft.network.tls:undefined}};const e=environment?await api.update(environment.id,body):await api.create(body);await onSave(e.id);}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <Modal title={environment?'编辑环境':'新建 Windows Linux 环境'} subtitle="所有业务流量使用受控代理；出口须经核验。" onClose={()=>{if(!busy)onClose();}}>
  <form onSubmit={event=>void save(event)}><div className="modal-body"><div className="form-grid">
   <Field label="环境名称"><input autoFocus required maxLength={60} value={draft.name} onChange={e=>setDraft(d=>({...d,name:e.target.value}))}/></Field>
   <Field label="时区"><input required value={draft.identity.timezone} onChange={e=>setDraft(d=>({...d,identity:{...d.identity,timezone:e.target.value}}))}/></Field>
   <Field label="CPU 核心"><input type="number" min={1} max={Math.min(16,system.cpus)} disabled={resourcesLocked} value={draft.cpus} onChange={e=>setDraft(d=>({...d,cpus:Number(e.target.value)}))}/></Field>
   <Field label="内存 GiB"><input type="number" min={2} max={Math.min(32,Math.floor(system.memoryGiB*.8))} disabled={resourcesLocked} value={draft.memoryGiB} onChange={e=>setDraft(d=>({...d,memoryGiB:Number(e.target.value)}))}/></Field>
   <Field label="磁盘 GiB"><input type="number" min={16} max={256} disabled={resourcesLocked} value={draft.diskGiB} onChange={e=>setDraft(d=>({...d,diskGiB:Number(e.target.value)}))}/></Field>
   <Field label="代理类型"><select value={draft.network.mode} onChange={e=>network({mode:e.target.value as 'http'|'https'|'socks5'})}><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option></select></Field>
   <Field label="代理地址"><input required value={draft.network.host} onChange={e=>network({host:e.target.value})}/></Field>
   <Field label="代理端口"><input type="number" required min={1} max={65535} value={draft.network.port} onChange={e=>network({port:Number(e.target.value)})}/></Field>
   <Field label="用户名"><input autoComplete="off" value={draft.network.username} onChange={e=>network({username:e.target.value})}/></Field>
   <Field label="密码" hint={environment?.network.passwordConfigured?'未修改时保留已保存密码；清空输入可移除。':undefined}><input type="password" autoComplete="new-password" value={password} onChange={e=>{setPassword(e.target.value);setPasswordChanged(true);}}/></Field>
   {draft.network.mode==='https'&&<Field label="证书服务器名称"><input required value={draft.network.tls?.serverName??''} onChange={e=>network({tls:{serverName:e.target.value}})}/></Field>}
   <Field label="明确批准的出口 IPv4" hint="填写你认可的代理出口；不一致时无法启动。"><input required placeholder="例如 203.0.113.10" value={draft.network.egressLock?.expectedIp??''} onChange={e=>network({egressLock:{expectedIp:e.target.value}})}/></Field>
  </div>{error&&<Notice kind="error">{error}</Notice>}</div><footer className="modal-footer"><Button disabled={busy} onClick={onClose}>取消</Button><Button type="submit" className="primary" loading={busy}>保存配置</Button></footer></form>
 </Modal>;
}
