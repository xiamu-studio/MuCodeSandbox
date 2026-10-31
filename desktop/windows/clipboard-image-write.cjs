'use strict';
const MAX_BYTES=10*1024*1024,MAX_PIXELS=16000000;
function createClipboardImageWriteHandler({getState,clipboard,nativeImage,ClipboardItem}){
 let busy=false;
 return async(event,input)=>{
  const initial=getState(),window=initial.window,origin=initial.origin,epoch=initial.epoch;
  const allowed=()=>{try{const current=getState(),web=window?.webContents,frame=event.senderFrame;if(!current.normal||current.epoch!==epoch||current.origin!==origin||current.window!==window||!origin||!window||window.isDestroyed()||!window.isFocused()||!web||web.isDestroyed()||event.sender!==web||frame!==web.mainFrame||!frame||frame.isDestroyed())return false;const url=new URL(frame.url);return url.origin===origin&&url.pathname==='/'&&new URL(web.getURL()).origin===origin;}catch{return false;}};
  if(!allowed())throw Error('图片复制请求来源无效。');
  if(!input||typeof input!=='object'||Object.keys(input).length!==1||!(input.data instanceof Uint8Array)||!input.data.byteLength||input.data.byteLength>MAX_BYTES)throw Error('请复制不超过10 MiB的 PNG 图片。');
  if(busy)throw Error('图片正在复制，请稍后重试。');busy=true;
  try{
   // Copy the bounded IPC data before any asynchronous check.
   const data=Buffer.from(input.data);
   const active=await window.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'Boolean(navigator.userActivation.isActive)'}],false);
   if(active!==true||!allowed())throw Error('请在当前 Windows 窗口点击“复制图片到 Windows”。');
   if(data.length<45||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||data.toString('ascii',12,16)!=='IHDR')throw Error('图片无效，请重新取回。');
   const width=data.readUInt32BE(16),height=data.readUInt32BE(20);if(!width||!height||width*height>MAX_PIXELS)throw Error('图片分辨率过大，请缩小后再复制。');
   const image=nativeImage.createFromBuffer(data);if(image.isEmpty())throw Error('图片无效，请重新取回。');const size=image.getSize(1);if(size.width!==width||size.height!==height)throw Error('图片尺寸不一致，请重新取回。');
   const png=image.toPNG({scaleFactor:1});if(!png.length||png.length>MAX_BYTES)throw Error('转换后的图片超过10 MiB。');
   if(!allowed())throw Error('图片复制请求已失效。');
   await clipboard.write([new ClipboardItem({'image/png':new Blob([new Uint8Array(png)],{type:'image/png'})})]);
   if(!allowed())throw Error('图片复制窗口已变化，请确认 Windows 剪贴板。');return {ok:true,width,height};
  }finally{busy=false;}
 };
}
module.exports={createClipboardImageWriteHandler};
