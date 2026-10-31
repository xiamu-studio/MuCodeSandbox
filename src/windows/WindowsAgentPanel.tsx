import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {Bot,Download,RefreshCw,TerminalSquare} from 'lucide-react';
import type {Environment,Job} from '../../shared/types.ts';
import {WINDOWS_AGENT_VERSION,type WindowsAgentStatus} from '../../shared/windows-agent.ts';
import {api,request} from '../api.ts';
import {Button,Modal,Notice,SectionHeading} from '../components.tsx';
const TerminalPanel=lazy(()=>import('../TerminalPanel.tsx'));
const labels={stopped:'环境已停止',unavailable:'环境尚未就绪',verified:'已安装',missing:'尚未安装',pending:'安装待继续',untrusted:'需要核对',busy:'正在安装'};
function valid(value:WindowsAgentStatus){if(value?.version!==1||value.availableVersion!==WINDOWS_AGENT_VERSION||value.architecture!=='x86_64'||value.runtime!=='native'||typeof value.supported!=='boolean'||typeof value.enabled!=='boolean'||!Object.hasOwn(labels,value.state)||typeof value.message!=='string'||value.message.length>500||value.installedVersion!==(value.state==='verified'?WINDOWS_AGENT_VERSION:null))throw Error('组件状态回执无法核对，请刷新后重试');return value;}

