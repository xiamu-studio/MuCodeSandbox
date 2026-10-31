import {attachWindowsGuardDiagnostics,changedGuardComponents,guardFailureCode,guardFailureSource} from './guard-diagnostics.ts';
import type {GuardDiagnostics} from '../../../shared/windows-guard-diagnostics.ts';
import {randomUUID} from 'node:crypto';
import {access,lstat} from 'node:fs/promises';
import {lookup} from 'node:dns/promises';
import {isIPv4} from 'node:net';
import {cpus,totalmem,freemem,hostname} from 'node:os';
import path from 'node:path';
import type {Environment,Job,Snapshot,NetworkProtection,EgressStatus,EgressVerification} from '../../../shared/types.ts';
import {VERSION} from './release.ts';
import {Store} from '../../store.ts';
import {environmentSchema,redact} from '../../validation.ts';
import {AppError,errorMessage} from '../../errors.ts';
import type {RunOptions} from '../../process.ts';
import {HyperVRuntime} from './runtime.ts';
import {windowsConfigSchema,windowsPaths,vmIdentity,isSealedBase,type WindowsConfig} from './config.ts';
import type {WindowsNetworkSession} from './session.ts';
import {resourceIssue} from './resources.ts';
import {powerIssue} from './power.ts';
import {WindowsProtectionEvents} from './protection-events.ts';
import {windowsDiskSize,windowsDiskAllocationSummary} from '../../../shared/windows-disk.ts';

export interface WindowsBase {image:string;imageSha256:string}
export type WindowsBackend=Pick<HyperVRuntime,'info'|'create'|'start'|'stop'|'state'|'session'|'connect'|'inspectGuard'>&Partial<Pick<HyperVRuntime,'prepareNormalStop'|'remove'|'recoverCreation'|'deletionAvailable'|'resources'|'power'|'diskGrowthAvailable'|'diskGrowthInfo'|'growDisk'|'prepareDiskCompaction'|'verifyDiskCompaction'|'diskCompactionStatus'|'resumeDiskCompaction'|'cancelDiskCompaction'>>;
export interface WindowsManagerOptions {runtimeRoot:string;base?:WindowsBase;probe?:(config:WindowsConfig)=>()=>Promise<{receiver:string;ip:string}[]>;diskCompactionPreview?:boolean}

