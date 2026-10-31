import {useEffect,useRef,useState} from 'react';
import type RFB from '@novnc/novnc';
import {Maximize2,Minimize2,RefreshCw,Image} from 'lucide-react';
import {api,request} from '../api.ts';
import {Button,Notice,SectionHeading} from '../components.tsx';
import GuestTimezoneClock from '../GuestTimezoneClock.tsx';
import type {Environment} from '../../shared/types.ts';
import type {DesktopAppId} from '../../shared/guest-desktop.ts';
import {imageClipboardBlob,writeGuestClipboardImage} from '../clipboard-image.ts';
import {readWindowsClipboardImage,readWindowsGuestImage,copyWindowsReceivedImage,type ReceivedWindowsImage} from './clipboard-image.ts';
import GuestAudio from './WindowsAudio.tsx';
import {windowsPasteShortcut,windowsTextDraft} from './text-input.ts';
import WindowsTextTools from './WindowsTextTools.tsx';
import GuestExchangePanel from '../GuestExchangePanel.tsx';
import {DEFAULT_FIXED_DISPLAY,FIXED_DISPLAY_PRESETS,displayPixels,displayPreference,displayRequestKey,fitDisplay,guestPresentation,type DisplayRequest,type GuestDisplay,type PresentationMode} from '../../shared/guest-display.ts';

