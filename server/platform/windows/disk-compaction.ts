import {z} from 'zod';
import {setTimeout as delay} from 'node:timers/promises';
import {AppError} from '../../errors.ts';
import type {RunOptions} from '../../process.ts';
import type {WindowsConfig} from './config.ts';
import type {HyperVRuntime} from './runtime.ts';
import {windowsDiskIdentifier,windowsDiskSize} from '../../../shared/windows-disk.ts';
import {armWindowsDiskMaintenance,windowsRootGrowthScript,windowsFilesystemGrowth} from './disk-growth.ts';
import {parseWindowsRootTrimReceipt,windowsRootTrimScript} from './disk-trim.ts';

// Desktop preview opts in explicitly after Hyper-V main-path validation. An
// uncertain provider outcome remains fenced and may need support; a
// caller-selected disk path is never accepted.
type CompactionRuntime=Pick<HyperVRuntime,'state'|'stop'|'disconnect'|'inspectGuard'|'management'> & {
 broker:{call:(action:'disk-compact-begin'|'disk-compact-trimmed'|'disk-compact-run'|'disk-compact-reconcile'|'disk-compact-review'|'disk-compact-finish'|'disk-compact-status'|'disk-compact-retry'|'disk-compact-cancel',parameters:Record<string,unknown>,options?:RunOptions)=>Promise<unknown>};
 startDiskCompaction:(config:WindowsConfig,options:RunOptions)=>Promise<unknown>;
 startDiskCompactionVerify:(config:WindowsConfig,options:RunOptions)=>Promise<unknown>;
};
const identity=z.object({platformId:z.uuid(),diskIdentifier:windowsDiskIdentifier,diskGiB:windowsDiskSize,phase:z.enum(['preparing','armed','compacting','verifying'])}).strict();
type Identity=z.infer<typeof identity>;
const status=z.discriminatedUnion('pending',[z.object({pending:z.literal(false)}).strict(),z.object({pending:z.literal(true),platformId:z.uuid(),diskIdentifier:windowsDiskIdentifier,diskGiB:windowsDiskSize,phase:z.enum(['preparing','trimming','armed','compacting','verifying']),beforeBytes:z.number().int().nonnegative().safe(),jobTracked:z.boolean().nullable().optional()}).strict()]);
export type WindowsCompactionStatus=z.infer<typeof status>;
export async function windowsCompactionStatus(runtime:CompactionRuntime,config:WindowsConfig,options:RunOptions={}){return status.parse(await runtime.broker.call('disk-compact-status',{id:config.id},{...options,timeoutMs:90000}));}
function same(actual:Identity,original:Identity,phase:Identity['phase']){
 if(actual.phase!==phase||actual.platformId!==original.platformId||actual.diskIdentifier!==original.diskIdentifier||actual.diskGiB!==original.diskGiB)throw new AppError('磁盘维护身份或阶段发生变化，已保留待处理状态。',409,'DISK_COMPACTION_IDENTITY');
}
async function closed(runtime:CompactionRuntime,config:WindowsConfig){const guard=await runtime.inspectGuard(config);if(guard.leaseActive||guard.remainingMs!==0)throw new AppError('无法确认维护时业务网络关闭。',409,'DISK_COMPACTION_NETWORK');}
async function waitForCompaction(runtime:CompactionRuntime,config:WindowsConfig,original:Identity,options:RunOptions){
 const deadline=performance.now()+1800000;
 for(;;){
  options.signal?.throwIfAborted();
  try{const result=identity.parse(await runtime.broker.call('disk-compact-reconcile',{id:config.id},{...options,timeoutMs:90000}));same(result,original,'verifying');return result;}
  catch(error){if(!(error instanceof AppError)||error.code!=='DISK_COMPACTION_RUNNING')throw error;}
  if(performance.now()>=deadline)throw new AppError('磁盘压缩仍在进行，结果未确认；请保留磁盘并稍后继续检查。',409,'DISK_COMPACTION_UNCONFIRMED');
  await delay(Math.min(2000,Math.max(1,deadline-performance.now())),undefined,{signal:options.signal});
 }
}
async function maintenance(runtime:CompactionRuntime,config:WindowsConfig,work:()=>Promise<void>){
 let failure:unknown,stopFailure:unknown,failed=false,stopFailed=false;
 try{await work();}catch(error){failed=true;failure=error;}
 finally{try{await runtime.stop(config);}catch(error){stopFailed=true;stopFailure=error;}}
 if(failed&&stopFailed)throw new AggregateError([failure,stopFailure],'磁盘维护失败，停止环境也未确认。');
 if(failed)throw failure;if(stopFailed)throw stopFailure;
}

