import {z} from 'zod';
import type {HyperVBrokerClient} from './broker.ts';
import type {RunOptions} from '../../process.ts';
import {AppError} from '../../errors.ts';
import {connect} from 'node:net';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const protectedBackupReadSchema=z.object({id:z.uuid(),session:z.uuid(),bytes:z.number().int().positive().safe().max(260*2**30),sha256:digest,chunkBytes:z.literal(32768),platformId:z.uuid(),imageSha256:digest,cpus:z.number().int().min(1).max(16),memoryGiB:z.number().int().min(2).max(32),diskGiB:z.number().int().min(16).max(256),diskIdentifier:z.uuid(),state:z.literal('Off')}).strict();
const block=z.object({data:z.string().max(43692),nextOffset:z.number().int().nonnegative().safe(),done:z.boolean()}).strict();
export async function openProtectedBackupRead(client:HyperVBrokerClient,id:string,options:RunOptions={}){
 z.uuid().parse(id);const raw=await client.call('backup-begin',{id},{...options,timeoutMs:options.timeoutMs??1200000});let info:z.infer<typeof protectedBackupReadSchema>;
 try{info=protectedBackupReadSchema.parse(raw);}catch(error){const lease=z.object({session:z.uuid()}).safeParse(raw);if(lease.success)await client.call('backup-close',{id,session:lease.data.session}).catch(()=>{});throw error;}
 if(info.id!==id){await client.call('backup-close',{id,session:info.session}).catch(()=>{});throw new AppError('备份对象身份不一致',409,'BACKUP_IDENTITY_CHANGED');}
 let closed=false,consumed=false;
 const close=async()=>{if(closed)return;closed=true;z.object({closed:z.literal(true)}).strict().parse(await client.call('backup-close',{id,session:info.session}));};
 const read=async function*(){
  if(closed||consumed)throw new AppError('备份读取已关闭或已开始',409,'BACKUP_EXPIRED');consumed=true;let offset=0;
  try{
   while(offset<info.bytes){
    options.signal?.throwIfAborted();const reply=block.parse(await client.call('backup-read',{id,session:info.session,offset},{signal:options.signal,timeoutMs:30000}));
    const bytes=Buffer.from(reply.data,'base64'),expected=Math.min(info.chunkBytes,info.bytes-offset);
    if(bytes.toString('base64')!==reply.data||bytes.length!==expected||reply.nextOffset!==offset+expected||reply.done!==(reply.nextOffset===info.bytes))throw new AppError('备份读取顺序或长度异常',409,'BACKUP_STREAM_INVALID');
    offset=reply.nextOffset;try{yield bytes;}finally{bytes.fill(0);}
   }
  }finally{await close();}
 };
 const stream=async function*(){
  if(closed||consumed)throw new AppError('备份读取已关闭或已开始',409,'BACKUP_EXPIRED');consumed=true;
  let socket:ReturnType<typeof connect>|undefined;
  const abort=()=>socket?.destroy(new AppError('备份读取已取消',409,'CANCELLED'));
  try{
   options.signal?.throwIfAborted();const opened=z.object({pipeName:z.string().regex(/^MuCodeSandbox-Backup-[a-f0-9]{32}$/)}).strict().parse(await client.call('backup-stream',{id,session:info.session},{signal:options.signal,timeoutMs:30000}));
   socket=connect('\\\\.\\pipe\\'+opened.pipeName);socket.on('error',()=>{});socket.setTimeout(30000,()=>socket?.destroy(new AppError('备份数据流超时',504,'BACKUP_TIMEOUT')));options.signal?.addEventListener('abort',abort,{once:true});
   await new Promise<void>((resolve,reject)=>{socket!.once('connect',resolve);socket!.once('error',reject);});options.signal?.throwIfAborted();socket.write(Buffer.from([46]));let received=0;
   for await(const data of socket){
    options.signal?.throwIfAborted();if(!(data instanceof Buffer)||!data.length||received+data.length>info.bytes)throw new AppError('备份数据流长度异常',409,'BACKUP_STREAM_INVALID');received+=data.length;
    try{yield data;}finally{data.fill(0);}
    if(received===info.bytes)break;
   }
   if(received!==info.bytes)throw new AppError('备份数据流未完整结束',409,'BACKUP_STREAM_INVALID');
  }finally{options.signal?.removeEventListener('abort',abort);socket?.destroy();await close();}
 };
 return {info,read,stream,close};
}
