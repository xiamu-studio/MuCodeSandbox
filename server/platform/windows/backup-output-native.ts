import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {run} from '../../process.ts';
import {AppError} from '../../errors.ts';
import {cleanWindowsEnvironment} from './broker.ts';
import {powershellArgs,powershellPath,powershellScript} from './runtime.ts';

export interface BackupOutputIdentity {path:string;dev:string;ino:string;birthtimeNs:string}
export interface BackupOutputEntry extends BackupOutputIdentity {bytes:string;mtimeNs:string;sha256:string}
export interface BackupOutputOperation {temporary:string;target:string;ancestors:BackupOutputIdentity[];entry:BackupOutputEntry}
export type BackupOutputMode='publish'|'check-published'|'cleanup';
export type BackupOutputReply={published:boolean}|{removed:true};
const scripts=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..','scripts/windows');
// Only the encrypted producer registry supplies this path-bearing input.
export async function operateWindowsBackupOutput(input:BackupOutputOperation,mode:BackupOutputMode,signal?:AbortSignal):Promise<BackupOutputReply>{
 signal?.throwIfAborted();
 try{
  const started=(await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop';[Console]::Write([Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().Ticks.ToString())`),{env:cleanWindowsEnvironment(),signal,timeoutMs:10000,maxBytes:2048})).trim();
  if(!/^[0-9]{1,24}$/.test(started))throw Error('Output controller identity unavailable');signal?.throwIfAborted();
  const raw=await run(powershellPath(),powershellArgs(`${powershellScript(path.join(scripts,'backup-output.ps1'))} -ScriptDirectory '${scripts.replaceAll("'","''")}' -Mode '${mode}' -OwnerPid ${process.pid} -OwnerStarted '${started}'`),{input:JSON.stringify(input),env:cleanWindowsEnvironment(),signal,timeoutMs:1200000,maxBytes:8192});
  if(mode==='cleanup')return z.object({removed:z.literal(true)}).strict().parse(JSON.parse(raw));
  const value=z.union([z.object({published:z.boolean()}).strict(),z.object({published:z.literal(false),conflict:z.literal(true)}).strict()]).parse(JSON.parse(raw));
  if('conflict' in value)throw new AppError('目标文件已存在，请选择新的保存文件名',409,'BACKUP_EXISTS');return value;
 }catch(error){signal?.throwIfAborted();if(error instanceof AppError&&error.code==='BACKUP_EXISTS')throw error;throw new AppError('备份输出无法安全核验或仍被占用，原临时文件与清理凭据已保留',409,'BACKUP_OUTPUT_PENDING');}
}
