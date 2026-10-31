import {lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import type {SystemInfo} from '../../../shared/types.ts';

const receipt=z.object({buildId:z.string().regex(/^[a-f0-9]{8,64}$/),builtAt:z.string().max(40).datetime({offset:true}),channel:z.literal('local-test')}).strict();
async function boundedJson(file:string,limit:number){
 const entry=await lstat(file);if(!entry.isFile()||entry.isSymbolicLink()||entry.nlink!==1||entry.size>limit)throw Error('Invalid metadata file');
 const handle=await open(file,'r');
 try{
  const actual=await handle.stat();if(!actual.isFile()||actual.nlink!==1||actual.ino!==entry.ino||actual.dev!==entry.dev||actual.size>limit)throw Error('Metadata identity changed');
  const buffer=Buffer.alloc(limit+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0),after=await handle.stat();
  if(bytesRead!==actual.size||after.size!==actual.size||after.mtimeMs!==actual.mtimeMs)throw Error('Metadata changed while reading');
  return JSON.parse(buffer.subarray(0,bytesRead).toString('utf8')) as unknown;
 }finally{await handle.close();}
}

// Read only the selected application root, never cwd or the runtime/data root.
// This is a build label, not a signature or proof of the native broker inputs.
export async function windowsApplication(rootDir:string,version:string):Promise<NonNullable<SystemInfo['application']>>{
 let channel:'source-preview'|'desktop-test'='source-preview';
 const unknown=()=>({channel,buildId:'unknown',builtAt:null});
 try{
  const pkg=await boundedJson(path.join(rootDir,'package.json'),256*1024);
  if(pkg&&typeof pkg==='object'&&'name' in pkg&&pkg.name==='mucodesandbox-windows-preview'){
   channel='desktop-test';if(!('version' in pkg)||pkg.version!==version)return unknown();
  }
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return unknown();}
 try{
  const saved=receipt.parse(await boundedJson(path.join(rootDir,'build-info.json'),4096));
  return {channel,buildId:saved.buildId,builtAt:saved.builtAt};
 }catch(error){
  if(channel==='source-preview'&&(error as NodeJS.ErrnoException).code==='ENOENT')return {channel,buildId:'working-tree',builtAt:null};
  return unknown();
 }
}
