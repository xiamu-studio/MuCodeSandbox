import {windowsGuardInspection} from '../server/platform/windows/guard-diagnostics.ts';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {Store} from '../server/store.ts';import {WindowsManager,type WindowsBackend} from '../server/platform/windows/manager.ts';
import {AppError} from '../server/errors.ts';
import {WindowsNetworkSession} from '../server/platform/windows/session.ts';import {windowsPaths} from '../server/platform/windows/config.ts';
const input=()=>({name:'Windows fixture',cpus:1,memoryGiB:2,diskGiB:16,network:{mode:'http',host:'127.0.0.1',port:12345,username:'',password:'fixture-secret',strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.10'}}});
test('Disk compaction task is gated, exclusive and publishes success only after verification',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 try{
  const e=await f.manager.create(input());f.store.state(e.id,'stopped');
  const identity={platformId:'87654321-4321-4321-8321-abcdefabcdef',diskIdentifier:'abcdefab-4321-4321-8321-123456789abc',diskGiB:16,phase:'verifying' as const};
  f.manager.runtime.prepareDiskCompaction=async()=>{entered();await gate;return identity;};
  f.manager.runtime.verifyDiskCompaction=async(_c,value)=>{assert.deepEqual(value,identity);return {...identity,completed:true as const,beforeBytes:500,afterBytes:300};};
  f.manager.runtime.resumeDiskCompaction=async()=>({...identity,completed:true as const,beforeBytes:500,afterBytes:300});
  f.manager.runtime.cancelDiskCompaction=async()=>({cancelled:true as const});
  await assert.rejects(f.manager.compactDisk(e.id,'start',e.name),{code:'FEATURE_UNAVAILABLE'});f.manager.options.diskCompactionPreview=true;
  await assert.rejects(f.manager.compactDisk(e.id,'start','wrong'),{code:'DISK_COMPACTION_CONFIRMATION'});
  const other=await f.manager.create({...input(),name:'Other synthetic environment'});f.store.state(other.id,'stopped');
  const job=await f.manager.compactDisk(e.id,'start',e.name);await started;await assert.rejects(f.manager.action(e.id,'start'),{code:'DISK_COMPACTION_BUSY'});await assert.rejects(f.manager.action(other.id,'start'),{code:'DISK_COMPACTION_BUSY'});await assert.rejects(f.manager.compactDisk(other.id,'start',other.name),{code:'DISK_COMPACTION_BUSY'});
  release();await f.manager.wait(job.id);assert.equal(f.store.jobs().find(j=>j.id===job.id)?.status,'succeeded');assert.equal(f.store.get(e.id).state,'stopped');
  let releaseOther!:()=>void,enteredOther!:()=>void;const otherStarted=new Promise<void>(r=>enteredOther=r),otherGate=new Promise<void>(r=>releaseOther=r);
  const snapshot=f.manager.runSnapshotOperation(other.id,'snapshot-create',async()=>{enteredOther();await otherGate;});await otherStarted;
  try{await assert.rejects(f.manager.compactDisk(e.id,'start',e.name),{code:'DISK_COMPACTION_BUSY'});}finally{releaseOther();await f.manager.wait(snapshot.id);}
  f.manager.runtime.resumeDiskCompaction=async()=>{throw Error('Synthetic unknown provider result');};
  const failed=await f.manager.compactDisk(e.id,'resume',e.name);await f.manager.wait(failed.id);assert.equal(f.store.jobs().find(j=>j.id===failed.id)?.status,'failed');assert.equal(f.store.get(e.id).state,'error');
  let enteredCancel!:()=>void;const cancelStarted=new Promise<void>(r=>enteredCancel=r);
  f.manager.runtime.resumeDiskCompaction=async(_c,options={})=>new Promise((_resolve,reject)=>{enteredCancel();options.signal!.addEventListener('abort',()=>reject(Error('Synthetic provider outcome unknown')),{once:true});});
  const cancelled=await f.manager.compactDisk(e.id,'resume',e.name);await cancelStarted;f.manager.cancel(cancelled.id);await f.manager.wait(cancelled.id);
  const result=f.store.jobs().find(j=>j.id===cancelled.id)!;assert.equal(result.status,'failed');assert.match(result.message,/未确认完成/);assert.equal(f.store.get(e.id).state,'error');
 }finally{release();await f.close();}
});
for(const stopFails of [false,true])test(`Monitor reconciles an independently failed session with ${stopFails?'unconfirmed':'confirmed'} stop instead of leaving a running page`,async()=>{
 const f=await fixture();try{const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);const session=f.manager.sessions.get(e.id)!;session.driver.transportDiagnostics=()=>({state:'exited',failures:{TRANSPORT_RESET:1},lastFailure:'TRANSPORT_RESET',ignoredLines:0,oversizedLines:0});if(stopFails)session.driver.stop=async()=>{throw Error('Synthetic independent stop failure');};await session.fail().catch(()=>{});assert.equal(session.state,'failed');assert.equal(f.store.get(e.id).state,'running');await f.manager.monitor();assert.equal(f.store.get(e.id).state,'error');assert.equal(f.manager.sessions.has(e.id),false);const event=f.store.protectionEvents(e.id)[0];assert.equal(event.stopResult,stopFails?'failed':'confirmed');assert.equal(event.guard!.operation,'monitor');assert.equal(event.guard!.transport!.state,'exited');assert.equal(event.guard!.transport!.failures.TRANSPORT_RESET,1);}finally{await f.close();}
});
test('Unexpected transport exit records original evidence before teardown and later access failure',async()=>{
 const f=await fixture();try{
  const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);
  const session=f.manager.sessions.get(e.id)!;let state:'exited'|'ready'='exited';
  session.driver.transportDiagnostics=()=>({state,failures:{TRANSPORT_RESET:1},lastFailure:'TRANSPORT_RESET',ignoredLines:0,oversizedLines:0});
  const original=session.driver.disconnect;session.driver.disconnect=async()=>{state='ready';await original();};
  await Promise.all([session.transportFailed(),session.transportFailed()]);
  assert.equal(session.state,'failed');const initial=f.store.protectionEvents(e.id);assert.equal(initial.length,1);assert.equal(initial[0].guard?.operation,'monitor');assert.equal(initial[0].guard?.transport?.state,'exited');
  await f.manager.monitor();const final=f.store.protectionEvents(e.id);assert.equal(final.length,1);assert.equal(final[0].stopResult,'confirmed');assert.equal(final[0].guard?.transport?.state,'exited');
 }finally{await f.close();}
});
test('Monitor persists the owned control-pipe failure without raw error details',async()=>{
 const f=await fixture();try{const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);const session=f.manager.sessions.get(e.id)!;session.driver.transportDiagnostics=()=>({state:'ready',failures:{CONTROL_PIPE_ERROR:1},lastFailure:'CONTROL_PIPE_ERROR',ignoredLines:0,oversizedLines:0});await session.fail();await f.manager.monitor();const event=f.store.protectionEvents(e.id)[0];assert.equal(event.stopResult,'confirmed');assert.equal(event.guard!.transport!.failures.CONTROL_PIPE_ERROR,1);assert.equal(JSON.stringify(event).includes('fixture-secret'),false);}finally{await f.close();}
});
test('Process error records its fixed classification before teardown and reports stop outcome',async()=>{
 const f=await fixture();try{
  const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);
  const session=f.manager.sessions.get(e.id)!;let available=true;
  session.driver.transportDiagnostics=()=>available?{state:'ready',failures:{PROCESS_ERROR:1},lastFailure:'PROCESS_ERROR',ignoredLines:0,oversizedLines:0}:undefined;
  session.driver.disconnect=async()=>{available=false;};
  await session.transportFailed();await f.manager.monitor();
  const events=f.store.protectionEvents(e.id);assert.equal(events.length,1);
  assert.equal(events[0].stopResult,'confirmed');assert.equal(events[0].guard?.transport?.failures.PROCESS_ERROR,1);
  assert.equal(events[0].guard?.transport?.lastFailure,'PROCESS_ERROR');assert.equal(JSON.stringify(events).includes('fixture-secret'),false);
 }finally{await f.close();}
});
test('Access failure journals the current session transport snapshot and confirms stop without trusting raw stderr',async()=>{
 const f=await fixture();try{const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);const session=f.manager.sessions.get(e.id)!;session.driver.transportDiagnostics=()=>({state:'ready',failures:{FORWARD_CONNECT_REFUSED:1},lastFailure:'FORWARD_CONNECT_REFUSED',lastFailureAt:'2026-10-27T00:00:00.000Z',ignoredLines:0,oversizedLines:0});f.state(e.id).active=false;await assert.rejects(f.manager.assertAccess(e.id),{code:'GUARD_FAILED'});const event=f.store.protectionEvents(e.id)[0];assert.equal(event.guard!.transport!.failures.FORWARD_CONNECT_REFUSED,1);assert.equal(event.stopResult,'confirmed');assert.equal(f.state(e.id).state,'Off');assert.equal(JSON.stringify(event.guard).includes('fixture-secret'),false);}finally{await f.close();}
});
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'mu-win-manager-'));const store=new Store(path.join(root,'app'),Buffer.alloc(32,5));
 const states=new Map<string,{state:string;active:boolean;digest:string}>();let badProbe=false;
 const state=(id:string)=>{let s=states.get(id);if(!s){s={state:'Off',active:false,digest:'a'.repeat(64)};states.set(id,s);}return s;};
 const backend:WindowsBackend={info:async()=>({available:true,issues:[]}),create:async c=>{const p=windowsPaths(root,c.id);await mkdir(p.directory,{recursive:true});await writeFile(p.manifest,JSON.stringify({id:c.id}));},start:async c=>{state(c.id).state='Running';},stop:async c=>{state(c.id).state='Off';state(c.id).active=false;},state:async c=>({state:state(c.id).state}),
 inspectGuard:async c=>({digest:state(c.id).digest,leaseActive:state(c.id).active,remainingMs:state(c.id).active?45000:0}),
 connect:async c=>{assert.equal(state(c.id).active,false);},
 session:async c=>{const s=state(c.id);s.active=false;return new WindowsNetworkSession({inspect:async()=>({digest:s.digest,leaseActive:s.active,remainingMs:s.active?45000:0}),probe:async()=>[{receiver:'a',ip:'203.0.113.10'},{receiver:'b',ip:badProbe?'203.0.113.11':'203.0.113.10'}],activate:async()=>{s.active=true;},renew:async()=>{},revoke:async()=>{s.active=false;},disconnect:async()=>{},stop:async()=>{s.state='Off';s.active=false;}},c.expectedIp);}};
 const manager=new WindowsManager(store,backend,{runtimeRoot:root,base:{image:path.join(root,'base.vhdx'),imageSha256:'a'.repeat(64)}});
 return {manager,store,state,bad:()=>{badProbe=true;},close:async()=>{await manager.close();await rm(root,{recursive:true,force:true});}};
}

