import {useEffect,useRef,useState} from 'react';
import {Button,Field,Modal,Notice} from '../components.tsx';
import {ApiError,request} from '../api.ts';
import type {Environment} from '../../shared/types.ts';
export default function WindowsDeleteDialog({environment,onClose,onDeleted}:{environment:Environment;onClose:()=>void;onDeleted:()=>Promise<void>}){
 const [name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[outcome,setOutcome]=useState<'accepted'|'unknown'|null>(null);
 const composing=useRef(false),pending=useRef(false),reading=useRef(false),submitted=useRef(false),live=useRef(false);
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 async function readback(){if(!live.current||reading.current)return;reading.current=true;setBusy(true);setError('');try{await onDeleted();}catch(value){if(live.current)setError((value as Error).message);}finally{reading.current=false;if(live.current)setBusy(false);}}
 async function submit(event:React.SubmitEvent<HTMLFormElement>){
  event.preventDefault();if(!live.current||pending.current||submitted.current||composing.current||name!==environment.name)return;
  pending.current=true;setBusy(true);setError('');
  try{await request(`/environments/${environment.id}/actions/delete`,{method:'POST',body:JSON.stringify({confirmation:name})});submitted.current=true;if(live.current){setOutcome('accepted');await readback();}}
  catch(value){if(!(value instanceof ApiError&&value.status>=400&&value.status<500)){submitted.current=true;if(live.current)setOutcome('unknown');}if(live.current)setError((value as Error).message);}
  finally{pending.current=false;if(live.current)setBusy(false);}
 }
 const close=()=>{if(!pending.current&&!reading.current&&!composing.current)onClose();};
 return <Modal title="删除 Windows 环境" subtitle={environment.name} narrow onClose={close}><form onSubmit={event=>void submit(event)} onKeyDown={event=>{if(event.key==='Enter'&&(composing.current||event.nativeEvent.isComposing||event.keyCode===229))event.preventDefault();}}><div className="modal-body"><Notice kind="error">将永久删除此环境的虚拟磁盘、文件和管理密钥，无法撤销。</Notice>{outcome?<Notice>{outcome==='accepted'?'删除请求已受理，可在操作记录查看结果。':'未能确认删除请求的结果，请刷新操作记录后核对。'}</Notice>:<Field label="输入完整环境名称以确认"><input autoFocus autoComplete="off" disabled={busy} value={name} onChange={event=>setName(event.target.value)} placeholder={environment.name} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}/></Field>}{error&&<Notice kind="error">{error}</Notice>}</div><footer className="modal-footer"><Button disabled={busy} onClick={close}>{outcome?'关闭':'取消'}</Button>{outcome?<Button disabled={busy} onClick={()=>void readback()}>刷新操作结果</Button>:<Button type="submit" className="danger" loading={busy} disabled={name!==environment.name}>永久删除</Button>}</footer></form></Modal>;
}
