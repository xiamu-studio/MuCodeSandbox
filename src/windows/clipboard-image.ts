import {imageClipboardBlob} from '../clipboard-image.ts';
import {request} from '../api.ts';
import {IMAGE_CLIPBOARD_MAX_BYTES,IMAGE_CLIPBOARD_MAX_PIXELS} from '../../shared/clipboard-image.ts';
export interface ReceivedWindowsImage {data:string;width:number;height:number;bytes:number}
export function receivedWindowsImageBytes(image:ReceivedWindowsImage){
 if(typeof image.data!=='string'||!image.data.length||image.data.length>4*Math.ceil(IMAGE_CLIPBOARD_MAX_BYTES/3)||!Number.isSafeInteger(image.width)||!Number.isSafeInteger(image.height)||image.width<=0||image.height<=0||image.width*image.height>IMAGE_CLIPBOARD_MAX_PIXELS)throw Error('沙箱图片无效或过大，请重新复制后取回。');
 let raw:string;try{raw=atob(image.data);if(btoa(raw)!==image.data)throw Error();}catch{throw Error('沙箱图片编码无效，请重新取回。');}
 if(raw.length!==image.bytes||raw.length<45||raw.length>IMAGE_CLIPBOARD_MAX_BYTES)throw Error('沙箱图片大小无效，请重新取回。');
 const data=Uint8Array.from(raw,c=>c.charCodeAt(0)),view=new DataView(data.buffer);if(Array.from(data.subarray(0,8)).join(',')!=='137,80,78,71,13,10,26,10'||view.getUint32(16)!==image.width||view.getUint32(20)!==image.height)throw Error('沙箱图片尺寸无效，请重新取回。');return data;
}
export async function readWindowsGuestImage(id:string,signal:AbortSignal){const image=await request<ReceivedWindowsImage>(`/environments/${id}/clipboard/image/read`,{method:'POST',body:'{}',signal});receivedWindowsImageBytes(image);return image;}
export async function copyWindowsReceivedImage(image:ReceivedWindowsImage){
 if(!window.muWindowsDesktop?.writeClipboardImage)throw Error('请使用 Windows 桌面应用复制图片。');
 try{const result=await window.muWindowsDesktop.writeClipboardImage(receivedWindowsImageBytes(image));if(result.ok!==true||result.width!==image.width||result.height!==image.height)throw Error('图片尚未确认复制，请重试。');}
 catch(error){throw Error((error instanceof Error?error.message:'图片复制未完成，请重试。').replace(/^Error invoking remote method 'mu-windows:clipboard-image-write': (?:Error: )?/,''));}
}
export async function readWindowsClipboardImage():Promise<Blob>{
 if(window.muWindowsDesktop){
  try{const result=await window.muWindowsDesktop.readClipboardImage();return new Blob([new Uint8Array(result.data)],{type:'image/png'});}
  catch(error){
   const message=(error instanceof Error?error.message:'').replace(/^Error invoking remote method 'mu-windows:clipboard-image': (?:Error: )?/,'');
   const known=['图片剪贴板请求来源无效。','请点击“粘贴图片到沙箱”读取图片。','图片剪贴板请求已失效。','图片正在读取，请稍后重试。','Windows 剪贴板中没有图片，请先复制图片或截图。','图片超过10 MiB，请缩小后再复制。','图片分辨率过大，请缩小后再复制。','无法读取图片，请重新复制图片或截图。'];
   throw Error(known.includes(message)?message:'无法读取图片，请重新复制，或在图片粘贴区按 Ctrl+V。');
  }
 }
 if(!navigator.clipboard.read)throw Error('请在图片粘贴区按 Ctrl+V，或使用 Windows 桌面应用。');
 const items=await navigator.clipboard.read();for(const item of items)if(item.types.includes('image/png'))return imageClipboardBlob(await item.getType('image/png'));
 throw Error('Windows 剪贴板中没有图片，请先复制图片或截图。');
}
