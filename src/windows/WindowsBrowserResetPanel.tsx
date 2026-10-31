import {useEffect,useRef,useState} from 'react';
import type {Environment,Job} from '../../shared/types.ts';
import {ApiError,request} from '../api.ts';
import {Button,Modal,Notice} from '../components.tsx';
import {CleanupScope} from '../CleanupScope.tsx';

export default function WindowsBrowserResetPanel(props:{environment:Environment;enabled?:boolean;disabled?:boolean;jobs?:Job[];onChange?:()=>Promise<void>}){
 return <ResetPanel key={props.environment.id} {...props}/>;
}
function ResetPanel({environment,enabled=false,disabled=false,jobs=[],onChange}:{environment:Environment;enabled?:boolean;disabled?:boolean;jobs?:Job[];onChange?:()=>Promise<void>}){
 const [target,setTarget]=useState<{id:string;name:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[outcome,setOutcome]=useState<'accepted'|'unknown'|null>(null),[jobId,setJobId]=useState<string|null>(null);
 const live=useRef(false),pending=useRef(false),reading=useRef(false),submitted=useRef(false),composing=useRef(false),latest=useRef(environment);latest.current=environment;
 const job=jobs.find(value=>value.id===jobId&&value.environmentId===environment.id&&value.action==='browser-reset'),terminal=!!job&&job.status!=='running';
 const available=enabled&&!disabled&&environment.state==='running'&&(!submitted.current||terminal);
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 const close=()=>{if(!pending.current&&!reading.current&&!composing.current)setTarget(null);};
 async function refresh(){if(reading.current||!live.current)return;reading.current=true;setBusy(true);setError('');try{await onChange?.();}catch(value){if(live.current)setError((value as Error).message);}finally{reading.current=false;if(live.current)setBusy(false);}}
 async function submit(event:React.SubmitEvent<HTMLFormElement>){
  event.preventDefault();if(!live.current||!available||pending.current||submitted.current&&!terminal||composing.current||!target||environment.id!==target.id||environment.name!==target.name)return;
  const id=target.id;pending.current=true;submitted.current=true;setBusy(true);setError('');setOutcome(null);setJobId(null);
  try{const accepted=await request<Job>(`/environments/${id}/browser/reset`,{method:'POST',body:JSON.stringify({confirm:'erase-browser-profile',environmentName:target.name})});if(!live.current||latest.current.id!==id)return;if(!accepted.id||accepted.environmentId!==id||accepted.action!=='browser-reset')throw Error('重置回执无法对应当前环境，请核对操作记录');setJobId(accepted.id);setOutcome('accepted');setTarget(null);await refresh();}
  catch(value){if(!live.current||latest.current.id!==id)return;if(value instanceof ApiError&&value.status>=400&&value.status<500){submitted.current=false;setOutcome(null);}else setOutcome('unknown');setError((value as Error).message);}
  finally{pending.current=false;if(live.current)setBusy(false);}
 }
 const jobMessage=job?.status==='succeeded'?'浏览器资料已清除，请手动重新打开浏览器。':job&&job.status!=='running'?`重置任务${job.status==='cancelled'?'已取消':'未完成'}：${job.message}。请核对操作记录；已写入的清理意图将在下次打开浏览器前继续处理。`:outcome==='accepted'?'重置任务已提交，等待操作记录确认完成；不会自动打开浏览器。':outcome==='unknown'?'未能确认重置请求的结果，请先刷新并核对操作记录，勿重复提交。':'';
 return <section aria-label="Windows 浏览器资料重置"><div className="profile-reset-card"><div><h3>空白浏览器资料</h3><p>清除网站登录、缓存、历史、密码和扩展。保留虚拟机、项目文件与线路。</p></div><Button disabled={!available||busy} onClick={()=>{if(!available||pending.current)return;submitted.current=false;setTarget({id:environment.id,name:environment.name});setError('');setOutcome(null);setJobId(null);}}>重置浏览器资料</Button></div>
  {!enabled&&<Notice>浏览器资料重置尚未完成 Windows 实机验收，暂未开放。</Notice>}
  {jobMessage&&!target&&<Notice kind={job?.status==='succeeded'?'success':'info'}>{jobMessage}</Notice>}{error&&!target&&<Notice kind="error">{error}</Notice>}
  {outcome&&<div className="button-row"><Button disabled={busy} onClick={()=>void refresh()}>刷新操作结果</Button></div>}
  {target&&<Modal title="重置浏览器资料？" subtitle={target.name} narrow onClose={close}><form onSubmit={event=>void submit(event)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event=>{if(event.key==='Enter'&&(composing.current||event.nativeEvent.isComposing||event.keyCode===229))event.preventDefault();}}><div className="modal-body"><CleanupScope operation="browser"/>{(!available||environment.name!==target.name)&&!outcome&&<Notice>环境状态已变化，请关闭并重新核对重置范围。</Notice>}{outcome==='unknown'&&<Notice>{jobMessage}</Notice>}{error&&<Notice kind="error">{error}</Notice>}</div><footer className="modal-footer"><Button disabled={busy} onClick={close}>{outcome?'关闭':'取消'}</Button>{outcome?<Button disabled={busy} onClick={()=>void refresh()}>刷新操作记录</Button>:<Button type="submit" className="danger-filled" disabled={!available||environment.name!==target.name} loading={busy}>确认清除浏览器资料</Button>}</footer></form></Modal>}
 </section>;
}