export default function WindowsBrowserView({environment,title='Linux 浏览器',showNavigation=true,desktopClient}:{environment:Environment;title?:string;showNavigation?:boolean;desktopClient?:{application:DesktopAppId;viewId:string}}){
 const clientApplication=desktopClient?.application,clientViewId=desktopClient?.viewId;
 const container=useRef<HTMLDivElement>(null),viewport=useRef<HTMLDivElement>(null),surface=useRef<HTMLDivElement>(null),remote=useRef<RFB|null>(null);
 const [attempt,retry]=useState(0),[status,setStatus]=useState('连接中'),[error,setError]=useState(''),[text,setText]=useState(''),[busy,setBusy]=useState(false),[address,setAddress]=useState('');
 const addressComposing=useRef(false);
 useEffect(()=>{addressComposing.current=false;},[environment.id,attempt]);
 const [fullscreen,setFullscreen]=useState(false),[fullscreenBusy,setFullscreenBusy]=useState(false);const nativeFullscreenRequested=useRef(false),fullscreenEpoch=useRef(0);
 const [settings,setSettings]=useState(false),[preference,setPreference]=useState<DisplayRequest>({...DEFAULT_FIXED_DISPLAY}),[presentation,setPresentation]=useState<PresentationMode>('fit'),[displayBusy,setDisplayBusy]=useState(false);
 const [display,setDisplay]=useState<GuestDisplay|null>(null),[displayLoaded,setDisplayLoaded]=useState(false),[view,setView]=useState({width:0,height:0,density:window.devicePixelRatio});
 const displayEpoch=useRef(0),displayQueue=useRef(Promise.resolve()),appliedDisplay=useRef('');
 const preferenceEdits=useRef(0);
 const refreshFrame=useRef<()=>void>(()=>{});
 function editDisplay(value:DisplayRequest){preferenceEdits.current++;setPreference(value);}
 useEffect(()=>{
  const target=container.current,client=remote.current;
  if(!target||!client||status!=='已连接')return;
  let timer:ReturnType<typeof setTimeout>|undefined,last=0;
  const redraw=()=>{
   if(document.hidden||remote.current!==client||target.clientWidth<1||target.clientHeight<1)return;
   last=performance.now();client.refreshFrame();
  };
  // Coalesce restored/focused/resized views without replacing the connection,
  // canvas or decoder. A retired viewer must never refresh its replacement.
  const schedule=()=>{clearTimeout(timer);timer=setTimeout(redraw,Math.max(180,750-(performance.now()-last)));};
  refreshFrame.current=schedule;
  const observer=new ResizeObserver(schedule);observer.observe(target);
  window.addEventListener('focus',schedule);window.addEventListener('pageshow',schedule);window.addEventListener('resize',schedule);window.visualViewport?.addEventListener('resize',schedule);
  document.addEventListener('visibilitychange',schedule);document.addEventListener('fullscreenchange',schedule);target.addEventListener('contextrestored',schedule,true);schedule();
  return()=>{clearTimeout(timer);refreshFrame.current=()=>{};observer.disconnect();window.removeEventListener('focus',schedule);window.removeEventListener('pageshow',schedule);window.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('resize',schedule);document.removeEventListener('visibilitychange',schedule);document.removeEventListener('fullscreenchange',schedule);target.removeEventListener('contextrestored',schedule,true);};
 },[environment.id,attempt,status,clientApplication,clientViewId]);
 useEffect(()=>{
  const target=viewport.current;if(!target)return;let media:MediaQueryList;
  const measure=()=>{const width=target.clientWidth,height=target.clientHeight,density=window.devicePixelRatio;setView(previous=>previous.width===width&&previous.height===height&&previous.density===density?previous:{width,height,density});};
  const observeDensity=()=>{media?.removeEventListener('change',densityChanged);media=window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);media.addEventListener('change',densityChanged);};
  const densityChanged=()=>{observeDensity();measure();};
  const observer=new ResizeObserver(measure);observer.observe(target);observeDensity();measure();window.addEventListener('resize',measure);window.addEventListener('focus',measure);window.visualViewport?.addEventListener('resize',measure);document.addEventListener('visibilitychange',measure);
  return()=>{observer.disconnect();media.removeEventListener('change',densityChanged);window.removeEventListener('resize',measure);window.removeEventListener('focus',measure);window.visualViewport?.removeEventListener('resize',measure);document.removeEventListener('visibilitychange',measure);};
 },[environment.id,attempt,clientApplication,clientViewId]);
 useEffect(()=>{
  setDisplayLoaded(false);appliedDisplay.current='';setDisplay(null);
  if(status!=='已连接')return;let live=true;const revision=preferenceEdits.current;
  void (clientApplication&&clientViewId?api.windowsDesktopClientView(environment.id,clientApplication,clientViewId):api.guestBrowser(environment.id)).then(value=>{
   if(!live)return;const restored=displayPreference(value.display);
   if(revision===preferenceEdits.current){setPreference(restored);setDisplay(value.display??null);if(value.display?.matched)appliedDisplay.current=displayRequestKey(restored);}
   setDisplayLoaded(true);
  }).catch(error=>{if(live)setError(`无法读取显示设置：${(error as Error).message}。请重新连接画面后重试。`);});
  return()=>{live=false;};
 },[environment.id,attempt,status,clientApplication,clientViewId]);
 useEffect(()=>{
  const target=viewport.current,stamp=++displayEpoch.current;
  if(!target||status!=='已连接'||!displayLoaded){setDisplayBusy(false);return;}
  let disposed=false,timer:ReturnType<typeof setTimeout>|undefined,wanted='';
  const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>{
   const next=preference.mode==='adaptive'?{...fitDisplay(target.clientWidth,target.clientHeight,window.devicePixelRatio),mode:'adaptive' as const}:preference;
   const key=displayRequestKey(next);wanted=key;if(key===appliedDisplay.current)return;
   displayQueue.current=displayQueue.current.catch(()=>{}).then(async()=>{
    if(disposed||stamp!==displayEpoch.current||wanted!==key||key===appliedDisplay.current)return;
    setDisplayBusy(true);
    try{const actual=await (clientApplication&&clientViewId?api.resizeWindowsDesktopClientView(environment.id,clientApplication,clientViewId,next):api.resizeGuestDisplay(environment.id,next));if(disposed||stamp!==displayEpoch.current||wanted!==key)return;setDisplay(actual);if(!actual.matched)throw Error('客体画面与请求尺寸尚未一致，请重新应用显示设置');appliedDisplay.current=key;}
    catch(error){if(!disposed&&stamp===displayEpoch.current)setError((error as Error).message);}
    finally{if(!disposed&&stamp===displayEpoch.current)setDisplayBusy(false);}
   });
  },250);};
  const observer=new ResizeObserver(schedule);observer.observe(target);window.addEventListener('resize',schedule);schedule();
  return()=>{disposed=true;clearTimeout(timer);observer.disconnect();window.removeEventListener('resize',schedule);};
 },[environment.id,attempt,status,displayLoaded,preference,fullscreen,view,clientApplication,clientViewId]);
 useEffect(()=>{
  const desktop=window.muWindowsDesktop,stamp=++fullscreenEpoch.current;
  const changed=()=>setFullscreen(document.fullscreenElement===surface.current);
  const unsubscribe=desktop?.onViewerFullscreenChange?.(value=>{if(fullscreenEpoch.current===stamp){nativeFullscreenRequested.current=value;setFullscreen(value);}});
  document.addEventListener('fullscreenchange',changed);
  return()=>{fullscreenEpoch.current++;document.removeEventListener('fullscreenchange',changed);unsubscribe?.();if(nativeFullscreenRequested.current){nativeFullscreenRequested.current=false;void desktop?.setViewerFullscreen?.(false).catch(()=>{});}};
 },[environment.id]);
 async function changeFullscreen(enabled:boolean){
  if(fullscreenBusy)return;setFullscreenBusy(true);setError('');const stamp=fullscreenEpoch.current,desktop=window.muWindowsDesktop;
  try{
   if(desktop?.setViewerFullscreen){nativeFullscreenRequested.current=enabled;const actual=await desktop.setViewerFullscreen(enabled);if(fullscreenEpoch.current===stamp){nativeFullscreenRequested.current=actual;setFullscreen(actual);}}
   else if(enabled)await surface.current?.requestFullscreen();else if(document.fullscreenElement===surface.current)await document.exitFullscreen();
  }catch(error){if(fullscreenEpoch.current===stamp){nativeFullscreenRequested.current=false;setFullscreen(false);setError((error as Error).message);}}
  finally{if(fullscreenEpoch.current===stamp)setFullscreenBusy(false);}
 }
 useEffect(()=>{
  if(!fullscreen||!window.muWindowsDesktop?.setViewerFullscreen)return;
  const escape=(event:KeyboardEvent)=>{if(event.key!=='Escape'||event.isComposing||event.keyCode===229||document.querySelector('.guest-input-floating:not([hidden]),.guest-translation-expanded,.modal-backdrop'))return;event.preventDefault();event.stopImmediatePropagation();void changeFullscreen(false);};
  window.addEventListener('keydown',escape,true);return()=>window.removeEventListener('keydown',escape,true);
 },[fullscreen,fullscreenBusy]);
 const [imageStatus,setImageStatus]=useState('');const imageRequest=useRef<AbortController|null>(null),imageRevision=useRef(0),imageBusy=useRef(false),imageAvailable=useRef(false);imageAvailable.current=status==='已连接';
 const [receivedImage,setReceivedImage]=useState<ReceivedWindowsImage|null>(null);
 const textComposing=useRef(false),textValue=useRef(''),textRevision=useRef(0),textView=useRef(0),textRequest=useRef<AbortController|null>(null);const [composing,setComposing]=useState(false);
 useEffect(()=>{textView.current++;textRequest.current?.abort();return()=>{textView.current++;textRequest.current?.abort();};},[environment.id,attempt,status,clientApplication,clientViewId]);
 useEffect(()=>{imageRevision.current++;imageRequest.current?.abort();setImageStatus('');setReceivedImage(null);return()=>{imageRevision.current++;imageRequest.current?.abort();};},[environment.id,attempt,status,clientApplication,clientViewId]);
 useEffect(()=>{
  let closed=false,rfb:RFB|undefined;setStatus('连接中');setError('');
  void(async()=>{const ticket=await (clientApplication&&clientViewId?api.windowsDesktopClientTicket(environment.id,clientApplication,clientViewId):api.guestBrowserTicket(environment.id));if(closed||!container.current)return;const FrameBuffer=(await import('@novnc/novnc')).default;if(closed)return;
   rfb=new FrameBuffer(container.current,`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/guest-browser?ticket=${encodeURIComponent(ticket.ticket)}`,{credentials:{password:ticket.password},shared:true});remote.current=rfb;
   rfb.scaleViewport=true;rfb.resizeSession=false;rfb.viewOnly=false;rfb.focusOnClick=true;
   rfb.addEventListener('connect',()=>{if(!closed){setStatus('已连接');rfb!.focus();}});
   rfb.addEventListener('disconnect',()=>{if(!closed)setStatus('已断开');});rfb.addEventListener('securityfailure',()=>{if(!closed){setStatus('连接失败');setError('客体画面认证失败，请重试连接。');}});
  })().catch(e=>{if(!closed){setStatus('连接失败');setError(e.message);}});
  return()=>{closed=true;if(remote.current===rfb)remote.current=null;rfb?.disconnect();};
 },[environment.id,attempt,clientApplication,clientViewId]);
 function editText(value:string){textRevision.current++;textValue.current=value;setText(value);}
 async function paste(){
  if(busy||textComposing.current||!remote.current||status!=='已连接')return;const sent=textValue.current;if(!sent)return;const rfb=remote.current,view=textView.current,revision=textRevision.current,focus=document.activeElement,controller=new AbortController();textRequest.current=controller;setBusy(true);setError('');
  let interacted=false;const invalidate=()=>{interacted=true;};
  document.addEventListener('pointerdown',invalidate,true);document.addEventListener('keydown',invalidate,true);document.addEventListener('focusin',invalidate,true);window.addEventListener('blur',invalidate);
  const current=()=>imageAvailable.current&&!textComposing.current&&remote.current===rfb&&textView.current===view&&textRevision.current===revision&&!interacted&&document.hasFocus()&&(document.activeElement===focus||(focus instanceof HTMLButtonElement&&focus.disabled&&document.activeElement===document.body));
  try{windowsTextDraft(sent);await request(`/environments/${environment.id}/clipboard/write`,{method:'POST',body:JSON.stringify({text:sent}),signal:controller.signal});if(!current()){setError('输入或画面已变化，当前文字已保留；请重新确认粘贴。');return;}rfb.focus();rfb.sendKey(0xffe3,'ControlLeft',true);try{rfb.sendKey(0x76,'KeyV');}finally{rfb.sendKey(0xffe3,'ControlLeft',false);}if(textValue.current===sent)editText('');}
  catch(e){if(textView.current===view)setError((e as Error).message);}finally{document.removeEventListener('pointerdown',invalidate,true);document.removeEventListener('keydown',invalidate,true);document.removeEventListener('focusin',invalidate,true);window.removeEventListener('blur',invalidate);if(textRequest.current===controller)textRequest.current=null;setBusy(false);}
 }
 async function receiveText(){
  if(busy||textComposing.current||status!=='已连接')return;const view=textView.current,revision=textRevision.current,controller=new AbortController();textRequest.current=controller;setBusy(true);setError('');
  try{const result=await request<{text:string}>(`/environments/${environment.id}/clipboard/read`,{method:'POST',body:'{}',signal:controller.signal});if(!imageAvailable.current||textView.current!==view||textRevision.current!==revision||textComposing.current){setError('文字或画面已变化，已保留当前输入；请重新取回。');return;}editText(result.text);}catch(e){if(textView.current===view)setError((e as Error).message);}finally{if(textRequest.current===controller)textRequest.current=null;setBusy(false);}
 }
 async function pasteImage(source?:Blob){
  if(busy||imageBusy.current||!imageAvailable.current||!remote.current)return;const stamp=imageRevision.current,rfb=remote.current;const current=()=>imageAvailable.current&&imageRevision.current===stamp&&remote.current===rfb;
  imageBusy.current=true;setBusy(true);setError('');setImageStatus('正在传入图片…');
  try{const bytes=source?await imageClipboardBlob(source):await readWindowsClipboardImage();if(!current())return;const controller=new AbortController();imageRequest.current=controller;await writeGuestClipboardImage(environment.id,bytes,controller.signal);if(current())setImageStatus('图片已放入客体剪贴板，请在客体中按 Ctrl+V 粘贴。');}
  catch(e){if(current()){setImageStatus('');setError((e as Error).message);}}
  finally{imageBusy.current=false;imageRequest.current=null;setBusy(false);}
 }
 async function navigate(event:React.SubmitEvent<HTMLFormElement>){event.preventDefault();if(addressComposing.current||busy||status!=='已连接')return;setBusy(true);setError('');try{await request(`/environments/${environment.id}/browser/navigate`,{method:'POST',body:JSON.stringify({url:address})});}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function receiveImage(){
  if(busy||imageBusy.current||!imageAvailable.current||!remote.current)return;const stamp=imageRevision.current,rfb=remote.current,current=()=>imageAvailable.current&&imageRevision.current===stamp&&remote.current===rfb,controller=new AbortController();
  imageBusy.current=true;imageRequest.current=controller;setBusy(true);setError('');setReceivedImage(null);setImageStatus('正在取回沙箱图片…');
  try{const result=await readWindowsGuestImage(environment.id,controller.signal);if(current()){setReceivedImage(result);setImageStatus('图片已取回。确认预览后，点击“复制图片到 Windows”。');}}
  catch(e){if(current()){setImageStatus('');setError((e as Error).message);}}
  finally{imageBusy.current=false;if(imageRequest.current===controller)imageRequest.current=null;setBusy(false);}
 }
 async function copyReceivedImage(){
  if(busy||imageBusy.current||!imageAvailable.current||!receivedImage)return;const stamp=imageRevision.current,selected=receivedImage,current=()=>imageAvailable.current&&imageRevision.current===stamp;
  imageBusy.current=true;setBusy(true);setError('');
  try{await copyWindowsReceivedImage(selected);if(current())setImageStatus('图片已复制到 Windows，可在本机应用中粘贴。');}
  catch(e){if(current())setError((e as Error).message);}
  finally{imageBusy.current=false;setBusy(false);}
 }
 async function pasteTool(value:string,signal:AbortSignal){
  const rfb=remote.current,view=textView.current;if(!imageAvailable.current||!rfb)throw Error('画面尚未连接。');windowsTextDraft(value);
  await request(`/environments/${environment.id}/clipboard/write`,{method:'POST',body:JSON.stringify({text:value}),signal});signal.throwIfAborted();
  if(!imageAvailable.current||remote.current!==rfb||textView.current!==view)throw Error('画面已变化，原文已保留。');rfb.focus();rfb.sendKey(0xffe3,'ControlLeft',true);try{rfb.sendKey(0x76,'KeyV');}finally{rfb.sendKey(0xffe3,'ControlLeft',false);}
 }
 function toolKey(key:'backspace'|'enter'){if(imageAvailable.current&&remote.current){remote.current.focus();remote.current.sendKey(key==='enter'?0xff0d:0xff08,key==='enter'?'Enter':'Backspace');}}
 const frame=guestPresentation(display??displayPixels(DEFAULT_FIXED_DISPLAY),view.width,view.height,view.density,presentation);
 // Disabling the submitting button blurs it. That is not a draft or target
 // change; edits, other focus changes and transport changes still invalidate.
 return <section className={`windows-browser${fullscreen?' windows-browser-fullscreen':''}`} ref={surface} onPointerDownCapture={()=>{if(textRequest.current)textRevision.current++;}} onBlurCapture={event=>{if(textRequest.current&&!(event.target instanceof HTMLButtonElement&&event.target.disabled))textRevision.current++;}}>
  <SectionHeading title={title} subtitle={status} action={<><GuestTimezoneClock timezone={environment.identity.timezone}/>{window.__MU_CONFIG__.capabilities?.files&&<GuestExchangePanel key={environment.id} id={environment.id} connected={status==='已连接'} dropTarget={surface} onReturn={()=>remote.current?.focus()}/ >}{window.__MU_CONFIG__.capabilities?.translation&&<WindowsTextTools id={environment.id} connected={status==='已连接'} onPaste={pasteTool} onKey={toolKey}/ >}{window.__MU_CONFIG__.capabilities?.audio&&<GuestAudio id={environment.id} connected={status==='已连接'}/>}<Button aria-expanded={settings} aria-label="显示设置" onClick={()=>setSettings(value=>!value)}>显示设置</Button><Button aria-label="重新连接画面" onClick={()=>retry(value=>value+1)} icon={<RefreshCw size={15}/>}/><Button aria-label={fullscreen?'退出全屏':'全屏画面'} disabled={fullscreenBusy} title={fullscreen?'退出全屏 · Esc':'全屏画面'} onClick={()=>void changeFullscreen(!fullscreen)} icon={fullscreen?<Minimize2 size={15}/>:<Maximize2 size={15}/>}>{fullscreen?'退出全屏':null}</Button></>}/>
  {settings&&<div className="guest-browser-keyboard windows-display-settings"><Button disabled={status!=='已连接'||!displayLoaded} title="重新绘制完整画面，保留当前网页和连接" onClick={()=>refreshFrame.current()}>重绘画面</Button><label>虚拟桌面 <select aria-label="虚拟桌面模式" disabled={status!=='已连接'||!displayLoaded} value={preference.mode} onChange={event=>editDisplay(event.target.value==='fixed'?{...DEFAULT_FIXED_DISPLAY}:{...preference,mode:'adaptive'})}><option value="fixed">固定尺寸 · {desktopClient?'本次共享桌面会话':'本次浏览器会话'}</option><option value="adaptive">随查看窗口调整</option></select></label>{preference.mode==='fixed'&&<label>桌面尺寸 <select aria-label="固定桌面尺寸" disabled={status!=='已连接'||!displayLoaded} value={preference.cssWidth+'x'+preference.cssHeight} onChange={event=>{const [cssWidth,cssHeight]=event.target.value.split('x').map(Number);editDisplay({cssWidth,cssHeight,scaleFactor:2,mode:'fixed'});}}>{FIXED_DISPLAY_PRESETS.map(value=><option key={value.cssWidth} value={value.cssWidth+'x'+value.cssHeight}>{value.cssWidth}×{value.cssHeight} · 2×</option>)}</select></label>}<label>查看方式 <select aria-label="画面查看方式" value={presentation} onChange={event=>setPresentation(event.target.value as PresentationMode)}><option value="native">原始像素 · 清晰 / 可滚动</option><option value="fit">适合窗口 · 只缩小</option></select></label><span role="status">{!displayLoaded?'正在读取显示设置…':displayBusy?'正在调整实际桌面…':preference.mode==='fixed'?'窗口与全屏变化保持真实桌面和 2× 密度。':'窗口和屏幕密度变化会调整真实桌面。'}</span><Button disabled={displayBusy||status!=='已连接'||!displayLoaded} onClick={()=>{appliedDisplay.current='';editDisplay({...preference});}}>重新应用</Button></div>}
  {showNavigation&&<form className="windows-address" onSubmit={event=>void navigate(event)} onKeyDown={event=>{if(event.key==='Enter'&&(addressComposing.current||event.nativeEvent.isComposing||event.keyCode===229)){event.preventDefault();event.stopPropagation();}}}><input type="url" aria-label="浏览器网址" placeholder="输入 HTTP 或 HTTPS 网址后打开" value={address} onChange={event=>setAddress(event.target.value)} onCompositionStart={()=>{addressComposing.current=true;}} onCompositionEnd={event=>{addressComposing.current=false;setAddress(event.currentTarget.value);}} required/><Button type="submit" disabled={busy||status!=='已连接'}>打开网址</Button></form>}
  {error&&<Notice kind="error">{error}</Notice>}<div className={`windows-browser-canvas ${presentation==='native'?'windows-browser-native':''}`} ref={viewport}><div style={{width:Math.max(view.width,frame.width),height:Math.max(view.height,frame.height),display:'flex',alignItems:'center',justifyContent:'center'}}><div className="windows-browser-frame" ref={container} style={{width:frame.width,height:frame.height,flexShrink:0}}/></div></div>
  <details className="windows-input-fallback"><summary>备用输入与图片工具</summary><div className="windows-terminal-input"><label>中文与多行输入<textarea aria-label="浏览器待粘贴文字" value={text} maxLength={65536} onChange={event=>editText(event.target.value)} onCompositionStart={()=>{textRevision.current++;textComposing.current=true;setComposing(true);}} onCompositionEnd={event=>{textComposing.current=false;setComposing(false);editText(event.currentTarget.value);}} onKeyDown={event=>{if(windowsPasteShortcut(event.nativeEvent,textComposing.current)){event.preventDefault();void paste();}}}/></label><Button disabled={busy||composing||status!=='已连接'||!text} onClick={()=>void paste()}>粘贴到客体</Button><Button disabled={busy||composing||status!=='已连接'} onClick={()=>void receiveText()}>取回客体文字</Button><small>先点击客体输入框。Ctrl+Enter 粘贴，候选选字时不会触发；最多64 KiB，不自动发送。</small></div>
  {window.__MU_CONFIG__.capabilities?.imageClipboard&&<div className="windows-image-clipboard" tabIndex={0} role="group" aria-label="图片粘贴区" onPaste={event=>{const image=Array.from(event.clipboardData.files).find(file=>file.type.startsWith('image/'));if(image){event.preventDefault();void pasteImage(image);}}}><div><strong>剪贴板图片</strong><small>复制图片后点按钮，或在此处按 Ctrl+V。最多 10 MiB、1600 万像素。</small></div><Button icon={<Image size={15}/>} disabled={busy||status!=='已连接'} onClick={()=>void pasteImage()}>粘贴图片到沙箱</Button><Button disabled={busy||status!=='已连接'} onClick={()=>void receiveImage()}>取回沙箱图片</Button>{receivedImage&&<div className="windows-image-preview"><img src={'data:image/png;base64,'+receivedImage.data} alt="取回的沙箱剪贴板图片"/><small>{receivedImage.width} × {receivedImage.height} · 仅预览，点击后复制</small><Button disabled={busy||status!=='已连接'||!window.muWindowsDesktop?.writeClipboardImage} onClick={()=>void copyReceivedImage()}>复制图片到 Windows</Button></div>}{imageStatus&&<p role="status">{imageStatus}</p>}</div>}
 </details></section>;
}
