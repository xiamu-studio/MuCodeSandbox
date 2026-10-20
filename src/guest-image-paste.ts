import {useEffect,useRef,useState,type RefObject} from 'react';
import type RFB from '@novnc/novnc';
import {readMacClipboardImage,imageClipboardBlob,writeGuestClipboardImage} from './clipboard-image.ts';

// Only the focused remote canvas owns this shortcut. Local forms retain their
// native paste behavior; clipboard reads always follow a real key/paste gesture.
export function useGuestImagePaste({id,active,connected,container,remote}:{id:string;active:boolean;connected:boolean;container:RefObject<HTMLDivElement|null>;remote:RefObject<RFB|null>}){
 const [status,setStatus]=useState(''),[error,setError]=useState('');
 const revision=useRef(0),busy=useRef(false),available=useRef(active&&connected);available.current=active&&connected;
 useEffect(()=>{
  const element=container.current;if(!element||!active||!connected)return;
  let disposed=false,suppressed=false;let controller:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  setStatus('');setError('');
  const ownsFocus=()=>available.current&&!disposed&&document.hasFocus()&&!document.hidden&&document.activeElement instanceof HTMLCanvasElement&&element.contains(document.activeElement);
  const invalidate=()=>{revision.current++;controller?.abort();};
  const paste=async(source?:Blob)=>{
   if(busy.current||!ownsFocus())return;
   const client=remote.current,canvas=document.activeElement,stamp=revision.current;if(!client)return;
   const current=()=>ownsFocus()&&document.activeElement===canvas&&remote.current===client&&revision.current===stamp;
   busy.current=true;setStatus('正在粘贴图片…');setError('');clearTimeout(timer);
   try{
    // noVNC maps Command to Alt/Super on macOS. Release that remote modifier
    // before the later Ctrl+V; the physical key-up can safely release it again.
    client.sendKey(0xffe9,'MetaLeft',false);client.sendKey(0xffeb,'MetaRight',false);
    const image=source?await imageClipboardBlob(source):await readMacClipboardImage();
    if(!current())return;
    controller=new AbortController();await writeGuestClipboardImage(id,image,controller.signal);
    if(!current())return;
    client.sendKey(0xffe3,'ControlLeft',true);
    try{client.sendKey(0x76,'KeyV');}finally{client.sendKey(0xffe3,'ControlLeft',false);}
    setStatus('已执行图片粘贴。');timer=setTimeout(()=>setStatus(''),3000);
   }catch(e){if(current()){setStatus('');setError((e as Error).message);}}
   finally{busy.current=false;controller=undefined;if(!disposed&&!current())setStatus('');}
  };
  const keydown=(event:KeyboardEvent)=>{
   if(!event.isTrusted||event.isComposing)return;
   const shortcut=event.metaKey&&!event.ctrlKey&&!event.altKey&&!event.shiftKey&&(event.code==='KeyV'||event.key.toLowerCase()==='v');
   if(shortcut&&ownsFocus()&&element.contains(event.target as Node)){
    event.preventDefault();event.stopImmediatePropagation();suppressed=true;if(!event.repeat)void paste();return;
   }
   if(busy.current&&event.key!=='Meta'&&event.key!=='Control')invalidate();
  };
  const keyup=(event:KeyboardEvent)=>{if(suppressed&&(event.code==='KeyV'||event.key.toLowerCase()==='v')){suppressed=false;event.preventDefault();event.stopImmediatePropagation();}};
  const pasted=(event:ClipboardEvent)=>{
   if(!event.isTrusted||!ownsFocus()||!element.contains(event.target as Node))return;
   const image=Array.from(event.clipboardData?.files??[]).find(file=>file.type.startsWith('image/'));if(!image)return;
   event.preventDefault();event.stopImmediatePropagation();void paste(image);
  };
  const pointer=()=>{if(busy.current)invalidate();};
  const blur=()=>{if(busy.current)invalidate();};
  window.addEventListener('keydown',keydown,true);window.addEventListener('keyup',keyup,true);window.addEventListener('paste',pasted,true);window.addEventListener('pointerdown',pointer,true);window.addEventListener('blur',blur);element.addEventListener('focusout',blur);document.addEventListener('visibilitychange',blur);
  return()=>{disposed=true;invalidate();clearTimeout(timer);window.removeEventListener('keydown',keydown,true);window.removeEventListener('keyup',keyup,true);window.removeEventListener('paste',pasted,true);window.removeEventListener('pointerdown',pointer,true);window.removeEventListener('blur',blur);element.removeEventListener('focusout',blur);document.removeEventListener('visibilitychange',blur);};
 },[id,active,connected,container,remote]);
 return{status:active&&connected?status:'',error:active&&connected?error:''};
}
