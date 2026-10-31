import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {WindowsManager,type WindowsBackend} from '../server/platform/windows/manager.ts';
import {WindowsNetworkSession} from '../server/platform/windows/session.ts';
import {windowsPaths} from '../server/platform/windows/config.ts';
import {WindowsSnapshotProduct} from '../server/platform/windows/snapshot-product.ts';

const input=(name='快照产品测试')=>({name,cpus:2,memoryGiB:2,diskGiB:32,network:{mode:'http',host:'127.0.0.1',port:7897,username:'',strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.10'}}});
const copyReview=(phase:'copy'|'deleting'|'done'='copy')=>({id:randomUUID(),operation:'create' as const,phase,token:'c'.repeat(64),bytes:phase==='done'?0:65536,files:phase==='done'?0:1,partialReceipt:false});
async function fixture(options:{enabled?:boolean;liveDeletionEnabled?:boolean;available?:()=>boolean;recoveryAvailable?:()=>boolean}={enabled:true}){
 const root=await mkdtemp(path.join(tmpdir(),'mu-snapshot-product-')),store=new Store(path.join(root,'app'),Buffer.alloc(32,7)),states=new Map<string,{state:string;active:boolean}>(),calls:string[]=[],pending=new Set<string>(),journal=new Set<string>();
 const state=(id:string)=>{if(!states.has(id))states.set(id,{state:'Off',active:false});return states.get(id)!;};
 const runtime:WindowsBackend={info:async()=>({available:true,issues:[]}),create:async config=>{const files=windowsPaths(root,config.id);await mkdir(files.directory,{recursive:true});await writeFile(files.manifest,'{}');},start:async config=>{calls.push('start');state(config.id).state='Running';},stop:async config=>{calls.push('stop');state(config.id).state='Off';state(config.id).active=false;},state:async config=>({state:state(config.id).state}),connect:async()=>{},inspectGuard:async config=>({digest:'a'.repeat(64),leaseActive:state(config.id).active,remainingMs:state(config.id).active?45000:0}),session:async config=>{const current=state(config.id);return new WindowsNetworkSession({inspect:async()=>({digest:'a'.repeat(64),leaseActive:current.active,remainingMs:current.active?45000:0}),probe:async()=>[{receiver:'ipify',ip:'203.0.113.10',latencyMs:1},{receiver:'ipwho',ip:'203.0.113.10',latencyMs:2}],activate:async()=>{current.active=true;},renew:async()=>{},revoke:async()=>{current.active=false;},disconnect:async()=>{},stop:async()=>{current.state='Off';current.active=false;}},config.expectedIp);}};
 const manager=new WindowsManager(store,runtime,{runtimeRoot:root,base:{image:path.join(root,'base.vhdx'),imageSha256:'a'.repeat(64)}}),environment=await manager.create(input()),other=await manager.create(input('另一个环境'));store.state(environment.id,'stopped');store.state(other.id,'stopped');
 const hooks:{remove?:(resumeOnly:boolean,options:{signal?:AbortSignal;allowRunning?:boolean})=>Promise<void>;create?:(signal:AbortSignal)=>Promise<void>;restore?:()=>Promise<void>;recover?:()=>Promise<void>;recoverAll?:()=>Promise<{recovered:string[];issues:{id:string;message:string}[]}>}={};
 const coordinator={store,root,journal:{has:(id:string)=>journal.has(id),pending:()=>[...journal]},native:{staging:async()=>({entries:[],truncated:false}),status:async(id:string)=>({pending:pending.has(id)}),pending:async()=>[...pending]},list:async()=>[],deletions:async()=>[],remove:async(_id:string,_snapshotId:string,_name:string,resumeOnly:boolean,options:{signal?:AbortSignal;allowRunning?:boolean})=>{calls.push('snapshot-delete');await hooks.remove?.(resumeOnly,options);return {deleted:true};},create:async(_environment:unknown,_name:string,run:{signal:AbortSignal})=>{calls.push('snapshot-create');await hooks.create?.(run.signal);return {};},restore:async()=>{calls.push('snapshot-restore');await hooks.restore?.();return {};},recover:async(id:string)=>{calls.push('snapshot-recover');await hooks.recover?.();pending.delete(id);journal.delete(id);return null;},recoverAll:async()=>{calls.push('snapshot-startup');return hooks.recoverAll?await hooks.recoverAll():{recovered:[],issues:[]};}} as unknown as ConstructorParameters<typeof WindowsSnapshotProduct>[1];
 const product=new WindowsSnapshotProduct(manager,coordinator,options);
 return {root,store,manager,product,coordinator,environment,other,state,calls,hooks,pending,journal,close:async()=>{await manager.close();await rm(root,{recursive:true,force:true});}};
}
test('Staging review and cleanup are separate confirmed jobs, and a consumed approval cannot be replayed',async()=>{
 const f=await fixture(),review=copyReview();let removed=0;
 try{await f.product.initialize();f.coordinator.native.inspectStaging=async()=>review;f.coordinator.native.cleanupStaging=async(id,approved,resumeOnly,options)=>{options?.signal?.throwIfAborted();assert.equal(id,f.environment.id);assert.deepEqual(approved,review);assert.equal(resumeOnly,false);removed++;return {deleted:true,alreadyDeleted:false,id:review.id,operation:review.operation,bytes:review.bytes};};
  const checking=f.product.inspectStaging(f.environment.id,review.id,review.operation);assert.equal(f.product.stagingReviewState(f.environment.id).phase,'running');await f.manager.wait(checking.id);assert.equal(removed,0);assert.equal(f.store.jobs().find(job=>job.id===checking.id)?.status,'succeeded');assert.match(f.store.jobs().find(job=>job.id===checking.id)!.message!,/尚未删除/);assert.deepEqual(f.product.stagingReviewState(f.environment.id),{phase:'ready',jobId:checking.id,review});
  const count=f.store.jobs().length;for(const args of [[review.id,review.token,'wrong name',false],[randomUUID(),review.token,f.environment.name,false],[review.id,'d'.repeat(64),f.environment.name,false],[review.id,review.token,f.environment.name,true]] as const)assert.throws(()=>f.product.cleanupStaging(f.environment.id,args[0],review.operation,args[1],args[2],args[3]));assert.equal(f.store.jobs().length,count);assert.equal(removed,0);
  const cleaning=f.product.cleanupStaging(f.environment.id,review.id,review.operation,review.token,f.environment.name,false);assert.equal(f.product.stagingReviewState(f.environment.id).phase,'idle');await f.manager.wait(cleaning.id);assert.equal(removed,1);assert.equal(f.store.jobs().find(job=>job.id===cleaning.id)?.status,'succeeded');assert.match(f.store.jobs().find(job=>job.id===cleaning.id)!.message!,/遗留副本已清理/);assert.equal(f.store.get(f.environment.id).state,'stopped');assert.throws(()=>f.product.cleanupStaging(f.environment.id,review.id,review.operation,review.token,f.environment.name,false),{code:'SNAPSHOT_REVIEW_EXPIRED'});
 }finally{await f.close();}
});

test('A five-minute staging approval expires without invoking a native delete',async()=>{
 const f=await fixture(),review=copyReview(),now=Date.now;let removed=0;
 try{await f.product.initialize();f.coordinator.native.inspectStaging=async()=>review;f.coordinator.native.cleanupStaging=async()=>{removed++;throw Error('must not run');};const checking=f.product.inspectStaging(f.environment.id,review.id,review.operation);await f.manager.wait(checking.id);const future=now()+5*60*1000+1;Date.now=()=>future;assert.equal(f.product.stagingReviewState(f.environment.id).phase,'idle');assert.throws(()=>f.product.cleanupStaging(f.environment.id,review.id,review.operation,review.token,f.environment.name,false),{code:'SNAPSHOT_REVIEW_EXPIRED'});assert.equal(removed,0);
 }finally{Date.now=now;await f.close();}
});

test('New cleanup can be disabled while an existing original deletion remains resumable',async()=>{
 const f=await fixture({enabled:false}),review=copyReview();let removed=0;
 try{await f.product.initialize();f.coordinator.native.inspectStaging=async()=>review;f.coordinator.native.cleanupStaging=async()=>{removed++;return {deleted:true,alreadyDeleted:false,id:review.id,operation:review.operation,bytes:review.bytes};};let checking=f.product.inspectStaging(f.environment.id,review.id,review.operation);await f.manager.wait(checking.id);assert.throws(()=>f.product.cleanupStaging(f.environment.id,review.id,review.operation,review.token,f.environment.name,false),{code:'FEATURE_UNAVAILABLE'});assert.equal(removed,0);
  f.coordinator.native.inspectStaging=async()=>({...review,phase:'deleting'});checking=f.product.inspectStaging(f.environment.id,review.id,review.operation);await f.manager.wait(checking.id);const cleaning=f.product.cleanupStaging(f.environment.id,review.id,review.operation,review.token,f.environment.name,true);await f.manager.wait(cleaning.id);assert.equal(removed,1);assert.equal(f.store.jobs().find(job=>job.id===cleaning.id)?.status,'succeeded');
 }finally{await f.close();}
});

test('Repeated resource pressure leaves a stopped staging cleanup cancellable and able to reclaim space',async()=>{
 const f=await fixture(),review=copyReview();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>entered=resolve);
 try{await f.product.initialize();await f.manager.resourcesUnavailable('synthetic pressure');f.coordinator.native.inspectStaging=async()=>review;f.coordinator.native.cleanupStaging=async(_id,_review,_resume,options)=>{entered();await gate;assert.equal(options!.signal!.aborted,false);return {deleted:true,alreadyDeleted:false,id:review.id,operation:review.operation,bytes:review.bytes};};const checking=f.product.inspectStaging(f.environment.id,review.id,review.operation);await f.manager.wait(checking.id);const cleaning=f.product.cleanupStaging(f.environment.id,review.id,review.operation,review.token,f.environment.name,false);await began;await f.manager.resourcesUnavailable('repeated pressure');assert.equal(f.manager.tasks.get(cleaning.id)!.controller.signal.aborted,false);await assert.rejects(f.manager.action(f.other.id,'start'),{code:'RESOURCE_FENCED'});release();await f.manager.wait(cleaning.id);assert.equal(f.store.jobs().find(job=>job.id===cleaning.id)?.status,'succeeded');
 }finally{release();await f.close();}
});

test('Cancelling an in-flight review rejects late approval publication',async()=>{
 const f=await fixture(),review=copyReview();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>entered=resolve);
 try{await f.product.initialize();f.coordinator.native.inspectStaging=async()=>{entered();await gate;return review;};const checking=f.product.inspectStaging(f.environment.id,review.id,review.operation);await began;assert.throws(()=>f.product.inspectStaging(f.environment.id,review.id,review.operation),{code:'SNAPSHOT_BUSY'});f.manager.cancel(checking.id);release();await f.manager.wait(checking.id);assert.equal(f.store.jobs().find(job=>job.id===checking.id)?.status,'cancelled');assert.equal(f.product.stagingReviewState(f.environment.id).phase,'failed');assert.equal(f.product.stagingReviewState(f.environment.id).review,undefined);assert.throws(()=>f.product.cleanupStaging(f.environment.id,review.id,review.operation,review.token,f.environment.name,false),{code:'SNAPSHOT_REVIEW_EXPIRED'});
 }finally{release();await f.close();}
});

test('A foreign or private native review never becomes a user approval',async()=>{
 const f=await fixture(),review=copyReview();try{await f.product.initialize();for(const result of [{...review,id:randomUUID()},{...review,ownerConfiguration:'SYNTHETIC_PRIVATE_OWNER_CIPHER'}]){f.coordinator.native.inspectStaging=async()=>result;const checking=f.product.inspectStaging(f.environment.id,review.id,review.operation);await f.manager.wait(checking.id);assert.equal(f.store.jobs().find(job=>job.id===checking.id)?.status,'failed');const state=f.product.stagingReviewState(f.environment.id);assert.equal(state.phase,'failed');assert.equal(state.review,undefined);assert.equal(JSON.stringify(state).includes('SYNTHETIC_PRIVATE_OWNER_CIPHER'),false);assert.equal(f.store.get(f.environment.id).state,'stopped');}}finally{await f.close();}
});

test('Cancellation during the final native-state check cannot publish a completed staging approval',async()=>{
 const f=await fixture(),review=copyReview();let release!:()=>void,entered!:()=>void,first=true;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>entered=resolve);
 try{await f.product.initialize();f.coordinator.native.inspectStaging=async()=>review;f.coordinator.native.status=async()=>{if(first){first=false;entered();await gate;}return {pending:false};};const checking=f.product.inspectStaging(f.environment.id,review.id,review.operation);await began;assert.equal(f.product.stagingReviewState(f.environment.id).phase,'running');f.manager.cancel(checking.id);release();await f.manager.wait(checking.id);assert.equal(f.store.jobs().find(job=>job.id===checking.id)?.status,'cancelled');assert.equal(f.product.stagingReviewState(f.environment.id).phase,'failed');assert.equal(f.product.stagingReviewState(f.environment.id).review,undefined);
 }finally{release();await f.close();}
});

