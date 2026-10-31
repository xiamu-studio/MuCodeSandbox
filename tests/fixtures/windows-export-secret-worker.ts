// Isolated fault injection. Every path, key and broker receipt is supplied by
// the parent test's private synthetic fixture. No global runner flag is needed.
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import path from 'node:path';
import {readFile,mkdir,writeFile,lstat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const processModule=new URL('../../server/process.ts',import.meta.url).href;
const {run:actualRun}=await import(processModule);
const {powershellPath,powershellArgs}=await import('../../server/platform/windows/runtime.ts');
let releaseLock:(()=>Promise<void>)|undefined,privateFile:string|undefined;
async function hold(file:string){
 const child=spawn(powershellPath(),powershellArgs("$ErrorActionPreference='Stop';$file=[Console]::In.ReadLine();$handle=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[Console]::WriteLine('LOCKED');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null}finally{$handle.Dispose()}"),{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let details='';child.stderr.on('data',bytes=>details=(details+bytes).slice(-2048));child.stdin.on('error',()=>{});const ended=new Promise<number|null>(resolve=>child.once('close',resolve)),watchdog=setTimeout(()=>child.kill(),30000);watchdog.unref();child.once('close',()=>clearTimeout(watchdog));
 await new Promise<void>((resolve,reject)=>{let text='',settled=false;const timer=setTimeout(()=>finish(Error('Private check lock did not initialize: '+details)),10000),finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};child.once('error',finish);child.once('close',()=>finish(Error('Private check lock exited: '+details)));child.stdout.on('data',bytes=>{text+=bytes;if(text.includes('LOCKED'))finish();});child.stdin.write(file+'\n');});let released=false;
 return async()=>{if(released)return;released=true;child.stdin.end('\n');assert.equal(await ended,0,details);};
}
mock.module(processModule,{namedExports:{run:async(file:string,args:string[],options:unknown)=>{
 if(path.basename(file).toLowerCase()==='ssh-keygen.exe'&&args[0]==='-y'&&path.basename(args.at(-1)??'')==='management-check'&&!releaseLock){privateFile=args.at(-1)!;releaseLock=await hold(privateFile);}
 return actualRun(file,args,options as never);
}}});
const [{openWindowsStore},{WindowsManager},{WindowsBackupService},{windowsPaths}]=await Promise.all([import('../../server/platform/windows/credentials.ts'),import('../../server/platform/windows/manager.ts'),import('../../server/platform/windows/backup-service.ts'),import('../../server/platform/windows/config.ts')]);
const data=JSON.parse(await new Promise<string>(resolve=>{let text='';process.stdin.on('data',bytes=>text+=bytes);process.stdin.on('end',()=>resolve(text));}));
assert.match(path.basename(data.root),/^mu-backup-bundle-/);assert.equal(path.dirname(data.dataDir),data.root);assert.equal(path.dirname(data.runtimeRoot),data.root);assert.equal(path.dirname(data.target),data.root);
const seed=Buffer.from(data.seed,'base64'),source=windowsPaths(data.runtimeRoot,data.id),beforeKey=await readFile(source.key),beforeManifest=await readFile(source.manifest),calls:string[]=[];
const broker={call:async(action:string,args:Record<string,unknown>={})=>{calls.push(action);if(action==='backup-begin')return data.info;if(action==='backup-close')return{closed:true};if(action==='backup-seed'){const start=Number(args.offset),end=Math.min(start+32768,seed.length);return{data:seed.subarray(start,end).toString('base64'),nextOffset:end,done:end===seed.length};}throw Error('Forbidden private-key fixture broker call: '+action);}};
const backend={state:async()=>({state:'Off'}),stop:async()=>{throw Error('No VM stopping in this fixture');}};
let manager:InstanceType<typeof WindowsManager>|undefined,service:InstanceType<typeof WindowsBackupService>|undefined;
try{
 manager=new WindowsManager(await openWindowsStore(data.dataDir),backend as never,{runtimeRoot:data.runtimeRoot});service=new WindowsBackupService(manager,broker as never);
 const environment=manager.store.get(data.id),job=service.export(data.id,data.target,data.password,environment.name);await manager.wait(job.id);
 const state=service.snapshot();assert.equal(state.phase,'failed');assert.ok(privateFile);assert.deepEqual(await readFile(privateFile),beforeKey);assert.equal(state.cleanupIssues?.length,1);const issue=state.cleanupIssues![0];assert.ok(issue.id);assert.equal(issue.retryable,true);assert.equal(issue.sensitiveDataMayRemain,true);assert.equal(path.dirname(privateFile),issue.directory);assert.match(issue.message,/明文|凭据|管理/);assert.ok(manager.store.logs(null).some(row=>row.message.includes(issue.directory)&&/明文|凭据|管理/.test(row.message)));
 const raw=manager.store.db.prepare('SELECT payload FROM windows_backup_cleanup WHERE id=?').get(issue.id) as {payload:string};assert.ok(raw.payload.startsWith('enc:'));assert.equal(JSON.parse(manager.store.decrypt(raw.payload)).kind,'windows-backup-export-work');assert.equal(raw.payload.includes(beforeKey.toString()),false);
 service.close();await manager.close();manager=undefined;service=undefined;
 manager=new WindowsManager(await openWindowsStore(data.dataDir),backend as never,{runtimeRoot:data.runtimeRoot});service=new WindowsBackupService(manager,broker as never,()=>false);assert.equal(service.snapshot().cleanupIssues?.length,1);assert.equal(service.snapshot().cleanupIssues![0].id,issue.id);assert.equal(manager.store.jobs().find(row=>row.id===job.id)?.status,'failed');
 const other=path.join(data.runtimeRoot,'unrelated-fixture-'+randomUUID());await mkdir(other);await writeFile(path.join(other,'preserve.txt'),'unrelated synthetic runtime data');await releaseLock!();const priorCalls=calls.length,cleanup=service.cleanup(issue.id);await manager.wait(cleanup.id);assert.equal(service.snapshot().phase,'succeeded');assert.equal(service.snapshot().cleanupIssues,undefined);await assert.rejects(lstat(issue.directory),{code:'ENOENT'});assert.equal(await readFile(path.join(other,'preserve.txt'),'utf8'),'unrelated synthetic runtime data');assert.equal(calls.length,priorCalls);assert.deepEqual(await readFile(source.key),beforeKey);assert.deepEqual(await readFile(source.manifest),beforeManifest);assert.equal(manager.store.get(data.id).state,'stopped');await assert.rejects(lstat(data.target),{code:'ENOENT'});
 console.log(JSON.stringify({case:'export-private-check-lock',passed:true,realWindowsSharingLock:true,producerCreatedExactKey:true,sensitiveWarningPersistedAcrossStoreReopen:true,onlyRecordedWorkRemoved:true,sourceUnchanged:true,extraBrokerCallsDuringCleanup:0,realHyperV:false}));
}finally{await releaseLock?.();service?.close();await manager?.close();seed.fill(0);beforeKey.fill(0);mock.restoreAll();}
