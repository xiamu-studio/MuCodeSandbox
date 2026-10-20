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
import type {WindowsBackend} from '../server/platform/windows/manager.ts';
import type {HyperVRuntime} from '../server/platform/windows/runtime.ts';

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
