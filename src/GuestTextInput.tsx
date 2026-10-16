import {useRef,useState,type KeyboardEvent} from 'react';
import {Button,Notice} from './components.tsx';
import {request} from './api.ts';

export default function GuestTextInput({id,connected,onPaste,onKey,onClose,onReadText,terminal=false}:{id:string;connected:boolean;onClose?:()=>void;onPaste:(text:string)=>Promise<void>;onKey:(key:'backspace'|'enter')=>void;onReadText?:()=>Promise<string>;terminal?:boolean}){
 const [text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const [translated,setTranslated]=useState<string|null>(null),[translating,setTranslating]=useState(false);
 const originalInput=useRef<HTMLTextAreaElement>(null),translatedInput=useRef<HTMLTextAreaElement>(null);
 const working=useRef(false),composing=useRef(false);
 async function editClipboard(action:'copy'|'paste',target:'original'|'translation'){
  if(working.current||composing.current)return;
  const input=(target==='original'?originalInput:translatedInput).current;if(!input)return;
  const value=input.value,start=input.selectionStart,end=input.selectionEnd;
  working.current=true;setBusy(true);setError('');setMessage('');
  try{
   if(action==='copy'){
    await navigator.clipboard.writeText(start===end?value:value.slice(start,end));
    setMessage('已复制到 Mac 剪贴板。');
   }else{
    const incoming=await navigator.clipboard.readText();
    const next=value.slice(0,start)+incoming+value.slice(end);
    if(next.length>16000||next.includes('\0'))throw new Error('粘贴内容须为 16000 字以内的普通文本。');
    if(target==='original'){setText(next);setTranslated(null);}else setTranslated(next);
    requestAnimationFrame(()=>{input.focus();input.setSelectionRange(start+incoming.length,start+incoming.length);});
    setMessage('已粘贴到小窗，未发送到沙箱。');
   }
  }catch(e){setError((e as Error).message||'剪贴板不可用，请使用右键菜单或 ⌘C / ⌘V。');}
  finally{working.current=false;setBusy(false);}
 }
 function inputKeyDown(event:KeyboardEvent<HTMLTextAreaElement>,value:string){
  if(event.nativeEvent.isComposing||composing.current||event.keyCode===229)return;
  if(event.key==='Escape'){event.preventDefault();onClose?.();}
  if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();void paste(value);}
 }
 function textTools(target:'original'|'translation'){
  const value=target==='original'?text:translated;
  return <div className="guest-text-tools"><span>{target==='original'?'原文':'英文译文 · 可修改'}</span><button type="button" disabled={busy||!value} onMouseDown={event=>event.preventDefault()} onClick={()=>void editClipboard('copy',target)}>复制</button><button type="button" disabled={busy} onMouseDown={event=>event.preventDefault()} onClick={()=>void editClipboard('paste',target)}>粘贴</button><button type="button" disabled={busy||!value} onClick={()=>{if(target==='original'){setText('');setTranslated(null);}else setTranslated('');setMessage('');}}>清空</button></div>;
 }
 async function paste(value=text){
  if(working.current||composing.current||!connected||!value)return;
  working.current=true;setBusy(true);setError('');setMessage('');
  try{await onPaste(value);setMessage('已粘贴，未发送。');onClose?.();}
  catch(e){setError((e as Error).message);}
  finally{working.current=false;setBusy(false);}
 }
 async function translate(){
  if(working.current||!connected||composing.current||!text.trim())return;
  if(text.length>2000){setError('每次最多翻译 2000 字，请分段翻译。');return;}
  working.current=true;setBusy(true);setTranslating(true);setError('');setMessage('');setTranslated(null);
  try{const result=await request<{text:string}>(`/environments/${id}/translate-text`,{method:'POST',body:JSON.stringify({text})});setTranslated(result.text);}
  catch(e){setError((e as Error).message);}finally{working.current=false;setBusy(false);setTranslating(false);}
 }
 async function receive(){
  if(working.current||!connected)return;
  working.current=true;setBusy(true);setError('');setMessage('');
  try{const value=onReadText?{text:await onReadText()}:await request<{text:string}>(`/environments/${id}/clipboard/read`,{method:'POST',body:'{}'});if(!value.text)throw new Error(terminal?'请先在当前终端中选中文字。':'沙箱剪贴板为空，请先在沙箱中选中文字并复制。');if(value.text.length>16000)throw new Error('文字过长，请分段取回。');setText(value.text);setTranslated(null);setMessage(terminal?'已取回终端选中文字，请核对后再使用。':'已取回沙箱剪贴板文字，请核对后再使用。');}
  catch(e){setError((e as Error).message);}finally{working.current=false;setBusy(false);}
 }
 return <section className="guest-text-input" aria-label="中文快捷输入">
  <div className="guest-input-heading"><strong>中文输入</strong><span>Mac 输入法</span><button type="button" className="guest-input-close" aria-label="收起中文输入" title="收起，保留草稿" onClick={onClose}>×</button></div>
  {textTools('original')}
  <textarea ref={originalInput} aria-label="中文或其他文字" rows={2} maxLength={16000} value={text} disabled={busy} placeholder={terminal?'输入文字，粘贴到当前终端；不自动执行…':'先点沙箱输入框，再在这里输入…'} onChange={event=>{setText(event.target.value);setTranslated(null);setMessage('');}}
   onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
   onKeyDown={event=>inputKeyDown(event,text)}/>
  <div className="guest-input-actions"><Button className="primary" title="⌘Enter / Ctrl+Enter；粘贴后自动收起，不发送" disabled={busy||!connected||!text} onClick={()=>void paste()}>{busy&&!translating?'处理中…':'粘贴原文'}</Button><Button title="仅点击时将原文交给 Google，使用沙箱网络" disabled={busy||!connected||!text.trim()} onClick={()=>void translate()}>{translating?'翻译中…':'翻译成英文'}</Button></div>
  <small className="guest-translation-disclosure">Google · 点击翻译才发送原文</small>
  {translated!==null&&<div className="guest-translation-result">{textTools('translation')}<textarea ref={translatedInput} id={`translation-${id}`} aria-label="英文译文" value={translated} maxLength={16000} rows={3} disabled={busy} onChange={event=>setTranslated(event.target.value)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event=>inputKeyDown(event,translated)}/><Button className="primary" disabled={busy||!connected||!translated.trim()} onClick={()=>void paste(translated)}>粘贴译文</Button></div>}
  <details className="guest-input-more"><summary>帮助与更多操作 <span>⌘Enter 粘贴</span></summary>
   <p>{terminal?'文字粘贴到当前终端光标处，不自动按回车执行；多行需要终端支持安全粘贴。':'先点击沙箱输入框，再输入中文。粘贴到沙箱后自动收起，不会按回车发送；'}草稿保留。文本框支持右键剪切、复制、粘贴、全选；小按钮操作的是 Mac 剪贴板。</p>
   <p>译文直接显示在这里，核对后再粘贴。Google 公共翻译接口可能限流，失败时保留原文，不改用 Mac 直连。原文、译文不写入应用日志。</p>
   <div className="guest-input-actions"><Button disabled={busy||!connected} onClick={()=>void receive()}>{terminal?'取回终端选中文字':'取回沙箱文字'}</Button><Button disabled={busy||!text} onClick={()=>{setText('');setTranslated(null);setMessage('');setError('');}}>清空草稿</Button><Button disabled={busy||!connected} onClick={()=>onKey('backspace')}>退格</Button><Button disabled={busy||!connected} onClick={()=>onKey('enter')}>回车</Button></div>
  </details>
  {error&&<Notice kind="error">{error}</Notice>}{message&&<p role="status">{message}</p>}
 </section>;
}
