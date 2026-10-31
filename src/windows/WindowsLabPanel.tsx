import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,Check,FlaskConical,LoaderCircle,Play,RefreshCw,ShieldCheck,X} from 'lucide-react';
import type {Environment,Job,Snapshot} from '../../shared/types.ts';
import {windowsLocalCheckStartSchema,windowsLocalCheckStatusSchema,type WindowsLocalCheckReport,type WindowsLocalCheckStatus} from '../../shared/windows-local-check.ts';
import {ApiError,request} from '../api.ts';
import WindowsHostLabPanel from './WindowsHostLabPanel.tsx';
import {Button,IconButton,Notice,SectionHeading,dateLabel} from '../components.tsx';

export default function WindowsLabPanel({snapshot,disabled=false,onConfigure,onJobs}:{snapshot:Snapshot;disabled?:boolean;onConfigure:(id:string)=>void;onJobs:()=>Promise<void>}){
 const [selected,setSelected]=useState(()=>snapshot.environments.find(environment=>environment.kind==='vm')?.id??''),[status,setStatus]=useState<WindowsLocalCheckStatus|null>(null),[error,setError]=useState(''),[reading,setReading]=useState(false);
 const live=useRef(false),epoch=useRef(0),pending=useRef<{epoch:number;controller:AbortController;promise:Promise<void>}|null>(null);
 const invalidate=useCallback(()=>{epoch.current++;pending.current?.controller.abort();pending.current=null;},[]);
 const refresh=useCallback((fresh=false):Promise<void>=>{
  if(fresh)invalidate();if(pending.current?.epoch===epoch.current)return pending.current.promise;
  const version=epoch.current,controller=new AbortController();setReading(true);
  const promise=request('/windows/local-checks',{signal:controller.signal}).then(value=>{const parsed=windowsLocalCheckStatusSchema.parse(value);if(live.current&&version===epoch.current&&!controller.signal.aborted){setStatus(parsed);setError('');}}).catch(value=>{if(live.current&&version===epoch.current&&!controller.signal.aborted){setError((value as Error).message);throw value;}}).finally(()=>{if(pending.current?.controller===controller){pending.current=null;if(live.current)setReading(false);}});
  pending.current={epoch:version,controller,promise};return promise;
 },[invalidate]);
 useEffect(()=>{live.current=true;void refresh().catch(()=>{});const timer=setInterval(()=>void refresh().catch(()=>{}),3000);return()=>{live.current=false;clearInterval(timer);invalidate();};},[refresh,invalidate]);
 const environment=snapshot.environments.find(value=>value.id===selected),report=status?.reports.find(value=>value.environmentId===selected),jobs=snapshot.jobs;
 return <>
  <header className="page-header"><div><div className="eyebrow">不用真实账号</div><h1>检测实验室</h1><p>确认环境，再检查本地浏览器与模拟任务。</p></div><span className="account-free-badge"><ShieldCheck size={15}/>付费请求 0</span></header>
  <WindowsLabRun key={selected} selected={selected} environments={snapshot.environments} onSelect={setSelected} environment={environment} report={report} jobs={jobs} disabled={disabled} enabled={status?.enabled===true} loaded={!!status} onConfigure={onConfigure} invalidate={invalidate} refresh={()=>refresh(true)} onJobs={onJobs}/>
  {error&&<Notice kind="error">检测报告读取失败：{error}<Button disabled={reading} onClick={()=>void refresh(true).catch(()=>{})}>重试读取报告</Button></Notice>}{status?.issue&&<Notice kind="error">{status.issue}</Notice>}
  {!status&&!error&&<p className="checking-caption"><LoaderCircle className="spin" size={15}/>正在读取检测状态…</p>}
 </>;
}
function WindowsLabRun({selected,environments,onSelect,environment,report,jobs,disabled,enabled,loaded,onConfigure,invalidate,refresh,onJobs}:{selected:string;environments:Environment[];onSelect:(id:string)=>void;environment?:Environment;report?:WindowsLocalCheckReport;jobs:Job[];disabled:boolean;enabled:boolean;loaded:boolean;onConfigure:(id:string)=>void;invalidate:()=>void;refresh:()=>Promise<void>;onJobs:()=>Promise<void>}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[ticket,setTicket]=useState<{reportId:string;jobId:string}|null>(null),[unknown,setUnknown]=useState(false);
 const live=useRef(false),submitted=useRef(false),inflight=useRef(false),composing=useRef(false),latest=useRef(environment),baseline=useRef<{at:number;reportId?:string;jobs:Set<string>}|null>(null),reconcile=useRef(false);latest.current=environment;
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 const active=jobs.find(job=>job.environmentId===environment?.id&&job.status==='running'),acceptedJob=ticket?jobs.find(job=>job.id===ticket.jobId&&job.environmentId===environment?.id&&job.action==='lab-check'):undefined;
 const terminal=!!acceptedJob&&acceptedJob.status!=='running',available=!!environment&&enabled&&!disabled&&!active&&environment.state==='running'&&environment.network.strict&&environment.network.transparent&&!unknown&&(!submitted.current||terminal);
 useEffect(()=>{if(!unknown||!reconcile.current||!report||!baseline.current||report.id===baseline.current.reportId||Date.parse(report.startedAt)<baseline.current.at||baseline.current.jobs.has(report.jobId))return;const job=jobs.find(value=>value.id===report.jobId&&value.environmentId===environment?.id&&value.action==='lab-check');if(job&&job.status!=='running'){setTicket({reportId:report.id,jobId:job.id});setUnknown(false);setError('');reconcile.current=false;}},[unknown,report,jobs,environment?.id]);
 const visible=busy&&!ticket||unknown?undefined:ticket?report?.id===ticket.reportId&&report.jobId===ticket.jobId?report:undefined:report;
 async function check(){
  if(!live.current||!available||inflight.current||composing.current||!environment)return;
  const id=environment.id;let acknowledged=false;inflight.current=true;submitted.current=true;baseline.current={at:Date.now(),reportId:report?.id,jobs:new Set(jobs.map(value=>value.id))};reconcile.current=false;setBusy(true);setError('');setTicket(null);setUnknown(false);invalidate();
  try{
   const accepted=windowsLocalCheckStartSchema.parse(await request('/environments/'+id+'/lab/check',{method:'POST',body:'{}'}));
   if(!live.current||latest.current?.id!==id)return;if(accepted.job.environmentId!==id)throw Error('检测回执无法对应当前环境');
   acknowledged=true;setTicket({reportId:accepted.reportId,jobId:accepted.job.id});await onJobs();await refresh();
  }catch(value){if(!live.current||latest.current?.id!==id)return;if(!acknowledged){if(value instanceof ApiError&&value.status>=400&&value.status<500)submitted.current=false;else setUnknown(true);}setError((value as Error).message);}
  finally{inflight.current=false;if(live.current)setBusy(false);}
 }
 async function read(){if(inflight.current||!live.current)return;setBusy(true);reconcile.current=unknown;try{await onJobs();await refresh();if(live.current)setError('');}catch(value){if(live.current)setError((value as Error).message);}finally{if(live.current)setBusy(false);}}
 function download(){if(!visible||visible.state==='running')return;const url=URL.createObjectURL(new Blob([JSON.stringify(visible,null,2)],{type:'application/json'})),anchor=document.createElement('a');anchor.href=url;anchor.download='MuCodeSandbox-local-check-'+visible.id+'.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 const matchingJob=visible?jobs.find(value=>value.id===visible.jobId&&value.environmentId===visible.environmentId&&value.action==='lab-check'):undefined,awaiting=visible?.state==='passed'&&(matchingJob?.status==='running'||!!ticket&&!matchingJob),reportPassed=visible?.state==='passed'&&(matchingJob?.status==='succeeded'||!ticket&&!matchingJob),historical=!!visible&&(environment?.state!=='running'||visible.environmentUpdatedAt!==environment.updatedAt),prerequisite=!environment?'先创建 Linux 沙箱':environment.state!=='running'?'需要先配置线路并启动环境':!environment.network.strict||!environment.network.transparent?'需要强制防护与透明代理':active?'等待当前操作完成':'';
 return <div onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event=>{if(event.key==='Enter'&&(composing.current||event.nativeEvent.isComposing||event.keyCode===229))event.preventDefault();}}>
  <section className="lab-run-card"><div className="lab-run-heading"><span className="setup-compass"><FlaskConical size={24}/></span><div><h2>沙箱无账号检测</h2><p>所选 Linux 环境 · 独立临时资料 · 本地模拟任务</p></div></div>
  <div className="lab-run-controls"><label className="field"><span>检测环境</span><select aria-label="检测环境" value={selected} onChange={event=>onSelect(event.target.value)}>{!environment&&<option value="">选择 Linux 沙箱</option>}{environments.filter(value=>value.kind==='vm').map(value=><option key={value.id} value={value.id}>{value.name}{value.state!=='running'?' · 已停止':''}</option>)}</select></label><Button className="primary" icon={<Play size={15}/>} disabled={!available} loading={busy||active?.action==='lab-check'} onClick={()=>void check()}>运行无账号检测</Button></div>
  {prerequisite&&<div className="lab-prerequisite"><span>{prerequisite}</span>{environment&&environment.state!=='running'&&<button className="text-button" onClick={()=>onConfigure(environment.id)}>前往线路设置</button>}</div>}
  {loaded&&!enabled&&<Notice>检测实验室尚未完成 Windows 实机验收，暂未开放运行；可查看已有报告。</Notice>}
  <p className="scope-caption">范围：实时防护、浏览器上下文、合成登录和本地模拟消息。公网出口、实际 DNS / WebRTC 泄漏须另验。</p>
  </section>
  {ticket&&!visible&&<Notice>检测任务已提交，等待对应报告与操作记录；接受请求不代表检测通过。</Notice>}
  {unknown&&<Notice>未能确认检测请求的结果，请刷新并核对操作记录，勿重复提交。</Notice>}{error&&<Notice kind="error">{error}</Notice>}
  {(ticket&&!visible||unknown)&&<Button disabled={busy} onClick={()=>void read()}>刷新检测结果</Button>}
  {visible&&<section className="lab-report-card"><SectionHeading title={historical?'上次检测结果':'本次检测结果'} subtitle={visible.environmentName+' · '+dateLabel(visible.checkedAt)} action={<div className="button-row"><span className={'report-state '+(visible.state==='running'||awaiting?'running':reportPassed?'passed':'failed')}>{visible.state==='running'?'检测中':awaiting?'等待操作确认':reportPassed?historical?'历史分项通过':'本地分项通过':'需要检查'}</span>{(visible.state==='running'||awaiting||!!error)&&<IconButton title="刷新检测结果" disabled={busy} onClick={()=>void read()}><RefreshCw size={17}/></IconButton>}<IconButton title="下载检测报告" disabled={visible.state==='running'||awaiting} onClick={download}><ArrowDownToLine size={17}/></IconButton></div>}/>
   <div className="check-results">{visible.checks.map(value=><div className={value.passed?'passed':'failed'} key={value.name}>{value.passed?<Check size={17}/>:<X size={17}/>}<div><strong>{value.name}</strong><p>{value.detail}</p></div><span>{value.passed?'通过':'未通过'}</span></div>)}</div>
   {visible.state==='running'&&<p className="checking-caption"><LoaderCircle size={15} className="spin"/>正在读取实际结果…</p>}{visible.error&&<Notice kind="error">{visible.error}</Notice>}{visible.state==='passed'&&!reportPassed&&!awaiting&&<Notice kind="error">操作记录未确认检测成功，请核对结果并重新检测。</Notice>}{historical&&<Notice>这是上次会话或配置的检测记录，当前环境需要重新检测。</Notice>}<p className="scope-caption">{visible.scope}</p>
  </section>}
  <details className="lab-advanced"><summary>本机对照与原始接收端</summary><WindowsHostLabPanel disabled={disabled}/><p>以下为所选 Linux 沙箱的本地模拟接收记录。</p><SectionHeading title="原始报告" action={<IconButton title="刷新报告" disabled={busy} onClick={()=>void read()}><RefreshCw size={16}/></IconButton>}/>{visible?.result?<details className="lab-record"><summary>{visible.id}</summary><pre>{JSON.stringify(visible.result,null,2)}</pre></details>:<p className="muted">{loaded?'暂无原始报告':'尚未读取报告'}</p>}</details>
 </div>;
}