for(const initiallyRunning of [false,true])test(`Recovery preserves a pending backup marker and reports an actionable error when ${initiallyRunning?'running':'stopped'}`,async()=>{
 const f=await fixture();try{
  const e=await f.manager.create(input()),p=windowsPaths(f.manager.options.runtimeRoot,e.id);await mkdir(p.directory,{recursive:true});
  await writeFile(p.manifest,JSON.stringify({id:e.id}));await writeFile(path.join(p.directory,'backup-restore.json'),'synthetic pending restore');
  f.store.state(e.id,'stopped');f.state(e.id).state=initiallyRunning?'Running':'Off';
  await f.manager.recover();assert.equal(f.state(e.id).state,'Off');assert.equal(f.store.get(e.id).state,'error');assert.match(f.store.get(e.id).lastError??'',/备份恢复.*原备份/);
  assert.equal(await (await import('node:fs/promises')).readFile(path.join(p.directory,'backup-restore.json'),'utf8'),'synthetic pending restore');
 }finally{await f.close();}
});
test('Recovery does not claim a pending restored environment stopped when stop fails',async()=>{
 const f=await fixture();try{
  const e=await f.manager.create(input()),p=windowsPaths(f.manager.options.runtimeRoot,e.id);await mkdir(p.directory,{recursive:true});
  await writeFile(p.manifest,JSON.stringify({id:e.id}));await writeFile(path.join(p.directory,'backup-restore.json'),'synthetic pending restore');
  f.state(e.id).state='Running';f.manager.runtime.stop=async()=>{throw Error('Synthetic unconfirmed stop');};
  await f.manager.recover();assert.equal(f.store.get(e.id).state,'error');assert.match(f.store.get(e.id).lastError??'',/停机未确认/);assert.equal(f.state(e.id).state,'Running');
 }finally{await f.close();}
});
for(const phase of ['preparing','trimming','armed','compacting','verifying'] as const)test(`Startup retains pending disk maintenance at ${phase}`,async()=>{
 const f=await fixture();try{
  const e=await f.manager.create(input()),p=windowsPaths(f.manager.options.runtimeRoot,e.id);await mkdir(p.directory,{recursive:true});await writeFile(p.manifest,JSON.stringify({id:e.id}));f.state(e.id).state='Off';f.store.state(e.id,'error');
  f.manager.runtime.diskCompactionStatus=async()=>({pending:true,phase,platformId:'87654321-4321-4321-8321-abcdefabcdef',diskIdentifier:'abcdefab-4321-4321-8321-123456789abc',diskGiB:16,beforeBytes:100});
  await f.manager.recover();assert.equal(f.store.get(e.id).state,'error');assert.match(f.store.get(e.id).lastError??'',/磁盘维护/);assert.equal(f.state(e.id).state,'Off');
 }finally{await f.close();}
});
test('Startup does not hide an uninspectable disk maintenance state',async()=>{
 const f=await fixture();try{
  const e=await f.manager.create(input()),p=windowsPaths(f.manager.options.runtimeRoot,e.id);await mkdir(p.directory,{recursive:true});await writeFile(p.manifest,JSON.stringify({id:e.id}));f.state(e.id).state='Running';
  f.manager.runtime.diskCompactionStatus=async()=>{throw Error('synthetic status unavailable');};await f.manager.recover();assert.equal(f.state(e.id).state,'Off');assert.equal(f.store.get(e.id).state,'error');assert.match(f.store.get(e.id).lastError??'',/磁盘维护.*无法确认/);
 }finally{await f.close();}
});
test('Startup reports ordinary stopped state only when disk maintenance is clear',async()=>{
 const f=await fixture();try{
  const e=await f.manager.create(input()),p=windowsPaths(f.manager.options.runtimeRoot,e.id);await mkdir(p.directory,{recursive:true});await writeFile(p.manifest,JSON.stringify({id:e.id}));f.state(e.id).state='Off';f.store.state(e.id,'error');
  f.manager.runtime.diskCompactionStatus=async()=>({pending:false});await f.manager.recover();assert.equal(f.store.get(e.id).state,'stopped');
 }finally{await f.close();}
});
test('Startup reconciles two separate environments at a time and waits for all stop checks',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>entered=resolve);
 try{
  const environments=[];for(let i=0;i<4;i++){const e=await f.manager.create({...input(),name:'Recovery fixture '+i}),p=windowsPaths(f.manager.options.runtimeRoot,e.id);await mkdir(p.directory,{recursive:true});await writeFile(p.manifest,JSON.stringify({id:e.id}));f.state(e.id).state='Off';environments.push(e);}
  const state=f.manager.runtime.state;let active=0,maximum=0,calls=0,finished=false;
  f.manager.runtime.state=async c=>{active++;maximum=Math.max(maximum,active);calls++;if(calls===2)entered();try{await gate;return await state(c);}finally{active--;}};
  const recovering=f.manager.recover().then(()=>{finished=true;});await began;assert.equal(finished,false);assert.equal(calls,2);release();await recovering;
  assert.equal(calls,4);assert.equal(maximum,2);for(const e of environments)assert.equal(f.store.get(e.id).state,'stopped');
 }finally{release();await f.close();}
});
test('A startup reconciliation error waits for the other in-flight environment before failing',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>entered=resolve);
 try{
  for(let i=0;i<2;i++){const e=await f.manager.create({...input(),name:'Concurrent error fixture '+i}),p=windowsPaths(f.manager.options.runtimeRoot,e.id);await mkdir(p.directory,{recursive:true});await writeFile(p.manifest,JSON.stringify({id:e.id}));f.state(e.id).state='Off';}
  const failedId=f.store.list()[0].id;f.manager.snapshotAdmission={assertWritable:()=>{},blocked:id=>{if(id===failedId)throw Error('Synthetic recovery failure');return false;}};
  const original=f.manager.runtime.state;f.manager.runtime.state=async c=>{entered();await gate;return original(c);};let finished=false;
  const rejecting=assert.rejects(f.manager.recover().finally(()=>{finished=true;}),/Synthetic recovery failure/);await began;assert.equal(finished,false);release();await rejecting;assert.equal(finished,true);
 }finally{release();await f.close();}
});
test('Pending disk compaction blocks settings and snapshot cleanup without hiding its status',async()=>{
 const f=await fixture();let work=0;try{
  const e=await f.manager.create(input()),p=windowsPaths(f.manager.options.runtimeRoot,e.id);await mkdir(p.directory,{recursive:true});await writeFile(p.manifest,JSON.stringify({id:e.id}));f.state(e.id).state='Off';f.store.state(e.id,'error','磁盘维护尚未确认完成');
  f.manager.runtime.diskCompactionStatus=async()=>({pending:true,phase:'compacting',platformId:'87654321-4321-4321-8321-abcdefabcdef',diskIdentifier:'abcdefab-4321-4321-8321-123456789abc',diskGiB:16,beforeBytes:100});
  await assert.rejects(f.manager.update(e.id,{...input(),name:'Changed'}),{code:'DISK_COMPACTION_PENDING'});assert.equal(f.store.get(e.id).name,e.name);
  const job=f.manager.runSnapshotOperation(e.id,'snapshot-staging-cleanup',async()=>{work++;});await f.manager.wait(job.id);
  assert.equal(work,0);assert.equal(f.store.get(e.id).state,'error');assert.match(f.store.get(e.id).lastError??'',/磁盘维护/);assert.equal(f.store.jobs().find(j=>j.id===job.id)?.status,'failed');
 }finally{await f.close();}
});
test('Settings and snapshot work recheck disk maintenance after a stopped-state query',async()=>{
 for(const mode of ['settings','snapshot'] as const){const f=await fixture();let checks=0,work=0;try{
  const e=await f.manager.create(input()),p=windowsPaths(f.manager.options.runtimeRoot,e.id);await mkdir(p.directory,{recursive:true});await writeFile(p.manifest,JSON.stringify({id:e.id}));f.state(e.id).state='Off';f.store.state(e.id,'error');
  f.manager.runtime.diskCompactionStatus=async()=>++checks===1?{pending:false}:{pending:true,phase:'compacting',platformId:'87654321-4321-4321-8321-abcdefabcdef',diskIdentifier:'abcdefab-4321-4321-8321-123456789abc',diskGiB:16,beforeBytes:100};
  if(mode==='settings'){await assert.rejects(f.manager.update(e.id,{...input(),name:'Changed'}),{code:'DISK_COMPACTION_PENDING'});assert.equal(f.store.get(e.id).name,e.name);}
  else{const job=f.manager.runSnapshotOperation(e.id,'snapshot-staging-cleanup',async()=>{work++;});await f.manager.wait(job.id);assert.equal(work,0);assert.equal(f.store.get(e.id).state,'error');assert.equal(f.store.jobs().find(j=>j.id===job.id)?.status,'failed');}
  assert.equal(checks,2);
 }finally{await f.close();}}
});
test('Snapshot recovery remains available while disk maintenance is clear',async()=>{
 const f=await fixture();let work=0;try{
  const e=await f.manager.create(input()),p=windowsPaths(f.manager.options.runtimeRoot,e.id);await mkdir(p.directory,{recursive:true});await writeFile(p.manifest,JSON.stringify({id:e.id}));f.state(e.id).state='Off';f.store.state(e.id,'error');
  f.manager.snapshotAdmission={assertWritable:()=>{throw new AppError('Synthetic pending snapshot',409,'SNAPSHOT_PENDING');},blocked:()=>true};
  f.manager.runtime.diskCompactionStatus=async()=>({pending:false});const job=f.manager.runSnapshotOperation(e.id,'snapshot-recover',async()=>{work++;});await f.manager.wait(job.id);
  assert.equal(work,1);assert.equal(f.store.jobs().find(j=>j.id===job.id)?.status,'succeeded');assert.equal(f.store.get(e.id).state,'stopped');
 }finally{await f.close();}
});
test('A pending backup restore blocks editing the saved configuration',async()=>{
 const f=await fixture();try{
  const e=await f.manager.create(input()),p=windowsPaths(f.manager.options.runtimeRoot,e.id);await mkdir(p.directory,{recursive:true});
  await writeFile(path.join(p.directory,'backup-restore.json'),'synthetic pending restore');f.store.state(e.id,'error');
  await assert.rejects(f.manager.update(e.id,{...input(),name:'Changed during restore'}),{code:'RESTORE_PENDING'});
  assert.equal(f.store.get(e.id).name,e.name);assert.equal(await (await import('node:fs/promises')).readFile(path.join(p.directory,'backup-restore.json'),'utf8'),'synthetic pending restore');
 }finally{await f.close();}
});
test('Configuration changes recheck for a restore marker after checking VM state',async()=>{
 const f=await fixture();try{
  const e=await f.manager.create(input()),p=windowsPaths(f.manager.options.runtimeRoot,e.id);await mkdir(p.directory,{recursive:true});f.store.state(e.id,'stopped');
  f.manager.runtime.state=async()=>{await writeFile(path.join(p.directory,'backup-restore.json'),'synthetic pending restore');return {state:'Off'};};
  await assert.rejects(f.manager.update(e.id,{...input(),name:'Changed during restore'}),{code:'RESTORE_PENDING'});assert.equal(f.store.get(e.id).name,e.name);
 }finally{await f.close();}
});
test('A pending backup restore blocks disk growth and snapshot mutation',async()=>{
 const f=await fixture();let growth=0,snapshot=0;try{
  const e=await f.manager.create(input()),p=windowsPaths(f.manager.options.runtimeRoot,e.id);await mkdir(p.directory,{recursive:true});
  await writeFile(path.join(p.directory,'backup-restore.json'),'synthetic pending restore');f.store.state(e.id,'error');
  Object.defineProperty(f.manager.runtime,'diskGrowthAvailable',{value:true});f.manager.runtime.growDisk=async()=>{growth++;return {diskGiB:32,reconciled:false};};
  await assert.rejects(f.manager.growDisk(e.id,32,e.name),{code:'RESTORE_PENDING'});assert.equal(growth,0);assert.equal(f.store.get(e.id).diskGiB,16);
  const job=f.manager.runSnapshotOperation(e.id,'snapshot-delete',async()=>{snapshot++;});await f.manager.wait(job.id);
  assert.equal(snapshot,0);assert.equal(f.store.get(e.id).state,'error');assert.match(f.store.get(e.id).lastError??'',/备份恢复/);assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'failed');
 }finally{await f.close();}
});
test('Snapshot mutation rechecks restore state after the asynchronous VM check',async()=>{
 const f=await fixture();let mutations=0;try{
  const e=await f.manager.create(input()),p=windowsPaths(f.manager.options.runtimeRoot,e.id);await mkdir(p.directory,{recursive:true});f.store.state(e.id,'stopped');
  f.manager.runtime.state=async()=>{await writeFile(path.join(p.directory,'backup-restore.json'),'synthetic pending restore');return {state:'Off'};};
  const job=f.manager.runSnapshotOperation(e.id,'snapshot-create',async()=>{mutations++;});await f.manager.wait(job.id);
  assert.equal(mutations,0);assert.equal(f.store.get(e.id).state,'error');assert.match(f.store.get(e.id).lastError??'',/备份恢复/);assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'failed');
 }finally{await f.close();}
});

