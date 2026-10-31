import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm,lstat,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';import {Store} from '../server/store.ts';import {environmentSchema} from '../server/validation.ts';import {windowsPaths,vmIdentity} from '../server/platform/windows/config.ts';import {run} from '../server/process.ts';import type {Environment} from '../shared/types.ts';
import {spawn} from 'node:child_process';
import {WindowsBackupCleanupRegistry} from '../server/platform/windows/backup-cleanup.ts';
import {WindowsBackupService} from '../server/platform/windows/backup-service.ts';
import {WindowsSnapshotProduct,type WindowsSnapshotCoordinatorPort} from '../server/platform/windows/snapshot-product.ts';
import type {WindowsManager} from '../server/platform/windows/manager.ts';
import type {HyperVBrokerClient} from '../server/platform/windows/broker.ts';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
import {cleanWindowsEnvironment} from '../server/platform/windows/broker.ts';
async function fixture(){const root=await mkdtemp(path.join(tmpdir(),'mu-snapshot-owner-')),id=randomUUID(),p=windowsPaths(root,id);await mkdir(p.directory);const keygen=path.join(process.env.SystemRoot??'C:/Windows','System32/OpenSSH/ssh-keygen.exe');for(const file of [p.key,p.hostKey])await run(keygen,['-q','-t','ed25519','-N','','-C','synthetic-snapshot-owner','-f',file]);const pub=await readFile(p.key+'.pub','utf8'),host=await readFile(p.hostKey+'.pub','utf8'),seed=Buffer.alloc(49152);Buffer.from('CD001').copy(seed,32769);Buffer.from(pub+'\n'+host).copy(seed,40000);await writeFile(p.seed,seed);await writeFile(p.knownHosts,vmIdentity(id).name+' '+host);const platformId=randomUUID(),imageSha256='a'.repeat(64);await writeFile(p.manifest,JSON.stringify({version:1,id,platformId,imageSha256,purpose:'environment'}));await writeFile(path.join(p.directory,'allocation.json'),JSON.stringify({version:1,id,backend:'hyperv-broker'}));const store=new Store(path.join(root,'store'),Buffer.alloc(32,13)),now=new Date().toISOString(),e:Environment={...environmentSchema.parse({name:'完整快照配置',network:{mode:'http',host:'127.0.0.1',port:7897,password:'SYNTHETIC_OWNER_PASSWORD',strict:true,transparent:true,egressLock:{expectedIp:'198.51.100.25'}},cpus:2,memoryGiB:2,diskGiB:32}),id,instanceName:vmIdentity(id).name,state:'stopped',browserRunning:false,lastError:null,createdAt:now,updatedAt:now};store.save(e);const binding={id,platformId,cpus:e.cpus,memoryGiB:e.memoryGiB,diskGiB:e.diskGiB,imageSha256,seedSha256:createHash('sha256').update(seed).digest('hex'),seedBytes:seed.length};return{root,p,e,seed,store,binding,close:async()=>{store.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}};}
test('Snapshot owner encryption round-trips complete configuration and original management identity without putting seed bytes into the envelope',{skip:process.platform!=='win32'},async()=>{
 const {WindowsSnapshotOwnerCodec}=await import('../server/platform/windows/snapshot-owner.ts');const f=await fixture();try{const codec=new WindowsSnapshotOwnerCodec(f.store,f.root),captured=await codec.capture(f.e),owner=codec.decode(captured.ownerConfiguration,f.binding);assert.equal(owner.config.network.password,'SYNTHETIC_OWNER_PASSWORD');assert.equal(owner.identity.managementPrivate,await readFile(f.p.key,'utf8'));assert.equal(owner.identity.hostPrivate,await readFile(f.p.hostKey,'utf8'));assert.equal(owner.identity.knownHosts,await readFile(f.p.knownHosts,'utf8'));assert.equal(captured.seedSha256,f.binding.seedSha256);assert.equal(captured.ownerConfiguration.includes('SYNTHETIC_OWNER_PASSWORD'),false);assert.equal('seed' in owner.identity,false);await codec.validateSeed(owner,f.seed);assert.deepEqual((await codec.files(owner,f.seed)).map(v=>v.name),['management','management.pub','host-ed25519','host-ed25519.pub','known_hosts','seed.iso','manifest.json','allocation.json']);}finally{await f.close();}
});