for(const action of ['create','restore'] as const)test(`Unpublished copies refuse ${action} before capture or native copying without fencing the current environment`,async()=>{
 const f=await fixture();try{
  await f.product.initialize();f.coordinator.native.staging=async()=>({entries:[{name:'create-next-unverified',operation:'create'}],truncated:false});
  const job=action==='create'?f.product.create(f.environment.id,'新快照'):f.product.restore(f.environment.id,randomUUID(),f.environment.name);await f.manager.wait(job.id);
  const saved=f.store.jobs().find(row=>row.id===job.id)!;assert.equal(saved.status,'failed');assert.match(saved.message!,/未发布快照副本/);assert.equal(f.store.get(f.environment.id).state,'stopped');
  assert.equal(f.calls.includes('snapshot-create'),false);assert.equal(f.calls.includes('snapshot-restore'),false);assert.equal(f.calls.includes('snapshot-recover'),false);assert.deepEqual(f.product.status().pendingIds,[]);
  assert.equal((await f.product.staging(f.environment.id)).entries.length,1);assert.deepEqual(await f.product.list(f.environment.id),[]);
  await f.manager.wait((await f.manager.action(f.environment.id,'start')).id);assert.equal(f.store.get(f.environment.id).state,'running');
  await f.manager.wait((await f.manager.action(f.environment.id,'stop')).id);f.coordinator.native.staging=async()=>({entries:[],truncated:false});const retry=f.product.create(f.environment.id,'核验后重试');await f.manager.wait(retry.id);assert.equal(f.store.jobs().find(row=>row.id===retry.id)!.status,'succeeded');
 }finally{await f.close();}
});

