import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Environment} from '../shared/types.ts';
import {createWindowsService} from '../server/platform/windows/service.ts';
import type {WindowsBackend} from '../server/platform/windows/manager.ts';
import type {HyperVRuntime} from '../server/platform/windows/runtime.ts';
import type {WindowsSnapshotRecord} from '../server/platform/windows/snapshots.ts';
import type {WindowsSnapshotCoordinatorPort} from '../server/platform/windows/snapshot-product.ts';
import {WindowsNetworkSession} from '../server/platform/windows/session.ts';

async function fixture(enabled=false,liveDeletion=false){
 const root=await mkdtemp(path.join(tmpdir(),'mu-snapshot-api-'));await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/index.html'),'<!doctype html><!-- MU_BOOTSTRAP -->');const calls:string[]=[],pending=new Set<string>(),records:WindowsSnapshotRecord[]=[];let corruptList=false,stagingPhase:'copy'|'deleting'='copy';
 const runtime:WindowsBackend&Pick<HyperVRuntime,'fingerprint'>={info:async()=>({available:true,issues:[]}),fingerprint:async()=>'stable fixture',state:async()=>({state:'Off'}),create:async()=>{throw Error('Must not create a VM');},start:async()=>{throw Error('Must not start a VM');},stop:async()=>{calls.push('stop');},connect:async()=>{throw Error('No guest access');},inspectGuard:async()=>{throw Error('No live guest');},session:async()=>{throw Error('No live guest');}};
 const service=await createWindowsService({rootDir:root,dataDir:path.join(root,'app'),runtimeRoot:path.join(root,'runtime'),runtime,base:{image:path.join(root,'base.vhdx'),imageSha256:'a'.repeat(64)},enableSnapshotPreview:enabled,enableLiveSnapshotDeletionPreview:liveDeletion,snapshotCoordinator:manager=>({store:manager.store,root:path.join(root,'runtime'),journal:{has:()=>false,pending:()=>[]},native:{staging:async()=>({entries:[],truncated:false}),inspectStaging:async(id:string,copyId:string,operation:'create'|'restore')=>{calls.push('staging-review:'+id);return {id:copyId,operation,phase:stagingPhase,token:'c'.repeat(64),bytes:65536,files:1,partialReceipt:false};},cleanupStaging:async(id:string,review:{id:string;operation:'create'|'restore';bytes:number},resume:boolean)=>{calls.push('staging-cleanup:'+id+':'+resume);return {deleted:true,alreadyDeleted:false,id:review.id,operation:review.operation,bytes:review.bytes};},status:async()=>({pending:false}),pending:async()=>[...pending]},recoverAll:async()=>{calls.push('startup');return {recovered:[],issues:[]};},deletions:async()=>[],remove:async(id:string,snapshotId:string,label:string,resumeOnly:boolean,options?:{allowRunning?:boolean})=>{calls.push('delete:'+resumeOnly);if(options?.allowRunning)calls.push('delete-live');const index=records.findIndex(row=>row.id===snapshotId&&row.environmentId===id&&row.name===label);if(index<0)throw Error('No exact deletion intent');records.splice(index,1);return {deleted:true};},list:async()=>corruptList?[{ownerConfiguration:'SYNTHETIC_PRIVATE_OWNER_CIPHER'}]:records,create:async(environment:Environment,label:string)=>{calls.push('create');const record={id:randomUUID(),environmentId:environment.id,name:label,createdAt:new Date().toISOString(),bytes:65536,seedSha256:'b'.repeat(64),cpus:environment.cpus,memoryGiB:environment.memoryGiB,diskGiB:environment.diskGiB,imageSha256:'a'.repeat(64)};records.push(record);return record;},restore:async(environment:Environment,snapshotId:string)=>{calls.push('restore');assert.ok(records.some(record=>record.id===snapshotId&&record.environmentId===environment.id));manager.store.save({...environment,name:'快照时名称',state:'stopped'});return {id:environment.id,snapshotId,transactionId:randomUUID(),decision:'committed',alreadyAcknowledged:false};},recover:async(id:string)=>{calls.push('recover');pending.delete(id);return null;}} as unknown as WindowsSnapshotCoordinatorPort)});
 const launched=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=launched.headers.getSetCookie()[0].split(';')[0],html=await(await fetch(service.url+'/',{headers:{Cookie:cookie}})).text(),bootstrap=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]),token=bootstrap.token;
 const headers={Cookie:cookie,Authorization:'Bearer '+token,'Content-Type':'application/json'};
 const request=(pathname:string,method='GET',body?:unknown)=>fetch(service.url+'/api'+pathname,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {service,calls,pending,records,headers,request,bootstrap,stagingPhase:(phase:'copy'|'deleting')=>{stagingPhase=phase;},corruptList:()=>{corruptList=true;},close:async()=>{await service.close();await rm(root,{recursive:true,force:true});}};
}
async function environment(f:Awaited<ReturnType<typeof fixture>>){const response=await f.request('/environments','POST',{name:'API 合成环境',cpus:2,memoryGiB:2,diskGiB:32,network:{mode:'http',host:'127.0.0.1',port:7897,strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.10'}}});assert.equal(response.status,201);const value=await response.json();f.service.manager.store.state(value.id,'stopped');return value;}

test('Unpublished-copy inspection uses the authenticated fixed-environment endpoint even when new snapshots are disabled',async()=>{
 const f=await fixture(false);try{
  const e=await environment(f),endpoint=`/environments/${e.id}/windows-snapshots/staging`;
  assert.deepEqual(await(await f.request(endpoint)).json(),{entries:[],truncated:false});
  assert.equal((await fetch(f.service.url+'/api'+endpoint)).status,401);
  assert.equal((await f.request(`/environments/${randomUUID()}/windows-snapshots/staging`)).status,404);
  assert.equal(f.calls.includes('create'),false);assert.equal(f.calls.includes('restore'),false);assert.equal(f.calls.includes('delete:false'),false);assert.equal(f.service.manager.store.get(e.id).state,'stopped');
 }finally{await f.close();}
});

test('Staging review and cleanup require authentication, exact confirmation and the current reviewed token',async()=>{
 const f=await fixture(true);try{
  const e=await environment(f),other=await environment(f),copyId=randomUUID(),endpoint=`/environments/${e.id}/windows-snapshots/staging`,body={copyId,operation:'create'};
  assert.equal((await fetch(f.service.url+'/api'+endpoint+'/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
  for(const extra of [{path:'F:/other'},{ownerConfiguration:'private'},{allowRunning:true}])assert.equal((await f.request(endpoint+'/review','POST',{...body,...extra})).status,400);
  const checked=await f.request(endpoint+'/review','POST',body);assert.equal(checked.status,202);const checking=await checked.json();assert.equal(checking.action,'snapshot-staging-review');await f.service.manager.wait(checking.id);const state=await(await f.request(endpoint+'/review')).json();assert.equal(state.phase,'ready');assert.equal(state.jobId,checking.id);assert.equal(state.review.id,copyId);assert.equal(f.calls.some(call=>call.startsWith('staging-cleanup:')),false);
  const cleanup={...body,token:state.review.token,confirmation:e.name,resumeOnly:false};assert.equal((await f.request(endpoint+'/cleanup','POST',{...cleanup,confirmation:'wrong'})).status,400);assert.equal((await f.request(endpoint+'/cleanup','POST',{...cleanup,token:'d'.repeat(64)})).status,409);assert.equal((await f.request(endpoint+'/cleanup','POST',{...cleanup,path:'F:/other'})).status,400);assert.equal((await f.request(`/environments/${other.id}/windows-snapshots/staging/cleanup`,'POST',cleanup)).status,409);assert.equal(f.calls.some(call=>call.startsWith('staging-cleanup:')),false);
  const cleaned=await f.request(endpoint+'/cleanup','POST',cleanup);assert.equal(cleaned.status,202);const cleaning=await cleaned.json();assert.equal(cleaning.action,'snapshot-staging-cleanup');await f.service.manager.wait(cleaning.id);assert.equal(f.service.manager.store.jobs().find(row=>row.id===cleaning.id)?.status,'succeeded');assert.deepEqual(f.calls.filter(call=>call.startsWith('staging-cleanup:')),[`staging-cleanup:${e.id}:false`]);assert.equal((await f.request(endpoint+'/cleanup','POST',cleanup)).status,409);assert.equal(f.service.manager.store.get(e.id).state,'stopped');
 }finally{await f.close();}
});

test('A previously planned staging cleanup can resume through the API while new snapshot creation is disabled',async()=>{
 const f=await fixture(false);try{
  const e=await environment(f),copyId=randomUUID(),endpoint=`/environments/${e.id}/windows-snapshots/staging`,body={copyId,operation:'restore'};
  let response=await f.request(endpoint+'/review','POST',body);await f.service.manager.wait((await response.json()).id);let state=await(await f.request(endpoint+'/review')).json();assert.equal((await f.request(endpoint+'/cleanup','POST',{...body,token:state.review.token,confirmation:e.name,resumeOnly:false})).status,409);assert.equal(f.calls.some(call=>call.startsWith('staging-cleanup:')),false);
  f.stagingPhase('deleting');response=await f.request(endpoint+'/review','POST',body);await f.service.manager.wait((await response.json()).id);state=await(await f.request(endpoint+'/review')).json();const cleaned=await f.request(endpoint+'/cleanup','POST',{...body,token:state.review.token,confirmation:e.name,resumeOnly:true});assert.equal(cleaned.status,202);const job=await cleaned.json();await f.service.manager.wait(job.id);assert.equal(f.service.manager.store.jobs().find(row=>row.id===job.id)?.status,'succeeded');assert.ok(f.calls.includes(`staging-cleanup:${e.id}:true`));
 }finally{await f.close();}
});

test('Snapshot delete API requires explicit mode, current environment confirmation and the existing local authentication',async()=>{
 const f=await fixture(true);try{const e=await environment(f);const created=await f.request(`/environments/${e.id}/windows-snapshots`,'POST',{name:'待删快照'});await f.service.manager.wait((await created.json()).id);const snapshot=f.records[0],endpoint=`/environments/${e.id}/windows-snapshots/delete`,body={snapshotId:snapshot.id,name:snapshot.name,confirmation:e.name,resumeOnly:false};
  assert.equal((await fetch(f.service.url+'/api'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
  for(const input of [{...body,resumeOnly:undefined},{...body,resumeOnly:'false'},{...body,path:'F:/outside.vhdx'},{...body,confirmation:'错误名称'}])assert.equal((await f.request(endpoint,'POST',input)).status,400);assert.equal(f.calls.includes('delete:false'),false);
  const result=await f.request(endpoint,'POST',body);assert.equal(result.status,202);await f.service.manager.wait((await result.json()).id);assert.equal(f.records.length,0);assert.ok(f.calls.includes('delete:false'));assert.deepEqual(await(await f.request(`/environments/${e.id}/windows-snapshots/deletions`)).json(),[]);assert.equal(f.service.manager.store.get(e.id).state,'stopped');
 }finally{await f.close();}
});

test('Snapshot API remains authenticated and disabled by default while startup reconciliation and explicit recovery are available',async()=>{
 const f=await fixture();try{assert.deepEqual(f.calls,['startup']);for(const headers of [{},{Authorization:f.headers.Authorization},{Cookie:f.headers.Cookie}] as Record<string,string>[]){const response=await fetch(f.service.url+'/api/windows/snapshots',{headers});assert.equal(response.status,401);}
  const status=await(await f.request('/windows/snapshots')).json();assert.equal(status.initialized,true);assert.equal(status.enabled,false);assert.equal(f.bootstrap.capabilities.snapshots,true);assert.equal(f.bootstrap.capabilities.snapshotRecovery,true);const e=await environment(f);const before=f.service.manager.store.jobs().length;assert.equal((await f.request(`/environments/${e.id}/windows-snapshots`,'POST',{name:'未开放的创建'})).status,409);assert.equal(f.service.manager.store.jobs().length,before);assert.equal(f.calls.includes('create'),false);
  const response=await f.request(`/environments/${e.id}/windows-snapshots/recover`,'POST',{confirmation:e.name});assert.equal(response.status,202);await f.service.manager.wait((await response.json()).id);assert.ok(f.calls.includes('recover'));assert.equal(f.service.manager.store.get(e.id).state,'stopped');
 }finally{await f.close();}
});
test('Enabled source preview creates and restores through jobs, requires the current name and never returns owner ciphertext',async()=>{
 const f=await fixture(true);try{const e=await environment(f);const created=await f.request(`/environments/${e.id}/windows-snapshots`,'POST',{name:'本地快照'});assert.equal(created.status,202);const job=await created.json();await f.service.manager.wait(job.id);assert.equal(f.service.manager.store.jobs().find(value=>value.id===job.id)?.status,'succeeded');
  const list=await(await f.request(`/environments/${e.id}/windows-snapshots`)).json();assert.equal(list.length,1);assert.equal(list[0].name,'本地快照');assert.equal(JSON.stringify(list).includes('ownerConfiguration'),false);
  const wrong=await f.request(`/environments/${e.id}/windows-snapshots/restore`,'POST',{snapshotId:list[0].id,confirmation:'错误名称'});assert.equal(wrong.status,400);assert.equal(f.calls.includes('restore'),false);
  const restored=await f.request(`/environments/${e.id}/windows-snapshots/restore`,'POST',{snapshotId:list[0].id,confirmation:e.name});assert.equal(restored.status,202);await f.service.manager.wait((await restored.json()).id);assert.equal(f.service.manager.store.get(e.id).name,'快照时名称');assert.equal(f.service.manager.store.get(e.id).state,'stopped');
  f.corruptList();const rejected=await f.request(`/environments/${e.id}/windows-snapshots`);assert.equal(rejected.status,400);assert.equal((await rejected.text()).includes('SYNTHETIC_PRIVATE_OWNER_CIPHER'),false);
 }finally{await f.close();}
});
test('A native transaction discovered after startup blocks API configuration changes and appears in the workspace status',async()=>{
 const f=await fixture();try{const e=await environment(f);f.pending.add(e.id);const config=f.service.manager.store.get(e.id);const changed=await f.request(`/environments/${e.id}`,'PUT',{...config,name:'不能覆盖'});assert.equal(changed.status,409);assert.equal(f.service.manager.store.get(e.id).name,e.name);const workspace=await(await f.request('/snapshot')).json();assert.ok(workspace.system.hostSnapshotIssue);const state=await(await f.request('/windows/snapshots')).json();assert.deepEqual(state.pendingIds,[e.id]);assert.equal(JSON.stringify(state).includes('ownerConfiguration'),false);
  await f.request('/windows/snapshots/recheck','POST',{});assert.equal(f.calls.filter(call=>call==='startup').length,2);
 }finally{await f.close();}
});

test('Authenticated live deletion selects its server-side capability and never accepts a client privilege override',async()=>{
 const f=await fixture(true,true);try{
  const e=await environment(f),made=await f.request(`/environments/${e.id}/windows-snapshots`,'POST',{name:'运行前快照'});await f.service.manager.wait((await made.json()).id);const record=f.records[0];
  const manager=f.service.manager,digest='a'.repeat(64);let active=false;
  manager.runtime.inspectGuard=async()=>({digest,leaseActive:active,remainingMs:45000});
  const session=new WindowsNetworkSession({inspect:async()=>({digest,leaseActive:active,remainingMs:45000}),probe:async()=>[{receiver:'ipify',ip:'203.0.113.10',latencyMs:1},{receiver:'ipwho',ip:'203.0.113.10',latencyMs:2}],activate:async()=>{active=true;},renew:async()=>{},revoke:async()=>{active=false;},disconnect:async()=>{},stop:async()=>{}},'203.0.113.10');
  await session.open();manager.sessions.set(e.id,session);manager.store.state(e.id,'running');
  const endpoint=`/environments/${e.id}/windows-snapshots/delete`,body={snapshotId:record.id,name:record.name,confirmation:e.name,resumeOnly:false};
  const forged=await f.request(endpoint,'POST',{...body,allowRunning:true});assert.equal(forged.status,400);assert.equal(f.calls.includes('delete-live'),false);
  const status=await(await f.request('/windows/snapshots')).json();assert.equal(status.liveDeletionAvailable,true);
  const response=await f.request(endpoint,'POST',body);assert.equal(response.status,202);const job=await response.json();assert.equal(job.action,'snapshot-delete-live');await manager.wait(job.id);
  assert.equal(manager.store.jobs().find(row=>row.id===job.id)?.status,'succeeded');assert.equal(manager.store.get(e.id).state,'running');assert.equal(manager.sessions.get(e.id),session);assert.equal(f.records.length,0);assert.equal(f.calls.filter(call=>call==='delete-live').length,1);assert.equal((await f.request(`/environments/${e.id}/network/protection`)).status,200);
 }finally{await f.close();}
});
