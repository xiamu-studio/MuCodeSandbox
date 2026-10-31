import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {Download,Monitor,Play,RefreshCw,ArrowRight,Square} from 'lucide-react';
import type {Environment,Job} from '../../shared/types.ts';
import {DESKTOP_APPS,type DesktopAppId} from '../../shared/guest-desktop.ts';
import {WINDOWS_DESKTOP_COMPONENT_RELEASES,type WindowsDesktopComponentsStatus} from '../../shared/windows-desktop-components.ts';
import {api} from '../api.ts';
import {Button,Modal,Notice,SectionHeading} from '../components.tsx';
import {checkedWindowsDesktopComponents} from './desktop-component-state.ts';
import {checkedWindowsDesktopClients} from './desktop-client-state.ts';
import type {WindowsDesktopClientsState} from '../../shared/windows-desktop-clients.ts';
const WindowsBrowserView=lazy(()=>import('./WindowsBrowserView.tsx'));
const clientLabels={idle:'尚未打开',starting:'正在打开',running:'运行中',stopping:'正在关闭',failed:'关闭待确认',unavailable:'暂不可用'};

const labels={stopped:'启动后检测',unavailable:'暂不可检测',verified:'组件已核验',missing:'尚未安装',pending:'准备待继续',untrusted:'需要核对',busy:'正在准备'};
export default function WindowsDesktopComponentsPanel({environment,jobs,disabled,visible=true,onChange,onConfigure}:{environment:Environment;jobs:Job[];disabled:boolean;visible?:boolean;onChange:()=>Promise<void>;onConfigure:()=>void}){
 const [inspection,setInspection]=useState<{id:string;state:Environment['state'];value:WindowsDesktopComponentsStatus}|null>(null),[error,setError]=useState(''),[reading,setReading]=useState(false),[dialog,setDialog]=useState<DesktopAppId|null>(null),[confirmation,setConfirmation]=useState(''),[sending,setSending]=useState(false),[composing,setComposing]=useState(false);
 const live=useRef(true),scope=useRef(0),readingOwner=useRef<{epoch:number}|null>(null),submitting=useRef(false),ime=useRef(false);
 const clientEnabled=window.__MU_CONFIG__.capabilities?.desktopClients===true;
 const [clients,setClients]=useState<{id:string;state:Environment['state'];epoch:number;value:WindowsDesktopClientsState}|null>(null),[clientError,setClientError]=useState(''),[preferred,setPreferred]=useState<DesktopAppId|null>(null);
 const clientRevision=useRef(0),clientReader=useRef<{epoch:number}|null>(null),clientData=clients?.id===environment.id&&clients.state===environment.state?clients.value:null;
 const [focusError,setFocusError]=useState(''),[focusing,setFocusing]=useState(false),[focusAttempt,retryFocus]=useState(0);const focusRevision=useRef(0);
 const active=jobs.find(job=>job.environmentId===environment.id&&job.status==='running'),installing=active?.action==='install-desktop',running=environment.state==='running',network=environment.network.strict&&environment.network.transparent;
 const data=inspection?.id===environment.id&&inspection.state===environment.state?inspection.value:null;
 useEffect(()=>{live.current=true;return()=>{live.current=false;scope.current++;};},[]);
 useEffect(()=>{scope.current++;setInspection(null);setClients(null);setClientError('');setPreferred(null);setError('');setDialog(null);setConfirmation('');ime.current=false;setComposing(false);},[environment.id,environment.state,environment.name]);
 async function inspect(){
  if(!visible||!running||disabled||active)return;
  const epoch=scope.current;if(readingOwner.current?.epoch===epoch)return;const owner={epoch};readingOwner.current=owner;setReading(true);
  const revision=++clientRevision.current;
  try{const [value,status]=await Promise.all([api.windowsDesktopComponents(environment.id).then(checkedWindowsDesktopComponents),clientEnabled?api.windowsDesktopClients(environment.id).then(checkedWindowsDesktopClients):undefined]);if(live.current&&scope.current===epoch){setInspection({id:environment.id,state:environment.state,value});if(status&&revision===clientRevision.current){setClients({id:environment.id,state:environment.state,epoch,value:status});setClientError('');}setError('');}}
  catch(e){if(live.current&&scope.current===epoch)setError((e as Error).message);}
  finally{if(readingOwner.current===owner)readingOwner.current=null;if(live.current&&scope.current===epoch)setReading(false);}
 }
 useEffect(()=>{scope.current++;setReading(false);if(!visible||!running||disabled||active)return;void inspect();const timer=setInterval(()=>void inspect(),15000);return()=>{scope.current++;clearInterval(timer);};},[visible,environment.id,environment.state,environment.name,disabled,active?.id]);
 useEffect(()=>{if(!clientEnabled||!visible||!running||disabled||active)return;const timer=setInterval(()=>{
  const epoch=scope.current;if(clientReader.current?.epoch===epoch)return;const owner={epoch};clientReader.current=owner;const revision=++clientRevision.current;
  void api.windowsDesktopClients(environment.id).then(checkedWindowsDesktopClients).then(value=>{if(live.current&&scope.current===epoch&&revision===clientRevision.current){setClients({id:environment.id,state:environment.state,epoch,value});setClientError('');}}).catch(e=>{if(live.current&&scope.current===epoch&&revision===clientRevision.current)setClientError((e as Error).message);}).finally(()=>{if(clientReader.current===owner)clientReader.current=null;});
 },5000);return()=>clearInterval(timer);},[clientEnabled,visible,running,disabled,active?.id,environment.id,environment.state,environment.name]);
 const usable=visible&&running&&network&&!disabled&&!active&&!reading&&!error&&!clientError&&!!data?.enabled;
 function close(){if(!submitting.current&&!ime.current){setDialog(null);setConfirmation('');}}
 async function install(){
  const application=dialog,state=data?.apps.find(app=>app.id===application)?.state;
  if(!application||!usable||!state||!['missing','pending'].includes(state)||confirmation!==environment.name||ime.current||submitting.current)return;
  submitting.current=true;setSending(true);const epoch=scope.current;setError('');
  try{await api.installWindowsDesktopComponent(environment.id,application,confirmation);if(live.current&&scope.current===epoch){setDialog(null);setConfirmation('');}await onChange();}
  catch(e){if(live.current&&scope.current===epoch)setError((e as Error).message);}
  finally{submitting.current=false;if(live.current)setSending(false);}
 }
 async function cancel(){if(!installing||!active||submitting.current)return;submitting.current=true;setSending(true);const epoch=scope.current;try{await api.cancel(active.id);await onChange();}catch(e){if(live.current&&scope.current===epoch)setError((e as Error).message);}finally{submitting.current=false;if(live.current)setSending(false);}}
 async function clientAction(application:DesktopAppId,action:'start'|'stop',viewId?:string){if(submitting.current||!clientEnabled||!clientData?.enabled||!visible||!running||disabled||active)return;if(action==='start'&&!usable)return;submitting.current=true;setSending(true);const epoch=scope.current;setError('');try{if(action==='start'){setPreferred(application);await api.startWindowsDesktopClient(environment.id,application,environment.name);}else{if(!viewId)return;await api.stopWindowsDesktopClient(environment.id,application,viewId);}await onChange();}catch(e){if(live.current&&scope.current===epoch)setError((e as Error).message);}finally{submitting.current=false;if(live.current)setSending(false);}}
 async function cancelClient(){if(!active||active.action!=='desktop-start'||submitting.current)return;submitting.current=true;setSending(true);const epoch=scope.current;try{await api.cancel(active.id);await onChange();}catch(e){if(live.current&&scope.current===epoch)setError((e as Error).message);}finally{submitting.current=false;if(live.current)setSending(false);}}
 const opened=running?clientData?.apps.filter(app=>app.state==='running'&&app.viewId):undefined,view=opened?.find(app=>app.id===preferred)??opened?.[0];
 useEffect(()=>{
  const revision=++focusRevision.current,controller=new AbortController(),epoch=scope.current;setFocusError('');setFocusing(false);
  if(!clientEnabled||!clientData?.enabled||clients?.epoch!==scope.current||!visible||!running||disabled||active||!view?.viewId)return;
  setFocusing(true);void api.focusWindowsDesktopClient(environment.id,view.id,view.viewId,controller.signal).then(value=>{
   if(live.current&&scope.current===epoch&&focusRevision.current===revision&&!controller.signal.aborted){if(!value||Object.keys(value).length!==1||typeof value.focused!=='boolean')throw Error('客户端窗口状态无法核对');if(!value.focused)throw Error('尚未找到可显示的客户端窗口，请稍后重试');}
  }).catch(e=>{if(live.current&&scope.current===epoch&&focusRevision.current===revision&&!controller.signal.aborted)setFocusError((e as Error).message);}).finally(()=>{if(live.current&&focusRevision.current===revision&&!controller.signal.aborted)setFocusing(false);});
  return()=>controller.abort();
 },[clientEnabled,clientData?.enabled,clients?.epoch,visible,running,disabled,active?.id,environment.id,environment.state,environment.name,view?.id,view?.viewId,focusAttempt]);
 const selected=WINDOWS_DESKTOP_COMPONENT_RELEASES.find(app=>app.id===dialog);
 return <div className="desktop-panel">
  <SectionHeading title="沙箱桌面应用" subtitle="在当前 Linux 沙箱内运行 · 共用线路、语言和时区" action={<Button icon={<RefreshCw size={16}/>} disabled={!visible||!running||disabled||!!active||reading} onClick={()=>void inspect()}>刷新状态</Button>}/>
  {(!running||!network)&&<div className="desktop-state-summary" role="status"><Monitor size={19}/><div><strong>{!network?'请先配置受保护网络':environment.state==='stopped'?'启动环境后可检测组件':'环境尚未就绪'}</strong><p>{!network?'在网络页启用“仅代理联网”和“透明代理”。':'请先启动环境并完成网络防护核验，本次未检测组件。'}</p></div>{!network&&<Button icon={<ArrowRight size={14}/>} onClick={onConfigure}>查看网络</Button>}</div>}
  <Notice>{clientEnabled?'客户端在同一 Linux 沙箱的共享桌面内运行，共用线路和显示；准备组件不会自动打开客户端或登录账号。':'Windows 桌面客户端仍在验收。本页可准备固定版本组件；打开客户端和运行画面尚未开放，安装完成不会自动打开应用或登录账号。'}</Notice>
  {data&&!data.enabled&&<Notice>组件准备入口尚未开放，请等待 Windows 实机验收。</Notice>}
  {error&&!dialog&&<Notice kind="error">{error}。检测失败不表示需要重新安装。</Notice>}
  {clientError&&<Notice kind="error">{clientError}。请刷新状态；已有画面仍由后台保护监测。</Notice>}
  {focusing&&<Notice>正在显示所选客户端窗口…</Notice>}
  {focusError&&<Notice kind="error">{focusError}。共享桌面仍可查看。<Button onClick={()=>retryFocus(value=>value+1)}>重试显示窗口</Button></Notice>}
  {installing&&<Notice>正在准备并核验桌面组件，可继续使用现有浏览器和终端；停止环境会取消准备。<Button disabled={sending} onClick={()=>void cancel()}>取消准备</Button></Notice>}
  {active&&['desktop-start','desktop-stop'].includes(active.action)&&<Notice>{active.action==='desktop-start'?'正在打开并核验客户端渲染保护':'正在关闭客户端并核对进程退出'}{active.action==='desktop-start'&&<Button disabled={sending} onClick={()=>void cancelClient()}>取消打开</Button>}</Notice>}
  <div className="desktop-app-grid">{WINDOWS_DESKTOP_COMPONENT_RELEASES.map(app=>{const state=running&&!error?data?.apps.find(value=>value.id===app.id):undefined,client=clientData?.apps.find(value=>value.id===app.id);return <section className="desktop-app-card" key={app.id} aria-label={app.name+' 桌面组件'}>
   <div className="desktop-app-name"><Monitor size={25}/><div><h3>{app.name}</h3><span>{state?.state==='verified'?'已核验 '+state.installedVersion:`Linux AMD64 · ${app.version} · 下载约 ${(app.downloadBytes/1048576).toFixed(1)} MiB`}</span></div><span className="status">{state?labels[state.state]:!running?'启动后检测':error?'检测失败':reading?'正在检测':'待检测'}</span></div>
   <p>{app.id==='grok-bot'?'仅保护本地客户端；Bot 云电脑出口不由本项目控制。':'Linux 桌面客户端，账号由你自行管理。'}</p>
   {state&&<p>{state.message}</p>}
   {clientEnabled&&<p role="status">客户端：{client?clientLabels[client.state]:'状态待检测'}{client?.state==='running'?' · 渲染保护已核验':''}</p>}
   <a href={DESKTOP_APPS.find(value=>value.id===app.id)!.source} target="_blank" rel="noreferrer">官方说明</a>
   <div className="button-row">{state?.state!=='verified'&&<Button className="primary" icon={<Download size={16}/>} disabled={!usable||sending||!state||!['missing','pending'].includes(state.state)} onClick={()=>{setConfirmation('');setDialog(app.id);}}>{state?.state==='pending'?'继续准备组件':'准备固定版本组件'}</Button>}{clientEnabled?<><Button className="primary" icon={client?.state==='running'?<Monitor size={16}/>:<Play size={16}/>} disabled={!clientData?.enabled||sending||disabled||!!active||!running||(client?.state==='running'?false:!usable||state?.state!=='verified'||client?.state!=='idle')} onClick={()=>{if(client?.state==='running'){setPreferred(app.id);retryFocus(value=>value+1);}else void clientAction(app.id,'start');}}>{client?.state==='running'?'显示窗口':'打开客户端'}</Button><Button icon={<Square size={16}/>} disabled={!clientData?.enabled||sending||disabled||!!active||!running||!client?.viewId||!['running','failed'].includes(client.state)} onClick={()=>void clientAction(app.id,'stop',client?.viewId??undefined)}>关闭客户端</Button></>:<Button className="primary" icon={<Play size={16}/>} disabled title="客户端启动与关闭尚未完成 Windows 实机验收">打开客户端（待验收）</Button>}</div>
  </section>;})}</div>
  {clientEnabled&&clientData?.enabled&&visible&&view?.viewId&&<section className="desktop-display"><p>同一环境中的客户端共用画面；关闭浏览器不会关闭客户端。</p><Suspense fallback={<p>加载桌面画面…</p>}><WindowsBrowserView key={environment.id+':'+view.viewId} environment={environment} title="共享 Linux 桌面" showNavigation={false} desktopClient={{application:view.id,viewId:view.viewId}}/></Suspense></section>}
  <details className="desktop-notes"><summary>资料保存与准备说明</summary><p>组件安装在 Linux 沙箱中。取消后已完成且可核验的暂存会保留，刷新后可继续相同版本；无法核验的原文件不会被自动覆盖。准备组件不会修改已有客户端资料或浏览器配置。</p><p>正常关闭、重开或切换查看环境会保留客户端资料。客户端使用共享显示，关闭浏览器不会关闭客户端；停止环境会关闭全部程序。</p><p>各客户端有各自的资料目录，但同一环境内的程序使用同一 Linux 用户，不能作为程序之间的强隔离。</p></details>
  {selected&&<Modal title={'准备 '+selected.name+' 组件'} narrow onClose={close}><p>在「{environment.name}」准备 Linux AMD64 {selected.version}，下载约 {(selected.downloadBytes/1048576).toFixed(1)} MiB。此操作只准备并核验固定版本组件，不会打开客户端。</p>{error&&<Notice kind="error">{error}。请关闭后刷新状态再继续。</Notice>}<form onSubmit={event=>{event.preventDefault();void install();}}><label>输入完整环境名称<input aria-label="组件准备确认环境名称" autoComplete="off" maxLength={60} value={confirmation} onChange={event=>setConfirmation(event.target.value)} onCompositionStart={()=>{ime.current=true;setComposing(true);}} onCompositionEnd={event=>{ime.current=false;setComposing(false);setConfirmation(event.currentTarget.value);}} onKeyDown={event=>{if(event.key==='Enter'&&(ime.current||event.nativeEvent.isComposing||event.keyCode===229))event.preventDefault();}}/></label><div className="button-row"><Button disabled={sending} onClick={close}>取消</Button><Button type="submit" className="primary" loading={sending} disabled={!usable||sending||composing||confirmation!==environment.name}>准备并核验</Button></div></form></Modal>}
 </div>;
}