test('Snapshot startup admission is closed until reconciliation, including when creation is disabled',async()=>{
 const f=await fixture({enabled:false});try{await assert.rejects(f.manager.update(f.environment.id,input()),{code:'SNAPSHOT_PENDING'});assert.throws(()=>f.product.create(f.environment.id,'快照'),{code:'FEATURE_UNAVAILABLE'});assert.equal((await f.product.initialize()).initialized,true);assert.ok(f.calls.includes('snapshot-startup'));await f.manager.update(f.environment.id,input());assert.equal((await f.product.list(f.environment.id)).length,0);}finally{await f.close();}
});

test('Deletion requires feature/name admission, while existing-intent cleanup remains available with the preview off',async()=>{
 const f=await fixture({enabled:false});try{await f.product.initialize();const snapshotId=randomUUID();assert.throws(()=>f.product.remove(f.environment.id,snapshotId,'快照',f.environment.name,false),{code:'FEATURE_UNAVAILABLE'});assert.throws(()=>f.product.remove(f.environment.id,snapshotId,'快照','错误名称',true),{code:'SNAPSHOT_CONFIRMATION'});let mode:boolean|undefined;f.hooks.remove=async resumeOnly=>{mode=resumeOnly;};const job=f.product.remove(f.environment.id,snapshotId,'快照',f.environment.name,true);await f.manager.wait(job.id);assert.equal(mode,true);assert.equal(f.store.jobs().find(row=>row.id===job.id)?.status,'succeeded');assert.equal(f.store.get(f.environment.id).state,'stopped');assert.equal(f.calls.includes('start'),false);}finally{await f.close();}
});
test('Interrupted snapshot deletion keeps the confirmed stopped environment and never invokes disk/config restoration',async()=>{
 const f=await fixture();try{await f.product.initialize();const before=f.store.get(f.environment.id);f.hooks.remove=async()=>{throw Error('Synthetic deletion interruption');};const job=f.product.remove(f.environment.id,randomUUID(),'快照',f.environment.name,false);await f.manager.wait(job.id);assert.equal(f.store.jobs().find(row=>row.id===job.id)?.status,'failed');assert.equal(f.store.get(f.environment.id).state,'stopped');assert.equal(f.store.get(f.environment.id).network.password,before.network.password);assert.equal(f.calls.includes('snapshot-recover'),false);assert.equal(f.calls.includes('start'),false);assert.deepEqual(f.product.status().pendingIds,[]);}finally{await f.close();}
});
test('A deletion never trusts stopped metadata, and explicit cleanup can retry after the real stop state is confirmed',async()=>{
 const f=await fixture();try{await f.product.initialize();f.state(f.environment.id).state='Running';const job=f.product.remove(f.environment.id,randomUUID(),'快照',f.environment.name,true);await f.manager.wait(job.id);assert.equal(f.store.jobs().find(row=>row.id===job.id)?.status,'failed');assert.equal(f.calls.includes('snapshot-delete'),false);assert.equal(f.store.get(f.environment.id).state,'error');f.state(f.environment.id).state='Off';const retry=f.product.remove(f.environment.id,randomUUID(),'快照',f.environment.name,true);await f.manager.wait(retry.id);assert.equal(f.store.jobs().find(row=>row.id===retry.id)?.status,'succeeded');assert.equal(f.store.get(f.environment.id).state,'stopped');assert.equal(f.calls.includes('start'),false);}finally{await f.close();}
});
test('Repeated disk-pressure fencing does not cancel stopped-copy cleanup needed to reclaim space',async()=>{
 const f=await fixture({enabled:false,available:()=>false});let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>entered=resolve);
 try{await f.product.initialize();await f.manager.resourcesUnavailable('合成空间压力');f.hooks.remove=async()=>{entered();await gate;};const job=f.product.remove(f.environment.id,randomUUID(),'快照',f.environment.name,true);await began;await f.manager.resourcesUnavailable('再次检测到空间压力');assert.equal(f.manager.tasks.get(job.id)!.controller.signal.aborted,false);await assert.rejects(f.manager.action(f.other.id,'start'),{code:'RESOURCE_FENCED'});release();await f.manager.wait(job.id);assert.equal(f.store.jobs().find(row=>row.id===job.id)?.status,'succeeded');assert.equal(f.calls.includes('start'),false);}finally{release();await f.close();}
});
test('Exact restore confirmation rejects the operation before a job or native transaction exists',async()=>{
 const f=await fixture();try{await f.product.initialize();const before=f.store.jobs().length;assert.throws(()=>f.product.restore(f.environment.id,randomUUID(),'错误名称'),{code:'SNAPSHOT_CONFIRMATION'});assert.equal(f.store.jobs().length,before);assert.equal(f.calls.includes('snapshot-restore'),false);}finally{await f.close();}
});
test('An inactive host runtime defers reconciliation without querying native state and can retry once active',async()=>{
 let ready=false;const f=await fixture({enabled:false,recoveryAvailable:()=>ready});try{assert.equal((await f.product.initialize()).initialized,false);assert.equal(f.calls.includes('snapshot-startup'),false);assert.throws(()=>f.product.recover(f.environment.id,f.environment.name),{code:'HOST_REQUIREMENTS'});ready=true;assert.equal((await f.product.initialize()).initialized,true);assert.equal(f.calls.filter(call=>call==='snapshot-startup').length,1);}finally{await f.close();}
});
test('A queued snapshot locks its environment while a separate environment can run',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>entered=resolve);
 try{await f.product.initialize();await f.manager.wait((await f.manager.action(f.other.id,'start')).id);assert.equal(f.store.get(f.other.id).state,'running');f.hooks.create=async()=>{entered();await gate;};const job=f.product.create(f.environment.id,'停止时快照');await began;await assert.rejects(f.manager.update(f.environment.id,input()),{code:'SNAPSHOT_BUSY'});await assert.rejects(f.manager.action(f.environment.id,'start'),{code:'SNAPSHOT_BUSY'});assert.throws(()=>f.manager.runMaintenance('backup-export',async()=>{}),{code:'ENVIRONMENT_BUSY'});assert.equal(f.store.get(f.other.id).state,'running');release();await f.manager.wait(job.id);assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'succeeded');assert.equal(f.store.get(f.environment.id).state,'stopped');assert.equal(f.store.jobs().find(value=>value.id===job.id)?.environmentId,f.environment.id);assert.deepEqual(f.product.status().pendingIds,[]);}finally{release();await f.close();}
});
test('Unresolved native or ordinary journals block writes without replacing original configuration',async()=>{
 const f=await fixture();try{f.pending.add(f.environment.id);f.journal.add(f.environment.id);f.hooks.recoverAll=async()=>({recovered:[],issues:[{id:f.environment.id,message:'private failure'}]});await f.product.initialize();await assert.rejects(f.manager.update(f.environment.id,input('must stay original')),{code:'SNAPSHOT_PENDING'});await assert.rejects(f.manager.remove(f.environment.id,f.environment.name),{code:'SNAPSHOT_PENDING'});await assert.rejects(f.manager.growDisk(f.environment.id,40,f.environment.name),{code:'SNAPSHOT_PENDING'});assert.equal(f.store.get(f.environment.id).name,f.environment.name);assert.equal(JSON.stringify(f.product.status()).includes('private failure'),false);await f.manager.update(f.other.id,input('独立环境仍可编辑'));assert.equal(f.store.get(f.other.id).name,'独立环境仍可编辑');}finally{await f.close();}
});
test('A newly discovered native pending transaction blocks metadata editing before any save',async()=>{
 const f=await fixture();try{await f.product.initialize();f.pending.add(f.environment.id);await assert.rejects(f.manager.update(f.environment.id,input('must not save')),{code:'SNAPSHOT_PENDING'});assert.equal(f.store.get(f.environment.id).name,f.environment.name);assert.deepEqual(f.product.status().pendingIds,[f.environment.id]);await f.manager.update(f.other.id,input('其他环境可以编辑'));}finally{await f.close();}
});
test('A settings request delayed across a completed snapshot restore cannot overwrite the restored configuration',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>entered=resolve);
 try{await f.product.initialize();const original=f.manager.runtime.state;let first=true;f.manager.runtime.state=async(...args)=>{const captured=await original(...args);if(first){first=false;entered();await gate;}return captured;};
  const editing=f.manager.update(f.environment.id,input('滞后的设置请求'));const rejected=assert.rejects(editing,{code:'ENVIRONMENT_BUSY'});await began;
  f.hooks.restore=async()=>{const current=f.store.get(f.environment.id);f.store.save({...current,name:'恢复后的配置',network:{...current.network,password:'SYNTHETIC_RESTORED_PASSWORD'}});};
  const job=f.product.restore(f.environment.id,randomUUID(),f.environment.name);await f.manager.wait(job.id);assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'succeeded');release();await rejected;
  assert.equal(f.store.get(f.environment.id).name,'恢复后的配置');assert.equal(f.store.get(f.environment.id).network.password,'SYNTHETIC_RESTORED_PASSWORD');
 }finally{release();await f.close();}
});
test('Explicit reconciliation remains available when creation or host admission is disabled',async()=>{
 const f=await fixture({enabled:false,available:()=>false});try{f.pending.add(f.environment.id);f.journal.add(f.environment.id);await f.product.initialize();await f.manager.hostUnavailable('synthetic host fence');const job=f.product.recover(f.environment.id,f.environment.name);await f.manager.wait(job.id);assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'succeeded');assert.equal(f.store.get(f.environment.id).state,'stopped');assert.deepEqual(f.product.status().pendingIds,[]);assert.equal(f.calls.includes('start'),false);}finally{await f.close();}
});
test('An unconfirmed native outcome retains admission fences and cannot publish a successful restore',async()=>{
 const f=await fixture();try{await f.product.initialize();f.hooks.restore=async()=>{f.pending.add(f.environment.id);f.journal.add(f.environment.id);throw Error('synthetic private native error');};f.hooks.recover=async()=>{throw Error('unavailable');};const job=f.product.restore(f.environment.id,randomUUID(),f.environment.name);await f.manager.wait(job.id);assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'failed');assert.deepEqual(f.product.status().pendingIds,[f.environment.id]);await assert.rejects(f.manager.action(f.environment.id,'start'),{code:'SNAPSHOT_PENDING'});assert.equal(f.store.get(f.environment.id).name,f.environment.name);assert.equal(f.calls.includes('start'),false);}finally{await f.close();}
});
test('Ordinary startup recovery may stop a fenced VM but never repairs its unknown management files',async()=>{
 const f=await fixture();try{f.pending.add(f.environment.id);let repaired=0;f.manager.runtime.recoverCreation=async()=>{repaired++;return true;};await f.product.initialize();f.state(f.environment.id).state='Running';await f.manager.recover();assert.equal(f.state(f.environment.id).state,'Off');assert.equal(f.store.get(f.environment.id).state,'error');assert.equal(repaired,1,'Only the unrelated environment may use ordinary creation recovery');assert.ok(f.calls.includes('stop'));}finally{await f.close();}
});
test('Cancellation before snapshot work never calls the coordinator or starts a VM',async()=>{
 const f=await fixture();try{await f.product.initialize();const job=f.product.create(f.environment.id,'取消测试');f.manager.cancel(job.id);await f.manager.wait(job.id);assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'cancelled');assert.equal(f.calls.includes('snapshot-create'),false);assert.deepEqual(f.product.status().pendingIds,[]);}finally{await f.close();}
});

