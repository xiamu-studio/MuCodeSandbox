import {createHash} from 'node:crypto';
import {z} from 'zod';
import {AppError} from '../../errors.ts';
import type {RunOptions} from '../../process.ts';
import type {HyperVBrokerClient} from './broker.ts';

const id=z.uuid().refine(value=>value===value.toLowerCase(),'需要规范小写标识');
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const WINDOWS_SNAPSHOT_OWNER_CIPHER_MAX=512*1024;
export const windowsSnapshotCipher=z.string().max(WINDOWS_SNAPSHOT_OWNER_CIPHER_MAX).refine(value=>{
 if(!value.startsWith('enc:')||value.length>WINDOWS_SNAPSHOT_OWNER_CIPHER_MAX)return false;
 const bytes=Buffer.from(value.slice(4),'base64');try{return bytes.length>28&&bytes.toString('base64')===value.slice(4);}finally{bytes.fill(0);}
},'需要当前用户加密的完整快照配置');
const resources={cpus:z.number().int().min(1).max(16),memoryGiB:z.number().int().min(2).max(32),diskGiB:z.number().int().min(16).max(256),imageSha256:digest};
const owner=z.object({ownerConfiguration:windowsSnapshotCipher,seedSha256:digest,...resources}).strict();
export const windowsSnapshotRecord=z.object({id,environmentId:id,name:z.string().min(1).max(60).refine(value=>value===value.trim()&&!/[\x00-\x1f\x7f]/.test(value)),createdAt:z.string().datetime(),bytes:z.number().int().positive().safe().max(260*2**30+8*2**20),seedSha256:digest,...resources}).strict();
const transaction=z.object({pending:z.literal(true),id,platformId:id,transactionId:id,snapshotId:id,phase:z.enum(['prepared','applied','committed','rolled-back']),ownerConfiguration:windowsSnapshotCipher,seedBytes:z.number().int().min(32774).max(8*2**20),seedSha256:digest,...resources}).strict();
const status=z.union([z.object({pending:z.literal(false)}).strict(),transaction]);
export const windowsSnapshotStaging=z.object({entries:z.array(z.object({name:z.string().min(1).max(255).regex(/^(create|restore)-next-/i).refine(value=>!/[\x00-\x1f\\/:]/.test(value)),operation:z.enum(['create','restore'])}).strict().refine(entry=>entry.name.toLowerCase().startsWith(entry.operation+'-next-'))).max(32),truncated:z.boolean()}).strict().refine(value=>new Set(value.entries.map(entry=>entry.name.toLowerCase())).size===value.entries.length&&(!value.truncated||value.entries.length===32));
export const windowsSnapshotStagingReview=z.object({id,operation:z.enum(['create','restore']),phase:z.enum(['copy','deleting','done']),token:digest,bytes:z.number().int().nonnegative().safe().max(260*2**30+10*2**20),files:z.number().int().min(0).max(3),partialReceipt:z.boolean()}).strict().refine(value=>value.phase!=='done'||value.bytes===0&&value.files===0);
const stagingCleanupReceipt=z.object({deleted:z.literal(true),alreadyDeleted:z.boolean(),id,operation:z.enum(['create','restore']),bytes:windowsSnapshotStagingReview.shape.bytes}).strict();
const outcome=z.object({acknowledged:z.literal(true),id,platformId:id,transactionId:id,snapshotId:id,phase:z.enum(['committed','rolled-back']),ownerConfigurationSha256:digest,seedBytes:z.number().int().min(32774).max(8*2**20),seedSha256:digest,...resources}).strict();
export type WindowsSnapshotOutcome=z.infer<typeof outcome>;
export type WindowsSnapshotRecord=z.infer<typeof windowsSnapshotRecord>;
export const windowsSnapshotDeletion=z.object({id,environmentId:id,name:windowsSnapshotRecord.shape.name,createdAt:z.string().datetime(),phase:z.enum(['intent','retired']),bytes:windowsSnapshotRecord.shape.bytes}).strict();
const deletionReceipt=z.object({deleted:z.literal(true),alreadyDeleted:z.boolean(),id,environmentId:id,name:windowsSnapshotRecord.shape.name,bytes:windowsSnapshotRecord.shape.bytes}).strict();
export type WindowsSnapshotTransaction=z.infer<typeof transaction>;
export type WindowsSnapshotOwner=z.infer<typeof owner>;
type Broker=Pick<HyperVBrokerClient,'call'>;
export type WindowsSnapshotDeleteOptions=RunOptions&{allowRunning?:boolean};
const invalid=()=>new AppError('快照代理回执与当前事务不一致，现有文件已保留',409,'SNAPSHOT_IDENTITY');

