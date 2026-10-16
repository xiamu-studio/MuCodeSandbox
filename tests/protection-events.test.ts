import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {protectionKind,protectionDisplayKind,protectionExplanation,probeProgress,recoverySteps,type ProtectionEvent} from '../shared/protection-events.ts';
import {environmentSchema} from '../server/validation.ts';
import type {Environment} from '../shared/types.ts';
import {Manager,protectionDiagnosticIssue} from '../server/manager.ts';
import {LimaRuntime} from '../server/runtime.ts';
import {EgressMismatchError} from '../server/egress.ts';
import {createService} from '../server/service.ts';
function env():Environment{return {...environmentSchema.parse({name:'Protected fixture',network:{mode:'socks5',host:'127.0.0.1',port:24898,strict:true,transparent:true,egressLock:{expectedIp:'8.8.8.8'}}}),id:randomUUID(),instanceName:'mu-event-fixture',state:'error',browserRunning:false,lastError:'Fixture unavailable',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};}
test('Protection failure classes explain repair without approving a changed IP',()=>{
 assert.equal(protectionKind('出口 IP 已变化'),'exit-changed');assert.equal(protectionKind('不足两个独立出口回执'),'exit-unavailable');assert.ok(recoverySteps('exit-changed').some(s=>s.includes('不会自动')));assert.ok(recoverySteps('tls').some(s=>s.includes('证书')));
});
test('A connection error is distinguished from missing quorum, including old stored classifications',()=>{
 const checks=[{receiver:'ipify' as const,status:'connection-error' as const}];
 assert.equal(protectionKind('无法确认批准的出口：curl: (56) peer reset',checks),'connection');
 const old={kind:'exit-unavailable',issue:'无法确认批准的出口：curl: (56) peer reset',checks} as ProtectionEvent;
 assert.equal(protectionDisplayKind(old),'connection');assert.equal(old.kind,'exit-unavailable');assert.ok(recoverySteps('connection').some(s=>s.includes('不会被当作普通超时')));
 assert.equal(probeProgress(checks[0]),null);
 assert.equal(probeProgress({...checks[0],diagnostics:{curlExitCode:56,httpStatus:0,tcpConnectMs:10,tlsHandshakeMs:200,firstByteMs:0,totalMs:910}}),'TLS 握手已完成，未收到 HTTP 状态');
 assert.equal(protectionDiagnosticIssue('curl: (56) peer reset\nMU_EGRESS_DIAGNOSTICS={"curlExitCode":"56"}\n'),'curl: (56) peer reset');
});
test('Diagnostic descriptions strip URI contents, proxy credentials and bearer tokens',()=>{
 const result=protectionDiagnosticIssue('https://user:MU_PASSWORD@proxy.test:443/auth?code=MU_CODE&state=MU_STATE grokbot://auth?code=MU_CALLBACK Bearer MU_BEARER');
 for(const value of ['MU_PASSWORD','MU_CODE','MU_STATE','MU_CALLBACK','MU_BEARER'])assert.ok(!result.includes(value));assert.ok(result.includes('proxy.test'));assert.ok(result.includes('链接内容已隐藏'));
});
test('Protection event persists through app restart, keeps original proof and is removed with its environment',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-events-'));let store=new Store(root);const e=env();store.save(e);
 const event={id:randomUUID(),environmentId:e.id,at:new Date().toISOString(),kind:'exit-changed' as const,issue:'Exit changed',source:'current' as const,route:{mode:'socks5',host:'127.0.0.1',port:24898},expectedIp:'8.8.8.8',observedIps:['9.9.9.9'],checks:[{receiver:'ipify' as const,status:'success' as const,ip:'9.9.9.9',latencyMs:23}],stopResult:'confirmed' as const,resolvedAt:null};
 try{store.addProtectionEvent(event);store.close();store=new Store(root);assert.deepEqual(store.protectionEvents(e.id)[0],event);store.resolveProtectionEvents(e.id,{at:new Date().toISOString(),ip:'8.8.8.8',receipts:[{receiver:'ipwho',ip:'8.8.8.8',latencyMs:1},{receiver:'ipify',ip:'8.8.8.8',latencyMs:2}]});const saved=store.protectionEvents(e.id)[0];assert.ok(saved.resolvedAt);assert.deepEqual(saved.observedIps,['9.9.9.9']);assert.equal(saved.resolution?.ip,'8.8.8.8');store.remove(e.id);assert.deepEqual(store.protectionEvents(e.id),[]);}
 finally{store.close();await rm(root,{recursive:true,force:true});}
});