test('Snapshot owners with long original public-key comments retain every identity byte instead of being truncated to the old small envelope',{skip:process.platform!=='win32'},async()=>{
 const {WindowsSnapshotOwnerCodec}=await import('../server/platform/windows/snapshot-owner.ts');const f=await fixture();try{
  const comment='原始管理身份'.repeat(2600),pub=(await readFile(f.p.key+'.pub','utf8')).trim().split(/\s+/).slice(0,2).join(' '),host=(await readFile(f.p.hostKey+'.pub','utf8')).trim().split(/\s+/).slice(0,2).join(' ');for(const [file,text] of [[f.p.key+'.pub',pub+' '+comment+'\n'],[f.p.hostKey+'.pub',host+' '+comment+'\n'],[f.p.knownHosts,vmIdentity(f.e.id).name+' '+host+' '+comment+'\n']])await writeFile(file,text);
  const codec=new WindowsSnapshotOwnerCodec(f.store,f.root),captured=await codec.capture(f.e);assert.ok(captured.ownerConfiguration.length>65536);const decoded=codec.decode(captured.ownerConfiguration,f.binding);assert.equal(decoded.identity.managementPublic,await readFile(f.p.key+'.pub','utf8'));assert.equal(decoded.identity.knownHosts,await readFile(f.p.knownHosts,'utf8'));
 }finally{await f.close();}
});

test('Wrong owner keys, tampered ciphertext, foreign native bindings, altered seeds and extra fields cannot replay a snapshot owner',{skip:process.platform!=='win32'},async()=>{
 const {WindowsSnapshotOwnerCodec}=await import('../server/platform/windows/snapshot-owner.ts');const f=await fixture();try{const codec=new WindowsSnapshotOwnerCodec(f.store,f.root),captured=await codec.capture(f.e),owner=codec.decode(captured.ownerConfiguration,f.binding);
  for(const change of [{id:randomUUID()},{platformId:randomUUID()},{cpus:4},{memoryGiB:4},{diskGiB:64},{imageSha256:'b'.repeat(64)},{seedSha256:'b'.repeat(64)},{seedBytes:f.seed.length+1}])assert.throws(()=>codec.decode(captured.ownerConfiguration,{...f.binding,...change}),{code:'SNAPSHOT_OWNER'});
  const other=new Store(path.join(f.root,'other-owner-store'),Buffer.alloc(32,24));try{assert.throws(()=>new WindowsSnapshotOwnerCodec(other,f.root).decode(captured.ownerConfiguration,f.binding),{code:'SNAPSHOT_OWNER'});}finally{other.close();}
  const tampered=Buffer.from(captured.ownerConfiguration.slice(4),'base64');tampered[12]^=1;assert.throws(()=>codec.decode('enc:'+tampered.toString('base64'),f.binding),{code:'SNAPSHOT_OWNER'});tampered.fill(0);
  for(const changed of [{...owner,hostPath:'C:/synthetic-forbidden'},{...owner,identity:{...owner.identity,id:randomUUID()}},{...owner,manifest:JSON.stringify({version:1,id:owner.id,platformId:randomUUID(),imageSha256:owner.imageSha256,purpose:'environment'})}])assert.throws(()=>codec.decode(f.store.encrypt(JSON.stringify(changed)),f.binding),{code:'SNAPSHOT_OWNER'});
  const badSeed=Buffer.from(f.seed);badSeed[40000]^=1;await assert.rejects(codec.files(owner,badSeed),{code:'SNAPSHOT_OWNER'});badSeed.fill(0);
 }finally{await f.close();}
});

async function holdIdentity(file:string){
 const child=spawn(powershellPath(),powershellArgs("$ErrorActionPreference='Stop';$f=[IO.File]::Open('"+file.replaceAll("'","''")+"',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[Console]::WriteLine('LOCKED');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null}finally{$f.Dispose()}"),{env:cleanWindowsEnvironment(),windowsHide:true,stdio:['pipe','pipe','pipe']});
 try{await new Promise<void>((resolve,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(Error('Synthetic identity lock timeout: '+errors)),10000);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('LOCKED')){clearTimeout(timer);resolve();}});child.stderr.on('data',chunk=>errors+=chunk);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(Error('Synthetic identity lock exited: '+errors));});});}catch(error){child.kill('SIGKILL');throw error;}
 return async()=>{if(child.exitCode!==null||child.signalCode!==null)return;const ended=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.stdin.end('\n');await ended;};
}
function cleanupViews(store:Store,root:string){
 const manager={store,options:{runtimeRoot:root},snapshotExportIds:()=>[]} as unknown as WindowsManager,coordinator={store,root,journal:{pending:()=>[],has:()=>false}} as unknown as WindowsSnapshotCoordinatorPort;
 return {snapshots:new WindowsSnapshotProduct(manager,coordinator,{enabled:false,available:()=>false,recoveryAvailable:()=>false}).status(),backups:new WindowsBackupService(manager,{} as HyperVBrokerClient,()=>false).snapshot()};
}

