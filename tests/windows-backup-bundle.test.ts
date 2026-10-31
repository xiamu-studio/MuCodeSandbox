import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,lstat,rm,rename,utimes} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {watch,mkdirSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openWindowsStore} from '../server/platform/windows/credentials.ts';
import {windowsPaths,windowsConfigSchema} from '../server/platform/windows/config.ts';
import {windowsEnvironment} from '../server/platform/windows/guest.ts';
import {HyperVRuntime,powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
import type {HyperVBrokerClient,BrokerAction} from '../server/platform/windows/broker.ts';
import {exportWindowsBackup,restoreWindowsBackup,WindowsBackupExportCleanupError,windowsRestoreSpaceWindow} from '../server/platform/windows/backup-bundle.ts';
import {readWindowsBackupArchive,windowsBackupManifest,type RestorableWindowsBackupManifest} from '../server/platform/windows/backup-archive.ts';
import {run} from '../server/process.ts';
import {WindowsManager,type WindowsBackend} from '../server/platform/windows/manager.ts';
import {WindowsBackupService} from '../server/platform/windows/backup-service.ts';
import {environmentSchema} from '../server/validation.ts';
import {AppError} from '../server/errors.ts';
const password='synthetic-restorable-backup-password';
test('Restore space checks reserve bounded batches and retry failed checks',async()=>{
 const checks:number[]=[];let fail=false;const reserve=windowsRestoreSpaceWindow(async bytes=>{checks.push(bytes);if(fail)throw new AppError('synthetic full disk',409,'RESOURCE_DISK');});
 for(let i=0;i<4;i++)await reserve(1024*1024,(6-i)*1024*1024);
 assert.deepEqual(checks,[4*1024*1024]);fail=true;await assert.rejects(reserve(1024*1024,2*1024*1024),{code:'RESOURCE_DISK'});
 fail=false;await reserve(1024*1024,2*1024*1024);await reserve(1024*1024,1024*1024);assert.deepEqual(checks,[4*1024*1024,2*1024*1024,2*1024*1024]);
 await assert.rejects(reserve(1,0),{code:'WINDOWS_BACKUP_INTEGRITY'});
});
async function* input(bytes:Buffer){for(let i=0;i<bytes.length;i+=137)yield bytes.subarray(i,i+137);}
async function holdTemporaryDisk(file:string,directory=false){
 const opening=directory?`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;public static class MuFixtureDirectoryHold{[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);}';$handle=[MuFixtureDirectoryHold]::CreateFile($file,2147483648,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero);if($handle.IsInvalid){throw 'Synthetic directory handle could not be opened'}`:"$handle=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)";
 const script="$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$file=[Console]::In.ReadLine();"+opening+";try{[Console]::Out.WriteLine('LOCKED');[Console]::Out.Flush();[Console]::In.ReadLine()|Out-Null}finally{$handle.Dispose()}";
 const child=spawn(powershellPath(),powershellArgs(script),{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let details='';child.stderr.on('data',data=>{details=(details+data).slice(-1024);});child.stdin.on('error',()=>{});
 const ended=new Promise<number|null>(resolve=>child.once('close',resolve));
 const watchdog=setTimeout(()=>child.kill(),15000);watchdog.unref();child.once('close',()=>clearTimeout(watchdog));
 let released=false;const release=async()=>{if(released)return;released=true;child.stdin.end('\n');let timeout:ReturnType<typeof setTimeout>|undefined;try{const code=await Promise.race([ended,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{child.kill();reject(Error('Synthetic file-lock helper did not release'));},5000);})]);assert.equal(code,0,details);}finally{clearTimeout(timeout);child.kill();await ended;}};
 try{await new Promise<void>((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('Synthetic file-lock helper did not pin staging')),10000);const finish=(error?:Error)=>{clearTimeout(timeout);if(error)reject(error);else resolve();};child.once('error',finish);child.once('close',()=>finish(Error('Synthetic file-lock helper exited before release: '+details)));child.stdout.on('data',data=>{output+=data;if(output.includes('LOCKED'))finish();});child.stdin.write(file+'\n');});}
 catch(error){await release().catch(()=>{});throw error;}
 return release;
}
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'mu-backup-bundle-')),runtimeRoot=path.join(root,'source-runtime'),restoreRoot=path.join(root,'restore-runtime'),id=randomUUID(),platformId=randomUUID(),session=randomUUID(),disk=Buffer.alloc(65539,91),seed=Buffer.alloc(49152);
 Buffer.from('CD001').copy(seed,32769);const config=windowsConfigSchema.parse({version:1,id,image:path.join(root,'base.vhdx'),imageSha256:'a'.repeat(64),cpus:1,memoryGiB:2,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:9,username:'synthetic',password:'synthetic-private-proxy-password'},expectedIp:'203.0.113.90'});
 const original={...windowsEnvironment(config),name:'合成加密恢复环境',browserUrl:'http://127.0.0.1/'},p=windowsPaths(runtimeRoot,id);await mkdir(p.directory,{recursive:true});
 const keygen=path.join(process.env.SystemRoot??'C:\\Windows','System32/OpenSSH/ssh-keygen.exe');for(const key of [p.key,p.hostKey])await run(keygen,['-q','-t','ed25519','-N','','-f',key]);
 const managementPublic=await readFile(p.key+'.pub','utf8'),hostPublic=await readFile(p.hostKey+'.pub','utf8');Buffer.from(managementPublic+'\n'+hostPublic).copy(seed,40000);await writeFile(p.knownHosts,original.instanceName+' '+hostPublic.trim()+'\n');await writeFile(p.manifest,JSON.stringify({version:1,id,platformId,imageSha256:config.imageSha256,purpose:'environment'}));
 const sourceStore=await openWindowsStore(path.join(root,'source-store')),restoreStore=await openWindowsStore(path.join(root,'restore-store'));sourceStore.save(original);
 const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex'),info={id,session,bytes:disk.length,sha256:hash(disk),seed:{bytes:seed.length,sha256:hash(seed)},chunkBytes:32768,platformId,imageSha256:config.imageSha256,cpus:config.cpus,memoryGiB:config.memoryGiB,diskGiB:config.diskGiB,diskIdentifier:id,state:'Off'};
 let allocation:{registered:boolean;backupRestorePending?:boolean;platformId?:string}={registered:false},imports=0,fail:'none'|'pending'|'lost'='none';const actions:BrokerAction[]=[],servers:ReturnType<typeof createServer>[]=[];
 const client={call:async(action:BrokerAction,args:Record<string,unknown>={})=>{
  actions.push(action);if(action==='backup-begin')return info;if(action==='backup-close')return {closed:true};if(action==='allocation')return allocation;if(action==='absence')return {absent:!allocation.registered};
  if(action==='backup-seed'){const start=Number(args.offset),end=Math.min(start+32768,seed.length);return {data:seed.subarray(start,end).toString('base64'),nextOffset:end,done:end===seed.length};}
  if(action==='backup-stream'){const pipeName='MuCodeSandbox-Backup-'+randomUUID().replaceAll('-',''),server=createServer(socket=>{socket.on('error',()=>{});socket.once('data',()=>socket.write(disk));});servers.push(server);await new Promise<void>(resolve=>server.listen('\\\\.\\pipe\\'+pipeName,resolve));return {pipeName};}
  if(action==='backup-import'){
   imports++;assert.deepEqual(await readFile(String(args.disk)),disk);assert.deepEqual(await readFile(String(args.seed)),seed);assert.equal(args.diskSha256,info.sha256);assert.equal(args.seedSha256,info.seed.sha256);
   if(fail==='pending'){allocation={registered:true,backupRestorePending:true};throw Object.assign(Error('synthetic copy interrupted'),{code:'BROKER_FAILED'});}
   allocation={registered:true,platformId};if(fail==='lost')throw Object.assign(Error('synthetic reply lost'),{code:'BROKER_UNAVAILABLE'});
   return {restored:true,id,platformId,state:'Off',diskSha256:info.sha256};
  }
  throw Error('Unexpected operation '+action);
 }} as HyperVBrokerClient;
 const archive=async()=>{const chunks:Buffer[]=[];await exportWindowsBackup(client,runtimeRoot,sourceStore.get(id),{write:async bytes=>{chunks.push(Buffer.from(bytes));}},password);return Buffer.concat(chunks);};
 const managers:WindowsManager[]=[],managedStores=new Set();
 const manage=(source=false)=>{const store=source?sourceStore:restoreStore;assert.ok(!managedStores.has(store));managedStores.add(store);const manager=new WindowsManager(store,{state:async()=>({state:'Off'}),stop:async()=>{}} as unknown as WindowsBackend,{runtimeRoot:source?runtimeRoot:restoreRoot});managers.push(manager);return manager;};
 return {root,id,config,p,client,sourceStore,restoreStore,restoreRoot,original,disk,seed,actions,info,archive,manage,imports:()=>imports,fail:(value:typeof fail)=>{fail=value;},conflict:()=>{allocation={registered:true,platformId};},privateFiles:async()=>{try{return (await readdir(restoreRoot)).filter(name=>name.startsWith('backup-work-'));}catch{return[];}},close:async()=>{for(const manager of managers)await manager.close();if(!managedStores.has(sourceStore))sourceStore.close();if(!managedStores.has(restoreStore))restoreStore.close();sourceStore.key.fill(0);restoreStore.key.fill(0);await Promise.all(servers.map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));const target=path.resolve(root);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.match(path.basename(target),/^mu-backup-bundle-/);await rm(target,{recursive:true,force:true});}};
}
test('Restorable Windows archive carries exact original identity and restores credentials using a new DPAPI-backed store',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture();try{const encrypted=await f.archive(),output:Buffer[]=[],manifest=await readWindowsBackupArchive(input(encrypted),{write:async bytes=>{output.push(Buffer.from(bytes));}},password) as RestorableWindowsBackupManifest;
  assert.equal(manifest.version,2);assert.equal(manifest.identity.managementPrivate,await readFile(f.p.key,'utf8'));assert.deepEqual(Buffer.from(manifest.identity.seed.base64,'base64'),f.seed);assert.deepEqual(Buffer.concat(output),f.disk);assert.equal(encrypted.includes(Buffer.from('synthetic-private-proxy-password')),false);assert.equal(encrypted.includes(Buffer.from('BEGIN OPENSSH PRIVATE KEY')),false);
  const restored=await restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password);assert.equal(restored.id,f.id);assert.equal(restored.state,'stopped');assert.equal(restored.network.password,undefined);assert.equal(restored.network.passwordConfigured,true);assert.equal(f.restoreStore.get(f.id).network.password,'synthetic-private-proxy-password');assert.notDeepEqual(f.sourceStore.key,f.restoreStore.key);
  const source=f.sourceStore.db.prepare('SELECT config FROM environments WHERE id=?').get(f.id) as {config:string},target=f.restoreStore.db.prepare('SELECT config FROM environments WHERE id=?').get(f.id) as {config:string};assert.ok(!target.config.includes('synthetic-private-proxy-password'));assert.throws(()=>f.sourceStore.decrypt(JSON.parse(target.config).network.password));assert.notEqual(JSON.parse(source.config).network.password,JSON.parse(target.config).network.password);
  assert.deepEqual(await f.privateFiles(),[]);assert.equal(f.imports(),1);assert.equal(f.actions.includes('start'),false);assert.equal(f.actions.includes('delete'),false);assert.deepEqual(await readFile(windowsPaths(f.restoreRoot,f.id).key),await readFile(f.p.key));
 }finally{await f.close();}
});
test('Restored display name survives an interruption and cannot change during resume',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture();try{const encrypted=await f.archive(),name='恢复后的环境',marker=path.join(windowsPaths(f.restoreRoot,f.id).directory,'backup-restore.json');
  f.fail('pending');await assert.rejects(restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password,{restoreName:name}));
  const before=await readFile(marker,'utf8');assert.equal(JSON.parse(before).restoreName,name);assert.equal(f.restoreStore.get(f.id).name,name);assert.equal(f.imports(),1);
  f.fail('none');await assert.rejects(restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password,{restoreName:'另一个名称'}),{code:'RESTORE_CONFLICT'});assert.equal(await readFile(marker,'utf8'),before);assert.equal(f.imports(),1);
  const restored=await restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password,{restoreName:name});assert.equal(restored.id,f.id);assert.equal(restored.name,name);assert.equal(restored.state,'stopped');assert.equal(f.imports(),2);await assert.rejects(readFile(marker),{code:'ENOENT'});
 }finally{await f.close();}
});
test('Export preserves unexpected staging files when no cleanup registry is supplied',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture();let unexpected='';try{
  const root=path.dirname(f.p.directory);
  await assert.rejects(exportWindowsBackup(f.client,root,f.sourceStore.get(f.id),{write:async()=>{
   if(unexpected)return;
   const names=(await readdir(root)).filter(name=>name.startsWith('backup-work-'));assert.equal(names.length,1);
   unexpected=path.join(root,names[0],'unrelated.txt');await writeFile(unexpected,'preserve unrelated data',{flag:'wx'});
  }},password),error=>error instanceof WindowsBackupExportCleanupError);
  assert.equal(await readFile(unexpected,'utf8'),'preserve unrelated data');
 }finally{await f.close();}
});
test('A newly published restore management directory already contains its complete recovery identity',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture();let watcher:ReturnType<typeof watch>|undefined;
 try{const encrypted=await f.archive(),p=windowsPaths(f.restoreRoot,f.id);await mkdir(f.restoreRoot,{recursive:true});let seen=false,resolve!:(files:string[])=>void,reject!:(error:unknown)=>void;
  const firstAppearance=new Promise<string[]>((yes,no)=>{resolve=yes;reject=no;});
  watcher=watch(f.restoreRoot,(event,name)=>{if(event==='rename'&&String(name)===path.basename(p.directory)&&!seen){seen=true;void readdir(p.directory).then(resolve,reject);}});
  const publication=firstAppearance.then(files=>files.sort());
  await restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password);
  assert.deepEqual(await publication,['backup-restore.json','allocation.json',...['key','hostKey','knownHosts','seed'].map(key=>path.basename(p[key as 'key'|'hostKey'|'knownHosts'|'seed'])),path.basename(p.key)+'.pub',path.basename(p.hostKey)+'.pub'].sort());
  assert.equal(f.restoreStore.get(f.id).state,'stopped');assert.equal(f.imports(),1);
 }finally{watcher?.close();await f.close();}
});

