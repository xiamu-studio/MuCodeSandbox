import {useLayoutEffect,useEffect,useRef,useState} from 'react';
import {Keyboard} from 'lucide-react';
import GuestTextInput from '../GuestTextInput.tsx';
import {windowsTextDraft} from './text-input.ts';

async function clipboardText(action:'read'|'write',value?:string){
 try{const desktop=window.muWindowsDesktop;if(action==='read')return desktop?.readClipboardText?await desktop.readClipboardText():await navigator.clipboard.readText();if(desktop?.writeClipboardText)await desktop.writeClipboardText(value!);else await navigator.clipboard.writeText(value!);return '';}
 catch(error){throw Error((error as Error).message.replace(/^Error invoking remote method 'mu-windows:clipboard-text': (?:Error: )?/,''));}
}
const hostClipboard={readText:()=>clipboardText('read'),writeText:(value:string)=>clipboardText('write',value)};
export default function WindowsTextTools({id,connected,onPaste,onReadText,onKey,terminal=false}:{id:string;connected:boolean;onPaste:(value:string,signal:AbortSignal)=>Promise<void>;onReadText?:()=>Promise<string>;onKey:(key:'backspace'|'enter')=>void;terminal?:boolean}){
 const [open,setOpen]=useState(false),anchor=useRef<HTMLButtonElement>(null),opened=useRef(false),available=useRef(connected),composing=useRef(false),epoch=useRef(0),pending=useRef<AbortController|null>(null);available.current=connected;
 function cancel(){epoch.current++;pending.current?.abort();pending.current=null;}
 function show(value:boolean){cancel();opened.current=value;setOpen(value);}
 useLayoutEffect(()=>{composing.current=false;show(false);return()=>{opened.current=false;cancel();};},[id,connected]);
 useEffect(()=>{if(!connected)return;const start=()=>{composing.current=true;},end=()=>{composing.current=false;},key=(event:KeyboardEvent)=>{if(composing.current||event.isComposing||event.keyCode===229||event.repeat||!event.ctrlKey||!event.shiftKey||event.altKey||event.metaKey||event.code!=='KeyY')return;event.preventDefault();event.stopImmediatePropagation();show(!opened.current);};window.addEventListener('compositionstart',start,true);window.addEventListener('compositionend',end,true);window.addEventListener('keydown',key,true);return()=>{window.removeEventListener('compositionstart',start,true);window.removeEventListener('compositionend',end,true);window.removeEventListener('keydown',key,true);};},[connected]);
 async function paste(value:string){
  if(!available.current||!opened.current)throw Error('输入窗口已变化，请重新打开后粘贴。');windowsTextDraft(value);
  const token=epoch.current,abort=new AbortController();pending.current=abort;
  try{await onPaste(value,abort.signal);if(token!==epoch.current||!available.current||!opened.current)throw Error('输入窗口已变化，原文已保留。');}
  finally{if(pending.current===abort)pending.current=null;}
 }
 return <><button ref={anchor} type="button" className={`button guest-exchange-button ${open?'selected':''}`} aria-label="中文输入与翻译" title="中文输入与翻译 · Ctrl+Shift+Y" aria-expanded={open} disabled={!connected} onClick={()=>show(!opened.current)}><Keyboard size={16}/><span>中文与翻译</span></button><GuestTextInput key={id} id={id} hostName="Windows" hostClipboard={hostClipboard} floating visible={open} connected={connected&&open} anchorRef={anchor} terminal={terminal} onPaste={paste} onReadText={onReadText} onKey={onKey} onClose={()=>show(false)}/></>;
}
