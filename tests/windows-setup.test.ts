import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,access,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {WindowsSetup} from '../server/platform/windows/setup.ts';
import {windowsBaseSchema,windowsConfigSchema} from '../server/platform/windows/config.ts';
import {CANONICAL_NOCLOUD_PATCH,HyperVRuntime} from '../server/platform/windows/runtime.ts';
import type {HyperVBrokerClient} from '../server/platform/windows/broker.ts';
import {AppError} from '../server/errors.ts';
import {spawn} from 'node:child_process';
const sha='a'.repeat(64),base={image:'mu-base:'+sha,imageSha256:sha};
test('Sealed base references bind their digest and reject paths disguised as capabilities',()=>{
 assert.deepEqual(windowsBaseSchema.parse(base),base);
 for(const image of ['mu-base:'+sha+'/disk.vhdx','mu-base:../image','mu-base:'+sha.toUpperCase()])assert.equal(windowsBaseSchema.safeParse({...base,image}).success,false);
 assert.equal(windowsBaseSchema.safeParse({...base,imageSha256:'b'.repeat(64)}).success,false);
});
test('A complete environment config projects only its base descriptor into the sealed verifier',async()=>{
 const seen:object[]=[],broker={call:async(action:string,parameters:object)=>{seen.push({action,...parameters});return{ready:true,...base};}} as unknown as HyperVBrokerClient,runtime=new HyperVRuntime(path.resolve('.'),undefined,broker);
 const config=windowsConfigSchema.parse({version:1,id:randomUUID(),...base,cpus:1,memoryGiB:2,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:1},expectedIp:'203.0.113.10'});
 assert.deepEqual(await runtime.verifySealedBase(config),base);assert.deepEqual(seen,[{action:'base-status',imageSha256:sha}]);
});
async function fixture(options:{failCleanup?:boolean;failVerify?:boolean;firstError?:unknown}={}){
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-setup-'));await mkdir(path.join(root,'setup'));const events:string[]=[];
 const c=windowsConfigSchema.parse({version:1,id:randomUUID(),image:path.join(root,'official.vhd'),imageSha256:CANONICAL_NOCLOUD_PATCH.sourceSha256,cpus:2,memoryGiB:4,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:1},expectedIp:'203.0.113.10'});
 await writeFile(path.join(root,'setup/state.json'),JSON.stringify({version:1,builder:c,base,status:'failed',phase:'cleaning'}));
 let first=true;const runtime={info:async()=>{if(first){first=false;if(options.firstError)throw options.firstError;}return{available:true,issues:[]};},disconnect:async()=>{},discardBaseBuilder:async()=>{events.push('clean');if(options.failCleanup)throw Error('Synthetic unconfirmed cleanup');},verifySealedBase:async()=>{events.push('verify');if(options.failVerify)throw Error('Synthetic changed base');return base;}} as unknown as HyperVRuntime;
 let published=false;const setup=new WindowsSetup(runtime,root,{canPrepare:()=>true,publish:()=>{events.push('publish');published=true;}});await setup.initialize();
 const journalErrors:{code?:string;message:string}[]=[],save=(setup as any).save.bind(setup);(setup as any).save=async()=>{try{return await save();}catch(error){journalErrors.push({code:(error as NodeJS.ErrnoException).code,message:(error as Error).message});throw error;}};
 return{root,events,setup,runtime,journalErrors,published:()=>published,close:async()=>{await setup.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}};
}
test('A recovered sealed image is published only after builder cleanup and fresh verification',{skip:process.platform!=='win32'},async()=>{const f=await fixture();try{assert.equal(f.setup.snapshot().status,'interrupted');f.setup.start();await f.setup.wait();assert.equal(f.setup.snapshot().status,'ready');assert.deepEqual(f.events,['clean','verify','publish']);assert.equal(f.published(),true);assert.deepEqual(JSON.parse(await readFile(path.join(f.root,'protected-desktop-base.json'),'utf8')),base);}finally{await f.close();}});
test('Unconfirmed builder cleanup cannot publish or advertise a ready base',{skip:process.platform!=='win32'},async()=>{const f=await fixture({failCleanup:true});try{f.setup.start();await f.setup.wait();assert.equal(f.setup.snapshot().status,'failed');assert.equal(f.setup.snapshot().phase,'cleaning');assert.equal(f.published(),false);await assert.rejects(access(path.join(f.root,'protected-desktop-base.json')),{code:'ENOENT'});}finally{await f.close();}});
test('A changed protected image cannot be published during recovery',{skip:process.platform!=='win32'},async()=>{const f=await fixture({failVerify:true});try{f.setup.start();await f.setup.wait();assert.equal(f.setup.snapshot().status,'failed');assert.equal(f.published(),false);await assert.rejects(access(path.join(f.root,'protected-desktop-base.json')),{code:'ENOENT'});}finally{await f.close();}});
test('Cancelling recovery keeps its verified base unpublished after safe builder cleanup',{skip:process.platform!=='win32'},async()=>{const f=await fixture();try{f.setup.start();f.setup.cancel();await f.setup.wait();assert.equal(f.setup.snapshot().status,'cancelled');assert.equal(f.published(),false);assert.deepEqual(f.events,['clean']);}finally{await f.close();}});

