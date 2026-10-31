import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,ArrowUpToLine,Copy,Folder,FolderPlus,RefreshCw} from 'lucide-react';
import {Button,Field,Notice,SectionHeading} from '../components.tsx';
import {request} from '../api.ts';
import {uploadGuestFile} from '../file-upload.ts';
import {TRANSFER_MAX_BYTES,TRANSFER_FOLDERS,type TransferFile,type TransferFilePage,type TransferZone} from '../../shared/guest-exchange.ts';
import {windowsDirectoryNameIssue,type WindowsTransferDirectory} from '../../shared/windows-files.ts';
import type {Environment} from '../../shared/types.ts';
import {windowsHostClipboard} from './clipboard-text.ts';
const FileViewer=lazy(()=>import('./WindowsBrowserView.tsx'));
const modifiedTime=(value:string)=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{hour12:false}):'时间未知';

interface FilesContext {id:string;zone:TransferZone;folder:string;abort:AbortController;scope:symbol}
export default function WindowsFilesPanel({id,environment,independentView=false,canCreateDirectories=false,canOpenFolder=false,viewerReady=false,onShowFolder,onUploadInterrupted}:{id:string;environment?:Environment;independentView?:boolean;canCreateDirectories?:boolean;canOpenFolder?:boolean;viewerReady?:boolean;onShowFolder?:()=>void;onUploadInterrupted?:()=>void}){
 const [zone,setZone]=useState<TransferZone>('downloads'),[folder,setFolder]=useState(''),[page,setPage]=useState<TransferFilePage|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[progress,setProgress]=useState<number|null>(null);
 const [creating,setCreating]=useState(false),[name,setName]=useState(''),[composing,setComposing]=useState(false),[uploadConfirmed,setUploadConfirmed]=useState(false),composition=useRef(false),current=useRef<FilesContext|null>(null),input=useRef<HTMLInputElement>(null);
 const [viewId,setViewId]=useState<string|null>(null),view=useRef<string|null>(null),mounted=useRef(false);
 const uploadPending=useRef<FilesContext|null>(null),interrupted=useRef(onUploadInterrupted);interrupted.current=onUploadInterrupted;
 const [listedAt,setListedAt]=useState('');
 const [readOperation,setReadOperation]=useState<'list'|'download'|null>(null);
 const standalone=independentView&&!!environment;
 const clipboardReady=viewerReady||standalone&&!!viewId;
 const closeView=(token:string)=>request(`/environments/${id}/transfer-folder/close`,{method:'POST',body:JSON.stringify({viewId:token}),keepalive:true});
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;const token=view.current;view.current=null;if(token)void closeView(token).catch(()=>{});};},[id]);
 const active=(context:FilesContext)=>current.current===context;
 const context=()=>{const value=current.current;return value&&value.id===id&&value.zone===zone&&value.folder===folder?value:null;};
 async function list(value:FilesContext,cursor?:string){
  const response=await request<TransferFilePage>(`/environments/${value.id}/transfer-files?directory=1&zone=${value.zone}&path=${encodeURIComponent(value.folder)}${cursor?'&cursor='+encodeURIComponent(cursor):''}`,{signal:value.abort.signal});
  if(active(value)){setPage(old=>cursor&&old?{...response,files:[...old.files,...response.files]}:response);setListedAt(new Date().toISOString());}
 }
 async function reload(value:FilesContext,cursor?:string){setBusy(true);setReadOperation('list');setError('');try{await list(value,cursor);}catch(e){if(active(value))setError((e as Error).message);}finally{if(active(value)){setBusy(false);setReadOperation(null);}}}
 function cancelRead(){
  const value=context();if(!value||!readOperation)return;
  current.current={...value,abort:new AbortController()};value.abort.abort();
  setBusy(false);setReadOperation(null);setError('');
  setMessage(readOperation==='download'?'已取消下载，可重新选择文件下载。':'已取消读取，可点击刷新重试。');
 }
 useEffect(()=>{
  const value:FilesContext={id,zone,folder,abort:new AbortController(),scope:Symbol()};current.current=value;
  setPage(null);setListedAt('');setMessage('');setProgress(null);setUploadConfirmed(false);setCreating(false);setName('');setComposing(false);composition.current=false;void reload(value);
  return()=>{if(uploadPending.current?.scope===value.scope){uploadPending.current=null;interrupted.current?.();}value.abort.abort();if(current.current?.scope===value.scope){current.current.abort.abort();current.current=null;}};
 },[id,zone,folder]);
 async function upload(file:File){
  const value=context();if(!value)return;
  if(file.size>TRANSFER_MAX_BYTES){setError('单个文件最多150 MiB');return;}uploadPending.current=value;setBusy(true);setError('');setMessage('');setProgress(0);setUploadConfirmed(false);
  try{const saved=await uploadGuestFile(value.id,file,(sent,total)=>{if(active(value))setProgress(total?Math.round(sent/total*100):100);},value.abort.signal);if(uploadPending.current===value)uploadPending.current=null;if(active(value)){setUploadConfirmed(true);setMessage(`已保存到 ${saved.path}`);if(value.zone==='downloads'&&!value.folder)await list(value);}}
  catch(e){if(active(value))setError((e as Error).message);}finally{if(uploadPending.current===value)uploadPending.current=null;if(active(value)){setBusy(false);setProgress(null);setUploadConfirmed(false);}}
 }
 function cancelUpload(){const value=context();if(!value)return;if(uploadPending.current===value)uploadPending.current=null;value.abort.abort();const next={...value,abort:new AbortController()};current.current=next;setProgress(null);setMessage(uploadConfirmed?'文件已保存，正在重新读取文件列表':'已请求取消传输，保存结果尚未确认；请刷新下载目录后再决定是否重试。');setUploadConfirmed(false);void reload(next);}
 async function download(file:TransferFile){
  const value=context();if(!value)return;setBusy(true);setReadOperation('download');setError('');setMessage('');
  try{const response=await fetch(`/api/environments/${value.id}/transfer-download`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+window.__MU_CONFIG__.token},body:JSON.stringify({zone:file.zone,name:file.name,path:value.folder,revision:file.revision}),signal:value.abort.signal});
   if(!response.ok)throw Error((await response.json()).error??'下载失败');const blob=await response.blob();if(!active(value))return;
   const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=file.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),10000);setMessage('文件已交给本机浏览器下载');
  }catch(e){if(active(value))setError((e as Error).message);}finally{if(active(value)){setBusy(false);setReadOperation(null);}}
 }
 async function createDirectory(){
  const value=context();if(!value||!canCreateDirectories||busy||composition.current)return;
  const issue=windowsDirectoryNameIssue(name);if(issue){setError(issue);return;}setBusy(true);setError('');setMessage('');
  try{const saved=await request<WindowsTransferDirectory>(`/environments/${value.id}/transfer-directories`,{method:'POST',body:JSON.stringify({zone:value.zone,path:value.folder,name}),signal:value.abort.signal});if(active(value)){setMessage(`已创建 ${saved.path}`);setCreating(false);setName('');await list(value);}}
  catch(e){if(active(value))setError((e as Error).message);}finally{if(active(value))setBusy(false);}
 }
 async function openFolder(){
  const value=context();if(!value||!canOpenFolder||!standalone&&!viewerReady||busy)return;setBusy(true);setError('');setMessage('');
  // Let an independent opening settle even if this panel unmounts, then close
  // its returned capability. Aborting the response could lose that capability.
  try{const result=await request<{viewId?:string}>(`/environments/${value.id}/transfer-folder/open`,{method:'POST',body:JSON.stringify({zone:value.zone,path:value.folder}),...(standalone?{}:{signal:value.abort.signal})});
   if(standalone){if(!result.viewId)throw Error('文件画面未返回关闭凭据，请重新打开');if(!mounted.current||!active(value)){await closeView(result.viewId);return;}view.current=result.viewId;setViewId(result.viewId);}
   if(active(value)){setMessage('已在沙箱画面中打开文件夹');if(!standalone)onShowFolder?.();}}
  catch(e){if(active(value))setError((e as Error).message);}finally{if(active(value))setBusy(false);}
 }
 async function closeFolder(){const token=view.current;if(!token||busy)return;setBusy(true);setError('');try{await closeView(token);if(mounted.current&&view.current===token){view.current=null;setViewId(null);setMessage('文件画面已关闭');}}catch(e){if(mounted.current)setError((e as Error).message);}finally{if(mounted.current)setBusy(false);}}
 async function copyPath(path:string,guest=false){
  const value=context();if(!value||busy||guest&&!clipboardReady)return;setBusy(true);setError('');setMessage('');
  try{
   if(guest)await request(`/environments/${value.id}/clipboard/write`,{method:'POST',body:JSON.stringify({text:path}),signal:value.abort.signal});
   else await windowsHostClipboard.writeText(path);
   if(active(value))setMessage(guest?'路径已放入沙箱剪贴板。在 Linux 文件选择框按 Ctrl+L、Ctrl+V 定位；不会自动上传或发送。':'Linux 路径已复制到 Windows；这个路径仅在当前沙箱内有效。');
  }catch(e){if(active(value))setError((e as Error).message);}finally{if(active(value))setBusy(false);}
 }
 const nameIssue=windowsDirectoryNameIssue(name);
 return <section>
  <SectionHeading title="文件传输" subtitle="上传到客体下载目录；每个文件最多150 MiB。" action={<div className="button-row"><Button disabled={busy||creating} onClick={()=>input.current?.click()} icon={<ArrowUpToLine size={15}/>}>上传文件</Button>{canCreateDirectories&&<Button disabled={busy||creating} onClick={()=>{setCreating(true);setError('');}} icon={<FolderPlus size={15}/>}>新建文件夹</Button>}<Button disabled={busy} aria-label="刷新文件" onClick={()=>{const value=context();if(value)void reload(value);}} icon={<RefreshCw size={15}/>}/></div>}/>
  <input hidden type="file" ref={input} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void upload(file);}}/>
  <div className="button-row">{(['downloads','incoming','outgoing'] as const).map(value=><Button key={value} disabled={busy} className={zone===value?'primary':''} onClick={()=>{setZone(value);setFolder('');}}>{({downloads:'下载',incoming:'传入',outgoing:'导出'})[value]}</Button>)}<Button disabled={busy||!folder} onClick={()=>setFolder(folder.split('/').slice(0,-1).join('/'))}>上一级</Button></div>
  <p className="mono path-text">{TRANSFER_FOLDERS[zone]}{folder?'/'+folder:''}</p>
  {canOpenFolder&&<div className="button-row"><Button disabled={busy||creating||!standalone&&!viewerReady} title={standalone||viewerReady?'在软件的沙箱画面中浏览、移动和重命名文件':'请先打开浏览器画面'} icon={<Folder size={15}/>} onClick={()=>void openFolder()}>在沙箱中打开文件夹</Button>{!standalone&&!viewerReady&&<small>请先打开浏览器画面</small>}{standalone&&viewId&&<Button disabled={busy} onClick={()=>void closeFolder()}>关闭文件画面</Button>}</div>}
  {error&&<Notice kind="error">{error}</Notice>}{message&&<Notice kind={message.startsWith('已请求取消传输')||message.startsWith('已取消')?'info':'success'}>{message}</Notice>}
  {busy&&progress===null&&<p role="status">{readOperation==='download'?'正在从沙箱下载文件…':page?'正在处理沙箱文件操作…':'正在读取沙箱文件列表…'}{readOperation&&<Button onClick={cancelRead}>{readOperation==='download'?'取消下载':'取消读取'}</Button>}</p>}
  {creating&&canCreateDirectories&&<form onSubmit={event=>{event.preventDefault();void createDirectory();}} onKeyDown={event=>{if(event.key==='Enter'&&(composition.current||event.nativeEvent.isComposing||event.keyCode===229)){event.preventDefault();event.stopPropagation();}}}>
   <Field label="文件夹名称" hint={name?nameIssue??undefined:undefined}><input autoFocus value={name} disabled={busy} onChange={event=>setName(event.target.value)} onCompositionStart={()=>{composition.current=true;setComposing(true);}} onCompositionEnd={()=>{composition.current=false;setComposing(false);}}/></Field>
   <div className="button-row"><Button type="submit" disabled={busy||composing||!!nameIssue} loading={busy}>创建文件夹</Button><Button disabled={busy} onClick={()=>{setCreating(false);composition.current=false;setComposing(false);}}>取消</Button></div>
  </form>}
  {progress!==null&&<div role="status">{uploadConfirmed?'文件已保存，正在刷新沙箱文件列表…':progress===100?'上传完成，正在确认客体保存…':`上传 ${progress}%`}{!uploadConfirmed&&<progress value={progress} max={100}/>}<Button onClick={cancelUpload}>{uploadConfirmed?'重新读取列表':'取消传输'}</Button></div>}
  {page&&<p className="muted">已显示 {page.files.length} / {page.total} 项 · 修改时间按 Windows 本地时间显示{listedAt&&<> · 读取于 <time dateTime={listedAt}>{new Date(listedAt).toLocaleTimeString()}</time></>}</p>}
  <div className="windows-transfer-list">{page?.files.map(file=><div className="windows-file-row" key={file.name}>
   <div className="windows-file-details">{file.kind==='directory'?<Button disabled={busy} icon={<Folder size={16}/>} onClick={()=>setFolder(file.relativePath??[folder,file.name].filter(Boolean).join('/'))}>{file.name}</Button>:<strong>{file.name}</strong>}
    <small>{file.kind==='directory'?'文件夹':file.bytes<1024?`${file.bytes} B`:file.bytes<1024*1024?`${(file.bytes/1024).toFixed(1)} KiB`:`${(file.bytes/(1024*1024)).toFixed(1)} MiB`} · 修改于 <time dateTime={Number.isFinite(Date.parse(file.modifiedAt))?file.modifiedAt:undefined}>{modifiedTime(file.modifiedAt)}</time></small>
   </div>
   {file.kind!=='directory'&&<Button disabled={busy} aria-label={`下载 ${file.name}`} icon={<ArrowDownToLine size={15}/>} onClick={()=>void download(file)}>下载到 Windows</Button>}
   <div className="button-row windows-file-actions">{canOpenFolder&&<Button disabled={busy||creating||!standalone&&!viewerReady} onClick={()=>void openFolder()}>打开所在文件夹</Button>}<Button disabled={busy||!clipboardReady} title={clipboardReady?'复制 Linux 路径，不会自动上传文件':'请先打开浏览器或文件画面'} onClick={()=>void copyPath(file.path,true)}>复制路径到沙箱</Button><Button disabled={busy} icon={<Copy size={15}/>} onClick={()=>void copyPath(file.path)}>复制路径</Button></div>
  </div>)}</div>
  {page&&!busy&&!page.files.length&&<p>此文件夹暂无可传输文件</p>}{page?.nextCursor&&<Button disabled={busy} onClick={()=>{const value=context();if(value)void reload(value,page.nextCursor!);}}>加载更多</Button>}
  <details className="guest-transfer-help"><summary>上传、路径与保存说明</summary>
   <ol><li>选择 Windows 文件，等待提示已保存到沙箱“下载”目录。</li><li>返回网页点“上传 / 附件”，在 Linux 文件选择框中进入“下载 / Downloads”选择文件。</li><li>需要定位文件时，点“复制路径到沙箱”，在 Linux 文件选择框按 <kbd>Ctrl+L</kbd>、<kbd>Ctrl+V</kbd>；由你确认选择，不会自动发送。</li></ol>
   <p>这是 Linux 文件选择框；Windows 的桌面和下载目录不会自动出现在里面。</p>
   <div className="button-row"><Button disabled={busy||!clipboardReady} onClick={()=>void copyPath(TRANSFER_FOLDERS.incoming,true)}>使用传入文件夹路径</Button><Button disabled={busy||!clipboardReady} onClick={()=>void copyPath(TRANSFER_FOLDERS.downloads,true)}>使用下载文件夹路径</Button></div>
   {!clipboardReady&&<p>复制到沙箱剪贴板前，请先打开浏览器或文件画面。复制到 Windows 不需要打开画面。</p>}
   <p>新上传默认保存到 <code>{TRANSFER_FOLDERS.downloads}</code>。导出文件可保存到“下载”或 <code>{TRANSFER_FOLDERS.outgoing}</code> 及其子文件夹，完成后刷新列表；修改时间不一定是导出时间，正在下载的临时文件不显示。</p>
   <p>文件保存在当前虚拟机磁盘内，正常停止和重启会保留；重建或删除环境会清除。Windows 原文件保留。持续共享目录尚未提供。</p>
  </details>
  {standalone&&viewId&&environment&&<Suspense fallback={<p>加载文件画面…</p>}><FileViewer key={viewId} environment={environment} title="Linux 文件" showNavigation={false}/></Suspense>}
 </section>;
}
