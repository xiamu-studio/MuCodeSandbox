import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {IPty} from 'node-pty';
import {WebSocket} from 'ws';
import {createWindowsService,type WindowsServiceOptions} from '../server/platform/windows/service.ts';
import {WindowsNetworkSession} from '../server/platform/windows/session.ts';
import {windowsPaths} from '../server/platform/windows/config.ts';
import {WindowsTerminalServer} from '../server/platform/windows/terminal.ts';

test('Windows terminal authenticates the upgrade, consumes tickets and revokes stopped sessions',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-win-terminal-'));await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/index.html'),'<!-- MU_BOOTSTRAP -->');
 let active=false,running=false,spawned=0,killed=0;const writes:string[]=[],sizes:number[][]=[];
 const runtime:NonNullable<WindowsServiceOptions['runtime']>={info:async()=>({available:true,issues:[]}),fingerprint:async()=>'fixture',state:async()=>({state:running?'Running':'Off'}),create:async c=>{const p=windowsPaths(root,c.id);await mkdir(p.directory,{recursive:true});await writeFile(p.manifest,'{}');},start:async()=>{running=true;},stop:async()=>{running=false;active=false;},connect:async()=>{},inspectGuard:async()=>({digest:'a'.repeat(64),leaseActive:active,remainingMs:active?45000:0}),
  terminalLaunch:async()=>({file:'fixture-ssh.exe',args:[],env:{},cwd:root}),
  session:async c=>{active=false;return new WindowsNetworkSession({inspect:async()=>({digest:'a'.repeat(64),leaseActive:active,remainingMs:active?45000:0}),probe:async()=>[{receiver:'a',ip:c.expectedIp},{receiver:'b',ip:c.expectedIp}],activate:async()=>{active=true;},renew:async()=>{},revoke:async()=>{active=false;},disconnect:async()=>{},stop:async()=>{running=false;active=false;}},c.expectedIp);}};
 const service=await createWindowsService({rootDir:root,dataDir:path.join(root,'app'),runtimeRoot:root,base:{image:path.join(root,'base.vhdx'),imageSha256:'a'.repeat(64)},runtime,ptyFactory:(_file,_args,options)=>{
  assert.equal(options.useConptyDll,true);spawned++;const events=new EventEmitter();let dead=false;
  return {write:(data:string)=>{writes.push(data);events.emit('data',data);},resize:(cols:number,rows:number)=>sizes.push([cols,rows]),kill:()=>{if(!dead){dead=true;killed++;events.emit('exit',{exitCode:0});}},onData:(fn:(value:string)=>void)=>{events.on('data',fn);return {dispose:()=>events.off('data',fn)};},onExit:(fn:(value:{exitCode:number})=>void)=>{events.on('exit',fn);return {dispose:()=>events.off('exit',fn)};}} as unknown as IPty;
 }});
 const sockets:WebSocket[]=[];
 try{
  const launch=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
  const html=await(await fetch(service.url,{headers:{Cookie:cookie}})).text(),token=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]).token;
  const headers={Cookie:cookie,Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const e=await service.manager.create({name:'Terminal fixture',cpus:1,memoryGiB:2,diskGiB:16,network:{mode:'http',host:'127.0.0.1',port:1234,strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.10'}}});
  const start=await service.manager.action(e.id,'start');await service.manager.wait(start.id);
  async function ticket(){const result=await fetch(service.url+`/api/environments/${e.id}/terminal-ticket`,{method:'POST',headers,body:'{"command":"shell","cols":80,"rows":24}'});assert.equal(result.status,200);return (await result.json() as {ticket:string}).ticket;}
  function socket(key:string,origin=service.url,sessionCookie=cookie){const ws=new WebSocket(service.url.replace('http:','ws:')+'/terminal?ticket='+key,{headers:{Origin:origin,Cookie:sessionCookie}});sockets.push(ws);return ws;}
  async function rejected(ws:WebSocket){await new Promise<void>((resolve,reject)=>{ws.once('open',()=>reject(Error('Unauthorized upgrade opened')));ws.once('error',()=>resolve());ws.once('close',()=>resolve());});}
  await rejected(socket(await ticket(),'http://attacker.invalid'));await rejected(socket(await ticket(),service.url,''));assert.equal(spawned,0);
  const key=await ticket(),ws=socket(key);const messages:string[]=[];ws.on('message',data=>messages.push(data.toString()));await once(ws,'open');
  await rejected(socket(key));assert.equal(spawned,1);
  ws.send(JSON.stringify({type:'input',data:'中文 input'}));ws.send(JSON.stringify({type:'resize',cols:10000,rows:-1}));
  const deadline=Date.now()+3000;while(!writes.length||!sizes.length){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,10));}
  assert.deepEqual(writes,['中文 input']);assert.deepEqual(sizes,[[300,5]]);assert.ok(messages.some(value=>value.includes('connected')));
  for(const action of ['open-browser','close-browser']){
   let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
   const job=await service.manager.submit(e.id,action,async()=>{entered();await gate;});await started;
   try{
    ws.send(JSON.stringify({type:'input',data:action}));const deadline=Date.now()+3000;while(!writes.includes(action)){assert.ok(Date.now()<deadline,'Existing terminal input lost during '+action);await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(ws.readyState,WebSocket.OPEN);assert.equal(killed,0);
    const pending=await fetch(service.url+`/api/environments/${e.id}/terminal-ticket`,{method:'POST',headers,body:'{"command":"shell","cols":80,"rows":24}'});assert.notEqual(pending.status,200,'A browser job must not admit new terminal sessions');
   }finally{release();await service.manager.wait(job.id);}
  }
  const stale=await ticket(),closed=once(ws,'close'),stop=await service.manager.action(e.id,'stop');await service.manager.wait(stop.id);await closed;assert.equal(killed,1);
  const restart=await service.manager.action(e.id,'start');await service.manager.wait(restart.id);await rejected(socket(stale));assert.equal(spawned,1);
  const protectedWs=socket(await ticket());await once(protectedWs,'open');assert.equal(spawned,2);
  let finishBrowser!:()=>void,browserEntered!:()=>void;const browserGate=new Promise<void>(resolve=>finishBrowser=resolve),browserStarted=new Promise<void>(resolve=>browserEntered=resolve);
  const browserJob=await service.manager.submit(e.id,'open-browser',async()=>{browserEntered();await browserGate;});await browserStarted;
  try{const revoked=once(protectedWs,'close');await service.manager.failProtection(e.id,'Synthetic protection failure');await revoked;assert.equal(killed,2);assert.equal(service.manager.sessions.has(e.id),false);}
  finally{finishBrowser();await service.manager.wait(browserJob.id);}
 }finally{for(const ws of sockets)ws.terminate();await service.close();await rm(root,{recursive:true,force:true});}
});