for(const [code,expected]of [['RESOURCE_DISK','磁盘增长预留'],['RESOURCE_MEMORY','可用内存不足'],['RESOURCE_QUOTA','虚拟磁盘容量上限'],['RESOURCE_FENCED','重新打开软件'],['RESOURCE_BUSY','启动操作仍在进行'],['STORAGE_BUSY','镜像操作仍在进行']]){
 test('Setup retains a safe actionable '+code+' reason across restart and clears it on successful retry',{skip:process.platform!=='win32'},async()=>{
  const f=await fixture({firstError:new AppError('Sensitive diagnostic must not enter the UI or journal',409,code)});
  try{
   f.setup.start();await f.setup.wait();assert.equal(f.setup.snapshot().status,'failed');assert.ok(f.setup.snapshot().message?.includes(expected),JSON.stringify({state:f.setup.snapshot(),journalErrors:f.journalErrors}));assert.deepEqual(f.events,['clean']);assert.equal(f.published(),false);
   const text=await readFile(path.join(f.root,'setup/state.json'),'utf8'),saved=JSON.parse(text);assert.equal(saved.failureCode,code);assert.equal(saved.builder,undefined);assert.equal(text.includes('Sensitive diagnostic'),false);assert.equal(f.setup.snapshot().message?.includes('Sensitive diagnostic'),false);
   const resumed=new WindowsSetup(f.runtime,f.root,{canPrepare:()=>true,publish:()=>{}});await resumed.initialize();assert.equal(resumed.snapshot().status,'failed');assert.equal(resumed.snapshot().message,f.setup.snapshot().message);
   resumed.start();assert.equal(resumed.snapshot().message,null);await resumed.wait();assert.equal(resumed.snapshot().status,'ready');assert.equal(resumed.snapshot().message,null);assert.equal(JSON.parse(await readFile(path.join(f.root,'setup/state.json'),'utf8')).failureCode,undefined);await resumed.close();
  }finally{await f.close();}
 });
}
test('Unconfirmed cleanup takes precedence over the original resource reason and retains the builder',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture({firstError:new AppError('private',409,'RESOURCE_DISK'),failCleanup:true});try{f.setup.start();await f.setup.wait();const state=f.setup.snapshot(),saved=JSON.parse(await readFile(path.join(f.root,'setup/state.json'),'utf8'));assert.equal(state.phase,'cleaning');assert.ok(state.message?.includes('清理尚未确认'));assert.equal(saved.failureCode,undefined);assert.ok(saved.builder);assert.equal(f.published(),false);}finally{await f.close();}
});
test('Unknown and untyped setup errors do not expose raw diagnostics or persist an untrusted resource code',{skip:process.platform!=='win32'},async()=>{
 for(const error of [new AppError('private',409,'UNKNOWN'),Object.assign(Error('private'),{code:'RESOURCE_DISK'})]){const f=await fixture({firstError:error});try{f.setup.start();await f.setup.wait();assert.equal(f.setup.snapshot().status,'failed');assert.equal(f.setup.snapshot().message?.includes('private'),false);const saved=JSON.parse(await readFile(path.join(f.root,'setup/state.json'),'utf8'));assert.equal(saved.failureCode,undefined);assert.equal(saved.builder,undefined);}finally{await f.close();}}
});

async function holdJournal(file:string){
 const body="$ErrorActionPreference='Stop';$f=[IO.File]::Open('"+file.replaceAll("'","''")+"',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[Console]::Out.WriteLine('LOCKED');[Console]::Out.Flush();[Console]::In.ReadLine()|Out-Null}finally{$f.Dispose()}";
 const child=spawn(path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(body,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',issue='';child.stderr.on('data',bytes=>issue+=bytes.toString());child.stdin.on('error',()=>{});const exited=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Synthetic file-lock helper failed: '+issue.slice(0,1000))));});
 await new Promise<void>((resolve,reject)=>{child.stdout.on('data',bytes=>{output+=bytes.toString();if(output.includes('LOCKED'))resolve();});exited.then(()=>{if(!output.includes('LOCKED'))reject(Error('File-lock helper exited before acquiring its handle'));},reject);});
 return {release:()=>child.stdin.end('\n'),exited};
}

test('Setup retries a real Windows journal sharing violation and preserves the prior record until its handle is released',{skip:process.platform!=='win32',timeout:20000},async()=>{
 const f=await fixture(),file=path.join(f.root,'setup/state.json'),before=await readFile(file),lock=await holdJournal(file);let release:ReturnType<typeof setTimeout>|undefined;
 try{f.setup.start();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(f.setup.running,true);assert.deepEqual(await readFile(file),before);release=setTimeout(()=>lock.release(),250);await f.setup.wait();await lock.exited;assert.equal(f.setup.snapshot().status,'ready',JSON.stringify(f.journalErrors));assert.equal(f.published(),true);assert.equal(JSON.parse(await readFile(file,'utf8')).status,'ready');}
 finally{clearTimeout(release);lock.release();await lock.exited;await f.close();}
});

test('A persistent Windows journal sharing denial fails closed without replacing or removing the previous record',{skip:process.platform!=='win32',timeout:20000},async()=>{
 const f=await fixture(),file=path.join(f.root,'setup/state.json'),before=await readFile(file),lock=await holdJournal(file);
 try{f.setup.start();await f.setup.wait();assert.equal(f.setup.snapshot().status,'failed');assert.equal(f.published(),false);assert.deepEqual(await readFile(file),before);assert.ok(f.journalErrors.some(v=>['EPERM','EACCES','EBUSY'].includes(v.code??'')));await assert.rejects(access(path.join(f.root,'protected-desktop-base.json')),{code:'ENOENT'});}
 finally{lock.release();await lock.exited;await f.close();}
});
