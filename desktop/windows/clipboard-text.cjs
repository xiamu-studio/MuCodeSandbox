'use strict';
const TEXT_CLIPBOARD_LIMIT=64000;
function text(value){if(typeof value!=='string'||value.length>TEXT_CLIPBOARD_LIMIT||value.includes('\0'))throw Error('剪贴板须为 64,000 字以内的普通文字。');return value;}
function createClipboardTextHandler({getState,clipboard}){
 let busy=false;
 return async(event,input)=>{
  const initial=getState(),window=initial.window,origin=initial.origin,epoch=initial.epoch;
  const allowed=()=>{try{const current=getState(),web=window?.webContents,frame=event.senderFrame;if(!current.normal||current.epoch!==epoch||current.origin!==origin||current.window!==window||!origin||!window||window.isDestroyed()||!window.isFocused()||!web||web.isDestroyed()||event.sender!==web||frame!==web.mainFrame||!frame||frame.isDestroyed())return false;const url=new URL(frame.url);return url.origin===origin&&url.pathname==='/'&&new URL(web.getURL()).origin===origin;}catch{return false;}};
  if(!allowed())throw Error('文字剪贴板请求来源无效。');
  if(!input||typeof input!=='object'||Array.isArray(input)||!['read','write'].includes(input.action)||Object.keys(input).some(key=>!['action','text'].includes(key))||input.action==='read'&&Object.hasOwn(input,'text'))throw Error('文字剪贴板请求无效。');
  const value=input.action==='write'?text(input.text):undefined;
  if(busy)throw Error('剪贴板操作正在进行，请稍后重试。');busy=true;
  try{
   const active=await window.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'Boolean(navigator.userActivation.isActive)'}],false);
   if(active!==true||!allowed())throw Error('请在当前 Windows 窗口点击复制或粘贴按钮。');
   // Never inspect formats, images, file lists or the primary selection.
   if(input.action==='read'){const result=text(await clipboard.readText());if(!allowed())throw Error('文字剪贴板请求已失效。');return result;}
   await clipboard.writeText(value);if(!allowed())throw Error('文字剪贴板请求已失效。');return {ok:true};
  }finally{busy=false;}
 };
}
module.exports={createClipboardTextHandler,TEXT_CLIPBOARD_LIMIT};
