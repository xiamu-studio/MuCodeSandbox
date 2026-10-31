import {z} from 'zod';
import type {HyperVBrokerClient} from './broker.ts';
import type {RunOptions} from '../../process.ts';
import {AppError} from '../../errors.ts';
import {connect} from 'node:net';
import {createHash} from 'node:crypto';
import {windowsSnapshotCipher} from './snapshots.ts';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const protectedBackupReadSchema=z.object({id:z.uuid(),session:z.uuid(),bytes:z.number().int().positive().safe().max(260*2**30),sha256:digest,seed:z.object({bytes:z.number().int().min(32774).max(8*2**20),sha256:digest}).strict().optional(),chunkBytes:z.literal(32768),platformId:z.uuid(),imageSha256:digest,cpus:z.number().int().min(1).max(16),memoryGiB:z.number().int().min(2).max(32),diskGiB:z.number().int().min(16).max(256),diskIdentifier:z.uuid(),state:z.literal('Off')}).strict();
const canonicalId=z.uuid().refine(v=>v===v.toLowerCase()&&v!=='00000000-0000-0000-0000-000000000000');
export const protectedSnapshotReadSchema=protectedBackupReadSchema.omit({diskIdentifier:true,state:true}).extend({kind:z.literal('snapshot'),id:canonicalId,session:canonicalId,platformId:canonicalId,snapshotId:canonicalId,name:z.string().min(1).max(60).refine(v=>v===v.trim()&&!/[\x00-\x1f\x7f]/.test(v)),createdAt:z.string().datetime({offset:true}),ownerConfiguration:windowsSnapshotCipher,seed:protectedBackupReadSchema.shape.seed.unwrap()}).strict();
const block=z.object({data:z.string().max(43692),nextOffset:z.number().int().nonnegative().safe(),done:z.boolean()}).strict();
export interface WindowsBackupReleaseIssue {environmentId:string;pending:boolean;message:string}
export interface WindowsBackupReadOptions extends RunOptions {onReleaseIssue?:(issue:WindowsBackupReleaseIssue)=>void}
type ContentInfo=Omit<z.infer<typeof protectedBackupReadSchema>,'diskIdentifier'|'state'>;
const currentActions={begin:'backup-begin',read:'backup-read',seed:'backup-seed',stream:'backup-stream',close:'backup-close'} as const;
const historyActions={begin:'snapshot-export-begin',read:'snapshot-export-read',seed:'snapshot-export-seed',stream:'snapshot-export-stream',close:'snapshot-export-close'} as const;
export function openProtectedBackupRead(client:HyperVBrokerClient,id:string,options:WindowsBackupReadOptions={}){return openProtectedRead(client,id,options,currentActions,raw=>protectedBackupReadSchema.parse(raw));}
export function openProtectedSnapshotRead(client:HyperVBrokerClient,id:string,snapshotId:string,options:WindowsBackupReadOptions={}){
 canonicalId.parse(id);canonicalId.parse(snapshotId);return openProtectedRead(client,id,options,historyActions,raw=>{const info=protectedSnapshotReadSchema.parse(raw);if(info.snapshotId!==snapshotId)throw new AppError('所选历史快照已变化',409,'BACKUP_IDENTITY_CHANGED');return info;},snapshotId);
}
async function openProtectedRead<T extends ContentInfo>(client:HyperVBrokerClient,id:string,options:WindowsBackupReadOptions,actions:typeof currentActions|typeof historyActions,parse:(raw:unknown)=>T,snapshotId?:string){
 z.uuid().parse(id);
 const reportRelease=(pending:boolean)=>{try{options.onReleaseIssue?.({environmentId:id,pending,message:snapshotId?(pending?'历史快照读取的释放尚未确认，请保留所选快照与告警并稍后重试。':'历史快照读取已确认释放。'):(pending?'原盘备份读取的释放尚未确认，请保留原环境并检查权限代理，暂勿再次启动。':'原盘备份读取已确认释放。')});}catch{/* Reporting cannot replace an operation or release error. */}};
 const closeRejectedLease=async(session:string)=>{try{z.object({closed:z.literal(true)}).strict().parse(await client.call(actions.close,{id,session}));reportRelease(false);}catch{reportRelease(true);}};
 const raw=await client.call(actions.begin,{id,...(snapshotId?{snapshotId}:{})},{...options,timeoutMs:options.timeoutMs??1200000});let info:T;
 try{info=parse(raw);}catch(error){const lease=z.object({session:z.uuid()}).safeParse(raw);if(lease.success)await closeRejectedLease(lease.data.session);throw error;}
 if(info.id!==id){await closeRejectedLease(info.session);throw new AppError('备份对象身份不一致',409,'BACKUP_IDENTITY_CHANGED');}
 let closed=false,released=false,consumed=false,seedReading=false,seedConsumed=false;
 let closing:Promise<void>|undefined,activeSocket:ReturnType<typeof connect>|undefined;
 const assertReadable=()=>{options.signal?.throwIfAborted();if(closed)throw new AppError('备份读取已关闭',409,'BACKUP_EXPIRED');};
 const close=()=>{
  // Stop local delivery immediately, but retain an unconfirmed native release
  // so an enclosing cleanup can retry the same idempotent lease close.
  closed=true;activeSocket?.destroy(new AppError('备份读取已关闭',409,'BACKUP_EXPIRED'));
  if(released)return Promise.resolve();if(closing)return closing;
  const task=Promise.resolve().then(()=>client.call(actions.close,{id,session:info.session})).then(reply=>{
   z.object({closed:z.literal(true)}).strict().parse(reply);released=true;reportRelease(false);
  }).catch(error=>{reportRelease(true);throw error;}).finally(()=>{if(closing===task)closing=undefined;});
  closing=task;return task;
 };
 const read=async function*(){
  if(closed||consumed||seedReading)throw new AppError('备份读取已关闭或已开始',409,'BACKUP_EXPIRED');consumed=true;let offset=0,failed=false;
  try{
   while(offset<info.bytes){
    assertReadable();const raw=await client.call(actions.read,{id,session:info.session,offset},{signal:options.signal,timeoutMs:30000});assertReadable();const reply=block.parse(raw);
    const bytes=Buffer.from(reply.data,'base64'),expected=Math.min(info.chunkBytes,info.bytes-offset);
    if(bytes.toString('base64')!==reply.data||bytes.length!==expected||reply.nextOffset!==offset+expected||reply.done!==(reply.nextOffset===info.bytes))throw new AppError('备份读取顺序或长度异常',409,'BACKUP_STREAM_INVALID');
    offset=reply.nextOffset;try{yield bytes;}finally{bytes.fill(0);}
   }
  }catch(error){failed=true;throw error;}finally{try{await close();}catch(error){if(!failed)throw error;}}
 };
 const stream=async function*(){
  if(closed||consumed||seedReading)throw new AppError('备份读取已关闭或已开始',409,'BACKUP_EXPIRED');consumed=true;
  let socket:ReturnType<typeof connect>|undefined,failed=false;
  const abort=()=>socket?.destroy(new AppError('备份读取已取消',409,'CANCELLED'));
  try{
   assertReadable();const raw=await client.call(actions.stream,{id,session:info.session},{signal:options.signal,timeoutMs:30000});assertReadable();const opened=z.object({pipeName:z.string().regex(snapshotId?/^MuCodeSandbox-SnapshotExport-[a-f0-9]{32}$/:/^MuCodeSandbox-Backup-[a-f0-9]{32}$/)}).strict().parse(raw);
   socket=connect('\\\\.\\pipe\\'+opened.pipeName);activeSocket=socket;socket.on('error',()=>{});socket.setTimeout(30000,()=>socket?.destroy(new AppError('备份数据流超时',504,'BACKUP_TIMEOUT')));options.signal?.addEventListener('abort',abort,{once:true});
   await new Promise<void>((resolve,reject)=>{socket!.once('connect',resolve);socket!.once('error',reject);});assertReadable();socket.write(Buffer.from([46]));let received=0;
   for await(const data of socket){
    assertReadable();if(!(data instanceof Buffer)||!data.length||received+data.length>info.bytes)throw new AppError('备份数据流长度异常',409,'BACKUP_STREAM_INVALID');received+=data.length;
    try{yield data;}finally{data.fill(0);}
    if(received===info.bytes)break;
   }
   assertReadable();if(received!==info.bytes)throw new AppError('备份数据流未完整结束',409,'BACKUP_STREAM_INVALID');
  }catch(error){failed=true;throw error;}finally{options.signal?.removeEventListener('abort',abort);socket?.destroy();if(activeSocket===socket)activeSocket=undefined;try{await close();}catch(error){if(!failed)throw error;}}
 };
 const readSeed=async()=>{
  if(closed||consumed||seedReading||seedConsumed||!info.seed)throw new AppError('原种子资料不可读取，请重新开始备份',409,'BACKUP_SEED_UNAVAILABLE');seedReading=true;seedConsumed=true;const chunks:Buffer[]=[];let offset=0;
  try{
   const hash=createHash('sha256');while(offset<info.seed.bytes){assertReadable();const raw=await client.call(actions.seed,{id,session:info.session,offset},{signal:options.signal,timeoutMs:30000});assertReadable();const reply=block.parse(raw),bytes=Buffer.from(reply.data,'base64'),expected=Math.min(info.chunkBytes,info.seed.bytes-offset);
    if(bytes.toString('base64')!==reply.data||bytes.length!==expected||reply.nextOffset!==offset+expected||reply.done!==(reply.nextOffset===info.seed.bytes)){bytes.fill(0);throw new AppError('原种子资料顺序或长度异常',409,'BACKUP_STREAM_INVALID');}offset=reply.nextOffset;hash.update(bytes);chunks.push(bytes);
   }
   if(hash.digest('hex')!==info.seed.sha256)throw new AppError('原种子资料摘要不一致',409,'BACKUP_STREAM_INVALID');return Buffer.concat(chunks);
  }catch(error){try{await close();}catch{/* The close failure is reported independently; the original read remains authoritative. */}throw error;}finally{seedReading=false;for(const bytes of chunks)bytes.fill(0);}
 };
 return {info,read,stream,readSeed,close};
}
