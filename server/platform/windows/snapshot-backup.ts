import type {Store} from '../../store.ts';
import {AppError} from '../../errors.ts';
import type {HyperVBrokerClient} from './broker.ts';
import {privateWindowsBackupWork,validateBackupIdentity,WindowsBackupExportCleanupError,type ExportedWindowsBackup} from './backup-bundle.ts';
import {WindowsBackupCleanupRegistry} from './backup-cleanup.ts';
import {openProtectedSnapshotRead,type WindowsBackupReadOptions} from './backup-reader.ts';
import {WindowsSnapshotOwnerCodec} from './snapshot-owner.ts';
import {restorableWindowsBackupManifest,windowsBackupIdentity,writeWindowsBackupArchive,type BackupSink} from './backup-archive.ts';
import type {WindowsBackupCleanupIssue} from '../../../shared/windows-backup.ts';

// Every archive field is selected from the authenticated historical owner and
// native snapshot lease. Current management files and current disk are unused.
export async function exportWindowsSnapshotBackup(broker:HyperVBrokerClient,store:Store,root:string,id:string,snapshotId:string,output:BackupSink,password:string,options:WindowsBackupReadOptions&{expectedName?:string;expectedCreatedAt?:string;cleanupRegistry?:WindowsBackupCleanupRegistry;onCleanupIssue?:(issue:WindowsBackupCleanupIssue)=>void}={}){
 const staging=await privateWindowsBackupWork(root),registry=options.cleanupRegistry??new WindowsBackupCleanupRegistry(store,root),owned=await registry.begin(staging.directory,'export');let reader:Awaited<ReturnType<typeof openProtectedSnapshotRead>>|undefined,seed:Buffer|undefined,failed=false,result:ExportedWindowsBackup|undefined;
 try{
  options.signal?.throwIfAborted();reader=await openProtectedSnapshotRead(broker,id,snapshotId,options);const info=reader.info;
  if(options.expectedName!==undefined&&info.name!==options.expectedName||options.expectedCreatedAt!==undefined&&Date.parse(info.createdAt)!==Date.parse(options.expectedCreatedAt))throw new AppError('所选历史快照的名称或时间已变化，请刷新后重新导出',409,'BACKUP_IDENTITY_CHANGED');
  const owner=new WindowsSnapshotOwnerCodec(store,root).decode(info.ownerConfiguration,{id:info.id,platformId:info.platformId,imageSha256:info.imageSha256,seedSha256:info.seed.sha256,seedBytes:info.seed.bytes,cpus:info.cpus,memoryGiB:info.memoryGiB,diskGiB:info.diskGiB});
  seed=await reader.readSeed();const identity=windowsBackupIdentity.parse({...owner.identity,seed:{base64:seed.toString('base64'),sha256:info.seed.sha256}});await validateBackupIdentity(identity,staging.directory,options.signal,owned.write);
  const manifest=restorableWindowsBackupManifest.parse({version:2,architecture:'x86_64',platform:'hyperv',config:owner.config,identity,imageSha256:owner.imageSha256,disk:{bytes:info.bytes,sha256:info.sha256}});
  await writeWindowsBackupArchive(output,reader.stream(),manifest,password,options.signal);result={id,bytes:manifest.disk.bytes,sha256:manifest.disk.sha256};return result;
 }catch(error){failed=true;throw error;}
 finally{
  seed?.fill(0);let releaseError:unknown,cleanupError:unknown,issue:WindowsBackupCleanupIssue|undefined;
  try{await reader?.close();}catch(error){releaseError=error;}
  try{await owned.close();}catch(error){cleanupError=error;issue=registry.issues().find(value=>value.directory===staging.directory)??{directory:staging.directory,message:'历史身份校验资料尚未确认清理，请保留告警并核对临时目录。',sensitiveDataMayRemain:true};try{options.onCleanupIssue?.(issue);}catch{/* Keep the original operation outcome. */}}
  if(!failed){if(releaseError)throw releaseError;if(cleanupError){if(result&&issue)throw new WindowsBackupExportCleanupError(result,issue,cleanupError);throw cleanupError;}}
 }
}
