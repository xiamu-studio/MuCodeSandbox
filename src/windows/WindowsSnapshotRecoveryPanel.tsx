import {useEffect,useRef,useState} from 'react';
import type {Environment} from '../../shared/types.ts';
import type {WindowsSnapshotProductStatus} from '../../shared/windows-snapshots.ts';
import {request} from '../api.ts';
import {Button,Field,Modal,Notice,SectionHeading} from '../components.tsx';

export default function WindowsSnapshotRecoveryPanel({environments,onChange,disabled}:{environments:Environment[];onChange:()=>Promise<void>;disabled:boolean}){
 const [state,setState]=useState<WindowsSnapshotProductStatus|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[selected,setSelected]=useState<Environment|null>(null),[confirmation,setConfirmation]=useState('');
 const live=useRef(false),revision=useRef(0),composition=useRef(false),posting=useRef(false),polling=useRef(false);
 useEffect(()=>{
  live.current=true;const read=async()=>{if(polling.current||posting.current)return;polling.current=true;const stamp=revision.current;try{const next=await request<WindowsSnapshotProductStatus>('/windows/snapshots');if(live.current&&stamp===revision.current){setState(next);setError('');}}catch(error){if(live.current&&stamp===revision.current)setError((error as Error).message);}finally{polling.current=false;}};
  void read();const timer=setInterval(()=>void read(),5000);return()=>{live.current=false;revision.current++;clearInterval(timer);};
 },[]);
 async function perform(action:'recheck'|'recover'){
  if(posting.current||disabled||composition.current)return;if(action==='recover'&&(!selected||confirmation!==selected.name))return;
  posting.current=true;const stamp=++revision.current;setBusy(true);setError('');
  try{
   await request(action==='recheck'?'/windows/snapshots/recheck':`/environments/${selected!.id}/windows-snapshots/recover`,{method:'POST',body:JSON.stringify(action==='recheck'?{}:{confirmation})});
   if(live.current&&stamp===revision.current){const next=await request<WindowsSnapshotProductStatus>('/windows/snapshots');if(live.current&&stamp===revision.current){setSelected(null);setConfirmation('');setState(next);await onChange();}}
  }catch(error){if(live.current&&stamp===revision.current)setError((error as Error).message);}finally{posting.current=false;if(live.current&&stamp===revision.current)setBusy(false);}
 }
 const attention=state&&(state.recoveryAvailable&&!state.initialized||state.pendingIds.length||state.issues.length);
 if(!attention&&!error)return null;
 return <section className="windows-setup" aria-label="快照事务恢复"><SectionHeading title="快照事务恢复" action={<Button disabled={disabled||busy||!state?.recoveryAvailable||!!state?.activeIds.length} loading={busy&&!selected} onClick={()=>void perform('recheck')}>重新核验恢复状态</Button>}/>
  <p>先接续已有事务，再允许相关环境启动或修改配置。接续按已保存的提交或回滚决定执行，完成后保持停止。</p>
  {state&&!state.recoveryAvailable&&<Notice>请先完成系统组件准备并重新打开软件，再核验快照事务。</Notice>}
  {state?.issues.filter(issue=>issue.id===null).map(issue=><Notice kind="error" key="workspace">{issue.message}</Notice>)}
  {state?.pendingIds.map(id=>{const environment=environments.find(value=>value.id===id);return <div className="windows-file-row" key={id}><span><strong>{environment?.name??'待核验的原环境'}</strong><small className="path-text">{environment?'磁盘与配置已保留；尚未完成恢复':`原标识 ${id}；先重新核验，不创建替代环境`}</small></span>{environment&&<Button disabled={disabled||busy||!state.recoveryAvailable||!!state.activeIds.length} onClick={()=>{setSelected(environment);setConfirmation('');composition.current=false;}}>接续此环境</Button>}</div>;})}
  {error&&!selected&&<Notice kind="error">{error}</Notice>}
  {selected&&<Modal title="接续快照事务？" subtitle={selected.name} narrow onClose={()=>{if(!busy){setSelected(null);setConfirmation('');}}}><form onSubmit={event=>{event.preventDefault();void perform('recover');}}><div className="modal-body"><Notice>将按原事务的持久化决定核验并重放磁盘与配置。不会选择新的快照，不会启动环境。未知内容会保留并继续阻止启动。</Notice><Field label="输入完整环境名称以确认"><input autoFocus autoComplete="off" value={confirmation} disabled={busy} onChange={event=>setConfirmation(event.target.value)} onCompositionStart={()=>{composition.current=true;}} onCompositionEnd={()=>{composition.current=false;}}/></Field>{error&&<Notice kind="error">{error}</Notice>}</div><footer className="modal-footer"><Button disabled={busy} onClick={()=>{setSelected(null);setConfirmation('');}}>取消</Button><Button type="submit" className="primary" loading={busy} disabled={confirmation!==selected.name||disabled}>确认接续</Button></footer></form></Modal>}
 </section>;
}
