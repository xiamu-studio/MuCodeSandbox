'use strict';
// Native viewer presentation, separate from renderer/browser permissions.
function createViewerFullscreenController({getState,notify}){
 let owner,revision=0,busy=false;
 function clear(restore){
  revision++;const previous=owner;owner=undefined;
  if(!previous)return;
  const {window,wasFullscreen}=previous;
  try{if(restore&&!window.isDestroyed()&&window.isFullScreen()!==wasFullscreen)window.setFullScreen(wasFullscreen);}finally{try{notify(window.webContents,false);}catch{}}
 }
 return {
  reset:()=>clear(true),
  nativeLeft:()=>clear(false),
  async handle(event,enabled){
   const initial=getState(),window=initial.window,origin=initial.origin,epoch=initial.epoch;
   const allowed=()=>{try{const current=getState(),web=window?.webContents,frame=event.senderFrame;return Boolean(current.normal&&current.epoch===epoch&&current.origin===origin&&current.window===window&&origin&&window&&!window.isDestroyed()&&(!enabled||window.isFocused())&&web&&!web.isDestroyed()&&event.sender===web&&frame===web.mainFrame&&frame&&!frame.isDestroyed()&&new URL(frame.url).origin===origin&&new URL(frame.url).pathname==='/'&&new URL(web.getURL()).origin===origin);}catch{return false;}};
   if(typeof enabled!=='boolean'||!allowed())throw Error('画面全屏请求来源无效。');
   // Cleanup may cancel an activation check that has not finished yet.
   if(!enabled){clear(true);return false;}
   if(busy)throw Error('正在切换全屏，请稍后重试。');
   const token=++revision;busy=true;
   try{
    const active=await window.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'Boolean(navigator.userActivation.isActive)'}],false);
    if(active!==true||revision!==token||!allowed())throw Error('请在当前 Windows 窗口点击全屏按钮。');
    if(owner?.window===window)return true;
    owner={window,wasFullscreen:window.isFullScreen()};
    if(!owner.wasFullscreen){
     await new Promise((resolve,reject)=>{
      const done=()=>{cleanup();resolve();},gone=()=>{cleanup();reject(Error('全屏窗口已关闭。'));};
      const timer=setTimeout(()=>{cleanup();reject(Error('未能进入全屏，请重试。'));},5000);
      function cleanup(){clearTimeout(timer);window.removeListener('enter-full-screen',done);window.removeListener('closed',gone);}
      window.once('enter-full-screen',done);window.once('closed',gone);
      try{window.setFullScreen(true);}catch(error){cleanup();reject(error);}
     });
    }
    if(revision!==token||!allowed()||!window.isFullScreen())throw Error('画面全屏请求已失效。');
    notify(window.webContents,true);return true;
   }catch(error){if(revision===token)clear(true);throw error;}
   finally{busy=false;}
  }
 };
}
module.exports={createViewerFullscreenController};
