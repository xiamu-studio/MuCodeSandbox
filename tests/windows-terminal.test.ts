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
  const stale=await ticket(),closed=once(ws,'close'),stop=await service.manager.action(e.id,'stop');await service.manager.wait(stop.id);await closed;assert.equal(killed,1);
  const restart=await service.manager.action(e.id,'start');await service.manager.wait(restart.id);await rejected(socket(stale));assert.equal(spawned,1);
 }finally{for(const ws of sockets)ws.terminate();await service.close();await rm(root,{recursive:true,force:true});}
});