test('Running snapshot deletion is separately disabled by default even when stopped snapshots are enabled',async()=>{
 const f=await fixture();try{await f.product.initialize();await f.manager.wait((await f.manager.action(f.environment.id,'start')).id);const count=f.store.jobs().length;assert.throws(()=>f.product.remove(f.environment.id,randomUUID(),'旧快照',f.environment.name,false),{code:'FEATURE_UNAVAILABLE'});assert.equal(f.product.status().liveDeletionAvailable,undefined);assert.equal(f.store.jobs().length,count);assert.equal(f.calls.includes('snapshot-delete'),false);}finally{await f.close();}
});

test('Running snapshot deletion preserves the exact guard session and profile while fencing lifecycle/configuration mutations',async()=>{
 const f=await fixture({enabled:true,liveDeletionEnabled:true});let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>entered=resolve);
 try{
  await f.product.initialize();await f.manager.wait((await f.manager.action(f.environment.id,'start')).id);const session=f.manager.sessions.get(f.environment.id),profile=f.manager.profiles.get(f.environment.id);let revoked=0,ticks=0;f.manager.onAccessRevoked=()=>{revoked++;};const tick=session!.tick.bind(session);session!.tick=async()=>{ticks++;await tick();};
  f.hooks.remove=async(resume,options)=>{assert.equal(resume,false);assert.equal(options.allowRunning,true);assert.equal(options.signal?.aborted,false);entered();await gate;};
  const job=f.product.remove(f.environment.id,randomUUID(),'旧快照',f.environment.name,false);await began;assert.equal(job.action,'snapshot-delete-live');assert.equal(f.product.status().liveDeletionAvailable,true);
  await f.manager.assertAccess(f.environment.id);assert.equal((await f.manager.protection(f.environment.id)).active,true);assert.equal((await f.manager.egress(f.environment.id)).status,'verified');await f.manager.monitor();assert.equal(ticks,1);
  await assert.rejects(f.manager.update(f.environment.id,input('不能修改')),{code:'SNAPSHOT_BUSY'});await assert.rejects(f.manager.action(f.environment.id,'restart'),{code:'SNAPSHOT_BUSY'});assert.throws(()=>f.product.restore(f.environment.id,randomUUID(),f.environment.name),{code:'SNAPSHOT_BUSY'});assert.throws(()=>f.product.create(f.environment.id,'新快照'),{code:'SNAPSHOT_BUSY'});await assert.rejects(f.manager.submit(f.environment.id,'browser-update',async()=>{}),{code:'SNAPSHOT_BUSY'});
  assert.equal(f.manager.sessions.get(f.environment.id),session);assert.equal(f.manager.profiles.get(f.environment.id),profile);assert.equal(revoked,0);release();await f.manager.wait(job.id);
  assert.equal(f.store.get(f.environment.id).state,'running');assert.equal(f.manager.sessions.get(f.environment.id),session);assert.equal(f.manager.profiles.get(f.environment.id),profile);assert.equal(f.store.jobs().find(row=>row.id===job.id)?.status,'succeeded');assert.equal(revoked,0);assert.equal(f.calls.includes('stop'),false);await f.manager.assertAccess(f.environment.id);
 }finally{release();await f.close();}
});

