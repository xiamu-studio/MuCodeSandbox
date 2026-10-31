import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.ts';
import type {Environment} from '../shared/types.ts';
import type {WindowsManager} from '../server/platform/windows/manager.ts';
import type {HyperVRuntime} from '../server/platform/windows/runtime.ts';
import {WindowsNetworkSession} from '../server/platform/windows/session.ts';
import {WindowsNetworkObservations,observationFailureCategory} from '../server/platform/windows/network-observations.ts';
import {AppError} from '../server/errors.ts';

const expected='203.0.113.10';
async function session(){let active=false;const value=new WindowsNetworkSession({inspect:async()=>({digest:'a'.repeat(64),leaseActive:active,remainingMs:active?30000:0}),probe:async()=>[{receiver:'ipwho',ip:expected,latencyMs:15},{receiver:'ipify',ip:expected,latencyMs:12}],activate:async()=>{active=true;},renew:async()=>{},revoke:async()=>{},disconnect:async()=>{},stop:async()=>{}},expected);await value.open();return value;}
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-observations-')),store=new Store(root),now=new Date().toISOString();
 const environment:Environment={id:randomUUID(),instanceName:'fixture',name:'Windows合成网络记录',description:'',kind:'vm',color:'blue',cpus:2,memoryGiB:4,diskGiB:32,mounts:[],ports:[],identity:{timezone:'Asia/Taipei',locale:'zh-CN'},network:{mode:'http',host:'127.0.0.1',port:7897,password:'PRIVATE_PROXY_PASSWORD',username:'',noProxy:'localhost,127.0.0.1',strict:true,transparent:true,egressLock:{expectedIp:expected}},browserUrl:'about:blank',state:'running',browserRunning:false,lastError:null,createdAt:now,updatedAt:now};store.save(environment);
 const sessions=new Map([[environment.id,await session()]]),active=new Map<string,string>(),calls:{kind:string;command:string[]}[]=[],hooks:{management?:(command:string[])=>Promise<string>;guest?:()=>Promise<string>}={};
 const manager={store,sessions,active,guestOperationBusy:(id:string)=>active.has(id),assertAccess:async(id:string)=>{if(store.get(id).state!=='running'||sessions.get(id)?.state!=='active'||active.has(id))throw Error('Fixture is not available');return store.get(id);},profile:async()=>({id:environment.id})} as unknown as WindowsManager;
 const runtime={management:async(_config,command)=>{calls.push({kind:'management',command});return hooks.management?hooks.management(command):command.includes('show')?'mucodesandbox-network\n':'';},guest:async(_config,command)=>{calls.push({kind:'guest',command});return hooks.guest?hooks.guest():JSON.stringify({ip:expected});}} as Pick<HyperVRuntime,'guest'|'management'>;
 const subject=new WindowsNetworkObservations(manager,runtime,false);
 const journal=(message:string,index:number,at=Date.now())=>JSON.stringify({__CURSOR:`s=fixture;i=${index}`,__REALTIME_TIMESTAMP:String(at*1000),_BOOT_ID:'fixture-boot',_SYSTEMD_INVOCATION_ID:'fixture-service',MESSAGE:message});
 return {root,store,environment,sessions,active,calls,hooks,subject,journal,close:async()=>{await subject.close();store.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}};
}
test('Windows catalog records original guest exit receipts and parses real journal-format domain/server metadata',async()=>{
 const f=await fixture();try{
  const at=f.sessions.get(f.environment.id)!.verifiedAt!;let info=f.subject.info(f.environment.id);assert.equal(info.sampleIntervalSeconds,30,'The advertised independent sampling interval must match the shared collector, not the 8-second polling timer');assert.equal(info.summary.lastIp,expected);assert.ok(info.samples.every(sample=>sample.at===at));assert.equal(info.samples.length,2);f.subject.info(f.environment.id);assert.equal(f.subject.info(f.environment.id).samples.length,2);
  const time=Date.parse(at)+1;f.hooks.management=async command=>command.includes('show')?'mucodesandbox-network\n':[
   f.journal('INFO [0042] [42 0ms] inbound/tun[tun-in]: inbound connection to docs.example:443',1,time),
   f.journal('INFO [0042] [42 0ms] dns: lookup succeed for docs.example: 203.0.113.44',2,time),
   f.journal('INFO [0042] [42 0ms] outbound/http[upstream]: outbound connection to 203.0.113.44:443',3,time),
   f.journal('INFO outbound/http[upstream]: outbound connection to 203.0.113.55:443',4,Date.parse(at)-1000),
  ].join('\n');await f.subject.tick();info=f.subject.info(f.environment.id,{scope:'all'});assert.equal(info.capture,'ready');const connection=info.connections.find(row=>row.target==='203.0.113.44')!;assert.equal(connection.domain,'docs.example');assert.equal(connection.exitIp,expected);assert.equal(connection.exitCheckedAt,at);assert.equal(info.connections.find(row=>row.target==='203.0.113.55')!.exitIp,undefined);assert.equal(f.subject.info(f.environment.id,{scope:'all',q:'docs.example'}).connections.length,1);assert.ok(f.calls.some(call=>call.kind==='management'&&call.command.includes('--namespace=mucodesandbox-network')));assert.equal(JSON.stringify(info).includes('PRIVATE_PROXY_PASSWORD'),false);
 }finally{await f.close();}
});
test('Late Windows journal and probe completions cannot enter a restarted session',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>entered=resolve);
 try{f.hooks.management=async command=>{if(command.includes('show'))return 'mucodesandbox-network';entered();await gate;return f.journal('INFO outbound/http[upstream]: outbound connection to stale.example:443',1);};f.hooks.guest=async()=>{await gate;return JSON.stringify({ip:'203.0.113.99'});};const pending=f.subject.tick();await began;f.sessions.set(f.environment.id,await session());f.subject.info(f.environment.id);release();await pending;await new Promise(resolve=>setImmediate(resolve));const current=f.subject.info(f.environment.id,{scope:'all'});assert.equal(current.connections.length,0);assert.equal(current.samples.some(row=>row.ip==='203.0.113.99'),false);assert.equal(current.summary.lastIp,expected);
 }finally{release();await f.close();}
});
test('Stopped Windows guests retain historical IPs and connections without issuing new guest commands',async()=>{
 const f=await fixture();try{f.hooks.management=async command=>command.includes('show')?'mucodesandbox-network':f.journal('INFO outbound/http[upstream]: outbound connection to history.example:443',1);await f.subject.tick();f.store.state(f.environment.id,'stopped');f.sessions.delete(f.environment.id);const count=f.calls.length,history=f.subject.info(f.environment.id,{scope:'all'});assert.equal(history.enabled,false);assert.equal(history.summary.lastIp,expected);assert.equal(history.connections[0].target,'history.example');await f.subject.tick();assert.equal(f.calls.length,count);}finally{await f.close();}
});
test('Windows capture and observation errors remain explicit and do not copy raw diagnostics or host fallback addresses',async()=>{
 const f=await fixture();try{f.hooks.management=async()=>{throw Error('PRIVATE_PROXY_PASSWORD');};f.hooks.guest=async()=>{throw Error('PRIVATE_PROXY_PASSWORD');};await f.subject.tick();await f.subject.observer.sample(f.environment);const info=f.subject.info(f.environment.id);assert.equal(info.capture,'error');assert.ok(info.captureGaps);assert.ok(info.samples.some(row=>row.status==='failed'));assert.equal(JSON.stringify(info).includes('PRIVATE_PROXY_PASSWORD'),false);assert.equal(info.connections.length,0);assert.ok(f.calls.filter(call=>call.kind==='guest').every(call=>call.command[0]==='/usr/bin/curl'&&!call.command.includes('--proxy')));}finally{await f.close();}
});
test('Windows observation failures retain only a bounded category, without changing protection',async()=>{
 const f=await fixture();try{
  f.subject.info(f.environment.id);
  const cases:[unknown,string][]=[[new Error('curl: (35) PRIVATE_PROXY_PASSWORD'),'tls'],[new Error('curl: (28) PRIVATE_PROXY_PASSWORD'),'timeout'],[new Error('curl: (6) PRIVATE_PROXY_PASSWORD'),'dns'],[new Error('curl: (97) PRIVATE_PROXY_PASSWORD'),'connection'],[new Error('proxy authentication PRIVATE_PROXY_PASSWORD'),'auth'],[new AppError('secret',409,'CANCELLED'),'interrupted'],[new SyntaxError('secret'),'invalid'],[new Error('PRIVATE_PROXY_PASSWORD'),'unknown']];
  for(const [error,category] of cases){assert.equal(observationFailureCategory(error),category);f.hooks.guest=async()=>{throw error;};await f.subject.observer.sample(f.environment);const info=f.subject.info(f.environment.id),last=info.samples.at(-1)!;assert.equal(last.status,'failed');assert.equal(last.failureReason,category);assert.ok(!JSON.stringify(info).includes('PRIVATE_PROXY_PASSWORD'));assert.equal(f.sessions.get(f.environment.id)?.state,'active');}
 }finally{await f.close();}
});
test('A changed Windows line isolates its retained history and busy environments do not collect',async()=>{
 const f=await fixture();try{f.subject.info(f.environment.id);f.active.set(f.environment.id,randomUUID());await f.subject.tick();assert.equal(f.calls.length,0);f.active.clear();f.store.save({...f.environment,network:{...f.environment.network,port:8888}});assert.equal(f.subject.info(f.environment.id).connections.length,0);assert.equal(f.subject.info(f.environment.id).samples.length,0);assert.equal(f.subject.info(f.environment.id).summary.lastIp,null);}finally{await f.close();}
});