test('Disconnected Windows ticket requests cancel authorization without issuing a late ticket or retiring the healthy session',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-win-terminal-cancel-'));await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/index.html'),'<!-- MU_BOOTSTRAP -->');
 let active=false,running=false,issued=0,hook:((signal?:AbortSignal)=>Promise<{digest:string;leaseActive:boolean;remainingMs:number}>)|undefined;
 const inspection=()=>({digest:'a'.repeat(64),leaseActive:active,remainingMs:active?45000:0});
 const runtime:NonNullable<WindowsServiceOptions['runtime']>={info:async()=>({available:true,issues:[]}),fingerprint:async()=>'fixture',state:async()=>({state:running?'Running':'Off'}),create:async c=>{const p=windowsPaths(root,c.id);await mkdir(p.directory,{recursive:true});await writeFile(p.manifest,'{}');},start:async()=>{running=true;},stop:async()=>{running=false;active=false;},connect:async()=>{},inspectGuard:async(_c,options={})=>{const pending=hook;hook=undefined;return pending?pending(options.signal):inspection();},terminalLaunch:async()=>({file:'synthetic-only',args:[],env:{},cwd:root}),session:async c=>{active=false;return new WindowsNetworkSession({inspect:async()=>inspection(),probe:async()=>[{receiver:'a',ip:c.expectedIp},{receiver:'b',ip:c.expectedIp}],activate:async()=>{active=true;},renew:async()=>{},revoke:async()=>{active=false;},disconnect:async()=>{},stop:async()=>{running=false;active=false;}},c.expectedIp);}};
 const issue=WindowsTerminalServer.prototype.issue;t.mock.method(WindowsTerminalServer.prototype,'issue',function(this:WindowsTerminalServer,...args:Parameters<typeof issue>){issued++;return issue.apply(this,args);});
 const service=await createWindowsService({rootDir:root,dataDir:path.join(root,'app'),runtimeRoot:root,base:{image:path.join(root,'base.vhdx'),imageSha256:'a'.repeat(64)},runtime,ptyFactory:()=>{throw Error('No test PTY expected');}});
 const releases:(()=>void)[]=[];
 try{
  const launch=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0],html=await(await fetch(service.url,{headers:{Cookie:cookie}})).text(),token=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]).token;
  const headers={Cookie:cookie,Authorization:'Bearer '+token,'Content-Type':'application/json'},e=await service.manager.create({name:'Synthetic terminal cancellation',network:{mode:'http',host:'127.0.0.1',port:1234,strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.10'}}});await service.manager.wait((await service.manager.action(e.id,'start')).id);
  const original=service.manager.sessions.get(e.id),url=service.url+`/api/environments/${e.id}/terminal-ticket`,body='{"command":"shell","cols":80,"rows":24}';
  for(const mode of ['honors-abort','late-valid'] as const){
   let enter!:()=>void,cancelled!:(value:boolean)=>void,finish!:()=>void,release!:(value:ReturnType<typeof inspection>)=>void,reject!:(reason:unknown)=>void;
   const entered=new Promise<void>(r=>enter=r),observed=new Promise<boolean>(r=>cancelled=r),done=new Promise<void>(r=>finish=r),held=new Promise<ReturnType<typeof inspection>>((r,j)=>{release=r;reject=j;});releases.push(()=>release(inspection()));
   hook=async signal=>{const cancel=()=>{cancelled(true);if(mode==='honors-abort')reject(signal!.reason);};signal?.addEventListener('abort',cancel,{once:true});enter();try{return await held;}finally{signal?.removeEventListener('abort',cancel);finish();}};
   const controller=new AbortController(),before=issued,pending=fetch(url,{method:'POST',headers,body,signal:controller.signal}).catch(error=>error);await entered;controller.abort();await pending;
   let timer:ReturnType<typeof setTimeout>|undefined;const sawAbort=await Promise.race([observed,new Promise<boolean>(r=>timer=setTimeout(()=>r(false),1000))]);clearTimeout(timer);release(inspection());await done;await new Promise<void>(r=>setImmediate(r));
   assert.equal(sawAbort,true,mode+' did not receive cancellation');assert.equal(issued,before,mode+' issued a late ticket');assert.equal(service.manager.sessions.get(e.id),original);assert.equal(original?.state,'active');assert.equal(service.manager.protectionRecords.list(e.id).length,0);
  }
  const retry=await fetch(url,{method:'POST',headers,body});assert.equal(retry.status,200);assert.equal(typeof (await retry.json() as {ticket:string}).ticket,'string');assert.equal(issued,1);
 }finally{hook=undefined;for(const release of releases)release();await service.close();assert.equal(path.dirname(root),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
