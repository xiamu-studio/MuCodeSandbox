import path from 'node:path';
import {open,lstat,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import {z} from 'zod';
import type {Store} from '../../store.ts';
import {AppError} from '../../errors.ts';
import {run} from '../../process.ts';
import {powershellPath,powershellArgs} from './runtime.ts';
import {cleanWindowsEnvironment} from './broker.ts';
import {removeWindowsBackupWork,type BackupCleanupIdentity,type BackupCleanupEntry} from './backup-cleanup-native.ts';
import type {WindowsBackupCleanupIssue} from '../../../shared/windows-backup.ts';

const uuid=z.uuid().refine(value=>value===value.toLowerCase()&&value!=='00000000-0000-0000-0000-000000000000');
const decimal=z.string().regex(/^\d{1,24}$/),digest=z.string().regex(/^[a-f0-9]{64}$/);
const identity=z.object({path:z.string().max(4096),dev:decimal,ino:decimal,birthtimeNs:decimal}).strict();
const fileClaim=identity.extend({kind:z.literal('file'),bytes:decimal.optional(),mtimeNs:decimal.optional(),sha256:digest.optional()}).strict();
const directoryClaim=identity.extend({kind:z.literal('directory')}).strict();
const claim=z.discriminatedUnion('kind',[directoryClaim,fileClaim]);
const entry=z.discriminatedUnion('kind',[directoryClaim,fileClaim.required()]);
const record=z.object({format:z.literal(1),kind:z.enum(['windows-backup-restore-work','windows-backup-export-work','windows-snapshot-identity-work']),id:uuid,root:z.string().max(4096),directory:z.string().max(4096),ancestors:z.array(identity).min(1).max(64),storeAncestors:z.array(identity).min(1).max(64),owner:z.object({pid:z.number().int().positive(),started:decimal}).strict(),createdAt:z.string().datetime(),phase:z.enum(['active','blocked','sealed']),claims:z.array(claim).min(1).max(32),entries:z.array(entry).min(1).max(32).optional()}).strict();
type CleanupRecord=z.infer<typeof record>;
interface Reference {value:CleanupRecord;cipher:string}
export interface WindowsBackupCleanupItem extends WindowsBackupCleanupIssue {id:string;retryable:boolean}
export interface OwnedBackupWriter {write(bytes:Uint8Array):Promise<void>;sync():Promise<void>;close():Promise<void>}
export interface OwnedBackupWork {open(relative:string):Promise<OwnedBackupWriter>;write(relative:string,bytes:Uint8Array):Promise<void>;mkdir(relative:string):Promise<void>;close():Promise<void>}
const active=new Set<string>(),deleting=new Set<string>();
const pending=()=>new AppError('临时资料尚未通过安全清理核验，原目录与索引已保留',409,'BACKUP_CLEANUP_PENDING');
const indexFailure='备份或快照临时资料索引无法安全读取，已保留原记录，请检查原工作区和数据目录。';
const canonical=(value:string)=>path.resolve(value).toLowerCase();
const same=(a:BackupCleanupIdentity,b:BackupCleanupIdentity)=>a.dev===b.dev&&a.ino===b.ino&&a.birthtimeNs===b.birthtimeNs;
function facts(file:string,stat:BigIntStats):BackupCleanupIdentity {
 if(stat.isSymbolicLink()||stat.ino===0n||stat.birthtimeNs<=0n)throw pending();
 return {path:file,dev:stat.dev.toString(),ino:stat.ino.toString(),birthtimeNs:stat.birthtimeNs.toString()};
}
async function ancestors(folder:string){const result:BackupCleanupIdentity[]=[];for(let cursor=path.resolve(folder);;cursor=path.dirname(cursor)){const info=await lstat(cursor,{bigint:true});if(!info.isDirectory())throw pending();result.push(facts(cursor,info));if(path.dirname(cursor)===cursor)break;}if(result.length>64)throw pending();return result;}
function relativePath(value:string){
 const result=value.replaceAll('\\','/');if(!result||result.length>256||/[\x00-\x1f<>:"|?*]/.test(result)||result.startsWith('/')||result.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)))throw pending();
 const parts=result.split('/'),leaves=['backup-restore.json','management','management.pub','host-ed25519','host-ed25519.pub','known_hosts','seed.iso','allocation.json'];
 if(parts.length===1&&(['disk.vhdx','management-check','host-check'].includes(result)||/^mu-win-[a-f0-9]{32}$/.test(result)))return result;
 if(parts.length===2&&/^mu-win-[a-f0-9]{32}$/.test(parts[0])&&leaves.includes(parts[1]))return result;
 throw pending();
}
async function ownerStart(pid:number):Promise<string|null>{
 const script=`$ErrorActionPreference='Stop';try{$p=[Diagnostics.Process]::GetProcessById(${pid});[Console]::Write($p.StartTime.ToUniversalTime().Ticks.ToString())}catch [ArgumentException]{[Console]::Write('missing')}`;
 const value=(await run(powershellPath(),powershellArgs(script),{env:cleanWindowsEnvironment(),timeoutMs:10000,maxBytes:2048})).trim();
 if(value==='missing')return null;return decimal.parse(value);
}
function issue(value:CleanupRecord):WindowsBackupCleanupItem{return{id:value.id,directory:value.directory,message:value.phase==='sealed'?'临时资料尚未确认清理，可能仍有明文磁盘或管理资料；原创建清单已保留，可在关闭原操作后重新核验。':'临时资料尚未完成可信清单核验，不能自动删除；可能仍有明文磁盘或管理资料。',sensitiveDataMayRemain:true,retryable:value.phase==='sealed'};}

// Only explicit backup/snapshot producers register a freshly created empty work directory.
// Old prefix directories, including earlier snapshot workspaces, are never auto-adopted.
export class WindowsBackupCleanupRegistry {
 readonly store:Store;readonly root:string;private indexIssue:string|null=null;
 constructor(store:Store,runtimeRoot:string){this.store=store;this.root=path.resolve(runtimeRoot);if(!/^[a-z]:\\/i.test(this.root))throw pending();store.db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS windows_backup_cleanup(id TEXT PRIMARY KEY,payload TEXT NOT NULL);');}
 get issue(){return this.indexIssue;}
 private key(id:string){return canonical(this.root)+'\0'+id;}
 private checked(value:unknown,id:string):CleanupRecord {
  const parsed=record.parse(value);uuid.parse(id);if(parsed.id!==id||canonical(parsed.root)!==canonical(this.root)||canonical(parsed.directory)!==canonical(path.join(this.root,'backup-work-'+id)))throw pending();
  const paths=new Set<string>();for(const item of parsed.claims){if(item.path)relativePath(item.path);if(paths.has(item.path.toLowerCase()))throw pending();paths.add(item.path.toLowerCase());}
  if(parsed.claims[0].path!==''||parsed.claims[0].kind!=='directory')throw pending();
  if(parsed.kind!=='windows-backup-restore-work'&&parsed.claims.some(item=>item.path&&!['management-check','host-check'].includes(item.path)))throw pending();
  if(parsed.phase==='sealed'&&!parsed.entries)throw pending();
  if(parsed.entries){const expected=new Map(parsed.claims.map(item=>[item.path,item]));const seen=new Set<string>();for(const item of parsed.entries){const original=expected.get(item.path);if(!original||item.kind!==original.kind||!same(item,original)||seen.has(item.path.toLowerCase()))throw pending();seen.add(item.path.toLowerCase());if(item.kind==='file'&&(original.kind!=='file'||item.bytes!==original.bytes||item.mtimeNs!==original.mtimeNs||item.sha256!==original.sha256))throw pending();}if(!parsed.entries.some(item=>item.path===''&&item.kind==='directory'))throw pending();}
  const checkedChain=(items:BackupCleanupIdentity[],base:string)=>{const expected:string[]=[];for(let cursor=path.resolve(base);;cursor=path.dirname(cursor)){expected.push(cursor);if(path.dirname(cursor)===cursor)break;}if(items.length!==expected.length)throw pending();for(let i=0;i<items.length;i++){const selected=items[i].path;if(!path.isAbsolute(selected)||path.resolve(selected)!==selected||canonical(selected)!==canonical(expected[i]))throw pending();}};
  if(path.resolve(parsed.root)!==parsed.root||path.resolve(parsed.directory)!==parsed.directory)throw pending();checkedChain(parsed.ancestors,this.root);checkedChain(parsed.storeAncestors,this.store.dataDir);return parsed;
 }
 private read():Reference[]{
  this.indexIssue=null;const result:Reference[]=[];
  try{const rows=this.store.db.prepare('SELECT id, CASE WHEN length(payload) BETWEEN 1 AND 1048576 THEN payload ELSE NULL END AS payload FROM windows_backup_cleanup LIMIT 65').all() as {id:string;payload:string|null}[];if(rows.length>64)throw pending();for(const row of rows){try{if(!row.payload?.startsWith('enc:'))throw pending();const plain=this.store.decrypt(row.payload);if(Buffer.byteLength(plain)>750000)throw pending();result.push({value:this.checked(JSON.parse(plain),row.id),cipher:row.payload});}catch{this.indexIssue=indexFailure;}}}catch{this.indexIssue=indexFailure;}
  return result;
 }
 issues():WindowsBackupCleanupItem[]{try{return this.read().filter(item=>item.value.phase!=='active'||!active.has(this.key(item.value.id))).map(item=>issue(item.value));}catch{this.indexIssue=indexFailure;return[];}}
 snapshotIssues():WindowsBackupCleanupItem[]{try{return this.read().filter(item=>item.value.kind==='windows-snapshot-identity-work'&&(item.value.phase!=='active'||!active.has(this.key(item.value.id)))).map(item=>issue(item.value));}catch{this.indexIssue=indexFailure;return[];}}
 private save(ref:Reference,initial=false){
  const value=this.checked(ref.value,ref.value.id),plain=JSON.stringify(value);if(Buffer.byteLength(plain)>750000)throw pending();const cipher=this.store.encrypt(plain);if(cipher.length>1048576)throw pending();
  const result=initial?this.store.db.prepare('INSERT INTO windows_backup_cleanup VALUES(?,?)').run(value.id,cipher):this.store.db.prepare('UPDATE windows_backup_cleanup SET payload=? WHERE id=? AND payload=?').run(cipher,value.id,ref.cipher);
  if(result.changes!==1)throw pending();ref.cipher=cipher;
 }
 private async bound(ref:Reference){
  const storeDirectory=await lstat(path.resolve(this.store.dataDir),{bigint:true});if(!storeDirectory.isDirectory()||!same(ref.value.storeAncestors[0],facts(this.store.dataDir,storeDirectory)))throw pending();
  for(const expected of [...ref.value.ancestors,...ref.value.storeAncestors]){const actual=await lstat(expected.path,{bigint:true});if(!actual.isDirectory()||!same(expected,facts(expected.path,actual)))throw pending();}
  const current=this.read().find(item=>item.value.id===ref.value.id);if(this.indexIssue||!current||current.cipher!==ref.cipher)throw pending();
 }
 private async idle(ref:Reference){
  if(active.has(this.key(ref.value.id)))throw pending();const current=await ownerStart(ref.value.owner.pid);
  if(current!==null&&current===ref.value.owner.started&&ref.value.owner.pid!==process.pid)throw pending();
  if(ref.value.owner.pid===process.pid&&current!==ref.value.owner.started)throw pending();
 }
 private async remove(ref:Reference,signal?:AbortSignal){
  signal?.throwIfAborted();await this.bound(ref);await this.idle(ref);if(ref.value.phase!=='sealed'||!ref.value.entries)throw pending();signal?.throwIfAborted();
  await removeWindowsBackupWork({root:this.root,directory:ref.value.directory,ancestors:ref.value.ancestors,entries:ref.value.entries as BackupCleanupEntry[]},signal);
  signal?.throwIfAborted();await this.bound(ref);const result=this.store.db.prepare('DELETE FROM windows_backup_cleanup WHERE id=? AND payload=?').run(ref.value.id,ref.cipher);if(result.changes!==1)throw pending();
 }
 async retry(id:string,signal?:AbortSignal){
  uuid.parse(id);signal?.throwIfAborted();const refs=this.read(),ref=refs.find(item=>item.value.id===id);if(this.indexIssue||!ref)throw pending();const key=this.key(id);if(deleting.has(key))throw pending();deleting.add(key);try{await this.remove(ref,signal);}finally{deleting.delete(key);}
 }
 async begin(directory:string,operation:'restore'|'export'|'snapshot-identity'='restore'):Promise<OwnedBackupWork>{
  if(!['restore','export','snapshot-identity'].includes(operation))throw pending();
  const existing=this.read();if(this.indexIssue||existing.length>=64)throw pending();const selected=path.resolve(directory),id=path.basename(selected).replace(/^backup-work-/,'');uuid.parse(id);if(canonical(path.dirname(selected))!==canonical(this.root)||path.basename(selected)!=='backup-work-'+id||existing.some(item=>item.value.id===id))throw pending();
  const parent=await ancestors(this.root),storeAncestors=await ancestors(this.store.dataDir),stat=await lstat(selected,{bigint:true});if(!stat.isDirectory()||(await readdir(selected)).length)throw pending();const rootClaim={...facts('',stat),kind:'directory' as const};const started=await ownerStart(process.pid);if(!started)throw pending();
  const kind=operation==='restore'?'windows-backup-restore-work':operation==='export'?'windows-backup-export-work':'windows-snapshot-identity-work';
  const ref:Reference={cipher:'',value:{format:1,kind,id,root:this.root,directory:selected,ancestors:parent,storeAncestors,owner:{pid:process.pid,started},createdAt:new Date().toISOString(),phase:'active',claims:[rootClaim]}};this.save(ref,true);
  const key=this.key(id),writers=new Set<object>();active.add(key);let finished=false,removed=false;
  const current=async()=>{if(finished)throw pending();await this.bound(ref);const actual=await lstat(selected,{bigint:true});if(!actual.isDirectory()||!same(rootClaim,facts('',actual)))throw pending();};
  const parents=async(relative:string)=>{await current();const pieces=relative.split('/');pieces.pop();let prefix='';for(const part of pieces){prefix=prefix?prefix+'/'+part:part;const expected=ref.value.claims.find(item=>item.path===prefix&&item.kind==='directory');if(!expected)throw pending();const info=await lstat(path.join(selected,...prefix.split('/')),{bigint:true});if(!info.isDirectory()||!same(expected,facts(prefix,info)))throw pending();}};
  const opened=async(relative:string):Promise<OwnedBackupWriter>=>{
   const name=relativePath(relative);if(/^mu-win-[a-f0-9]{32}$/.test(name)||operation!=='restore'&&!['management-check','host-check'].includes(name))throw pending();await parents(name);if(ref.value.claims.some(item=>item.path.toLowerCase()===name.toLowerCase())||ref.value.claims.length>=32)throw pending();
   const file=path.join(selected,...name.split('/')),handle=await open(file,'wx+');let original:BackupCleanupIdentity;
   try{const created=await handle.stat({bigint:true});original=facts(name,created);if(!created.isFile()||created.nlink!==1n)throw pending();ref.value.claims.push({...original,kind:'file'});this.save(ref);}catch(error){await handle.close().catch(()=>{});throw error;}
   const marker={};writers.add(marker);const hash=createHash('sha256');let bytes=0n,closed=false,broken=false,chain=Promise.resolve();
   const enqueue=(work:()=>Promise<void>)=>{const task=chain.then(work);chain=task.catch(()=>{});return task;};
   return {
    write:(input:Uint8Array)=>{const owned=Buffer.from(input);return enqueue(async()=>{try{if(closed||broken)throw pending();await current();let offset=0;while(offset<owned.length){const result=await handle.write(owned,offset,owned.length-offset);if(result.bytesWritten<1)throw pending();hash.update(owned.subarray(offset,offset+result.bytesWritten));bytes+=BigInt(result.bytesWritten);offset+=result.bytesWritten;}}catch(error){broken=true;throw error;}finally{owned.fill(0);}});},
    sync:()=>enqueue(async()=>{if(closed)throw pending();await handle.sync();}),
    close:()=>enqueue(async()=>{if(closed)return;let last:BigIntStats|undefined,failure:unknown;try{last=await handle.stat({bigint:true});}catch(error){failure=error;}try{await handle.close();}catch(error){failure??=error;}finally{closed=true;writers.delete(marker);}if(failure)throw failure;if(broken||!last?.isFile()||last.nlink!==1n||!same(original,facts(name,last))||last.size!==bytes)throw pending();const value=ref.value.claims.find(item=>item.path===name);if(!value||value.kind!=='file')throw pending();Object.assign(value,{bytes:bytes.toString(),mtimeNs:last.mtimeNs.toString(),sha256:hash.digest('hex')});this.save(ref);})
   };
  };
  const seal=async()=>{
   await current();if(writers.size)throw pending();const expected=new Map(ref.value.claims.map(item=>[item.path,item])),entries:BackupCleanupEntry[]=[];
   const visit=async(file:string,relative:string)=>{const original=expected.get(relative);if(!original)throw pending();const before=await lstat(file,{bigint:true}),actual=facts(relative,before);if(!same(original,actual)||before.isDirectory()!==(original.kind==='directory'))throw pending();
    if(original.kind==='directory'){entries.push({...actual,kind:'directory'});for(const name of await readdir(file))await visit(path.join(file,name),relative?relative+'/'+name:name);}
    else{if(!before.isFile()||before.nlink!==1n||!original.sha256||!original.bytes||!original.mtimeNs||before.size.toString()!==original.bytes||before.mtimeNs.toString()!==original.mtimeNs)throw pending();const fd=await open(file,'r');try{const opened=await fd.stat({bigint:true});if(!same(actual,facts(relative,opened))||opened.nlink!==1n)throw pending();const digest=createHash('sha256');for await(const chunk of fd.createReadStream({autoClose:false}))digest.update(chunk);const after=await fd.stat({bigint:true});if(!same(actual,facts(relative,after))||after.size!==before.size||after.mtimeNs!==before.mtimeNs||digest.digest('hex')!==original.sha256)throw pending();}finally{await fd.close();}entries.push({...actual,kind:'file',bytes:original.bytes,mtimeNs:original.mtimeNs,sha256:original.sha256});}
   };
   await visit(selected,'');ref.value.entries=entries.sort((a,b)=>a.path.localeCompare(b.path));ref.value.phase='sealed';this.save(ref);
  };
  return {
   open:opened,
   write:async(relative,bytes)=>{const writer=await opened(relative);let failed=false;try{await writer.write(bytes);await writer.sync();}catch(error){failed=true;throw error;}finally{try{await writer.close();}catch(error){if(!failed)throw error;}}},
   mkdir:async(relative)=>{const name=relativePath(relative);if(operation!=='restore'||!/^mu-win-[a-f0-9]{32}$/.test(name))throw pending();await parents(name);if(ref.value.claims.some(item=>item.path===name)||ref.value.claims.length>=32)throw pending();const {mkdir}=await import('node:fs/promises');const file=path.join(selected,name);await mkdir(file);const info=await lstat(file,{bigint:true});if(!info.isDirectory())throw pending();ref.value.claims.push({...facts(name,info),kind:'directory'});this.save(ref);},
   close:async()=>{if(removed)return;if(finished){await this.retry(id);removed=true;return;}try{if(ref.value.phase!=='sealed')await seal();finished=true;active.delete(key);await this.retry(id);removed=true;}catch(error){if(!writers.size){finished=true;active.delete(key);}if(ref.value.phase!=='sealed'){ref.value.phase='blocked';try{this.save(ref);}catch{/* A failed index update never grants cleanup authority. */}}throw error;}}
  };
 }
}