export async function prepareAndCompactWindowsDisk(runtime:CompactionRuntime,config:WindowsConfig,options:RunOptions={}){
 windowsDiskSize.parse(config.diskGiB);options.signal?.throwIfAborted();
 if((await runtime.state(config)).state!=='Off')throw new AppError('请先停止环境。',409,'DISK_COMPACTION_STATE');
 await runtime.disconnect(config.id);options.signal?.throwIfAborted();
 const original=identity.parse(await runtime.broker.call('disk-compact-begin',{id:config.id},{...options,timeoutMs:90000}));
 if(original.phase!=='preparing'||original.diskGiB!==config.diskGiB)throw new AppError('磁盘维护准备回执不一致。',409,'DISK_COMPACTION_IDENTITY');
 return runPrepared(runtime,config,original,options);
}
async function runPrepared(runtime:CompactionRuntime,config:WindowsConfig,original:Identity,options:RunOptions){
 await maintenance(runtime,config,async()=>{
  options.signal?.throwIfAborted();await runtime.startDiskCompaction(config,options);
  await armWindowsDiskMaintenance(runtime,config,options);await closed(runtime,config);options.signal?.throwIfAborted();
  const raw=await runtime.management(config,['sudo','-n','python3','-'],{...options,input:windowsRootTrimScript(config.diskGiB),timeoutMs:150000,maxBytes:4096,onOutput:undefined});
  parseWindowsRootTrimReceipt(raw,config.diskGiB);await closed(runtime,config);options.signal?.throwIfAborted();
 });
 options.signal?.throwIfAborted();if((await runtime.state(config)).state!=='Off')throw new AppError('无法确认环境已停止，未压缩磁盘。',409,'DISK_COMPACTION_STATE');
 const ready=identity.parse(await runtime.broker.call('disk-compact-trimmed',{id:config.id},{...options,timeoutMs:90000}));same(ready,original,'armed');
 options.signal?.throwIfAborted();let result:Identity;
 try{result=identity.parse(await runtime.broker.call('disk-compact-run',{id:config.id},{...options,timeoutMs:1850000}));same(result,original,'verifying');}
 catch(error){if(!(error instanceof AppError)||error.code!=='DISK_COMPACTION_RUNNING')throw error;result=await waitForCompaction(runtime,config,original,options);}
 // Verifying remains fenced. No reclaimed-byte or completion claim is made.
 return result;
}

function fromPending(value:Extract<WindowsCompactionStatus,{pending:true}>,phase:Identity['phase']):Identity{return {platformId:value.platformId,diskIdentifier:value.diskIdentifier,diskGiB:value.diskGiB,phase};}
export async function resumeWindowsDiskCompaction(runtime:CompactionRuntime,config:WindowsConfig,options:RunOptions={}){
 options.signal?.throwIfAborted();const pending=await windowsCompactionStatus(runtime,config,options);
 if(!pending.pending)throw new AppError('没有待继续的磁盘维护记录。',409,'DISK_COMPACTION_NONE');
 if(pending.diskGiB!==config.diskGiB)throw new AppError('磁盘维护容量与环境不一致。',409,'DISK_COMPACTION_IDENTITY');
 if(pending.phase==='compacting'){
  if(pending.jobTracked===false)throw new AppError('原压缩作业身份未记录，无法自动确认结果；请保留磁盘并联系支持，不要重复回收。',409,'DISK_COMPACTION_JOB_UNAVAILABLE');
  const original=fromPending(pending,'verifying');
  const resolved=await waitForCompaction(runtime,config,original,options);
  return inspectCompactedWindowsDisk(runtime,config,resolved,options);
 }
 if((await runtime.state(config)).state!=='Off')throw new AppError('请先停止维护环境。',409,'DISK_COMPACTION_STATE');
 await runtime.disconnect(config.id);options.signal?.throwIfAborted();
 if(pending.phase==='verifying')return inspectCompactedWindowsDisk(runtime,config,fromPending(pending,'verifying'),options);
 let original=fromPending(pending,'preparing');
 if(pending.phase==='trimming'||pending.phase==='armed'){
  const retried=identity.parse(await runtime.broker.call('disk-compact-retry',{id:config.id},{...options,timeoutMs:90000}));same(retried,original,'preparing');original=retried;
 }
 const ready=await runPrepared(runtime,config,original,options);return inspectCompactedWindowsDisk(runtime,config,ready,options);
}
export async function cancelPreCompaction(runtime:CompactionRuntime,config:WindowsConfig,options:RunOptions={}){
 options.signal?.throwIfAborted();const pending=await windowsCompactionStatus(runtime,config,options);
 if(!pending.pending||pending.diskGiB!==config.diskGiB||!['preparing','trimming','armed'].includes(pending.phase))throw new AppError('当前磁盘维护阶段不能安全取消。',409,'DISK_COMPACTION_UNCONFIRMED');
 if((await runtime.state(config)).state!=='Off')throw new AppError('请先停止维护环境。',409,'DISK_COMPACTION_STATE');
 return z.object({cancelled:z.literal(true)}).strict().parse(await runtime.broker.call('disk-compact-cancel',{id:config.id},{...options,timeoutMs:90000}));
}

