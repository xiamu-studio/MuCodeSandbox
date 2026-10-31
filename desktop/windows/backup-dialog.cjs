'use strict';
function createBackupDialogHandler({getState,dialog}){
 let busy=false;
 return async(event,action)=>{
  const initial=getState(),window=initial.window,origin=initial.origin,epoch=initial.epoch;
  const allowed=()=>{try{const state=getState(),web=window?.webContents,frame=event.senderFrame;return state.normal&&state.epoch===epoch&&state.window===window&&state.origin===origin&&!!origin&&!window.isDestroyed()&&window.isFocused()&&event.sender===web&&frame===web.mainFrame&&!frame.isDestroyed()&&new URL(frame.url).origin===origin&&new URL(frame.url).pathname==='/';}catch{return false;}};
  if(!allowed()||!['export','restore'].includes(action))throw Error('备份文件选择请求无效');
  if(busy)throw Error('文件选择窗口已打开');busy=true;
  try{
   const active=await window.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'Boolean(navigator.userActivation.isActive)'}],false);
   if(active!==true||!allowed())throw Error('请点击当前窗口的文件选择按钮');
   const options={title:action==='export'?'保存 Windows 加密备份':'选择 Windows 加密备份',filters:[{name:'MuCodeSandbox 加密备份',extensions:['mucwin']}]};
   const value=action==='export'?await dialog.showSaveDialog(window,{...options,defaultPath:'environment.mucwin'}):await dialog.showOpenDialog(window,{...options,properties:['openFile']});
   // The native dialog may temporarily take focus from its parent window.
   if(getState().epoch!==epoch||getState().origin!==origin||!getState().normal)throw Error('文件选择已失效，请重试');
   return value.canceled?null:action==='export'?value.filePath:value.filePaths[0];
  }finally{busy=false;}
 };
}
module.exports={createBackupDialogHandler};
