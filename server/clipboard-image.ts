import {inflateSync,crc32} from 'node:zlib';
import {AppError} from './errors.ts';
import {IMAGE_CLIPBOARD_MAX_BYTES,IMAGE_CLIPBOARD_MAX_PIXELS} from '../shared/clipboard-image.ts';
function invalid():never{throw new AppError('图片无效或格式不受支持，请重新复制图片后再试。',400,'INVALID_CLIPBOARD_IMAGE');}
export function validateClipboardImage(data:Buffer){
 if(data.length>IMAGE_CLIPBOARD_MAX_BYTES)throw new AppError('图片超过10 MiB，请缩小后再复制。',413,'CLIPBOARD_IMAGE_TOO_LARGE');
 if(data.length<45||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))invalid();
 let offset=8,width=0,height=0,channels=0,color=0,palette=false,ended=false,started=false,closed=false;const parts:Buffer[]=[];
 while(offset<data.length){
  if(offset+12>data.length)invalid();const size=data.readUInt32BE(offset),end=offset+12+size;if(end>data.length)invalid();
  const kind=data.toString('ascii',offset+4,offset+8),body=data.subarray(offset+8,end-4);
  if(!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(kind)||(/^[A-Z]/.test(kind)&&!['IHDR','PLTE','IDAT','IEND'].includes(kind)))invalid();
  if(crc32(data.subarray(offset+4,end-4))!==data.readUInt32BE(end-4))invalid();
  if(offset===8){
   if(kind!=='IHDR'||size!==13)invalid();width=body.readUInt32BE(0);height=body.readUInt32BE(4);color=body[9];channels=({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[color]??0;
   if(!width||!height||width*height>IMAGE_CLIPBOARD_MAX_PIXELS)throw new AppError('图片分辨率过大，请缩小后再复制。',413,'CLIPBOARD_IMAGE_TOO_LARGE');
   if(body[8]!==8||!channels||body[10]||body[11]||body[12])invalid();
  }else if(kind==='IHDR')invalid();
  if(kind==='PLTE'){if(palette||started||color===0||color===4||!size||size%3||size>768)invalid();palette=true;}
  if(kind==='IDAT'){if(closed||(color===3&&!palette))invalid();parts.push(body);started=true;}else if(started)closed=true;
  if(kind==='IEND'){if(size||!started||end!==data.length)invalid();ended=true;break;}
  offset=end;
 }
 if(!ended)invalid();
 const expected=(width*channels+1)*height;
 try{const raw=inflateSync(Buffer.concat(parts),{maxOutputLength:expected+1});if(raw.length!==expected)invalid();for(let row=0;row<height;row++)if(raw[row*(width*channels+1)]>4)invalid();}catch{invalid();}
 return {width,height,bytes:data.length};
}