test('Failed or cancelled live deletion never restores configuration or rewrites the running state',async()=>{
 for(const cancel of [false,true]){const f=await fixture({enabled:true,liveDeletionEnabled:true});try{
  await f.product.initialize();await f.manager.wait((await f.manager.action(f.environment.id,'start')).id);const session=f.manager.sessions.get(f.environment.id),before=f.store.get(f.environment.id);let signal:AbortSignal|undefined;
  f.hooks.remove=async(_resume,options)=>{signal=options.signal;if(cancel)f.manager.cancel(f.manager.active.get(f.environment.id)!);throw Error('synthetic copy-delete failure');};
  const job=f.product.remove(f.environment.id,randomUUID(),'旧快照',f.environment.name,false);await f.manager.wait(job.id);assert.equal(signal?.aborted,cancel);assert.equal(f.store.jobs().find(row=>row.id===job.id)?.status,cancel?'cancelled':'failed');assert.equal(f.store.get(f.environment.id).state,'running');assert.equal(f.store.get(f.environment.id).network.password,before.network.password);assert.equal(f.manager.sessions.get(f.environment.id),session);assert.equal(f.calls.includes('snapshot-recover'),false);assert.equal(f.calls.includes('stop'),false);await f.manager.assertAccess(f.environment.id);
 }finally{await f.close();}}
});

