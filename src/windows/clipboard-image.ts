import {imageClipboardBlob} from '../clipboard-image.ts';
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
