import {useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,ArrowUpToLine,Folder,FolderPlus,RefreshCw} from 'lucide-react';
import {Button,Field,Notice,SectionHeading} from '../components.tsx';
import {request} from '../api.ts';
import {uploadGuestFile} from '../file-upload.ts';
import {TRANSFER_MAX_BYTES,TRANSFER_FOLDERS,type TransferFile,type TransferFilePage,type TransferZone} from '../../shared/guest-exchange.ts';
import {windowsDirectoryNameIssue,type WindowsTransferDirectory} from '../../shared/windows-files.ts';

interface FilesContext {id:string;zone:TransferZone;folder:string;abort:AbortController;scope:symbol}
export default function WindowsFilesPanel({id,canCreateDirectories=false}:{id:string;canCreateDirectories?:boolean}){
 const [zone,setZone]=useState<TransferZone>('downloads'),[folder,setFolder]=useState(''),[page,setPage]=useState<TransferFilePage|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[progress,setProgress]=useState<number|null>(null);
 const [creating,setCreating]=useState(false),[name,setName]=useState(''),[composing,setComposing]=useState(false),composition=useRef(false),current=useRef<FilesContext|null>(null),input=useRef<HTMLInputElement>(null);
 const active=(context:FilesContext)=>current.current===context;
 const context=()=>{const value=current.current;return value&&value.id===id&&value.zone===zone&&value.folder===folder?value:null;};
 async function list(value:FilesContext,cursor?:string){
  const response=await request<TransferFilePage>(`/environments/${value.id}/transfer-files?directory=1&zone=${value.zone}&path=${encodeURIComponent(value.folder)}${cursor?'&cursor='+encodeURIComponent(cursor):''}`,{signal:value.abort.signal});
  if(active(value))setPage(old=>cursor&&old?{...response,files:[...old.files,...response.files]}:response);
 }
 async function reload(value:FilesContext,cursor?:string){setBusy(true);setError('');try{await list(value,cursor);}catch(e){if(active(value))setError((e as Error).message);}finally{if(active(value))setBusy(false);}}
 useEffect(()=>{
  const value:FilesContext={id,zone,folder,abort:new AbortController(),scope:Symbol()};current.current=value;
  setPage(null);setMessage('');setProgress(null);setCreating(false);setName('');setComposing(false);composition.current=false;void reload(value);
  return()=>{value.abort.abort();if(current.current?.scope===value.scope){current.current.abort.abort();current.current=null;}};
 },[id,zone,folder]);
 async function upload(file:File){
  const value=context();if(!value)return;
  if(file.size>TRANSFER_MAX_BYTES){setError('单个文件最多150 MiB');return;}setBusy(true);setError('');setMessage('');setProgress(0);
  try{const saved=await uploadGuestFile(value.id,file,(sent,total)=>{if(active(value))setProgress(total?Math.round(sent/total*100):100);},value.abort.signal);if(active(value)){setMessage(`已保存到 ${saved.path}`);if(value.zone==='downloads'&&!value.folder)await list(value);}}
  catch(e){if(active(value))setError((e as Error).message);}finally{if(active(value)){setBusy(false);setProgress(null);}}
 }
 function cancelUpload(){const value=context();if(!value)return;value.abort.abort();const next={...value,abort:new AbortController()};current.current=next;setProgress(null);setMessage('传输已取消，已保存的文件会保留');void reload(next);}
 async function download(file:TransferFile){
  const value=context();if(!value)return;setBusy(true);setError('');setMessage('');
  try{const response=await fetch(`/api/environments/${value.id}/transfer-download`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+window.__MU_CONFIG__.token},body:JSON.stringify({zone:file.zone,name:file.name,path:value.folder,revision:file.revision}),signal:value.abort.signal});
   if(!response.ok)throw Error((await response.json()).error??'下载失败');const blob=await response.blob();if(!active(value))return;
   const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=file.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),10000);setMessage('文件已交给本机浏览器下载');
  }catch(e){if(active(value))setError((e as Error).message);}finally{if(active(value))setBusy(false);}
 }
 async function createDirectory(){
  const value=context();if(!value||!canCreateDirectories||busy||composition.current)return;
  const issue=windowsDirectoryNameIssue(name);if(issue){setError(issue);return;}setBusy(true);setError('');setMessage('');
  try{const saved=await request<WindowsTransferDirectory>(`/environments/${value.id}/transfer-directories`,{method:'POST',body:JSON.stringify({zone:value.zone,path:value.folder,name}),signal:value.abort.signal});if(active(value)){setMessage(`已创建 ${saved.path}`);setCreating(false);setName('');await list(value);}}
  catch(e){if(active(value))setError((e as Error).message);}finally{if(active(value))setBusy(false);}
 }
 const nameIssue=windowsDirectoryNameIssue(name);
 return <section>
  <SectionHeading title="文件传输" subtitle="上传到客体下载目录；每个文件最多150 MiB。" action={<div className="button-row"><Button disabled={busy||creating} onClick={()=>input.current?.click()} icon={<ArrowUpToLine size={15}/>}>上传文件</Button>{canCreateDirectories&&<Button disabled={busy||creating} onClick={()=>{setCreating(true);setError('');}} icon={<FolderPlus size={15}/>}>新建文件夹</Button>}<Button disabled={busy} aria-label="刷新文件" onClick={()=>{const value=context();if(value)void reload(value);}} icon={<RefreshCw size={15}/>}/></div>}/>
  <input hidden type="file" ref={input} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void upload(file);}}/>
  <div className="button-row">{(['downloads','incoming','outgoing'] as const).map(value=><Button key={value} disabled={busy} className={zone===value?'primary':''} onClick={()=>{setZone(value);setFolder('');}}>{({downloads:'下载',incoming:'传入',outgoing:'导出'})[value]}</Button>)}<Button disabled={busy||!folder} onClick={()=>setFolder(folder.split('/').slice(0,-1).join('/'))}>上一级</Button></div>
  <p className="mono path-text">{TRANSFER_FOLDERS[zone]}{folder?'/'+folder:''}</p>
  {error&&<Notice kind="error">{error}</Notice>}{message&&<Notice kind="success">{message}</Notice>}
  {creating&&canCreateDirectories&&<form onSubmit={event=>{event.preventDefault();void createDirectory();}} onKeyDown={event=>{if(event.key==='Enter'&&(composition.current||event.nativeEvent.isComposing||event.keyCode===229)){event.preventDefault();event.stopPropagation();}}}>
   <Field label="文件夹名称" hint={name?nameIssue??undefined:undefined}><input autoFocus value={name} disabled={busy} onChange={event=>setName(event.target.value)} onCompositionStart={()=>{composition.current=true;setComposing(true);}} onCompositionEnd={()=>{composition.current=false;setComposing(false);}}/></Field>
   <div className="button-row"><Button type="submit" disabled={busy||composing||!!nameIssue} loading={busy}>创建文件夹</Button><Button disabled={busy} onClick={()=>{setCreating(false);composition.current=false;setComposing(false);}}>取消</Button></div>
  </form>}
  {progress!==null&&<div role="status">{progress===100?'上传完成，正在确认客体保存…':`上传 ${progress}%`}<progress value={progress} max={100}/><Button onClick={cancelUpload}>取消传输</Button></div>}
  {page?.files.map(file=><div className="windows-file-row" key={file.name}>{file.kind==='directory'?<Button disabled={busy} icon={<Folder size={16}/>} onClick={()=>setFolder(file.relativePath??[folder,file.name].filter(Boolean).join('/'))}>{file.name}</Button>:<><span>{file.name}</span><small>{file.bytes<1024?`${file.bytes} B`:`${(file.bytes/1024).toFixed(1)} KiB`}</small><Button disabled={busy} aria-label={`下载 ${file.name}`} icon={<ArrowDownToLine size={15}/>} onClick={()=>void download(file)}>下载</Button></>}</div>)}
  {page&&!page.files.length&&<p>此文件夹暂无可传输文件</p>}{page?.nextCursor&&<Button disabled={busy} onClick={()=>{const value=context();if(value)void reload(value,page.nextCursor!);}}>加载更多</Button>}
 </section>;
}