test('User stop revokes viewers and egress before normal browser preparation, including a viewer exception',async()=>{
 const f=await fixture();try{const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);let viewer=false,prepared=false;
  f.manager.onAccessRevoked=()=>{viewer=true;throw Error('Synthetic viewer failure');};f.manager.runtime.prepareNormalStop=async(c,options)=>{assert.equal(c.id,e.id);assert.ok(viewer);assert.equal(f.manager.sessions.has(e.id),false);assert.equal(f.state(e.id).active,false);assert.equal(f.state(e.id).state,'Running');assert.equal(options?.signal?.aborted,false);prepared=true;};
  const job=await f.manager.action(e.id,'stop');await f.manager.wait(job.id);assert.equal(prepared,true);assert.equal(f.store.get(e.id).state,'stopped');assert.equal(f.state(e.id).state,'Off');assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'succeeded');
 }finally{await f.close();}
});
test('Protection during normal restart interrupts preparation, preserves the error and cannot start a fresh session',async()=>{
 const f=await fixture();try{const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);let entered!:()=>void;const preparing=new Promise<void>(resolve=>entered=resolve);let signal:AbortSignal|undefined;
  f.manager.runtime.prepareNormalStop=async(_c,options)=>{signal=options?.signal;entered();await new Promise<void>(()=>{});};
  const job=await f.manager.action(e.id,'restart');await preparing;await f.manager.failProtection(e.id,'Synthetic fault during normal restart');await f.manager.wait(job.id);
  assert.equal(signal?.aborted,true);assert.equal(f.state(e.id).state,'Off');assert.equal(f.manager.sessions.size,0);assert.equal(f.store.get(e.id).state,'error');assert.match(f.store.get(e.id).lastError??'',/Synthetic fault|防护异常/);assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'failed');
 }finally{await f.close();}
});

