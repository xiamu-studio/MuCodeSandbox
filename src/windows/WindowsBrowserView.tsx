import {useEffect,useRef,useState} from 'react';
import type RFB from '@novnc/novnc';
import {Maximize2,RefreshCw,Image} from 'lucide-react';
import {api,request} from '../api.ts';
import {Button,Notice,SectionHeading} from '../components.tsx';
import GuestTimezoneClock from '../GuestTimezoneClock.tsx';
import type {Environment} from '../../shared/types.ts';
import {imageClipboardBlob,writeGuestClipboardImage} from '../clipboard-image.ts';
import {readWindowsClipboardImage} from './clipboard-image.ts';
import GuestAudio from './WindowsAudio.tsx';
import {windowsPasteShortcut,windowsTextDraft} from './text-input.ts';
import WindowsTextTools from './WindowsTextTools.tsx';

export default function WindowsBrowserView({environment}:{environment:Environment}){
 const container=useRef<HTMLDivElement>(null),surface=useRef<HTMLDivElement>(null),remote=useRef<RFB|null>(null);
 const [attempt,retry]=useState(0),[status,setStatus]=useState('连接中'),[error,setError]=useState(''),[text,setText]=useState(''),[busy,setBusy]=useState(false),[address,setAddress]=useState('');
 const [imageStatus,setImageStatus]=useState('');const imageRequest=useRef<AbortController|null>(null),imageRevision=useRef(0),imageBusy=useRef(false),imageAvailable=useRef(false);imageAvailable.current=status==='已连接';
 const textComposing=useRef(false),textValue=useRef(''),textRevision=useRef(0),textView=useRef(0),textRequest=useRef<AbortController|null>(null);const [composing,setComposing]=useState(false);
 useEffect(()=>{textView.current++;textRequest.current?.abort();return()=>{textView.current++;textRequest.current?.abort();};},[environment.id,attempt,status]);
 useEffect(()=>{imageRevision.current++;imageRequest.current?.abort();setImageStatus('');return()=>{imageRevision.current++;imageRequest.current?.abort();};},[environment.id,attempt,status]);
 useEffect(()=>{
  let closed=false,rfb:RFB|undefined;setStatus('连接中');setError('');
  void(async()=>{const ticket=await api.guestBrowserTicket(environment.id);if(closed||!container.current)return;const FrameBuffer=(await import('@novnc/novnc')).default;if(closed)return;
   rfb=new FrameBuffer(container.current,`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/guest-browser?ticket=${encodeURIComponent(ticket.ticket)}`,{credentials:{password:ticket.password},shared:true});remote.current=rfb;
   rfb.scaleViewport=true;rfb.resizeSession=false;rfb.viewOnly=false;rfb.focusOnClick=true;
   rfb.addEventListener('connect',()=>{if(!closed){setStatus('已连接');rfb!.focus();}});
   rfb.addEventListener('disconnect',()=>{if(!closed)setStatus('已断开');});rfb.addEventListener('securityfailure',()=>{if(!closed){setStatus('连接失败');setError('客体画面认证失败，请重试连接。');}});
  })().catch(e=>{if(!closed){setStatus('连接失败');setError(e.message);}});
  return()=>{closed=true;if(remote.current===rfb)remote.current=null;rfb?.disconnect();};
 },[environment.id,attempt]);
 function editText(value:string){textRevision.current++;textValue.current=value;setText(value);}
 async function paste(){
  if(busy||textComposing.current||!remote.current||status!=='已连接')return;const sent=textValue.current;if(!sent)return;const rfb=remote.current,view=textView.current,revision=textRevision.current,controller=new AbortController();textRequest.current=controller;setBusy(true);setError('');
  const current=()=>imageAvailable.current&&!textComposing.current&&remote.current===rfb&&textView.current===view&&textRevision.current===revision;
  try{windowsTextDraft(sent);await request(`/environments/${environment.id}/clipboard/write`,{method:'POST',body:JSON.stringify({text:sent}),signal:controller.signal});if(!current()){setError('输入或画面已变化，当前文字已保留；请重新确认粘贴。');return;}rfb.focus();rfb.sendKey(0xffe3,'ControlLeft',true);try{rfb.sendKey(0x76,'KeyV');}finally{rfb.sendKey(0xffe3,'ControlLeft',false);}if(textValue.current===sent)editText('');}
  catch(e){if(textView.current===view)setError((e as Error).message);}finally{if(textRequest.current===controller)textRequest.current=null;setBusy(false);}
 }
 async function receiveText(){
  if(busy||textComposing.current||status!=='已连接')return;const view=textView.current,revision=textRevision.current,controller=new AbortController();textRequest.current=controller;setBusy(true);setError('');
  try{const result=await request<{text:string}>(`/environments/${environment.id}/clipboard/read`,{method:'POST',body:'{}',signal:controller.signal});if(!imageAvailable.current||textView.current!==view||textRevision.current!==revision||textComposing.current){setError('文字或画面已变化，已保留当前输入；请重新取回。');return;}editText(result.text);}catch(e){if(textView.current===view)setError((e as Error).message);}finally{if(textRequest.current===controller)textRequest.current=null;setBusy(false);}
 }
 async function resize(){setBusy(true);setError('');try{const actual=await api.resizeGuestDisplay(environment.id,{cssWidth:1600,cssHeight:1000,scaleFactor:2,mode:'fixed'});if(!actual.matched)throw Error('客体画面与请求尺寸尚未一致，请重试');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function pasteImage(source?:Blob){
  if(busy||imageBusy.current||!imageAvailable.current||!remote.current)return;const stamp=imageRevision.current,rfb=remote.current;const current=()=>imageAvailable.current&&imageRevision.current===stamp&&remote.current===rfb;
  imageBusy.current=true;setBusy(true);setError('');setImageStatus('正在传入图片…');
  try{const bytes=source?await imageClipboardBlob(source):await readWindowsClipboardImage();if(!current())return;const controller=new AbortController();imageRequest.current=controller;await writeGuestClipboardImage(environment.id,bytes,controller.signal);if(current())setImageStatus('图片已放入客体剪贴板，请在客体中按 Ctrl+V 粘贴。');}
  catch(e){if(current()){setImageStatus('');setError((e as Error).message);}}
  finally{imageBusy.current=false;imageRequest.current=null;setBusy(false);}
 }
 async function navigate(event:React.SubmitEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError('');try{await request(`/environments/${environment.id}/browser/navigate`,{method:'POST',body:JSON.stringify({url:address})});}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function pasteTool(value:string,signal:AbortSignal){
  const rfb=remote.current,view=textView.current;if(!imageAvailable.current||!rfb)throw Error('画面尚未连接。');windowsTextDraft(value);
  await request(`/environments/${environment.id}/clipboard/write`,{method:'POST',body:JSON.stringify({text:value}),signal});signal.throwIfAborted();
  if(!imageAvailable.current||remote.current!==rfb||textView.current!==view)throw Error('画面已变化，原文已保留。');rfb.focus();rfb.sendKey(0xffe3,'ControlLeft',true);try{rfb.sendKey(0x76,'KeyV');}finally{rfb.sendKey(0xffe3,'ControlLeft',false);}
 }
 function toolKey(key:'backspace'|'enter'){if(imageAvailable.current&&remote.current){remote.current.focus();remote.current.sendKey(key==='enter'?0xff0d:0xff08,key==='enter'?'Enter':'Backspace');}}
 return <section className="windows-browser" ref={surface} onPointerDownCapture={()=>{if(textRequest.current)textRevision.current++;}} onBlurCapture={()=>{if(textRequest.current)textRevision.current++;}}>
  <SectionHeading title="Linux 浏览器" subtitle={status} action={<><GuestTimezoneClock timezone={environment.identity.timezone}/>{window.__MU_CONFIG__.capabilities?.translation&&<WindowsTextTools id={environment.id} connected={status==='已连接'} onPaste={pasteTool} onKey={toolKey}/ >}{window.__MU_CONFIG__.capabilities?.audio&&<GuestAudio id={environment.id} connected={status==='已连接'}/>}<Button disabled={busy||status!=='已连接'} onClick={()=>void resize()}>1600 × 1000 · 2×</Button><Button aria-label="重新连接画面" onClick={()=>retry(value=>value+1)} icon={<RefreshCw size={15}/>}/><Button aria-label="全屏画面" onClick={()=>void surface.current?.requestFullscreen().catch(e=>setError(e.message))} icon={<Maximize2 size={15}/>}/></>}/>
  <form className="windows-address" onSubmit={event=>void navigate(event)}><input type="url" aria-label="浏览器网址" placeholder="输入 HTTP 或 HTTPS 网址后打开" value={address} onChange={event=>setAddress(event.target.value)} required/><Button type="submit" disabled={busy||status!=='已连接'}>打开网址</Button></form>
  {error&&<Notice kind="error">{error}</Notice>}<div className="windows-browser-canvas" ref={container}/>
  <div className="windows-terminal-input"><label>中文与多行输入<textarea aria-label="浏览器待粘贴文字" value={text} maxLength={65536} onChange={event=>editText(event.target.value)} onCompositionStart={()=>{textRevision.current++;textComposing.current=true;setComposing(true);}} onCompositionEnd={event=>{textComposing.current=false;setComposing(false);editText(event.currentTarget.value);}} onKeyDown={event=>{if(windowsPasteShortcut(event.nativeEvent,textComposing.current)){event.preventDefault();void paste();}}}/></label><Button disabled={busy||composing||status!=='已连接'||!text} onClick={()=>void paste()}>粘贴到客体</Button><Button disabled={busy||composing||status!=='已连接'} onClick={()=>void receiveText()}>取回客体文字</Button><small>先点击客体输入框。Ctrl+Enter 粘贴，候选选字时不会触发；最多64 KiB，不自动发送。</small></div>
  {window.__MU_CONFIG__.capabilities?.imageClipboard&&<div className="windows-image-clipboard" tabIndex={0} role="group" aria-label="图片粘贴区" onPaste={event=>{const image=Array.from(event.clipboardData.files).find(file=>file.type.startsWith('image/'));if(image){event.preventDefault();void pasteImage(image);}}}><div><strong>剪贴板图片</strong><small>复制图片后点按钮，或在此处按 Ctrl+V。最多 10 MiB、1600 万像素。</small></div><Button icon={<Image size={15}/>} disabled={busy||status!=='已连接'} onClick={()=>void pasteImage()}>粘贴图片到沙箱</Button>{imageStatus&&<p role="status">{imageStatus}</p>}</div>}
 </section>;
}
