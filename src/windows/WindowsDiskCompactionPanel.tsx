import {useEffect,useRef,useState} from 'react';
import {Button,Field,Modal,Notice} from '../components.tsx';
import {request} from '../api.ts';
import type {Environment} from '../../shared/types.ts';
import type {WindowsCompactionStatus} from '../../server/platform/windows/disk-compaction.ts';

const phaseText:Record<Extract<WindowsCompactionStatus,{pending:true}>['phase'],string>={
 preparing:'准备维护',trimming:'整理环境内的空闲空间',armed:'准备压缩虚拟磁盘',compacting:'确认磁盘压缩结果',verifying:'检查环境能否正常启动'
};
type Schedule={enabled:boolean;nextAt:number|null;lastAt:number|null;result:'pending'|'done'|'blocked'|'failed'|null;running:boolean};
function scheduleTime(value:number|null){
 if(value===null)return '暂无记录';
 const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'时间无法读取';
}

export default function WindowsDiskCompactionPanel({environment,disabled,onChange}:{environment:Environment;disabled:boolean;onChange:()=>Promise<void>}){
 const [opened,setOpened]=useState(false),[status,setStatus]=useState<WindowsCompactionStatus|null>(null),[busy,setBusy]=useState(false),[posting,setPosting]=useState(false),[error,setError]=useState(''),[confirmation,setConfirmation]=useState(''),[composing,setComposing]=useState(false);
 const [schedule,setSchedule]=useState<Schedule|null>(null),[scheduleBusy,setScheduleBusy]=useState(false);
 const read=useRef<AbortController|null>(null),composingRef=useRef(false),actionLock=useRef(false);
 useEffect(()=>()=>read.current?.abort(),[]);
 function close(){if(actionLock.current)return;read.current?.abort();read.current=null;setOpened(false);setBusy(false);}
 async function open(){
  read.current?.abort();const controller=new AbortController();read.current=controller;setOpened(true);setBusy(true);setStatus(null);setSchedule(null);setError('');setConfirmation('');composingRef.current=false;setComposing(false);
  try{const [result,scheduled]=await Promise.all([request<WindowsCompactionStatus>(`/environments/${environment.id}/disk-compaction`,{signal:controller.signal}),request<Schedule>(`/environments/${environment.id}/disk-compaction/schedule`,{signal:controller.signal})]);if(read.current===controller){setStatus(result);setSchedule(scheduled);}}
  catch(e){if(read.current===controller&&!controller.signal.aborted)setError((e as Error).message);}
  finally{if(read.current===controller){read.current=null;setBusy(false);}}
 }
 async function submit(operation:'start'|'resume'|'cancel'){
  if(actionLock.current||busy||composingRef.current||confirmation!==environment.name||!status)return;
  actionLock.current=true;setBusy(true);setPosting(true);setError('');
  try{await request(`/environments/${environment.id}/disk-compaction`,{method:'POST',body:JSON.stringify({operation,confirmation})});setOpened(false);await onChange();}
  catch(e){setError((e as Error).message);}finally{actionLock.current=false;setBusy(false);setPosting(false);}
 }
 async function setScheduled(enabled:boolean){if(actionLock.current||scheduleBusy||posting)return;actionLock.current=true;setScheduleBusy(true);setError('');try{setSchedule(await request<Schedule>(`/environments/${environment.id}/disk-compaction/schedule`,{method:'POST',body:JSON.stringify({enabled})}));}catch(e){setSchedule(null);setError((e as Error).message);}finally{actionLock.current=false;setScheduleBusy(false);}}
 const canCancel=status?.pending&&['preparing','trimming','armed'].includes(status.phase);
 return <><Button disabled={disabled||!['stopped','error'].includes(environment.state)} onClick={()=>void open()}>回收磁盘空间</Button>{opened&&<Modal title="回收磁盘空间" subtitle={environment.name} narrow onClose={close}><div className="modal-body">
  {error&&<Notice kind="error">{error}</Notice>}{busy&&!status&&<p>正在核对磁盘维护状态…</p>}
  {status&&<><p>回收 Linux 中已删除文件所占的宿主磁盘空间，不会缩小环境的容量上限。文件分配量和宿主可用空间的变化可能不同。</p><p>维护期间环境会短暂启动以整理空闲空间，业务网络保持关闭；结束后环境保持停止。</p><Notice>此功能处于预览阶段，请先备份重要数据。若维护意外中断且结果无法确认，环境可能暂时无法启动，需要保留磁盘并联系支持。</Notice>
   {status.pending&&<Notice>上次磁盘维护尚未确认完成，停在“{phaseText[status.phase]}”。维护前虚拟磁盘文件分配量约 {(status.beforeBytes/1024**3).toFixed(2)} GiB。请继续检查原操作；不要重复开始新的回收。</Notice>}
   {status.pending&&status.phase==='compacting'&&status.jobTracked===false&&<Notice kind="error">原压缩作业身份未记录，无法自动确认结果。请保留此环境和磁盘，联系支持处理；不要重新回收。</Notice>}
   {!schedule&&<><Notice>定期回收状态未确认，请重新检查后再调整设置。</Notice><Button disabled={busy||scheduleBusy||posting} onClick={()=>void open()}>重新检查回收设置</Button></>}
   {schedule&&<><p>定期回收：{schedule.enabled?'已开启':'已关闭'}。开启后每周检查一次，仅在应用打开、环境停止且没有其他维护任务时执行。</p>
    {schedule.lastAt!==null&&<p>上次检查：{scheduleTime(schedule.lastAt)} · {schedule.result==='done'?'回收已完成':schedule.result==='blocked'?'条件暂不满足，稍后重试':schedule.result==='pending'?(schedule.running?'正在处理':'结果待确认'):schedule.result==='failed'?'未确认完成':'暂无结果'}</p>}
    {schedule.enabled&&!schedule.running&&!['pending','failed'].includes(schedule.result??'')&&<p>下次检查不早于：{scheduleTime(schedule.nextAt)}。应用关闭期间不会执行，重新打开后会在条件满足时检查。</p>}
    {schedule.result==='pending'&&!schedule.running&&<Notice>上次定期回收未确认完成，自动回收已暂停；请先检查原维护状态。</Notice>}{schedule.result==='failed'&&<Notice>上次定期回收未确认完成，已关闭自动回收；请检查维护状态后再开启。</Notice>}<Button disabled={busy||scheduleBusy||posting||schedule.running||status.pending&&!schedule.enabled} onClick={()=>void setScheduled(!schedule.enabled)}>{schedule.enabled?'关闭定期回收':'开启定期回收'}</Button></>}
   <Field label="输入完整环境名称以确认"><input autoComplete="off" value={confirmation} disabled={busy} onChange={event=>setConfirmation(event.target.value)} onKeyDown={event=>{if((event.key==='Enter'||event.keyCode===229)&&(composingRef.current||event.nativeEvent.isComposing||event.keyCode===229)){event.preventDefault();event.stopPropagation();}}} onCompositionStart={()=>{composingRef.current=true;setComposing(true);}} onCompositionEnd={event=>{composingRef.current=false;setComposing(false);setConfirmation(event.currentTarget.value);}}/></Field></>}
 </div><footer className="modal-footer"><Button disabled={posting||scheduleBusy} onClick={close}>关闭</Button>{canCancel&&<Button disabled={busy||scheduleBusy||composing||confirmation!==environment.name} onClick={()=>void submit('cancel')}>取消未提交的维护</Button>}{status&&<Button className="primary" loading={busy} disabled={busy||scheduleBusy||composing||confirmation!==environment.name||status.pending&&status.phase==='compacting'&&status.jobTracked===false} onClick={()=>void submit(status.pending?'resume':'start')}>{status.pending?'继续检查':'开始回收'}</Button>}</footer></Modal>}</>;
}
