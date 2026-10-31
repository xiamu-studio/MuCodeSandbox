import path from 'node:path';
import {lstat,readdir,rmdir,unlink} from 'node:fs/promises';
import type {BigIntStats} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {fileHash} from '../../server/platform/windows/runtime.ts';

interface EntryIdentity {path:string;dev:string;ino:string}
export type BuildTreeEntry=EntryIdentity&({kind:'directory'}|{kind:'file';bytes:string;mtimeNs:string;birthtimeNs:string;sha256:string});
const decimal=(value:unknown)=>typeof value==='string'&&/^\d{1,24}$/.test(value);
const order=(a:BuildTreeEntry,b:BuildTreeEntry)=>a.path<b.path?-1:a.path>b.path?1:0;
export function buildInventory(value:unknown):BuildTreeEntry[]{
 if(!Array.isArray(value)||value.length<1||value.length>100000)throw Error('Build inventory is missing or too large');
 const seen=new Map<string,BuildTreeEntry>();
 for(const item of value){
  if(!item||typeof item!=='object'||typeof item.path!=='string'||item.path.length>4096||item.path.includes('\\')||/[\x00-\x1f<>:"|?*]/.test(item.path)||item.path.startsWith('/')||item.path&&item.path.split('/').some((part:string)=>!part||part==='.'||part==='..'||/[. ]$/.test(part))||!decimal(item.dev)||!decimal(item.ino)||!['file','directory'].includes(item.kind))throw Error('Build inventory entry rejected');
  const keys=Object.keys(item).sort().join(','),expected=item.kind==='directory'?'dev,ino,kind,path':'birthtimeNs,bytes,dev,ino,kind,mtimeNs,path,sha256';
  if(keys!==expected||seen.has(item.path.toLowerCase()))throw Error('Build inventory duplicate or unexpected field');
  if(item.kind==='file'&&(!decimal(item.bytes)||!decimal(item.mtimeNs)||!decimal(item.birthtimeNs)||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256)))throw Error('Build inventory file metadata rejected');
  seen.set(item.path.toLowerCase(),item);
 }
 if(seen.get('')?.kind!=='directory')throw Error('Build inventory root rejected');
 for(const item of seen.values())if(item.path){const parent=path.posix.dirname(item.path);if(seen.get(parent==='.'?'':parent.toLowerCase())?.kind!=='directory')throw Error('Build inventory parent missing');}
 return [...seen.values()].sort(order);
}
export async function plainBuildAncestors(value:string){let current=path.resolve(value);for(;;){if((await lstat(current)).isSymbolicLink())throw Error('Build cleanup ancestor reparse rejected');const parent=path.dirname(current);if(parent===current)break;current=parent;}}
function identity(relative:string,info:BigIntStats):EntryIdentity{return {path:relative,dev:info.dev.toString(),ino:info.ino.toString()};}
function fileMetadata(relative:string,info:BigIntStats){return {...identity(relative,info),kind:'file' as const,bytes:info.size.toString(),mtimeNs:info.mtimeNs.toString(),birthtimeNs:info.birthtimeNs.toString()};}
async function fileEntry(file:string,relative:string,info:BigIntStats):Promise<BuildTreeEntry>{
 if(!info.isFile()||info.isSymbolicLink())throw Error('Build inventory requires ordinary files');
 const before=fileMetadata(relative,info),sha256=await fileHash(file),after=await lstat(file,{bigint:true});
 if(!after.isFile()||after.isSymbolicLink()||!isDeepStrictEqual(before,fileMetadata(relative,after)))throw Error('Build inventory file changed during hashing');
 return {...before,sha256};
}
export async function captureBuildTree(root:string,excludeReceipt=false):Promise<BuildTreeEntry[]>{
 await plainBuildAncestors(root);const result:BuildTreeEntry[]=[];
 async function visit(file:string,relative:string){if(result.length>=100000)throw Error('Build inventory is too large');const info=await lstat(file,{bigint:true});if(info.isSymbolicLink())throw Error('Build cleanup rejects reparse entries');
  if(info.isDirectory()){result.push({...identity(relative,info),kind:'directory'});for(const name of (await readdir(file)).sort()){if(!relative&&excludeReceipt&&name==='build-receipt.json')continue;await visit(path.join(file,name),relative?relative+'/'+name:name);}}
  else result.push(await fileEntry(file,relative,info));
 }
 await visit(root,'');return buildInventory(result);
}
export async function removeRecordedBuildTree(root:string,expected:BuildTreeEntry[],receipt?:{path:string;sha256:string}){
 const inventory=buildInventory(expected),actual=await captureBuildTree(root,!!receipt);
 if(!isDeepStrictEqual(actual,inventory))throw Error('Build inventory changed; unrecorded or modified content is preserved');
 // Never recursively remove a directory: additions after verification remain.
 for(const entry of inventory.filter(item=>item.kind==='file')){const file=path.join(root,...entry.path.split('/'));await plainBuildAncestors(file);const current=await fileEntry(file,entry.path,await lstat(file,{bigint:true}));if(!isDeepStrictEqual(current,entry))throw Error('Build file changed before removal; remaining content is preserved');await unlink(file);}
 for(const entry of inventory.filter(item=>item.kind==='directory').sort((a,b)=>b.path.split('/').length-a.path.split('/').length||-order(a,b))){
  const directory=entry.path?path.join(root,...entry.path.split('/')):root;await plainBuildAncestors(directory);const info=await lstat(directory,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink()||!isDeepStrictEqual({...identity(entry.path,info),kind:'directory'},entry))throw Error('Build directory identity changed before removal');
  if(!entry.path&&receipt){if(path.resolve(receipt.path)!==path.join(path.resolve(root),'build-receipt.json')||await fileHash(receipt.path)!==receipt.sha256)throw Error('Build receipt changed before removal');await unlink(receipt.path);}
  await rmdir(directory);
 }
}