test('A destination appearing after restore preflight is preserved without publishing or importing',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture();let watcher:ReturnType<typeof watch>|undefined;
 try{const encrypted=await f.archive(),p=windowsPaths(f.restoreRoot,f.id);await mkdir(f.restoreRoot,{recursive:true});let injected=false;
  watcher=watch(f.restoreRoot,{recursive:true},(_event,name)=>{const relative=String(name).replaceAll('\\','/');if(!injected&&relative.startsWith('backup-work-')&&relative.endsWith('/'+path.basename(p.directory)+'/allocation.json')){injected=true;mkdirSync(p.directory);writeFileSync(path.join(p.directory,'preserve.txt'),'unrelated destination created during restore',{flag:'wx'});}});
  await assert.rejects(restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password),{code:'RESTORE_CONFLICT'});
  assert.equal(injected,true);assert.deepEqual(await readdir(p.directory),['preserve.txt']);assert.equal(await readFile(path.join(p.directory,'preserve.txt'),'utf8'),'unrelated destination created during restore');assert.equal(f.imports(),0);assert.deepEqual(f.restoreStore.list(),[]);assert.deepEqual(await f.privateFiles(),[]);
 }finally{watcher?.close();await f.close();}
});

test('Cancellation during metadata staging leaves no incomplete published directory and the same archive can retry',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture();let watcher:ReturnType<typeof watch>|undefined;
 try{const encrypted=await f.archive(),p=windowsPaths(f.restoreRoot,f.id),controller=new AbortController();await mkdir(f.restoreRoot,{recursive:true});
  watcher=watch(f.restoreRoot,{recursive:true},(_event,name)=>{const relative=String(name).replaceAll('\\','/');if(relative.startsWith('backup-work-')&&relative.endsWith('/'+path.basename(p.directory)+'/allocation.json'))controller.abort();});
  await assert.rejects(restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password,{signal:controller.signal}));watcher.close();watcher=undefined;
  assert.equal(controller.signal.aborted,true);assert.equal(f.imports(),0);await assert.rejects(readFile(path.join(p.directory,'backup-restore.json')),{code:'ENOENT'});assert.deepEqual(await f.privateFiles(),[]);
  const restored=await restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password);assert.equal(restored.state,'stopped');assert.equal(f.imports(),1);
 }finally{watcher?.close();await f.close();}
});

test('The same archive recovers published management files even when the environment record was never saved',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture();const save=f.restoreStore.save.bind(f.restoreStore);
 try{const encrypted=await f.archive(),p=windowsPaths(f.restoreRoot,f.id);f.restoreStore.save=()=>{throw Error('Synthetic interruption before saving the environment record');};
  await assert.rejects(restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password),/Synthetic interruption/);assert.deepEqual(f.restoreStore.list(),[]);assert.equal(f.imports(),0);assert.ok((await readFile(path.join(p.directory,'backup-restore.json'),'utf8')).includes(f.id));await assert.rejects(readFile(p.manifest),{code:'ENOENT'});assert.deepEqual(await f.privateFiles(),[]);
  f.restoreStore.save=save;const restored=await restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password);assert.equal(restored.id,f.id);assert.equal(restored.state,'stopped');assert.equal(f.imports(),1);await assert.rejects(readFile(path.join(p.directory,'backup-restore.json')),{code:'ENOENT'});
 }finally{f.restoreStore.save=save;await f.close();}
});

