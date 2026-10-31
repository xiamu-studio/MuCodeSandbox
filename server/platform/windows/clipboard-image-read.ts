import {z} from 'zod';
import {AppError} from '../../errors.ts';
import {validateClipboardImage} from '../../clipboard-image.ts';
import type {GuestExchange} from '../../guest-exchange.ts';
import {IMAGE_CLIPBOARD_MAX_BYTES} from '../../../shared/clipboard-image.ts';

export const WINDOWS_IMAGE_CLIPBOARD_READ=String.raw`import subprocess,json,select,time,os,base64,struct
p=subprocess.Popen(['/usr/bin/xclip','-selection','clipboard','-out','-target','image/png'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
data=bytearray();deadline=time.monotonic()+3
try:
 while True:
  if time.monotonic()>deadline:raise ValueError('Clipboard timed out')
  if not select.select([p.stdout],[],[],.05)[0]:continue
  chunk=os.read(p.stdout.fileno(),min(65536,10485761-len(data)))
  if not chunk:break
  data.extend(chunk)
  if len(data)>10485760:raise ValueError('Image exceeds limit')
 p.wait(timeout=.5)
 if p.returncode!=0 or len(data)<45 or data[:8]!=b'\x89PNG\r\n\x1a\n' or data[12:16]!=b'IHDR':raise ValueError('No PNG image')
 width,height=struct.unpack('!II',data[16:24])
 if not width or not height or width*height>16000000:raise ValueError('Image dimensions exceed limit')
 print(json.dumps({'data':base64.b64encode(data).decode('ascii')}))
finally:
 if p.poll() is None:p.kill();p.wait()
`;
const MAX_BASE64=4*Math.ceil(IMAGE_CLIPBOARD_MAX_BYTES/3),result=z.object({data:z.string().min(60).max(MAX_BASE64)}).strict();
// Shares the existing exchange mutex and its session-bound management wrapper.
// Only the Windows HTTP route exposes this manual read; Mac is unchanged.
export async function readWindowsGuestClipboardImage(exchange:GuestExchange,id:string,signal:AbortSignal){
 if(exchange.busy.has(id))throw new AppError('当前环境正在传输，请稍后重试',409,'TRANSFER_BUSY');
 exchange.busy.add(id);
 try{
  signal.throwIfAborted();const e=await exchange.authorize(id);if(e.kind!=='vm')throw new AppError('此功能只支持 Linux 环境',409);
  let encoded:string;
  try{const raw=await exchange.runtime.management(e,['sudo','-H','-u','dev','--','env','-i','HOME=/home/dev','PATH=/usr/bin:/bin','DISPLAY=:99','XAUTHORITY=/run/mu-browser/Xauthority','python3','-c',WINDOWS_IMAGE_CLIPBOARD_READ],{signal,timeoutMs:6000,maxBytes:MAX_BASE64+256,onOutput:undefined});encoded=result.parse(JSON.parse(raw)).data;}
  catch{signal.throwIfAborted();throw new AppError('无法读取沙箱图片；请先在沙箱中复制 PNG 图片，且不超过10 MiB、1600万像素。',409,'GUEST_CLIPBOARD_IMAGE_UNAVAILABLE');}
  signal.throwIfAborted();const bytes=Buffer.from(encoded,'base64');if(bytes.toString('base64')!==encoded)throw new AppError('沙箱图片编码无效，请重新复制。',400,'INVALID_CLIPBOARD_IMAGE');const image=validateClipboardImage(bytes);
  const current=await exchange.authorize(id);signal.throwIfAborted();if(current.updatedAt!==e.updatedAt)throw new AppError('环境已变化，图片结果不再交付',409,'CONFIGURATION_CHANGED');
  return {data:encoded,...image};
 }finally{exchange.busy.delete(id);}
}
