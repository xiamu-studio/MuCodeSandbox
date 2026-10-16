import {useEffect,useRef,useState,type RefObject} from 'react';
import {ArrowDownToLine,ArrowUpToLine,Copy,FolderInput,RefreshCw} from 'lucide-react';
import {Button,Modal,Notice} from './components.tsx';
import {request,ApiError} from './api.ts';
import {TRANSFER_MAX_BYTES,TRANSFER_FOLDERS,type TransferFile,type TransferFilePage} from '../shared/guest-exchange.ts';
import {quoteTerminalPath} from './terminal-input.ts';

type UploadedFile={name:string;path:string;bytes:number};
const fileSize=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KiB`:`${(bytes/(1024*1024)).toFixed(1)} MiB`;
export default function GuestExchangePanel({id,connected,active=true,dropTarget,onReturn,onPasteText,onReadText}:{id:string;connected:boolean;active?:boolean;dropTarget?:RefObject<HTMLDivElement|null>;onReturn?:()=>void;onPasteText?:(text:string)=>Promise<void>;onReadText?:()=>Promise<string>}){
 const [open,setOpen]=useState(false),[tab,setTab]=useState<'text'|'files'>('files'),[text,setText]=useState(''),[received,setReceived]=useState(''),[files,setFiles]=useState<TransferFile[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const picker=useRef<HTMLInputElement>(null),working=useRef(false);
 const [dragging,setDragging]=useState(false),[uploaded,setUploaded]=useState<UploadedFile[]>([]),[progress,setProgress]=useState('');
 const [listState,setListState]=useState<'idle'|'loading'|'ready'|'error'>('idle'),[nextCursor,setNextCursor]=useState<string|null>(null),[fileTotal,setFileTotal]=useState<number|null>(null);
 const queueRevision=useRef(0);
 const available=useRef(active&&connected);available.current=active&&connected;
 useEffect(()=>{
  available.current=active&&connected;
  // An in-flight file can finish after this view is removed. Do not start
  // another file in its queue after an environment switch or view teardown.
  return()=>{available.current=false;queueRevision.current++;};
 },[id,active,connected]);
 useEffect(()=>{
  const target=dropTarget?.current;if(!target||!active)return;
  let depth=0;
  const hasFiles=(event:DragEvent)=>Array.from(event.dataTransfer?.types??[]).includes('Files');
  const enter=(event:DragEvent)=>{if(!hasFiles(event))return;event.preventDefault();depth++;setDragging(true);};
  const over=(event:DragEvent)=>{if(!hasFiles(event))return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect=connected&&!working.current?'copy':'none';};
  const leave=(event:DragEvent)=>{if(!hasFiles(event))return;if(--depth<=0){depth=0;setDragging(false);}};
  const drop=(event:DragEvent)=>{if(!hasFiles(event))return;event.preventDefault();event.stopPropagation();depth=0;setDragging(false);if(event.dataTransfer)acceptDrop(event.dataTransfer);};
  const end=()=>{depth=0;setDragging(false);};
  target.addEventListener('dragenter',enter);target.addEventListener('dragover',over);target.addEventListener('dragleave',leave);target.addEventListener('drop',drop,true);window.addEventListener('dragend',end);
  return()=>{target.removeEventListener('dragenter',enter);target.removeEventListener('dragover',over);target.removeEventListener('dragleave',leave);target.removeEventListener('drop',drop,true);window.removeEventListener('dragend',end);};
 },[dropTarget,active,connected,id]);
 function acceptDrop(data:DataTransfer){
  if(working.current)return;
  setOpen(true);setTab('files');
  if(!available.current){setError('沙箱画面尚未连接，请连接后重新拖入文件。');return;}
  if(Array.from(data.items??[]).some(item=>item.webkitGetAsEntry?.()?.isDirectory)){setError('暂不支持拖入文件夹。请先压缩为文件，或使用“项目目录”。');return;}
  if(!data.files.length){setError('没有取得可传输文件，请使用“选择文件上传”。');return;}
  void upload(Array.from(data.files));
 }

 async function task(work:()=>Promise<void>){if(working.current)return;working.current=true;setBusy(true);setError('');setMessage('');try{await work();}catch(e){setError((e as Error).message);}finally{working.current=false;setBusy(false);setProgress('');}}
 async function refresh(more=false){
  setListState('loading');
  try{
   const page=await request<TransferFilePage>(`/environments/${id}/transfer-files?paged=1${more&&nextCursor?'&cursor='+encodeURIComponent(nextCursor):''}`);
   setFiles(current=>more?[...new Map([...current,...page.files].map(file=>[`${file.zone}/${file.name}`,file])).values()]:page.files);
   setFileTotal(page.total);setNextCursor(page.nextCursor);setListState('ready');
  }catch(e){setListState('error');throw e;}
 }
 async function check(response:Response){if(!response.ok){const result=await response.json();throw new ApiError(result.error??'传输失败',response.status,result.code??'TRANSFER_FAILED');}return response;}
 async function upload(list:FileList|File[]){await task(async()=>{
  const selected=Array.from(list);if(!selected.length)return;
  const revision=queueRevision.current;
  setUploaded([]);
  // Validate the entire selection before uploading anything.
  const tooLarge=selected.find(file=>file.size>TRANSFER_MAX_BYTES);
  if(tooLarge)throw new Error(`${tooLarge.name} 超过25 MiB，本批尚未上传；可使用“项目目录”传入大文件`);
  let completed=0;
  for(const file of selected){
   if(!available.current||revision!==queueRevision.current)throw new Error(`已传入 ${completed} 个文件；沙箱已断开或离开当前画面，剩余文件未上传。`);
   setProgress(`正在传入 ${completed+1} / ${selected.length}：${file.name}`);
   try{
    const response=await check(await fetch(`/api/environments/${id}/transfer-files?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{Authorization:`Bearer ${window.__MU_CONFIG__.token}`,'Content-Type':'application/octet-stream'},body:file}));
    const saved:UploadedFile=await response.json();setUploaded(current=>[...current,saved]);completed++;
    // The guarded upload receipt already confirms the saved path. Invalidate
    // old pagination without making a second guest scan block the handoff.
    setFiles([]);setFileTotal(null);setNextCursor(null);setListState('idle');
   }catch(e){throw new Error(`已传入 ${completed} 个文件；${file.name} 未确认传入：${(e as Error).message}。其余文件未上传，刷新列表后再重试。`);}
  }
  setMessage(onPasteText?`已传入 ${completed} 个文件。可将路径粘贴到当前终端；尚未执行命令。`:`已传入 ${completed} 个文件。下方路径可直接用于沙箱网页的文件选择框；尚未发送给网站。`);
 });}
 async function copyGuestPath(path:string){await task(async()=>{
  if(onPasteText){await onPasteText(quoteTerminalPath(path));setMessage('路径已粘贴到当前终端，未执行。');return;}
  await request(`/environments/${id}/clipboard/write`,{method:'POST',body:JSON.stringify({text:path})});
  setMessage('路径已放入沙箱剪贴板。返回网页点“上传 / 附件”，在弹出的文件选择框按 Ctrl+L、Ctrl+V，再按回车。');
 });}
 function fileActions(file:{name:string;path:string}){return <div className="guest-transfer-actions"><Button disabled={busy||!connected} onClick={()=>void copyGuestPath(file.path)}>{onPasteText?'粘贴路径到终端':'复制路径到沙箱'}</Button><Button icon={<Copy size={15}/>} disabled={busy} onClick={()=>void task(async()=>{await navigator.clipboard.writeText(file.path);setMessage('Linux 路径已复制到 Mac；这个路径仅在当前沙箱内有效。');})}>复制路径</Button></div>;}
 async function download(file:TransferFile){await task(async()=>{
  const response=await check(await fetch(`/api/environments/${id}/transfer-download`,{method:'POST',headers:{Authorization:`Bearer ${window.__MU_CONFIG__.token}`,'Content-Type':'application/json'},body:JSON.stringify({zone:file.zone,name:file.name})}));
  const url=URL.createObjectURL(await response.blob());const a=document.createElement('a');a.href=url;a.download=file.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setMessage('已交给 Mac 保存文件。');
 });}
 function close(){if(working.current)return;setOpen(false);setText('');setReceived('');setError('');setMessage('');setFiles([]);setUploaded([]);setListState('idle');setNextCursor(null);setFileTotal(null);onReturn?.();}
 return <><button className="button guest-exchange-button" type="button" disabled={!connected} onClick={()=>{setOpen(true);if(tab==='files')void task(refresh);}} title="文件与复制粘贴"><FolderInput size={16}/><span>文件与粘贴</span></button>{dragging&&active&&<div className="guest-file-drop-overlay" role="status"><FolderInput size={36}/><strong>{connected&&!busy?'松开即可传入当前沙箱':'请先连接沙箱，并等待当前传输完成'}</strong><span>文件保存在沙箱内，由你选择是否上传给网站</span></div>}{open&&active&&<Modal title="文件与复制粘贴" subtitle="只传输你选择的文件和文字" onClose={close}>
  <div className="modal-body guest-exchange-body">
   <div className="segmented"><button disabled={busy} className={tab==='text'?'selected':''} onClick={()=>setTab('text')}>文字复制粘贴</button><button disabled={busy} className={tab==='files'?'selected':''} onClick={()=>{setTab('files');void task(refresh);}}>文件传输</button></div>
   {error&&<Notice kind="error">{error}</Notice>}{message&&<Notice kind="success">{message}</Notice>}{busy&&<p role="status">{progress||'正在处理，请稍候…'}</p>}
   {tab==='text'?<>
    <label className="field"><span>{onPasteText?'Mac → 当前终端':'Mac → 沙箱'}</span><textarea aria-label="要发送到沙箱的文字" rows={4} maxLength={65536} value={text} onChange={event=>setText(event.target.value)} placeholder="在这里用 ⌘V 粘贴文字，再发送到沙箱"/></label>
    <Button className="primary" icon={<ArrowUpToLine size={16}/>} disabled={busy||!text||!connected} onClick={()=>void task(async()=>{if(onPasteText)await onPasteText(text);else await request(`/environments/${id}/clipboard/write`,{method:'POST',body:JSON.stringify({text})});setText(current=>current===text?'':current);setMessage(onPasteText?'已粘贴到当前终端，未按回车执行。':'已放入沙箱剪贴板。在沙箱网页或客户端中按 Ctrl+V 粘贴。');})}>{onPasteText?'粘贴到当前终端':'发送到沙箱剪贴板'}</Button>
    <div className="guest-exchange-divider"/>
    <p>{onReadText?'终端 → Mac：先在当前终端中选中文字，再点击取回。':'沙箱 → Mac：先在沙箱中选中文字，按 Ctrl+C。'}</p>
    <div className="button-row"><Button icon={<ArrowDownToLine size={16}/>} disabled={busy||!connected} onClick={()=>void task(async()=>{const result=onReadText?{text:await onReadText()}:await request<{text:string}>(`/environments/${id}/clipboard/read`,{method:'POST',body:'{}'});if(new TextEncoder().encode(result.text).length>65536)throw new Error('所选文字超过64 KiB，请分段取回。');setReceived(result.text);setMessage(result.text?'已取回文字；核对后可复制到 Mac。':onReadText?'当前终端尚未选中文字。':'沙箱剪贴板里暂无普通文本。');})}>{onReadText?'取回终端选中文字':'取回沙箱文字'}</Button><Button icon={<Copy size={16}/>} disabled={!received||busy} onClick={()=>void task(async()=>{await navigator.clipboard.writeText(received);setMessage('已复制到 Mac，可用 ⌘V 粘贴。');})}>复制到 Mac</Button></div>
    {received&&<textarea aria-label="从沙箱取回的文字" rows={4} readOnly value={received}/>}
    <p className="muted">手动传输普通文本，最多64 KiB。不会自动读取或同步 Mac 剪贴板；关闭此面板清空预览。</p>
   </>:<>
    {uploaded.length>0&&<section className="guest-upload-results" aria-label="本次传入的文件"><h3>本次已传入 {uploaded.length} 个文件</h3>{uploaded.map(file=><div key={file.path}><strong>{file.name}</strong><code>{file.path}</code>{fileActions(file)}</div>)}</section>}
    <div className="guest-transfer-drop" onDragOver={event=>{event.preventDefault();}} onDrop={event=>{if(!dropTarget){event.preventDefault();acceptDrop(event.dataTransfer);}}}>
     <FolderInput size={26}/><strong>直接拖到沙箱画面，或选择 Mac 文件</strong><span>每个文件最多25 MiB，上传到当前沙箱</span><Button className="primary" icon={<ArrowUpToLine size={16}/>} disabled={busy||!connected} onClick={()=>picker.current?.click()}>选择文件上传</Button>
     <input ref={picker} type="file" multiple hidden aria-label="选择 Mac 文件上传" onChange={event=>{if(event.target.files)void upload(event.target.files);event.target.value='';}}/>
    </div>
    {onPasteText?<p className="muted">文件传入后，点“粘贴路径到终端”。路径会加好引号，不自动执行命令。</p>:<details className="guest-upload-guide"><summary>在网页中上传怎么操作？</summary><ol><li>将 Mac 文件拖进沙箱画面，等待传入完成。</li><li>点击文件旁的“复制路径到沙箱”，再返回网页点“上传 / 附件”。</li><li>在文件选择框按 <kbd>Ctrl+L</kbd>、<kbd>Ctrl+V</kbd>，再按回车。</li></ol><small>这是 Linux 文件选择框；Mac 的桌面和下载目录不会自动出现在里面。</small></details>}

    <div className="button-row"><Button disabled={busy||!connected} onClick={()=>void copyGuestPath(TRANSFER_FOLDERS.incoming)}>使用传入文件夹路径</Button><Button disabled={busy||!connected} onClick={()=>void copyGuestPath(TRANSFER_FOLDERS.downloads)}>使用下载文件夹路径</Button></div>
    <p className="guest-transfer-path">上传位置：<code>{TRANSFER_FOLDERS.incoming}</code><br/>导出时，在沙箱应用中将文件保存到 <code>{TRANSFER_FOLDERS.downloads}</code> 或 <code>{TRANSFER_FOLDERS.outgoing}</code>，再刷新并下载。</p>
    <div className="section-heading"><h3>沙箱文件</h3><Button icon={<RefreshCw size={15}/>} disabled={busy||!connected} onClick={()=>void task(refresh)}>刷新文件</Button></div>
    {fileTotal!==null&&<p className="muted">已显示 {files.length} / {fileTotal} 个可传输文件 · 最近修改在前</p>}
    {listState==='loading'&&<p role="status">正在读取文件列表…</p>}
    {listState==='error'&&<p className="muted">{files.length?'列表未更新，仍显示上次读取的文件。请刷新重试。':'未能读取文件列表，请刷新重试。'}</p>}
    {listState==='idle'&&<p className="muted">点击“刷新文件”查看沙箱文件。</p>}
    <div className="guest-transfer-list">{files.map(file=><div key={`${file.zone}/${file.name}`}><div><strong>{file.name}</strong><code>{file.path}</code><small>{file.zone==='incoming'?'上传文件':file.zone==='outgoing'?'导出文件':'下载文件'} · {fileSize(file.bytes)}</small>{fileActions(file)}</div><Button icon={<ArrowDownToLine size={15}/>} disabled={busy||!connected} onClick={()=>void download(file)}>下载到 Mac</Button></div>)}{listState==='ready'&&!files.length&&<p className="muted">这些文件夹里还没有可传输的文件。</p>}</div>
    {nextCursor&&<Button disabled={busy||!connected} onClick={()=>void task(()=>refresh(true))}>加载更多文件</Button>}
    <p className="muted">文件在当前 VM 内保存；重建或删除环境会清除，Mac 原文件保留。更多 / 更大的项目文件可使用“项目目录”。</p>
   </>}

  </div><footer className="modal-footer"><Button disabled={busy} onClick={close}>{onPasteText?'返回终端':'返回沙箱'}</Button></footer>
 </Modal>}</>;
}