test('A failed restored-environment read retains the resume marker and can retry without reimporting',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),originalPublic=f.restoreStore.public.bind(f.restoreStore);
 try{
  const encrypted=await f.archive(),p=windowsPaths(f.restoreRoot,f.id);
  f.restoreStore.public=()=>{throw Error('Synthetic restored-environment read failure');};
  await assert.rejects(restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password),/Synthetic restored-environment read failure/);
  assert.equal(f.imports(),1);assert.equal(f.restoreStore.get(f.id).state,'error');
  assert.ok((await readFile(path.join(p.directory,'backup-restore.json'),'utf8')).includes(f.id));
  f.restoreStore.public=originalPublic;
  const restored=await restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password);
  assert.equal(restored.state,'stopped');assert.equal(f.imports(),1);
  await assert.rejects(readFile(path.join(p.directory,'backup-restore.json')),{code:'ENOENT'});
 }finally{f.restoreStore.public=originalPublic;await f.close();}
});

test('Wrong passwords, final corruption and existing registrations never publish a restore or leave plaintext staging',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture();try{const encrypted=await f.archive();await assert.rejects(restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),'wrong-synthetic-password'),{code:'WINDOWS_BACKUP_INTEGRITY'});const damaged=Buffer.from(encrypted);damaged[damaged.length-1]^=1;await assert.rejects(restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(damaged),password),{code:'WINDOWS_BACKUP_INTEGRITY'});assert.equal(f.imports(),0);assert.equal(f.restoreStore.list().length,0);assert.deepEqual(await f.privateFiles(),[]);
  f.conflict();await assert.rejects(restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password),{code:'RESTORE_CONFLICT'});await assert.rejects(restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password,{restoreName:'新名称不能绕过身份冲突'}),{code:'RESTORE_CONFLICT'});assert.equal(f.imports(),0);assert.equal(f.restoreStore.list().length,0);assert.deepEqual(await f.privateFiles(),[]);
 }finally{await f.close();}
});
for(const failure of ['pending','lost'] as const)test('An interrupted restore resumes without replacement after '+failure,{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture();try{const encrypted=await f.archive();f.fail(failure);await assert.rejects(restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password));assert.equal(f.restoreStore.get(f.id).state,'error');assert.ok((await readFile(path.join(windowsPaths(f.restoreRoot,f.id).directory,'backup-restore.json'),'utf8')).includes(f.id));
  const runtime=new HyperVRuntime(f.restoreRoot,undefined,f.client);await assert.rejects(runtime.start(f.config),{code:'RESTORE_PENDING'});await assert.rejects(runtime.create(f.config),{code:'RESTORE_PENDING'});await assert.rejects(runtime.recoverCreation(f.config),{code:'RESTORE_PENDING'});await assert.rejects(runtime.growDisk(f.config,64),{code:'RESTORE_PENDING'});await assert.rejects(runtime.prepareDiskCompaction(f.config),{code:'RESTORE_PENDING'});
  f.fail('none');const done=await restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password);assert.equal(done.state,'stopped');assert.equal(f.imports(),failure==='pending'?2:1);assert.deepEqual(await f.privateFiles(),[]);
 }finally{await f.close();}
});
test('A primary import failure survives a secondary error-state database failure with the original pending identity retained',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),call=f.client.call.bind(f.client),state=f.restoreStore.state.bind(f.restoreStore),cause={phase:'synthetic-backup-import'},primary=Object.assign(new Error('Synthetic primary import failure',{cause}),{code:'SYNTHETIC_BACKUP_IMPORT_FAILED'}),secondary=Object.assign(new Error('Synthetic error-state database failure'),{code:'SQLITE_SYNTHETIC_STATE_WRITE'});
 primary.name='SyntheticBackupImportError';secondary.name='SyntheticStateUpdateError';let imports=0,stateWrites=0,pendingBefore:Buffer|undefined,keyBefore:Buffer|undefined;
 try{
  const encrypted=await f.archive(),p=windowsPaths(f.restoreRoot,f.id);
  f.client.call=async(action,args={},options)=>{if(action==='backup-import'){imports++;assert.deepEqual(await readFile(String(args.disk)),f.disk);pendingBefore=await readFile(path.join(p.directory,'backup-restore.json'));keyBefore=await readFile(p.key);throw primary;}return call(action,args,options);};
  f.restoreStore.state=(environmentId,next,message)=>{if(next==='error'){stateWrites++;throw secondary;}return state(environmentId,next,message);};
  let observed:unknown;try{await restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,input(encrypted),password);}catch(error){observed=error;}
  assert.equal(imports,1);assert.equal(stateWrites,1);assert.ok(pendingBefore);assert.ok(keyBefore);assert.deepEqual(await readFile(path.join(p.directory,'backup-restore.json')),pendingBefore);assert.deepEqual(await readFile(p.key),keyBefore);assert.deepEqual(await readFile(p.key),await readFile(f.p.key));assert.deepEqual(await readFile(p.hostKey),await readFile(f.p.hostKey));assert.deepEqual(await readFile(p.seed),f.seed);await assert.rejects(readFile(p.manifest),{code:'ENOENT'});assert.deepEqual(await f.privateFiles(),[]);
  assert.equal(observed,primary);assert.equal(primary.name,'SyntheticBackupImportError');assert.equal(primary.code,'SYNTHETIC_BACKUP_IMPORT_FAILED');assert.equal(primary.cause,cause);
 }finally{f.client.call=call;f.restoreStore.state=state;await f.close();}
});

test('Backup refuses a mismatched management public/private pair before emitting an archive',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture();try{await writeFile(f.p.key+'.pub',await readFile(f.p.hostKey+'.pub'));let output=0;await assert.rejects(exportWindowsBackup(f.client,path.dirname(f.p.directory),f.sourceStore.get(f.id),{write:async bytes=>{output+=bytes.length;}},password),{code:'BACKUP_IDENTITY'});assert.equal(output,0);assert.ok(f.actions.includes('backup-close'));}finally{await f.close();}
});
test('A network-form staging path is refused before file access or native backup operations',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture();try{await assert.rejects(exportWindowsBackup(f.client,'\\\\invalid-synthetic-host\\share',f.original,{write:async()=>{}},password),{code:'BACKUP_PATH'});assert.equal(f.actions.length,0);}finally{await f.close();}
});

test('Product backup reviews authenticate fully, expose no secrets, consume one review and restore only after name confirmation',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),manager=f.manage(),service=new WindowsBackupService(manager,f.client);try{
  const file=path.join(f.root,'review.mucwin');await writeFile(file,await f.archive());
  const reviewJob=service.review(file,password);
  await assert.rejects(manager.create({}),{code:'BACKUP_BUSY'});assert.throws(()=>service.review(file,password),{code:'BACKUP_BUSY'});
  await manager.wait(reviewJob.id);assert.equal(service.snapshot().phase,'succeeded');assert.equal(f.imports(),0);assert.equal(f.restoreStore.list().length,0);
  const review=service.snapshot().review!;assert.equal(review.name,f.original.name);assert.ok(!JSON.stringify(service.snapshot()).includes(password));assert.ok(!JSON.stringify(service.snapshot()).includes('synthetic-private-proxy-password'));
  assert.throws(()=>service.restore(review.token,'wrong'),{code:'BACKUP_CONFIRMATION'});const job=service.restore(review.token,review.name);assert.throws(()=>service.restore(review.token,review.name),{code:'BACKUP_REVIEW_EXPIRED'});await manager.wait(job.id);
  assert.equal(service.snapshot().phase,'succeeded');assert.equal(f.restoreStore.get(f.id).state,'stopped');assert.equal(f.imports(),1);assert.equal(service.snapshot().bytes,f.disk.length);assert.deepEqual(await f.privateFiles(),[]);
 }finally{service.close();await f.close();}
});
test('Product review recalls the name of the same interrupted restore',{skip:process.platform!=='win32',timeout:45000},async()=>{
 const f=await fixture(),manager=f.manage(),service=new WindowsBackupService(manager,f.client);try{
  const file=path.join(f.root,'resume-name.mucwin');await writeFile(file,await f.archive());await manager.wait(service.review(file,password).id);
  let review=service.snapshot().review!;assert.equal(review.resumeName,undefined);f.fail('pending');await manager.wait(service.restore(review.token,review.name,'自定义恢复名称').id);assert.equal(service.snapshot().phase,'failed');
  f.fail('none');await manager.wait(service.review(file,password).id);review=service.snapshot().review!;assert.equal(review.resumeName,'自定义恢复名称');
  await manager.wait(service.restore(review.token,review.name).id);assert.equal(service.snapshot().phase,'succeeded');assert.equal(f.restoreStore.get(f.id).name,'自定义恢复名称');assert.equal(f.imports(),2);
 }finally{service.close();await f.close();}
});
test('Product review refuses wrong passwords, changed files and discarded approvals without importing',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),manager=f.manage(),service=new WindowsBackupService(manager,f.client);try{
  const file=path.join(f.root,'review.mucwin'),encrypted=await f.archive();await writeFile(file,encrypted);
  await manager.wait(service.review(file,'wrong-synthetic-password').id);assert.equal(service.snapshot().phase,'failed');assert.equal(service.snapshot().review,undefined);
  await manager.wait(service.review(file,password).id);const review=service.snapshot().review!;await writeFile(file,Buffer.concat([encrypted,Buffer.from([0])]));await manager.wait(service.restore(review.token,review.name).id);assert.equal(service.snapshot().phase,'failed');assert.equal(f.imports(),0);assert.equal(f.restoreStore.list().length,0);
  await writeFile(file,encrypted);await manager.wait(service.review(file,password).id);const token=service.snapshot().review!.token;service.discard();assert.throws(()=>service.restore(token,review.name),{code:'BACKUP_REVIEW_EXPIRED'});
 }finally{service.close();await f.close();}
});

