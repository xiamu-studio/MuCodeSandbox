import path from 'node:path';
import type {Environment} from '../../../shared/types.ts';
import type {Store} from '../../store.ts';
import type {RunOptions} from '../../process.ts';
import {AppError} from '../../errors.ts';
import type {HyperVBrokerClient} from './broker.ts';
import {WindowsSnapshots,type WindowsSnapshotTransaction,type WindowsSnapshotDeleteOptions} from './snapshots.ts';
import {WindowsSnapshotOwnerCodec,type WindowsSnapshotOwnerPayload,type WindowsSnapshotOwnerFile} from './snapshot-owner.ts';
import {WindowsSnapshotReplayJournal,snapshotOwnerBinding,type WindowsSnapshotReplayEntry} from './snapshot-replay-journal.ts';
import {replayWindowsSnapshotOwnerFiles} from './snapshot-owner-files.ts';

const operations=new Set<string>();
const pending=()=>new AppError('快照恢复尚待接续，当前磁盘和配置已保留',409,'SNAPSHOT_PENDING');
export interface WindowsSnapshotRecoveryResult {id:string;transactionId:string;snapshotId:string;decision:'committed'|'rolled-back';alreadyAcknowledged:boolean}

// This is the complete owner-side transaction protocol. Product maintenance,
// authentication/confirmation and startup admission must surround these calls.
// Nothing here starts a VM or chooses a commit from a diagnostic status alone.
export class WindowsSnapshotCoordinator {
 readonly store:Store;readonly root:string;readonly native:WindowsSnapshots;readonly codec:WindowsSnapshotOwnerCodec;readonly journal:WindowsSnapshotReplayJournal;
 constructor(store:Store,root:string,broker:Pick<HyperVBrokerClient,'call'>){this.store=store;this.root=path.resolve(root);this.native=new WindowsSnapshots(broker);this.codec=new WindowsSnapshotOwnerCodec(store,this.root);this.journal=new WindowsSnapshotReplayJournal(store,this.codec);}
 private async exclusive<T>(id:string,work:()=>Promise<T>){
  const key=this.root.toLowerCase()+'\0'+id;if(operations.has(key))throw new AppError('该环境正在处理快照事务',409,'SNAPSHOT_BUSY');operations.add(key);try{return await work();}finally{operations.delete(key);}
 }
 private async idle(id:string,options:RunOptions){if(this.journal.has(id)||(await this.native.status(id,options)).pending)throw pending();}
 list(id:string,options:RunOptions={}){return this.native.list(id,options);}
 deletions(id:string,options:RunOptions={}){return this.native.deletions(id,options);}
 remove(id:string,snapshotId:string,name:string,resumeOnly:boolean,options:WindowsSnapshotDeleteOptions={}){return this.exclusive(id,async()=>{options.signal?.throwIfAborted();await this.idle(id,options);return this.native.remove(id,snapshotId,name,resumeOnly,options);});}
 create(environment:Environment,name:string,options:RunOptions={}){return this.exclusive(environment.id,async()=>{options.signal?.throwIfAborted();await this.idle(environment.id,options);const captured=await this.codec.capture(environment,options);return this.native.create(environment.id,name,captured,options);});}
 private begin(receipt:WindowsSnapshotTransaction,prior:{cipher:string;owner:WindowsSnapshotOwnerPayload},target:WindowsSnapshotOwnerPayload,allowMissing=false){
  return this.journal.begin({format:1,id:receipt.id,transactionId:receipt.transactionId,snapshotId:receipt.snapshotId,createdAt:new Date().toISOString(),prior:{cipher:prior.cipher,binding:snapshotOwnerBinding(prior.owner)},target:{cipher:receipt.ownerConfiguration,binding:snapshotOwnerBinding(target)}},allowMissing);
 }
 private async replay(entry:WindowsSnapshotReplayEntry,receipt:WindowsSnapshotTransaction,options:RunOptions={},allowMissing=false){
  const selected=this.journal.selected(entry,receipt),other=this.journal.other(entry,receipt);this.journal.assertAllowed(entry,allowMissing);let seed:Buffer|undefined,files:WindowsSnapshotOwnerFile[]=[];
  try{
   seed=await this.native.readSeed(receipt,options);files=await this.codec.files(selected,seed,options);
   await replayWindowsSnapshotOwnerFiles(this.root,receipt.id,receipt.transactionId,files,[],{...options,previousHashes:this.codec.fileBindings(other)});
   options.signal?.throwIfAborted();this.journal.persist(entry,receipt,allowMissing);
   await replayWindowsSnapshotOwnerFiles(this.root,receipt.id,receipt.transactionId,files,[],{...options,checkOnly:true});this.journal.assertSelected(entry,receipt);
  }finally{seed?.fill(0);for(const file of files)file.bytes.fill(0);}
 }
 private async finish(entry:WindowsSnapshotReplayEntry,receipt:WindowsSnapshotTransaction):Promise<WindowsSnapshotRecoveryResult>{
  if(!['committed','rolled-back'].includes(receipt.phase))throw pending();this.journal.assertSelected(entry,receipt);
  let seed:Buffer|undefined,files:WindowsSnapshotOwnerFile[]=[];
  try{seed=await this.native.readSeed(receipt);files=await this.codec.files(this.journal.selected(entry,receipt),seed);await replayWindowsSnapshotOwnerFiles(this.root,receipt.id,receipt.transactionId,files,[],{checkOnly:true});this.journal.assertSelected(entry,receipt);}
  finally{seed?.fill(0);for(const file of files)file.bytes.fill(0);}
  await this.native.acknowledge(receipt);const outcome=await this.native.outcome(receipt.id,receipt.transactionId);this.journal.archive(entry,outcome);
  return{id:receipt.id,transactionId:receipt.transactionId,snapshotId:receipt.snapshotId,decision:outcome.phase,alreadyAcknowledged:false};
 }
 private async recoverLocked(id:string):Promise<WindowsSnapshotRecoveryResult|null>{
  let entry=this.journal.get(id);const current=await this.native.status(id);
  if(entry&&current.pending&&(current.transactionId!==entry.value.transactionId||current.snapshotId!==entry.value.snapshotId))throw pending();
  if(!current.pending){
   if(!entry)return null;const outcome=await this.native.outcome(id,entry.value.transactionId);this.journal.archive(entry,outcome);
   return{id,transactionId:outcome.transactionId,snapshotId:outcome.snapshotId,decision:outcome.phase,alreadyAcknowledged:true};
  }
  // Status binds only which transaction may be reconciled, never its decision.
  const recovered=await this.native.recover(id,{transactionId:current.transactionId});
  if(!recovered.pending){if(!entry)throw pending();const outcome=await this.native.outcome(id,entry.value.transactionId);this.journal.archive(entry,outcome);return{id,transactionId:outcome.transactionId,snapshotId:outcome.snapshotId,decision:outcome.phase,alreadyAcknowledged:true};}
  if(!entry){const selected=this.codec.decode(recovered.ownerConfiguration,recovered);entry=this.begin(recovered,{cipher:recovered.ownerConfiguration,owner:selected},selected,true);}
  await this.replay(entry,recovered,{},true);return this.finish(entry,recovered);
 }
 recover(id:string){return this.exclusive(id,()=>this.recoverLocked(id));}
 async recoverAll(){
  const ids=[...new Set([...this.journal.pending(),...await this.native.pending()])],recovered:string[]=[],issues:{id:string;message:string}[]=[];
  if(ids.length>32)throw pending();for(const id of ids){try{await this.recover(id);recovered.push(id);}catch{issues.push({id,message:'快照恢复尚未完成；原磁盘、配置和恢复日志已保留，请先处理恢复问题'});}}
  return{recovered,issues};
 }
 restore(environment:Environment,snapshotId:string,options:RunOptions={}){return this.exclusive(environment.id,async()=>{
  options.signal?.throwIfAborted();await this.idle(environment.id,options);const prior=await this.codec.captureState(environment,options);let attempted=false;
  try{
   options.signal?.throwIfAborted();attempted=true;const prepared=await this.native.prepare(environment.id,snapshotId,prior.configuration,options);
   if(prepared.platformId!==prior.owner.platformId)throw pending();const target=this.codec.decode(prepared.ownerConfiguration,prepared),entry=this.begin(prepared,{cipher:prior.configuration.ownerConfiguration,owner:prior.owner},target);
   await this.replay(entry,prepared,options);options.signal?.throwIfAborted();const committed=await this.native.commit(prepared,options);return await this.finish(entry,committed);
  }catch(error){
   if(attempted){let resolved:WindowsSnapshotRecoveryResult|null;try{resolved=await this.recoverLocked(environment.id);}catch{throw new AppError('快照恢复未完成且无法安全接续，事务已保留；请先恢复该事务再启动环境',409,'SNAPSHOT_RECOVERY_REQUIRED');}if(resolved?.decision==='committed')return resolved;}
   options.signal?.throwIfAborted();if(error instanceof AppError)throw error;throw new AppError('快照恢复未完成，已按原生决定接续；请检查恢复状态',409,'SNAPSHOT_FAILED');
  }
 });}
}