test('Explicit stop does not join a slow live deletion and its stale completion cannot replace a later job',async()=>{
 const f=await fixture({enabled:true,liveDeletionEnabled:true});let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>entered=resolve);let signal:AbortSignal|undefined;
 try{
  await f.product.initialize();await f.manager.wait((await f.manager.action(f.environment.id,'start')).id);f.hooks.remove=async(_resume,options)=>{signal=options.signal;entered();await gate;};
  const deletion=f.product.remove(f.environment.id,randomUUID(),'旧快照',f.environment.name,false);await began;const stop=await f.manager.action(f.environment.id,'stop');await f.manager.wait(stop.id);
  assert.equal(signal?.aborted,true);assert.equal(f.manager.tasks.has(deletion.id),true,'Stop must finish while an uncooperative copy operation is still pending');assert.equal(f.store.get(f.environment.id).state,'stopped');assert.equal(f.store.jobs().find(row=>row.id===stop.id)?.status,'succeeded');
  await assert.rejects(f.manager.action(f.environment.id,'start'),{code:'SNAPSHOT_BUSY'});release();await f.manager.wait(deletion.id);assert.equal(f.store.get(f.environment.id).state,'stopped');assert.equal(f.store.jobs().find(row=>row.id===deletion.id)?.status,'cancelled');assert.equal(f.manager.active.has(f.environment.id),false);
 }finally{release();await f.close();}
});

