import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {request as httpRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createWindowsService} from '../server/platform/windows/service.ts';
import {acquireWindowsServiceLock} from '../server/platform/windows/service-lock.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import type {WindowsBackend} from '../server/platform/windows/manager.ts';
import type {HyperVRuntime} from '../server/platform/windows/runtime.ts';
import {WindowsNetworkSession} from '../server/platform/windows/session.ts';
import {windowsPaths} from '../server/platform/windows/config.ts';

for(const phase of ['clipboard-completion','clipboard-authorization','download-completion','download-authorization'] as const)test(`Old Windows exchange work cannot cross a restart at ${phase}`,{skip:process.platform!=='win32',timeout:30000},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-exchange-session-')),runtimeRoot=path.join(root,'runtime');
 await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/index.html'),'<!-- MU_BOOTSTRAP -->');
 let state='Off',lease=false,calls=0,release!:()=>void,entered!:()=>void,signal:AbortSignal|undefined;
 const began=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
 const inspection=async()=>({digest:'a'.repeat(64),leaseActive:lease,remainingMs:lease?40000:0});
 const driver={inspect:inspection,probe:async()=>[{receiver:'local-a',ip:'203.0.113.10'},{receiver:'local-b',ip:'203.0.113.10'}],activate:async()=>{lease=true;},renew:async()=>{},revoke:async()=>{lease=false;},disconnect:async()=>{},stop:async()=>{state='Off';lease=false;}};
 const complete=async(options:Parameters<HyperVRuntime['guest']>[2])=>{calls++;if(calls===1&&phase.endsWith('completion')){signal=options?.signal;entered();await gate;}};
 const runtime:WindowsBackend&Pick<HyperVRuntime,'fingerprint'|'guest'|'management'>={info:async()=>({available:true,issues:[]}),fingerprint:async()=>'fixture',state:async()=>({state}),stop:driver.stop,create:async c=>{const file=windowsPaths(runtimeRoot,c.id).manifest;await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'{}');},start:async()=>{state='Running';},session:async()=>new WindowsNetworkSession(driver,'203.0.113.10'),connect:async()=>{},inspectGuard:inspection,guest:async(_c,_command,options)=>{assert.ok(phase.startsWith('download'));await complete(options);return JSON.stringify({data:Buffer.from('Synthetic download').toString('base64')});},management:async(_c,_command,options)=>{assert.ok(phase.startsWith('clipboard'));await complete(options);return '';}};
 const service=await createWindowsService({rootDir:root,dataDir:path.join(root,'app'),runtimeRoot,runtime,base:{image:path.join(root,'base.vhdx'),imageSha256:'b'.repeat(64)}});
 try{
  const e=await service.manager.create({name:'Synthetic clipboard session',cpus:1,memoryGiB:2,diskGiB:16,network:{mode:'http',host:'127.0.0.1',port:12345,strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.10'}}});
  const start=await service.manager.action(e.id,'start');await service.manager.wait(start.id);assert.equal(service.manager.store.jobs().find(job=>job.id===start.id)!.status,'succeeded');
  const oldSession=service.manager.sessions.get(e.id)!;
  const exchange=service.exchange!,authorize=exchange.authorize;
  if(phase.endsWith('authorization')){
   let first=true;exchange.authorize=async id=>{const authorized=await authorize(id);if(first){first=false;entered();await gate;}return authorized;};
  }
  const operate=()=>phase.startsWith('clipboard')?exchange.writeClipboard(e.id,'合成旧会话文字'):exchange.download(e.id,'downloads','synthetic.txt');
  const pending=assert.rejects(operate());
  await began;
  const stop=await service.manager.action(e.id,'stop');await service.manager.wait(stop.id);assert.equal(signal?.aborted,phase.endsWith('completion')?true:undefined);
  const restart=await service.manager.action(e.id,'start');await service.manager.wait(restart.id);assert.equal(service.manager.store.jobs().find(job=>job.id===restart.id)!.status,'succeeded');assert.notEqual(service.manager.sessions.get(e.id),oldSession);
  // Model a late successful SSH completion after cancellation, rather than
  // assuming cancellation always wins the race with process exit.
  release();await pending;
  const oldCalls=phase.endsWith('completion')?1:0;
  assert.equal(calls,oldCalls,'Old private work must never execute in the new guest session');
  assert.equal(service.manager.sessions.get(e.id)?.state,'active');
  assert.equal(service.exchange!.busy.has(e.id),false);
  await operate();assert.equal(calls,oldCalls+(phase.startsWith('clipboard')?3:1));
 }finally{release();await service.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});

test('Windows API requires its launch cookie, bearer token, valid Host and same Origin',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-service-'));
 await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist','index.html'),'<!doctype html><html><head><!-- MU_BOOTSTRAP --></head><body>fixture</body></html>');
 const runtime:WindowsBackend&Pick<HyperVRuntime,'fingerprint'>={info:async()=>({available:true,issues:[]}),fingerprint:async()=>'fixture',state:async()=>({state:'Off'}),stop:async()=>{},create:async()=>{},start:async()=>{},session:async()=>{throw Error('not used');},connect:async()=>{},inspectGuard:async()=>{throw Error('not used');}};
 const options={rootDir:root,dataDir:path.join(root,'app'),runtimeRoot:path.join(root,'vms'),runtime,base:{image:path.join(root,'base.vhdx'),imageSha256:'a'.repeat(64)}};
 let service:Awaited<ReturnType<typeof createWindowsService>>|undefined;
 try{
  service=await createWindowsService(options);
  const address=service.server.address();assert.ok(address&&typeof address==='object');assert.equal(address.address,'127.0.0.1');
  assert.equal((await fetch(service.url)).status,403);
  assert.equal((await fetch(service.url+'/api/snapshot')).status,401);
  assert.equal((await fetch(service.launchUrl()+'&launch=other',{redirect:'manual'})).status,403);
  const launch=await fetch(service.launchUrl(),{redirect:'manual'});assert.equal(launch.status,302);
  const cookie=launch.headers.get('set-cookie')!;assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
  const sessionCookie=cookie.split(';')[0];
  const page=await fetch(service.url,{headers:{Cookie:sessionCookie}});assert.equal(page.status,200);
  assert.match(page.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
  const bootstrap=JSON.parse((await page.text()).match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]);
  assert.equal(bootstrap.platform,'win32');
  const headers={Cookie:sessionCookie,Authorization:'Bearer '+bootstrap.token,'Content-Type':'application/json'};
  assert.equal((await fetch(service.url+'/api/windows/host',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(service.url+'/api/windows/host',{method:'POST',headers,body:JSON.stringify({features:['anything']})})).status,400);
  assert.equal((await fetch(service.url+'/api/windows/host',{method:'POST',headers,body:'{}'})).status,409);
  assert.equal((await fetch(service.url+'/api/windows/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(service.url+'/api/windows/setup',{method:'POST',headers,body:JSON.stringify({image:'C:\\outside.vhdx'})})).status,400);
  assert.equal((await fetch(service.url+'/api/windows/setup',{method:'POST',headers,body:'{}'})).status,409);
  assert.equal((await fetch(service.url+'/api/windows/storage')).status,401);
  assert.equal((await fetch(service.url+'/api/windows/storage',{headers})).status,409);
  assert.equal((await fetch(service.url+'/api/windows/resources')).status,401);
  assert.equal((await fetch(service.url+'/api/windows/resources',{headers})).status,409);
  assert.equal((await fetch(service.url+'/api/windows/power')).status,401);assert.equal((await fetch(service.url+'/api/windows/power',{headers})).status,409);
  assert.equal((await fetch(service.url+'/api/windows/storage/prune',{method:'POST',headers,body:JSON.stringify({plan:'a'.repeat(64),directory:'C:\\outside'})})).status,400);
  assert.equal((await fetch(service.url+'/api/windows/storage/prune',{method:'POST',headers,body:JSON.stringify({plan:'a'.repeat(64)})})).status,409);
  assert.equal((await fetch(service.url+'/api/snapshot',{headers:{Authorization:headers.Authorization}})).status,401);
  const wrongHost=await new Promise<number>(resolve=>{const request=httpRequest(service!.url+'/api/snapshot',{headers:{...headers,Host:'attacker.invalid'}},response=>{response.resume();resolve(response.statusCode!);});request.end();});
  assert.equal(wrongHost,403);
  assert.equal((await fetch(service.url+'/api/snapshot',{headers:{...headers,Origin:'http://attacker.invalid'}})).status,403);
  const input={name:'Local API fixture',cpus:1,memoryGiB:2,diskGiB:16,network:{mode:'http',host:'127.0.0.1',port:12345,strict:true,transparent:true,password:'local-only-fixture-password',egressLock:{expectedIp:'203.0.113.10'}}};
  assert.equal((await fetch(service.url+'/api/environments',{method:'POST',headers:{...headers,Origin:'http://attacker.invalid'},body:JSON.stringify(input)})).status,403);
  assert.equal(service.manager.store.list().length,0);
  const created=await fetch(service.url+'/api/environments',{method:'POST',headers,body:JSON.stringify(input)});assert.equal(created.status,201);
  const e=await created.json() as {id:string;network:{password?:string;passwordConfigured:boolean}};assert.equal(e.network.password,undefined);assert.equal(e.network.passwordConfigured,true);
  const snapshot=await fetch(service.url+'/api/snapshot',{headers});assert.equal(snapshot.status,200);assert.ok(!(await snapshot.text()).includes(input.network.password));
  assert.ok(!(await readFile(path.join(root,'app','state.sqlite-wal'))).includes(Buffer.from(input.network.password)));
  assert.equal((await fetch(service.url+'/api/environments/'+e.id+'/actions/delete',{method:'POST',headers})).status,400);
  assert.equal((await fetch(service.url+'/api/environments/'+e.id+'/browser/open',{method:'POST',headers})).status,409);
  await assert.rejects(createWindowsService(options),{code:'ALREADY_RUNNING'});
  await service.close();service=undefined;
  service=await createWindowsService(options);assert.equal(service.manager.store.list().length,1);
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});

test('Windows workspace lock releases cleanly and uses canonical directory identity',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-lock-'));let release:(()=>Promise<void>)|undefined;
 try{release=await acquireWindowsServiceLock(root);await assert.rejects(acquireWindowsServiceLock(root.toUpperCase()),{code:'ALREADY_RUNNING'});await release();release=await acquireWindowsServiceLock(root);}
 finally{await release?.();await rm(root,{recursive:true,force:true});}
});

test('Windows releases the workspace lock after its controller is killed',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-crash-lock-'));
 const source=`const {acquireWindowsServiceLock}=await import(${JSON.stringify(new URL('../server/platform/windows/service-lock.ts',import.meta.url).href)});await acquireWindowsServiceLock(process.argv[1]);process.stdout.write('locked');`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,root],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 let release:(()=>Promise<void>)|undefined;
 try{
  assert.equal(String((await once(child.stdout,'data'))[0]),'locked');
  await assert.rejects(acquireWindowsServiceLock(root),{code:'ALREADY_RUNNING'});
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  release=await acquireWindowsServiceLock(root);
 }finally{child.kill('SIGKILL');await release?.();await rm(root,{recursive:true,force:true});}
});

test('Default CLI and management paths share prepared bases and retain legacy runtime data',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-defaults-')),saved={local:process.env.LOCALAPPDATA,runtime:process.env.MU_WINDOWS_DATA_DIR,app:process.env.MU_WINDOWS_APP_DIR};
 let service:Awaited<ReturnType<typeof createWindowsService>>|undefined;
 try{
  process.env.LOCALAPPDATA=root;delete process.env.MU_WINDOWS_DATA_DIR;delete process.env.MU_WINDOWS_APP_DIR;
  const runtimeRoot=windowsRuntimeDirectory();await mkdir(runtimeRoot,{recursive:true});const base={image:path.join(root,'desktop.vhdx'),imageSha256:'a'.repeat(64)};await writeFile(path.join(runtimeRoot,'protected-desktop-base.json'),JSON.stringify(base));
  const runtime={info:async()=>({available:true,issues:[]}),fingerprint:async()=>'fixture',state:async()=>({state:'Off'}),stop:async()=>{},create:async()=>{},start:async()=>{},session:async()=>{throw Error('not used');},connect:async()=>{},inspectGuard:async()=>{throw Error('not used');}};
  service=await createWindowsService({rootDir:root,runtime});assert.equal(service.manager.options.runtimeRoot,runtimeRoot);assert.deepEqual(service.manager.options.base,base);const app=service.manager.store.dataDir;await service.close();service=undefined;
  const legacy=path.join(app,'hyperv');await mkdir(legacy);await writeFile(path.join(legacy,'protected-base.json'),JSON.stringify(base));assert.equal(windowsRuntimeDirectory(),legacy);
  service=await createWindowsService({rootDir:root,runtime});assert.equal(service.manager.options.runtimeRoot,legacy);assert.deepEqual(service.manager.options.base,base);
 }finally{await service?.close();if(saved.local===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=saved.local;if(saved.runtime===undefined)delete process.env.MU_WINDOWS_DATA_DIR;else process.env.MU_WINDOWS_DATA_DIR=saved.runtime;if(saved.app===undefined)delete process.env.MU_WINDOWS_APP_DIR;else process.env.MU_WINDOWS_APP_DIR=saved.app;await rm(root,{recursive:true,force:true});}
});