for(const storage of ['state','addProtectionEvent','updateProtectionStop','all'] as const)for(const stopFails of [false,true])test(`Windows protection keeps access closed with ${storage} write failure and ${stopFails?'unconfirmed':'confirmed'} stop`,async t=>{
 const f=await fixture();
 try{
  const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);
  const session=f.manager.sessions.get(e.id)!;let disconnects=0,revocations=0,stops=0,viewerCloses=0;
  session.driver.disconnect=async()=>{disconnects++;};
  session.driver.revoke=async()=>{revocations++;throw Error('Synthetic guest revoke failure');};
  session.driver.stop=async()=>{stops++;if(stopFails)throw Error('Synthetic Hyper-V stop failure');f.state(e.id).state='Off';f.state(e.id).active=false;};
  f.manager.onAccessRevoked=()=>{viewerCloses++;throw Error('Synthetic viewer close failure');};
  const writes=storage==='all'?['state','addProtectionEvent','updateProtectionStop'] as const:[storage];
  for(const write of writes)t.mock.method(f.store,write,()=>{throw Error('Synthetic disk write failure');});
  const stopping=f.manager.failProtection(e.id,'Synthetic protection fault');
  assert.equal(f.manager.sessions.has(e.id),false,'Retire the session before awaiting shutdown or disk writes');
  const [result]=await Promise.allSettled([stopping]);
  assert.equal(result.status,storage==='state'||storage==='all'?'rejected':'fulfilled');
  assert.equal(disconnects,1);assert.equal(revocations,1);assert.equal(stops,1);assert.equal(viewerCloses,1);
  assert.equal(f.state(e.id).state,stopFails?'Running':'Off');
  const event=f.manager.protectionRecords.list(e.id)[0];
  assert.equal(event.stopResult,stopFails?'failed':'confirmed');
  if(storage!=='state')assert.equal(event.persisted,false);
  t.mock.restoreAll();
  await assert.rejects(f.manager.assertAccess(e.id),{code:'GUARD_FAILED'});
  assert.equal(f.manager.sessions.has(e.id),false,'Restoring disk writes cannot restore the old session');
 }finally{t.mock.restoreAll();f.manager.onAccessRevoked=undefined;await f.close();}
});
test('Windows lifecycle reaches running only after closed-start and exit approval',async()=>{const f=await fixture();try{const e=await f.manager.create(input());assert.equal(e.network.password,undefined);const job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);assert.equal(f.store.get(e.id).state,'running');assert.equal((await f.manager.protection(e.id)).integrity,'verified');const stopped=await f.manager.action(e.id,'stop');await f.manager.wait(stopped.id);assert.equal(f.store.get(e.id).state,'stopped');assert.equal(f.state(e.id).state,'Off');}finally{await f.close();}});
test('Cancelling a startup during exit verification prevents permit activation',async()=>{
 const f=await fixture();let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);const create=f.manager.runtime.session;let probes=0,activations=0;
 try{
  f.manager.runtime.session=async(...args)=>{const session=await create(...args),probe=session.driver.probe,activate=session.driver.activate;session.driver.probe=async()=>{probes++;enter();await gate;return probe();};session.driver.activate=async()=>{activations++;await activate();};return session;};
  const e=await f.manager.create(input()),job=await f.manager.action(e.id,'start');await entered;f.manager.cancel(job.id);release();await f.manager.wait(job.id);
  assert.equal(probes,1);assert.equal(activations,0);assert.equal(f.state(e.id).active,false);assert.equal(f.state(e.id).state,'Off');assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'cancelled');
 }finally{release();await f.close();}
});