test('Power, resource and guest protection failures cancel live cleanup without changing the authoritative shutdown error',async()=>{
 for(const kind of ['power','resources','guard'] as const){const f=await fixture({enabled:true,liveDeletionEnabled:true});let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>entered=resolve);let signal:AbortSignal|undefined;
  try{await f.product.initialize();await f.manager.wait((await f.manager.action(f.environment.id,'start')).id);f.hooks.remove=async(_resume,options)=>{signal=options.signal;entered();await gate;};const job=f.product.remove(f.environment.id,randomUUID(),'旧快照',f.environment.name,false);await began;
   if(kind==='power')await f.manager.powerUnavailable('合成电源异常');else if(kind==='resources')await f.manager.resourcesUnavailable('合成资源异常');else await f.manager.failProtection(f.environment.id,'合成防护异常');
   const stopped=f.store.get(f.environment.id);assert.equal(signal?.aborted,true);assert.equal(stopped.state,'error');assert.equal(f.state(f.environment.id).state,'Off');release();await f.manager.wait(job.id);assert.equal(f.store.get(f.environment.id).state,'error');assert.equal(f.store.get(f.environment.id).lastError,stopped.lastError);assert.equal(f.manager.sessions.has(f.environment.id),false);assert.equal(f.store.jobs().find(row=>row.id===job.id)?.status,'cancelled');
  }finally{release();await f.close();}
 }
});

