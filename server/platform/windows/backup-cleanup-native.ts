import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {run} from '../../process.ts';
import {AppError} from '../../errors.ts';
import {cleanWindowsEnvironment} from './broker.ts';
import {powershellArgs,powershellPath,powershellScript} from './runtime.ts';

export interface BackupCleanupIdentity {path:string;dev:string;ino:string;birthtimeNs:string}
export type BackupCleanupEntry=BackupCleanupIdentity&({kind:'directory'}|{kind:'file';bytes:string;mtimeNs:string;sha256:string});
export interface BackupCleanupRemoval {root:string;directory:string;ancestors:BackupCleanupIdentity[];entries:BackupCleanupEntry[]}
const scripts=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..','scripts/windows');
// This internal input must originate in the authenticated producer registry.
// The HTTP API accepts only a record UUID, never this path-bearing structure.
export async function removeWindowsBackupWork(input:BackupCleanupRemoval,signal?:AbortSignal){
 signal?.throwIfAborted();
 try{
  const started=(await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop';[Console]::Write([Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().Ticks.ToString())`),{env:cleanWindowsEnvironment(),signal,timeoutMs:10000,maxBytes:2048})).trim();
  if(!/^[0-9]{1,24}$/.test(started))throw Error('Cleanup controller identity unavailable');signal?.throwIfAborted();
  const result=await run(powershellPath(),powershellArgs(`${powershellScript(path.join(scripts,'backup-cleanup.ps1'))} -ScriptDirectory '${scripts.replaceAll("'","''")}' -OwnerPid ${process.pid} -OwnerStarted '${started}'`),{input:JSON.stringify(input),env:cleanWindowsEnvironment(),signal,timeoutMs:1200000,maxBytes:8192});
  z.object({removed:z.literal(true)}).strict().parse(JSON.parse(result));
 }catch{signal?.throwIfAborted();throw new AppError('临时资料无法安全核验或仍被占用，目录和原清理凭据已保留',409,'BACKUP_CLEANUP_PENDING');}
}