test('Sealed local backup cleanup remains independent of VM fences but keeps lifecycle exclusion, explicit cancel and shutdown',async()=>{
 const f=await fixture();try{
  const env=await f.manager.create(input());f.store.state(env.id,'running');assert.throws(()=>f.manager.runBackupCleanupMaintenance(async()=>{}),{code:'ENVIRONMENT_BUSY'});f.store.state(env.id,'stopped');
  f.manager.snapshotAdmission={assertWritable:()=>{throw new AppError('Synthetic pending VM recovery',409,'SNAPSHOT_PENDING');},blocked:()=>true};
  await f.manager.hostUnavailable('Synthetic unavailable components');await f.manager.resourcesUnavailable('Synthetic low disk');await f.manager.powerUnavailable('Synthetic uninitialized power monitor');
  assert.throws(()=>f.manager.runMaintenance('backup-export',async()=>{}),{code:'SNAPSHOT_PENDING'});
  let entered!:()=>void,signal:AbortSignal|undefined;const began=new Promise<void>(resolve=>entered=resolve);
  const job=f.manager.runBackupCleanupMaintenance(async current=>{signal=current;entered();await new Promise<void>((_resolve,reject)=>{current.addEventListener('abort',()=>reject(current.reason),{once:true});});});await began;
  assert.throws(()=>f.manager.runBackupCleanupMaintenance(async()=>{}),{code:'BACKUP_BUSY'});await f.manager.hostUnavailable('Synthetic later network fence');await f.manager.resourcesUnavailable('Synthetic later disk fence');await f.manager.powerUnavailable('Synthetic later power fence');assert.equal(signal!.aborted,false);
  f.manager.cancel(job.id);await f.manager.wait(job.id);assert.equal(signal!.aborted,true);assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'cancelled');
  let closingSignal:AbortSignal|undefined,closingEntered!:()=>void;const closingBegan=new Promise<void>(resolve=>closingEntered=resolve);f.manager.runBackupCleanupMaintenance(async current=>{closingSignal=current;closingEntered();await new Promise<void>((_resolve,reject)=>current.addEventListener('abort',()=>reject(current.reason),{once:true}));});await closingBegan;await f.manager.close();assert.equal(closingSignal!.aborted,true);assert.throws(()=>f.manager.runBackupCleanupMaintenance(async()=>{}),{code:'CLOSING'});
 }finally{await f.close();}
});
test('Windows disk jobs require exact confirmation and only commit capacity after confirmed maintenance',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const began=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
 try{const e=await f.manager.create(input());Object.defineProperty(f.manager.runtime,'diskGrowthAvailable',{value:true});f.manager.runtime.growDisk=async(c,target)=>{assert.equal(c.diskGiB,16);assert.equal(f.state(e.id).state,'Off');entered();await gate;return{diskGiB:target,reconciled:false};};
  await assert.rejects(f.manager.growDisk(e.id,32,e.name),{code:'ENVIRONMENT_BUSY'});await f.manager.wait((await f.manager.action(e.id,'start')).id);await assert.rejects(f.manager.growDisk(e.id,32,e.name),{code:'ENVIRONMENT_BUSY'});await f.manager.wait((await f.manager.action(e.id,'stop')).id);
  await assert.rejects(f.manager.growDisk(e.id,32,'other'),{code:'DISK_GROWTH_CONFIRMATION'});const job=await f.manager.growDisk(e.id,32,e.name);await began;assert.equal(f.store.get(e.id).diskGiB,16);assert.equal(f.store.get(e.id).state,'starting');await assert.rejects(f.manager.action(e.id,'start'),{code:'ENVIRONMENT_BUSY'});await assert.rejects(f.manager.update(e.id,input()),{code:'ENVIRONMENT_BUSY'});release();await f.manager.wait(job.id);assert.equal(f.store.get(e.id).diskGiB,32);assert.equal(f.store.get(e.id).state,'stopped');assert.equal(f.store.get(e.id).network.password,'fixture-secret');assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'succeeded');
 }finally{release();await f.close();}
});
test('Cancelling a disk job keeps the old workspace capacity and a resumable error instead of advertising completion',async()=>{
 const f=await fixture();let enter!:()=>void;const began=new Promise<void>(resolve=>enter=resolve);
 try{const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);await f.manager.wait((await f.manager.action(e.id,'stop')).id);Object.defineProperty(f.manager.runtime,'diskGrowthAvailable',{value:true});f.manager.runtime.growDisk=async(_c,_target,options={})=>new Promise((_resolve,reject)=>{enter();options.signal!.addEventListener('abort',()=>reject(Error('Synthetic maintenance cancelled')),{once:true});});const job=await f.manager.growDisk(e.id,32,e.name);await began;f.manager.cancel(job.id);await f.manager.wait(job.id);assert.equal(f.store.get(e.id).diskGiB,16);assert.equal(f.store.get(e.id).state,'error');assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'cancelled');assert.equal(f.state(e.id).state,'Off');
 }finally{await f.close();}
});
test('Existing restored VMs start without a blank base while new allocations still require preparation',async()=>{
 const f=await fixture();let creates=0;const create=f.manager.runtime.create;f.manager.runtime.create=async(...args)=>{creates++;return create(...args);};
 try{const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);await f.manager.wait((await f.manager.action(e.id,'stop')).id);assert.equal(creates,1);
  f.manager.options.base=undefined;f.manager.profiles.clear();const reopened=await f.manager.action(e.id,'start');await f.manager.wait(reopened.id);assert.equal(f.store.jobs().find(job=>job.id===reopened.id)?.status,'succeeded');assert.equal(f.store.get(e.id).state,'running');assert.equal(creates,1);await f.manager.wait((await f.manager.action(e.id,'stop')).id);
  const fresh=await f.manager.create(input()),blocked=await f.manager.action(fresh.id,'start');await f.manager.wait(blocked.id);const failed=f.store.jobs().find(job=>job.id===blocked.id)!;assert.equal(failed.status,'failed');assert.match(failed.message,/创建新环境前请先准备/);assert.equal(creates,1);
 }finally{await f.close();}
});

test('A conflicting receiver fails the job and confirms stop instead of advertising running',async()=>{const f=await fixture();try{f.bad();const e=await f.manager.create(input()),job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);assert.equal(f.store.get(e.id).state,'error');assert.equal(f.state(e.id).state,'Off');assert.equal(f.store.jobs().find(j=>j.id===job.id)?.status,'failed');}finally{await f.close();}});
test('Windows exit status uses dated active-session receipts and clears them after stop',async()=>{
 const f=await fixture();try{
  const e=await f.manager.create(input());assert.equal((await f.manager.egress(e.id)).status,'unverified');
  const original=f.manager.runtime.session;f.manager.runtime.session=async(...args)=>{const session=await original(...args);session.driver.probe=async()=>[{receiver:'ipify',ip:'203.0.113.10',latencyMs:10},{receiver:'ipwho',ip:'203.0.113.10',latencyMs:12}];return session;};
  await f.manager.wait((await f.manager.action(e.id,'start')).id);
  const first=await f.manager.egress(e.id);assert.equal(first.status,'verified');assert.equal(first.actualIp,'203.0.113.10');assert.equal(first.verification?.receipts.length,2);
  assert.equal((await f.manager.egress(e.id)).checkedAt,first.checkedAt,'Reading old receipts must not renew their timestamp');
  await f.manager.wait((await f.manager.action(e.id,'stop')).id);assert.equal((await f.manager.egress(e.id)).status,'unverified');assert.equal((await f.manager.egress(e.id)).actualIp,undefined);
 }finally{await f.close();}
});
test('Concurrent status reads share only their in-flight inspection, never operation authorization',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>entered=resolve);
 try{const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);
  const inspect=f.manager.runtime.inspectGuard;let calls=0;f.manager.runtime.inspectGuard=async c=>{calls++;if(calls===1){entered();await gate;}return inspect(c);};
  const protection=f.manager.protection(e.id);await began;const egress=f.manager.egress(e.id);await f.manager.assertAccess(e.id);assert.equal(calls,2,'authorization must inspect independently');
  release();assert.equal((await protection).integrity,'verified');await egress;assert.equal(calls,2,'status requests should share the pending inspection');
  await f.manager.protection(e.id);assert.equal(calls,3,'completed inspections are not cached');
 }finally{release();await f.close();}
});
test('A status inspection cannot report success after a browser switch begins',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void,releaseJob!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>entered=resolve),jobGate=new Promise<void>(resolve=>releaseJob=resolve);
 try{const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);const inspect=f.manager.runtime.inspectGuard;
  let first=true;f.manager.runtime.inspectGuard=async c=>{if(first){first=false;entered();await gate;}return inspect(c);};const result=assert.rejects(f.manager.protection(e.id),{code:'PROTECTION_BUSY'});await began;
  const job=await f.manager.submit(e.id,'open-browser',async()=>jobGate);release();await result;releaseJob();await f.manager.wait(job.id);
 }finally{release();releaseJob();await f.close();}
});
test('Access checks quarantine changed integrity; startup recovery stops leftover VMs',async()=>{const f=await fixture();try{const e=await f.manager.create(input()),job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);f.state(e.id).digest='b'.repeat(64);await assert.rejects(f.manager.assertAccess(e.id));assert.equal(f.state(e.id).state,'Off');f.state(e.id).state='Running';await f.manager.recover();assert.equal(f.state(e.id).state,'Off');assert.equal(f.store.get(e.id).state,'stopped');}finally{await f.close();}});
test('Windows profile edits preserve omitted credentials and reject unprotected modes',async()=>{const f=await fixture();try{await assert.rejects(f.manager.create({...input(),network:{mode:'direct'}}));const e=await f.manager.create(input()),edited=input();delete (edited.network as {password?:string}).password;await f.manager.update(e.id,edited);assert.equal(f.store.get(e.id).network.password,'fixture-secret');assert.equal((await f.manager.snapshot()).environments[0].network.password,undefined);}finally{await f.close();}});
test('A delayed stopped-state reply cannot let settings overwrite a newly running environment',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>entered=resolve);
 try{const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);await f.manager.wait((await f.manager.action(e.id,'stop')).id);
  const original=f.manager.runtime.state;let first=true;f.manager.runtime.state=async(...args)=>{const captured=await original(...args);if(first){first=false;entered();await gate;}return captured;};
  const editing=f.manager.update(e.id,{...input(),name:'must not overwrite'});const denied=assert.rejects(editing,/环境已变化/);await began;await f.manager.wait((await f.manager.action(e.id,'start')).id);release();await denied;assert.equal(f.store.get(e.id).state,'running');assert.equal(f.store.get(e.id).name,input().name);
 }finally{release();await f.close();}
});

