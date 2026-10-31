import {mkdir,rmdir,lstat,writeFile,statfs,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import type {Environment} from '../../../shared/types.ts';
import type {Store} from '../../store.ts';
import {environmentSchema} from '../../validation.ts';
import {AppError} from '../../errors.ts';
import {run,type RunOptions} from '../../process.ts';
import type {HyperVBrokerClient} from './broker.ts';
import {cleanWindowsEnvironment} from './broker.ts';
import {secureWindowsDirectory} from './credentials.ts';
import {windowsPaths,vmIdentity} from './config.ts';
import {readOriginal} from './recovery-candidates.ts';
import {openProtectedBackupRead,type WindowsBackupReadOptions} from './backup-reader.ts';
import {writeWindowsBackupArchive,readWindowsBackupArchive,restorableWindowsBackupManifest,windowsBackupIdentity,type BackupSink,type RestorableWindowsBackupManifest} from './backup-archive.ts';
import {powershellArgs,powershellPath} from './runtime.ts';
import type {WindowsBackupCleanupIssue} from '../../../shared/windows-backup.ts';
import {WindowsBackupCleanupRegistry,type OwnedBackupWriter} from './backup-cleanup.ts';

export class WindowsBackupCleanupError extends AppError {
 readonly restoreCommitted=true;
 readonly environmentId:string;
 readonly cleanupIssue:WindowsBackupCleanupIssue;
 constructor(environmentId:string,cleanupIssue:WindowsBackupCleanupIssue,cause:unknown){
  super('恢复已完成，环境保持停止；临时资料尚未确认清理，请勿重复恢复',409,'BACKUP_CLEANUP_PENDING');
  this.environmentId=environmentId;this.cleanupIssue=cleanupIssue;this.cause=cause;
 }
}
export interface ExportedWindowsBackup {id:string;bytes:number;sha256:string}
export class WindowsBackupExportCleanupError extends AppError {
 readonly archiveComplete=true;
 readonly backup:ExportedWindowsBackup;
 readonly cleanupIssue:WindowsBackupCleanupIssue;
 constructor(backup:ExportedWindowsBackup,cleanupIssue:WindowsBackupCleanupIssue,cause:unknown){
  super('加密档案已完整生成；校验临时资料尚未确认清理',409,'BACKUP_EXPORT_CLEANUP_PENDING');this.backup=backup;this.cleanupIssue=cleanupIssue;this.cause=cause;
 }
}
type Input=AsyncIterable<Uint8Array>;
const metadataManifest=z.object({version:z.literal(1),id:z.uuid(),platformId:z.uuid(),imageSha256:z.string().regex(/^[a-f0-9]{64}$/),purpose:z.literal('environment')});
const failure=(code:string,message:string)=>new AppError(message,409,code);
function configOf(environment:Environment){return environmentSchema.parse(Object.fromEntries(Object.keys(environmentSchema.shape).map(key=>[key,environment[key as keyof Environment]])));}
async function privateWork(root:string){
 const parent=path.resolve(root);if(!/^[A-Za-z]:\\/.test(parent))throw failure('BACKUP_PATH','备份临时目录需要本地磁盘路径');
 await run(powershellPath(),powershellArgs("$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd();$drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($p));if($drive.DriveType -eq 'Network'){throw 'Local private staging required'};while($p){if([IO.Directory]::Exists($p) -or [IO.File]::Exists($p)){if([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint){throw 'Private staging ancestor reparse point rejected'}};$p=[IO.Path]::GetDirectoryName($p)}"),{input:parent,env:cleanWindowsEnvironment(),timeoutMs:10000});
 await secureWindowsDirectory(parent);if((await lstat(parent)).isSymbolicLink())throw failure('BACKUP_PATH','备份工作目录异常');
 const directory=path.join(parent,'backup-work-'+randomUUID());await mkdir(directory);await secureWindowsDirectory(directory);
 return {directory,close:async()=>{const target=path.resolve(directory);if(path.dirname(target)!==parent||!/^backup-work-[a-f0-9-]{36}$/.test(path.basename(target))||(await lstat(target)).isSymbolicLink())throw failure('BACKUP_PATH','备份临时目录身份变化，文件已保留');await rmdir(target);}};
}
function keyPublic(value:string){const fields=value.trim().split(/\s+/);if(fields.length<2||fields[0]!=='ssh-ed25519'||!/^[A-Za-z0-9+/]+={0,2}$/.test(fields[1]))throw failure('BACKUP_IDENTITY','原管理身份格式不受支持');return fields.slice(0,2).join(' ');}
export async function validateBackupIdentity(identity:RestorableWindowsBackupManifest['identity'],directory:string,signal?:AbortSignal,writeOwned?:(name:string,bytes:Buffer)=>Promise<void>){
 const keygen=path.join(process.env.SystemRoot??'C:\\Windows','System32/OpenSSH/ssh-keygen.exe');
 try{
  for(const [name,secret,expected] of [['management-check',identity.managementPrivate,identity.managementPublic],['host-check',identity.hostPrivate,identity.hostPublic]]){
   const file=path.join(directory,name);if(writeOwned){const bytes=Buffer.from(secret);try{await writeOwned(name,bytes);}finally{bytes.fill(0);}}else await writeFile(file,secret,{flag:'wx'});
   let validationFailed=false;
   try{const actual=await run(keygen,['-y','-P','','-f',file],{env:cleanWindowsEnvironment(),signal,timeoutMs:10000,maxBytes:32768});if(keyPublic(actual)!==keyPublic(expected))throw Error('Key pair differs');}
   catch(error){validationFailed=true;throw error;}
   finally{try{await unlink(file);}catch(error){if(!validationFailed)throw new AppError('身份校验临时资料尚未确认清理，原目录已保留',409,'BACKUP_CLEANUP_PENDING');}}
  }
  const known=identity.knownHosts.trim().split(/\r?\n/);if(known.length!==1||known[0].trim().split(/\s+/).slice(0,3).join(' ')!==vmIdentity(identity.id).name+' '+keyPublic(identity.hostPublic))throw Error('Known host identity differs');
  const seed=Buffer.from(identity.seed.base64,'base64');try{for(const value of [identity.managementPublic,identity.hostPublic])if(!seed.includes(Buffer.from(keyPublic(value).split(' ')[1])))throw Error('Seed public identity differs');}finally{seed.fill(0);}
 }catch(error){signal?.throwIfAborted();if(error instanceof AppError&&error.code==='BACKUP_CLEANUP_PENDING')throw error;throw failure('BACKUP_IDENTITY','原管理密钥、主机身份或种子资料不一致，未继续恢复');}
}
async function materialFiles(root:string,id:string){const p=windowsPaths(root,id),files=[p.key,p.key+'.pub',p.hostKey,p.hostKey+'.pub',p.knownHosts,p.manifest],bytes:Buffer[]=[];try{for(const file of files)bytes.push(await readOriginal(file,65536));return {files,bytes,binding:materialHash(bytes)};}catch(error){for(const value of bytes)value.fill(0);throw error;}}
function materialHash(bytes:Buffer[]){const hash=createHash('sha256');for(const value of bytes){const size=Buffer.alloc(4);size.writeUInt32BE(value.length);hash.update(size).update(value);}return hash.digest('hex');}
// Shared by offline snapshot ownership replay. These helpers expose only the
// existing checked reads/private workspace; they never publish an environment.
export {configOf as windowsEnvironmentConfiguration,privateWork as privateWindowsBackupWork,materialFiles as readWindowsManagementMaterials};
export async function exportWindowsBackup(broker:HyperVBrokerClient,root:string,environment:Environment,output:BackupSink,password:string,options:WindowsBackupReadOptions&{cleanupRegistry?:WindowsBackupCleanupRegistry;onCleanupIssue?:(issue:WindowsBackupCleanupIssue)=>void}={}){
 const staging=await privateWork(root),owned=await options.cleanupRegistry?.begin(staging.directory,'export'),work={directory:staging.directory,close:()=>owned?owned.close():staging.close()};let reader:Awaited<ReturnType<typeof openProtectedBackupRead>>|undefined,materials:Awaited<ReturnType<typeof materialFiles>>|undefined,seed:Buffer|undefined,failed=false,result:ExportedWindowsBackup|undefined;
 try{
  options.signal?.throwIfAborted();materials=await materialFiles(root,environment.id);const saved=metadataManifest.parse(JSON.parse(materials.bytes[5].toString('utf8')));if(saved.id!==environment.id)throw failure('BACKUP_IDENTITY','原管理清单身份不一致');
  reader=await openProtectedBackupRead(broker,environment.id,options);if(reader.info.platformId!==saved.platformId||reader.info.imageSha256!==saved.imageSha256||reader.info.cpus!==environment.cpus||reader.info.memoryGiB!==environment.memoryGiB||reader.info.diskGiB!==environment.diskGiB)throw failure('BACKUP_IDENTITY','原配置与受保护磁盘登记不一致');
  seed=await reader.readSeed();const identity=windowsBackupIdentity.parse({id:environment.id,managementPrivate:materials.bytes[0].toString('utf8'),managementPublic:materials.bytes[1].toString('utf8'),hostPrivate:materials.bytes[2].toString('utf8'),hostPublic:materials.bytes[3].toString('utf8'),knownHosts:materials.bytes[4].toString('utf8'),seed:{base64:seed.toString('base64'),sha256:reader.info.seed!.sha256}});
  await validateBackupIdentity(identity,work.directory,options.signal,owned?(name,bytes)=>owned.write(name,bytes):undefined);
  const manifest=restorableWindowsBackupManifest.parse({version:2,architecture:'x86_64',platform:'hyperv',config:configOf(environment),identity,imageSha256:saved.imageSha256,disk:{bytes:reader.info.bytes,sha256:reader.info.sha256}});
  const again=await materialFiles(root,environment.id);try{if(again.binding!==materials.binding)throw failure('BACKUP_IDENTITY','原管理资料在备份前变化，请重新开始');}finally{for(const value of again.bytes)value.fill(0);}
  await writeWindowsBackupArchive(output,reader.stream(),manifest,password,options.signal);
  const final=await materialFiles(root,environment.id);try{if(final.binding!==materials.binding)throw failure('BACKUP_IDENTITY','原管理资料在备份期间变化，未完成备份');}finally{for(const value of final.bytes)value.fill(0);}
  result={id:environment.id,bytes:manifest.disk.bytes,sha256:manifest.disk.sha256};return result;
 }catch(error){failed=true;throw error;}
 finally{
  seed?.fill(0);if(materials)for(const value of materials.bytes)value.fill(0);
  let releaseFailure:unknown,cleanupFailure:unknown,issue:WindowsBackupCleanupIssue|undefined;
  try{await reader?.close();}catch(error){releaseFailure=error;}
  try{await work.close();}catch(error){cleanupFailure=error;issue=options.cleanupRegistry?.issues().find(value=>value.directory===work.directory)??{directory:work.directory,message:'临时管理资料尚未确认清理，可能仍有明文凭据。请勿分享该目录，核对后再清理。',sensitiveDataMayRemain:true};try{options.onCleanupIssue?.(issue);}catch{/* Diagnostics cannot replace the primary operation. */}}
  if(!failed){if(releaseFailure)throw releaseFailure;if(cleanupFailure){if(result&&issue)throw new WindowsBackupExportCleanupError(result,issue,cleanupFailure);throw cleanupFailure;}}
 }
}
async function room(directory:string,additional:number){const facts=await statfs(directory,{bigint:true});if(facts.bavail*facts.bsize<BigInt(additional)+2n*1024n**3n)throw failure('RESOURCE_DISK','剩余空间不足，已停止恢复并保留原环境');}
// Reserve a small bounded window at each space check. The stream is written
// serially; unspent reservation is never carried across a failed check.
export function windowsRestoreSpaceWindow(check:(bytes:number)=>Promise<void>){let remaining=0;return async(bytes:number,totalRemaining:number)=>{
 if(!Number.isSafeInteger(bytes)||bytes<1||!Number.isSafeInteger(totalRemaining)||totalRemaining<bytes)throw failure('WINDOWS_BACKUP_INTEGRITY','恢复数据长度异常');
 if(remaining<bytes){remaining=0;const next=Math.min(4*1024*1024,totalRemaining);await check(next);remaining=next;}remaining-=bytes;
};}
async function writeOriginal(file:string,bytes:Buffer){try{await writeFile(file,bytes,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const existing=await readOriginal(file,Math.max(1,bytes.length));try{if(!existing.equals(bytes))throw failure('RESTORE_CONFLICT','目标管理文件已变化，已保留，不能覆盖');}finally{existing.fill(0);}}}
function tokenOf(manifest:RestorableWindowsBackupManifest){return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');}
export async function windowsBackupResumeName(root:string,manifest:RestorableWindowsBackupManifest){
 const file=path.join(windowsPaths(root,manifest.identity.id).directory,'backup-restore.json');try{const bytes=await readOriginal(file,4096);try{const value=z.object({version:z.literal(1),id:z.literal(manifest.identity.id),digest:z.literal(tokenOf(manifest)),restoreName:environmentSchema.shape.name.optional()}).strict().parse(JSON.parse(bytes.toString('utf8')));return value.restoreName??manifest.config.name;}finally{bytes.fill(0);}}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw failure('RESTORE_CONFLICT','已有恢复资料与此备份不一致，原文件已保留');}
}
async function localResume(root:string,manifest:RestorableWindowsBackupManifest,restoreName:string){
 const saved=await windowsBackupResumeName(root,manifest);if(saved!==null&&saved!==restoreName)throw failure('RESTORE_CONFLICT','恢复名称与原记录不一致，请使用原名称继续');return saved;
}
export async function restoreWindowsBackup(broker:HyperVBrokerClient,root:string,store:Store,input:Input,password:string,options:WindowsBackupReadOptions&{expectedManifestDigest?:string;restoreName?:string;onProgress?:(bytes:number,total:number)=>void;onCleanupIssue?:(issue:WindowsBackupCleanupIssue)=>void;cleanupRegistry?:WindowsBackupCleanupRegistry}={}){
 const staging=await privateWork(root),registry=options.cleanupRegistry??new WindowsBackupCleanupRegistry(store,root),owned=await registry.begin(staging.directory),work={directory:staging.directory,close:()=>owned.close()},disk=path.join(work.directory,'disk.vhdx'),checkSpace=windowsRestoreSpaceWindow(bytes=>room(work.directory,bytes));let file:OwnedBackupWriter|undefined,total=0,manifest:RestorableWindowsBackupManifest|undefined,targetStarted=false,restoreCommitted=false;
 try{
  file=await owned.open('disk.vhdx');const decoded=await readWindowsBackupArchive(input,{write:async bytes=>{options.signal?.throwIfAborted();if(!manifest)throw failure('WINDOWS_BACKUP_INTEGRITY','恢复数据缺少清单');await checkSpace(bytes.length,manifest.disk.bytes-total);await file!.write(bytes);total+=bytes.length;options.onProgress?.(total,manifest.disk.bytes);}},password,options.signal,async value=>{
   manifest=restorableWindowsBackupManifest.parse(value);if(options.expectedManifestDigest&&tokenOf(manifest)!==options.expectedManifestDigest)throw failure('BACKUP_REVIEW_CHANGED','备份内容已变化，请重新审阅');const restoreName=environmentSchema.shape.name.parse(options.restoreName??manifest.config.name),resume=await localResume(root,manifest,restoreName),row=store.list().find(item=>item.id===manifest!.identity.id);
   if(row&&(!resume||JSON.stringify(configOf(row))!==JSON.stringify({...manifest.config,name:restoreName})))throw failure('RESTORE_CONFLICT','原环境记录已存在或已变化，不能覆盖');
   const allocation=await broker.call('allocation',{id:manifest.identity.id}) as {registered:boolean;backupRestorePending?:boolean};
   if(allocation.registered&&!allocation.backupRestorePending&&!resume)throw failure('RESTORE_CONFLICT','原环境登记已存在，不能覆盖');
   if(!allocation.registered){const absent=await broker.call('absence',{id:manifest.identity.id}) as {absent:boolean};if(!absent.absent)throw failure('RESTORE_CONFLICT','原虚拟机或磁盘仍存在，不能覆盖');}
   const directory=windowsPaths(root,manifest.identity.id).directory;try{const entry=await lstat(directory);if(!resume||!entry.isDirectory()||entry.isSymbolicLink())throw failure('RESTORE_CONFLICT','已有管理目录已保留，不能覆盖');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   await room(work.directory,manifest.disk.bytes);
  });
  manifest=restorableWindowsBackupManifest.parse(decoded);if(total!==manifest.disk.bytes)throw failure('WINDOWS_BACKUP_INTEGRITY','备份长度不完整');await file.sync();await file.close();
  options.signal?.throwIfAborted();await validateBackupIdentity(manifest.identity,work.directory,options.signal,(name,bytes)=>owned.write(name,bytes));const restoreName=environmentSchema.shape.name.parse(options.restoreName??manifest.config.name),p=windowsPaths(root,manifest.identity.id),resume=await localResume(root,manifest,restoreName);
  // Prepare new management identities in the private work directory. Publishing
  // an empty final directory first leaves no recovery journal if the process
  // exits before its next write, so the next attempt cannot prove ownership.
  const prepared=resume?p:windowsPaths(work.directory,manifest.identity.id);
  if(!resume)await owned.mkdir(path.basename(prepared.directory));await secureWindowsDirectory(prepared.directory);
  const writePrepared=(file:string,bytes:Buffer)=>resume?writeOriginal(file,bytes):owned.write(path.relative(work.directory,file).split(path.sep).join('/'),bytes);
  await writePrepared(path.join(prepared.directory,'backup-restore.json'),Buffer.from(JSON.stringify({version:1,id:manifest.identity.id,digest:tokenOf(manifest),...(restoreName!==manifest.config.name?{restoreName}:{})})));
  const identity=manifest.identity;const material:[string,Buffer][]=[[prepared.key,Buffer.from(identity.managementPrivate)],[prepared.key+'.pub',Buffer.from(identity.managementPublic)],[prepared.hostKey,Buffer.from(identity.hostPrivate)],[prepared.hostKey+'.pub',Buffer.from(identity.hostPublic)],[prepared.knownHosts,Buffer.from(identity.knownHosts)],[prepared.seed,Buffer.from(identity.seed.base64,'base64')]];
  try{for(const [name,bytes] of material)await writePrepared(name,bytes);}finally{for(const [,bytes] of material)bytes.fill(0);}
  await writePrepared(path.join(prepared.directory,'allocation.json'),Buffer.from(JSON.stringify({version:1,id:identity.id,backend:'hyperv-broker'})));
  if(!resume){
   options.signal?.throwIfAborted();
   // Both directories are on the validated runtime volume. Directory.Move
   // publishes the complete directory and refuses any existing destination.
   try{await run(powershellPath(),powershellArgs("$ErrorActionPreference='Stop';[Console]::InputEncoding=New-Object Text.UTF8Encoding($false);$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;[IO.Directory]::Move([string]$r.source,[string]$r.target)"),{input:JSON.stringify({source:prepared.directory,target:p.directory}),env:cleanWindowsEnvironment(),signal:options.signal,timeoutMs:10000});}
   catch(error){options.signal?.throwIfAborted();const existing=await lstat(p.directory).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});if(existing)throw failure('RESTORE_CONFLICT','恢复目标目录已出现，原文件已保留，不能覆盖');throw error;}
  }
  const old=store.list().find(value=>value.id===identity.id),now=new Date().toISOString();const environment:Environment={...manifest.config,name:restoreName,id:identity.id,instanceName:vmIdentity(identity.id).name,state:'error',lastError:'备份恢复待完成，请使用原备份继续恢复',browserRunning:false,createdAt:old?.createdAt??now,updatedAt:now};store.save(environment);targetStarted=true;
  const allocated=await broker.call('allocation',{id:identity.id}) as {registered:boolean;backupRestorePending?:boolean;platformId?:string};let platformId:string;
  if(allocated.registered&&!allocated.backupRestorePending){
   const original=await openProtectedBackupRead(broker,identity.id,options);try{if(original.info.sha256!==manifest.disk.sha256||original.info.bytes!==manifest.disk.bytes||original.info.seed?.sha256!==identity.seed.sha256)throw failure('RESTORE_CONFLICT','已有磁盘不符合这份待完成恢复，已保留');platformId=original.info.platformId;}finally{await original.close();}
  }else{
   const result=z.object({restored:z.literal(true),id:z.literal(identity.id),platformId:z.uuid(),state:z.literal('Off'),diskSha256:z.literal(manifest.disk.sha256)}).strict().parse(await broker.call('backup-import',{id:identity.id,imageSha256:manifest.imageSha256,cpus:manifest.config.cpus,memoryGiB:manifest.config.memoryGiB,diskGiB:manifest.config.diskGiB,disk, diskSha256:manifest.disk.sha256,diskBytes:manifest.disk.bytes,seed:p.seed,seedSha256:identity.seed.sha256,seedBytes:Buffer.from(identity.seed.base64,'base64').length},{...options,timeoutMs:options.timeoutMs??1200000}));platformId=result.platformId;
  }
  await writeOriginal(p.manifest,Buffer.from(JSON.stringify({version:1,id:identity.id,platformId,imageSha256:manifest.imageSha256,purpose:'environment'})));store.state(identity.id,'stopped');
  // Construct the result before removing the resume marker: a database or
  // serialization failure must leave the same archive able to finish safely.
  const restored=store.public(store.get(identity.id));await unlink(path.join(p.directory,'backup-restore.json'));restoreCommitted=true;return restored;
 }catch(error){if(targetStarted&&manifest)try{store.state(manifest.identity.id,'error','备份恢复未完成，文件已保留，请使用原备份继续或确认删除');}catch{try{store.log(null,null,'备份恢复失败后的状态记录未能更新；原恢复资料与原错误均已保留。','error');}catch{/* A secondary database fault cannot replace the original restore error. */}}throw error;}
 finally{
  await file?.close().catch(()=>{});
  try{await work.close();}catch(error){
   const issue:WindowsBackupCleanupIssue=registry.issues().find(value=>value.directory===work.directory)??{directory:work.directory,message:'临时资料尚未确认清理，可能仍有明文磁盘或管理凭据。请勿分享该目录，核对后再清理。',sensitiveDataMayRemain:true};
   // Record globally so deleting an environment cannot erase this warning.
   try{store.log(null,null,`${restoreCommitted?'恢复已完成，请勿重复恢复。':'恢复尚未完成。'}${issue.message} 目录：${issue.directory}`,'error');}catch{/* Diagnostics must not replace the operation result. */}
   try{options.onCleanupIssue?.(issue);}catch{/* An observer cannot replace the primary error or committed result. */}
   if(restoreCommitted)throw new WindowsBackupCleanupError(manifest!.identity.id,issue,error);
   // The pending primary failure/cancellation continues unchanged. Do not let
   // a cleanup error replace its code, name, cause or object identity.
  }
 }
}
