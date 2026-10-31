import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {run,type Runner,type RunOptions} from '../../process.ts';
import {AppError} from '../../errors.ts';
import {cleanWindowsEnvironment} from './broker.ts';
import {powershellPath,powershellArgs,powershellScript} from './runtime.ts';
import {windowsSnapshotOwnerFileNames,type WindowsSnapshotOwnerFile,type WindowsSnapshotOwnerFileBinding} from './snapshot-owner.ts';

const scripts=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..','scripts/windows');
const canonical=z.uuid().refine(v=>v===v.toLowerCase()&&v!=='00000000-0000-0000-0000-000000000000');
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const receipt=z.object({verified:z.literal(true),retainedBackups:z.number().int().min(0).max(8),files:z.array(z.object({name:z.enum(windowsSnapshotOwnerFileNames),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().min(1).max(8*2**20)}).strict()).length(8)}).strict();
const failure=()=>new AppError('快照管理文件无法安全重放或已被改动，事务与原文件已保留',409,'SNAPSHOT_FILES');

// Both versions must come from authenticated owner envelopes bound to the same
// native transaction. No caller paths or plaintext enter shell command text.
export async function replayWindowsSnapshotOwnerFiles(root:string,id:string,transactionId:string,desired:WindowsSnapshotOwnerFile[],previous:WindowsSnapshotOwnerFile[]=[],options:RunOptions&{checkOnly?:boolean;runner?:Runner;previousHashes?:WindowsSnapshotOwnerFileBinding[]}={}){
 canonical.parse(id);canonical.parse(transactionId);options.signal?.throwIfAborted();
 const inventory=(files:WindowsSnapshotOwnerFile[])=>files.length===8&&new Set(files.map(f=>f.name)).size===8&&files.every(f=>windowsSnapshotOwnerFileNames.includes(f.name));
 if(!inventory(desired)||(previous.length&&!inventory(previous))||previous.length&&options.previousHashes)throw failure();
 const previousHashes=options.previousHashes?z.array(z.object({name:z.enum(windowsSnapshotOwnerFileNames),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().positive().max(8*2**20)}).strict()).length(8).parse(options.previousHashes):previous.map(file=>({name:file.name,sha256:hash(file.bytes),bytes:file.bytes.length}));
 if(previousHashes.length&&new Set(previousHashes.map(v=>v.name)).size!==8)throw failure();
 const files=desired.map(file=>({name:file.name,base64:file.bytes.toString('base64'),sha256:hash(file.bytes),allowed:[...new Set([hash(file.bytes),...previousHashes.filter(v=>v.name===file.name).map(v=>v.sha256)])]}));
 try{
  const output=await(options.runner??run)(powershellPath(),powershellArgs(`${powershellScript(path.join(scripts,'snapshot-owner-files.ps1'))} -ScriptDirectory '${scripts.replaceAll("'","''")}'`),{input:JSON.stringify({root:path.resolve(root),id,transactionId,files,checkOnly:options.checkOnly??false}),env:cleanWindowsEnvironment(),signal:options.signal,timeoutMs:options.timeoutMs??30000,maxBytes:16384});
  const value=receipt.parse(JSON.parse(output));if(new Set(value.files.map(f=>f.name)).size!==8||value.files.some(file=>{const expected=desired.find(v=>v.name===file.name)!;return file.sha256!==hash(expected.bytes)||file.bytes!==expected.bytes.length;}))throw failure();return value;
 }catch{options.signal?.throwIfAborted();throw failure();}
}