test('Replacing a reviewed backup with equal bytes and restored modification time invalidates the approval',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),manager=f.manage(),service=new WindowsBackupService(manager,f.client);
 try{
  const file=path.join(f.root,'review-replaced.mucwin'),old=path.join(f.root,'review-original.mucwin'),encrypted=await f.archive();await writeFile(file,encrypted);
  await manager.wait(service.review(file,password).id);const review=service.snapshot().review!;assert.ok(review);const original=await lstat(file);
  await rename(file,old);await writeFile(file,encrypted);await utimes(file,original.atime,original.mtime);const replacement=await lstat(file);
  assert.equal(replacement.size,original.size);assert.notEqual(replacement.ino,original.ino);
  await manager.wait(service.restore(review.token,review.name).id);
  assert.equal(service.snapshot().phase,'failed');assert.match(service.snapshot().message,/文件已变化/);assert.equal(f.imports(),0);assert.deepEqual(f.restoreStore.list(),[]);assert.deepEqual(await readFile(old),encrypted);assert.deepEqual(await readFile(file),encrypted);
 }finally{service.close();await f.close();}
});

test('Rewriting the reviewed file with a different valid equal-size backup cannot reuse the approval',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),manager=f.manage(),service=new WindowsBackupService(manager,f.client);
 try{
  const first=await f.archive();f.sourceStore.save({...f.original,name:'合成加密恢复环界'});const other=await f.archive();assert.equal(first.length,other.length);
  const file=path.join(f.root,'review-rewritten.mucwin');await writeFile(file,first);const fixed=new Date('2025-01-01T00:00:00.000Z');await utimes(file,fixed,fixed);
  await manager.wait(service.review(file,password).id);const review=service.snapshot().review!;assert.ok(review);const original=await lstat(file);
  await writeFile(file,other);await utimes(file,fixed,fixed);const changed=await lstat(file);
  assert.equal(changed.ino,original.ino);assert.equal(changed.size,original.size);assert.equal(changed.mtimeMs,original.mtimeMs);
  await manager.wait(service.restore(review.token,review.name).id);
  assert.equal(service.snapshot().phase,'failed');assert.match(service.snapshot().message,/文件已变化/);assert.equal(f.imports(),0);assert.deepEqual(f.restoreStore.list(),[]);assert.deepEqual(await readFile(file),other);
 }finally{service.close();await f.close();}
});

test('A real post-commit staging cleanup fault retains committed success and independent cleanup warnings',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),manager=f.manage(),service=new WindowsBackupService(manager,f.client),call=f.client.call.bind(f.client);
 let releaseLock:(()=>Promise<void>)|undefined;
 f.client.call=async(action,args={},options)=>{const result=await call(action,args,options);if(action==='backup-import')releaseLock=await holdTemporaryDisk(String(args.disk));return result;};
 try{
  const file=path.join(f.root,'post-commit-cleanup.mucwin'),encrypted=await f.archive();await writeFile(file,encrypted);
  await manager.wait(service.review(file,password).id);const reviewed=service.snapshot().review!;
  const job=service.restore(reviewed.token,reviewed.name);await manager.wait(job.id);
  const p=windowsPaths(f.restoreRoot,f.id),manifest=await readFile(p.manifest),leftovers=await f.privateFiles();
  assert.equal(f.restoreStore.get(f.id).state,'stopped');await assert.rejects(readFile(path.join(p.directory,'backup-restore.json')),{code:'ENOENT'});
  assert.equal(f.imports(),1);assert.equal(leftovers.length,1);assert.equal(service.snapshot().phase,'succeeded');
  const completedJob=manager.store.jobs().find(row=>row.id===job.id)!;assert.equal(completedJob.status,'succeeded');assert.match(completedJob.message,/恢复已完成/);assert.match(completedJob.message,/清理/);assert.match(completedJob.message,/请勿重复恢复/);
  assert.match(service.snapshot().message,/请勿重复恢复/);const warnings=service.snapshot().cleanupIssues!;assert.equal(warnings.length,1);assert.equal(warnings[0].directory,path.join(f.restoreRoot,leftovers[0]));assert.equal(warnings[0].sensitiveDataMayRemain,true);assert.match(warnings[0].message,/明文|凭据|敏感/);
  assert.ok(manager.store.logs(null).some(row=>row.environmentId===null&&row.level==='error'&&row.message.includes(warnings[0].directory)&&/请勿重复恢复/.test(row.message)&&/清理/.test(row.message)));
  await releaseLock!();
  service.discard();assert.deepEqual(service.snapshot().cleanupIssues,warnings);
  await manager.wait(service.review(file,password).id);assert.deepEqual(service.snapshot().cleanupIssues,warnings);const retry=service.snapshot().review!;await manager.wait(service.restore(retry.token,retry.name).id);
  assert.equal(service.snapshot().phase,'failed');assert.match(service.snapshot().message,/已有环境或文件与备份冲突/);assert.equal(f.imports(),1);
  assert.deepEqual(service.snapshot().cleanupIssues,warnings);assert.equal(f.restoreStore.get(f.id).state,'stopped');assert.deepEqual(await readFile(p.manifest),manifest);assert.deepEqual(await readFile(file),encrypted);assert.deepEqual(await f.privateFiles(),leftovers);
  console.log(JSON.stringify({diagnostic:'post-commit-cleanup-fixed',realWindowsFileLock:true,realHyperVExercised:false,restoreCommitted:true,environmentState:'stopped',restoreMarkerRemoved:true,productPhaseAfterCommit:'succeeded',jobSucceeded:true,independentCleanupWarnings:1,warningSurvivedDiscardAndRetry:true,retryConflict:true,imports:f.imports(),retainedTemporaryDirectories:leftovers.length}));
 }finally{await releaseLock?.();f.client.call=call;service.close();await f.close();}
});

test('A committed restore cleanup warning survives a real DPAPI Store reopen and retry removes only its recorded staging directory',{skip:process.platform!=='win32',timeout:45000},async()=>{
 const f=await fixture(),manager=f.manage(),service=new WindowsBackupService(manager,f.client),call=f.client.call.bind(f.client);
 let releaseLock:(()=>Promise<void>)|undefined,reopenedManager:WindowsManager|undefined,reopenedService:WindowsBackupService|undefined;
 f.client.call=async(action,args={},options)=>{const result=await call(action,args,options);if(action==='backup-import')releaseLock=await holdTemporaryDisk(String(args.disk));return result;};
 try{
  const archive=await f.archive(),file=path.join(f.root,'reopen-cleanup.mucwin');await writeFile(file,archive);
  await manager.wait(service.review(file,password).id);const review=service.snapshot().review!;
  const restore=service.restore(review.token,review.name);await manager.wait(restore.id);
  assert.equal(service.snapshot().phase,'succeeded');assert.equal(manager.store.jobs().find(row=>row.id===restore.id)?.status,'succeeded');
  const issue=service.snapshot().cleanupIssues![0];assert.ok(issue.id);assert.equal(issue.retryable,true);assert.equal(service.snapshot().cleanupIssues!.length,1);
  const records=manager.store.db.prepare('SELECT id,payload FROM windows_backup_cleanup').all() as {id:string;payload:string}[];assert.equal(records.length,1);assert.equal(records[0].id,issue.id);assert.ok(records[0].payload.startsWith('enc:'));assert.equal(records[0].payload.includes(issue.directory),false);assert.equal(records[0].payload.includes('BEGIN OPENSSH PRIVATE KEY'),false);assert.equal(records[0].payload.includes(password),false);
  const p=windowsPaths(f.restoreRoot,f.id),manifest=await readFile(p.manifest),management=await readFile(p.key),staged=await readFile(path.join(issue.directory,'disk.vhdx'));
  assert.deepEqual(staged,f.disk);assert.equal(f.restoreStore.get(f.id).state,'stopped');assert.equal(f.imports(),1);
  await releaseLock!();service.close();await manager.close();
  const reopenedStore=await openWindowsStore(path.join(f.root,'restore-store'));
  reopenedManager=new WindowsManager(reopenedStore,{state:async()=>({state:'Off'}),stop:async()=>{}} as unknown as WindowsBackend,{runtimeRoot:f.restoreRoot});
  reopenedService=new WindowsBackupService(reopenedManager,f.client,()=>false);
  const resumed=reopenedService.snapshot();assert.equal(resumed.phase,'idle');assert.equal(resumed.cleanupIndexIssue,undefined);assert.equal(resumed.cleanupIssues!.length,1);
  assert.equal(resumed.cleanupIssues![0].id,issue.id);assert.equal(resumed.cleanupIssues![0].directory,issue.directory);assert.equal(resumed.cleanupIssues![0].retryable,true);
  assert.equal(reopenedStore.jobs().find(row=>row.id===restore.id)?.status,'succeeded');
  const actions=f.actions.length,cleanup=reopenedService.cleanup(issue.id);await reopenedManager.wait(cleanup.id);
  assert.equal(reopenedService.snapshot().phase,'succeeded');assert.match(reopenedService.snapshot().message,/核验.*清理/);assert.equal(reopenedService.snapshot().cleanupIssues,undefined);
  assert.equal(reopenedStore.jobs().find(row=>row.id===cleanup.id)?.status,'succeeded');await assert.rejects(lstat(issue.directory),{code:'ENOENT'});assert.deepEqual(await f.privateFiles(),[]);
  assert.equal(f.actions.length,actions);assert.equal(f.imports(),1);assert.equal(reopenedStore.get(f.id).state,'stopped');assert.deepEqual(await readFile(p.manifest),manifest);assert.deepEqual(await readFile(p.key),management);assert.deepEqual(await readFile(file),archive);
  console.log(JSON.stringify({diagnostic:'cleanup-reopen-and-safe-retry',realWindowsFileLock:true,realDpapiStoreReopen:true,realHyperVExercised:false,committedRestoreJobPreserved:true,cleanupSucceeded:true,brokerOperationsDuringCleanup:0,imports:f.imports(),environmentState:'stopped',originalArchiveUnchanged:true}));
 }finally{await releaseLock?.();f.client.call=call;service.close();reopenedService?.close();await reopenedManager?.close();await f.close();}
});

