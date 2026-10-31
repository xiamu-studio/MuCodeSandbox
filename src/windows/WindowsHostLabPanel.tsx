import {useCallback,useEffect,useRef,useState} from 'react';
import {Globe,Play,RefreshCw,Square} from 'lucide-react';
import {z} from 'zod';
import {windowsHostLabStatusSchema,windowsHostLabWindowSchema,type WindowsHostLabStatus} from '../../shared/windows-host-lab.ts';
import {request} from '../api.ts';
import {Button,IconButton,Notice,SectionHeading} from '../components.tsx';
const recordsSchema=z.object({runId:z.uuid().nullable(),receipts:z.array(z.object({id:z.uuid(),result:z.unknown()}).strict()).max(100),events:z.array(z.unknown()).max(1000)}).strict();
export default function WindowsHostLabPanel({disabled=false}:{disabled?:boolean}){
 const [status,setStatus]=useState<WindowsHostLabStatus|null>(null),[records,setRecords]=useState<z.infer<typeof recordsSchema>|null>(null),[error,setError]=useState(''),[readFailed,setReadFailed]=useState(false),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false);
 const live=useRef(false),epoch=useRef(0),operation=useRef(false),readController=useRef<AbortController|null>(null),composing=useRef(false);
 const read=useCallback(async(fresh=false)=>{
  if(fresh){epoch.current++;readController.current?.abort();readController.current=null;}if(readController.current)return;
  const controller=new AbortController(),version=epoch.current;readController.current=controller;
  try{const next=windowsHostLabStatusSchema.parse(await request('/windows/host-lab',{signal:controller.signal})),raw=recordsSchema.parse(await request('/windows/host-lab/records',{signal:controller.signal}));if(live.current&&version===epoch.current&&!controller.signal.aborted){setStatus(next);setRecords(raw.runId===next.runId?raw:null);setError('');setReadFailed(false);if(fresh)setUnknown(false);}}
  catch(value){if(live.current&&version===epoch.current&&!controller.signal.aborted){setError((value as Error).message);setReadFailed(true);setRecords(null);throw value;}}
  finally{if(readController.current===controller)readController.current=null;}
 },[]);
 useEffect(()=>{live.current=true;void read().catch(()=>{});const timer=setInterval(()=>{if(!operation.current)void read().catch(()=>{});},3000);return()=>{live.current=false;epoch.current++;readController.current?.abort();readController.current=null;clearInterval(timer);};},[read]);
 const working=busy||status?.phase==='starting'||status?.phase==='stopping',blocked=disabled||working||unknown;
 async function toggle(){
  if(operation.current||blocked||!status?.enabled||composing.current)return;const current=status;operation.current=true;setBusy(true);setError('');epoch.current++;readController.current?.abort();readController.current=null;
  try{const next=windowsHostLabStatusSchema.parse(await request('/windows/host-lab/'+(current.running?'stop':'start'),{method:'POST',body:current.running?JSON.stringify({runId:current.runId}):'{}'}));if(!live.current)return;setStatus(next);if(current.running&&current.runId)await window.muWindowsDesktop?.closeHostLab?.(current.runId);await read(true);}
  catch(value){if(live.current){setUnknown(true);setError((value as Error).message);}}
  finally{operation.current=false;if(live.current)setBusy(false);}
 }
 async function open(){
  if(operation.current||blocked||!status?.running||!status.runId||!window.muWindowsDesktop?.openHostLab||composing.current)return;const runId=status.runId;operation.current=true;setBusy(true);setError('');
  try{const descriptor=windowsHostLabWindowSchema.parse(await request('/windows/host-lab/window',{method:'POST',body:JSON.stringify({runId})}));if(!live.current)return;if(descriptor.runId!==runId)throw Error('本机检测会话已变化，请刷新后重试');const response=await window.muWindowsDesktop.openHostLab(descriptor);if(live.current&&(response.opened!==true||response.runId!==runId))throw Error('本机对照窗口未确认打开');}
  catch(value){if(live.current)setError((value as Error).message);}
  finally{operation.current=false;if(live.current)setBusy(false);}
 }
 return <section aria-label="Windows 本机检测对照" onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event=>{if(event.key==='Enter'&&(composing.current||event.nativeEvent.isComposing||event.keyCode===229))event.preventDefault();}}>
  <p>此入口打开 Windows 本机浏览器，用于对照，不受 Linux 防火墙保护。使用独立临时资料，只连接本地合成接收端，不使用日常浏览器资料。</p>
  <div className="button-row"><Button icon={status?.running?<Square size={15}/>:<Play size={15}/>} disabled={blocked||!status?.enabled} loading={busy} onClick={()=>void toggle()}>{status?.running?'停止本机接收端':'启动本机接收端'}</Button><Button icon={<Globe size={16}/>} disabled={blocked||!status?.running||!window.muWindowsDesktop?.openHostLab} onClick={()=>void open()}>打开本机对照浏览器</Button><IconButton title="刷新本机检测" disabled={busy||disabled} onClick={()=>void read(true).catch(()=>{})}><RefreshCw size={16}/></IconButton></div>
  {status&&!status.enabled&&<Notice>Windows 本机对照尚未完成桌面验收，暂未开放运行。</Notice>}{!window.muWindowsDesktop?.openHostLab&&<p className="muted">本机对照窗口需要 Windows 桌面入口。</p>}
  {unknown&&<Notice>未能确认接收端操作结果，请刷新本机检测后核对，勿重复提交。</Notice>}{error&&<Notice kind="error">{error}</Notice>}{status?.issue&&<Notice kind="error">{status.issue}</Notice>}
  <dl className="facts"><div><dt>本机页面</dt><dd className="mono path-text">{status?.url??'--'}</dd></div><div><dt>DNS / STUN</dt><dd>{status?.dnsPort??'--'} / {status?.stunPort??'--'}</dd></div><div><dt>事件 / 模拟调用</dt><dd>{status?.eventCount??0} / {status?.modelCalls??0}</dd></div></dl>
  <SectionHeading title="本机原始报告"/>{readFailed?<p className="muted">本机原始报告尚未读取</p>:records?.receipts.length?records.receipts.map(item=><details className="lab-record" key={item.id}><summary>{item.id}</summary><pre>{JSON.stringify(item.result,null,2)}</pre></details>):<p className="muted">暂无本机原始报告</p>}
 </section>;
}
