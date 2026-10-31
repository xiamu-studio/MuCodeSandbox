import {useEffect,useRef,useState,type RefObject} from 'react';
import {ArrowDownToLine,ArrowUpToLine,Copy,Folder,FolderInput,Image,RefreshCw} from 'lucide-react';
import {Button,Modal,Notice} from './components.tsx';
import {request,ApiError} from './api.ts';
import {TRANSFER_MAX_BYTES,TRANSFER_FOLDERS,type TransferFile,type TransferFilePage,type TransferZone,type SavedTransferFile,type SharedTransferDirectory} from '../shared/guest-exchange.ts';
import {readMacClipboardImage,imageClipboardBlob,writeGuestClipboardImage} from './clipboard-image.ts';
import {uploadGuestFile} from './file-upload.ts';
import {quoteTerminalPath} from './terminal-input.ts';
import {windowsHostClipboard} from './windows/clipboard-text.ts';
import {readWindowsClipboardImage} from './windows/clipboard-image.ts';

type UploadedFile=SavedTransferFile;
const folderLabels:Record<TransferZone,string>={downloads:'下载',outgoing:'导出',incoming:'传入'};
const modifiedTime=(value:string)=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{hour12:false}):'时间未知';
type FolderLocation={zone:TransferZone;path:string};
type FolderSnapshot={files:Map<string,string>;complete:boolean};
const fileSize=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KiB`:`${(bytes/(1024*1024)).toFixed(1)} MiB`;
export default function GuestExchangePanel({id,connected,active=true,dropTarget,onReturn,onPasteText,onReadText}:{id:string;connected:boolean;active?:boolean;dropTarget?:RefObject<HTMLDivElement|null>;onReturn?:()=>void;onPasteText?:(text:string)=>Promise<void>;onReadText?:()=>Promise<string>}){
 const windows=window.__MU_CONFIG__?.platform==='win32',hostName=windows?'Windows':'Mac',pasteShortcut=windows?'Ctrl+V':'⌘V';
 const writeHostText=windows?windowsHostClipboard.writeText:(value:string)=>navigator.clipboard.writeText(value);
 const [open,setOpen]=useState(false),[tab,setTab]=useState<'text'|'files'|'image'>('files'),[text,setText]=useState(''),[received,setReceived]=useState(''),[files,setFiles]=useState<TransferFile[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const picker=useRef<HTMLInputElement>(null),working=useRef(false),uploadAbort=useRef<AbortController|null>(null);
 const [uploadProgress,setUploadProgress]=useState<{sent:number;total:number}|null>(null),[projects,setProjects]=useState<SharedTransferDirectory[]|null>(null),[showProjects,setShowProjects]=useState(false);
 const [dragging,setDragging]=useState(false),[uploaded,setUploaded]=useState<UploadedFile[]>([]),[progress,setProgress]=useState('');
 const [listState,setListState]=useState<'idle'|'loading'|'ready'|'error'>('idle'),[nextCursor,setNextCursor]=useState<string|null>(null),[fileTotal,setFileTotal]=useState<number|null>(null);
 const [location,setLocation]=useState<FolderLocation>({zone:'downloads',path:''}),[listedAt,setListedAt]=useState(''),[changes,setChanges]=useState<Record<string,string>>({});
 const folderSnapshots=useRef(new Map<string,FolderSnapshot>()),comparison=useRef<FolderSnapshot|undefined>(undefined);
 const [listBusy,setListBusy]=useState(false);
 const listWorking=useRef(false),listGeneration=useRef(0),listAbort=useRef<AbortController|null>(null),panelOpen=useRef(false);
 const networkBusy=busy||listBusy;
 const queueRevision=useRef(0);
 const available=useRef(active&&connected);available.current=active&&connected;
 useEffect(()=>{
  available.current=active&&connected;
  // An in-flight file can finish after this view is removed. Do not start
  // another file in its queue after an environment switch or view teardown.
  return()=>{available.current=false;queueRevision.current++;listGeneration.current++;uploadAbort.current?.abort();listAbort.current?.abort();};
 },[id,active,connected]);
 useEffect(()=>{
  const target=dropTarget?.current;if(!target||!active)return;
  let depth=0;
  const hasFiles=(event:DragEvent)=>Array.from(event.dataTransfer?.types??[]).includes('Files');
  const enter=(event:DragEvent)=>{if(!hasFiles(event))return;event.preventDefault();depth++;setDragging(true);};
  const over=(event:DragEvent)=>{if(!hasFiles(event))return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect=connected&&!working.current&&!listWorking.current?'copy':'none';};
  const leave=(event:DragEvent)=>{if(!hasFiles(event))return;if(--depth<=0){depth=0;setDragging(false);}};
  const drop=(event:DragEvent)=>{if(!hasFiles(event))return;event.preventDefault();event.stopPropagation();depth=0;setDragging(false);if(event.dataTransfer)acceptDrop(event.dataTransfer);};
  const end=()=>{depth=0;setDragging(false);};
  target.addEventListener('dragenter',enter);target.addEventListener('dragover',over);target.addEventListener('dragleave',leave);target.addEventListener('drop',drop,true);window.addEventListener('dragend',end);
  return()=>{target.removeEventListener('dragenter',enter);target.removeEventListener('dragover',over);target.removeEventListener('dragleave',leave);target.removeEventListener('drop',drop,true);window.removeEventListener('dragend',end);};
 },[dropTarget,active,connected,id]);
 function show(){panelOpen.current=true;setOpen(true);}
 function acceptDrop(data:DataTransfer){
  if(working.current)return;
  show();setTab('files');
  if(listWorking.current){setError('正在读取沙箱文件，请稍后再传入。');return;}
  if(!available.current){setError('沙箱画面尚未连接，请连接后重新拖入文件。');return;}
  if(Array.from(data.items??[]).some(item=>item.webkitGetAsEntry?.()?.isDirectory)){setError('暂不支持拖入文件夹。请先压缩为文件，或使用“项目目录”。');return;}
  if(!data.files.length){setError('没有取得可传输文件，请使用“选择文件上传”。');return;}
  void upload(Array.from(data.files));
 }

 async function task(work:()=>Promise<void>,label='正在传输文件…',local=false){if(working.current||(!local&&listWorking.current))return;working.current=true;setBusy(true);setProgress(label);setError('');setMessage('');try{await work();}catch(e){setError((e as Error).message);}finally{working.current=false;setBusy(false);setProgress('');}}
 async function refresh(more=false,destination=location){
  if(working.current||listWorking.current||!available.current)return;
  const generation=++listGeneration.current,folderKey=destination.zone+'/'+destination.path;
  if(!more)comparison.current=folderSnapshots.current.get(folderKey);
  if(destination.zone!==location.zone||destination.path!==location.path){setLocation(destination);setFiles([]);setFileTotal(null);setNextCursor(null);setListedAt('');setChanges({});}
  const abort=new AbortController();listAbort.current=abort;listWorking.current=true;setListBusy(true);setListState('loading');setError('');
  try{
   const page=await request<TransferFilePage>(`/environments/${id}/transfer-files?paged=1&directory=1&zone=${destination.zone}&path=${encodeURIComponent(destination.path)}${more&&nextCursor?'&cursor='+encodeURIComponent(nextCursor):''}`,windows?{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(20000)])}:{});
   if(generation!==listGeneration.current||!available.current||!panelOpen.current)return;
   setFiles(current=>more?[...new Map([...current,...page.files].map(file=>[`${file.zone}/${file.name}`,file])).values()]:page.files);
   const previous=comparison.current,updated:Record<string,string>={};
   for(const file of page.files){if(file.kind==='directory')continue;const fingerprint=file.revision??`${file.bytes}|${file.modifiedAt}`,old=previous?.files.get(file.name);if(old&&old!==fingerprint)updated[file.path]='已更新';else if(previous?.complete&&!old)updated[file.path]='新增';}
   const known=more?new Map(folderSnapshots.current.get(folderKey)?.files):new Map<string,string>();
   for(const file of page.files)known.set(file.name,file.revision??`${file.bytes}|${file.modifiedAt}`);
   folderSnapshots.current.set(folderKey,{files:known,complete:!page.nextCursor});setChanges(current=>more?{...current,...updated}:updated);
   setListedAt(new Date().toLocaleTimeString('zh-CN',{hour12:false}));setFileTotal(page.total);setNextCursor(page.nextCursor);setListState('ready');
  }catch(e){if(generation===listGeneration.current&&available.current&&panelOpen.current){setListState('error');setError(e instanceof DOMException&&e.name==='TimeoutError'?'读取沙箱文件列表超时，请重新刷新。':(e as Error).message);}}
  finally{if(listAbort.current===abort){listAbort.current=null;listWorking.current=false;setListBusy(false);if(generation!==listGeneration.current)setListState(current=>current==='loading'?'idle':current);}}
 }
 async function check(response:Response){if(!response.ok){const result=await response.json();throw new ApiError(result.error??'传输失败',response.status,result.code??'TRANSFER_FAILED');}return response;}
 async function upload(list:FileList|File[]){let complete=false;
  await task(async()=>{
   const selected=Array.from(list);if(!selected.length)return;const revision=queueRevision.current;
   const tooLarge=selected.find(file=>file.size>TRANSFER_MAX_BYTES);
   if(tooLarge)throw new Error(`${tooLarge.name} 超过150 MiB，本批尚未上传。`);
   setUploaded([]);setShowProjects(false);let completed=0;
   try{for(const file of selected){
    if(!available.current||revision!==queueRevision.current)throw new Error(`已传入 ${completed} 个文件；沙箱已断开或离开当前画面，剩余文件未上传。`);
    const controller=new AbortController();uploadAbort.current=controller;setUploadProgress({sent:0,total:file.size});setProgress(`正在传入 ${completed+1} / ${selected.length}：${file.name}`);
    try{
     const saved=await uploadGuestFile(id,file,(sent,total)=>{if(!available.current||revision!==queueRevision.current)return;setUploadProgress({sent,total});if(sent>=total)setProgress(`数据已传完，正在确认沙箱保存：${file.name}`);},controller.signal);
     if(!available.current||revision!==queueRevision.current)throw new Error('画面已变化，请重新连接后查看下载目录。');
     setUploaded(current=>[...current,saved]);completed++;setLocation({zone:'downloads',path:''});setFiles([]);setFileTotal(null);setNextCursor(null);setListState('idle');setListedAt('');setChanges({});
    }catch(e){throw new Error(`已传入 ${completed} 个文件；${file.name} 尚未确认保存：${(e as Error).message} 其余文件未上传。`);}
   }}finally{uploadAbort.current=null;setUploadProgress(null);}
   setMessage(`已保存 ${completed} 个文件到沙箱“下载”目录，可直接在 Linux 文件选择框中选择。`);complete=true;
  });
  if(complete&&available.current&&panelOpen.current)void refresh(false,{zone:'downloads',path:''});
 }
 async function sendClipboardImage(source?:Blob){
  if(!available.current||working.current||listWorking.current)return;
  const revision=queueRevision.current;
  await task(async()=>{
   const image=source?await imageClipboardBlob(source):await (windows?readWindowsClipboardImage():readMacClipboardImage());
   if(!available.current||revision!==queueRevision.current)return;
   await writeGuestClipboardImage(id,image);
   if(!available.current||revision!==queueRevision.current)return;
   setMessage(onPasteText?'图片已放入 Linux 剪贴板。CLI 是否支持 Ctrl+V 贴图取决于客户端；不会向终端发送二进制内容。':'图片已放入沙箱剪贴板。返回网页或客户端，在支持图片粘贴的输入框按 Ctrl+V；不会自动发送。');
  },'正在把剪贴板图片传到沙箱…');
 }
 async function copyGuestPath(path:string){await task(async()=>{
  if(onPasteText){await onPasteText(quoteTerminalPath(path));setMessage('路径已粘贴到当前终端，未执行。');return;}
  await request(`/environments/${id}/clipboard/write`,{method:'POST',body:JSON.stringify({text:path})});
  setMessage('路径已放入沙箱剪贴板。返回网页点“上传 / 附件”，在弹出的文件选择框按 Ctrl+L、Ctrl+V，再按回车。');
 },onPasteText?'正在粘贴路径到终端…':'正在把路径复制到沙箱…');}
 async function openFolder(input:{zone?:TransferZone;path?:string;projectId?:string}){let opened=false;await task(async()=>{await request(`/environments/${id}/transfer-folder/open`,{method:'POST',body:JSON.stringify(input)});opened=true;},'正在打开沙箱文件夹…');if(opened)close();}
 async function loadProjects(){setShowProjects(true);await task(async()=>{setProjects(await request<SharedTransferDirectory[]>(`/environments/${id}/transfer-projects`));},'正在读取已共享项目目录…');}
 async function move(file:TransferFile){let moved=false;await task(async()=>{const saved=await request<SavedTransferFile>(`/environments/${id}/transfer-move`,{method:'POST',body:JSON.stringify({zone:file.zone,name:file.name,path:file.relativePath?.split('/').slice(0,-1).join('/')??'',...(file.revision?{revision:file.revision}:{})})});setUploaded(current=>[...current,saved]);setLocation({zone:'downloads',path:''});setShowProjects(false);setMessage('文件已移到沙箱下载目录，原有同名文件未覆盖。');moved=true;},'正在移到下载目录…');if(moved&&available.current&&panelOpen.current)void refresh(false,{zone:'downloads',path:''});}
 function fileActions(file:{name:string;path:string;zone?:TransferZone;relativePath?:string;revision?:string}){return <div className="guest-transfer-actions"><Button disabled={networkBusy||!connected} onClick={()=>void openFolder({zone:file.zone??'downloads',path:file.relativePath?.split('/').slice(0,-1).join('/')??''})}>打开所在文件夹</Button>{file.zone&&file.zone!=='downloads'&&<Button disabled={networkBusy||!connected} onClick={()=>void move(file as TransferFile)}>移到下载目录</Button>}<Button disabled={networkBusy||!connected} onClick={()=>void copyGuestPath(file.path)}>{onPasteText?'粘贴路径到终端':'复制路径到沙箱'}</Button><Button icon={<Copy size={15}/>} disabled={busy} onClick={()=>void task(async()=>{await writeHostText(file.path);setMessage(`Linux 路径已复制到 ${hostName}；这个路径仅在当前沙箱内有效。`);},'正在复制路径…',true)}>复制路径</Button></div>;}
 async function download(file:TransferFile){await task(async()=>{
  const response=await check(await fetch(`/api/environments/${id}/transfer-download`,{method:'POST',headers:{Authorization:`Bearer ${window.__MU_CONFIG__.token}`,'Content-Type':'application/json'},body:JSON.stringify({zone:file.zone,name:file.name,path:file.relativePath?.split('/').slice(0,-1).join('/')??'',...(file.revision?{revision:file.revision}:{})})}));
  const url=URL.createObjectURL(await response.blob());const a=document.createElement('a');a.href=url;a.download=file.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setMessage(`已交给 ${hostName} 保存文件。`);
 },`正在下载文件到 ${hostName}…`);}
 function close(){if(working.current)return;panelOpen.current=false;listGeneration.current++;listAbort.current?.abort();setOpen(false);setText('');setReceived('');setError('');setMessage('');setFiles([]);setUploaded([]);setListState('idle');setNextCursor(null);setFileTotal(null);setListedAt('');setChanges({});folderSnapshots.current.clear();comparison.current=undefined;setShowProjects(false);setProjects(null);setUploadProgress(null);onReturn?.();}
 return <><button className="button guest-exchange-button" type="button" disabled={!connected} onClick={show} title="文件与复制粘贴"><FolderInput size={16}/><span>文件与粘贴</span></button>{dragging&&active&&<div className="guest-file-drop-overlay" role="status"><FolderInput size={36}/><strong>{connected&&!networkBusy?'松开即可传入当前沙箱':'请先连接沙箱，并等待当前传输完成'}</strong><span>文件保存在沙箱内，由你选择是否上传给网站</span></div>}{open&&active&&<Modal title="文件与复制粘贴" subtitle="只传输你选择的文件和文字" onClose={close}>
  <div className="modal-body guest-exchange-body" onPaste={event=>{if(tab==='text')return;const image=Array.from(event.clipboardData.files).find(file=>file.type.startsWith('image/'));if(image){event.preventDefault();void sendClipboardImage(image);}}}>
   <div className="segmented guest-exchange-tabs" role="group" aria-label="传输内容"><button disabled={busy} className={tab==='files'?'selected':''} onClick={()=>setTab('files')}>文件传输</button><button disabled={busy} className={tab==='image'?'selected':''} onClick={()=>setTab('image')}>图片粘贴</button><button disabled={busy} className={tab==='text'?'selected':''} onClick={()=>setTab('text')}>文字复制粘贴</button></div>
   {error&&<Notice kind="error">{error}</Notice>}{message&&<Notice kind="success">{message}</Notice>}{busy&&<p role="status">{progress}</p>}{uploadProgress&&<div className="guest-upload-progress"><progress aria-label="文件传入进度" max={uploadProgress.total||1} value={uploadProgress.sent}/><span>{Math.round(uploadProgress.sent/Math.max(1,uploadProgress.total)*100)}% · {fileSize(uploadProgress.sent)} / {fileSize(uploadProgress.total)}</span></div>}{listBusy&&<p role="status">正在读取沙箱文件列表…</p>}
   {tab==='text'?<>
    <label className="field"><span>{onPasteText?`${hostName} → 当前终端`:`${hostName} → 沙箱`}</span><textarea aria-label="要发送到沙箱的文字" rows={4} maxLength={65536} value={text} onChange={event=>setText(event.target.value)} placeholder={`在这里用 ${pasteShortcut} 粘贴文字，再发送到沙箱`}/></label>
    <Button className="primary" icon={<ArrowUpToLine size={16}/>} disabled={networkBusy||!text||!connected} onClick={()=>void task(async()=>{if(onPasteText)await onPasteText(text);else await request(`/environments/${id}/clipboard/write`,{method:'POST',body:JSON.stringify({text})});setText(current=>current===text?'':current);setMessage(onPasteText?'已粘贴到当前终端，未按回车执行。':'已放入沙箱剪贴板。在沙箱网页或客户端中按 Ctrl+V 粘贴。');},'正在发送文字到沙箱…')}>{onPasteText?'粘贴到当前终端':'发送到沙箱剪贴板'}</Button>
    <div className="guest-exchange-divider"/>
    <p>{onReadText?`终端 → ${hostName}：先在当前终端中选中文字，再点击取回。`:`沙箱 → ${hostName}：先在沙箱中选中文字，按 Ctrl+C。`}</p>
    <div className="button-row"><Button icon={<ArrowDownToLine size={16}/>} disabled={networkBusy||!connected} onClick={()=>void task(async()=>{const result=onReadText?{text:await onReadText()}:await request<{text:string}>(`/environments/${id}/clipboard/read`,{method:'POST',body:'{}'});if(new TextEncoder().encode(result.text).length>65536)throw new Error('所选文字超过64 KiB，请分段取回。');setReceived(result.text);setMessage(result.text?`已取回文字；核对后可复制到 ${hostName}。`:onReadText?'当前终端尚未选中文字。':'沙箱剪贴板里暂无普通文本。');},'正在读取沙箱文字…')}>{onReadText?'取回终端选中文字':'取回沙箱文字'}</Button><Button icon={<Copy size={16}/>} disabled={!received||busy} onClick={()=>void task(async()=>{await writeHostText(received);setMessage(`已复制到 ${hostName}，可用 ${pasteShortcut} 粘贴。`);},`正在复制文字到 ${hostName}…`,true)}>复制到 {hostName}</Button></div>
    {received&&<textarea aria-label="从沙箱取回的文字" rows={4} readOnly value={received}/>}
    <p className="muted">手动传输普通文本，最多64 KiB。不会自动读取或同步 {hostName} 剪贴板；关闭此面板清空预览。</p>
   </>:tab==='image'?<>
    <section className="guest-image-clipboard"><div><strong>剪贴板图片</strong><small>复制 {hostName} 图片后点按钮，或在此面板按 {pasteShortcut}。图片仅临时保存在 Linux 剪贴板中。</small></div><Button icon={<Image size={16}/>} disabled={networkBusy||!connected} onClick={()=>void sendClipboardImage()}>粘贴图片到沙箱</Button></section>
    <p className="muted">返回沙箱后，在支持图片的输入框按 Ctrl+V。图片不会自动发送，也不需要先保存为文件。</p>
   </>:<>
    <div className="guest-file-workspace" onDragOver={event=>event.preventDefault()} onDrop={event=>{if(!dropTarget){event.preventDefault();acceptDrop(event.dataTransfer);}}}>

    {uploaded.length>0&&<section className="guest-upload-results" aria-label="本次传入的文件"><h3>已保存到下载目录 · {uploaded.length} 个文件</h3>{uploaded.map(file=><div key={file.path}><strong>{file.name}</strong><code>{file.path}</code>{fileActions(file)}</div>)}</section>}
    <section className="guest-file-browser"><div className="section-heading guest-file-heading"><div><h3>沙箱文件</h3><p className="muted">拖入文件，或点击上传 · 单个文件最多150 MiB</p></div><div className="button-row"><Button icon={<RefreshCw size={15}/>} disabled={networkBusy||!connected} onClick={()=>void(showProjects?loadProjects():refresh())}>刷新文件</Button><Button className="primary" icon={<ArrowUpToLine size={16}/>} disabled={networkBusy||!connected} onClick={()=>picker.current?.click()}>选择文件上传</Button></div></div>
    <input ref={picker} type="file" multiple hidden aria-label={`选择 ${hostName} 文件上传`} onChange={event=>{if(event.target.files)void upload(event.target.files);event.target.value='';}}/>
    <div className="guest-folder-tabs" role="group" aria-label="文件位置">{(['downloads','outgoing','incoming'] as const).map(zone=><Button key={zone} aria-pressed={!showProjects&&location.zone===zone} className={!showProjects&&location.zone===zone?'selected':''} disabled={networkBusy||!connected} onClick={()=>{setShowProjects(false);void refresh(false,{zone,path:''});}}><Folder size={16}/>{folderLabels[zone]}</Button>)}<Button aria-pressed={showProjects} className={showProjects?'selected':''} disabled={windows||networkBusy||!connected} title={windows?'Windows 持续共享目录尚未提供':undefined} onClick={()=>void loadProjects()}><Folder size={16}/>项目目录</Button></div>
    {showProjects?<div className="guest-project-folders"><p className="muted">项目文件直接位于这些沙箱目录，不在“下载 / 传入”文件夹；沿用已有共享权限。</p>{projects?.map(project=><section key={project.id}><code>{project.guestPath}</code><span className="muted">{project.writable?'读写':'只读'}</span><Button disabled={networkBusy||!connected} onClick={()=>void openFolder({projectId:project.id})}>在沙箱中打开</Button><Button disabled={networkBusy||!connected} onClick={()=>void copyGuestPath(project.guestPath)}>复制路径到沙箱</Button></section>)}{projects?.length===0&&<p className="muted">尚未配置项目共享目录，请到环境“项目目录”中设置。</p>}</div>:<>
    {location.path&&<nav className="guest-folder-breadcrumb" aria-label="沙箱文件夹"><Button disabled={networkBusy||!connected} onClick={()=>void refresh(false,{zone:location.zone,path:''})}>{folderLabels[location.zone]}</Button>{location.path.split('/').filter(Boolean).map((part,index,parts)=><span key={index}> / <Button disabled={networkBusy||!connected} onClick={()=>void refresh(false,{zone:location.zone,path:parts.slice(0,index+1).join('/')})}>{part}</Button></span>)}{location.path&&<Button disabled={networkBusy||!connected} onClick={()=>void refresh(false,{zone:location.zone,path:location.path.split('/').slice(0,-1).join('/')})}>上一级</Button>}</nav>}
    <code className="guest-folder-path">{TRANSFER_FOLDERS[location.zone]}{location.path?'/'+location.path:''}</code>
    {fileTotal!==null&&<p className="muted">已显示 {files.length} / {fileTotal} 项 · 修改时间按 {hostName} 本地时间显示{listedAt&&` · 读取于 ${listedAt}`}</p>}
    {listState==='error'&&<p className="muted">{files.length?'列表未更新，仍显示上次读取的文件。请刷新重试。':'未能读取文件列表，请刷新重试。'}</p>}
    {listState==='idle'&&!listBusy&&<p className="muted">选择“下载 / 导出 / 传入”文件夹，或点击“刷新文件”。</p>}
    <div className="guest-transfer-list">{files.map(file=><div key={`${file.zone}/${file.relativePath??file.name}`}><div>{file.kind==='directory'?<Button className="guest-folder-entry" icon={<Folder size={18}/>} disabled={networkBusy||!connected} onClick={()=>void refresh(false,{zone:file.zone,path:file.relativePath!})}>{file.name}</Button>:<strong>{file.name}{changes[file.path]&&<span className="guest-file-change">本次刷新{changes[file.path]}</span>}</strong>}<small>{file.kind==='directory'?'文件夹':fileSize(file.bytes)} · 修改于 <time dateTime={file.modifiedAt}>{modifiedTime(file.modifiedAt)}</time></small>{file.kind!=='directory'&&fileActions(file)}</div>{file.kind==='directory'?<Button disabled={networkBusy||!connected} onClick={()=>void refresh(false,{zone:file.zone,path:file.relativePath!})}>打开文件夹</Button>:<Button icon={<ArrowDownToLine size={15}/>} disabled={networkBusy||!connected} onClick={()=>void download(file)}>下载到 {hostName}</Button>}</div>)}{listState==='ready'&&!files.length&&<p className="muted">此文件夹暂无可传输文件或子文件夹。</p>}</div>
    {nextCursor&&<Button disabled={networkBusy||!connected} onClick={()=>void refresh(true)}>加载更多文件</Button>}
    </>}
    </section>
    </div>
    <details className="guest-transfer-more guest-upload-guide"><summary>上传、路径与保存说明</summary>
     {onPasteText?<p>文件传入后，点“粘贴路径到终端”。路径会加好引号，不自动执行命令。</p>:<><ol><li>拖入或选择 {hostName} 文件，等待提示已保存到沙箱“下载”目录。</li><li>返回网页点“上传 / 附件”，在 Linux 文件选择框中进入“下载 / Downloads”选择文件。</li><li>需要找其他目录时，可点“打开所在文件夹”；也可复制路径，在文件选择框按 <kbd>Ctrl+L</kbd>、<kbd>Ctrl+V</kbd>定位。</li></ol><small>这是 Linux 文件选择框；{hostName} 的桌面和下载目录不会自动出现在里面。</small></>}
     <div className="button-row"><Button disabled={networkBusy||!connected} onClick={()=>void copyGuestPath(TRANSFER_FOLDERS.incoming)}>使用传入文件夹路径</Button><Button disabled={networkBusy||!connected} onClick={()=>void copyGuestPath(TRANSFER_FOLDERS.downloads)}>使用下载文件夹路径</Button></div><p className="guest-transfer-path">新上传默认保存到：<code>{TRANSFER_FOLDERS.downloads}</code><br/>导出时，保存到 <code>{TRANSFER_FOLDERS.downloads}</code> 或 <code>{TRANSFER_FOLDERS.outgoing}</code> 及其子文件夹。完成后刷新列表；修改时间不一定是导出时间。正在下载的临时文件不显示。</p>
     <p>文件在当前 VM 内保存；重建或删除环境会清除，{hostName} 原文件保留。{windows?'Windows 当前通过手动传输交换项目文件。':'更多 / 更大的项目文件可使用“项目目录”。'}</p>
    </details>
   </>}

  </div><footer className="modal-footer"><Button disabled={busy} onClick={close}>{onPasteText?'返回终端':'返回沙箱'}</Button></footer>
 </Modal>}</>;
}
