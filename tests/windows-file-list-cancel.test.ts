import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createWindowsService,type WindowsServiceOptions} from '../server/platform/windows/service.ts';
import {WindowsNetworkSession} from '../server/platform/windows/session.ts';
import {windowsPaths} from '../server/platform/windows/config.ts';
import {FILE_EXCHANGE_PYTHON} from '../server/guest-exchange.ts';
import {AppError} from '../server/errors.ts';

for(const phase of ['guest-read','authorization'] as const)for(const operation of ['listing','download'] as const)test(`Windows ${operation} HTTP disconnect cancels ${phase} and permits a retry`,{skip:process.platform!=='win32',timeout:30000},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-list-cancel-')),runtimeRoot=path.join(root,'runtime');await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/index.html'),'<!-- MU_BOOTSTRAP -->');
 let state='Off',lease=false,entered!:()=>void,observedAbort!:()=>void,releaseAuthorization:(()=>void)|undefined;const began=new Promise<void>(resolve=>entered=resolve),aborted=new Promise<void>(resolve=>observedAbort=resolve);let slow=phase==='guest-read';
 const inspection=async()=>({digest:'a'.repeat(64),leaseActive:lease,remainingMs:lease?40000:0}),driver={inspect:inspection,probe:async()=>[{receiver:'local-a',ip:'203.0.113.10'},{receiver:'local-b',ip:'203.0.113.10'}],activate:async()=>{lease=true;},renew:async()=>{},revoke:async()=>{lease=false;},disconnect:async()=>{},stop:async()=>{state='Off';lease=false;}};
 const runtime:NonNullable<WindowsServiceOptions['runtime']>={info:async()=>({available:true,issues:[]}),fingerprint:async()=>'fixture',state:async()=>({state}),stop:driver.stop,create:async c=>{const file=windowsPaths(runtimeRoot,c.id).manifest;await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'{}');},start:async()=>{state='Running';},session:async()=>new WindowsNetworkSession(driver,'203.0.113.10'),connect:async()=>{},inspectGuard:inspection,management:async()=>'',guest:async(_c,_args,options={})=>{const [program,input]=options.input!.split('\n');assert.equal(JSON.parse(program),FILE_EXCHANGE_PYTHON);assert.equal(JSON.parse(input).action,operation==='listing'?'browse':'download');assert.ok(options.signal);if(!slow)return operation==='listing'?'{"files":[],"total":0,"nextCursor":null}':JSON.stringify({data:Buffer.from('local\n').toString('base64')});entered();return await new Promise<string>((_resolve,reject)=>options.signal!.addEventListener('abort',()=>{observedAbort();reject(options.signal!.reason);},{once:true}));}};
 const service=await createWindowsService({rootDir:root,dataDir:path.join(root,'app'),runtimeRoot,runtime,base:{image:path.join(root,'base.vhdx'),imageSha256:'b'.repeat(64)}});
 try{
  const launched=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=launched.headers.get('set-cookie')!.split(';')[0],html=await(await fetch(service.url,{headers:{Cookie:cookie}})).text(),boot=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]),headers={Cookie:cookie,Authorization:'Bearer '+boot.token};
  const e=await service.manager.create({name:'Synthetic listing',cpus:1,memoryGiB:2,diskGiB:16,network:{mode:'http',host:'127.0.0.1',port:12345,strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.10'}}});const job=await service.manager.action(e.id,'start');await service.manager.wait(job.id);assert.equal(service.manager.store.jobs().find(item=>item.id===job.id)!.status,'succeeded');
  if(phase==='authorization')runtime.inspectGuard=async(_config,options={})=>{entered();return new Promise((resolve,reject)=>{releaseAuthorization=()=>{void inspection().then(resolve);};options.signal?.addEventListener('abort',()=>{observedAbort();reject(new AppError('Synthetic authorization cancelled',409,'CANCELLED'));},{once:true});});};
  const url=service.url+'/api/environments/'+e.id+(operation==='listing'?'/transfer-files?directory=1&zone=downloads&path=':'/transfer-download');
  const init=operation==='listing'?{headers}:{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({zone:'downloads',name:'synthetic.txt'})};
  const controller=new AbortController(),pending=fetch(url,{...init,signal:controller.signal});await Promise.race([began,pending.then(response=>{throw Error('Read returned early: '+response.status);}),delay(5000).then(()=>{throw Error('Guest read did not start');})]);controller.abort();await assert.rejects(pending);await Promise.race([aborted,delay(3000).then(()=>{throw Error('Guest read was not cancelled');})]);
  const deadline=Date.now()+3000;while(service.exchange!.busy.has(e.id)){assert.ok(Date.now()<deadline);await delay(10);}slow=false;runtime.inspectGuard=inspection;assert.equal(service.manager.store.get(e.id).state,'running');assert.equal(service.manager.store.protectionEvents(e.id).length,0);const next=await fetch(url,init);assert.equal(next.status,200);if(operation==='listing')assert.deepEqual(await next.json(),{files:[],total:0,nextCursor:null});else assert.equal(await next.text(),'local\n');
 }finally{releaseAuthorization?.();await service.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-list-cancel-/);await rm(root,{recursive:true,force:true});}
});