test('Cleanup retry rejects unknown ids and active work, and a queued cancellation retains the original receipt for retry',{skip:process.platform!=='win32',timeout:45000},async()=>{
 const f=await fixture(),manager=f.manage(),service=new WindowsBackupService(manager,f.client),call=f.client.call.bind(f.client);
 let releaseLock:(()=>Promise<void>)|undefined,releaseMaintenance:(()=>void)|undefined,maintenanceId:string|undefined;
 f.client.call=async(action,args={},options)=>{const result=await call(action,args,options);if(action==='backup-import')releaseLock=await holdTemporaryDisk(String(args.disk));return result;};
 try{
  const archive=await f.archive(),file=path.join(f.root,'cancel-cleanup.mucwin');await writeFile(file,archive);await manager.wait(service.review(file,password).id);const review=service.snapshot().review!;await manager.wait(service.restore(review.token,review.name).id);
  const issue=service.snapshot().cleanupIssues![0];assert.ok(issue.id);assert.equal(issue.retryable,true);await releaseLock!();
  const p=windowsPaths(f.restoreRoot,f.id),manifest=await readFile(p.manifest),stagedFile=path.join(issue.directory,'disk.vhdx'),staged=await readFile(stagedFile),identity=await lstat(stagedFile,{bigint:true}),before=f.actions.length,jobs=manager.store.jobs().length;
  assert.throws(()=>service.cleanup(randomUUID()),{code:'BACKUP_CLEANUP_UNVERIFIED'});assert.throws(()=>service.cleanup('../backup-work-untrusted'));assert.equal(manager.store.jobs().length,jobs);
  f.restoreStore.state(f.id,'running');assert.throws(()=>service.cleanup(issue.id!),{code:'ENVIRONMENT_BUSY'});f.restoreStore.state(f.id,'stopped');
  let entered!:()=>void;const began=new Promise<void>(resolve=>entered=resolve),maintenance=manager.runMaintenance('synthetic-cleanup-admission',async()=>{entered();await new Promise<void>(resolve=>releaseMaintenance=resolve);});maintenanceId=maintenance.id;await began;
  assert.throws(()=>service.cleanup(issue.id!),{code:'BACKUP_BUSY'});releaseMaintenance!();await manager.wait(maintenance.id);maintenanceId=undefined;
  const job=service.cleanup(issue.id);manager.cancel(job.id);await manager.wait(job.id);
  assert.equal(service.snapshot().phase,'cancelled');assert.equal(manager.store.jobs().find(row=>row.id===job.id)?.status,'cancelled');assert.equal(service.snapshot().cleanupIssues![0].id,issue.id);assert.equal(service.snapshot().cleanupIssues![0].retryable,true);
  const after=await lstat(stagedFile,{bigint:true});assert.equal(after.ino,identity.ino);assert.equal(after.dev,identity.dev);assert.equal(after.mtimeNs,identity.mtimeNs);assert.deepEqual(await readFile(stagedFile),staged);assert.equal(f.actions.length,before);assert.equal(f.imports(),1);
  await manager.wait(service.cleanup(issue.id).id);assert.equal(service.snapshot().phase,'succeeded');assert.equal(service.snapshot().cleanupIssues,undefined);assert.deepEqual(await f.privateFiles(),[]);assert.equal(f.actions.length,before);assert.equal(f.restoreStore.get(f.id).state,'stopped');assert.deepEqual(await readFile(p.manifest),manifest);assert.deepEqual(await readFile(file),archive);
 }finally{releaseMaintenance?.();if(maintenanceId)await manager.wait(maintenanceId);await releaseLock?.();f.client.call=call;service.close();await f.close();}
});

test('Product cleanup preserves an added unrecorded file and the sealed staging disk instead of adopting the changed tree',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),manager=f.manage(),service=new WindowsBackupService(manager,f.client),call=f.client.call.bind(f.client);
 let releaseLock:(()=>Promise<void>)|undefined;
 f.client.call=async(action,args={},options)=>{const result=await call(action,args,options);if(action==='backup-import')releaseLock=await holdTemporaryDisk(String(args.disk));return result;};
 try{
  const archive=await f.archive(),file=path.join(f.root,'changed-cleanup.mucwin');await writeFile(file,archive);await manager.wait(service.review(file,password).id);const review=service.snapshot().review!;await manager.wait(service.restore(review.token,review.name).id);
  const issue=service.snapshot().cleanupIssues![0];assert.ok(issue.id);assert.equal(issue.retryable,true);await releaseLock!();
  const extra=path.join(issue.directory,'unrecorded-synthetic.txt'),foreign='Synthetic file never produced by the restore';await writeFile(extra,foreign,{flag:'wx'});
  const disk=path.join(issue.directory,'disk.vhdx'),before=await readFile(disk),p=windowsPaths(f.restoreRoot,f.id),manifest=await readFile(p.manifest),actions=f.actions.length;
  const job=service.cleanup(issue.id);await manager.wait(job.id);
  assert.equal(service.snapshot().phase,'failed');assert.equal(manager.store.jobs().find(row=>row.id===job.id)?.status,'failed');assert.equal(service.snapshot().cleanupIssues![0].id,issue.id);assert.match(service.snapshot().message,/归属|变化/);
  assert.equal(await readFile(extra,'utf8'),foreign);assert.deepEqual(await readFile(disk),before);assert.deepEqual(await readFile(p.manifest),manifest);assert.deepEqual(await readFile(file),archive);assert.equal(f.restoreStore.get(f.id).state,'stopped');assert.equal(f.imports(),1);assert.equal(f.actions.length,actions);
 }finally{await releaseLock?.();f.client.call=call;service.close();await f.close();}
});

test('Committed cleanup remains available while VM snapshot admission and host readiness are fenced',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),manager=f.manage(),call=f.client.call.bind(f.client);let available=true;
 const service=new WindowsBackupService(manager,f.client,()=>available);let releaseLock:(()=>Promise<void>)|undefined;
 f.client.call=async(action,args={},options)=>{const result=await call(action,args,options);if(action==='backup-import')releaseLock=await holdTemporaryDisk(String(args.disk));return result;};
 try{
  const archive=await f.archive(),file=path.join(f.root,'snapshot-fenced-cleanup.mucwin');await writeFile(file,archive);await manager.wait(service.review(file,password).id);const review=service.snapshot().review!;await manager.wait(service.restore(review.token,review.name).id);
  assert.equal(service.snapshot().phase,'succeeded');const issue=service.snapshot().cleanupIssues![0];assert.ok(issue.id);assert.equal(issue.retryable,true);await releaseLock!();
  const p=windowsPaths(f.restoreRoot,f.id),manifest=await readFile(p.manifest),management=await readFile(p.key),before=f.actions.length;
  available=false;manager.snapshotAdmission={assertWritable:()=>{throw new AppError('Synthetic snapshot admission is not initialized',409,'SNAPSHOT_PENDING');},blocked:()=>true};
  const jobs=manager.store.jobs().length;assert.throws(()=>manager.runMaintenance('backup-export',async()=>{throw Error('VM backup work must remain fenced');}),{code:'SNAPSHOT_PENDING'});assert.equal(manager.store.jobs().length,jobs);
  const cleanup=service.cleanup(issue.id);await manager.wait(cleanup.id);
  assert.equal(cleanup.action,'backup-cleanup');assert.equal(service.snapshot().phase,'succeeded');assert.equal(manager.store.jobs().find(row=>row.id===cleanup.id)?.status,'succeeded');assert.equal(service.snapshot().cleanupIssues,undefined);await assert.rejects(lstat(issue.directory),{code:'ENOENT'});
  assert.equal(available,false);assert.throws(()=>manager.snapshotAdmission!.assertWritable(),{code:'SNAPSHOT_PENDING'});assert.throws(()=>manager.runMaintenance('backup-export',async()=>{}),{code:'SNAPSHOT_PENDING'});
  assert.equal(f.actions.length,before);assert.equal(f.imports(),1);assert.equal(f.restoreStore.get(f.id).state,'stopped');assert.deepEqual(await readFile(p.manifest),manifest);assert.deepEqual(await readFile(p.key),management);assert.deepEqual(await readFile(file),archive);
 }finally{await releaseLock?.();f.client.call=call;service.close();await f.close();}
});

