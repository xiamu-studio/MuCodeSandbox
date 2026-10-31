import path from 'node:path';
import {z} from 'zod';
import {AppError} from '../../errors.ts';
import type {WindowsManager} from './manager.ts';
import type {WindowsSnapshotCoordinator} from './snapshot-coordinator.ts';
import type {WindowsSnapshots} from './snapshots.ts';
import {windowsSnapshotRecord,windowsSnapshotDeletion,windowsSnapshotStaging,windowsSnapshotStagingReview} from './snapshots.ts';
import type {WindowsSnapshotReplayJournal} from './snapshot-replay-journal.ts';
import type {WindowsSnapshotProductStatus,WindowsSnapshotStagingReview,WindowsSnapshotStagingReviewState} from '../../../shared/windows-snapshots.ts';
import {WindowsBackupCleanupRegistry} from './backup-cleanup.ts';
export type {WindowsSnapshotProductStatus} from '../../../shared/windows-snapshots.ts';

export type WindowsSnapshotCoordinatorPort=Pick<WindowsSnapshotCoordinator,'store'|'root'|'create'|'restore'|'recover'|'recoverAll'|'list'|'remove'|'deletions'>&{
 native:Pick<WindowsSnapshots,'status'|'pending'|'staging'|'inspectStaging'|'cleanupStaging'>;
 journal:Pick<WindowsSnapshotReplayJournal,'has'|'pending'>;
};
export interface WindowsSnapshotProductOptions {enabled?:boolean;liveDeletionEnabled?:boolean;exportEnabled?:boolean;available?:()=>boolean;recoveryAvailable?:()=>boolean}
const identity=z.uuid().refine(value=>value===value.toLowerCase()&&value!=='00000000-0000-0000-0000-000000000000');
const name=z.string().min(1).max(60).refine(value=>value===value.trim()&&!/[\x00-\x1f\x7f]/.test(value));
const pendingMessage='快照恢复尚未接续，相关磁盘、配置和日志已保留；请先核对恢复状态';
const stagingMessage='发现未发布快照副本，可能仍占用磁盘空间；新复制已暂停，请先核验归属和清理凭据。当前环境和已有快照保持原样';