test('Unknown native restore state after live deletion failure quarantines the original session',async()=>{
 const f=await fixture({enabled:true,liveDeletionEnabled:true});try{await f.product.initialize();await f.manager.wait((await f.manager.action(f.environment.id,'start')).id);f.hooks.remove=async()=>{f.pending.add(f.environment.id);throw Error('synthetic ambiguous native state');};const job=f.product.remove(f.environment.id,randomUUID(),'旧快照',f.environment.name,false);await f.manager.wait(job.id);assert.equal(f.store.get(f.environment.id).state,'error');assert.equal(f.state(f.environment.id).state,'Off');assert.equal(f.manager.sessions.has(f.environment.id),false);assert.deepEqual(f.product.status().pendingIds,[f.environment.id]);assert.equal(f.calls.includes('snapshot-recover'),false);}finally{await f.close();}
});

test('Pre-cancelled live deletion never submits a native request or retires the current session',async()=>{
 const f=await fixture({enabled:true,liveDeletionEnabled:true});try{await f.product.initialize();await f.manager.wait((await f.manager.action(f.environment.id,'start')).id);const session=f.manager.sessions.get(f.environment.id),job=f.product.remove(f.environment.id,randomUUID(),'旧快照',f.environment.name,false);f.manager.cancel(job.id);await f.manager.wait(job.id);assert.equal(f.calls.includes('snapshot-delete'),false);assert.equal(f.manager.sessions.get(f.environment.id),session);assert.equal(f.store.get(f.environment.id).state,'running');assert.equal(f.store.jobs().find(row=>row.id===job.id)?.status,'cancelled');}finally{await f.close();}
});

test('A completed copy deletion cannot claim the current session stayed running after its lease was lost',async()=>{
 const f=await fixture({enabled:true,liveDeletionEnabled:true});try{await f.product.initialize();await f.manager.wait((await f.manager.action(f.environment.id,'start')).id);f.hooks.remove=async()=>{f.state(f.environment.id).active=false;};const job=f.product.remove(f.environment.id,randomUUID(),'旧快照',f.environment.name,false);await f.manager.wait(job.id);assert.notEqual(f.store.jobs().find(row=>row.id===job.id)?.status,'succeeded');assert.equal(f.store.get(f.environment.id).state,'error');assert.equal(f.state(f.environment.id).state,'Off');assert.equal(f.manager.sessions.has(f.environment.id),false);}finally{await f.close();}
});