const review=identity.extend({phase:z.literal('verifying'),beforeBytes:z.number().int().nonnegative().safe(),afterBytes:z.number().int().nonnegative().safe()}).strict();
const complete=z.object({completed:z.literal(true),platformId:z.uuid(),diskIdentifier:windowsDiskIdentifier,diskGiB:windowsDiskSize,beforeBytes:z.number().int().nonnegative().safe(),afterBytes:z.number().int().nonnegative().safe()}).strict();
export async function inspectCompactedWindowsDisk(runtime:CompactionRuntime,config:WindowsConfig,expected:Identity,options:RunOptions={}){
 const original=identity.parse(expected);if(original.phase!=='verifying'||original.diskGiB!==config.diskGiB)throw new AppError('磁盘待核验身份不一致。',409,'DISK_COMPACTION_IDENTITY');
 options.signal?.throwIfAborted();if((await runtime.state(config)).state!=='Off')throw new AppError('请先停止环境。',409,'DISK_COMPACTION_STATE');
 await runtime.disconnect(config.id);options.signal?.throwIfAborted();
 let filesystem:z.infer<typeof windowsFilesystemGrowth>|undefined;
 await maintenance(runtime,config,async()=>{
  await runtime.startDiskCompactionVerify(config,options);await armWindowsDiskMaintenance(runtime,config,options);await closed(runtime,config);options.signal?.throwIfAborted();
  const raw=await runtime.management(config,['sudo','-n','python3','-'],{...options,input:windowsRootGrowthScript(config.diskGiB,true),timeoutMs:30000,maxBytes:16384,onOutput:undefined});
  const fs=windowsFilesystemGrowth.parse(JSON.parse(raw));
  if(fs.diskBytes!==config.diskGiB*2**30||fs.beforeFilesystemBytes!==fs.filesystemBytes||fs.filesystemBytes>fs.partitionBytes||fs.partitionStartBytes+fs.partitionBytes>fs.diskBytes)throw new AppError('无法核验客体磁盘布局。',409,'DISK_COMPACTION_FILESYSTEM');
  await closed(runtime,config);options.signal?.throwIfAborted();filesystem=fs;
 });
 options.signal?.throwIfAborted();if((await runtime.state(config)).state!=='Off')throw new AppError('无法确认维护环境已停止。',409,'DISK_COMPACTION_STATE');
 const result=review.parse(await runtime.broker.call('disk-compact-review',{id:config.id},{...options,timeoutMs:90000}));
 same({platformId:result.platformId,diskIdentifier:result.diskIdentifier,diskGiB:result.diskGiB,phase:result.phase},original,'verifying');
 if(!filesystem)throw new AppError('客体磁盘布局检查未完成。',409,'DISK_COMPACTION_FILESYSTEM');
 options.signal?.throwIfAborted();
 const committed=complete.parse(await runtime.broker.call('disk-compact-finish',{id:config.id,filesystemBytes:filesystem.filesystemBytes,partitionBytes:filesystem.partitionBytes,partitionStartBytes:filesystem.partitionStartBytes,afterBytes:result.afterBytes},{...options,timeoutMs:90000}));
 if(committed.platformId!==result.platformId||committed.diskIdentifier!==result.diskIdentifier||committed.diskGiB!==result.diskGiB||committed.beforeBytes!==result.beforeBytes||committed.afterBytes!==result.afterBytes)throw new AppError('磁盘维护提交回执不一致。',409,'DISK_COMPACTION_IDENTITY');
 // This confirms mountability and geometry, not arbitrary user-file integrity.
 return committed;
}