// Product admission and job ownership surround the authenticated transaction
// coordinator. Initialization must precede ordinary startup recovery even when
// new snapshot creation is disabled. No method here starts a VM.
export class WindowsSnapshotProduct {
 readonly manager:WindowsManager;readonly coordinator:WindowsSnapshotCoordinatorPort;readonly options:WindowsSnapshotProductOptions;
 private readonly cleanupRegistry:WindowsBackupCleanupRegistry;
 private initialized=false;private initializing:Promise<WindowsSnapshotProductStatus>|undefined;
 private pendingIds=new Set<string>();private operating=new Set<string>();private liveDeleting=new Set<string>();private issues=new Map<string,string>();private globalIssue:string|null=null;
 private stagingReviews=new Map<string,{jobId:string;expires:number;review?:WindowsSnapshotStagingReview}>();
 constructor(manager:WindowsManager,coordinator:WindowsSnapshotCoordinatorPort,options:WindowsSnapshotProductOptions={}){
  if(manager.snapshotAdmission||coordinator.store!==manager.store||path.resolve(coordinator.root).toLowerCase()!==path.resolve(manager.options.runtimeRoot).toLowerCase())throw new AppError('快照管理器与当前工作区不一致',409,'SNAPSHOT_IDENTITY');
  this.manager=manager;this.coordinator=coordinator;this.options=options;
  this.cleanupRegistry=new WindowsBackupCleanupRegistry(manager.store,manager.options.runtimeRoot);
  manager.snapshotAdmission={assertWritable:id=>this.assertWritable(id),assertReadable:id=>this.assertAdmission(id,true),verifyWritable:id=>this.verifyWritable(id),blocked:id=>{try{this.assertWritable(id);return false;}catch{return true;}}};
 }
 status():WindowsSnapshotProductStatus{
  const cleanupIssues=this.cleanupRegistry.snapshotIssues(),cleanupIndexIssue=this.cleanupRegistry.issue;
  let journalIds:string[]=[];try{journalIds=this.coordinator.journal.pending();}catch{this.globalIssue='无法核验快照恢复日志，原数据已保留';}
  return {initialized:this.initialized,enabled:!!this.options.enabled,stagingCleanupAvailable:!!this.options.enabled,available:this.options.available?.()??true,recoveryAvailable:this.options.recoveryAvailable?.()??true,...(this.options.liveDeletionEnabled?{liveDeletionAvailable:true}:{}),...(this.options.exportEnabled?{exportAvailable:true}:{}),activeIds:[...new Set([...this.operating,...this.manager.snapshotExportIds()])].sort(),pendingIds:[...new Set([...this.pendingIds,...journalIds])].sort(),issues:[...(this.globalIssue?[{id:null,message:this.globalIssue}]:[]),...[...this.issues].map(([id,message])=>({id,message}))],...(cleanupIssues.length?{cleanupIssues}:{}),...(cleanupIndexIssue?{cleanupIndexIssue}:{})};
 }
 assertWritable(id?:string){this.assertAdmission(id,false);}
 private assertAdmission(id:string|undefined,readable:boolean){
  if(!this.initialized||this.globalIssue)throw new AppError(pendingMessage,409,'SNAPSHOT_PENDING');
  if(id&&this.operating.has(id)&&!(readable&&this.liveDeleting.has(id)))throw new AppError('该环境正在处理快照操作，请等待完成',409,'SNAPSHOT_BUSY');
  try{if(id?this.pendingIds.has(id)||this.issues.has(id)||this.coordinator.journal.has(id):this.pendingIds.size||this.issues.size||this.coordinator.journal.pending().length)throw new AppError(pendingMessage,409,'SNAPSHOT_PENDING');}
  catch(error){if(error instanceof AppError&&error.code==='SNAPSHOT_PENDING')throw error;this.globalIssue='无法核验快照恢复日志，原数据已保留';throw new AppError(pendingMessage,409,'SNAPSHOT_PENDING');}
 }
 private async verifyWritable(id?:string){
  this.assertWritable(id);
  let native:string[];try{native=await this.coordinator.native.pending();}catch{this.globalIssue='无法核验待完成快照，原磁盘和配置已保留';throw new AppError(pendingMessage,409,'SNAPSHOT_PENDING');}
  for(const value of native){this.pendingIds.add(identity.parse(value));if(!this.operating.has(value))this.issues.set(value,pendingMessage);}
  this.assertWritable(id);
 }
 initialize(force=false){
  if(this.initializing)return this.initializing;if(!force&&this.initialized&&!this.globalIssue)return Promise.resolve(this.status());
  if(this.manager.tasks.size||this.manager.sessions.size)throw new AppError('请先停止环境并等待当前操作完成',409,'ENVIRONMENT_BUSY');
  if(!(this.options.recoveryAvailable?.()??true)){this.initialized=false;this.globalIssue='运行组件尚未激活，请先完成组件准备并重新打开软件后核验快照恢复状态';return Promise.resolve(this.status());}
  this.initialized=false;
  this.initializing=(async()=>{
   try{
    const result=await this.coordinator.recoverAll();
    const ids=[...this.coordinator.journal.pending(),...await this.coordinator.native.pending()];
    this.pendingIds=new Set(ids);this.issues.clear();for(const issue of result.issues){this.pendingIds.add(identity.parse(issue.id));this.issues.set(issue.id,pendingMessage);}for(const id of this.pendingIds){identity.parse(id);this.issues.set(id,pendingMessage);}
    for(const id of result.recovered)this.manager.profiles.delete(id);
    this.globalIssue=null;this.initialized=true;
   }catch{this.initialized=false;this.globalIssue='无法核验待完成快照，原磁盘和配置已保留；普通写入继续受限';}
   return this.status();
  })().finally(()=>{this.initializing=undefined;});return this.initializing;
 }
 private available(){if(!this.options.enabled)throw new AppError('快照创建和恢复尚未开放',409,'FEATURE_UNAVAILABLE');if(!(this.options.available?.()??true))throw new AppError('请先完成系统组件准备',409,'HOST_REQUIREMENTS');}
 async list(id:string){identity.parse(id);this.manager.store.get(id);const records=z.array(windowsSnapshotRecord).max(32).parse(await this.coordinator.list(id));if(records.some(record=>record.environmentId!==id)||new Set(records.map(record=>record.id)).size!==records.length)throw new AppError('快照列表与当前环境不一致',409,'SNAPSHOT_IDENTITY');return records;}
 async deletions(id:string){identity.parse(id);this.manager.store.get(id);const records=z.array(windowsSnapshotDeletion).max(32).parse(await this.coordinator.deletions(id));if(records.some(record=>record.environmentId!==id)||new Set(records.map(record=>record.id)).size!==records.length)throw new AppError('待清理快照与当前环境不一致',409,'SNAPSHOT_IDENTITY');return records;}
 async staging(id:string){identity.parse(id);this.manager.store.get(id);return windowsSnapshotStaging.parse(await this.coordinator.native.staging(id));}
 stagingReviewState(id:string):WindowsSnapshotStagingReviewState{
  identity.parse(id);this.manager.store.get(id);const current=this.stagingReviews.get(id);if(!current||current.expires<Date.now()){this.stagingReviews.delete(id);return {phase:'idle'};}
  const job=this.manager.store.jobs().find(row=>row.id===current.jobId);if(!job)return {phase:'idle'};
  return {phase:job.status==='running'?'running':job.status==='succeeded'&&current.review?'ready':'failed',jobId:current.jobId,...(job.status==='succeeded'&&current.review?{review:current.review}:{})};
 }
 inspectStaging(id:string,copyId:string,operation:'create'|'restore'){
  identity.parse(id);identity.parse(copyId);windowsSnapshotStagingReview.shape.operation.parse(operation);this.assertWritable(id);
  if(!(this.options.recoveryAvailable?.()??true))throw new AppError('请先完成运行组件准备',409,'HOST_REQUIREMENTS');
  this.stagingReviews.delete(id);const job=this.submit(id,'snapshot-staging-review',async signal=>{
   const review=windowsSnapshotStagingReview.parse(await this.coordinator.native.inspectStaging(id,copyId,operation,{signal}));if(review.id!==copyId||review.operation!==operation)throw new AppError('遗留副本核验回执不一致',409,'SNAPSHOT_IDENTITY');
   signal.throwIfAborted();this.stagingReviews.set(id,{jobId:job.id,review,expires:Date.now()+5*60*1000});return '遗留副本核验完成；尚未删除文件';
  });this.stagingReviews.set(id,{jobId:job.id,expires:Date.now()+5*60*1000});return job;
 }
 cleanupStaging(id:string,copyId:string,operation:'create'|'restore',token:string,confirmation:string,resumeOnly:boolean){
  identity.parse(id);identity.parse(copyId);windowsSnapshotStagingReview.shape.operation.parse(operation);windowsSnapshotStagingReview.shape.token.parse(token);z.boolean().parse(resumeOnly);this.assertWritable(id);
  if(!(this.options.recoveryAvailable?.()??true))throw new AppError('请先完成运行组件准备',409,'HOST_REQUIREMENTS');
  if(confirmation!==this.manager.store.get(id).name)throw new AppError('请输入完整环境名称以确认清理',400,'SNAPSHOT_CONFIRMATION');
  const state=this.stagingReviewState(id),review=state.review;if(state.phase!=='ready'||!review||review.id!==copyId||review.operation!==operation||review.token!==token)throw new AppError('清理核验已失效，请重新核验选定条目',409,'SNAPSHOT_REVIEW_EXPIRED');
  if(resumeOnly!==(review.phase!=='copy'))throw new AppError('清理重试方式与核验记录不一致',409,'SNAPSHOT_IDENTITY');
  if(!this.options.enabled&&!resumeOnly)throw new AppError('新的遗留副本清理尚未开放，已有清理记录仍可接续',409,'FEATURE_UNAVAILABLE');
  const job=this.submit(id,'snapshot-staging-cleanup',async signal=>{await this.coordinator.native.cleanupStaging(id,review,resumeOnly,{signal});return '遗留副本已清理；环境保持停止';});this.stagingReviews.delete(id);return job;
 }
 private async settle(id:string){
  if((await this.coordinator.native.status(id)).pending||this.coordinator.journal.has(id))throw new AppError(pendingMessage,409,'SNAPSHOT_PENDING');
  this.pendingIds.delete(id);this.issues.delete(id);
 }
 private submit(id:string,action:'snapshot-create'|'snapshot-restore'|'snapshot-recover'|'snapshot-delete'|'snapshot-staging-review'|'snapshot-staging-cleanup',work:(signal:AbortSignal)=>Promise<unknown>){
  return this.manager.runSnapshotOperation(id,action,async signal=>{
   this.operating.add(id);this.manager.profiles.delete(id);
   let attempted=false;
   try{
    if((action==='snapshot-create'||action==='snapshot-restore')&&(await this.staging(id)).entries.length)throw new AppError(stagingMessage,409,'SNAPSHOT_STAGING_PENDING');
    attempted=true;const result=await work(signal);if(action==='snapshot-staging-review')signal.throwIfAborted();await this.settle(id);if(action==='snapshot-staging-review')signal.throwIfAborted();if(typeof result==='string')return result;
   }
   catch(error){
    if(attempted&&(action==='snapshot-restore'||action==='snapshot-recover')){try{await this.coordinator.recover(id);}catch{/* Keep the fence unless authoritative idle state is confirmed below. */}}
    try{await this.settle(id);}catch{this.pendingIds.add(id);this.issues.set(id,pendingMessage);}
    if(!this.pendingIds.has(id)&&error instanceof AppError&&error.code==='SNAPSHOT_STAGING_PENDING')throw new AppError(stagingMessage,409,'SNAPSHOT_STAGING_PENDING');
    throw new AppError(this.pendingIds.has(id)?pendingMessage:'快照操作未完成，已核对没有待完成事务；请检查操作记录',409,this.pendingIds.has(id)?'SNAPSHOT_RECOVERY_REQUIRED':'SNAPSHOT_FAILED');
   }finally{this.operating.delete(id);this.manager.profiles.delete(id);}
  });
 }
 create(id:string,label:string){this.available();identity.parse(id);name.parse(label);this.assertWritable(id);return this.submit(id,'snapshot-create',signal=>this.coordinator.create(this.manager.store.get(id),label,{signal}));}
 remove(id:string,snapshotId:string,snapshotName:string,confirmation:string,resumeOnly:boolean){
  identity.parse(id);identity.parse(snapshotId);name.parse(snapshotName);z.boolean().parse(resumeOnly);this.assertWritable(id);
  if(!resumeOnly&&!this.options.enabled)throw new AppError('快照删除尚未开放',409,'FEATURE_UNAVAILABLE');
  if(!(this.options.recoveryAvailable?.()??true))throw new AppError('请先完成组件准备并重新打开软件',409,'HOST_REQUIREMENTS');
  if(confirmation!==this.manager.store.get(id).name)throw new AppError('请输入完整环境名称以确认快照删除',400,'SNAPSHOT_CONFIRMATION');
  if(this.manager.store.get(id).state==='running'){
   if(!this.options.liveDeletionEnabled)throw new AppError('运行中删除快照尚未开放，请先停止环境',409,'FEATURE_UNAVAILABLE');
   return this.manager.runLiveSnapshotDeletion(id,async signal=>{
    this.operating.add(id);this.liveDeleting.add(id);
    try{await this.coordinator.remove(id,snapshotId,snapshotName,resumeOnly,{signal,allowRunning:true});await this.settle(id);}
    catch{try{await this.settle(id);}catch{this.pendingIds.add(id);this.issues.set(id,pendingMessage);}throw new AppError('旧快照删除未完成，请保留待清理记录',409,'SNAPSHOT_FAILED');}
    finally{this.liveDeleting.delete(id);this.operating.delete(id);}
   });
  }
  return this.submit(id,'snapshot-delete',signal=>this.coordinator.remove(id,snapshotId,snapshotName,resumeOnly,{signal}));
 }
 restore(id:string,snapshotId:string,confirmation:string){
  this.available();identity.parse(id);identity.parse(snapshotId);this.assertWritable(id);const environment=this.manager.store.get(id);
  if(confirmation!==environment.name)throw new AppError('请输入完整环境名称以确认快照恢复',400,'SNAPSHOT_CONFIRMATION');
  return this.submit(id,'snapshot-restore',signal=>this.coordinator.restore(this.manager.store.get(id),snapshotId,{signal}));
 }
 recover(id:string,confirmation:string){
  if(!(this.options.recoveryAvailable?.()??true))throw new AppError('请先完成组件准备并重新打开软件',409,'HOST_REQUIREMENTS');
  identity.parse(id);if(!this.initialized||this.globalIssue)throw new AppError('请先重新核验工作区的快照恢复状态',409,'SNAPSHOT_PENDING');
  if(confirmation!==this.manager.store.get(id).name)throw new AppError('请输入完整环境名称以确认事务接续',400,'SNAPSHOT_CONFIRMATION');
  // Recovery remains available when creation is disabled or host admission is
  // fenced. The native coordinator still requires the exact stopped allocation.
  return this.submit(id,'snapshot-recover',()=>this.coordinator.recover(id));
 }
}