export default function WindowsAgentPanel({environment,jobs,disabled,visible=true,onShell,onChange}:{environment:Environment;jobs:Job[];disabled:boolean;visible?:boolean;onShell:()=>void;onChange:()=>Promise<void>}){
 const [data,setData]=useState<WindowsAgentStatus|null>(null),[error,setError]=useState(''),[reading,setReading]=useState(false),[dialog,setDialog]=useState(false),[confirmation,setConfirmation]=useState(''),[sending,setSending]=useState(false),[terminal,setTerminal]=useState(false),[composing,setComposing]=useState(false);
 const generation=useRef(0),singleFlight=useRef(false),ime=useRef(false),live=useRef(true);const active=jobs.find(j=>j.environmentId===environment.id&&j.status==='running'),installing=active?.action==='install-agent',running=environment.state==='running';
 useEffect(()=>{live.current=true;return()=>{live.current=false;generation.current++;};},[]);
 async function inspect(background=false){const epoch=++generation.current;if(!background)setReading(true);try{const value=valid(await request<WindowsAgentStatus>(`/environments/${environment.id}/agent`));if(live.current&&epoch===generation.current){setData(value);setError('');}}catch(e){if(live.current&&epoch===generation.current)setError((e as Error).message);}finally{if(live.current&&epoch===generation.current)setReading(false);}}
 useEffect(()=>{generation.current++;setData(null);setError('');setDialog(false);setConfirmation('');setTerminal(false);},[environment.id,environment.state,environment.name]);
 useEffect(()=>{if(!visible||!running||disabled)return;let pending=false,first=true;const update=async()=>{if(pending)return;pending=true;try{await inspect(!first);}finally{first=false;pending=false;}};void update();const timer=setInterval(()=>void update(),15000);return()=>{generation.current++;clearInterval(timer);};},[visible,running,disabled,environment.id,active?.id]);
 const inactive={not_created:{title:"环境尚未创建",badge:"创建后检测",message:"创建并启动环境后，可检测组件安装状态。"},creating:{title:"环境创建中",badge:"等待创建",message:"请等待环境创建和启动完成，再检测组件。"},starting:{title:"环境启动中",badge:"等待核验",message:"请等待启动与网络防护核验完成，再检测组件。"},stopping:{title:"环境正在停止",badge:"等待停机确认",message:"正在等待停止结果，本次未检测组件。"},stopped:{title:"环境已停止",badge:"启动后检测",message:"启动环境并通过网络防护核验后，可检测安装状态。"},deleting:{title:"环境正在删除",badge:"暂不可检测",message:"删除期间不检测或启动组件。"},error:{title:"环境状态需要处理",badge:"状态待核对",message:"请先查看日志并处理环境状态，本次未检测组件。"}};
 const inactiveView=environment.state==="running"?null:inactive[environment.state];
 const usable=running&&!disabled&&!active&&!reading&&!error&&!!data?.enabled;
 async function install(){if(ime.current||singleFlight.current||!usable||confirmation!==environment.name)return;singleFlight.current=true;setSending(true);setError('');try{await request(`/environments/${environment.id}/agent/install`,{method:'POST',body:JSON.stringify({confirm:'install-approved-agent',environmentName:confirmation})});if(live.current){setDialog(false);setConfirmation('');await onChange();}}catch(e){if(live.current)setError((e as Error).message);}finally{singleFlight.current=false;if(live.current)setSending(false);}}
 return <div className="panel-width">
  <SectionHeading title="Claude Code" action={<Button icon={<RefreshCw size={15}/>} disabled={!running||disabled||!!active||reading} onClick={()=>void inspect()}>刷新状态</Button>}/>
  <div className="agent-heading"><div className="agent-icon"><Bot size={28}/></div><div><h3>Claude Code</h3><p>{!running?inactiveView!.title:data?.state==='verified'?data.installedVersion:reading?'正在核验安装状态':data?labels[data.state]+' · 批准版本 '+data.availableVersion:'尚未检测'}</p></div><span className={`permission ${running&&data?.state==='verified'&&!error?'':'neutral'}`}>{!running?inactiveView!.badge:error?'检测失败':installing?'正在安装':data?labels[data.state]:'待检测'}</span></div>
  <dl className="facts"><div><dt>执行位置</dt><dd>Linux 沙箱 · dev 用户</dd></div><div><dt>运行方式</dt><dd>Linux x64 原生程序 · 无需 Node.js</dd></div><div><dt>本机访问</dt><dd>仅手动传入的文件；持续共享尚未提供</dd></div><div><dt>登录状态</dt><dd>由你在专用终端内管理</dd></div></dl>
  {inactiveView&&<Notice>{inactiveView.message}</Notice>}
  {data&&!data.enabled&&<Notice>专用安装和终端入口等待 Windows Linux 实机验收，暂未开放。</Notice>}
  {error&&!dialog&&<Notice kind="error">{error}。检测失败不表示需要重新安装。</Notice>}
  {installing?<Notice>正在安装并核验固定版本，可继续使用现有终端和浏览器；停止环境会取消安装。<Button disabled={sending} onClick={()=>{if(singleFlight.current)return;singleFlight.current=true;setSending(true);void api.cancel(active!.id).then(()=>onChange()).catch(e=>{if(live.current)setError((e as Error).message);}).finally(()=>{singleFlight.current=false;if(live.current)setSending(false);});}}>取消安装</Button></Notice>:data&&running&&data.state!=='verified'&&<Notice>{data.message}</Notice>}
  <div className="button-row">
   <Button icon={<Download size={16}/>} disabled={!usable||!data||!['missing','pending'].includes(data.state)} onClick={()=>{setConfirmation('');setDialog(true);}}>{data?.state==='verified'?'组件已安装':data?.state==='pending'?'继续安装':'安装 Claude Code'}</Button>
   <Button className="primary" icon={<Bot size={16}/>} disabled={!usable||data?.state!=='verified'} onClick={()=>setTerminal(true)}>打开 Claude</Button>
   <Button icon={<TerminalSquare size={16}/>} disabled={!running||disabled} onClick={onShell}>打开终端</Button>
  </div>
  {dialog&&<Modal title="安装 Claude Code" narrow onClose={()=>{if(!sending&&!ime.current){setDialog(false);setConfirmation('');}}}><p>在「{environment.name}」安装 Claude Code {WINDOWS_AGENT_VERSION}。下载约 126 MiB，客体组件约 278 MiB；项目和账号资料保留。安装完成后由你打开专用终端并自行登录。</p>{error&&<Notice kind="error">{error}。请关闭后刷新安装状态再继续。</Notice>}<form onSubmit={event=>{event.preventDefault();void install();}}><label>输入完整环境名称<input aria-label="安装确认环境名称" autoComplete="off" value={confirmation} maxLength={60} onChange={e=>setConfirmation(e.target.value)} onCompositionStart={()=>{ime.current=true;setComposing(true);}} onCompositionEnd={e=>{ime.current=false;setComposing(false);setConfirmation(e.currentTarget.value);}} onKeyDown={e=>{if(e.key==='Enter'&&(ime.current||e.nativeEvent.isComposing||e.keyCode===229))e.preventDefault();}}/></label><div className="button-row"><Button type="button" disabled={sending} onClick={()=>{setDialog(false);setConfirmation('');}}>取消</Button><Button type="submit" className="primary" disabled={!usable||sending||composing||confirmation!==environment.name}>安装并核验</Button></div></form></Modal>}
  {terminal&&running&&<Suspense fallback={<p>加载专用终端…</p>}><TerminalPanel environment={environment} command="claude" active={visible&&!disabled} quickTools="text"/></Suspense>}
 </div>;
}
