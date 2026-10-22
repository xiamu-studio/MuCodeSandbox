import {DatabaseSync} from 'node:sqlite';
import {open,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {z} from 'zod';
import {protectCurrentUser} from './credentials.ts';
import {windowsPaths} from './config.ts';
import type {WindowsRecoveryCandidate} from '../../../shared/windows-recovery.ts';
const id=z.uuid().refine(value=>value===value.toLowerCase()&&value!=='00000000-0000-0000-0000-000000000000');
const saved=z.object({id,name:z.string().min(1).max(60),kind:z.literal('vm'),cpus:z.number().int().min(1).max(16),memoryGiB:z.number().int().min(2).max(32),diskGiB:z.number().int().min(16).max(256)});
const manifest=z.object({version:z.literal(1),id,platformId:id,imageSha256:z.string().regex(/^[a-f0-9]{64}$/),purpose:z.literal('environment')});
async function regular(file:string,max:number){const entry=await lstat(file);if(!entry.isFile()||entry.isSymbolicLink()||entry.nlink!==1||entry.size<1||entry.size>max)throw Error('Original management file is unavailable');return entry;}
async function readOriginal(file:string,max:number){
 const before=await regular(file,max),handle=await open(file,'r');
 try{
  const pinned=await handle.stat();if(!pinned.isFile()||pinned.nlink!==1||pinned.dev!==before.dev||pinned.ino!==before.ino||pinned.size!==before.size)throw Error('Original management file changed');
  // Bound the read even if another process grows the file after stat.
  const bytes=Buffer.alloc(max+1);let size=0;
  while(size<bytes.length){const read=await handle.read(bytes,size,bytes.length-size,null);if(!read.bytesRead)break;size+=read.bytesRead;}
  const after=await regular(file,max),end=await handle.stat();
  if(size!==before.size||after.dev!==pinned.dev||after.ino!==pinned.ino||end.size!==pinned.size||end.nlink!==1||end.mtimeMs!==pinned.mtimeMs||end.ctimeMs!==pinned.ctimeMs||after.mtimeMs!==end.mtimeMs||after.ctimeMs!==end.ctimeMs)throw Error('Original management file changed');
  return bytes.subarray(0,size);
 }finally{await handle.close();}
}
// Private server state: never copy these bindings into the recovery UI snapshot.
export interface RecoveryInventory {candidates:WindowsRecoveryCandidate[];issue:string|null;bindings:Map<string,string>}
// Open only the existing database in read-only mode. Never construct Store:
// normal initialization creates keys/tables and rewrites interrupted jobs.
export async function recoveryCandidates(dataDir:string,runtimeRoot:string):Promise<RecoveryInventory>{
 let db:DatabaseSync|undefined;
 try{
  await regular(path.join(dataDir,'state.sqlite'),128*1024*1024);await regular(path.join(dataDir,'credentials.dpapi'),65536);
  const credentials=await readOriginal(path.join(dataDir,'credentials.dpapi'),65536);
  const key=await protectCurrentUser(credentials,'unprotect');try{if(key.length!==32)throw Error('Original credentials unavailable');}finally{key.fill(0);}
  db=new DatabaseSync(path.join(dataDir,'state.sqlite'),{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
  const rows=db.prepare('SELECT id,config FROM environments ORDER BY rowid DESC LIMIT 257').all() as {id:string;config:string}[];
  if(rows.length>256)throw Error('Original configuration inventory exceeds its bound');
  const candidates:WindowsRecoveryCandidate[]=[],bindings=new Map<string,string>();
  for(const row of rows){
   if(typeof row.config!=='string'||Buffer.byteLength(row.config)>65536)throw Error('Original configuration is unavailable');
   const original=saved.parse(JSON.parse(row.config));if(original.id!==row.id)throw Error('Original configuration identity changed');
   const item:WindowsRecoveryCandidate={id:original.id,name:original.name,cpus:original.cpus,memoryGiB:original.memoryGiB,diskGiB:original.diskGiB,platformId:null,imageSha256:null,ready:false,issue:null};
   try{
    const p=windowsPaths(runtimeRoot,original.id),dir=await lstat(p.directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('Original directory changed');
    const metadata=await readOriginal(p.manifest,16384),value=manifest.parse(JSON.parse(metadata.toString('utf8')));if(value.id!==original.id)throw Error('Original manifest changed');
    if(value.imageSha256==='c74a7d3b3476ffb2715bfcaf9c216e9dd1d6c7e01bc6d0380b1744518dfae15c'||/^0{64}$/.test(value.imageSha256))throw Error('A working environment source is required');
    const binding=createHash('sha256').update('MuCodeSandbox recovery original materials v1\0');
    const add=(bytes:Buffer)=>{const size=Buffer.alloc(4);size.writeUInt32BE(bytes.length);binding.update(size).update(bytes);};
    add(Buffer.from(row.config));add(credentials);add(metadata);
    for(const file of [p.key,p.hostKey,p.knownHosts]){const bytes=await readOriginal(file,65536);try{add(bytes);}finally{bytes.fill(0);}}
    bindings.set(original.id,binding.digest('hex'));
    item.platformId=value.platformId;item.imageSha256=value.imageSha256;item.ready=true;
   }catch{item.issue='原管理清单或密钥不完整，文件已保留；请先恢复原管理资料。';}
   candidates.push(item);
  }
  return {candidates,bindings,issue:candidates.length?null:'未找到原环境配置，现有文件已保留。此向导需要原环境配置、管理清单和密钥。'};
 }catch{return {candidates:[],bindings:new Map(),issue:'无法只读核验原环境配置或当前用户凭据，现有文件已保留。请先恢复原管理资料。'};}
 finally{db?.close();}
}