// Only the ordinary controller calls this boundary. ownerConfiguration is never
// returned by an HTTP/UI list. The coordinator must replay it before commit/ack.
export class WindowsSnapshots {
 private broker:Broker;
 constructor(broker:Broker){this.broker=broker;}
 async staging(environmentId:string,options:RunOptions={}){
  id.parse(environmentId);const result=windowsSnapshotStaging.parse(await this.broker.call('snapshot-staging',{id:environmentId},options));
  return result;
 }
 async inspectStaging(environmentId:string,copyId:string,operation:'create'|'restore',options:RunOptions={}){
  id.parse(environmentId);id.parse(copyId);windowsSnapshotStagingReview.shape.operation.parse(operation);
  const result=windowsSnapshotStagingReview.parse(await this.broker.call('snapshot-staging-review',{id:environmentId,copyId,operation},{...options,timeoutMs:options.timeoutMs??180000}));
  if(result.id!==copyId||result.operation!==operation)throw invalid();return result;
 }
 async cleanupStaging(environmentId:string,review:z.infer<typeof windowsSnapshotStagingReview>,resumeOnly:boolean,options:RunOptions={}){
  id.parse(environmentId);windowsSnapshotStagingReview.parse(review);z.boolean().parse(resumeOnly);
  const result=stagingCleanupReceipt.parse(await this.broker.call('snapshot-staging-cleanup',{id:environmentId,copyId:review.id,operation:review.operation,token:review.token,resumeOnly},{...options,timeoutMs:options.timeoutMs??600000}));
  if(result.id!==review.id||result.operation!==review.operation||result.bytes!==(result.alreadyDeleted?0:review.bytes))throw invalid();return result;
 }
 async pending(options:RunOptions={}){
  const value=z.object({ids:z.array(id).max(32)}).strict().parse(await this.broker.call('snapshot-pending',{},options));
  if(new Set(value.ids).size!==value.ids.length)throw invalid();return value.ids;
 }
 async list(environmentId:string,options:RunOptions={}){
  id.parse(environmentId);const values=z.array(windowsSnapshotRecord).max(32).parse(await this.broker.call('snapshot-list',{id:environmentId},options));
  if(values.some(v=>v.environmentId!==environmentId)||new Set(values.map(v=>v.id)).size!==values.length)throw invalid();return values;
 }
 async deletions(environmentId:string,options:RunOptions={}){
  id.parse(environmentId);const records=z.array(windowsSnapshotDeletion).max(32).parse(await this.broker.call('snapshot-deletions',{id:environmentId},options));
  if(records.some(record=>record.environmentId!==environmentId)||new Set(records.map(record=>record.id)).size!==records.length)throw invalid();return records;
 }
 async remove(environmentId:string,snapshotId:string,name:string,resumeOnly:boolean,options:WindowsSnapshotDeleteOptions={}){
  id.parse(environmentId);id.parse(snapshotId);windowsSnapshotRecord.shape.name.parse(name);z.boolean().parse(resumeOnly);
  if(options.allowRunning!==undefined)z.boolean().parse(options.allowRunning);const {allowRunning,...runOptions}=options;
  const result=deletionReceipt.parse(await this.broker.call('snapshot-delete',{id:environmentId,snapshotId,name,resumeOnly,...(allowRunning?{allowRunning:true}:{})},{...runOptions,timeoutMs:options.timeoutMs??1200000}));
  if(result.id!==snapshotId||result.environmentId!==environmentId||result.name!==name)throw invalid();return result;
 }
 private bound(value:unknown,environmentId:string){const receipt=status.parse(value);if(receipt.pending&&receipt.id!==environmentId)throw invalid();return receipt;}
 async status(environmentId:string,options:RunOptions={}){
  id.parse(environmentId);return this.bound(await this.broker.call('snapshot-status',{id:environmentId},options),environmentId);
 }
 async create(environmentId:string,name:string,configuration:WindowsSnapshotOwner,options:RunOptions={}){
  id.parse(environmentId);z.string().min(1).max(60).refine(v=>v===v.trim()&&!/[\x00-\x1f\x7f]/.test(v)).parse(name);const bound=owner.parse(configuration);
  const result=windowsSnapshotRecord.parse(await this.broker.call('snapshot-create',{id:environmentId,name,...bound},{...options,timeoutMs:options.timeoutMs??1200000}));
  if(result.environmentId!==environmentId||result.seedSha256!==bound.seedSha256||Object.keys(resources).some(key=>result[key as keyof typeof resources]!==bound[key as keyof typeof resources]))throw invalid();return result;
 }
 async prepare(environmentId:string,snapshotId:string,configuration:WindowsSnapshotOwner,options:RunOptions={}){
  id.parse(environmentId);id.parse(snapshotId);const bound=owner.parse(configuration);
  const result=this.bound(await this.broker.call('snapshot-prepare',{id:environmentId,snapshotId,...bound},{...options,timeoutMs:options.timeoutMs??1200000}),environmentId);
  if(!result.pending||result.snapshotId!==snapshotId||result.phase!=='applied')throw invalid();return result;
 }
 async recover(environmentId:string,options:RunOptions&{transactionId?:string}={}){
  id.parse(environmentId);if(options.transactionId)id.parse(options.transactionId);const result=this.bound(await this.broker.call('snapshot-recover',{id:environmentId,...(options.transactionId?{transactionId:options.transactionId}:{})},{...options,timeoutMs:options.timeoutMs??1200000}),environmentId);
  if(result.pending&&(!['committed','rolled-back'].includes(result.phase)||options.transactionId&&result.transactionId!==options.transactionId))throw invalid();return result;
 }
 async outcome(environmentId:string,transactionId:string,options:RunOptions={}){
  id.parse(environmentId);id.parse(transactionId);const result=outcome.parse(await this.broker.call('snapshot-outcome',{id:environmentId,transactionId},options));
  if(result.id!==environmentId||result.transactionId!==transactionId)throw invalid();return result;
 }
 async commit(prepared:WindowsSnapshotTransaction,options:RunOptions={}){
  transaction.parse(prepared);if(!['applied','committed'].includes(prepared.phase))throw invalid();
  const result=this.bound(await this.broker.call('snapshot-commit',{id:prepared.id,transactionId:prepared.transactionId},{...options,timeoutMs:options.timeoutMs??1200000}),prepared.id);
  if(!result.pending||result.phase!=='committed'||result.transactionId!==prepared.transactionId||result.snapshotId!==prepared.snapshotId||result.ownerConfiguration!==prepared.ownerConfiguration||result.platformId!==prepared.platformId||result.seedSha256!==prepared.seedSha256||result.seedBytes!==prepared.seedBytes||Object.keys(resources).some(key=>result[key as keyof typeof resources]!==prepared[key as keyof typeof resources]))throw invalid();return result;
 }
 async acknowledge(resolved:WindowsSnapshotTransaction,options:RunOptions={}){
  transaction.parse(resolved);if(!['committed','rolled-back'].includes(resolved.phase))throw invalid();
  return z.object({acknowledged:z.literal(true)}).strict().parse(await this.broker.call('snapshot-acknowledge',{id:resolved.id,transactionId:resolved.transactionId},options));
 }
 async readSeed(receipt:WindowsSnapshotTransaction,options:RunOptions={}){
  transaction.parse(receipt);if(!['applied','committed','rolled-back'].includes(receipt.phase))throw invalid();
  const chunks:Buffer[]=[],hash=createHash('sha256');let offset=0;
  try{
   while(offset<receipt.seedBytes){
    options.signal?.throwIfAborted();const result=z.object({data:z.string().max(43692),nextOffset:z.number().int().nonnegative().safe(),done:z.boolean()}).strict().parse(await this.broker.call('snapshot-seed',{id:receipt.id,transactionId:receipt.transactionId,offset},{...options,timeoutMs:options.timeoutMs??30000}));
    const bytes=Buffer.from(result.data,'base64'),expected=Math.min(32768,receipt.seedBytes-offset);
    if(bytes.length!==expected||bytes.toString('base64')!==result.data||result.nextOffset!==offset+expected||result.done!==(offset+expected===receipt.seedBytes)){bytes.fill(0);throw invalid();}
    offset=result.nextOffset;hash.update(bytes);chunks.push(bytes);
   }
   if(hash.digest('hex')!==receipt.seedSha256)throw invalid();return Buffer.concat(chunks);
  }finally{for(const chunk of chunks)chunk.fill(0);}
 }
}