// Windows owns its lifecycle and storage integration. The shipping Mac
// Manager and service continue to use their existing constructors unchanged.
export class WindowsManager {
 readonly store:Store;readonly runtime:WindowsBackend;readonly options:WindowsManagerOptions;
 readonly active=new Map<string,string>();readonly sessions=new Map<string,WindowsNetworkSession>();
 private readonly statusInspections=new Map<string,{session:WindowsNetworkSession;promise:ReturnType<WindowsManager['inspectAccess']>}>();
 readonly profiles=new Map<string,WindowsConfig>();readonly tasks=new Map<string,{controller:AbortController;promise:Promise<void>;action?:string;localBackupCleanup?:boolean;liveSnapshotDeletion?:boolean}>();
 readonly protectionRecords:WindowsProtectionEvents;
 snapshotAdmission:{assertWritable:(id?:string)=>void;assertReadable?:(id:string)=>void;verifyWritable?:(id?:string)=>Promise<void>;blocked:(id:string)=>boolean}|undefined;
 private readonly liveSnapshotDeletions=new Map<string,string>();
 private readonly snapshotExports=new Map<string,string>();
 private readonly componentInstalls=new Map<string,string>();
 private readonly browserViewJobs=new Map<string,string>();
 snapshotExportIds(){return [...this.snapshotExports.keys()];}
 guestOperationBusy(id:string){const job=this.active.get(id);return !!job&&job!==this.liveSnapshotDeletions.get(id)&&job!==this.snapshotExports.get(id)&&job!==this.componentInstalls.get(id);}
 // Existing terminal streams may continue during browser open/close, but new
 // guest operations remain subject to the normal exclusive-job admission.
 terminalStreamBusy(id:string){return this.guestOperationBusy(id)&&this.active.get(id)!==this.browserViewJobs.get(id);}
 private assertSnapshotWritable(id?:string){this.snapshotAdmission?.assertWritable(id);}
 private async verifySnapshotWritable(id?:string){this.assertSnapshotWritable(id);await this.snapshotAdmission?.verifyWritable?.(id);this.assertSnapshotWritable(id);}
 private readonly sessionFailureEvents=new WeakMap<WindowsNetworkSession,string>();
 private readonly sessionEnvironments=new WeakMap<WindowsNetworkSession,Environment>();
 private readonly stoppingSessions=new Map<string,{session:WindowsNetworkSession;interrupted:boolean}>();
 private readonly deletions=new Set<string>();
 private maintenance=false;private diskMaintenance=false;
 private assertMaintenanceFree(){if(this.maintenance)throw new AppError('备份或恢复正在进行，请等待完成或取消任务',409,'BACKUP_BUSY');if(this.diskMaintenance)throw new AppError('磁盘回收正在进行，请等待完成或取消任务',409,'DISK_COMPACTION_BUSY');}
 private async assertBackupRestoreFinished(id:string){
  try{await lstat(path.join(windowsPaths(this.options.runtimeRoot,id).directory,'backup-restore.json'));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new AppError('无法核验备份恢复状态，请保留现有文件并检查管理目录',409,'RESTORE_PENDING');}
  throw new AppError('备份恢复尚未完成，请先使用原备份继续恢复',409,'RESTORE_PENDING');
 }
 private async assertDiskCompactionFinished(e:Environment){
  if(e.state==='not_created'||!this.runtime.diskCompactionStatus||this.runtime instanceof HyperVRuntime&&!this.runtime.broker)return;
  let pending:boolean;try{pending=(await this.runtime.diskCompactionStatus(await this.profile(e,false))).pending;}
  catch{throw new AppError('无法确认磁盘维护状态，请保留磁盘并检查维护状态',409,'DISK_COMPACTION_PENDING');}
  if(pending)throw new AppError('磁盘维护尚未确认完成，请保留磁盘并检查维护状态',409,'DISK_COMPACTION_PENDING');
 }
 runMaintenance(action:string,work:(signal:AbortSignal)=>Promise<void|string>){
  return this.maintenanceTask(action,work,true);
 }
 // Producer-sealed temporary files are independent of VM write admission and
 // can reclaim space while host components or snapshot recovery are fenced.
 // This fixed action still shares lifecycle exclusion, cancellation and exit.
 runBackupCleanupMaintenance(work:(signal:AbortSignal)=>Promise<void|string>){return this.maintenanceTask('backup-cleanup',work,false);}
 private maintenanceTask(action:string,work:(signal:AbortSignal)=>Promise<void|string>,vmWrite:boolean){
  if(vmWrite)this.assertSnapshotWritable();
  this.assertMaintenanceFree();if(this.closing)throw new AppError('应用正在退出',409,'CLOSING');
  if(vmWrite&&(this.hostIssue||this.resourceIssue||this.powerIssue))throw new AppError('请处理宿主防护问题并重新打开软件',409,'GUARD_FAILED');
  if(this.tasks.size||this.sessions.size||this.store.list().some(e=>['running','starting','creating','stopping'].includes(e.state)))throw new AppError('请先停止所有环境并等待当前操作完成',409,'ENVIRONMENT_BUSY');
  const job=this.store.newJob(null,action),controller=new AbortController();this.maintenance=true;
  // The owner must receive even a pre-aborted signal so its operation status
  // can settle. It checks cancellation before touching paths or the broker.
  const promise=Promise.resolve().then(()=>work(controller.signal)).then(message=>this.store.finishJob(job.id,'succeeded',typeof message==='string'?message:'操作完成'),error=>{this.store.finishJob(job.id,controller.signal.aborted?'cancelled':'failed',action==='backup-cleanup'?'临时清理未完成；请保留原清理凭据并查看备份面板':'备份或恢复未完成；请查看备份面板并保留原文件');}).finally(()=>{this.maintenance=false;this.tasks.delete(job.id);});
  this.tasks.set(job.id,{controller,promise,action,...(!vmWrite?{localBackupCleanup:true}:{})});return job;
 }
 onAccessRevoked:((id:string)=>void)|undefined;
 inspectAdditionalProtection:((id:string)=>Promise<void>)|undefined;
 browserRunning:((id:string)=>boolean)|undefined;
 browserAvailable=false;
 private resourceIssue:string|null=null;
 private powerIssue:string|null=null;
 private lifecycleIds=new Set<string>();
 private timer:ReturnType<typeof setInterval>;private monitorTask:Promise<void>|undefined;private closeTask:Promise<void>|undefined;private closing=false;private hostIssue:string|null=null;
 constructor(store:Store,runtime:WindowsBackend,options:WindowsManagerOptions){
  this.store=store;this.runtime=runtime;this.options=options;
  this.protectionRecords=new WindowsProtectionEvents(store);for(const e of store.list())this.protectionRecords.legacy(e);
  this.timer=setInterval(()=>{void this.monitor();},8000);this.timer.unref();
 }
 private view(e:Environment){return this.store.public({...e,browserRunning:this.browserRunning?.(e.id)??false});}
 private validate(input:unknown){
  const e=environmentSchema.parse(input);
  if(e.kind!=='vm'||!e.network.strict||!e.network.transparent||!e.network.egressLock||!['http','https','socks5'].includes(e.network.mode))throw new AppError('Windows 环境需要启用严格透明代理并批准出口 IPv4',400,'WINDOWS_STRICT_REQUIRED');
  if(e.mounts.length||e.ports.length)throw new AppError('Windows 持续共享和端口映射仍在适配；请先使用手动传输',409,'FEATURE_UNAVAILABLE');
  if(e.network.tls?.certificate)throw new AppError('Windows 自定义代理 CA 仍在适配，请使用受信任证书',409,'FEATURE_UNAVAILABLE');
  if(e.cpus>Math.min(16,cpus().length)||e.memoryGiB<2||e.memoryGiB>Math.min(32,Math.floor(totalmem()/2**30*.8))||e.diskGiB<16)throw new AppError('请使用可用的 CPU、至少 2 GiB 内存和至少 16 GiB 磁盘',400,'RESOURCE_LIMIT');
  if(this.options.base&&isSealedBase(this.options.base.image)&&e.diskGiB<32)throw new AppError('当前空白基盘需要至少 32 GiB 虚拟磁盘',400,'RESOURCE_LIMIT');
  return e;
 }
 async create(input:unknown){
  await this.verifySnapshotWritable();
  this.assertMaintenanceFree();
  const parsed=this.validate(input),id=randomUUID(),now=new Date().toISOString();
  const e:Environment={...parsed,id,instanceName:vmIdentity(id).name,state:'not_created',browserRunning:false,lastError:null,createdAt:now,updatedAt:now};
  this.store.save(e);this.store.log(id,null,`已创建 Windows Linux 环境「${e.name}」`);return this.view(e);
 }
 async update(id:string,input:unknown){
  await this.verifySnapshotWritable(id);
  this.assertMaintenanceFree();
  await this.assertBackupRestoreFinished(id);
  if(this.active.has(id)||this.sessions.has(id))throw new AppError('请先停止环境',409,'ENVIRONMENT_BUSY');
  const old=this.store.get(id),parsed=this.validate(input);
  await this.assertDiskCompactionFinished(old);
  if(old.state!=='not_created'&&(await this.runtime.state(await this.profile(old,false))).state!=='Off')throw new AppError('无法确认环境已停止，请先处理停机错误',409,'STOP_UNCONFIRMED');
  await this.verifySnapshotWritable(id);
  this.assertMaintenanceFree();
  await this.assertBackupRestoreFinished(id);
  await this.assertDiskCompactionFinished(old);
  this.assertMaintenanceFree();
  if(this.active.has(id)||this.sessions.has(id)||JSON.stringify(this.store.get(id))!==JSON.stringify(old))throw new AppError('环境已变化，请停止后重新读取配置',409,'ENVIRONMENT_BUSY');
  this.assertSnapshotWritable(id);
  if(old.state!=='not_created'&&(old.cpus!==parsed.cpus||old.memoryGiB!==parsed.memoryGiB||old.diskGiB!==parsed.diskGiB))throw new AppError('已创建环境的资源调整仍在适配',409,'FEATURE_UNAVAILABLE');
  const e={...old,...parsed,network:{...parsed.network,password:parsed.network.password===undefined?old.network.password:parsed.network.password}};
  this.store.save(e);this.profiles.delete(id);return this.view(e);
 }
 async profile(e:Environment,resolve=true){
  const cached=this.profiles.get(e.id);if(cached)return cached;
  const address=isIPv4(e.network.host)?e.network.host:resolve?(await lookup(e.network.host,{family:4})).address:'127.0.0.1';
  const c=windowsConfigSchema.parse({version:1,id:e.id,cpus:e.cpus,memoryGiB:e.memoryGiB,diskGiB:e.diskGiB,timezone:e.identity.timezone,
   image:this.options.base?.image??path.join(this.options.runtimeRoot,'unprepared.vhdx'),imageSha256:this.options.base?.imageSha256??'0'.repeat(64),
   proxy:{mode:e.network.mode,address,port:e.network.port,username:e.network.username,password:e.network.password??'',serverName:e.network.tls?.serverName},expectedIp:e.network.egressLock?.expectedIp,dns:e.network.dns});
  if(resolve)this.profiles.set(e.id,c);return c;
 }
 async recover(){
  const environments=this.store.list();
  // Different guests can be reconciled concurrently, but never expose the
  // workspace until every reconciliation in the current batch has settled.
  for(let offset=0;offset<environments.length;offset+=2){
   const results=await Promise.allSettled(environments.slice(offset,offset+2).map(async e=>{
   if(this.snapshotAdmission?.blocked(e.id)){
    try{const c=await this.profile(e,false);if((await this.runtime.state(c)).state!=='Off')await this.runtime.stop(c);this.store.state(e.id,'error','快照事务尚未恢复，环境保持停止；原磁盘和配置已保留');}
    catch{this.store.state(e.id,'error','快照事务尚未恢复且停机未确认；请先处理恢复问题');}
    return;
   }
   // A crash can leave a valid manifest and a stopped row before the backup
   // restore marker is removed. Do not turn that unfinished restore into a
   // normal stopped environment during startup reconciliation.
   let backupPending=false,backupInspectionFailed=false;
   try{await lstat(path.join(windowsPaths(this.options.runtimeRoot,e.id).directory,'backup-restore.json'));backupPending=true;}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')backupInspectionFailed=true;}
   if(backupPending||backupInspectionFailed){
    try{const c=await this.profile(e,false);if((await this.runtime.state(c)).state!=='Off')await this.runtime.stop(c);this.store.state(e.id,'error',backupPending?'备份恢复尚未完成，环境保持停止；请使用原备份继续恢复，现有文件已保留':'无法核验备份恢复状态，环境保持停止；请保留现有文件并检查管理目录');}
    catch{this.store.state(e.id,'error','备份恢复状态或环境停机未确认；请保留现有文件并检查后使用原备份继续');}
    return;
   }
   try{await access(windowsPaths(this.options.runtimeRoot,e.id).manifest);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){
    try{if(await this.runtime.recoverCreation?.(await this.profile(e,false))){this.store.state(e.id,'stopped');this.store.log(e.id,null,'已核验原虚拟机并恢复运行清单，原磁盘保留');}else if(e.state!=='not_created')this.store.state(e.id,'error','创建未完成；文件已保留，可重试启动或删除环境');}
    catch(recoveryError){this.store.state(e.id,'error','创建恢复失败，文件已保留：'+redact(errorMessage(recoveryError)));}return;
   }throw error;}
   const c=await this.profile(e,false);
   let compactPending=false,compactInspectionFailed=false;
   if(this.runtime.diskCompactionStatus&&(!(this.runtime instanceof HyperVRuntime)||this.runtime.broker)){
    try{compactPending=(await this.runtime.diskCompactionStatus(c)).pending;}catch{compactInspectionFailed=true;}
   }
   try{const state=await this.runtime.state(c);if(state.state!=='Off')await this.runtime.stop(c);this.protectionRecords.confirmRecoveredStop(e.id);
    if(compactPending)this.store.state(e.id,'error','磁盘维护尚未确认完成，环境保持停止；请保留磁盘并检查维护状态');
    else if(compactInspectionFailed)this.store.state(e.id,'error','磁盘维护状态无法确认，环境保持停止；请保留磁盘并检查维护状态');
    else this.store.state(e.id,'stopped');}
   catch(error){this.store.state(e.id,'error','恢复时无法确认环境停机：'+redact(errorMessage(error)));}
   }));
   const failure=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(failure)throw failure.reason;
  }
 }
 async snapshot():Promise<Snapshot>{
  const info=await this.runtime.info();
  return {environments:this.store.list().map(e=>this.view(e)),jobs:this.store.jobs(),system:{platform:'win32',arch:process.arch,hostname:hostname(),cpus:cpus().length,memoryGiB:Math.round(totalmem()/2**30),freeMemoryGiB:Math.round(freemem()/2**30),dataDir:this.store.dataDir,version:VERSION,
   runtime:{available:info.available&&!!this.options.base,path:info.available?'Hyper-V':null,version:'Windows Hyper-V',error:info.issues.join('；')||(!this.options.base?'请先准备空白受保护基盘':null)},browser:{available:this.browserAvailable,engine:this.browserAvailable?'Linux AMD64 Chrome':'Linux 客体浏览器（组件待准备）',native:false},hostNetwork:{state:this.hostIssue?'failed':'ready',issue:this.hostIssue},hostResourceIssue:this.resourceIssue,hostPowerIssue:this.powerIssue}};
 }
 async action(id:string,action:'start'|'stop'|'restart'){
  if(action!=='stop')await this.verifySnapshotWritable(id);
  if(action!=='stop')this.assertMaintenanceFree();
  if(this.closing)throw new AppError('应用正在退出',409,'CLOSING');if(action!=='stop'&&this.powerIssue)throw new AppError(this.powerIssue+'；请重新打开软件后再启动',409,'POWER_FENCED');if(action!=='stop'&&this.resourceIssue)throw new AppError(this.resourceIssue+'；请处理资源压力后重新打开软件',409,'RESOURCE_FENCED');if(action!=='stop'&&this.hostIssue)throw new AppError(this.hostIssue+'；请退出并重新打开 Windows 预览',409,'HOST_NETWORK_CHANGED');
  if(this.active.has(id)){const previous=this.active.get(id)!;if(action==='stop'&&(previous===this.liveSnapshotDeletions.get(id)||previous===this.snapshotExports.get(id)||previous===this.componentInstalls.get(id)))this.tasks.get(previous)?.controller.abort();else throw new AppError('环境正在执行其他操作',409,'ENVIRONMENT_BUSY');}
  const e=this.store.get(id);if(action==='start'&&(e.state==='running'||this.sessions.has(id)))throw new AppError('环境已在运行，请先停止后再启动',409,'ENVIRONMENT_BUSY');
  const job=this.store.newJob(id,action),controller=new AbortController();this.active.set(id,job.id);
  this.lifecycleIds.add(id);
  const promise=this.lifecycle(e,action,controller.signal).then(()=>{this.store.finishJob(job.id,'succeeded','操作完成');},error=>{
   this.store.state(id,'error',redact(errorMessage(error)));this.store.finishJob(job.id,controller.signal.aborted?'cancelled':'failed',errorMessage(error));
  }).finally(()=>{this.active.delete(id);this.lifecycleIds.delete(id);this.tasks.delete(job.id);});
  this.tasks.set(job.id,{controller,promise});return job;
 }
 async remove(id:string,confirmation:string){
  await this.verifySnapshotWritable(id);
  this.assertMaintenanceFree();
  if(this.closing)throw new AppError('应用正在退出',409,'CLOSING');
  const e=this.store.get(id);if(confirmation!==e.name)throw new AppError('请输入完整环境名称以确认删除',400,'DELETE_CONFIRMATION_REQUIRED');
  if(!this.runtime.deletionAvailable||!this.runtime.remove)throw new AppError('当前入口未启用环境删除，请使用普通用户权限代理入口',409,'FEATURE_UNAVAILABLE');
  if(this.active.has(id)||this.sessions.has(id)||['running','starting','creating'].includes(e.state))throw new AppError('请先停止环境并等待当前操作完成',409,'ENVIRONMENT_BUSY');
  const job=this.store.newJob(id,'delete'),controller=new AbortController();this.active.set(id,job.id);this.deletions.add(job.id);
  const promise=Promise.resolve().then(async()=>{
   this.onAccessRevoked?.(id);await this.runtime.remove!(await this.profile(e,false));this.store.remove(id);this.profiles.delete(id);this.store.finishJob(job.id,'succeeded','环境及专属虚拟磁盘已删除');
  }).catch(error=>{this.store.state(id,'error','删除未完成，保留环境记录：'+redact(errorMessage(error)));this.store.finishJob(job.id,'failed',errorMessage(error));}).finally(()=>{this.active.delete(id);this.deletions.delete(job.id);this.tasks.delete(job.id);});
  this.tasks.set(job.id,{controller,promise});return job;
 }
 async diskGrowthInfo(id:string,options:RunOptions={}){
  this.assertSnapshotWritable(id);
  this.assertMaintenanceFree();
  if(!this.runtime.diskGrowthAvailable||!this.runtime.diskGrowthInfo)throw new AppError('此入口不支持磁盘扩容，请使用 Windows 桌面权限代理',409,'FEATURE_UNAVAILABLE');
  const e=this.store.get(id);if(this.active.has(id)||this.sessions.has(id)||!['stopped','error'].includes(e.state))throw new AppError('请先停止环境并等待当前操作完成',409,'ENVIRONMENT_BUSY');
  return this.runtime.diskGrowthInfo(await this.profile(e,false),options);
 }
 async growDisk(id:string,targetGiB:number,confirmation:string){
  await this.verifySnapshotWritable(id);
  this.assertMaintenanceFree();
  await this.assertBackupRestoreFinished(id);this.assertMaintenanceFree();this.assertSnapshotWritable(id);
  windowsDiskSize.parse(targetGiB);const e=this.store.get(id);
  if(this.closing)throw new AppError('应用正在退出',409,'CLOSING');
  if(this.hostIssue||this.resourceIssue||this.powerIssue)throw new AppError('请处理宿主防护问题并重新打开软件后维护磁盘',409,'GUARD_FAILED');
  if(!this.runtime.diskGrowthAvailable||!this.runtime.growDisk)throw new AppError('此入口不支持磁盘扩容',409,'FEATURE_UNAVAILABLE');
  if(confirmation!==e.name)throw new AppError('请输入完整环境名称以确认磁盘扩容',400,'DISK_GROWTH_CONFIRMATION');
  if(e.kind!=='vm'||this.active.has(id)||this.sessions.has(id)||!['stopped','error'].includes(e.state))throw new AppError('请先停止环境并等待当前操作完成',409,'ENVIRONMENT_BUSY');
  if(targetGiB<e.diskGiB)throw new AppError('磁盘容量不能缩小',400,'DISK_GROWTH_SIZE');
  const job=this.store.newJob(id,'disk-grow'),controller=new AbortController();this.active.set(id,job.id);this.lifecycleIds.add(id);this.store.state(id,'starting');
  const promise=Promise.resolve().then(async()=>{
   this.onAccessRevoked?.(id);controller.signal.throwIfAborted();const result=await this.runtime.growDisk!(await this.profile(e,false),targetGiB,{signal:controller.signal});
   if(result.diskGiB!==targetGiB)throw Error('Disk growth result changed');controller.signal.throwIfAborted();
   this.store.save({...e,diskGiB:targetGiB,state:'stopped',lastError:null});this.profiles.delete(id);this.store.finishJob(job.id,'succeeded',result.reconciled?'已同步磁盘容量记录；环境保持停止':'磁盘与文件系统已扩容；环境保持停止');
  }).catch(error=>{this.profiles.delete(id);this.store.state(id,'error','磁盘扩容未完成，请保留现有磁盘并按维护提示继续：'+redact(errorMessage(error)));this.store.finishJob(job.id,controller.signal.aborted?'cancelled':'failed',errorMessage(error));})
   .finally(()=>{this.active.delete(id);this.lifecycleIds.delete(id);this.tasks.delete(job.id);});
  this.tasks.set(job.id,{controller,promise});return job;
 }
 // Product-task integration remains disabled by default until real Hyper-V
 // and interrupted-provider recovery have been validated.
 async diskCompactionStatus(id:string,options:RunOptions={}){
  if(!this.options.diskCompactionPreview||!this.runtime.diskCompactionStatus)throw new AppError('磁盘回收尚未开放',409,'FEATURE_UNAVAILABLE');
  return this.runtime.diskCompactionStatus(await this.profile(this.store.get(id),false),options);
 }
 async compactDisk(id:string,operation:'start'|'resume'|'cancel',confirmation:string){
  if(!['start','resume','cancel'].includes(operation))throw new AppError('无效的磁盘维护操作',400,'INVALID_OPERATION');
  await this.verifySnapshotWritable(id);this.assertMaintenanceFree();
  await this.assertBackupRestoreFinished(id);this.assertMaintenanceFree();this.assertSnapshotWritable(id);
  if(!this.options.diskCompactionPreview||!this.runtime.prepareDiskCompaction||!this.runtime.verifyDiskCompaction||!this.runtime.resumeDiskCompaction||!this.runtime.cancelDiskCompaction)throw new AppError('磁盘回收尚未开放',409,'FEATURE_UNAVAILABLE');
  if(this.closing)throw new AppError('应用正在退出',409,'CLOSING');
  if(this.hostIssue||this.resourceIssue||this.powerIssue)throw new AppError('请处理宿主防护问题后再维护磁盘',409,'GUARD_FAILED');
  const e=this.store.get(id);if(confirmation!==e.name)throw new AppError('请输入完整环境名称以确认磁盘维护',400,'DISK_COMPACTION_CONFIRMATION');
  if(e.kind!=='vm'||this.active.has(id)||this.sessions.has(id)||!['stopped','error'].includes(e.state))throw new AppError('请先停止环境并等待当前操作完成',409,'ENVIRONMENT_BUSY');
  if(this.tasks.size)throw new AppError('请等待其他操作完成后再回收磁盘',409,'DISK_COMPACTION_BUSY');
  const job=this.store.newJob(id,'disk-compaction'),controller=new AbortController();this.diskMaintenance=true;this.active.set(id,job.id);this.lifecycleIds.add(id);
  const promise=Promise.resolve().then(async()=>{
   controller.signal.throwIfAborted();this.onAccessRevoked?.(id);const config=await this.profile(e,false),options={signal:controller.signal};
   if(operation==='cancel'){
    await this.runtime.cancelDiskCompaction!(config,options);this.store.state(id,'stopped');this.store.finishJob(job.id,'succeeded','已取消尚未提交的磁盘维护；环境保持停止');return;
   }
   const result=operation==='start'?await this.runtime.verifyDiskCompaction!(config,await this.runtime.prepareDiskCompaction!(config,options),options):await this.runtime.resumeDiskCompaction!(config,options);
   this.store.state(id,'stopped');this.store.finishJob(job.id,'succeeded',`磁盘维护已完成；${windowsDiskAllocationSummary(result.beforeBytes,result.afterBytes)}；环境保持停止`);
  }).catch(error=>{
   this.store.state(id,'error','磁盘维护未确认完成；请保留磁盘并核对维护状态：'+redact(errorMessage(error)));
   // Aborting a client request does not prove the provider stopped; even a
   // cancelled request can have submitted a durable compaction operation.
   this.store.finishJob(job.id,'failed','磁盘维护未确认完成；请核对维护状态，不要重复压缩');
  }).finally(()=>{this.profiles.delete(id);this.active.delete(id);this.lifecycleIds.delete(id);this.tasks.delete(job.id);this.diskMaintenance=false;});
  this.tasks.set(job.id,{controller,promise,action:'disk-compaction'});return job;
 }
 runSnapshotOperation(id:string,action:'snapshot-create'|'snapshot-restore'|'snapshot-recover'|'snapshot-delete'|'snapshot-staging-review'|'snapshot-staging-cleanup',work:(signal:AbortSignal)=>Promise<void|string>){
  this.assertMaintenanceFree();
  if(action!=='snapshot-recover')this.assertSnapshotWritable(id);
  if(this.closing)throw new AppError('应用正在退出',409,'CLOSING');
  const spaceCleanup=['snapshot-delete','snapshot-staging-review','snapshot-staging-cleanup'].includes(action);
  if(action!=='snapshot-recover'&&!spaceCleanup&&(this.hostIssue||this.resourceIssue||this.powerIssue))throw new AppError('请先处理宿主防护问题再操作快照',409,'GUARD_FAILED');
  const environment=this.store.get(id);
  if(this.active.has(id)||this.sessions.has(id)||!['stopped',...(action==='snapshot-recover'||spaceCleanup?['error']:[])].includes(environment.state))throw new AppError('请先停止该环境并等待当前操作完成',409,'ENVIRONMENT_BUSY');
  const job=this.store.newJob(id,action),controller=new AbortController();this.active.set(id,job.id);this.lifecycleIds.add(id);
  const promise=Promise.resolve().then(async()=>{
   controller.signal.throwIfAborted();
   await this.assertBackupRestoreFinished(id);controller.signal.throwIfAborted();
   await this.assertDiskCompactionFinished(environment);controller.signal.throwIfAborted();
   if((await this.runtime.state(await this.profile(environment,false))).state!=='Off')throw new AppError('未确认虚拟机已停止，尚未开始快照操作',409,'STOP_UNCONFIRMED');
   await this.assertBackupRestoreFinished(id);
   await this.assertDiskCompactionFinished(environment);
   if(action!=='snapshot-recover')this.assertSnapshotWritable(id);
   controller.signal.throwIfAborted();this.onAccessRevoked?.(id);const result=await work(controller.signal);this.store.state(id,'stopped');
   this.store.finishJob(job.id,'succeeded',typeof result==='string'?result:'快照操作完成；环境保持停止');
  }).catch(async error=>{
   if(error instanceof AppError&&error.code==='DISK_COMPACTION_PENDING'){
    this.store.state(id,'error','磁盘维护状态尚未确认；请保留磁盘并检查维护状态');
    this.store.finishJob(job.id,'failed','磁盘维护尚未确认；快照操作未开始');
   }else if(error instanceof AppError&&error.code==='RESTORE_PENDING'){
    this.store.state(id,'error','备份恢复尚未完成；请保留现有文件并使用原备份继续恢复');
    this.store.finishJob(job.id,'failed','备份恢复尚未完成；快照操作未开始');
   }else if((action==='snapshot-create'||action==='snapshot-restore')&&error instanceof AppError&&error.code==='SNAPSHOT_STAGING_PENDING'){
    let off=false;try{off=(await this.runtime.state(await this.profile(this.store.get(id),false))).state==='Off';}catch{/* Keep an unknown VM state visible. */}
    this.store.state(id,off?'stopped':'error',off?null:'发现未发布快照副本，且虚拟机停止状态未确认；请核对环境状态');
    this.store.finishJob(job.id,controller.signal.aborted?'cancelled':'failed','发现未发布快照副本；新复制已暂停，请先核验归属和清理凭据');
   }else if(spaceCleanup){
    let off=false;try{off=(await this.runtime.state(await this.profile(this.store.get(id),false))).state==='Off';}catch{/* Unknown stop state stays an error. */}
    this.store.state(id,off?'stopped':'error',off?null:'快照维护未完成，虚拟机停止状态未确认；请查看操作记录');
    this.store.finishJob(job.id,controller.signal.aborted?'cancelled':'failed',action==='snapshot-staging-review'?'遗留副本核验未完成；可能缺少原始凭据或文件已变化，请保留文件并重新核对':action==='snapshot-staging-cleanup'?'遗留副本清理未确认完成；请重新核验剩余条目后继续':'快照删除未确认完成；请在快照页核对待清理记录');
   }else{
    this.store.state(id,'error','快照操作未完成；原磁盘和恢复记录已保留，请查看快照状态');
    this.store.finishJob(job.id,controller.signal.aborted?'cancelled':'failed','快照操作未完成；请核对恢复状态后再重试');
   }
  }).finally(()=>{this.profiles.delete(id);this.active.delete(id);this.lifecycleIds.delete(id);this.tasks.delete(job.id);});
  this.tasks.set(job.id,{controller,promise,action});return job;
 }
 runAgentInstall(id:string,work:(signal:AbortSignal)=>Promise<unknown>){
  return this.runComponentInstall(id,'install-agent','Claude Code 组件已核验；可由你打开专用终端',work);
 }
 runDesktopComponentInstall(id:string,work:(signal:AbortSignal)=>Promise<unknown>){
  return this.runComponentInstall(id,'install-desktop','桌面组件已核验；本次未打开客户端',work);
 }
 runDesktopClientOperation(id:string,action:'desktop-start'|'desktop-stop',work:(signal:AbortSignal)=>Promise<unknown>){
  if(!['desktop-start','desktop-stop'].includes(action))throw new AppError('客户端操作无效',400,'DESKTOP_CLIENT_ACTION');
  return this.runComponentInstall(id,action,action==='desktop-start'?'桌面客户端已打开并通过进程保护核验':'桌面客户端已确认关闭',work);
 }
 private runComponentInstall(id:string,action:'install-agent'|'install-desktop'|'desktop-start'|'desktop-stop',message:string,work:(signal:AbortSignal)=>Promise<unknown>){
  this.assertMaintenanceFree();this.assertSnapshotWritable(id);
  if(this.closing||this.hostIssue||this.resourceIssue||this.powerIssue)throw new AppError('请先处理宿主防护问题',409,'GUARD_FAILED');
  if(this.active.has(id)||this.store.get(id).state!=='running'||this.sessions.get(id)?.state!=='active')throw new AppError('请先启动环境并等待当前操作完成',409,'ENVIRONMENT_BUSY');
  const job=this.store.newJob(id,action),controller=new AbortController();this.active.set(id,job.id);this.componentInstalls.set(id,job.id);
  const promise=Promise.resolve().then(()=>{controller.signal.throwIfAborted();return work(controller.signal);}).then(()=>this.store.finishJob(job.id,controller.signal.aborted?'cancelled':'succeeded',controller.signal.aborted?'操作已取消':message),error=>{this.store.finishJob(job.id,controller.signal.aborted?'cancelled':'failed',redact(errorMessage(error)));}).finally(()=>{if(this.active.get(id)===job.id)this.active.delete(id);if(this.componentInstalls.get(id)===job.id)this.componentInstalls.delete(id);this.tasks.delete(job.id);});
  this.tasks.set(job.id,{controller,promise,action});return job;
 }
 runSnapshotExport(id:string,work:(signal:AbortSignal)=>Promise<void|string>){
  this.assertMaintenanceFree();this.assertSnapshotWritable(id);
  if(this.closing||this.hostIssue||this.resourceIssue||this.powerIssue)throw new AppError('请处理当前防护问题后再导出历史快照',409,'GUARD_FAILED');
  const environment=this.store.get(id);if(this.active.has(id)||!['running','stopped','error'].includes(environment.state)||environment.state==='running'&&this.sessions.get(id)?.state!=='active')throw new AppError('请等待当前环境操作完成',409,'ENVIRONMENT_BUSY');
  const job=this.store.newJob(id,'snapshot-export'),controller=new AbortController();this.active.set(id,job.id);this.snapshotExports.set(id,job.id);
  // Work always observes cancellation and settles the backup panel status.
  // It does not write environment state or join a concurrent explicit stop.
  const promise=Promise.resolve().then(()=>work(controller.signal)).then(message=>this.store.finishJob(job.id,'succeeded',typeof message==='string'?message:'历史快照加密备份已保存'),()=>this.store.finishJob(job.id,controller.signal.aborted?'cancelled':'failed','历史快照导出未完成；请查看备份面板并保留原快照')).finally(()=>{if(this.active.get(id)===job.id)this.active.delete(id);if(this.snapshotExports.get(id)===job.id)this.snapshotExports.delete(id);this.tasks.delete(job.id);});
  this.tasks.set(job.id,{controller,promise,action:'snapshot-export'});return job;
 }
 runLiveSnapshotDeletion(id:string,work:(signal:AbortSignal)=>Promise<void>){
  this.assertMaintenanceFree();this.assertSnapshotWritable(id);
  if(this.closing||this.hostIssue||this.resourceIssue||this.powerIssue)throw new AppError('请先处理宿主防护问题再删除快照',409,'GUARD_FAILED');
  const environment=this.store.get(id),session=this.sessions.get(id);
  if(this.active.has(id)||this.liveSnapshotDeletions.has(id)||environment.state!=='running'||session?.state!=='active')throw new AppError('环境当前状态不允许运行中删除快照',409,'ENVIRONMENT_BUSY');
  const job=this.store.newJob(id,'snapshot-delete-live'),controller=new AbortController();this.active.set(id,job.id);this.liveSnapshotDeletions.set(id,job.id);
  const current=()=>this.sessions.get(id)===session&&this.store.get(id).state==='running'&&!this.lifecycleIds.has(id);
  const promise=Promise.resolve().then(async()=>{
   controller.signal.throwIfAborted();await this.assertAccess(id,false,controller.signal);controller.signal.throwIfAborted();
   if(!current())throw new AppError('环境防护会话已变化，尚未开始快照删除',409,'GUARD_FAILED');
   await work(controller.signal);controller.signal.throwIfAborted();await this.assertAccess(id,false,controller.signal);controller.signal.throwIfAborted();
   this.store.finishJob(job.id,'succeeded','旧快照副本已删除；当前环境会话保持运行');
  }).catch(async()=>{
   // A deletion failure must never rewrite a concurrent stop/protection error
   // to stopped or running. Unknown restore state still closes guest access.
   if(current()&&this.snapshotAdmission?.blocked(id))await this.quarantine(id,'快照恢复状态无法核验，已关闭当前环境');
   this.store.finishJob(job.id,controller.signal.aborted?'cancelled':'failed','旧快照删除未确认完成；请在快照页核对待清理记录');
  }).finally(()=>{if(this.active.get(id)===job.id)this.active.delete(id);if(this.liveSnapshotDeletions.get(id)===job.id)this.liveSnapshotDeletions.delete(id);this.tasks.delete(job.id);});
  this.tasks.set(job.id,{controller,promise,action:'snapshot-delete-live',liveSnapshotDeletion:true});return job;
 }
 private async lifecycle(e:Environment,action:'start'|'stop'|'restart',signal:AbortSignal){
  const c=await this.profile(e,action!=='stop');
  if(action==='stop'||action==='restart'){
   try{this.onAccessRevoked?.(e.id);}catch{/* Viewer cleanup must not prevent stopping the VM. */}
   const existing=this.sessions.get(e.id);this.sessions.delete(e.id);
   const stopping=existing?{session:existing,interrupted:false}:undefined;if(stopping)this.stoppingSessions.set(e.id,stopping);
   try{
    if(existing&&this.runtime.prepareNormalStop)await existing.stopNormally(signal=>this.runtime.prepareNormalStop!(c,{signal}));
    else if(existing)await existing.fail();else await this.runtime.stop(c);
   }finally{if(this.stoppingSessions.get(e.id)===stopping)this.stoppingSessions.delete(e.id);}
   if(stopping?.interrupted)throw new AppError(this.store.get(e.id).lastError??'停止期间发生防护异常，环境保持关闭，请核对操作记录',409,'GUARD_FAILED');
   if(existing?.normalStopOutcome==='fallback')try{this.store.log(e.id,null,'浏览器正常退出未能确认，已独立核验环境关闭；下次打开浏览器可能出现恢复提示','error');}catch{/* A warning cannot invalidate a confirmed VM stop. */}
   this.store.state(e.id,'stopped');
  }
  if(action==='stop')return;
  let exists=true;try{await access(windowsPaths(this.options.runtimeRoot,e.id).manifest);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')exists=false;else throw error;}
  // A failed protection stop may leave the guest running. Never treat that
  // existing VM as a fresh closed boot until Hyper-V confirms it is off.
  if(action==='start'&&e.state==='error'&&exists&&(await this.runtime.state(c)).state!=='Off')throw new AppError('无法确认环境已停止，请先停止环境并检查停机结果',409,'STOP_UNCONFIRMED');
  // A restored standalone VM already owns its disk and management identity.
  // Only provisioning a new allocation needs the blank base catalogue.
  if(!exists&&!this.options.base)throw new AppError('创建新环境前请先准备空白受保护基盘',409,'BASE_MISSING');
  if(!(await this.runtime.info()).available)throw new AppError('Hyper-V 或管理员运行组件尚不可用',409,'RUNTIME_MISSING');
  const options:RunOptions={signal};
  try{
   this.store.state(e.id,exists?'starting':'creating');
   if(!exists)await this.runtime.create(c,options);signal.throwIfAborted();await this.runtime.start(c,options);signal.throwIfAborted();
   const session=await this.runtime.session(c,this.options.probe?.(c));this.sessions.set(e.id,session);this.sessionEnvironments.set(session,e);
   session.onFailure=error=>{if(this.sessions.get(e.id)===session)this.sessionFailureEvents.set(session,this.protectionRecords.record(e,error));};
   await this.runtime.connect(c);signal.throwIfAborted();await session.open(signal);signal.throwIfAborted();
   this.store.state(e.id,'running');this.store.log(e.id,null,'网络规则、出口和限时联网许可已通过核验');this.protectionRecords.resolve(e,session);
  }catch(error){
   const session=this.sessions.get(e.id);this.sessions.delete(e.id);try{this.onAccessRevoked?.(e.id);}catch{/* A viewer cleanup failure must not prevent closing egress. */}
   const stopping=session?session.fail():this.runtime.stop(c),event=session?this.sessionFailureEvents.get(session)??this.protectionRecords.record(e,error):undefined;
   try{await stopping;if(event)this.protectionRecords.stop(event,'confirmed');}catch(stopError){if(event)this.protectionRecords.stop(event,'failed',errorMessage(stopError));throw new AggregateError([error,stopError],'启动失败且停机未确认');}throw error;
  }
 }
 private async inspectAccess(id:string,allowBusy=false,signal?:AbortSignal){
  signal?.throwIfAborted();
  if(this.snapshotAdmission?.assertReadable)this.snapshotAdmission.assertReadable(id);else this.assertSnapshotWritable(id);
  const passive=this.active.has(id)&&!this.guestOperationBusy(id);
  const e=this.store.get(id),session=this.sessions.get(id);if(e.state!=='running'||this.lifecycleIds.has(id)||(!allowBusy&&!passive&&this.active.has(id))||session?.state!=='active')throw new AppError('环境防护尚未通过或已失效',409,'GUARD_FAILED');
  const current=()=>this.sessions.get(id)===session&&!this.lifecycleIds.has(id)&&this.store.get(id).state==='running';
  const evidence:GuardDiagnostics={operation:'access',stage:'access-inspection',reason:'inspection-failed',durations:{},verifiedReceiptCount:0},started=performance.now();
  try{
   const config=await this.profile(e);signal?.throwIfAborted();
   const guard=await this.runtime.inspectGuard(config,{signal});
   const changed=changedGuardComponents(session.guardComponents,guard.components);
   evidence.access={leaseActive:guard.leaseActive,remainingMs:guard.remainingMs,digestMatches:guard.digest===session.guardDigest,...(changed?{changedComponents:changed}:{})};
   if(!current()||session.state!=='active')evidence.reason='session-retired';
   else if(!/^[a-f0-9]{64}$/.test(guard.digest))evidence.reason='invalid-digest';
   else if(guard.digest!==session.guardDigest)evidence.reason='integrity-changed';
   else if(!guard.leaseActive)evidence.reason='lease-inactive';
   else if(guard.remainingMs<=0)evidence.reason='lease-range';
   if(!current()||session.state!=='active'||!guard.leaseActive||guard.remainingMs<=0||guard.digest!==session.guardDigest)throw Error('联网许可或防护完整性已失效');
   signal?.throwIfAborted();return{e,session,guard};
  }
  catch(error){
   // Cancelling this request denies only its caller. Independent monitoring
   // still owns the session; an actual bad guard or command error below must
   // never be hidden merely because the caller also cancelled.
   if(signal?.aborted&&(error===signal.reason||error instanceof AppError&&error.code==='CANCELLED'))throw new AppError('检查已取消，尚未授权本次操作',409,'CANCELLED');
   // Intentional shutdown retires the session before its in-flight SSH checks
   // finish. Deny those callers without stopping a later session or replacing
   // the confirmed shutdown result with a stale protection failure.
   evidence.durations.accessInspectMs=Math.min(86400000,Math.max(0,Math.round(performance.now()-started)));
   const code=guardFailureCode(error);if(code)evidence.failureCode=code;
   const source=guardFailureSource(error);if(source)evidence.failureSource=source;
   try{const transport=session.driver.transportDiagnostics?.();if(transport)evidence.transport=transport;}catch{/* Preserve the original failure and immediate stop if a diagnostic is unavailable. */}
   if(current())await this.quarantine(id,'联网许可或防护完整性无法确认',attachWindowsGuardDiagnostics(error,evidence));
   throw new AppError('联网许可或防护完整性无法确认',409,'GUARD_FAILED');
  }
 }
 async assertAccess(id:string,allowBusy=false,signal?:AbortSignal){return(await this.inspectAccess(id,allowBusy,signal)).e;}
 private assertProtectionReadable(id:string,session:WindowsNetworkSession){
  if(session.state==='active'&&!this.lifecycleIds.has(id)&&this.active.has(id)&&this.active.get(id)===this.browserViewJobs.get(id))throw new AppError('浏览器正在切换，防护状态将在操作完成后重新核验',409,'PROTECTION_BUSY');
 }
 private async inspectStatus(id:string,session:WindowsNetworkSession){
  const check=()=>{
   if(this.snapshotAdmission?.assertReadable)this.snapshotAdmission.assertReadable(id);else this.assertSnapshotWritable(id);
   this.assertProtectionReadable(id,session);
   const passive=this.active.has(id)&&!this.guestOperationBusy(id);
   if(this.sessions.get(id)!==session||session.state!=='active'||this.store.get(id).state!=='running'||this.lifecycleIds.has(id)||(!passive&&this.active.has(id)))throw new AppError('环境防护尚未通过或已失效',409,'GUARD_FAILED');
  };
  check();
  let entry=this.statusInspections.get(id);
  if(!entry||entry.session!==session){
   const promise=this.inspectAccess(id).finally(()=>{if(this.statusInspections.get(id)?.promise===promise)this.statusInspections.delete(id);});
   entry={session,promise};this.statusInspections.set(id,entry);
  }
  const result=await entry.promise;check();return result;
 }
 async egress(id:string):Promise<EgressStatus>{
  const environment=this.store.get(id),expectedIp=environment.network.egressLock?.expectedIp;
  if(!expectedIp)return {status:'disabled'};
  if(environment.state!=='running'||!this.sessions.has(id))return {status:'unverified',expectedIp};
  const {session}=await this.inspectStatus(id,this.sessions.get(id)!),checkedAt=session.verifiedAt;
  const receipts=session.verifiedReceipts.filter((row):row is EgressVerification['receipts'][number]=>['ipwho','ipify','icanhazip'].includes(row.receiver)&&row.ip===expectedIp&&typeof row.latencyMs==='number'&&Number.isFinite(row.latencyMs)&&row.latencyMs>=0);
  if(!checkedAt||Date.now()-Date.parse(checkedAt)>=45000||receipts.length<2||new Set(receipts.map(row=>row.receiver)).size<2)return {status:'unverified',expectedIp,checkedAt};
  return {status:'verified',expectedIp,actualIp:expectedIp,checkedAt,verification:{requiredReceivers:2,receipts,timedOutReceivers:[]}};
 }
 async protection(id:string):Promise<NetworkProtection>{
  const e=this.store.get(id),session=this.sessions.get(id);if(!session||e.state!=='running')return {prepared:false,bootArmed:false,active:false,policy:'transparent',firewallActive:false,transparentReady:false,transparentActive:false,proxyEndpoints:[],blockedPackets:0,checkedAt:new Date().toISOString(),integrity:'inactive'};
  const {guard}=await this.inspectStatus(id,session);return {prepared:true,bootArmed:true,active:true,policy:'transparent',firewallActive:true,transparentReady:true,transparentActive:true,proxyEndpoints:[`${e.network.host}:${e.network.port}`],blockedPackets:0,checkedAt:new Date().toISOString(),integrity:'verified',leasePrepared:true,leaseActive:guard.leaseActive,leaseRemainingMs:guard.remainingMs};
 }
 private async quarantine(id:string,issue:string,error?:unknown){
  const passive=this.liveSnapshotDeletions.get(id)??this.snapshotExports.get(id)??this.componentInstalls.get(id);if(passive)this.tasks.get(passive)?.controller.abort();
  const stoppingSession=this.stoppingSessions.get(id);if(stoppingSession)stoppingSession.interrupted=true;
  const session=this.sessions.get(id)??stoppingSession?.session,original=session?this.sessionEnvironments.get(session):undefined;this.sessions.delete(id);try{this.onAccessRevoked?.(id);}catch{/* Always attempt the independent stop. */}
  const stopping=session?session.fail():Promise.resolve().then(()=>this.profile(this.store.get(id),false)).then(c=>this.runtime.stop(c));let event:string|undefined;
  try{if(!(this.closing&&issue==='应用已退出'))event=(session?this.sessionFailureEvents.get(session):undefined)??this.protectionRecords.record(original??this.store.get(id),error??issue,issue);}catch{/* A diagnostic lookup cannot prevent awaiting the already initiated stop. */}
  let stopError:unknown;try{await stopping;}catch(error){stopError=error;}
  if(stopError){try{event??=this.protectionRecords.record(original??this.store.get(id),stopError,issue+'；停机未能确认');this.protectionRecords.stop(event,'failed',errorMessage(stopError));}catch{/* The stopping error remains authoritative even if the journal is unavailable. */}this.store.state(id,'error',issue+'；停机未确认：'+redact(errorMessage(stopError)));}
  else{if(event)this.protectionRecords.stop(event,'confirmed');this.store.state(id,'error',issue+'；环境已确认关闭');}
 }
 monitor(){
  if(this.monitorTask)return this.monitorTask;if(this.closing)return Promise.resolve();
  return this.monitorTask=(async()=>{
   try{const status=await this.runtime.power?.();if(status?.fenced||status&&!status.monitoring){await this.powerUnavailable(powerIssue(status.issue));return;}}
   catch{await this.powerUnavailable('电源防护状态无法确认');return;}
   try{const status=await this.runtime.resources?.();if(status?.fenced){await this.resourcesUnavailable(resourceIssue(status.issue));return;}}
   catch{await this.resourcesUnavailable('宿主资源状态无法确认');return;}
   await Promise.all([...this.sessions].map(async([id,session])=>{
    if(this.lifecycleIds.has(id))return;
    try{
     // A transport can independently retire the session before this tick.
     // Keep the immediate teardown, then reconcile its actual stop result;
     // tick() deliberately does no work for an already failed session.
     if(session.state==='failed'){
      const evidence:GuardDiagnostics={operation:'monitor',stage:'session-state',reason:'session-retired',durations:{},verifiedReceiptCount:0};
      try{const transport=session.driver.transportDiagnostics?.();if(transport)evidence.transport=transport;}catch{/* Stop reconciliation does not depend on diagnostic availability. */}
      throw attachWindowsGuardDiagnostics(new AppError('防护会话已失效，须确认环境停止',409,'GUARD_FAILED'),evidence);
     }
     await session.tick();if(this.sessions.get(id)===session&&session.state==='active')await this.inspectAdditionalProtection?.(id);
    }catch(error){if(this.sessions.get(id)===session)await this.quarantine(id,redact(errorMessage(error)),error);}
   }));
  })().finally(()=>{this.monitorTask=undefined;});
 }
 async submit(id:string,action:string,work:(options:RunOptions)=>Promise<unknown>){
  this.assertSnapshotWritable(id);
  if(this.closing||this.active.has(id))throw new AppError('环境正在执行其他操作',409,'ENVIRONMENT_BUSY');
  await this.assertAccess(id);if(this.active.has(id))throw new AppError('环境正在执行其他操作',409,'ENVIRONMENT_BUSY');
  const job=this.store.newJob(id,action),controller=new AbortController();this.active.set(id,job.id);if(action==='open-browser'||action==='close-browser')this.browserViewJobs.set(id,job.id);
  const promise=Promise.resolve().then(()=>{controller.signal.throwIfAborted();return work({signal:controller.signal});}).then(()=>this.store.finishJob(job.id,'succeeded','操作完成'),error=>{this.store.finishJob(job.id,controller.signal.aborted?'cancelled':'failed',errorMessage(error));this.store.log(id,job.id,errorMessage(error),'error');}).finally(()=>{if(this.active.get(id)===job.id)this.active.delete(id);if(this.browserViewJobs.get(id)===job.id)this.browserViewJobs.delete(id);this.tasks.delete(job.id);});
  this.tasks.set(job.id,{controller,promise});return job;
 }
 async hostUnavailable(reason:string){this.hostIssue=reason;for(const task of this.tasks.values())if(!task.localBackupCleanup)task.controller.abort();await Promise.all(this.store.list().filter(e=>['running','starting','creating'].includes(e.state)).map(e=>this.quarantine(e.id,reason)));}
 async resourcesUnavailable(reason:string){
  this.resourceIssue=reason;
  // Stopped-copy cleanup can reclaim the space that caused this fence. It has
  // its own stop/ownership checks. Sealed backup staging uses no VM or guest
  // session; explicit cancellation and shutdown still cancel local cleanup.
  for(const task of this.tasks.values())if((!['snapshot-delete','snapshot-staging-review','snapshot-staging-cleanup'].includes(task.action??'')||task.liveSnapshotDeletion)&&!task.localBackupCleanup)task.controller.abort();
  await Promise.all(this.store.list().filter(e=>['running','starting','creating'].includes(e.state)||this.sessions.has(e.id)).map(e=>this.quarantine(e.id,reason)));
 }
 async powerUnavailable(reason:string){this.powerIssue=reason;for(const task of this.tasks.values())if(!task.localBackupCleanup)task.controller.abort();await Promise.all(this.store.list().filter(e=>['running','starting','creating'].includes(e.state)||this.sessions.has(e.id)).map(e=>this.quarantine(e.id,reason)));}
 failProtection(id:string,reason:string){return this.quarantine(id,reason);}
 cancel(jobId:string){if(this.deletions.has(jobId))throw new AppError('删除已开始，请等待清理结果',409,'DELETE_IN_PROGRESS');this.tasks.get(jobId)?.controller.abort();}
 async wait(jobId:string){await this.tasks.get(jobId)?.promise;}
 close(){return this.closeTask??=(async()=>{this.closing=true;clearInterval(this.timer);for(const task of this.tasks.values())task.controller.abort();await Promise.allSettled([...this.tasks.values()].map(t=>t.promise));await this.hostUnavailable('应用已退出');await this.monitorTask;this.store.close();this.store.key.fill(0);})();}
}
