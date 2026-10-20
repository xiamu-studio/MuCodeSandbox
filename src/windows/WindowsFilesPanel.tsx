import {useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,ArrowUpToLine,Folder,RefreshCw} from 'lucide-react';
import {Button,Notice,SectionHeading} from '../components.tsx';
import {request} from '../api.ts';
import {uploadGuestFile} from '../file-upload.ts';
import {TRANSFER_MAX_BYTES,TRANSFER_FOLDERS,type TransferFile,type TransferFilePage,type TransferZone} from '../../shared/guest-exchange.ts';

export default function WindowsFilesPanel({id}:{id:string}){
 const [zone,setZone]=useState<TransferZone>('downloads'),[folder,setFolder]=useState(''),[page,setPage]=useState<TransferFilePage|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[progress,setProgress]=useState<number|null>(null);
 const input=useRef<HTMLInputElement>(null),abort=useRef<AbortController|null>(null),live=useRef(false);
 async function list(cursor?:string){
  const response=await request<TransferFilePage>(`/environments/${id}/transfer-files?directory=1&zone=${zone}&path=${encodeURIComponent(folder)}${cursor?'&cursor='+encodeURIComponent(cursor):''}`,{signal:abort.current?.signal});
  if(live.current)setPage(old=>cursor&&old?{...response,files:[...old.files,...response.files]}:response);
 }
 useEffect(()=>{live.current=true;abort.current=new AbortController();setPage(null);setError('');setBusy(true);void list().catch(e=>{if(live.current)setError(e.message);}).finally(()=>{if(live.current)setBusy(false);});return()=>{live.current=false;abort.current?.abort();};},[id,zone,folder]);
 async function upload(file:File){
  if(file.size>TRANSFER_MAX_BYTES){setError('单个文件最多150 MiB');return;}setBusy(true);setError('');setMessage('');setProgress(0);
  try{const saved=await uploadGuestFile(id,file,(sent,total)=>{if(live.current)setProgress(total?Math.round(sent/total*100):100);},abort.current!.signal);if(live.current){setMessage(`已保存到 ${saved.path}`);if(zone==='downloads'&&!folder)await list();}}
  catch(e){if(live.current)setError((e as Error).message);}finally{if(live.current){setBusy(false);setProgress(null);}}
 }
 async function download(file:TransferFile){
  setBusy(true);setError('');
  try{const response=await fetch(`/api/environments/${id}/transfer-download`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+window.__MU_CONFIG__.token},body:JSON.stringify({zone:file.zone,name:file.name,path:folder,revision:file.revision}),signal:abort.current?.signal});
   if(!response.ok)throw Error((await response.json()).error??'下载失败');const blob=await response.blob();if(!live.current)return;
   const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=file.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),10000);setMessage('文件已交给本机浏览器下载');
  }catch(e){if(live.current)setError((e as Error).message);}finally{if(live.current)setBusy(false);}
 }
 return <section>
  <SectionHeading title="文件传输" subtitle="上传到客体下载目录；每个文件最多150 MiB。" action={<><Button disabled={busy} onClick={()=>input.current?.click()} icon={<ArrowUpToLine size={15}/>}>上传文件</Button><Button disabled={busy} aria-label="刷新文件" onClick={()=>{setBusy(true);void list().catch(e=>setError(e.message)).finally(()=>setBusy(false));}} icon={<RefreshCw size={15}/>}/></>}/>
  <input hidden type="file" ref={input} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void upload(file);}}/>
  <div className="button-row">{(['downloads','incoming','outgoing'] as const).map(value=><Button key={value} disabled={busy} className={zone===value?'primary':''} onClick={()=>{setZone(value);setFolder('');}}>{({downloads:'下载',incoming:'传入',outgoing:'导出'})[value]}</Button>)}<Button disabled={busy||!folder} onClick={()=>setFolder(folder.split('/').slice(0,-1).join('/'))}>上一级</Button></div>
  <p className="mono path-text">{TRANSFER_FOLDERS[zone]}{folder?'/'+folder:''}</p>
  {error&&<Notice kind="error">{error}</Notice>}{message&&<Notice kind="success">{message}</Notice>}
  {progress!==null&&<div role="status">{progress===100?'上传完成，正在确认客体保存…':`上传 ${progress}%`}<progress value={progress} max={100}/><Button onClick={()=>{abort.current?.abort();abort.current=new AbortController();}}>取消传输</Button></div>}
  {page?.files.map(file=><div className="windows-file-row" key={file.name}>{file.kind==='directory'?<Button disabled={busy} icon={<Folder size={16}/>} onClick={()=>setFolder(file.relativePath??[folder,file.name].filter(Boolean).join('/'))}>{file.name}</Button>:<><span>{file.name}</span><small>{file.bytes<1024?`${file.bytes} B`:`${(file.bytes/1024).toFixed(1)} KiB`}</small><Button disabled={busy} aria-label={`下载 ${file.name}`} icon={<ArrowDownToLine size={15}/>} onClick={()=>void download(file)}>下载</Button></>}</div>)}
  {page&&!page.files.length&&<p>此文件夹暂无可传输文件</p>}{page?.nextCursor&&<Button disabled={busy} onClick={()=>{setBusy(true);void list(page.nextCursor!).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>加载更多</Button>}
 </section>;
}