const browser={native:false,available:async()=>true,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{}};
const receipts=[{receiver:'ipwho' as const,ip:'8.8.8.8',latencyMs:1},{receiver:'ipify' as const,ip:'8.8.8.8',latencyMs:2}];
async function managerFixture(){
 const root=await mkdtemp(path.join(tmpdir(),'mu-event-manager-')),runtime=new LimaRuntime(root);let running=false,instance='',stopCalls=0;let beforeStop:()=>void=()=>{};
 runtime.info=async()=>({available:true,path:'fixture',version:'fixture',error:null});runtime.list=async()=>instance?[{name:instance,status:running?'Running':'Stopped'}]:[];
 runtime.start=async e=>{running=true;instance=e.instanceName;};runtime.stop=async()=>{beforeStop();running=false;stopCalls++;};runtime.networkProtection=async()=>({active:true,integrity:'verified',leaseActive:true} as any);runtime.renewLease=async()=>{};runtime.revokeLease=async()=>{};
 const manager=new Manager(root,browser,runtime);clearInterval(manager.protectionTimer);await manager.networkObserver.close();
 const e=await manager.create({name:'Fault fixture',memoryGiB:1,network:{mode:'socks5',host:'127.0.0.1',port:24898,password:'MU_FAKE_ROUTE_SECRET',strict:true,transparent:true,egressLock:{expectedIp:'8.8.8.8'}}});
 manager.measureExit=async()=>({ip:'8.8.8.8',country:'fixture',city:'fixture',latencyMs:1,source:'guest',verification:{requiredReceivers:2,receipts,timedOutReceivers:[]}});
 const start=async()=>{const job=await manager.lifecycle(e.id,'start');await manager.tasks.get(job.id)?.promise;return manager.store.jobs().find(j=>j.id===job.id)!;};
 await start();return {root,runtime,manager,e,start,stopCalls:()=>stopCalls,setBeforeStop:(work:()=>void)=>{beforeStop=work;}};
}
test('Fault evidence is recorded before stopping, failed retries never approve another IP, and successful recovery keeps original evidence',async()=>{
 const f=await managerFixture();try{
  f.manager.measureExit=async()=>{throw new EgressMismatchError('9.9.9.9',[{receiver:'ipify',status:'success',ip:'9.9.9.9',latencyMs:7},{receiver:'ipwho',status:'pending'}]);};
  f.setBeforeStop(()=>{const rows=f.manager.protectionEvents(f.e.id);assert.ok(rows.length);assert.equal(rows[0].stopResult,'requested');assert.deepEqual(rows[0].observedIps,['9.9.9.9']);});
  await assert.rejects(f.manager.assertAccess(f.e.id));await Promise.all([...f.manager.quarantines.values()]);const first=f.manager.protectionEvents(f.e.id)[0];assert.equal(first.stopResult,'confirmed');assert.equal(first.kind,'exit-changed');assert.equal(first.checks[1].status,'pending');assert.equal(first.expectedIp,'8.8.8.8');
  assert.equal((await f.start()).status,'failed');assert.equal(f.manager.store.get(f.e.id).network.egressLock?.expectedIp,'8.8.8.8');assert.ok(f.manager.protectionEvents(f.e.id).every(e=>!e.resolvedAt));
  f.setBeforeStop(()=>{});f.manager.measureExit=async()=>({ip:'8.8.8.8',country:'fixture',city:'fixture',latencyMs:1,source:'guest',verification:{requiredReceivers:2,receipts,timedOutReceivers:[]}});
  assert.equal((await f.start()).status,'succeeded');const recovered=f.manager.protectionEvents(f.e.id).find(e=>e.id===first.id)!;assert.ok(recovered.resolvedAt);assert.equal(recovered.resolution?.ip,'8.8.8.8');assert.deepEqual(recovered.observedIps,['9.9.9.9']);assert.ok(!JSON.stringify(recovered).includes('MU_FAKE_ROUTE_SECRET'));
 }finally{await f.manager.close();await rm(f.root,{recursive:true,force:true});}
});
test('An event-storage failure cannot prevent stopping and is honestly marked as memory-only',async()=>{
 const f=await managerFixture();try{
  f.manager.store.addProtectionEvent=()=>{throw new Error('Synthetic disk full');};f.manager.measureExit=async()=>{throw new EgressMismatchError('9.9.9.9');};
  await assert.rejects(f.manager.assertAccess(f.e.id));await Promise.all([...f.manager.quarantines.values()]);assert.equal(f.stopCalls(),1);assert.equal(f.manager.protectionEvents(f.e.id)[0].persisted,false);assert.equal(f.manager.protectionEvents(f.e.id)[0].stopResult,'confirmed');
 }finally{await f.manager.close();await rm(f.root,{recursive:true,force:true});}
});
test('A newly recorded connection reset keeps a stored kind readable by the older application',async()=>{
 const f=await managerFixture();try{
  f.manager.measureExit=async()=>{throw new Error('curl: (56) peer reset');};
  await assert.rejects(f.manager.assertAccess(f.e.id));await Promise.all([...f.manager.quarantines.values()]);
  const event=f.manager.protectionEvents(f.e.id)[0];assert.equal(event.kind,'exit-unavailable');assert.equal(protectionDisplayKind(event),'connection');assert.equal(event.stopResult,'confirmed');assert.equal(event.resolvedAt,null);
 }finally{await f.manager.close();await rm(f.root,{recursive:true,force:true});}
});
test('A single old or mismatched receipt cannot resolve a stopped protection event',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-proof-resolution-')),store=new Store(root),e=env();store.save(e);
 const event={id:randomUUID(),environmentId:e.id,at:new Date().toISOString(),kind:'exit-unavailable' as const,issue:'Timeout',source:'current' as const,route:{mode:'socks5',host:'127.0.0.1',port:24898},expectedIp:'8.8.8.8',observedIps:[],checks:[],stopResult:'confirmed' as const,resolvedAt:null};
 try{store.addProtectionEvent(event);for(const rows of [[receipts[0]],[receipts[0],{...receipts[1],ip:'9.9.9.9'}],[receipts[0],receipts[0]]]){store.resolveProtectionEvents(e.id,{at:new Date().toISOString(),ip:'8.8.8.8',receipts:rows});assert.equal(store.protectionEvents(e.id)[0].resolvedAt,null);}}
 finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('Connection failure history requires the same independent matching proof before marking recovery',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-connection-recovery-')),store=new Store(root),e=env();store.save(e);
 const event:ProtectionEvent={id:randomUUID(),environmentId:e.id,at:new Date().toISOString(),kind:'connection',issue:'curl: (56) peer reset',source:'current',route:{mode:'socks5',host:'127.0.0.1',port:24898},expectedIp:'8.8.8.8',observedIps:[],checks:[{receiver:'ipify',status:'connection-error',diagnostics:{curlExitCode:56,httpStatus:0,tcpConnectMs:10,tlsHandshakeMs:200,firstByteMs:0,totalMs:910}}],stopResult:'confirmed',resolvedAt:null};
 try{store.addProtectionEvent(event);for(const rows of [[],[receipts[0]],[receipts[0],receipts[0]]]){store.resolveProtectionEvents(e.id,{at:new Date().toISOString(),ip:'8.8.8.8',receipts:rows});assert.equal(store.protectionEvents(e.id)[0].resolvedAt,null);}
 store.resolveProtectionEvents(e.id,{at:new Date().toISOString(),ip:'8.8.8.8',receipts});const saved=store.protectionEvents(e.id)[0];assert.ok(saved.resolvedAt);assert.deepEqual(saved.checks,event.checks);}
 finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('Earlier stop jobs remain visible as honest legacy summaries even if the old app has already restarted the VM',async()=>{
 const f=await managerFixture();try{
  const job=f.manager.store.newJob(f.e.id,'quarantine');f.manager.store.finishJob(job.id,'succeeded','无法确认批准的出口：不足两个独立出口回执');
  const rows=f.manager.protectionEvents(f.e.id);assert.equal(rows.length,1);assert.equal(rows[0].source,'legacy');assert.equal(rows[0].at,job.createdAt);assert.equal(rows[0].stopResult,'not-confirmed');assert.deepEqual(rows[0].checks,[]);assert.deepEqual(rows[0].observedIps,[]);assert.equal(f.manager.protectionEvents(f.e.id).length,1,'Legacy reading must not duplicate records');
 }finally{await f.manager.close();await rm(f.root,{recursive:true,force:true});}
});
test('Stopped event history is authenticated; legacy summaries invent no receipts and retry cannot change approved configuration',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-event-api-')),service=await createService({rootDir:path.resolve(import.meta.dirname,'..'),dataDir:root,port:0,browser});const e=env();e.lastError='环境已停止：不足两个独立出口回执';service.manager.store.save(e);
 const headers={Authorization:'Bearer '+service.token,'Content-Type':'application/json'},base=service.url+'/api/environments/'+e.id+'/protection-events';
 try{assert.equal((await fetch(base)).status,401);const r=await fetch(base,{headers});assert.equal(r.status,200);const records=await r.json() as any[];assert.equal(records[0].source,'legacy');assert.deepEqual(records[0].checks,[]);assert.deepEqual(records[0].observedIps,[]);
  assert.equal((await fetch(base+'/retry',{method:'POST',headers,body:'{"expectedIp":"9.9.9.9"}'})).status,400);assert.equal(service.manager.store.get(e.id).network.egressLock?.expectedIp,'8.8.8.8');
 }finally{await service.close();await rm(root,{recursive:true,force:true});}
});

test('Human incident summaries distinguish sleep, missing receipts and an unconfirmed stop',()=>{
 const base={kind:'host',issue:'电脑休眠，保护环境已关闭；唤醒后请手动启动',stopResult:'confirmed',checks:[],observedIps:[]} as unknown as ProtectionEvent;
 assert.match(protectionExplanation(base).reason,/电脑休眠/);
 assert.match(protectionExplanation(base).next,/唤醒/);
 const failed={...base,stopResult:'failed' as const};
 assert.match(protectionExplanation(failed).next,/启动环境/);assert.ok(!protectionExplanation(failed).reason.includes('服务已关闭'));
 assert.ok(!protectionExplanation(failed).reason.includes('已停止'));
 const missing={...base,kind:'exit-unavailable' as const,issue:'不足两个独立出口回执'};
 assert.match(protectionExplanation(missing).reason,/至少两处一致/);
 assert.ok(!protectionExplanation(missing).reason.includes('IP 与批准值不同'));
 const changed={...missing,kind:'exit-changed' as const,expectedIp:'203.0.113.8',observedIps:['203.0.113.9']};
 assert.match(protectionExplanation(changed).reason,/203.0.113.8 → 203.0.113.9/);
});
