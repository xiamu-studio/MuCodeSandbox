import {useEffect,useRef,useState} from 'react';
import {Gauge,LoaderCircle,RefreshCw} from 'lucide-react';
import type {Environment} from '../shared/types.ts';
import {LATENCY_TARGETS,type AccessLatency,type LatencyTarget} from '../shared/latency.ts';
import {api} from './api.ts';
import {Button,Notice,SectionHeading,dateLabel} from './components.tsx';
type LatencyUpdate={key:string;phase:'started'|'finished'|'failed';report?:AccessLatency;error?:string};
const notifyLatency=(detail:LatencyUpdate)=>window.dispatchEvent(new CustomEvent('mu-access-latency',{detail}));

function useAccessLatency(environment:Environment){
  const key=`${environment.id}:${environment.state}:${environment.updatedAt}`,current=useRef(key);current.current=key;
  const [record,setRecord]=useState<{key:string;value:AccessLatency|null}|null>(null),[failure,setFailure]=useState<{key:string;message:string}|null>(null),[busyKey,setBusyKey]=useState<string|null>(null);
  const [readFailure,setReadFailure]=useState<{key:string;message:string}|null>(null);
  const inFlight=useRef<{key:string}|null>(null),pendingKey=useRef<string|null>(null),revision=useRef(0),running=environment.kind==='vm'&&environment.state==='running';
  useEffect(()=>{const receive=(event:Event)=>{const value=(event as CustomEvent<LatencyUpdate>).detail;if(value.key!==key)return;revision.current++;
    setReadFailure(null);
    pendingKey.current=value.phase==='started'?key:null;setBusyKey(value.phase==='started'?key:null);
    setRecord({key,value:value.phase==='finished'?value.report??null:null});setFailure(value.phase==='failed'?{key,message:value.error??'检测失败'}:null);
  };window.addEventListener('mu-access-latency',receive);return()=>window.removeEventListener('mu-access-latency',receive);},[key]);
  useEffect(()=>{let live=true,pending=false;if(!running)return;
    async function update(){if(pending||pendingKey.current===key||inFlight.current?.key===key)return;pending=true;const version=revision.current;try{const value=await api.accessLatency(environment.id);if(live&&version===revision.current){setRecord({key,value});setReadFailure(null);}}catch(error){if(live&&version===revision.current)setReadFailure({key,message:(error as Error).message});}finally{pending=false;}}
    void update();const timer=setInterval(()=>void update(),5000);return()=>{live=false;clearInterval(timer);};
  },[key,running]);
  async function measure(target:LatencyTarget){if(!running||pendingKey.current===key||inFlight.current?.key===key)return;const ticket={key};inFlight.current=ticket;setBusyKey(key);setRecord({key,value:null});setFailure(null);notifyLatency({key,phase:'started'});
    try{const value=await api.testAccessLatency(environment.id,target);if(current.current===key)setRecord({key,value});notifyLatency({key,phase:'finished',report:value});}
    catch(error){const message=(error as Error).message;if(current.current===key){setRecord({key,value:null});setFailure({key,message});}notifyLatency({key,phase:'failed',error:message});}
    finally{if(inFlight.current===ticket)inFlight.current=null;setBusyKey(value=>value===key?null:value);}
  }
  return {report:running&&record?.key===key?record.value:null,error:failure?.key===key?failure.message:readFailure?.key===key?readFailure.message:'',readError:readFailure?.key===key&&failure?.key!==key,busy:busyKey===key,running,measure};
}

export function LatencyBadge({environment}:{environment:Environment}){
  const {report,error,readError,busy,running,measure}=useAccessLatency(environment);
  if(environment.kind!=='vm')return null;
  const label=!running?'先启动':busy?'检测中':readError?'读取失败':error||report?.medianMs===null?'检测失败':report?`${report.medianMs} ms`:'未检测';
  const target=LATENCY_TARGETS.find(t=>t.id===report?.target);
  const title=!running?'启动 Linux 沙箱后可检测':error||report?error||`${target?.name} · ${report!.successfulSamples}/3 次成功 · ${dateLabel(report!.checkedAt)}；Clash 式统一延迟，复用连接后测请求往返`:'连续检测三次当前沙箱线路的统一延迟';
  return <button className={`latency-badge ${error||report?.medianMs===null?'has-error':''}`} aria-label="检测线路延迟" disabled={!running||busy} title={title} onClick={()=>void measure(report?.target??'google')}>
    {busy?<LoaderCircle size={14} className="spin"/>:<Gauge size={15}/>}<span>线路延迟</span><strong>{label}</strong>{running&&!busy&&<small>测延迟</small>}
  </button>;
}

export function AccessLatencyPanel({environment,hostLabel='Mac'}:{environment:Environment;hostLabel?:string}){
  const {report,error,readError,busy,running,measure}=useAccessLatency(environment),[target,setTarget]=useState<LatencyTarget>('google');
  const shown=report?.target===target&&!busy&&!error?report:null;
  return <section className="access-latency-panel">
    <SectionHeading title="线路延迟" subtitle="Clash 式统一延迟：先建立连接，再测复用连接的轻量请求往返。每次检测取三轮中位数。"/>
    <div className="latency-controls"><label>测试站点<select aria-label="延迟测试站点" value={target} disabled={busy} onChange={event=>setTarget(event.target.value as LatencyTarget)}>{LATENCY_TARGETS.map(t=><option value={t.id} key={t.id}>{t.name} · {t.host}</option>)}</select></label><Button className="primary" icon={<RefreshCw size={15}/>} loading={busy} disabled={!running} onClick={()=>void measure(target)}>测延迟</Button></div>
    <div className="latency-reading"><strong>{!running?'先启动环境':busy?'检测中…':readError?'读取失败':error?'检测失败':shown?.medianMs===null?'检测失败':shown?<>{shown.medianMs}<span> ms</span></>:'尚未检测'}</strong><div>{shown?<><p>三次测量的中位数 · {shown.successfulSamples}/3 次成功{shown.minMs!==null&&` · 范围 ${shown.minMs}–${shown.maxMs} ms`}</p><small>检测时间：{dateLabel(shown.checkedAt)} · Linux 沙箱内</small></>:<p>{running?'连续测三次小请求，不下载大文件。':`启动后才能测当前线路；不会使用 ${hostLabel} 本机直连代测。`}</p>}</div></div>
    {shown&&<div className="latency-samples">{shown.samples.map((sample,index)=><div key={index} className={sample.ok?'':'failed'}><span>第 {index+1} 次</span><strong>{sample.ok?`${sample.lineDelayMs} ms`:'失败'}</strong><small>{sample.ok?`复用连接 · HTTP ${sample.httpStatus}`:sample.issue}</small></div>)}</div>}
    {shown?.firstResponseMedianMs!==null&&shown?.firstResponseMedianMs!==undefined&&<p className="latency-page-time">网页首次响应耗时：{shown.firstResponseMedianMs} ms（包含首次建连，仅作补充对比）。</p>}
    {error&&<Notice kind="error">{error}</Notice>}
  </section>;
}
