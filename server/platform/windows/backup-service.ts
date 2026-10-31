import {open,lstat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {AppError} from '../../errors.ts';
import {run} from '../../process.ts';
import {powershellArgs,powershellPath} from './runtime.ts';
import {cleanWindowsEnvironment,type HyperVBrokerClient} from './broker.ts';
import {WindowsManager} from './manager.ts';
import {exportWindowsBackup,restoreWindowsBackup,windowsBackupResumeName,WindowsBackupCleanupError,WindowsBackupExportCleanupError} from './backup-bundle.ts';
import {readWindowsBackupArchive,restorableWindowsBackupManifest} from './backup-archive.ts';
import {WindowsBackupCleanupRegistry} from './backup-cleanup.ts';
import {WindowsBackupOutputRegistry,type OwnedBackupOutput} from './backup-output.ts';
import {exportWindowsSnapshotBackup} from './snapshot-backup.ts';
import type {WindowsSnapshotBackupSelection} from '../../../shared/windows-backup.ts';
import type {WindowsBackupReleaseIssue} from './backup-reader.ts';
import type {WindowsBackupStatus,WindowsBackupReview,WindowsBackupCleanupIssue,WindowsBackupReleaseWarning} from '../../../shared/windows-backup.ts';
import {environmentSchema} from '../../validation.ts';

export const backupPassword=z.string().min(12).max(256);
export const backupFilePath=z.string().min(12).max(1024).refine(value=>/^[a-z]:[\\/]/i.test(value)&&!/[\x00-\x1f<>"|?*]/.test(value)&&!value.slice(2).includes(':')&&value.toLowerCase().endsWith('.mucwin'),'请选择本地磁盘上的 .mucwin 文件');
const savedBackupRecord=z.object({path:backupFilePath,savedAt:z.string().datetime({offset:true})}).strict();
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fileBinding=(value:import('node:fs').Stats)=>digest([value.dev,value.ino,value.size,value.mtimeMs,value.birthtimeMs]);
const expiredReviewMessage='审阅已过期，请重新核验备份。';
async function localPath(value:string){
 const file=path.resolve(backupFilePath.parse(value));
 await run(powershellPath(),powershellArgs("$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd();$drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($p));if($drive.DriveType -eq 'Network'){throw 'Local backup file required'};while($p){if([IO.File]::Exists($p) -or [IO.Directory]::Exists($p)){if([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint){throw 'Backup reparse path rejected'}};$p=[IO.Path]::GetDirectoryName($p)}"),{input:file,env:cleanWindowsEnvironment(),timeoutMs:10000});
 return file;
}
async function source(file:string){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>260*2**30)throw new AppError('备份文件类型或大小异常',400,'BACKUP_PATH');const handle=await open(file,'r');return validateBackupSourceHandle(handle,info);}

export async function validateBackupSourceHandle<T extends {stat:()=>Promise<import('node:fs').Stats>;close:()=>Promise<void>}>(handle:T,info:import('node:fs').Stats):Promise<T>{
 try{
  const actual=await handle.stat();
  if(!actual.isFile()||actual.nlink!==1||actual.ino!==info.ino||actual.dev!==info.dev||actual.size!==info.size)throw new AppError('文件已变化，请重新选择',409,'BACKUP_REVIEW_CHANGED');
  return handle;
 }catch(error){try{await handle.close();}catch{/* A close error cannot replace the identity or stat failure. */}throw error;}
}

// Closing the input cannot erase an earlier integrity/restore error. After a
// committed restore, a close error is a warning rather than an invitation to
// repeat a completed import; a review still requires a successful close.
export async function withBackupSource<T>(handle:{close:()=>Promise<void>},work:()=>Promise<T>,committedOnSuccess:boolean,onCloseFailure:()=>void):Promise<T>{
 let failed=false;
 try{return await work();}catch(error){failed=true;throw error;}finally{
  try{await handle.close();}catch(error){if(failed||committedOnSuccess){try{onCloseFailure();}catch{/* Preserve the operation result. */}}else throw error;}
 }
}

export class WindowsBackupService {
 private status:WindowsBackupStatus={phase:'idle',bytes:0,total:0,message:''};
 private pending?:{review:WindowsBackupReview;file:string;password:string;binding:string;manifestDigest:string};
 private timer:ReturnType<typeof setTimeout>|undefined;
 private readonly cleanupIssues=new Map<string,WindowsBackupCleanupIssue>();
 private readonly cleanupRegistry:WindowsBackupCleanupRegistry;
 private readonly outputRegistry:WindowsBackupOutputRegistry;
 private readonly releaseIssues=new Map<string,WindowsBackupReleaseWarning>();
 private lastSavedWriteFailed=false;
 private manager:WindowsManager;private broker:HyperVBrokerClient;private available:()=>boolean;
 private options:{snapshotExportEnabled?:boolean};
 constructor(manager:WindowsManager,broker:HyperVBrokerClient,available:()=>boolean=()=>true,options:{snapshotExportEnabled?:boolean}={}){this.manager=manager;this.broker=broker;this.available=available;this.options=options;this.cleanupRegistry=new WindowsBackupCleanupRegistry(manager.store,manager.options.runtimeRoot);this.outputRegistry=new WindowsBackupOutputRegistry(manager.store);}
 private savedRecord(){
  try{
   if(this.lastSavedWriteFailed)throw Error('Backup location record was not saved');
   this.manager.store.db.exec('CREATE TABLE IF NOT EXISTS windows_backup_last_saved (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)');
   const row=this.manager.store.db.prepare('SELECT payload FROM windows_backup_last_saved WHERE id=1').get() as {payload:string}|undefined;
   return row?{lastSaved:savedBackupRecord.parse(JSON.parse(this.manager.store.decrypt(row.payload)))}:{};
  }catch{return {lastSavedIssue:'备份位置记录无法读取或保存；请自行保管备份文件路径。'};}
 }
 snapshot(){this.expireReviewIfDue();const issues=new Map(this.cleanupIssues);for(const issue of this.cleanupRegistry.issues())issues.set(issue.directory,issue);const outputIssues=this.outputRegistry.issues();return {...this.status,...this.savedRecord(),review:this.pending?.review,...(issues.size?{cleanupIssues:[...issues.values()].map(issue=>({...issue}))}:{}),...(this.cleanupRegistry.issue?{cleanupIndexIssue:this.cleanupRegistry.issue}:{}),...(outputIssues.length?{outputIssues}:{}),...(this.outputRegistry.issue?{outputIndexIssue:this.outputRegistry.issue}:{}),...(this.releaseIssues.size?{releaseIssues:[...this.releaseIssues.values()].map(issue=>({...issue}))}:{})};}
 private log(message:string,level:'info'|'error'='error'){try{this.manager.store.log(null,null,message,level);}catch{/* A diagnostic cannot replace the operation result. */}}
 private releaseIssue=(issue:WindowsBackupReleaseIssue)=>{const prior=this.releaseIssues.has(issue.environmentId);if(issue.pending)this.releaseIssues.set(issue.environmentId,{environmentId:issue.environmentId,message:issue.message});else this.releaseIssues.delete(issue.environmentId);if(issue.pending&&!prior||!issue.pending&&prior)this.log(issue.message,issue.pending?'error':'info');};
 private cleanupIssue=(issue:WindowsBackupCleanupIssue)=>{if(!issue.id)this.cleanupIssues.set(issue.directory,issue);this.log(`${issue.message} 目录：${issue.directory}`);};
 private clear(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.pending=undefined;}
 private expireReview(token:string){
  if(this.pending?.review.token!==token)return;
  this.clear();
  if(this.status.phase!=='running')this.status={phase:'idle',bytes:0,total:0,message:expiredReviewMessage};
 }
 private expireReviewIfDue(){const review=this.pending?.review;if(review&&Date.parse(review.expiresAt)<=Date.now())this.expireReview(review.token);}
 private start(operation:'export'|'review'|'restore'|'cleanup',work:(signal:AbortSignal)=>Promise<void|string>,history?:WindowsSnapshotBackupSelection){
  if(this.status.phase==='running')throw new AppError('已有备份任务正在进行，请等待或取消',409,'BACKUP_BUSY');
  if(operation!=='cleanup'&&!this.available())throw new AppError('请先完成系统组件准备并等待当前准备任务结束',409,'HOST_REQUIREMENTS');
  const execute=async(signal:AbortSignal)=>{
   try{signal.throwIfAborted();if(history&&this.manager.store.get(history.environmentId).state==='running')await this.manager.assertAccess(history.environmentId);signal.throwIfAborted();const message=await work(signal);this.status=operation==='review'&&!this.pending?{phase:'idle',bytes:0,total:0,message:expiredReviewMessage}:{...this.status,phase:'succeeded',message:typeof message==='string'?message:operation==='review'?'核验完成，请审阅后确认恢复':operation==='export'?'加密备份已保存':operation==='cleanup'?'该临时目录已核验并清理':'恢复完成，环境保持停止'};this.expireReviewIfDue();if(operation==='cleanup'||operation==='export')return this.status.message;}
   catch(error){
    this.clear();
    if(operation==='restore'&&error instanceof WindowsBackupCleanupError&&error.restoreCommitted){
     if(!error.cleanupIssue.id)this.cleanupIssues.set(error.cleanupIssue.directory,error.cleanupIssue);this.manager.profiles.delete(error.environmentId);
     this.status={...this.status,phase:'succeeded',message:'恢复已完成，环境保持停止；临时资料尚未确认清理，请勿重复恢复'};
     return this.status.message;
    }
    if(operation==='cleanup'){this.status={...this.status,phase:signal.aborted?'cancelled':'failed',message:signal.aborted?'临时清理已取消；剩余资料与原记录已保留，可稍后重试':'临时清理未完成；原归属凭据无法核验、文件仍被占用或目录内容已变化，请保留记录并核对。'};throw error;}
    const code=error&&typeof error==='object'&&'code' in error?String(error.code):'',messages:Record<string,string>={WINDOWS_BACKUP_INTEGRITY:'密码错误、备份损坏或格式不受支持，请重新选择并核验。',BACKUP_REVIEW_CHANGED:'备份文件已变化，请重新核验并审阅。',BACKUP_IDENTITY_CHANGED:'备份来源或所选版本已变化，请重新选择并核验。',SNAPSHOT_OWNER:'历史配置或连接身份无法核验，未生成备份。',RESTORE_CONFLICT:'已有环境或文件与备份冲突，已保留，不能覆盖。',BACKUP_EXISTS:'目标文件已存在，请选择新的保存文件名。',RESOURCE_DISK:'磁盘空间不足，请释放空间后使用原备份重试。',ENOSPC:'磁盘空间不足，请释放空间后重试。',BACKUP_IDENTITY:'备份中的管理身份不一致，未完成操作。',BACKUP_CLEANUP_PENDING:'身份校验临时资料清理未确认，请核对清理告警和文件占用后重试。',BACKUP_OUTPUT_PENDING:'加密输出尚未确认完成，请核对保存位置、文件占用及清理告警。'};this.status={...this.status,phase:signal.aborted?'cancelled':'failed',message:signal.aborted?(history?'历史快照导出已取消；原快照与当前环境数据保留。':'任务已取消；未完成的恢复请使用原备份继续'):messages[code]??'备份操作失败，原文件已保留。请检查文件权限、磁盘空间及目标冲突后重试。'};throw error;
   }
  };
  const job=history?this.manager.runSnapshotExport(history.environmentId,execute):operation==='cleanup'?this.manager.runBackupCleanupMaintenance(execute):this.manager.runMaintenance('backup-'+operation,execute);
  this.status={jobId:job.id,operation,phase:'running',bytes:0,total:0,message:operation==='export'?(history?'正在核验所选历史快照并加密':'正在核验原盘并加密'):operation==='review'?'正在核验完整备份':operation==='cleanup'?'正在核验原归属凭据并清理临时资料':'正在解密并恢复；完成前请勿退出',...(history?{source:history}:{})};return job;
 }
 export(id:string,file:string,password:string,confirmation:string){
  return this.exportSelected(id,file,password,confirmation);
 }
 exportSnapshot(id:string,snapshotId:string,name:string,createdAt:string,file:string,password:string,confirmation:string){
  if(!this.options.snapshotExportEnabled)throw new AppError('历史快照导出尚未开放',409,'FEATURE_UNAVAILABLE');
  const history=z.object({environmentId:z.uuid(),snapshotId:z.uuid(),name:z.string().min(1).max(60).refine(v=>v===v.trim()&&!/[\x00-\x1f\x7f]/.test(v)),createdAt:z.string().datetime({offset:true})}).strict().parse({environmentId:id,snapshotId,name,createdAt});
  return this.exportSelected(id,file,password,confirmation,history);
 }
 private exportSelected(id:string,file:string,password:string,confirmation:string,history?:WindowsSnapshotBackupSelection){
  backupFilePath.parse(file);backupPassword.parse(password);const environment=this.manager.store.get(z.uuid().parse(id));
  if(confirmation!==environment.name)throw new AppError('请输入完整环境名称确认备份',400,'BACKUP_CONFIRMATION');
  if(!history&&environment.state!=='stopped')throw new AppError('请先停止环境',409,'ENVIRONMENT_BUSY');
  const job=this.start('export',async signal=>{
   const target=await localPath(file);let output:OwnedBackupOutput|undefined,failed=false,published=false,sensitivePending=false,outputPending=false;
   try{
    try{await lstat(target);throw new AppError('目标文件已存在，请选择新文件名',409,'BACKUP_EXISTS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    output=await this.outputRegistry.begin(target);
    const sink={write:async(bytes:Uint8Array)=>{signal.throwIfAborted();await output!.write(bytes);this.status.bytes+=bytes.length;}},options={signal,cleanupRegistry:this.cleanupRegistry,onCleanupIssue:this.cleanupIssue,onReleaseIssue:this.releaseIssue};
    try{if(history)await exportWindowsSnapshotBackup(this.broker,this.manager.store,this.manager.options.runtimeRoot,id,history.snapshotId,sink,password,{...options,expectedName:history.name,expectedCreatedAt:history.createdAt});else await exportWindowsBackup(this.broker,this.manager.options.runtimeRoot,this.manager.store.get(id),sink,password,options);}
    catch(error){if(!(error instanceof WindowsBackupExportCleanupError&&error.archiveComplete))throw error;sensitivePending=true;}
    await output.sync();await output.close();await output.publish(signal);published=true;
   }catch(error){failed=true;throw error;}
   finally{
    let cleanupFailure:unknown;
    try{await output?.close();}catch(error){cleanupFailure=error;}
    // Finalize only the existing owned output with a separate bounded budget.
    // The original cancellation still determines the export result.
    try{await output?.cleanup(AbortSignal.timeout(10_000));}catch(error){cleanupFailure??=error;}
    if(cleanupFailure){outputPending=true;if(output)this.log(`加密输出临时文件尚未确认清理，已保留原记录；不得删除目标备份。临时文件：${output.temporary}`);if(!failed&&!published)throw cleanupFailure;}
   }
   if(!published)throw new AppError('加密备份尚未确认保存，原文件与记录已保留',409,'BACKUP_OUTPUT_PENDING');
   // Only expose a target after the owned encrypted output was published.
   // Status is in-memory and is reset when a new task starts.
   this.status.savedPath=target;
   try{const payload=this.manager.store.encrypt(JSON.stringify({path:target,savedAt:new Date().toISOString()}));this.manager.store.db.exec('CREATE TABLE IF NOT EXISTS windows_backup_last_saved (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)');this.manager.store.db.prepare('INSERT INTO windows_backup_last_saved(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(payload);this.lastSavedWriteFailed=false;}catch{this.lastSavedWriteFailed=true;}
   if(sensitivePending||outputPending||this.outputRegistry.issues().length||this.outputRegistry.issue)return '加密备份已保存；部分临时资料或记录尚未确认清理，请保留告警记录';
  },history);this.clear();return job;
 }
 review(file:string,password:string){
  backupFilePath.parse(file);backupPassword.parse(password);
  const job=this.start('review',async signal=>{
   const selected=await localPath(file),handle=await source(selected);
   await withBackupSource(handle,async()=>{
    const before=await handle.stat();this.status.total=before.size;
    const stream=handle.createReadStream({autoClose:false,start:0});stream.on('data',bytes=>{this.status.bytes+=(bytes as Buffer).length;});
    const manifest=restorableWindowsBackupManifest.parse(await readWindowsBackupArchive(stream,{write:async()=>{}},password,signal));
    const after=await handle.stat();if(fileBinding(before)!==fileBinding(after))throw new AppError('文件已变化，请重新审阅',409,'BACKUP_REVIEW_CHANGED');signal.throwIfAborted();
    let resumeName:string|null=null;try{resumeName=await windowsBackupResumeName(this.manager.options.runtimeRoot,manifest);}catch(error){if(!(error instanceof AppError&&error.code==='RESTORE_CONFLICT'))throw error;}signal.throwIfAborted();
    const review={token:randomUUID(),name:manifest.config.name,id:manifest.identity.id,diskGiB:manifest.config.diskGiB,diskBytes:manifest.disk.bytes,cpus:manifest.config.cpus,memoryGiB:manifest.config.memoryGiB,proxy:manifest.config.network.mode.toUpperCase()+' · '+manifest.config.network.host+':'+manifest.config.network.port,expectedIp:manifest.config.network.egressLock!.expectedIp,timezone:manifest.config.identity.timezone,expiresAt:new Date(Date.now()+300000).toISOString(),...(resumeName!==null?{resumeName}:{})};
    this.pending={review,file:selected,password,binding:fileBinding(after),manifestDigest:digest(manifest)};
    // Retire this exact approval after the fixed elapsed interval even when
    // the wall clock moved backwards. A stale callback cannot erase a new one.
    this.timer=setTimeout(()=>this.expireReview(review.token),300000);this.timer.unref();
   },false,()=>this.log('备份读取句柄关闭未确认；原核验错误已保留。'));
  });this.clear();return job;
 }
 restore(token:string,confirmation:string,requestedName?:string){
  this.expireReviewIfDue();
  const pending=this.pending;if(!pending||pending.review.token!==token||Date.parse(pending.review.expiresAt)<=Date.now())throw new AppError('审阅已过期，请重新核验备份',409,'BACKUP_REVIEW_EXPIRED');
  if(confirmation!==pending.review.name)throw new AppError('请输入备份中的完整环境名称',400,'BACKUP_CONFIRMATION');
  const restoreName=environmentSchema.shape.name.parse(requestedName??pending.review.resumeName??pending.review.name);
  const job=this.start('restore',async signal=>{
   const selected=await localPath(pending.file),handle=await source(selected);
   let closeWarning=false;
   await withBackupSource(handle,async()=>{if(fileBinding(await handle.stat())!==pending.binding)throw new AppError('备份文件已变化，请重新审阅',409,'BACKUP_REVIEW_CHANGED');
    this.status.total=pending.review.diskBytes;
    await restoreWindowsBackup(this.broker,this.manager.options.runtimeRoot,this.manager.store,handle.createReadStream({autoClose:false,start:0}),pending.password,{signal,restoreName,cleanupRegistry:this.cleanupRegistry,expectedManifestDigest:pending.manifestDigest,onProgress:(bytes,total)=>{this.status.bytes=bytes;this.status.total=total;},onCleanupIssue:issue=>{if(!issue.id)this.cleanupIssues.set(issue.directory,issue);},onReleaseIssue:this.releaseIssue});
    this.manager.profiles.delete(pending.review.id);
   },true,()=>{closeWarning=true;this.log('备份读取句柄关闭未确认；请保留原备份并核对操作记录。');});
   if(closeWarning)return '恢复已完成，环境保持停止；备份读取句柄关闭未确认，请勿重复恢复';
  });this.clear();return job;
 }
 cleanup(id:string){
  z.uuid().parse(id);
  const issue=this.cleanupRegistry.issues().find(value=>value.id===id);
  if(!issue||!issue.retryable)throw new AppError('此临时目录没有可核验的清理凭据，请保留记录并核对',409,'BACKUP_CLEANUP_UNVERIFIED');
  const job=this.start('cleanup',async signal=>{await this.cleanupRegistry.retry(id,signal);this.cleanupIssues.delete(issue.directory);});this.clear();return job;
 }
 cleanupOutput(id:string){
  z.uuid().parse(id);const issue=this.outputRegistry.issues().find(value=>value.id===id);
  if(!issue?.retryable)throw new AppError('此加密临时文件没有可核验的清理凭据，请保留记录并核对',409,'BACKUP_OUTPUT_PENDING');
  const job=this.start('cleanup',async signal=>{await this.outputRegistry.retry(id,signal);return '该加密临时文件已核验并清理';});this.clear();return job;
 }
 discard(){if(this.status.phase==='running')throw new AppError('请先取消正在进行的任务',409,'BACKUP_BUSY');this.clear();if(this.status.phase==='idle'||this.status.operation==='review'&&this.status.phase==='succeeded')this.status={phase:'idle',bytes:0,total:0,message:''};return {ok:true};}
 close(){this.clear();}
}
