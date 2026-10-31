import {test} from 'node:test';import assert from 'node:assert/strict';
import {prepareAndCompactWindowsDisk,inspectCompactedWindowsDisk,resumeWindowsDiskCompaction,cancelPreCompaction} from '../server/platform/windows/disk-compaction.ts';
import {windowsConfigSchema} from '../server/platform/windows/config.ts';
import {AppError} from '../server/errors.ts';
const id='12345678-1234-4234-8234-123456789abc',platformId='87654321-4321-4321-8321-abcdefabcdef',diskIdentifier='abcdefab-4321-4321-8321-123456789abc';
const config=windowsConfigSchema.parse({version:1,id,diskGiB:32,image:'C:/fixture/base.vhdx',imageSha256:'a'.repeat(64),proxy:{mode:'http',address:'127.0.0.1',port:12345},expectedIp:'203.0.113.10'});
function fixture(mode='ok'){
 let state='Off',guards=0,stops=0;const calls:string[]=[],abort=new AbortController();
 const answer=(phase:string)=>({platformId,diskIdentifier:mode==='changed-identity'&&phase==='armed'?'ffffffff-ffff-ffff-ffff-ffffffffffff':diskIdentifier,diskGiB:32,phase});
 const runtime={
  state:async()=>({state}),disconnect:async()=>{calls.push('disconnect');},
  startDiskCompaction:async()=>{calls.push('start');state='Running';if(mode==='start-fail')throw Error('start failed');},
  inspectGuard:async()=>{guards++;return {leaseActive:mode==='active-lease'||mode==='late-lease'&&guards===2,remainingMs:mode==='active-lease'||mode==='late-lease'&&guards===2?1:0};},
  management:async(_c:unknown,_args:string[],o:{input:string})=>{if(o.input.includes("'volatileState':True")){calls.push('arm');return JSON.stringify({closed:true,volatileState:true});}calls.push('trim');if(mode==='trim-fail')throw Error('trim failed');if(mode==='undefined-failure')throw undefined;if(mode==='cancel')abort.abort();return JSON.stringify({device:'/dev/sda1',diskBytes:32*2**30,discardCompleted:true});},
  stop:async()=>{stops++;calls.push('stop');if(mode==='stop-fail'||mode==='both-fail')throw Error('stop failed');state=mode==='not-off'?'Running':'Off';},
  broker:{call:async(action:string)=>{calls.push(action);if(action==='disk-compact-begin')return answer('preparing');if(action==='disk-compact-trimmed')return answer('armed');if(action==='disk-compact-run'){if(mode==='async-running'||mode==='async-abort')throw new AppError('Original job running',409,'DISK_COMPACTION_RUNNING');return answer('verifying');}if(action==='disk-compact-reconcile'&&mode==='async-running')return answer('verifying');if(action==='disk-compact-reconcile'&&mode==='async-abort'){abort.abort();throw new AppError('Original job running',409,'DISK_COMPACTION_RUNNING');}throw Error('unexpected');}},
 };
 if(mode==='both-fail')runtime.startDiskCompaction=async()=>{calls.push('start');state='Running';throw Error('start failed');};
 return {runtime:runtime as unknown as Parameters<typeof prepareAndCompactWindowsDisk>[0],calls,abort,get stops(){return stops;}};
}
test('Compaction coordinator closes the lease, trims, confirms stop and retains verification phase',async()=>{
 const f=fixture();const r=await prepareAndCompactWindowsDisk(f.runtime,config);assert.equal(r.phase,'verifying');assert.deepEqual(f.calls,['disconnect','disk-compact-begin','start','arm','trim','stop','disk-compact-trimmed','disk-compact-run']);
});
test('A running original compaction is observed without submitting it again; cancellation stops waiting',async()=>{
 const f=fixture('async-running'),result=await prepareAndCompactWindowsDisk(f.runtime,config);assert.equal(result.phase,'verifying');assert.equal(f.calls.filter(x=>x==='disk-compact-run').length,1);assert.equal(f.calls.filter(x=>x==='disk-compact-reconcile').length,1);
 const cancelled=fixture('async-abort');await assert.rejects(prepareAndCompactWindowsDisk(cancelled.runtime,config,{signal:cancelled.abort.signal}));assert.equal(cancelled.calls.filter(x=>x==='disk-compact-run').length,1);assert.equal(cancelled.calls.filter(x=>x==='disk-compact-reconcile').length,1);
});
test('Failures, revocation, cancellation and unconfirmed stop cannot reach offline compaction',async()=>{
 for(const mode of ['start-fail','active-lease','late-lease','trim-fail','undefined-failure','cancel','stop-fail','both-fail','not-off','changed-identity']){
  const f=fixture(mode);let rejected=false;try{await prepareAndCompactWindowsDisk(f.runtime,config,{signal:f.abort.signal});}catch(error){rejected=true;if(mode==='both-fail')assert.ok(error instanceof AggregateError);}
  assert.equal(rejected,true,mode);assert.equal(f.stops,1,mode);assert.equal(f.calls.includes('disk-compact-run'),false,mode);
  if(mode!=='changed-identity')assert.equal(f.calls.includes('disk-compact-trimmed'),false,mode);
 }
});
function verifyFixture(mode='ok'){
 const events:string[]=[],expected={platformId,diskIdentifier,diskGiB:32,phase:'verifying' as const};let state='Off',guards=0;
 const rt={state:async()=>({state}),disconnect:async()=>{events.push('disconnect');},startDiskCompactionVerify:async()=>{events.push('verify-start');state='Running';if(mode==='start-fail')throw Error('start failed');},
  inspectGuard:async()=>{guards++;return{leaseActive:mode==='lease'&&guards===2,remainingMs:mode==='lease'&&guards===2?1:0};},
  management:async(_c:unknown,_a:string[],o:{input:string})=>{if(o.input.includes("'volatileState':True")){events.push('arm');return JSON.stringify({closed:true,volatileState:true});}events.push('filesystem');const partition=32*2**30-128*2**20;return JSON.stringify({diskBytes:32*2**30,device:mode==='wrong-device'?'/dev/sdb1':'/dev/sda1',beforeFilesystemBytes:partition,filesystemBytes:mode==='bad-size'?partition+1:partition,partitionBytes:partition,partitionStartBytes:128*2**20,scratchInMemory:true});},
  stop:async()=>{events.push('stop');if(mode==='stop-fail')throw Error('stop failed');state='Off';},
  broker:{call:async(action:string,parameters:Record<string,unknown>)=>{events.push(action);if(action==='disk-compact-review')return {...expected,diskIdentifier:mode==='identity'?'ffffffff-ffff-ffff-ffff-ffffffffffff':diskIdentifier,beforeBytes:5*2**30,afterBytes:3*2**30};assert.equal(action,'disk-compact-finish');assert.equal(parameters.afterBytes,3*2**30);assert.equal(parameters.partitionStartBytes,128*2**20);return {completed:true,platformId,diskIdentifier,diskGiB:32,beforeBytes:5*2**30,afterBytes:mode==='bad-commit'?4*2**30:3*2**30};}},
 };
 return {runtime:rt as unknown as Parameters<typeof inspectCompactedWindowsDisk>[0],events,expected};
}
test('Verification checks guarded guest geometry, stops and commits the measured disk identity',async()=>{
 const f=verifyFixture();const r=await inspectCompactedWindowsDisk(f.runtime,config,f.expected);assert.equal(r.completed,true);assert.equal(r.beforeBytes,5*2**30);assert.equal(r.afterBytes,3*2**30);assert.deepEqual(f.events,['disconnect','verify-start','arm','filesystem','stop','disk-compact-review','disk-compact-finish']);
});
test('Verification failures and inconsistent completion receipts are not reported as success',async()=>{
 for(const mode of ['start-fail','lease','wrong-device','bad-size','stop-fail','identity','bad-commit']){
  const f=verifyFixture(mode);await assert.rejects(inspectCompactedWindowsDisk(f.runtime,config,f.expected));assert.ok(f.events.includes('stop'),mode);
  if(mode!=='identity'&&mode!=='bad-commit')assert.equal(f.events.includes('disk-compact-review'),false,mode);
  if(mode!=='bad-commit')assert.equal(f.events.includes('disk-compact-finish'),false,mode);
 }
});
function recoveryFixture(phase:'preparing'|'trimming'|'armed'|'compacting'|'verifying'|'none',confirmed=false,jobTracked?:boolean){
 const events:string[]=[],base={platformId,diskIdentifier,diskGiB:32};let state='Off';
 const rt={state:async()=>({state}),disconnect:async()=>{events.push('disconnect');},startDiskCompaction:async()=>{events.push('trim-start');state='Running';},startDiskCompactionVerify:async()=>{events.push('verify-start');state='Running';},inspectGuard:async()=>({leaseActive:false,remainingMs:0}),stop:async()=>{events.push('stop');state='Off';},
  management:async(_c:unknown,_a:string[],o:{input:string})=>{if(o.input.includes("'volatileState':True"))return JSON.stringify({closed:true,volatileState:true});if(o.input.includes("discardCompleted"))return JSON.stringify({device:'/dev/sda1',diskBytes:32*2**30,discardCompleted:true});const size=32*2**30-128*2**20;return JSON.stringify({diskBytes:32*2**30,device:'/dev/sda1',beforeFilesystemBytes:size,filesystemBytes:size,partitionBytes:size,partitionStartBytes:128*2**20,scratchInMemory:true});},
  broker:{call:async(action:string)=>{events.push(action);switch(action){case 'disk-compact-status':return phase==='none'?{pending:false}:{pending:true,...base,phase,beforeBytes:5*2**30,...(jobTracked===undefined?{}:{jobTracked})};case 'disk-compact-retry':return {...base,phase:'preparing'};case 'disk-compact-trimmed':return {...base,phase:'armed'};case 'disk-compact-run':return {...base,phase:'verifying'};case 'disk-compact-reconcile':if(!confirmed)throw Error('Job remains unconfirmed');return {...base,phase:'verifying'};case 'disk-compact-review':return {...base,phase:'verifying',beforeBytes:5*2**30,afterBytes:3*2**30};case 'disk-compact-finish':return {completed:true,...base,beforeBytes:5*2**30,afterBytes:3*2**30};case 'disk-compact-cancel':return {cancelled:true};default:throw Error('Unexpected recovery action '+action);}}}};
 return {runtime:rt as unknown as Parameters<typeof resumeWindowsDiskCompaction>[0],events};
}
test('Stopped interrupted preparation can resume, while confirmed compression resumes at verification only',async()=>{
 for(const phase of ['preparing','trimming','armed','verifying'] as const){const f=recoveryFixture(phase),result=await resumeWindowsDiskCompaction(f.runtime,config);assert.equal(result.completed,true);assert.equal(f.events.includes('disk-compact-begin'),false);assert.equal(f.events.includes('disk-compact-retry'),phase==='trimming'||phase==='armed');assert.equal(f.events.includes('disk-compact-run'),phase!=='verifying');assert.equal(f.events.includes('verify-start'),true);}
});
test('A confirmed original compaction job resumes at verification without another submission',async()=>{
 const f=recoveryFixture('compacting',true),result=await resumeWindowsDiskCompaction(f.runtime,config);assert.equal(result.completed,true);assert.equal(f.events.includes('disk-compact-reconcile'),true);assert.equal(f.events.includes('disk-compact-run'),false);assert.equal(f.events.includes('verify-start'),true);
});
test('Missing original job identity reports actionable failure without submitting or querying a different job',async()=>{
 const f=recoveryFixture('compacting',false,false);await assert.rejects(resumeWindowsDiskCompaction(f.runtime,config),{code:'DISK_COMPACTION_JOB_UNAVAILABLE'});assert.deepEqual(f.events,['disk-compact-status']);
});
test('Unknown compression outcome is neither retried nor cancelled',async()=>{
 for(const phase of ['compacting','verifying','none'] as const){const f=recoveryFixture(phase);await assert.rejects(cancelPreCompaction(f.runtime,config));assert.equal(f.events.includes('disk-compact-cancel'),false);if(phase!=='verifying'){await assert.rejects(resumeWindowsDiskCompaction(f.runtime,config));assert.equal(f.events.includes('disk-compact-run'),false);}}
 for(const phase of ['preparing','trimming','armed'] as const){const f=recoveryFixture(phase);assert.deepEqual(await cancelPreCompaction(f.runtime,config),{cancelled:true});assert.equal(f.events.includes('disk-compact-cancel'),true);}
});
