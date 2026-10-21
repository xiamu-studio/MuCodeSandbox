import {DatabaseSync} from 'node:sqlite';
import {readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {protectCurrentUser} from './credentials.ts';
import {windowsPaths} from './config.ts';
import type {WindowsRecoveryCandidate} from '../../../shared/windows-recovery.ts';
const id=z.uuid().refine(value=>value===value.toLowerCase()&&value!=='00000000-0000-0000-0000-000000000000');
const saved=z.object({id,name:z.string().min(1).max(60),kind:z.literal('vm'),cpus:z.number().int().min(1).max(16),memoryGiB:z.number().int().min(2).max(32),diskGiB:z.number().int().min(16).max(256)});
const manifest=z.object({version:z.literal(1),id,platformId:id,imageSha256:z.string().regex(/^[a-f0-9]{64}$/),purpose:z.literal('environment')});
async function regular(file:string,max:number){const entry=await lstat(file);if(!entry.isFile()||entry.isSymbolicLink()||entry.size<1||entry.size>max)throw Error('Original management file is unavailable');}
// Open only the existing database in read-only mode. Never construct Store:
// normal initialization creates keys/tables and rewrites interrupted jobs.
export async function recoveryCandidates(dataDir:string,runtimeRoot:string):Promise<{candidates:WindowsRecoveryCandidate[];issue:string|null}>{
 let db:DatabaseSync|undefined;
 try{
  await regular(path.join(dataDir,'state.sqlite'),128*1024*1024);await regular(path.join(dataDir,'credentials.dpapi'),65536);
  const key=await protectCurrentUser(await readFile(path.join(dataDir,'credentials.dpapi')),'unprotect');try{if(key.length!==32)throw Error('Original credentials unavailable');}finally{key.fill(0);}
  db=new DatabaseSync(path.join(dataDir,'state.sqlite'),{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
  const rows=db.prepare('SELECT id,config FROM environments ORDER BY rowid DESC LIMIT 257').all() as {id:string;config:string}[];
  if(rows.length>256)throw Error('Original configuration inventory exceeds its bound');
  const candidates:WindowsRecoveryCandidate[]=[];
  for(const row of rows){
   if(typeof row.config!=='string'||Buffer.byteLength(row.config)>65536)throw Error('Original configuration is unavailable');
   const original=saved.parse(JSON.parse(row.config));if(original.id!==row.id)throw Error('Original configuration identity changed');
   const item:WindowsRecoveryCandidate={id:original.id,name:original.name,cpus:original.cpus,memoryGiB:original.memoryGiB,diskGiB:original.diskGiB,platformId:null,imageSha256:null,ready:false,issue:null};
   try{
    const p=windowsPaths(runtimeRoot,original.id),dir=await lstat(p.directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('Original directory changed');
    await regular(p.manifest,16384);const value=manifest.parse(JSON.parse(await readFile(p.manifest,'utf8')));if(value.id!==original.id)throw Error('Original manifest changed');
    if(value.imageSha256==='c74a7d3b3476ffb2715bfcaf9c216e9dd1d6c7e01bc6d0380b1744518dfae15c'||/^0{64}$/.test(value.imageSha256))throw Error('A working environment source is required');
    for(const file of [p.key,p.hostKey,p.knownHosts])await regular(file,65536);
    item.platformId=value.platformId;item.imageSha256=value.imageSha256;item.ready=true;
   }catch{item.issue='原管理清单或密钥不完整，文件已保留；请先恢复原管理资料。';}
   candidates.push(item);
  }
  return {candidates,issue:candidates.length?null:'未找到原环境配置，现有文件已保留。此向导需要原环境配置、管理清单和密钥。'};
 }catch{return {candidates:[],issue:'无法只读核验原环境配置或当前用户凭据，现有文件已保留。请先恢复原管理资料。'};}
 finally{db?.close();}
}