for(const mode of ['error','cancel'] as const)test('A real pre-commit cleanup fault preserves the primary '+mode+' and reports cleanup independently',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),controller=new AbortController(),cause={synthetic:'original restore failure'},primary=Object.assign(new Error('Synthetic primary restore '+mode,{cause}),{code:mode==='cancel'?'CANCELLED':'SYNTHETIC_INPUT_FAILED'});primary.name=mode==='cancel'?'AbortError':'SyntheticRestoreInputError';
 let releaseLock:(()=>Promise<void>)|undefined,directory='';const warnings:{directory:string;message:string;sensitiveDataMayRemain:true}[]=[];
 async function* failedInput(){const pending=await f.privateFiles();assert.equal(pending.length,1);directory=path.join(f.restoreRoot,pending[0]);releaseLock=await holdTemporaryDisk(path.join(directory,'disk.vhdx'));if(mode==='cancel'){controller.abort(primary);controller.signal.throwIfAborted();}throw primary;}
 try{
  await assert.rejects(restoreWindowsBackup(f.client,f.restoreRoot,f.restoreStore,failedInput(),password,{signal:controller.signal,onCleanupIssue:issue=>{warnings.push(issue);if(mode==='error')throw Error('Synthetic observer failure');}}),error=>{
   assert.equal(error,primary);assert.equal((error as Error).name,primary.name);assert.equal((error as {code:string}).code,primary.code);assert.equal((error as Error).cause,cause);return true;
  });
  assert.equal(controller.signal.aborted,mode==='cancel');assert.equal(f.imports(),0);assert.deepEqual(f.restoreStore.list(),[]);assert.equal(warnings.length,1);assert.equal(warnings[0].directory,directory);assert.equal(warnings[0].sensitiveDataMayRemain,true);assert.match(warnings[0].message,/明文|凭据|敏感/);
  assert.ok(f.restoreStore.logs(null).some(row=>row.environmentId===null&&row.level==='error'&&row.message.includes(directory)&&/恢复尚未完成/.test(row.message)&&/清理/.test(row.message)));
  assert.deepEqual(await f.privateFiles(),[path.basename(directory)]);
 }finally{await releaseLock?.();await f.close();}
});

test('A real pre-commit cleanup fault keeps the product primary failure and a separate persistent warning',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),manager=f.manage(),service=new WindowsBackupService(manager,f.client),call=f.client.call.bind(f.client),primary=new AppError('Synthetic restore admission resource failure',409,'RESOURCE_DISK');
 let releaseLock:(()=>Promise<void>)|undefined,directory='';
 f.client.call=async(action,args={},options)=>{if(action==='allocation'){const pending=await f.privateFiles();assert.equal(pending.length,1);directory=path.join(f.restoreRoot,pending[0]);releaseLock=await holdTemporaryDisk(path.join(directory,'disk.vhdx'));throw primary;}return call(action,args,options);};
 try{
  const file=path.join(f.root,'pre-commit-cleanup.mucwin');await writeFile(file,await f.archive());await manager.wait(service.review(file,password).id);const review=service.snapshot().review!;
  const job=service.restore(review.token,review.name);await manager.wait(job.id);assert.equal(service.snapshot().phase,'failed');assert.match(service.snapshot().message,/磁盘空间不足/);assert.equal(manager.store.jobs().find(row=>row.id===job.id)?.status,'failed');assert.equal(f.imports(),0);assert.deepEqual(f.restoreStore.list(),[]);
  const warnings=service.snapshot().cleanupIssues!;assert.equal(warnings.length,1);assert.equal(warnings[0].directory,directory);assert.equal(warnings[0].sensitiveDataMayRemain,true);assert.match(warnings[0].message,/明文|凭据|敏感/);
  await releaseLock!();service.discard();assert.deepEqual(service.snapshot().cleanupIssues,warnings);
  assert.ok(manager.store.logs(null).some(row=>row.environmentId===null&&row.level==='error'&&row.message.includes(directory)&&/恢复尚未完成/.test(row.message)));
 }finally{await releaseLock?.();f.client.call=call;service.close();await f.close();}
});

test('Discarding an authenticated review clears its success instructions without restoring',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),manager=f.manage(),service=new WindowsBackupService(manager,f.client);
 try{
  const file=path.join(f.root,'discard-reviewed.mucwin'),encrypted=await f.archive();await writeFile(file,encrypted);
  await manager.wait(service.review(file,password).id);const review=service.snapshot().review!;assert.ok(review);
  service.discard();const state=service.snapshot();assert.equal(state.phase,'idle');assert.equal(state.message,'');assert.equal(state.review,undefined);
  assert.throws(()=>service.restore(review.token,review.name),{code:'BACKUP_REVIEW_EXPIRED'});assert.equal(f.imports(),0);assert.deepEqual(await readFile(file),encrypted);
 }finally{service.close();await f.close();}
});

test('The review timer retires approval and success instructions even when the wall clock moved backwards',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const f=await fixture(),manager=f.manage(),service=new WindowsBackupService(manager,f.client);
 try{
  const file=path.join(f.root,'timer-reviewed.mucwin');await writeFile(file,await f.archive());
  t.mock.timers.enable({apis:['setTimeout']});
  const job=service.review(file,password);await manager.wait(job.id);const review=service.snapshot().review!;assert.ok(review);
  t.mock.method(Date,'now',()=>Date.parse(review.expiresAt)-600000);
  t.mock.timers.tick(300000);const state=service.snapshot();assert.equal(state.phase,'idle');assert.match(state.message,/审阅已过期/);assert.equal(state.review,undefined);
  assert.throws(()=>service.restore(review.token,review.name),{code:'BACKUP_REVIEW_EXPIRED'});assert.equal(f.imports(),0);assert.equal(manager.store.jobs().find(row=>row.id===job.id)?.status,'succeeded');
 }finally{t.mock.restoreAll();t.mock.timers.reset();service.close();await f.close();}
});

test('Reading review status retires an elapsed approval even before its timer callback runs',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const f=await fixture(),manager=f.manage(),service=new WindowsBackupService(manager,f.client);
 try{
  const file=path.join(f.root,'late-timer-reviewed.mucwin');await writeFile(file,await f.archive());
  await manager.wait(service.review(file,password).id);const review=service.snapshot().review!;assert.ok(review);
  t.mock.method(Date,'now',()=>Date.parse(review.expiresAt)+1);
  const state=service.snapshot();assert.equal(state.phase,'idle');assert.match(state.message,/审阅已过期/);assert.equal(state.review,undefined);assert.equal(f.imports(),0);
 }finally{t.mock.restoreAll();service.close();await f.close();}
});

