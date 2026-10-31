import path from 'node:path';
import {open,lstat} from 'node:fs/promises';
import type {BigIntStats} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Store} from '../../store.ts';
import {AppError} from '../../errors.ts';
import {run} from '../../process.ts';
import {powershellPath,powershellArgs} from './runtime.ts';
import {cleanWindowsEnvironment} from './broker.ts';
import {operateWindowsBackupOutput,type BackupOutputIdentity,type BackupOutputEntry} from './backup-output-native.ts';

const uuid=z.uuid().refine(value=>value===value.toLowerCase()&&value!=='00000000-0000-0000-0000-000000000000');
const decimal=z.string().regex(/^\d{1,24}$/),digest=z.string().regex(/^[a-f0-9]{64}$/);
const identity=z.object({path:z.string().max(4096),dev:decimal,ino:decimal,birthtimeNs:decimal}).strict();
const entry=identity.extend({bytes:decimal,mtimeNs:decimal,sha256:digest}).strict();
const record=z.object({format:z.literal(1),kind:z.literal('windows-backup-encrypted-output'),id:uuid,target:z.string().max(4096),temporary:z.string().max(4096),ancestors:z.array(identity).min(1).max(64),storeAncestors:z.array(identity).min(1).max(64),owner:z.object({pid:z.number().int().positive(),started:decimal}).strict(),createdAt:z.string().datetime(),phase:z.enum(['active','blocked','sealed','published']),original:identity,entry:entry.optional()}).strict();
type OutputRecord=z.infer<typeof record>;
interface Reference {value:OutputRecord;cipher:string}
export interface WindowsBackupOutputIssue {id:string;path:string;message:string;encrypted:true;retryable:boolean}
export interface OwnedBackupOutput {temporary:string;target:string;write(bytes:Uint8Array):Promise<void>;sync():Promise<void>;close():Promise<void>;publish(signal?:AbortSignal):Promise<{published:true}>;cleanup(signal?:AbortSignal):Promise<void>}
const active=new Set<string>(),operating=new Set<string>();
const maxBytes=300n*1024n**3n;
const pending=()=>new AppError('加密输出临时文件尚未通过安全核验，原文件和记录已保留',409,'BACKUP_OUTPUT_PENDING');
const indexMessage='加密备份输出索引无法安全读写，原记录已保留；请核对保存位置与数据目录。';
const canonical=(value:string)=>path.resolve(value).toLowerCase();
const same=(a:BackupOutputIdentity,b:BackupOutputIdentity)=>a.dev===b.dev&&a.ino===b.ino&&a.birthtimeNs===b.birthtimeNs;
function facts(file:string,info:BigIntStats):BackupOutputIdentity {if(info.isSymbolicLink()||info.ino===0n||info.birthtimeNs<=0n)throw pending();return{path:file,dev:info.dev.toString(),ino:info.ino.toString(),birthtimeNs:info.birthtimeNs.toString()};}
function localFile(value:string){
 if(typeof value!=='string'||value.length>1024||! /^[a-z]:\\/i.test(value)||/[\x00-\x1f<>"|?*]/.test(value)||value.slice(2).includes(':')||path.resolve(value)!==value||value.slice(3).split('\\').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$|CLOCK\$)(?:\.|$)/i.test(part)))throw pending();return value;
}
async function ancestors(folder:string){const result:BackupOutputIdentity[]=[];for(let current=path.resolve(folder);;current=path.dirname(current)){const info=await lstat(current,{bigint:true});if(!info.isDirectory())throw pending();result.push(facts(current,info));if(path.dirname(current)===current)break;}if(result.length>64)throw pending();return result;}
function chain(items:BackupOutputIdentity[],folder:string){const expected:string[]=[];for(let current=path.resolve(folder);;current=path.dirname(current)){expected.push(current);if(path.dirname(current)===current)break;}if(items.length!==expected.length)throw pending();for(let i=0;i<items.length;i++)if(path.resolve(items[i].path)!==items[i].path||canonical(items[i].path)!==canonical(expected[i]))throw pending();}
async function ownerStart(pid:number){const value=(await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop';try{$p=[Diagnostics.Process]::GetProcessById(${pid});[Console]::Write($p.StartTime.ToUniversalTime().Ticks.ToString())}catch [ArgumentException]{[Console]::Write('missing')}`),{env:cleanWindowsEnvironment(),timeoutMs:10000,maxBytes:2048})).trim();return value==='missing'?null:decimal.parse(value);}
function warning(value:OutputRecord):WindowsBackupOutputIssue{return{id:value.id,path:value.temporary,encrypted:true,retryable:value.phase==='sealed'||value.phase==='published',message:value.phase==='published'?'加密备份已保存；输出临时文件记录尚未确认整理，目标文件将保留。':value.phase==='sealed'?'加密输出临时文件尚未确认清理；原创建凭据已保留，可关闭原操作后重新核验。':'加密输出临时文件未完成可信清单核验，不能自动删除；请保留原文件并核对。'};}

// A record is created from an exclusive original handle before any ciphertext
// is written. No prefix scan or post-failure file inventory grants authority.
export class WindowsBackupOutputRegistry {
 readonly store:Store;private indexIssue:string|null=null;private writeIssue:string|null=null;
 private readonly operate:typeof operateWindowsBackupOutput;
 private readonly volatile=new Map<string,WindowsBackupOutputIssue>();
 private readonly unindexed=new Set<string>();
 constructor(store:Store,operate:typeof operateWindowsBackupOutput=operateWindowsBackupOutput){this.store=store;this.operate=operate;store.db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS windows_backup_outputs(id TEXT PRIMARY KEY,payload TEXT NOT NULL);');}
 get issue(){return this.indexIssue??this.writeIssue;}
 private key(id:string){return canonical(this.store.dataDir)+'\0'+id;}
 private checked(raw:unknown,id:string):OutputRecord {
  const value=record.parse(raw);uuid.parse(id);if(value.id!==id)throw pending();localFile(value.target);localFile(value.temporary);if(!value.target.toLowerCase().endsWith('.mucwin')||path.dirname(value.temporary)!==path.dirname(value.target)||path.basename(value.temporary)!=='.mucwin-partial-'+id||value.original.path!==value.temporary)throw pending();
  chain(value.ancestors,path.dirname(value.target));chain(value.storeAncestors,this.store.dataDir);if(value.entry&&(value.entry.path!==value.temporary||!same(value.original,value.entry)||BigInt(value.entry.bytes)>maxBytes))throw pending();if(['sealed','published'].includes(value.phase)&&!value.entry)throw pending();return value;
 }
 private read():Reference[]{this.indexIssue=null;const result:Reference[]=[];try{const rows=this.store.db.prepare('SELECT id, CASE WHEN length(payload) BETWEEN 1 AND 131072 THEN payload ELSE NULL END AS payload FROM windows_backup_outputs LIMIT 65').all() as {id:string;payload:string|null}[];if(rows.length>64)throw pending();for(const row of rows){try{if(!row.payload||!/^enc:[A-Za-z0-9+/]+={0,2}$/.test(row.payload))throw pending();const encoded=row.payload.slice(4),decoded=Buffer.from(encoded,'base64');if(decoded.length<29||decoded.toString('base64')!==encoded)throw pending();const plain=this.store.decrypt(row.payload);if(Buffer.byteLength(plain)>90000)throw pending();result.push({value:this.checked(JSON.parse(plain),row.id),cipher:row.payload});}catch{this.indexIssue=indexMessage;}}}catch{this.indexIssue=indexMessage;}return result;}
 issues():WindowsBackupOutputIssue[]{try{const rows=this.read(),known=new Set(rows.map(ref=>ref.value.id)),result=new Map(rows.filter(ref=>!active.has(this.key(ref.value.id))).map(ref=>[ref.value.id,warning(ref.value)]));for(const [id,issue] of this.volatile){if(known.has(id)||this.unindexed.has(id)||this.indexIssue)result.set(id,{...issue});else this.volatile.delete(id);}if(!known.size&&!this.volatile.size&&!this.unindexed.size&&!this.indexIssue)this.writeIssue=null;return [...result.values()];}catch{this.indexIssue=indexMessage;return [...this.volatile.values()].map(issue=>({...issue}));}}
 private save(ref:Reference,initial=false){try{const value=this.checked(ref.value,ref.value.id),plain=JSON.stringify(value);if(Buffer.byteLength(plain)>90000)throw pending();const cipher=this.store.encrypt(plain);if(cipher.length>131072)throw pending();const result=initial?this.store.db.prepare('INSERT INTO windows_backup_outputs VALUES(?,?)').run(value.id,cipher):this.store.db.prepare('UPDATE windows_backup_outputs SET payload=? WHERE id=? AND payload=?').run(cipher,value.id,ref.cipher);if(result.changes!==1)throw pending();ref.cipher=cipher;this.writeIssue=null;}catch(error){this.writeIssue=indexMessage;throw error;}}
 private forget(ref:Reference){try{const result=this.store.db.prepare('DELETE FROM windows_backup_outputs WHERE id=? AND payload=?').run(ref.value.id,ref.cipher);if(result.changes!==1)throw pending();this.volatile.delete(ref.value.id);this.unindexed.delete(ref.value.id);this.writeIssue=null;}catch(error){this.writeIssue=indexMessage;throw error;}}
 private async bound(ref:Reference){const currentStore=await lstat(path.resolve(this.store.dataDir),{bigint:true});if(!currentStore.isDirectory()||!same(ref.value.storeAncestors[0],facts(this.store.dataDir,currentStore)))throw pending();for(const original of [...ref.value.ancestors,...ref.value.storeAncestors]){const info=await lstat(original.path,{bigint:true});if(!info.isDirectory()||!same(original,facts(original.path,info)))throw pending();}const current=this.read().find(item=>item.value.id===ref.value.id);if(this.indexIssue||!current||current.cipher!==ref.cipher)throw pending();}
 private async idle(ref:Reference){if(active.has(this.key(ref.value.id)))throw pending();const started=await ownerStart(ref.value.owner.pid);if(started!==null&&started===ref.value.owner.started&&ref.value.owner.pid!==process.pid||ref.value.owner.pid===process.pid&&started!==ref.value.owner.started)throw pending();}
 private input(ref:Reference){if(!ref.value.entry)throw pending();return{temporary:ref.value.temporary,target:ref.value.target,ancestors:ref.value.ancestors,entry:ref.value.entry as BackupOutputEntry};}
 async retry(id:string,signal?:AbortSignal){uuid.parse(id);signal?.throwIfAborted();const rows=this.read(),ref=rows.find(item=>item.value.id===id);if(this.indexIssue||!ref||!['sealed','published'].includes(ref.value.phase))throw pending();const key=this.key(id);if(operating.has(key))throw pending();operating.add(key);try{await this.bound(ref);await this.idle(ref);signal?.throwIfAborted();await this.operate(this.input(ref),'cleanup',signal);signal?.throwIfAborted();await this.bound(ref);this.forget(ref);}finally{operating.delete(key);}}
 async begin(target:string):Promise<OwnedBackupOutput>{
  localFile(target);if(!target.toLowerCase().endsWith('.mucwin'))throw pending();const existing=this.read();if(this.indexIssue||existing.length>=64)throw pending();
  await run(powershellPath(),powershellArgs("$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd();if([IO.DriveInfo]::new([IO.Path]::GetPathRoot($p)).DriveType -eq 'Network'){throw 'Local output required'};while($p){if([IO.File]::Exists($p) -or [IO.Directory]::Exists($p)){if([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint){throw 'Output ancestor reparse rejected'}};$p=[IO.Path]::GetDirectoryName($p)}"),{input:target,env:cleanWindowsEnvironment(),timeoutMs:10000});
  try{await lstat(target);throw new AppError('目标文件已存在，请选择新文件名',409,'BACKUP_EXISTS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const parent=await ancestors(path.dirname(target)),storeAncestors=await ancestors(this.store.dataDir),started=await ownerStart(process.pid);if(!started)throw pending();const id=randomUUID(),temporary=path.join(path.dirname(target),'.mucwin-partial-'+id),handle=await open(temporary,'wx+');
  let original:BackupOutputIdentity;try{const info=await handle.stat({bigint:true});original=facts(temporary,info);if(!info.isFile()||info.nlink!==1n)throw pending();}catch(error){await handle.close().catch(()=>{});throw error;}
  const ref:Reference={cipher:'',value:{format:1,kind:'windows-backup-encrypted-output',id,target,temporary,ancestors:parent,storeAncestors,owner:{pid:process.pid,started},createdAt:new Date().toISOString(),phase:'active',original}};
  try{this.save(ref,true);}catch(error){await handle.close().catch(()=>{});this.unindexed.add(id);this.volatile.set(id,warning({...ref.value,phase:'blocked'}));throw error;}
  const key=this.key(id);active.add(key);let closed=false,broken=false,sealed=false,published=false,removed=false,chainTask=Promise.resolve();let bytes=0n;const hash=createHash('sha256');
  const enqueue=(work:()=>Promise<void>)=>{const task=chainTask.then(work);chainTask=task.catch(()=>{});return task;};
  const current=async()=>{await this.bound(ref);const info=await lstat(temporary,{bigint:true});if(!info.isFile()||info.nlink!==1n||!same(original,facts(temporary,info)))throw pending();};
  const blocked=()=>{active.delete(key);if(ref.value.phase==='active'){ref.value.phase='blocked';try{this.save(ref);}catch{/* Never grant deletion authority after a failed receipt write. */}}};
  const finishPublished=():{published:true}=>{
   published=true;active.delete(key);ref.value.phase='published';
   // A committed file remains successful when only SQLite bookkeeping fails.
   try{this.save(ref);this.forget(ref);removed=true;}catch{this.volatile.set(id,warning(ref.value));}
   return{published:true};
  };
  const close=()=>enqueue(async()=>{if(closed)return;let last:BigIntStats|undefined,failure:unknown;try{last=await handle.stat({bigint:true});}catch(error){failure=error;}try{await handle.close();}catch(error){failure??=error;}finally{closed=true;}
   // A failed write/sync may still leave exactly the successful prefix. Seal
   // only that producer hash for cleanup; broken continues to forbid publish.
   // Extra bytes are never adopted, and native cleanup rechecks the full hash.
   if(failure||!last?.isFile()||last.nlink!==1n||!same(original,facts(temporary,last))||last.size!==bytes){blocked();throw failure??pending();}
   ref.value.entry={...original,bytes:bytes.toString(),mtimeNs:last.mtimeNs.toString(),sha256:hash.digest('hex')};ref.value.phase='sealed';try{await current();this.save(ref);sealed=true;}catch(error){blocked();throw error;}
  });
  return{temporary,target,
   write:(input:Uint8Array)=>{const owned=Buffer.from(input);return enqueue(async()=>{try{if(closed||broken||bytes+BigInt(owned.length)>maxBytes)throw pending();await current();let offset=0;while(offset<owned.length){const result=await handle.write(owned,offset,owned.length-offset);if(result.bytesWritten<1)throw pending();hash.update(owned.subarray(offset,offset+result.bytesWritten));bytes+=BigInt(result.bytesWritten);offset+=result.bytesWritten;}}catch(error){broken=true;throw error;}finally{owned.fill(0);}});},
   sync:()=>enqueue(async()=>{if(closed||broken)throw pending();try{await handle.sync();}catch(error){broken=true;throw error;}}),close,
   publish:async(signal)=>{if(published)return{published:true};await chainTask;if(broken||!closed||!sealed||ref.value.phase!=='sealed'||removed)throw pending();if(operating.has(key))throw pending();operating.add(key);try{
    await this.bound(ref);signal?.throwIfAborted();
    try{const result=await this.operate(this.input(ref),'publish',signal);if(!('published' in result)||!result.published)throw pending();return finishPublished();}
    catch(error){try{const checked=await this.operate(this.input(ref),'check-published');if('published' in checked&&checked.published)return finishPublished();}catch{/* Uncertain state is retained; never guess that the target is ours. */}throw error;}
   }finally{operating.delete(key);active.delete(key);}},
   cleanup:async(signal)=>{if(removed)return;if(!closed){try{await close();}catch(error){blocked();throw error;}}active.delete(key);
    if(published){try{await this.bound(ref);await this.operate(this.input(ref),'cleanup');this.forget(ref);removed=true;}catch{this.volatile.set(id,warning({...ref.value,phase:'published'}));}return;}
    try{await this.retry(id,signal);removed=true;}catch(error){blocked();throw error;}
   }
  };
 }
}
