'use strict';
const {readClipboardImage}=require('../clipboard-image.cjs');
function createClipboardImageHandler({getState,clipboard,nativeImage}){
 let busy=false;
 return async event=>{
  const initial=getState(),window=initial.window,origin=initial.origin,epoch=initial.epoch;
  const allowed=()=>{
   try{
    const current=getState(),web=window?.webContents,frame=event.senderFrame;
    if(!current.normal||current.epoch!==epoch||current.origin!==origin||current.window!==window||!origin||!window||window.isDestroyed()||!window.isFocused()||!web||web.isDestroyed()||event.sender!==web||frame!==web.mainFrame||!frame||frame.isDestroyed())return false;
    const url=new URL(frame.url);return url.origin===origin&&url.pathname==='/'&&new URL(web.getURL()).origin===origin;
   }catch{return false;}
  };
  if(!allowed())throw Error('图片剪贴板请求来源无效。');
  if(busy)throw Error('图片正在读取，请稍后重试。');
  busy=true;
  try{
   // The main-world page cannot replace the userActivation getter used here.
   const guarded={senderFrame:{executeJavaScript:()=>window.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'Boolean(navigator.userActivation.isActive)'}],false)}};
   return await readClipboardImage(guarded,{clipboard,nativeImage,allowed});
  }catch(error){throw Error(error.message.replace('Mac 剪贴板','Windows 剪贴板'));}
  finally{busy=false;}
 };
}
module.exports={createClipboardImageHandler};