test('Environment removal requires exact confirmation, a stopped guest and confirmed backend cleanup',async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 try{const e=await f.manager.create(input());Object.defineProperty(f.manager.runtime,'deletionAvailable',{value:true});f.manager.runtime.remove=async()=>{await gate;};
  await assert.rejects(f.manager.remove(e.id,'other'),{code:'DELETE_CONFIRMATION_REQUIRED'});const start=await f.manager.action(e.id,'start');await f.manager.wait(start.id);await assert.rejects(f.manager.remove(e.id,e.name),{code:'ENVIRONMENT_BUSY'});const stop=await f.manager.action(e.id,'stop');await f.manager.wait(stop.id);
  const removal=await f.manager.remove(e.id,e.name);assert.equal(f.store.get(e.id).id,e.id);assert.throws(()=>f.manager.cancel(removal.id),{code:'DELETE_IN_PROGRESS'});release();await f.manager.wait(removal.id);assert.throws(()=>f.store.get(e.id),{code:'NOT_FOUND'});assert.equal(f.store.jobs().find(job=>job.id===removal.id)?.status,'succeeded');
 }finally{release();await f.close();}
});
test('An unconfirmed backend removal keeps the environment and reports a failed job',async()=>{
 const f=await fixture();try{const e=await f.manager.create(input());Object.defineProperty(f.manager.runtime,'deletionAvailable',{value:true});f.manager.runtime.remove=async()=>{throw Error('Storage still in use');};const job=await f.manager.remove(e.id,e.name);await f.manager.wait(job.id);assert.equal(f.store.get(e.id).state,'error');assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'failed');}finally{await f.close();}
});
test('Recovery restores a lost manifest only after the backend confirms the original guest',async()=>{
 const f=await fixture();try{const e=await f.manager.create(input());f.store.state(e.id,'creating');let attempts=0;f.manager.runtime.recoverCreation=async()=>{attempts++;return false;};await f.manager.recover();assert.equal(f.store.get(e.id).state,'error');f.manager.runtime.recoverCreation=async()=>{attempts++;f.state(e.id).state='Off';return true;};await f.manager.recover();assert.equal(attempts,2);assert.equal(f.store.get(e.id).state,'stopped');}finally{await f.close();}
});

test('Unreachable guard inspection immediately quarantines the VM',async()=>{const f=await fixture();try{const e=await f.manager.create(input()),job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);f.manager.runtime.inspectGuard=async()=>{throw Error('unreachable');};await assert.rejects(f.manager.assertAccess(e.id),{code:'GUARD_FAILED'});assert.equal(f.state(e.id).state,'Off');assert.equal(f.store.get(e.id).state,'error');}finally{await f.close();}});

for(const mode of ['cancelled-command','late-valid','late-invalid','independent-failure'] as const)test(`Cancelled access inspection denies its caller and preserves protection: ${mode}`,async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const began=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve),abort=new AbortController();
 try{
  const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);const session=f.manager.sessions.get(e.id)!;
  f.manager.runtime.inspectGuard=async(_c,options={})=>{assert.equal(options.signal,abort.signal);entered();await gate;
   if(mode==='cancelled-command')throw new AppError('Synthetic cancelled command',409,'CANCELLED');
   if(mode==='independent-failure')throw new AppError('Synthetic independent failure',500,'PROCESS_FAILED');
   return {digest:session.guardDigest,leaseActive:mode!=='late-invalid',remainingMs:mode==='late-invalid'?0:30000};
  };
  const pending=f.manager.assertAccess(e.id,false,abort.signal).then(()=>null,error=>error);await began;abort.abort();release();const error=await pending;
  const cancellation=mode==='cancelled-command'||mode==='late-valid';assert.equal(error?.code,cancellation?'CANCELLED':'GUARD_FAILED');
  assert.equal(f.store.get(e.id).state,cancellation?'running':'error');assert.equal(f.state(e.id).state,cancellation?'Running':'Off');
  assert.equal(f.store.protectionEvents(e.id).length,cancellation?0:1);if(cancellation)assert.equal(f.manager.sessions.get(e.id),session);
 }finally{release();await f.close();}
});

