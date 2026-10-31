import {useEffect,useRef,useState} from 'react';
import type {Environment,Job} from '../../shared/types.ts';
import {ApiError,request} from '../api.ts';
import {Button,Modal,Notice} from '../components.tsx';

type Props={environment:Environment;enabled?:boolean;disabled?:boolean;jobs?:Job[];onChange?:()=>Promise<void>};
export default function WindowsBrowserRepairPanel(props:Props){return <RepairPanel key={props.environment.id} {...props}/>;}
function RepairPanel({environment,enabled=false,disabled=false,jobs=[],onChange}:Props){
 const [target,setTarget]=useState<{id:string;name:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[outcome,setOutcome]=useState<'accepted'|'unknown'|null>(null),[jobId,setJobId]=useState<string|null>(null);
 const live=useRef(false),pending=useRef(false),reading=useRef(false),submitted=useRef(false),composing=useRef(false),latest=useRef(environment);latest.current=environment;
 const job=jobs.find(value=>value.id===jobId&&value.environmentId===environment.id&&value.action==='browser-component-repair'),terminal=!!job&&job.status!=='running';
 const available=enabled&&!disabled&&environment.state==='running'&&(!submitted.current||terminal);
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 const close=()=>{if(!pending.current&&!reading.current&&!composing.current)setTarget(null);};
 async function refresh(){if(reading.current||!live.current)return;reading.current=true;setBusy(true);setError('');try{await onChange?.();}catch(value){if(live.current)setError((value as Error).message);}finally{reading.current=false;if(live.current)setBusy(false);}}
 async function submit(event:React.SubmitEvent<HTMLFormElement>){
  event.preventDefault();if(!live.current||!available||pending.current||submitted.current&&!terminal||composing.current||!target||environment.id!==target.id||environment.name!==target.name)return;
  const id=target.id;pending.current=true;submitted.current=true;setBusy(true);setError('');setOutcome(null);setJobId(null);
  try{const accepted=await request<Job>(`/environments/${id}/browser/component-repair`,{method:'POST',body:JSON.stringify({confirm:'repair-approved-browser-component',environmentName:target.name})});if(!live.current||latest.current.id!==id)return;if(!accepted.id||accepted.environmentId!==id||accepted.action!=='browser-component-repair')throw Error('恢复回执无法对应当前环境，请核对操作记录');setJobId(accepted.id);setOutcome('accepted');setTarget(null);await refresh();}
  catch(value){if(!live.current||latest.current.id!==id)return;if(value instanceof ApiError&&value.status>=400&&value.status<500){submitted.current=false;setOutcome(null);}else setOutcome('unknown');setError((value as Error).message);}
  finally{pending.current=false;if(live.current)setBusy(false);}
 }
 const message=job?.status==='succeeded'?'浏览器组件已恢复并核验，资料与项目保留；请手动重新打开浏览器。':job&&job.status!=='running'?`组件恢复${job.status==='cancelled'?'已取消':'尚未完成'}：${job.message}。请核对操作记录；未完成的组件事务将在下次打开浏览器前继续处理。`:outcome==='accepted'?'组件恢复任务已提交，等待操作记录确认完成；浏览器保持关闭。':outcome==='unknown'?'未能确认组件恢复请求的结果，请先刷新并核对操作记录，勿重复提交。':'';
 return <section aria-label="Windows 浏览器组件恢复"><div className="profile-reset-card"><div><h3>恢复已批准的浏览器组件</h3><p>修复缺失或损坏的 Linux AMD64 Chrome。保留浏览器资料、项目文件与线路。</p></div><Button disabled={!available||busy} onClick={()=>{if(!available||pending.current)return;submitted.current=false;setTarget({id:environment.id,name:environment.name});setError('');setOutcome(null);setJobId(null);}}>恢复浏览器组件</Button></div>
  {!enabled&&<Notice>浏览器组件恢复尚未完成 Windows 实机验收，暂未开放。</Notice>}
  {message&&!target&&<Notice kind={job?.status==='succeeded'?'success':'info'}>{message}</Notice>}{error&&!target&&<Notice kind="error">{error}</Notice>}
  {outcome&&<div className="button-row"><Button disabled={busy} onClick={()=>void refresh()}>刷新恢复结果</Button></div>}
  {target&&<Modal title="恢复浏览器组件？" subtitle={target.name} narrow onClose={close}><form onSubmit={event=>void submit(event)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event=>{if(event.key==='Enter'&&(composing.current||event.nativeEvent.isComposing||event.keyCode===229))event.preventDefault();}}><div className="modal-body"><p>将关闭当前浏览器，校验并替换为本应用批准的 Linux AMD64 Chrome 组件。旧组件保留供核对，会占用额外磁盘空间。</p><Notice>保留浏览器登录、Cookie、缓存、历史、密码和扩展，以及虚拟机、项目文件、线路与地区设置。</Notice><p>恢复完成后请手动重新打开浏览器。</p>{(!available||environment.name!==target.name)&&!outcome&&<Notice>环境状态已变化，请关闭并重新核对恢复范围。</Notice>}{outcome==='unknown'&&<Notice>{message}</Notice>}{error&&<Notice kind="error">{error}</Notice>}</div><footer className="modal-footer"><Button disabled={busy} onClick={close}>{outcome?'关闭':'取消'}</Button>{outcome?<Button disabled={busy} onClick={()=>void refresh()}>刷新操作记录</Button>:<Button type="submit" className="primary" disabled={!available||environment.name!==target.name} loading={busy}>确认恢复浏览器组件</Button>}</footer></form></Modal>}
 </section>;
}
