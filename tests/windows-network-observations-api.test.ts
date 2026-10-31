import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createWindowsService} from '../server/platform/windows/service.ts';
import {WindowsNetworkSession} from '../server/platform/windows/session.ts';
import type {HyperVRuntime} from '../server/platform/windows/runtime.ts';
import type {WindowsBackend} from '../server/platform/windows/manager.ts';

test('Windows network observation endpoints require the local session and expose retained guest IP metadata without arbitrary probe destinations',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-observation-api-'));await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/index.html'),'<!doctype html><!-- MU_BOOTSTRAP -->');let commandCount=0,active=false;
 const runtime:WindowsBackend&Pick<HyperVRuntime,'fingerprint'|'guest'|'management'>={fingerprint:async()=>'fixture',info:async()=>({available:true,issues:[]}),state:async()=>({state:'Off'}),create:async()=>{throw Error('No VM creation');},start:async()=>{throw Error('No VM start');},stop:async()=>{},session:async()=>{throw Error('No native session');},connect:async()=>{},inspectGuard:async()=>({digest:'a'.repeat(64),leaseActive:active,remainingMs:active?30000:0}),guest:async(_c,args)=>{commandCount++;assert.equal(args[0],'/usr/bin/curl');return JSON.stringify({ip:'203.0.113.10'});},management:async(_c,args)=>{commandCount++;return args.includes('show')?'mucodesandbox-network\n':JSON.stringify({__CURSOR:'s=windows;i=1',__REALTIME_TIMESTAMP:String(Date.now()*1000),MESSAGE:'INFO outbound/http[upstream]: outbound connection to api.example:443'});}};
 const service=await createWindowsService({rootDir:root,dataDir:path.join(root,'app'),runtimeRoot:path.join(root,'runtime'),runtime,base:{image:path.join(root,'base.vhdx'),imageSha256:'a'.repeat(64)}});
 try{
  const launch=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=launch.headers.getSetCookie()[0].split(';')[0],html=await(await fetch(service.url+'/',{headers:{Cookie:cookie}})).text(),bootstrap=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]);assert.equal(bootstrap.capabilities.networkObservations,true);
  const headers={Cookie:cookie,Authorization:'Bearer '+bootstrap.token,'Content-Type':'application/json'},request=(endpoint:string,method='GET',body?:unknown)=>fetch(service.url+'/api'+endpoint,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const created=await request('/environments','POST',{name:'Windows网络接口合成环境',cpus:2,memoryGiB:2,diskGiB:32,network:{mode:'http',host:'127.0.0.1',port:7897,password:'PRIVATE_PROXY_PASSWORD',strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.10'}}});assert.equal(created.status,201);const environment=await created.json(),endpoint=`/environments/${environment.id}/network/observations`;
  for(const partial of [{},{Cookie:cookie},{Authorization:headers.Authorization}] as Record<string,string>[]){const response=await fetch(service.url+'/api'+endpoint,{headers:partial});assert.equal(response.status,401);}assert.equal(commandCount,0);
  service.manager.store.state(environment.id,'running');const session=new WindowsNetworkSession({inspect:runtime.inspectGuard as never,probe:async()=>[{receiver:'ipwho',ip:'203.0.113.10',latencyMs:12},{receiver:'ipify',ip:'203.0.113.10',latencyMs:13}],activate:async()=>{active=true;},renew:async()=>{},revoke:async()=>{},disconnect:async()=>{},stop:async()=>{}},'203.0.113.10');await session.open();service.manager.sessions.set(environment.id,session);
  const initial=await(await request(endpoint)).json();assert.equal(initial.summary.lastIp,'203.0.113.10');assert.ok(initial.samples.every((row:{at:string})=>row.at===session.verifiedAt));assert.equal(commandCount,0);
  await service.networkObservations!.tick();const observed=await(await request(endpoint+'?scope=all&q=api.example')).json();assert.equal(observed.connections[0].target,'api.example');assert.equal(observed.connections[0].exitIp,'203.0.113.10');assert.equal(JSON.stringify(observed).includes('PRIVATE_PROXY_PASSWORD'),false);
  for(const action of ['install-agent','snapshot-export','snapshot-delete-live'] as const){
   let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),work=async()=>gate;
   const job=action==='install-agent'?service.manager.runAgentInstall(environment.id,work):action==='snapshot-export'?service.manager.runSnapshotExport(environment.id,work):service.manager.runLiveSnapshotDeletion(environment.id,work);
   try{await service.networkObservations!.tick();assert.equal((await request(endpoint,'POST',{})).status,200);const during=await(await request(endpoint+'?scope=all&q=api.example')).json();assert.equal(during.connections[0].exitIp,'203.0.113.10');assert.equal(during.connections[0].exitCheckedAt,session.verifiedAt);assert.equal(during.summary.lastIp,'203.0.113.10');assert.equal(service.manager.sessions.get(environment.id),session);assert.equal(service.manager.store.get(environment.id).state,'running');}
   finally{release();await service.manager.wait(job.id);}
  }
  console.log(JSON.stringify({diagnostic:'windows-observation-passive-api',actualHttp:true,actualManagerTasks:true,actions:['install-agent','snapshot-export','snapshot-delete-live'],guestAdapter:true,realHyperV:false,originalReceiptTimePreserved:true}));
  for(const query of ['?before=0','?scope=unknown','?q='+encodeURIComponent('x'.repeat(254)),'?url=https://arbitrary.example'])assert.equal((await request(endpoint+query)).status,400);
  const count=commandCount;assert.equal((await request(endpoint,'POST',{url:'https://arbitrary.example'})).status,400);assert.equal(commandCount,count);assert.equal((await request(endpoint,'POST',{})).status,200);
  service.manager.store.state(environment.id,'stopped');service.manager.sessions.delete(environment.id);const stopped=await(await request(endpoint)).json();assert.equal(stopped.enabled,false);assert.equal(stopped.summary.lastIp,'203.0.113.10');assert.equal((await request(endpoint,'POST',{})).status,409);
 }finally{await service.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