for(const phase of ['before-work','after-work'] as const)test(`Cancelling a live snapshot task during its ${phase} guard check leaves the healthy session running`,async()=>{
 const f=await fixture();let entered!:()=>void;const began=new Promise<void>(resolve=>entered=resolve);let checks=0,work=0;
 try{
  const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);const session=f.manager.sessions.get(e.id)!,original=f.manager.runtime.inspectGuard;
  f.manager.runtime.inspectGuard=async(c,options={})=>{
   if(++checks===(phase==='before-work'?1:2)){entered();return new Promise((_resolve,reject)=>{options.signal!.addEventListener('abort',()=>reject(new AppError('Synthetic cancelled check',409,'CANCELLED')),{once:true});});}
   return original(c,options);
  };
  const job=f.manager.runLiveSnapshotDeletion(e.id,async()=>{work++;});await began;f.manager.cancel(job.id);await f.manager.wait(job.id);
  assert.equal(work,phase==='before-work'?0:1);assert.equal(f.store.jobs().find(j=>j.id===job.id)?.status,'cancelled');
  assert.equal(f.store.get(e.id).state,'running');assert.equal(f.state(e.id).state,'Running');assert.equal(f.manager.sessions.get(e.id),session);assert.equal(f.store.protectionEvents(e.id).length,0);
  f.manager.runtime.inspectGuard=original;await f.manager.assertAccess(e.id);
 }finally{await f.close();}
});
test('A duplicate start cannot replace an active network session',async()=>{
 const f=await fixture();try{const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);const session=f.manager.sessions.get(e.id);
  await assert.rejects(f.manager.action(e.id,'start'),{code:'ENVIRONMENT_BUSY'});assert.equal(f.manager.sessions.get(e.id),session);assert.equal(session?.state,'active');assert.equal(f.store.get(e.id).state,'running');
 }finally{await f.close();}
});
test('Starting after an unconfirmed stop cannot reuse a guest that is still running',async()=>{
 const f=await fixture();try{const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);await f.manager.wait((await f.manager.action(e.id,'stop')).id);
  f.store.state(e.id,'error','Synthetic unconfirmed stop');f.state(e.id).state='Running';let starts=0;const start=f.manager.runtime.start;f.manager.runtime.start=async(...args)=>{starts++;return start(...args);};
  const job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);assert.equal(starts,0);assert.equal(f.manager.sessions.has(e.id),false);assert.equal(f.state(e.id).state,'Running');assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'failed');assert.match(f.store.get(e.id).lastError??'',/无法确认环境已停止/);
  f.state(e.id).state='Off';const retry=await f.manager.action(e.id,'start');await f.manager.wait(retry.id);assert.equal(starts,1);assert.equal(f.store.get(e.id).state,'running');
 }finally{await f.close();}
});

for(const access of ['assertAccess','protection'] as const)for(const restarted of [false,true])for(const inspectionFails of [false,true])test(`A ${access} inspection finishing after intentional ${restarted?'restart':'stop'} cannot quarantine a retired session (${inspectionFails?'SSH error':'late receipt'})`,async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
 try{const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);const retired=f.manager.sessions.get(e.id)!;
  const inspect=f.manager.runtime.inspectGuard;f.manager.runtime.inspectGuard=async()=>{entered();await gate;if(inspectionFails)throw Error('Guest SSH closed during intentional shutdown');return{digest:retired.guardDigest,leaseActive:true,remainingMs:30000};};
  const denied=assert.rejects(f.manager[access](e.id),{code:'GUARD_FAILED'});await began;await f.manager.wait((await f.manager.action(e.id,'stop')).id);f.manager.runtime.inspectGuard=inspect;
  if(restarted)await f.manager.wait((await f.manager.action(e.id,'start')).id);const current=f.manager.sessions.get(e.id);release();await denied;
  assert.equal(f.store.get(e.id).state,restarted?'running':'stopped');assert.equal(f.store.get(e.id).lastError,null);assert.equal(f.state(e.id).state,restarted?'Running':'Off');assert.equal(f.manager.sessions.get(e.id),current);assert.equal(retired.state,'failed');if(restarted){assert.notEqual(current,retired);assert.equal(current!.state,'active');}
 }finally{release();await f.close();}
});

test('Even busy-allowed consumers cannot begin authorization during intentional shutdown',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
 try{const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);let inspected=0;const inspect=f.manager.runtime.inspectGuard;f.manager.runtime.inspectGuard=async c=>{inspected++;return inspect(c);};f.manager.onAccessRevoked=()=>{entered();};const session=f.manager.sessions.get(e.id)!;const stop=session.driver.stop;session.driver.stop=async()=>{await gate;await stop();};
  const job=await f.manager.action(e.id,'stop');await began;await assert.rejects(f.manager.assertAccess(e.id,true),{code:'GUARD_FAILED'});assert.equal(inspected,0);release();await f.manager.wait(job.id);assert.equal(f.store.get(e.id).state,'stopped');
 }finally{release();await f.close();}
});

test('Host monitoring failure stops active VMs and prevents another start',async()=>{const f=await fixture();try{const e=await f.manager.create(input()),job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);await f.manager.hostUnavailable('fixture host event');assert.equal(f.state(e.id).state,'Off');await assert.rejects(f.manager.action(e.id,'start'),{code:'HOST_NETWORK_CHANGED'});assert.equal((await f.manager.snapshot()).system.hostNetwork?.state,'failed');}finally{await f.close();}});
test('A resource fence closes sessions and blocks restart while stop and status remain usable',async()=>{const f=await fixture();try{const e=await f.manager.create(input()),job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);f.manager.runtime.resources=async()=>({session:'a'.repeat(32),totalMemoryBytes:10*1024**3,availableMemoryBytes:128*1024**2,memoryReserveBytes:1024**3,memoryCriticalBytes:512*1024**2,freeDiskBytes:20*1024**3,diskFloorBytes:2*1024**3,lastReservedGrowthBytes:0,virtualDiskLimitGiB:1024,registeredDiskGiB:32,fenced:true,issue:'memory',cleanupRunning:false,stopsConfirmed:true});await f.manager.monitor();assert.equal(f.state(e.id).state,'Off');assert.match((await f.manager.snapshot()).system.hostResourceIssue!,/内存/);assert.equal((await f.manager.snapshot()).system.hostNetwork?.state,'ready');await assert.rejects(f.manager.action(e.id,'start'),{code:'RESOURCE_FENCED'});await f.manager.wait((await f.manager.action(e.id,'stop')).id);}finally{await f.close();}});

test('An unconfirmed stopped VM cannot have its network profile edited',async()=>{const f=await fixture();try{const e=await f.manager.create(input()),job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);const stop=await f.manager.action(e.id,'stop');await f.manager.wait(stop.id);f.state(e.id).state='Running';await assert.rejects(f.manager.update(e.id,input()),{code:'STOP_UNCONFIRMED'});}finally{await f.close();}});
test('An independent power fence closes sessions and requires a fresh application before restart',async()=>{const f=await fixture();try{const e=await f.manager.create(input()),job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);f.manager.runtime.power=async()=>({session:'a'.repeat(32),monitoring:true,fenced:true,issue:'resume',cleanupRunning:false,stopsConfirmed:true});await f.manager.monitor();assert.equal(f.state(e.id).state,'Off');assert.match((await f.manager.snapshot()).system.hostPowerIssue!,/休眠或唤醒/);assert.equal((await f.manager.snapshot()).system.hostResourceIssue,null);assert.equal((await f.manager.snapshot()).system.hostNetwork?.state,'ready');await assert.rejects(f.manager.action(e.id,'start'),{code:'POWER_FENCED'});await f.manager.wait((await f.manager.action(e.id,'stop')).id);}finally{await f.close();}});

test('Shutdown drains an in-flight monitor before closing the store',async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 try{const e=await f.manager.create(input()),job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);
  let entered!:()=>void;const inspecting=new Promise<void>(resolve=>{entered=resolve;});const inspect=f.manager.runtime.inspectGuard;const session=f.manager.sessions.get(e.id)!;session.driver.inspect=async()=>{entered();await gate;return inspect(await f.manager.profile(f.store.get(e.id)));};
  const monitoring=f.manager.monitor();await inspecting;let closed=false;const closing=f.manager.close().then(()=>{closed=true;});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(closed,false);release();await monitoring;await closing;assert.equal(closed,true);
 }finally{release();await f.close();}
});

test('A long browser job keeps renewing protection and sandbox failure still quarantines it',async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 try{const e=await f.manager.create(input()),start=await f.manager.action(e.id,'start');await f.manager.wait(start.id);let renewals=0;f.manager.sessions.get(e.id)!.driver.renew=async()=>{renewals++;};
  const job=await f.manager.submit(e.id,'open-browser',async()=>gate);await f.manager.monitor();assert.equal(renewals,1);assert.equal(f.state(e.id).state,'Running');
  f.manager.inspectAdditionalProtection=async()=>{throw Error('Browser sandbox changed');};await f.manager.monitor();assert.equal(f.state(e.id).state,'Off');assert.equal(f.store.get(e.id).state,'error');release();await f.manager.wait(job.id);
 }finally{release();await f.close();}
});