test('Snapshot key-validation leftovers have durable encrypted ownership, retain the primary error and remain reviewable without active components',{skip:process.platform!=='win32',timeout:120000},async()=>{
 const {WindowsSnapshotOwnerCodec}=await import('../server/platform/windows/snapshot-owner.ts');
 for(const phase of ['capture','validate'] as const){const f=await fixture(),codec=new WindowsSnapshotOwnerCodec(f.store,f.root),original=WindowsBackupCleanupRegistry.prototype.begin;let release:(()=>Promise<void>)|undefined,directory='',writes=0;const originalKey=await readFile(f.p.key,'utf8');
  try{
   const owner=phase==='validate'?codec.decode((await codec.capture(f.e)).ownerConfiguration,f.binding):undefined;
   WindowsBackupCleanupRegistry.prototype.begin=async function(selected,operation){assert.equal(operation,'snapshot-identity');directory=selected;const work=await original.call(this,selected,operation);return {...work,write:async(name,bytes)=>{await work.write(name,bytes);writes++;if(name==='management-check')release=await holdIdentity(path.join(selected,name));}};};
   await assert.rejects(phase==='capture'?codec.captureState(f.e):codec.validateSeed(owner!,f.seed),{code:'SNAPSHOT_OWNER'});assert.equal(writes,1);assert.ok(directory);
   const id=path.basename(directory).slice('backup-work-'.length),row=f.store.db.prepare('SELECT payload FROM windows_backup_cleanup WHERE id=?').get(id) as {payload:string},record=JSON.parse(f.store.decrypt(row.payload));assert.equal(record.kind,'windows-snapshot-identity-work');assert.equal(record.phase,'sealed');assert.ok(row.payload.startsWith('enc:'));assert.equal(row.payload.includes(directory),false);assert.equal(row.payload.includes('PRIVATE KEY'),false);assert.equal(await readFile(path.join(directory,'management-check'),'utf8'),await readFile(f.p.key,'utf8'));
   const reopened=new Store(f.store.dataDir,Buffer.alloc(32,13));try{const views=cleanupViews(reopened,f.root);assert.equal(views.snapshots.recoveryAvailable,false);assert.equal(views.snapshots.cleanupIssues?.[0].id,id);assert.equal(views.backups.cleanupIssues?.[0].id,id);assert.equal(views.snapshots.cleanupIssues?.[0].retryable,true);assert.equal(views.snapshots.cleanupIssues?.[0].sensitiveDataMayRemain,true);await release!();release=undefined;await new WindowsBackupCleanupRegistry(reopened,f.root).retry(id);assert.deepEqual(new WindowsBackupCleanupRegistry(reopened,f.root).snapshotIssues(),[]);await assert.rejects(lstat(directory),{code:'ENOENT'});}finally{reopened.close();}
   assert.equal(await readFile(f.p.key,'utf8'),originalKey);
  }finally{WindowsBackupCleanupRegistry.prototype.begin=original;await release?.();await f.close();}
 }
 console.log(JSON.stringify({diagnostic:'windows-snapshot-identity-cleanup',phases:2,actualWindowsFileLocks:true,actualNativeCleanup:true,actualSqlite:true,actualAesGcm:true,actualDpapi:false,realVm:false,originalKeysPreserved:true,componentsInactive:true}));
});

