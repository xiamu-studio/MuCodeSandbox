const MAX_BYTES=10*1024*1024,MAX_PIXELS=16000000;
/**
 * @param {any} event
 * @param {{clipboard:Pick<import('electron').Clipboard,'read'>,nativeImage:Pick<typeof import('electron').nativeImage,'createFromBuffer'>,allowed:(event:any)=>boolean}} options
 */
async function readClipboardImage(event,{clipboard,nativeImage,allowed}) {
 if(!allowed(event))throw new Error('图片剪贴板请求来源无效。');
 if(!await event.senderFrame.executeJavaScript('navigator.userActivation.isActive'))throw new Error('请点击“粘贴图片到沙箱”读取图片。');
 // Recheck the frame after the asynchronous gesture check; no remote frame may read.
 if(!allowed(event))throw new Error('图片剪贴板请求已失效。');
 const items=await clipboard.read();
 if(!allowed(event))throw new Error('图片剪贴板请求已失效。');
 const item=items.find(item=>item.types.includes('image/png'));
 if(!item)throw new Error('Mac 剪贴板中没有图片，请先复制图片或截图。');
 const blob=await item.getType('image/png');
 if(!allowed(event))throw new Error('图片剪贴板请求已失效。');
 if(!blob.size||blob.size>MAX_BYTES)throw new Error('图片超过10 MiB，请缩小后再复制。');
 const data=Buffer.from(await blob.arrayBuffer());
 if(!allowed(event))throw new Error('图片剪贴板请求已失效。');
 // Bound dimensions before decoding even a small compressed clipboard payload.
 if(data.length<33||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||data.toString('ascii',12,16)!=='IHDR')throw new Error('无法读取图片，请重新复制图片或截图。');
 if(data.readUInt32BE(16)*data.readUInt32BE(20)>MAX_PIXELS)throw new Error('图片分辨率过大，请缩小后再复制。');
 const image=nativeImage.createFromBuffer(data);if(image.isEmpty())throw new Error('无法读取图片，请重新复制图片或截图。');
 const scaleFactor=Math.max(1,...image.getScaleFactors().filter(value=>Number.isFinite(value)&&value>0));
 const {width,height}=image.getSize(scaleFactor);if(!width||!height||width*height>MAX_PIXELS)throw new Error('图片分辨率过大，请缩小后再复制。');
 const png=image.toPNG({scaleFactor});if(!png.length||png.length>MAX_BYTES)throw new Error('图片超过10 MiB，请缩小后再复制。');
 return {data:new Uint8Array(png),width,height};
}
module.exports={readClipboardImage};