test('Protection read during a browser switch is pending, while an actual failed session stays a guard failure',async()=>{
 for(const action of ['open-browser','close-browser']){
  const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  try{const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);
   const job=await f.manager.submit(e.id,action,async()=>gate);await assert.rejects(f.manager.protection(e.id),{code:'PROTECTION_BUSY'});await assert.rejects(f.manager.egress(e.id),{code:'PROTECTION_BUSY'});
   assert.equal(f.manager.sessions.get(e.id)?.state,'active');assert.equal(f.state(e.id).active,true);
   await f.manager.sessions.get(e.id)!.fail();await assert.rejects(f.manager.protection(e.id),{code:'GUARD_FAILED'});await assert.rejects(f.manager.egress(e.id),{code:'GUARD_FAILED'});
   release();await f.manager.wait(job.id);
  }finally{release();await f.close();}
 }
});

for(const scenario of ['lease','digest','command'] as const)test('Access failure must retain phase evidence: '+scenario,async()=>{
 const f=await fixture();try{
  const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);
  if(scenario==='lease')f.state(e.id).active=false;
  if(scenario==='digest')f.state(e.id).digest='b'.repeat(64);
  if(scenario==='command')f.manager.runtime.inspectGuard=async()=>{throw new AppError('Synthetic inspect deadline with PRIVATE_TEXT',504,'TIMEOUT');};
  await assert.rejects(f.manager.assertAccess(e.id),{code:'GUARD_FAILED'});
  const event=f.manager.protectionRecords.list(e.id)[0];
  assert.equal(event.stopResult,'confirmed');assert.equal(f.state(e.id).state,'Off');assert.equal(f.manager.sessions.has(e.id),false);
  assert.ok(event.guard,'Access-path stop lost its structured guard diagnosis');
  assert.equal(event.guard.operation,'access');assert.equal(event.guard.stage,'access-inspection');
  assert.equal(event.guard.reason,scenario==='lease'?'lease-inactive':scenario==='digest'?'integrity-changed':'inspection-failed');
  assert.equal(event.guard.verifiedReceiptCount,0);assert.ok(Number.isFinite(event.guard.durations.accessInspectMs));
  if(scenario==='command'){assert.equal(event.guard.access,undefined);assert.equal(event.guard.failureCode,'TIMEOUT');}
  else {assert.equal(event.guard.access!.digestMatches,scenario!=='digest');assert.equal(event.guard.access!.leaseActive,scenario!=='lease');}
  assert.doesNotMatch(JSON.stringify(event),/PRIVATE_TEXT|fixture-secret/);
 }finally{await f.close();}
});


test('Access diagnostics name changed components but never persist their digests',async()=>{
 const f=await fixture();try{
  const components={tables:'a'.repeat(64),files:'a'.repeat(64),networkRules:'a'.repeat(64),networkRoutes:'a'.repeat(64),networkDns:'a'.repeat(64),networkDomains:'a'.repeat(64)};
  const inspect=async(id:string)=>({digest:f.state(id).digest,leaseActive:f.state(id).active,remainingMs:f.state(id).active?45000:0,components:{...components}});
  const original=f.manager.runtime.session;f.manager.runtime.session=async c=>{const session=await original(c);session.driver.inspect=()=>inspect(c.id);return session;};f.manager.runtime.inspectGuard=c=>inspect(c.id);
  const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);
  const session=f.manager.sessions.get(e.id)!,exposed=session.guardComponents!;exposed.networkRoutes='c'.repeat(64);assert.equal(session.guardComponents!.networkRoutes,'a'.repeat(64));
  components.networkRoutes='b'.repeat(64);f.state(e.id).digest='b'.repeat(64);
  await assert.rejects(f.manager.assertAccess(e.id),{code:'GUARD_FAILED'});
  const event=f.manager.protectionRecords.list(e.id)[0];assert.equal(event.stopResult,'confirmed');assert.equal(event.kind,'integrity');assert.deepEqual(event.guard!.access!.changedComponents,['networkRoutes']);
  assert.doesNotMatch(JSON.stringify(event.guard),/[abc]{64}/);assert.equal(event.guard!.verifiedReceiptCount,0);
 }finally{await f.close();}
});

test('Access failure records the trusted failing inspection step without private text',async()=>{
 const {attachGuardFailureSource}=await import('../server/platform/windows/guard-diagnostics.ts');
 const f=await fixture();try{
  const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);
  f.manager.runtime.inspectGuard=async()=>{throw attachGuardFailureSource(new AppError('PRIVATE_DETAIL',500,'PROCESS_FAILED'),'guest-inspection');};
  await assert.rejects(f.manager.assertAccess(e.id),{code:'GUARD_FAILED'});
  const event=f.manager.protectionRecords.list(e.id)[0];assert.equal(event.guard?.failureSource,'guest-inspection');assert.equal(event.guard?.failureCode,'PROCESS_FAILED');assert.equal(event.stopResult,'confirmed');assert.doesNotMatch(JSON.stringify(event),/PRIVATE_DETAIL/);
 }finally{await f.close();}
});

for(const code of ['TIMEOUT','PROCESS_FAILED','PROCESS_INPUT_CLOSED','PROCESS_OUTPUT_TOO_LARGE','PROCESS_OUTPUT_HANDLER_FAILED','BROKER_TIMEOUT','BROKER_UNAVAILABLE','CANCELLED','PRIVATE_CODE'])test('Access diagnosis accepts only a bounded owned error code: '+code,async()=>{
 const f=await fixture();try{
  const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);
  f.manager.runtime.inspectGuard=async()=>{throw new AppError('PRIVATE_ERROR_MESSAGE',500,code);};
  await assert.rejects(f.manager.assertAccess(e.id),{code:'GUARD_FAILED'});
  const event=f.manager.protectionRecords.list(e.id)[0];assert.equal(event.stopResult,'confirmed');assert.equal(event.guard!.failureCode,code==='PRIVATE_CODE'?undefined:code);
  assert.equal(event.guard!.reason,'inspection-failed');assert.equal(event.guard!.access,undefined);assert.doesNotMatch(JSON.stringify(event),/PRIVATE_/);
 }finally{await f.close();}
});

test('Invalid inspection schema and forged error properties cannot leak response text into access diagnosis',async()=>{
 for(const scenario of ['schema','forged']){
  const f=await fixture();try{
   const e=await f.manager.create(input());await f.manager.wait((await f.manager.action(e.id,'start')).id);
   f.manager.runtime.inspectGuard=async()=>{if(scenario==='schema')windowsGuardInspection.parse({digest:'PRIVATE_RESPONSE'});throw Object.assign(Error('PRIVATE_MESSAGE'),{code:'TIMEOUT',guard:{failureCode:'TIMEOUT',reason:'lease-inactive'}});};
   await assert.rejects(f.manager.assertAccess(e.id),{code:'GUARD_FAILED'});
   const event=f.manager.protectionRecords.list(e.id)[0];assert.equal(event.stopResult,'confirmed');assert.equal(event.guard!.failureCode,scenario==='schema'?'INVALID_GUARD_RESPONSE':undefined);assert.equal(event.guard!.reason,'inspection-failed');assert.doesNotMatch(JSON.stringify(event),/PRIVATE_/);
  }finally{await f.close();}
 }
});