test('Restore synchronously retires elapsed approval but a stale token cannot erase a newer valid review',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const f=await fixture(),manager=f.manage(),service=new WindowsBackupService(manager,f.client);
 try{
  const file=path.join(f.root,'token-reviewed.mucwin');await writeFile(file,await f.archive());
  await manager.wait(service.review(file,password).id);const old=service.snapshot().review!;assert.ok(old);
  await manager.wait(service.review(file,password).id);const current=service.snapshot().review!;assert.ok(current);assert.notEqual(old.token,current.token);
  assert.throws(()=>service.restore(old.token,current.name),{code:'BACKUP_REVIEW_EXPIRED'});assert.equal(service.snapshot().review?.token,current.token);assert.equal(service.snapshot().phase,'succeeded');
  const jobs=manager.store.jobs().length;t.mock.method(Date,'now',()=>Date.parse(current.expiresAt)+1);
  assert.throws(()=>service.restore(current.token,current.name),{code:'BACKUP_REVIEW_EXPIRED'});
  const state=service.snapshot();assert.equal(state.phase,'idle');assert.match(state.message,/审阅已过期/);assert.equal(state.review,undefined);assert.equal(manager.store.jobs().length,jobs);assert.equal(f.imports(),0);
 }finally{t.mock.restoreAll();service.close();await f.close();}
});
test('Product exports never replace an existing file, cancel cleanly and block conflicting lifecycle changes',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),manager=f.manage(true),service=new WindowsBackupService(manager,f.client);try{
  f.sourceStore.state(f.id,'stopped');const file=path.join(f.root,'export.mucwin');await writeFile(file,'original');
  await manager.wait(service.export(f.id,file,password,f.original.name).id);assert.equal(service.snapshot().phase,'failed');assert.equal(service.snapshot().savedPath,undefined);assert.equal(await readFile(file,'utf8'),'original');
  let release!:()=>void,entered!:()=>void;const began=new Promise<void>(resolve=>entered=resolve);manager.runtime.state=async()=>{entered();await new Promise<void>(resolve=>release=resolve);return {state:'Off'};};
  const original=f.sourceStore.get(f.id),draft=Object.fromEntries(Object.keys(environmentSchema.shape).map(key=>[key,original[key as keyof typeof original]]));
  const updating=manager.update(f.id,{...draft,name:'Must not replace reviewed backup configuration'});await began;
  const next=path.join(f.root,'next.mucwin'),job=service.export(f.id,next,password,f.original.name);release();await assert.rejects(updating,{code:'BACKUP_BUSY'});assert.equal(f.sourceStore.get(f.id).name,f.original.name);manager.runtime.state=async()=>({state:'Off'});
  await assert.rejects(manager.update(f.id,{}),{code:'BACKUP_BUSY'});await assert.rejects(manager.remove(f.id,f.original.name),{code:'BACKUP_BUSY'});await assert.rejects(manager.action(f.id,'start'),{code:'BACKUP_BUSY'});manager.cancel(job.id);await manager.wait(job.id);assert.equal(service.snapshot().phase,'cancelled');assert.ok(!(await readdir(f.root)).some(name=>name.startsWith('.mucwin-partial-')));
  await manager.wait(service.export(f.id,next,password,f.original.name).id);assert.equal(service.snapshot().phase,'succeeded');assert.equal(service.snapshot().savedPath,next);assert.equal(service.snapshot().lastSaved?.path,next);const stored=manager.store.db.prepare('SELECT payload FROM windows_backup_last_saved WHERE id=1').get() as {payload:string};assert.equal(stored.payload.includes(next),false);
  const reopenedStore=await openWindowsStore(manager.store.dataDir),reopenedManager=new WindowsManager(reopenedStore,manager.runtime,manager.options),reopened=new WindowsBackupService(reopenedManager,f.client);try{assert.equal(reopened.snapshot().lastSaved?.path,next);}finally{reopened.close();await reopenedManager.close();}
  const manifest=await readWindowsBackupArchive(input(await readFile(next)),{write:async()=>{}},password);assert.equal(manifest.config.name,f.original.name);service.discard();assert.equal(service.snapshot().savedPath,next);
 }finally{service.close();await f.close();}
});

test('Backup location record failure does not undo a successfully published backup',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),manager=f.manage(true),service=new WindowsBackupService(manager,f.client),db=manager.store.db,original=db.prepare.bind(db);
 try{
  f.sourceStore.state(f.id,'stopped');const target=path.join(f.root,'record-failure.mucwin');
  db.prepare=((sql:string)=>{if(sql.startsWith('INSERT INTO windows_backup_last_saved'))throw Error('synthetic record failure');return original(sql);}) as typeof db.prepare;
  await manager.wait(service.export(f.id,target,password,f.original.name).id);
  assert.equal(service.snapshot().phase,'succeeded');assert.equal(service.snapshot().savedPath,target);assert.match(service.snapshot().lastSavedIssue??'',/无法读取或保存/);
  const manifest=await readWindowsBackupArchive(input(await readFile(target)),{write:async()=>{}},password);assert.equal(manifest.config.name,f.original.name);
 }finally{db.prepare=original;service.close();await f.close();}
});

test('A locked export stays unpublished, retains durable output cleanup, and retries the same target as a reviewable single-linked archive',{skip:process.platform!=='win32',timeout:60000},async()=>{
 for(const cancelled of [false,true]){const f=await fixture(),manager=f.manage(true),service=new WindowsBackupService(manager,f.client),call=f.client.call.bind(f.client);let releaseLock:(()=>Promise<void>)|undefined,reopenedManager:WindowsManager|undefined,reopenedService:WindowsBackupService|undefined,exportJobId='';
 f.client.call=async(action,args={},options)=>{const result=await call(action,args,options);if(action==='backup-close'&&!releaseLock){const partials=(await readdir(f.root)).filter(name=>name.startsWith('.mucwin-partial-'));assert.equal(partials.length,1);releaseLock=await holdTemporaryDisk(path.join(f.root,partials[0]));if(cancelled)manager.cancel(exportJobId);}return result;};
 try{
  f.sourceStore.state(f.id,'stopped');const key=await readFile(f.p.key),manifest=await readFile(f.p.manifest),target=path.join(f.root,'locked-export-same-target.mucwin'),sentinel=path.join(f.root,'unrelated-note.txt');await writeFile(sentinel,'preserve unrelated output data');
  const job=service.export(f.id,target,password,f.original.name);exportJobId=job.id;await manager.wait(job.id);const outcome=cancelled?'cancelled':'failed';assert.equal(service.snapshot().phase,outcome);assert.equal(manager.store.jobs().find(row=>row.id===job.id)?.status,outcome);assert.equal(service.snapshot().releaseIssues,undefined);await assert.rejects(lstat(target),{code:'ENOENT'});
  const warnings=service.snapshot().outputIssues!;assert.equal(warnings.length,1);const issue=warnings[0];assert.equal(issue.encrypted,true);assert.equal(issue.retryable,true);assert.equal(path.dirname(issue.path),f.root);const staged=await readFile(issue.path);if(cancelled)await assert.rejects(readWindowsBackupArchive(input(staged),{write:async()=>{}},password),{code:'WINDOWS_BACKUP_INTEGRITY'});else assert.equal((await readWindowsBackupArchive(input(staged),{write:async()=>{}},password)).config.name,f.original.name);assert.equal((await lstat(issue.path)).nlink,1);assert.deepEqual(await readFile(f.p.key),key);assert.deepEqual(await readFile(f.p.manifest),manifest);
  service.close();await manager.close();const reopenedStore=await openWindowsStore(path.join(f.root,'source-store'));reopenedManager=new WindowsManager(reopenedStore,{state:async()=>({state:'Off'}),stop:async()=>{}} as unknown as WindowsBackend,{runtimeRoot:path.dirname(f.p.directory)});let available=false;reopenedService=new WindowsBackupService(reopenedManager,f.client,()=>available);
  assert.equal(reopenedService.snapshot().outputIssues?.length,1);assert.equal(reopenedService.snapshot().outputIssues![0].id,issue.id);assert.equal(reopenedStore.jobs().find(row=>row.id===job.id)?.status,outcome);await releaseLock!();const before=f.actions.length,cleanup=reopenedService.cleanupOutput(issue.id);await reopenedManager.wait(cleanup.id);assert.equal(reopenedService.snapshot().phase,'succeeded');assert.equal(reopenedService.snapshot().outputIssues,undefined);await assert.rejects(lstat(issue.path),{code:'ENOENT'});await assert.rejects(lstat(target),{code:'ENOENT'});assert.equal(f.actions.length,before);assert.equal(await readFile(sentinel,'utf8'),'preserve unrelated output data');
  available=true;const retry=reopenedService.export(f.id,target,password,f.original.name);await reopenedManager.wait(retry.id);assert.equal(reopenedService.snapshot().phase,'succeeded');assert.equal(reopenedStore.jobs().find(row=>row.id===retry.id)?.status,'succeeded');assert.equal((await lstat(target)).nlink,1);assert.equal((await readdir(f.root)).some(name=>name.startsWith('.mucwin-partial-')),false);await reopenedManager.wait(reopenedService.review(target,password).id);assert.equal(reopenedService.snapshot().phase,'succeeded');assert.equal(reopenedService.snapshot().review?.id,f.id);assert.equal(reopenedStore.get(f.id).state,'stopped');assert.deepEqual(await readFile(f.p.key),key);assert.deepEqual(await readFile(f.p.manifest),manifest);assert.equal(f.imports(),0);
 }finally{await releaseLock?.();f.client.call=call;service.close();reopenedService?.close();await reopenedManager?.close();await f.close();}}
});

test('An export private-key sharing fault has a durable sensitive warning and safely cleans only that export work after reopening',{skip:process.platform!=='win32',timeout:45000},async()=>{
 const f=await fixture();let child:ReturnType<typeof spawn>|undefined;
 try{
  f.sourceStore.state(f.id,'stopped');const key=await readFile(f.p.key),manifest=await readFile(f.p.manifest),worker=fileURLToPath(new URL('./fixtures/windows-export-secret-worker.ts',import.meta.url));
  child=spawn(process.execPath,['--experimental-test-module-mocks',worker],{stdio:['pipe','pipe','pipe'],windowsHide:true});child.stdin!.on('error',()=>{});let output='',details='';child.stdout!.on('data',bytes=>output=(output+bytes).slice(-16384));child.stderr!.on('data',bytes=>details=(details+bytes).slice(-8192));const running=child,ended=new Promise<number|null>(resolve=>running.once('close',resolve)),watchdog=setTimeout(()=>running.kill('SIGKILL'),35000);watchdog.unref();
  child.stdin!.end(JSON.stringify({root:f.root,dataDir:f.sourceStore.dataDir,runtimeRoot:path.dirname(f.p.directory),target:path.join(f.root,'private-key-failed-export.mucwin'),id:f.id,info:f.info,seed:f.seed.toString('base64'),password}));let code:number|null;try{code=await ended;}finally{clearTimeout(watchdog);}assert.equal(code,0,details+'\n'+output);
  const result=JSON.parse(output.trim());assert.equal(result.passed,true);assert.equal(result.producerCreatedExactKey,true);assert.equal(result.realWindowsSharingLock,true);assert.equal(result.sensitiveWarningPersistedAcrossStoreReopen,true);assert.equal(result.onlyRecordedWorkRemoved,true);assert.equal(result.extraBrokerCallsDuringCleanup,0);assert.equal(result.realHyperV,false);assert.deepEqual(await readFile(f.p.key),key);assert.deepEqual(await readFile(f.p.manifest),manifest);assert.equal(f.sourceStore.get(f.id).state,'stopped');
 }finally{if(child?.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(resolve=>child!.once('close',()=>resolve()));child.kill('SIGKILL');await exited;}await f.close();}
});

