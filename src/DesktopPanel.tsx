import {lazy,Suspense,useEffect,useState} from 'react';
import {Download,Monitor,Play,Square,LoaderCircle,RefreshCw,AlertCircle,Info,ArrowRight} from 'lucide-react';
import type {Environment,Snapshot} from '../shared/types.ts';
import {DESKTOP_APPS,type DesktopAppId,type DesktopAppsStatus} from '../shared/guest-desktop.ts';
import {api,ApiError} from './api.ts';
import {Button,Notice,SectionHeading} from './components.tsx';
const GuestBrowserView=lazy(()=>import('./GuestBrowserView.tsx'));

export default function DesktopPanel({environment, snapshot,refresh,onConfigure,visible=true,preferredApplication}:{environment:Environment;snapshot:Snapshot;refresh:()=>Promise<void>;onConfigure:()=>void;visible?:boolean;preferredApplication?:DesktopAppId}) {
  const [inspection,setInspection]=useState<{environmentId:string;environmentState:Environment['state'];value:DesktopAppsStatus|null;error:string}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [preferred,setPreferred]=useState<DesktopAppId|null>(null);
  useEffect(()=>{const handler=(event:Event)=>{const value=(event as CustomEvent).detail;if(value.id===environment.id&&['grok-bot','claude-desktop'].includes(value.application))setPreferred(value.application);};window.addEventListener('mu-desktop-focus',handler);return()=>window.removeEventListener('mu-desktop-focus',handler);},[environment.id]);
  useEffect(()=>{if(preferredApplication)setPreferred(preferredApplication);},[preferredApplication]);
  const active=snapshot.jobs.find(j=>j.environmentId===environment.id&&j.status==='running');
  const usable=environment.state==='running'&&environment.network.strict&&environment.network.transparent;
  const networkConfigured=environment.network.strict&&environment.network.transparent;
  const stoppedIssue=environment.state==='error'?environment.lastError:null;
  const current=inspection?.environmentId===environment.id&&inspection.environmentState===environment.state?inspection:null;
  const data=current?.value,inspectionError=current?.error;
  useEffect(()=>{
    // Retained tabs keep client state, but only the visible tab needs UI inspection.
    // Server-side protection monitoring runs independently of this request.
    if(!visible)return;
    let live=true,pending=false;
    const update=async()=>{
      if(pending||active)return;
      pending=true;
      try{
        const value=await api.desktopApps(environment.id);
        if(live)setInspection({environmentId:environment.id,environmentState:environment.state,value,error:''});
      }catch(e){
        if(e instanceof ApiError&&e.code==='OPERATION_IN_PROGRESS')return;
        if(live)setInspection({environmentId:environment.id,environmentState:environment.state,value:null,error:(e as Error).message});
      }finally{pending=false;}
    };
    setError('');
    void update();
    const timer=setInterval(()=>void update(),5000);
    return()=>{live=false;clearInterval(timer);};
  },[environment.id,environment.state,active?.id,visible]);
  async function inspect(){try{const value=await api.desktopApps(environment.id);setInspection({environmentId:environment.id,environmentState:environment.state,value,error:''});}catch(e){setInspection({environmentId:environment.id,environmentState:environment.state,value:null,error:(e as Error).message});}}
  async function action(application:DesktopAppId,value:'install'|'start'|'stop') {if(value==='start')setPreferred(application);setBusy(true);setError('');try{await api.desktopAppAction(environment.id,application,value);await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const running=environment.state==='running'?data?.apps.find(a=>a.id===preferred&&a.running)??data?.apps.find(a=>a.running):undefined;
  const focusTarget=preferred?data?.apps.find(a=>a.id===preferred&&a.running)?.id:running?.id;
  useEffect(()=>{if(visible&&environment.state==='running'&&focusTarget&&!active&&!busy)void api.focusGuest(environment.id,focusTarget).catch(()=>{});},[visible,focusTarget,environment.id,environment.state,active?.id,busy]);
  return <div className="desktop-panel">
    <SectionHeading title="沙箱桌面应用" subtitle="在当前 Linux 沙箱内运行 · 共用线路、语言和时区 · 可先不登录账号" action={<Button icon={<RefreshCw size={16}/>} disabled={!!active||busy} onClick={()=>void inspect()}>刷新状态</Button>}/>
    {!usable&&<div className={`desktop-state-summary ${stoppedIssue?'has-issue':''}`} role="status">
      {stoppedIssue?<AlertCircle size={19}/>:<Info size={19}/>}
      <div><strong>{stoppedIssue?'环境暂时停止':!networkConfigured?'请先配置受保护网络':'启动环境后可使用客户端'}</strong><p>{stoppedIssue?stoppedIssue.replace(/^环境已停止：/,''):!networkConfigured?'在网络页启用“仅代理联网”和“透明代理”。':'点击右上角“启动”，完成核验后自动检测安装状态。停止环境不会清除资料。'}</p></div>
      {(stoppedIssue||!networkConfigured)&&<Button icon={<ArrowRight size={14}/>} onClick={onConfigure}>查看网络</Button>}
    </div>}
    {error&&<Notice kind="error">{error}</Notice>}
    {inspectionError&&<Notice kind="error">安装状态检测失败：{inspectionError}。请刷新重试，不需要因此重新安装。</Notice>}
    {active?.action.startsWith('desktop-')&&<Notice><LoaderCircle size={16} className="spin"/>正在{active.action==='desktop-install'?'安装官方客户端':active.action==='desktop-start'?'打开并核验客户端':'关闭客户端'}，可在日志页查看进度。</Notice>}
    <div className="desktop-app-grid">{DESKTOP_APPS.map(app=>{const state=environment.state==='running'&&!inspectionError?data?.apps.find(a=>a.id===app.id):undefined;const unknownLabel=environment.kind!=='vm'?'此环境不支持':environment.state!=='running'?'启动后检测':inspectionError?'检测失败':'正在检测';return <section className="desktop-app-card" key={app.id}>
      <div className="desktop-app-name"><Monitor size={25}/><div><h3>{app.name}</h3><span>{state?.installed?`已安装 ${state.installedVersion}`:state?`官方 ARM64 · ${app.version} · 下载约 ${app.downloadMB} MB`:environment.state!=='running'?'环境启动后自动检测安装状态':'尚未确认安装状态，请等待检测或刷新重试'}</span></div><span className={`status ${state?.running?'running':''}`}>{state?.running?'运行中':state?.installed?'已关闭':state?'未安装':unknownLabel}</span></div>
      <p>{app.note}</p><a href={app.source} target="_blank" rel="noreferrer">官方说明</a>
      <div className="button-row">{!state?<Button disabled icon={<Monitor size={16}/>}>安装状态待检测</Button>:state.installed?<><Button className="primary" icon={<Play size={16}/>} disabled={!usable||!!active||busy} onClick={()=>void action(app.id,'start')}>{state.running?'显示窗口':'打开客户端'}</Button><Button icon={<Square size={16}/>} disabled={!state.running||!!active||busy} onClick={()=>void action(app.id,'stop')}>关闭</Button></>:<Button className="primary" icon={<Download size={16}/>} disabled={!usable||!!active||busy} onClick={()=>void action(app.id,'install')}>安装官方客户端</Button>}</div>
      {state?.running&&<small className="desktop-protection-result">{state.rendererProtected?'渲染进程保护已检查':'正在检查渲染进程'} · 本轮未验证账号登录</small>}
    </section>;})}</div>
    {running&&<section className="desktop-display"><SectionHeading title={`${DESKTOP_APPS.find(a=>a.id===running.id)?.name} · Linux 沙箱桌面`}/><Suspense fallback={<LoaderCircle className="spin" size={28}/>}><GuestBrowserView id={environment.id} name={`${environment.name} · 桌面应用`} embedded desktop active={visible}/></Suspense></section>}
    <details className="desktop-notes"><summary>资料保存、清理与运行说明</summary><p>正常关闭、重开或切换查看环境会保存资料。需要清除所有客户端缓存、凭据和本地文件，请到“设置”使用“彻底重建环境”；它会删除旧虚拟机和其快照，创建全新环境。</p><p>桌面客户端直接使用独立显示服务，不会自动打开 Chrome。关闭浏览器不影响客户端；停止环境会关闭全部程序。各客户端拥有独立资料目录，但同一环境内的程序属于同一 Linux 用户，不能作为程序之间的强隔离。</p></details>
  </div>;
}
