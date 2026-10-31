import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type ClipboardEvent,type KeyboardEvent,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {Button,Modal,Notice} from './components.tsx';
import {request} from './api.ts';
import TranslationSettings from './TranslationSettings.tsx';
import {useFloatingTool} from './useFloatingTool.ts';
import {CLIPBOARD_MAX_BYTES} from '../shared/guest-exchange.ts';
import {TRANSLATION_INPUT_LIMIT,TRANSLATION_OUTPUT_LIMIT,translationTarget,type TranslationDirection,type TextTranslation} from '../shared/translation.ts';

export default function GuestTextInput({id,connected,onPaste,onKey,onClose,onReadText,terminal=false,floating=false,visible=true,anchorRef,hostName='Mac',hostClipboard}:{id:string;connected:boolean;onClose?:()=>void;onPaste:(text:string)=>Promise<void>;onKey:(key:'backspace'|'enter')=>void;onReadText?:()=>Promise<string>;terminal?:boolean;floating?:boolean;visible?:boolean;anchorRef?:RefObject<HTMLButtonElement|null>;hostName?:'Mac'|'Windows';hostClipboard?:{readText:()=>Promise<string>;writeText:(text:string)=>Promise<unknown>}}){
 const [text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const [translated,setTranslated]=useState<string|null>(null),[translating,setTranslating]=useState(false);
 const [receivedDraft,setReceivedDraft]=useState<{text:string;translate:boolean}|null>(null);
 const [direction,setDirection]=useState<TranslationDirection>('auto'),[expanded,setExpanded]=useState(false),[fontSize,setFontSize]=useState(16);
 const directionChosen=useRef(false);
 const floatingElement=useRef<HTMLDivElement>(null);
 const placement=useFloatingTool(floatingElement,floating&&visible&&!expanded,()=>{const anchor=anchorRef?.current?.getBoundingClientRect();return{x:(anchor?.right??innerWidth-12)-460,y:(anchor?.bottom??12)+8,width:460};});
 const originalInput=useRef<HTMLTextAreaElement>(null),translatedInput=useRef<HTMLTextAreaElement>(null);
 const [portalTarget,setPortalTarget]=useState<Element|null>(null);
 useEffect(()=>{const update=()=>setPortalTarget(document.fullscreenElement??document.body);update();document.addEventListener('fullscreenchange',update);return()=>document.removeEventListener('fullscreenchange',update);},[]);
 useEffect(()=>{
  if(!floating||!visible||expanded)return;
  const outside=(event:PointerEvent)=>{const target=event.target as Node;if(!composing.current&&!floatingElement.current?.contains(target)&&!anchorRef?.current?.contains(target))onClose?.();};
  document.addEventListener('pointerdown',outside,true);return()=>document.removeEventListener('pointerdown',outside,true);
 },[floating,visible,expanded,onClose,anchorRef]);
 const more=useRef<HTMLDetailsElement>(null),expandButton=useRef<HTMLButtonElement>(null);
 const working=useRef(false),composing=useRef(false),generation=useRef(0),pending=useRef<AbortController|null>(null);
 useLayoutEffect(()=>{
  if(!connected)setExpanded(false);
  return()=>{generation.current++;pending.current?.abort();pending.current=null;working.current=false;composing.current=false;setBusy(false);setTranslating(false);setReceivedDraft(null);};
 },[id,connected]);
 function current(token:number){return token===generation.current;}
 function cancelTranslation(){
  if(!translating||!pending.current)return;
  generation.current++;pending.current.abort();pending.current=null;working.current=false;setBusy(false);setTranslating(false);setError('');
  setMessage('已取消等待，原文已保留。已发送的请求可能仍由服务处理。');
 }
 function closeExpanded(){if(composing.current)return;setExpanded(false);requestAnimationFrame(()=>expandButton.current?.focus());}
 function clearOriginal(){if(composing.current)return;setReceivedDraft(null);setText('');setTranslated(null);setMessage('');setError('');directionChosen.current=false;setDirection('auto');}
 function editOriginal(value:string){setReceivedDraft(null);setText(value);setTranslated(null);setMessage('');setError('');if(!value.trim())directionChosen.current=false;if(!directionChosen.current)setDirection('auto');}
 async function editClipboard(action:'copy'|'paste',target:'original'|'translation'){
  if(working.current||composing.current)return;
  const input=(target==='original'?originalInput:translatedInput).current;if(!input)return;
  const value=input.value,start=input.selectionStart,end=input.selectionEnd,token=generation.current;
  working.current=true;setBusy(true);setError('');setMessage('');
  try{
   if(action==='copy'){
    await (hostClipboard??navigator.clipboard).writeText(start===end?value:value.slice(start,end));
    if(current(token))setMessage(`已复制到 ${hostName} 剪贴板。`);
   }else{
    const incoming=await (hostClipboard??navigator.clipboard).readText();if(!current(token))return;
    if(!incoming)throw new Error('剪贴板中没有可粘贴的普通文字，原有草稿已保留。');
    const next=value.slice(0,start)+incoming+value.slice(end),limit=target==='original'?TRANSLATION_INPUT_LIMIT:TRANSLATION_OUTPUT_LIMIT;
    if(next.length>limit||next.includes('\0'))throw new Error(`粘贴内容须为 ${limit.toLocaleString()} 字以内的普通文本。`);
    if(target==='original')editOriginal(next);else setTranslated(next);
    requestAnimationFrame(()=>{if(current(token)){input.focus();input.setSelectionRange(start+incoming.length,start+incoming.length);}});
    setMessage('已粘贴到小窗，未发送到沙箱。');
   }
  }catch(e){if(current(token))setError((e as Error).message||`剪贴板不可用，请使用右键菜单或 ${hostName==='Windows'?'Ctrl+C / Ctrl+V':'⌘C / ⌘V'}。`);}
  finally{if(current(token)){working.current=false;setBusy(false);}}
 }
 function nativePaste(event:ClipboardEvent<HTMLTextAreaElement>,limit:number){
  const input=event.currentTarget,incoming=event.clipboardData.getData('text/plain');
  if(input.value.length-input.selectionEnd+input.selectionStart+incoming.length>limit||incoming.includes('\0')){
   event.preventDefault();setError(`粘贴内容须为 ${limit.toLocaleString()} 字以内的普通文本；原有草稿已保留。`);
  }
 }
 function inputKeyDown(event:KeyboardEvent<HTMLTextAreaElement>,value:string){
  if(event.nativeEvent.isComposing||composing.current||event.keyCode===229)return;
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(expanded)closeExpanded();else onClose?.();}
  if(event.key==='Enter'&&(hostName==='Windows'?event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey:event.metaKey||event.ctrlKey)){event.preventDefault();void paste(value);}
 }
 function textTools(target:'original'|'translation'){
  const value=target==='original'?text:translated;
  return <div className="guest-text-tools"><span>{target==='original'?'原文':'译文 · 可修改'}</span>{target==='original'&&<button type="button" className="guest-receive-translate" disabled={busy||!connected} title={terminal?'读取当前终端选中文字并交给 DeepSeek 翻译':'读取 Linux 剪贴板并交给 DeepSeek 翻译；请先在沙箱内复制'} onClick={()=>void receive(true)}>取回并翻译</button>}<button type="button" disabled={busy||!value} onMouseDown={event=>event.preventDefault()} onClick={()=>void editClipboard('copy',target)}>复制</button><button type="button" disabled={busy} onMouseDown={event=>event.preventDefault()} onClick={()=>void editClipboard('paste',target)}>粘贴</button><button type="button" disabled={busy||!value} onClick={()=>{if(composing.current)return;if(target==='original')clearOriginal();else{setTranslated('');setMessage('');}}}>清空</button></div>;
 }
 async function paste(value=text){
  if(working.current||composing.current||!connected||!value)return;
  if(new TextEncoder().encode(value).length>CLIPBOARD_MAX_BYTES){setError('文字超过沙箱单次可粘贴的 64 KiB。可选中部分文字复制，再分段粘贴。');return;}
  const token=generation.current;working.current=true;setBusy(true);setError('');setMessage('正在粘贴到沙箱，请稍候…');
  try{await onPaste(value);if(current(token)){setMessage('已粘贴，未发送。');setExpanded(false);onClose?.();}}
  catch(e){if(current(token)){setMessage('');setError((e as Error).message);}}
  finally{if(current(token)){working.current=false;setBusy(false);}}
 }
 async function translateValue(value:string,token:number,signal:AbortSignal,targetDirection=direction){
  if(value.length>TRANSLATION_INPUT_LIMIT)throw new Error(`每次最多翻译 ${TRANSLATION_INPUT_LIMIT.toLocaleString()} 字，请分段翻译。`);
  if(targetDirection==='auto'&&!/\p{L}/u.test(value))throw new Error('这段内容只有数字或符号，无法判断翻译方向。请选择“中 → 英”或“英 → 中”。');
  setTranslating(true);
  const result=await request<TextTranslation>(`/environments/${id}/translate-text`,{method:'POST',body:JSON.stringify({text:value,direction:targetDirection}),signal});
  if(current(token))setTranslated(result.text);
 }
 async function translate(){
  if(working.current||!connected||composing.current||!text.trim())return;
  setReceivedDraft(null);
  const token=generation.current,controller=new AbortController();pending.current=controller;
  working.current=true;setBusy(true);setError('');setMessage('');if(hostName!=='Windows')setTranslated(null);
  try{await translateValue(text,token,controller.signal);}
  catch(e){if(current(token))setError((e as Error).message+(hostName==='Windows'&&translated!==null?' 上次译文已保留。':''));}finally{if(current(token)){working.current=false;setBusy(false);setTranslating(false);pending.current=null;}}
 }
 async function receive(andTranslate=false){
  if(working.current||!connected||composing.current)return;
  setReceivedDraft(null);
  const token=generation.current,controller=new AbortController();pending.current=controller;
  working.current=true;setBusy(true);setError('');setMessage('');
  try{
   const value=onReadText?{text:await onReadText()}:await request<{text:string}>(`/environments/${id}/clipboard/read`,{method:'POST',body:'{}',signal:controller.signal});
   if(!current(token))return;
   if(!value.text.trim())throw new Error(terminal?'请先在当前终端中选中文字。':'沙箱剪贴板为空，请先在沙箱中选中文字并复制。');
   if(value.text.length>TRANSLATION_INPUT_LIMIT||value.text.includes('\0'))throw new Error(`取回的文字须为 ${TRANSLATION_INPUT_LIMIT.toLocaleString()} 字以内的普通文本；当前草稿已保留。`);
   if(hostName==='Windows'&&text.trim()&&text!==value.text){setReceivedDraft({text:value.text,translate:andTranslate});return;}
   await applyReceived(value.text,andTranslate,token,controller.signal);
  }catch(e){if(current(token))setError((e as Error).message);}finally{if(current(token)){working.current=false;setBusy(false);setTranslating(false);pending.current=null;}}
 }
 async function applyReceived(value:string,andTranslate:boolean,token:number,signal:AbortSignal){
  setReceivedDraft(null);setText(value);setTranslated(null);
  if(andTranslate){const targetDirection=directionChosen.current?direction:'zh';setDirection(targetDirection);await translateValue(value,token,signal,targetDirection);}
  else {if(!directionChosen.current)setDirection('auto');setMessage(terminal?'已取回终端选中文字，请核对后再使用。':'已取回沙箱剪贴板文字，请核对后再使用。');}
 }
 async function replaceReceived(){
  if(!receivedDraft||working.current||composing.current||!connected)return;
  const value=receivedDraft,token=generation.current,controller=new AbortController();pending.current=controller;working.current=true;setBusy(true);setError('');setMessage('');
  try{await applyReceived(value.text,value.translate,token,controller.signal);}
  catch(e){if(current(token))setError((e as Error).message);}finally{if(current(token)){working.current=false;setBusy(false);setTranslating(false);pending.current=null;}}
 }
 const content=<section className={`guest-text-input ${expanded?'guest-text-input-expanded':''}`} aria-label="中文快捷输入" style={expanded?{'--translation-font-size':`${fontSize}px`} as CSSProperties:undefined}>
  {!expanded&&<div className={`guest-input-heading ${floating?'floating-tool-drag':''}`} {...(floating?placement.drag:{})} title={floating?'拖动标题可移动小窗':undefined}><strong>中文输入</strong><span>{hostName} 输入法</span><button ref={expandButton} type="button" className="guest-input-expand" onClick={()=>{if(!composing.current)setExpanded(true);}}>放大查看</button><button type="button" className="guest-input-close" aria-label="收起中文输入" title="收起，保留草稿" onClick={dismiss}>×</button></div>}
  {expanded&&<div className="guest-reader-toolbar"><span>原文 {text.length.toLocaleString()} / {TRANSLATION_INPUT_LIMIT.toLocaleString()} 字</span><div><Button aria-label="缩小阅读字号" disabled={fontSize<=14} onClick={()=>setFontSize(size=>size-2)}>A−</Button><span aria-live="polite">{fontSize}px</span><Button aria-label="放大阅读字号" disabled={fontSize>=24} onClick={()=>setFontSize(size=>size+2)}>A＋</Button><Button onClick={closeExpanded}>返回小窗</Button></div></div>}
  <div className={`guest-translation-editors ${translated!==null?'has-translation':''}`}>
   <div className="guest-original-editor">{textTools('original')}
    <textarea ref={originalInput} onPaste={event=>nativePaste(event,TRANSLATION_INPUT_LIMIT)} aria-label="中文或其他文字" rows={2} maxLength={TRANSLATION_INPUT_LIMIT} value={text} disabled={busy} placeholder={terminal?'输入文字，粘贴到当前终端；不自动执行…':'先点沙箱输入框，再在这里输入…'} onChange={event=>editOriginal(event.target.value)}
     onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={event=>{composing.current=false;if(event.currentTarget.value!==text)editOriginal(event.currentTarget.value);}}
     onKeyDown={event=>inputKeyDown(event,text)}/>
    <div className="guest-translation-actions"><div className="guest-translation-options"><select className="guest-translation-direction" aria-label="翻译方向" value={direction} disabled={busy} onChange={event=>{directionChosen.current=true;setDirection(event.target.value as TranslationDirection);setTranslated(null);setError('');}}><option value="auto">自动互译</option><option value="en">中 → 英</option><option value="zh">英 → 中</option></select></div><div className="guest-translation-submit"><Button title="仅点击时将原文交给 DeepSeek，使用沙箱网络与已配置的 Key" disabled={busy||!connected||!text.trim()} onClick={()=>void translate()}>{translating?'翻译中…':direction==='auto'&&!/\p{L}/u.test(text)?'翻译':translationTarget(text,direction)==='en'?'翻译成英文':'翻译成中文'}</Button><Button className="primary" title={`${hostName==='Windows'?'Ctrl+Enter':'⌘Enter / Ctrl+Enter'}；粘贴后自动收起，不发送`} disabled={busy||!connected||!text} onClick={()=>void paste()}>粘贴原文</Button></div></div>
   </div>
   {translated!==null&&<div className="guest-translation-result">{textTools('translation')}<textarea ref={translatedInput} onPaste={event=>nativePaste(event,TRANSLATION_OUTPUT_LIMIT)} id={`translation-${id}`} aria-label="译文" value={translated} maxLength={TRANSLATION_OUTPUT_LIMIT} rows={3} disabled={busy} onChange={event=>setTranslated(event.target.value)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={event=>{composing.current=false;if(event.currentTarget.value!==translated)setTranslated(event.currentTarget.value);}} onKeyDown={event=>inputKeyDown(event,translated)}/><Button className="primary" disabled={busy||!connected||!translated.trim()} onClick={()=>void paste(translated)}>粘贴译文</Button></div>}
  </div>
  {hostName==='Windows'&&translating&&<Button onClick={cancelTranslation}>取消翻译</Button>}
  {receivedDraft&&<div role="status" className="guest-input-actions"><span>取回的文字会替换当前草稿。</span><Button disabled={busy} onClick={()=>void replaceReceived()}>{receivedDraft.translate?'替换并翻译':'替换草稿'}</Button><Button disabled={busy} onClick={()=>setReceivedDraft(null)}>保留当前草稿</Button></div>}
  <small className="guest-translation-disclosure">DeepSeek Flash · 点击翻译才发送原文</small>
  {error&&<Notice kind="error">{error}</Notice>}{message&&<p role="status">{message}</p>}
  <details ref={more} className="guest-input-more"><summary>帮助与更多操作 <span>{hostName==='Windows'?'Ctrl+Enter':'⌘Enter'} 粘贴</span></summary>
   <TranslationSettings hostName={hostName} onSaved={()=>{if(more.current)more.current.open=false;}} />
   <p>{terminal?'选中当前终端中的文字，点击“取回并翻译”。文字粘贴到终端光标处，不自动按回车执行；多行需要终端支持安全粘贴。':'在 Linux 内复制文字，再点“取回并翻译”；只想取回文字可用下方按钮。先点沙箱输入框，再粘贴原文或译文，不会按回车发送。'}取回并翻译默认英 → 中，可手选方向；清空原文后恢复自动互译。点小窗外部可收起并保留草稿，拖动标题可移动，右下角可调整大小。文本框支持右键剪切、复制、粘贴、全选；复制和粘贴小按钮操作的是 {hostName} 剪贴板。</p>
   <p>每次最多翻译 {TRANSLATION_INPUT_LIMIT.toLocaleString()} 字，保留段落、换行和列表；模型可能改变格式，请核对译文。自动互译：有中文时译成英文，纯英文时译成中文；混合文本可手选方向。模型只翻译，不回答问题。失败时保留原文，不自动重试、不改用 {hostName} 直连。原文、译文和 Key 不写入应用日志。</p>
   <div className="guest-input-actions"><Button disabled={busy||!connected} onClick={()=>void receive()}>{terminal?'取回终端选中文字':'取回沙箱文字'}</Button><Button disabled={busy||!text} onClick={clearOriginal}>清空草稿</Button><Button disabled={busy||!connected} onClick={()=>{if(!composing.current)onKey('backspace');}}>退格</Button><Button disabled={busy||!connected} onClick={()=>{if(!composing.current)onKey('enter');}}>回车</Button></div>
  </details>
 </section>;
 // Portal avoids clipping by the compact tool and the remote display's overflow.
 function dismiss(){if(composing.current)return;setExpanded(false);onClose?.();}
 if(expanded&&connected&&visible)return createPortal(<div className="guest-translation-expanded"><Modal title="中文输入与翻译" subtitle="拖动标题移动 · 右下角调整大小 · 草稿保留" movable onClose={closeExpanded} onBackdropClose={dismiss}>{content}</Modal></div>,portalTarget??document.body);
 if(floating)return createPortal(<div ref={floatingElement} className="guest-input-container guest-input-floating" hidden={!visible} style={placement.style}>{content}<button type="button" className="floating-tool-resize" aria-label="调整翻译小窗大小" title="拖动调整大小；方向键微调" {...placement.resize}>◢</button></div>,portalTarget??document.body);
 return content;
}
