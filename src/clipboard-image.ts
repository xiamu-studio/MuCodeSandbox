import {IMAGE_CLIPBOARD_MAX_BYTES,IMAGE_CLIPBOARD_MAX_PIXELS} from '../shared/clipboard-image.ts';
import {ApiError} from './api.ts';
export async function writeGuestClipboardImage(id:string,image:Blob,signal?:AbortSignal){
 const response=await fetch(`/api/environments/${id}/clipboard/image`,{method:'POST',headers:{Authorization:`Bearer ${window.__MU_CONFIG__.token}`,'Content-Type':'image/png'},body:image,signal});
 const result=await response.json();
 if(!response.ok)throw new ApiError(result.error??'图片传输失败',response.status,result.code??'IMAGE_CLIPBOARD_FAILED');
 if(result.ok!==true)throw Error('图片尚未确认传入，请重试。');
}
export async function imageClipboardBlob(blob:Blob):Promise<Blob>{
 if(!blob.size||blob.size>IMAGE_CLIPBOARD_MAX_BYTES)throw Error('图片超过10 MiB或为空，请缩小后再复制。');
 const image=await createImageBitmap(blob);
 try{
  if(!image.width||!image.height||image.width*image.height>IMAGE_CLIPBOARD_MAX_PIXELS)throw Error('图片分辨率过大，请缩小后再复制。');
  const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d')!.drawImage(image,0,0);
  const result=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('无法读取图片，请重新复制。')),'image/png'));
  canvas.width=canvas.height=0;
  if(result.size>IMAGE_CLIPBOARD_MAX_BYTES)throw Error('转换后的图片超过10 MiB，请缩小后再复制。');return result;
 }finally{image.close();}
}
export async function readMacClipboardImage():Promise<Blob>{
 if(window.muDesktop?.readClipboardImage){
  try{const result=await window.muDesktop.readClipboardImage();return new Blob([new Uint8Array(result.data)],{type:'image/png'});}
  catch(error){
   const message=(error instanceof Error?error.message:'').replace(/^Error invoking remote method 'mu:clipboard-image': (?:Error: )?/,'');
   const known=['图片剪贴板请求来源无效。','请点击“粘贴图片到沙箱”读取图片。','图片剪贴板请求已失效。','Mac 剪贴板中没有图片，请先复制图片或截图。','图片超过10 MiB，请缩小后再复制。','图片分辨率过大，请缩小后再复制。','无法读取图片，请重新复制图片或截图。'];
   throw Error(known.includes(message)?message:'无法读取 Mac 图片，请重新复制后再试，也可在文件面板按 ⌘V。');
  }
 }
 if(!navigator.clipboard.read)throw Error('请在文件面板按 ⌘V 粘贴图片，或使用桌面应用。');
 const items=await navigator.clipboard.read();
 for(const item of items)if(item.types.includes('image/png'))return imageClipboardBlob(await item.getType('image/png'));
 throw Error('Mac 剪贴板中没有图片，请先复制图片或截图。');
}