test('A completed snapshot validation cannot report success while unknown workspace content prevents cleanup',{skip:process.platform!=='win32',timeout:120000},async()=>{
 const {WindowsSnapshotOwnerCodec}=await import('../server/platform/windows/snapshot-owner.ts');
 for(const phase of ['capture','validate'] as const){const f=await fixture(),codec=new WindowsSnapshotOwnerCodec(f.store,f.root),original=WindowsBackupCleanupRegistry.prototype.begin;let directory='';
  try{const owner=phase==='validate'?codec.decode((await codec.capture(f.e)).ownerConfiguration,f.binding):undefined;
   WindowsBackupCleanupRegistry.prototype.begin=async function(selected,operation){directory=selected;const work=await original.call(this,selected,operation);return {...work,close:async()=>{await writeFile(path.join(selected,'personal-sentinel.txt'),'unrelated synthetic content');await work.close();}};};
   await assert.rejects(phase==='capture'?codec.captureState(f.e):codec.validateSeed(owner!,f.seed),{code:'BACKUP_CLEANUP_PENDING'});assert.equal(await readFile(path.join(directory,'personal-sentinel.txt'),'utf8'),'unrelated synthetic content');const issue=new WindowsBackupCleanupRegistry(f.store,f.root).snapshotIssues()[0];assert.equal(issue.retryable,false);await assert.rejects(new WindowsBackupCleanupRegistry(f.store,f.root).retry(issue.id),{code:'BACKUP_CLEANUP_PENDING'});assert.equal(await readFile(path.join(directory,'personal-sentinel.txt'),'utf8'),'unrelated synthetic content');
  }finally{WindowsBackupCleanupRegistry.prototype.begin=original;await f.close();}
 }
});

test('Snapshot validation keeps its original cancellation or identity failure separate from an unsuccessful cleanup',{skip:process.platform!=='win32',timeout:120000},async()=>{
 const {WindowsSnapshotOwnerCodec}=await import('../server/platform/windows/snapshot-owner.ts');
 for(const mode of ['cancel','identity'] as const){const f=await fixture(),codec=new WindowsSnapshotOwnerCodec(f.store,f.root),original=WindowsBackupCleanupRegistry.prototype.begin,controller=new AbortController(),reason=new Error('synthetic original snapshot cancellation');let directory='';
  try{const owner=codec.decode((await codec.capture(f.e)).ownerConfiguration,f.binding),seed=Buffer.from(f.seed);if(mode==='identity')seed[40000]^=1;
   WindowsBackupCleanupRegistry.prototype.begin=async function(selected,operation){directory=selected;const work=await original.call(this,selected,operation);return {...work,write:async(name,bytes)=>{await work.write(name,bytes);if(mode==='cancel')controller.abort(reason);},close:async()=>{await writeFile(path.join(selected,'keep.txt'),'unrelated synthetic content');await work.close();}};};
   await assert.rejects(codec.validateSeed(owner,seed,{signal:controller.signal}),error=>mode==='cancel'?error===reason:(error as {code?:string}).code==='SNAPSHOT_OWNER');assert.ok(directory);assert.equal(new WindowsBackupCleanupRegistry(f.store,f.root).snapshotIssues()[0].retryable,false);assert.equal(await readFile(path.join(directory,'keep.txt'),'utf8'),'unrelated synthetic content');seed.fill(0);
  }finally{WindowsBackupCleanupRegistry.prototype.begin=original;await f.close();}
 }
});

test('An invalid sensitive-work index stops snapshot validation before any temporary private key is written',{skip:process.platform!=='win32'},async()=>{
 const {WindowsSnapshotOwnerCodec}=await import('../server/platform/windows/snapshot-owner.ts');const f=await fixture();
 try{const registry=new WindowsBackupCleanupRegistry(f.store,f.root),id=randomUUID();f.store.db.prepare('INSERT INTO windows_backup_cleanup VALUES(?,?)').run(id,'unreadable synthetic record');await assert.rejects(new WindowsSnapshotOwnerCodec(f.store,f.root).captureState(f.e),{code:'BACKUP_CLEANUP_PENDING'});const directories=(await readdir(f.root)).filter(name=>name.startsWith('backup-work-'));assert.equal(directories.length,1);assert.deepEqual(await readdir(path.join(f.root,directories[0])),[]);assert.equal((f.store.db.prepare('SELECT payload FROM windows_backup_cleanup WHERE id=?').get(id) as {payload:string}).payload,'unreadable synthetic record');registry.snapshotIssues();assert.match(registry.issue??'',/索引/);assert.ok(cleanupViews(f.store,f.root).snapshots.cleanupIndexIssue);}finally{await f.close();}
});
