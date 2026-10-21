import {useCallback,useEffect,useState} from 'react';import {request} from '../api.ts';import {Button,Modal,Notice,SectionHeading} from '../components.tsx';import type {WindowsStorageStatus} from '../../shared/windows-storage.ts';
const size=(bytes:number)=>bytes<1024**2?(bytes/1024).toFixed(1)+' KiB':bytes<1024**3?(bytes/1024**2).toFixed(1)+' MiB':(bytes/1024**3).toFixed(2)+' GiB';
const reasons:Record<NonNullable<WindowsStorageStatus['reason']>,string>={'host-unavailable':'请先完成系统组件准备。','unregistered-storage':'存在未登记的旧数据，处理资源接管后再清理缓存。','dependencies-unavailable':'有磁盘依赖无法确认，缓存已保留。','unrecognized-cache-data':'缓存目录包含未识别数据，已保留，请先检查。'};
const issue=(value:string)=>value.includes('Cache contents or references changed')||value.includes('Cache file identity changed')?'缓存或引用已变化，请重新检查后再清理。':value.includes('image operation is still running')?'正在准备镜像，请稍后重新检查。':value;
export default function WindowsStoragePanel(){
 const [state,setState]=useState<WindowsStorageStatus|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[review,setReview]=useState<WindowsStorageStatus|null>(null),[message,setMessage]=useState('');
 const refresh=useCallback(async(clearError=false)=>{try{const next=await request<WindowsStorageStatus>('/windows/storage');setState(next);if(clearError)setError('');}catch(e){setError(issue((e as Error).message));}},[]);
 useEffect(()=>{let live=true;void refresh();const timer=setInterval(()=>{if(live)void refresh();},15000);return()=>{live=false;clearInterval(timer);};},[refresh]);
 async function prune(){if(!review)return;setBusy(true);setError('');try{const value=await request<{deletedFiles:number;reclaimedBytes:number}>('/windows/storage/prune',{method:'POST',body:JSON.stringify({plan:review.plan})});setMessage(`已清理 ${value.deletedFiles} 个缓存文件，回收 ${size(value.reclaimedBytes)}。`);setReview(null);await refresh();}catch(e){const message=issue((e as Error).message);setReview(null);await refresh();setError(message);}finally{setBusy(false);}}
 return <section className="windows-setup" aria-label="Windows 存储与缓存"><SectionHeading title="存储与缓存"/>{state?<>
  <dl className="facts"><div><dt>镜像缓存</dt><dd>{size(state.imageBytes)} / {size(state.quotaBytes)}</dd></div><div><dt>可清理缓存</dt><dd>{size(state.reclaimableBytes)} · {state.reclaimableFiles} 个文件</dd></div><div><dt>磁盘可用空间</dt><dd>{size(state.freeBytes)}</dd></div><div><dt>已登记虚拟容量</dt><dd>{state.allocatedDiskGiB} GiB</dd></div></dl>
  {state.reason&&<Notice>{reasons[state.reason]}</Notice>}
  <p>清理不再使用的镜像副本和中断准备留下的临时文件。当前基盘、现有环境及仍被磁盘引用的缓存会保留。</p>
 </>:<p>正在检查缓存与磁盘引用…</p>}{message&&<Notice kind="success">{message}</Notice>}{error&&<Notice kind="error">{error}</Notice>}
 <div className="button-row"><Button disabled={busy||!state?.canPrune} onClick={()=>setReview(state)}>清理未使用缓存</Button><Button disabled={busy} onClick={()=>void refresh(true)}>重新检查存储</Button></div>
 {review&&<Modal title="清理未使用缓存" narrow onClose={()=>{if(!busy)setReview(null);}}><div className="modal-body"><p>本次将删除 {review.reclaimableFiles} 个缓存文件，约 {size(review.reclaimableBytes)}。</p><p>清理前会再次核对文件和引用；发生变化时需要重新检查。</p></div><footer className="modal-footer"><Button disabled={busy} onClick={()=>setReview(null)}>取消</Button><Button loading={busy} onClick={()=>void prune()}>确认清理缓存</Button></footer></Modal>}
 </section>;
}