test('A complete encrypted export remains published and reviewable when a real private-work directory lock blocks cleanup',{skip:process.platform!=='win32',timeout:45000},async()=>{
 const f=await fixture(),manager=f.manage(true),service=new WindowsBackupService(manager,f.client),call=f.client.call.bind(f.client),runtimeRoot=path.dirname(f.p.directory);let releaseLock:(()=>Promise<void>)|undefined,work='';
 f.client.call=async(action,args={},options)=>{const result=await call(action,args,options);if(action==='backup-close'&&!releaseLock){const directories=(await readdir(runtimeRoot)).filter(name=>name.startsWith('backup-work-'));assert.equal(directories.length,1);work=path.join(runtimeRoot,directories[0]);assert.deepEqual(await readdir(work),[]);releaseLock=await holdTemporaryDisk(work,true);}return result;};
 try{
  f.sourceStore.state(f.id,'stopped');const key=await readFile(f.p.key),manifest=await readFile(f.p.manifest),target=path.join(f.root,'complete-despite-work-lock.mucwin'),job=service.export(f.id,target,password,f.original.name);await manager.wait(job.id);
  assert.ok(releaseLock,'The real directory-sharing fixture must initialize before the product outcome is evaluated');assert.equal(service.snapshot().phase,'succeeded');assert.match(service.snapshot().message,/加密备份已保存/);assert.match(service.snapshot().message,/临时/);const completed=manager.store.jobs().find(row=>row.id===job.id)!;assert.equal(completed.status,'succeeded');assert.match(completed.message,/已保存/);assert.equal((await lstat(target)).nlink,1);const encrypted=await readFile(target),decoded:Buffer[]=[];const archive=await readWindowsBackupArchive(input(encrypted),{write:async bytes=>{decoded.push(Buffer.from(bytes));}},password);assert.equal(archive.version,2);assert.ok('identity' in archive);assert.equal(archive.identity.id,f.id);assert.deepEqual(Buffer.concat(decoded),f.disk);
  const warnings=service.snapshot().cleanupIssues!;assert.equal(warnings.length,1);const issue=warnings[0];assert.ok(issue.id);assert.equal(issue.directory,work);assert.equal(issue.retryable,true);const record=manager.store.db.prepare('SELECT payload FROM windows_backup_cleanup WHERE id=?').get(issue.id) as {payload:string};assert.equal(JSON.parse(manager.store.decrypt(record.payload)).kind,'windows-backup-export-work');assert.ok(manager.store.logs(null).some(row=>row.level==='error'&&row.message.includes(work)&&/临时|管理/.test(row.message)));assert.equal(service.snapshot().outputIssues,undefined);
  await manager.wait(service.review(target,password).id);assert.equal(service.snapshot().phase,'succeeded');assert.equal(service.snapshot().review?.id,f.id);assert.equal(service.snapshot().cleanupIssues![0].id,issue.id);await releaseLock!();const before=f.actions.length,cleanup=service.cleanup(issue.id);await manager.wait(cleanup.id);assert.equal(service.snapshot().phase,'succeeded');assert.equal(service.snapshot().cleanupIssues,undefined);await assert.rejects(lstat(work),{code:'ENOENT'});assert.equal(f.actions.length,before);assert.deepEqual(await readFile(target),encrypted);assert.deepEqual(await readFile(f.p.key),key);assert.deepEqual(await readFile(f.p.manifest),manifest);assert.equal(f.sourceStore.get(f.id).state,'stopped');assert.equal(f.imports(),0);
 }finally{await releaseLock?.();f.client.call=call;service.close();await f.close();}
});

test('Product export keeps its primary read failure or cancellation separate from pending native release and later confirmed release clears the warning',{skip:process.platform!=='win32',timeout:60000},async()=>{
 for(const mode of ['error','cancel'] as const){const f=await fixture(),manager=f.manage(true),service=new WindowsBackupService(manager,f.client),call=f.client.call.bind(f.client);let failClose=true,closeAttempts=0,releaseRead:(()=>void)|undefined,entered!:()=>void;const began=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>releaseRead=resolve),primary=new AppError('Synthetic disk read primary failure',409,'RESOURCE_DISK');
  f.client.call=async(action,args={},options)=>{if(action==='backup-close'&&failClose){closeAttempts++;throw new AppError('Synthetic independent native release failure',503,'BROKER_UNAVAILABLE');}if(action==='backup-stream'&&failClose){if(mode==='error')throw primary;entered();await gate;options?.signal?.throwIfAborted();}return call(action,args,options);};
  try{f.sourceStore.state(f.id,'stopped');const target=path.join(f.root,'release-primary-'+mode+'.mucwin'),key=await readFile(f.p.key),manifest=await readFile(f.p.manifest),job=service.export(f.id,target,password,f.original.name);if(mode==='cancel'){await began;manager.cancel(job.id);releaseRead!();}await manager.wait(job.id);const state=service.snapshot();assert.equal(state.phase,mode==='error'?'failed':'cancelled');assert.equal(manager.store.jobs().find(row=>row.id===job.id)?.status,mode==='error'?'failed':'cancelled');if(mode==='error')assert.match(state.message,/磁盘空间不足/);else assert.match(state.message,/已取消/);assert.equal(state.outputIssues,undefined);assert.equal((await readdir(f.root)).some(name=>name.startsWith('.mucwin-partial-')),false);assert.ok(closeAttempts>=2);assert.equal(state.releaseIssues?.length,1);assert.equal(state.releaseIssues![0].environmentId,f.id);assert.match(state.releaseIssues![0].message,/释放尚未确认/);await assert.rejects(lstat(target),{code:'ENOENT'});
   failClose=false;await manager.wait(service.export(f.id,target,password,f.original.name).id);assert.equal(service.snapshot().phase,'succeeded');assert.equal(service.snapshot().releaseIssues,undefined);assert.equal((await lstat(target)).nlink,1);await manager.wait(service.review(target,password).id);assert.equal(service.snapshot().review?.id,f.id);assert.equal(f.sourceStore.get(f.id).state,'stopped');assert.deepEqual(await readFile(f.p.key),key);assert.deepEqual(await readFile(f.p.manifest),manifest);assert.equal(f.imports(),0);
  }finally{releaseRead?.();f.client.call=call;service.close();await f.close();}
 }
});

for(const operation of ['export','review','restore'] as const)test('Cancelling a queued product '+operation+' settles its panel, touches no target and permits a fresh retry',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),manager=f.manage(operation==='export'),service=new WindowsBackupService(manager,f.client);
 try{
  const file=path.join(f.root,'queued-cancellation.mucwin');let job;
  if(operation==='export'){f.sourceStore.state(f.id,'stopped');job=service.export(f.id,file,password,f.original.name);}
  else{await writeFile(file,await f.archive());if(operation==='review')job=service.review(file,password);else{await manager.wait(service.review(file,password).id);const review=service.snapshot().review!;job=service.restore(review.token,review.name);}}
  const before=f.actions.length;manager.cancel(job.id);await manager.wait(job.id);
  assert.equal(manager.store.jobs().find(row=>row.id===job.id)?.status,'cancelled');
  assert.equal(service.snapshot().phase,'cancelled');assert.equal(service.snapshot().review,undefined);assert.equal(f.actions.length,before);assert.equal(f.imports(),0);assert.deepEqual(await f.privateFiles(),[]);
  assert.doesNotThrow(()=>service.discard());
  if(operation==='export'){await assert.rejects(readFile(file),{code:'ENOENT'});await manager.wait(service.export(f.id,file,password,f.original.name).id);assert.equal(service.snapshot().phase,'succeeded');await readWindowsBackupArchive(input(await readFile(file)),{write:async()=>{}},password);}
  else{assert.deepEqual(f.restoreStore.list(),[]);await manager.wait(service.review(file,password).id);assert.equal(service.snapshot().phase,'succeeded');if(operation==='restore'){const review=service.snapshot().review!;await manager.wait(service.restore(review.token,review.name).id);assert.equal(service.snapshot().phase,'succeeded');assert.equal(f.restoreStore.get(f.id).state,'stopped');assert.equal(f.imports(),1);}}
 }finally{service.close();await f.close();}
});
