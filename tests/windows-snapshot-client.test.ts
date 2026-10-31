import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';
import {WindowsSnapshots,type WindowsSnapshotTransaction} from '../server/platform/windows/snapshots.ts';
import type {HyperVBrokerClient} from '../server/platform/windows/broker.ts';
const environmentId=randomUUID(),snapshotId=randomUUID(),platformId=randomUUID(),transactionId=randomUUID(),cipher='enc:'+Buffer.alloc(64,31).toString('base64'),seed=Buffer.alloc(40001,17),seedSha256=createHash('sha256').update(seed).digest('hex');
const prepared:WindowsSnapshotTransaction={pending:true,id:environmentId,platformId,transactionId,snapshotId,phase:'applied',ownerConfiguration:cipher,seedBytes:seed.length,seedSha256,cpus:2,memoryGiB:2,diskGiB:32,imageSha256:'a'.repeat(64)};
const record={id:snapshotId,environmentId,name:'中文快照',createdAt:'2026-10-24T00:00:00.1234567Z',bytes:3*2**20+seed.length,seedSha256,cpus:2,memoryGiB:2,diskGiB:32,imageSha256:'a'.repeat(64)};
const owner={ownerConfiguration:cipher,seedSha256,cpus:2,memoryGiB:2,diskGiB:32,imageSha256:'a'.repeat(64)};
const stagingReview={id:snapshotId,operation:'create' as const,phase:'copy' as const,token:'c'.repeat(64),bytes:65536,files:1,partialReceipt:false};
function client(handler:(action:string,p:Record<string,unknown>)=>unknown){const calls:{action:string;p:Record<string,unknown>}[]=[];const broker={call:async(action,p={})=>{calls.push({action,p});return handler(action,p);}} as Pick<HyperVBrokerClient,'call'>;return {value:new WindowsSnapshots(broker),calls};}

test('Staging review binds the fixed copy and operation and never accepts private or path authority fields',async()=>{
 const good=client(()=>stagingReview);assert.deepEqual(await good.value.inspectStaging(environmentId,snapshotId,'create'),stagingReview);assert.deepEqual(good.calls,[{action:'snapshot-staging-review',p:{id:environmentId,copyId:snapshotId,operation:'create'}}]);
 for(const patch of [{id:randomUUID()},{operation:'restore'},{token:'C'.repeat(64)},{bytes:-1},{files:4},{phase:'done'},{path:'F:/other'},{ownerConfiguration:cipher},{partialReceipt:'false'}])await assert.rejects(client(()=>({...stagingReview,...patch})).value.inspectStaging(environmentId,snapshotId,'create'));
 const bad=client(()=>stagingReview);await assert.rejects(bad.value.inspectStaging('../other',snapshotId,'create'));await assert.rejects(bad.value.inspectStaging(environmentId,'../copy','create'));await assert.rejects(bad.value.inspectStaging(environmentId,snapshotId,'other' as 'create'));assert.equal(bad.calls.length,0);
});

test('Staging cleanup sends the reviewed token and explicit retry mode and verifies the complete receipt',async()=>{
 const receipt={deleted:true,alreadyDeleted:false,id:snapshotId,operation:'create',bytes:stagingReview.bytes};const good=client(()=>receipt);assert.deepEqual(await good.value.cleanupStaging(environmentId,stagingReview,false),receipt);assert.deepEqual(good.calls,[{action:'snapshot-staging-cleanup',p:{id:environmentId,copyId:snapshotId,operation:'create',token:stagingReview.token,resumeOnly:false}}]);
 for(const patch of [{id:randomUUID()},{operation:'restore'},{deleted:false},{bytes:1},{alreadyDeleted:true},{directory:'F:/other'}])await assert.rejects(client(()=>({...receipt,...patch})).value.cleanupStaging(environmentId,stagingReview,false));
 assert.equal((await client(()=>({...receipt,alreadyDeleted:true,bytes:0})).value.cleanupStaging(environmentId,{...stagingReview,phase:'done',files:0,bytes:0},true)).alreadyDeleted,true);
 const bad=client(()=>receipt);await assert.rejects(bad.value.cleanupStaging(environmentId,{...stagingReview,token:'not-a-token'},false));await assert.rejects(bad.value.cleanupStaging(environmentId,stagingReview,'true' as unknown as boolean));assert.equal(bad.calls.length,0);
});

test('Deletion uses an explicit resume-only flag and binds the exact environment, snapshot and name receipt',async()=>{
 const receipt={deleted:true,alreadyDeleted:false,id:snapshotId,environmentId,name:record.name,bytes:record.bytes};const {value,calls}=client(()=>receipt);
 await value.remove(environmentId,snapshotId,record.name,true);assert.deepEqual(calls[0],{action:'snapshot-delete',p:{id:environmentId,snapshotId,name:record.name,resumeOnly:true}});
 for(const patch of [{id:randomUUID()},{environmentId:randomUUID()},{name:'替换名称'},{ownerConfiguration:cipher},{deleted:false},{bytes:0}])await assert.rejects(client(()=>({...receipt,...patch})).value.remove(environmentId,snapshotId,record.name,false));
 const invalid=client(()=>receipt);await assert.rejects(invalid.value.remove(environmentId,'../outside',record.name,false));await assert.rejects(invalid.value.remove(environmentId,snapshotId,'快照\n',false));await assert.rejects(invalid.value.remove(environmentId,snapshotId,record.name,'false' as unknown as boolean));assert.equal(invalid.calls.length,0);
});
test('Pending deletion inventory rejects duplicate, foreign and private authority fields',async()=>{
 const pending={id:snapshotId,environmentId,name:record.name,createdAt:record.createdAt,phase:'retired',bytes:record.bytes};assert.deepEqual(await client(()=>[pending]).value.deletions(environmentId),[pending]);
 for(const rows of [[pending,pending],[{...pending,environmentId:randomUUID()}],[{...pending,authoritySha256:'a'.repeat(64)}]])await assert.rejects(client(()=>rows).value.deletions(environmentId));
});

test('Live deletion is an explicit bounded broker capability and never changes the legacy request by default',async()=>{
 const receipt={deleted:true,alreadyDeleted:false,id:snapshotId,environmentId,name:record.name,bytes:record.bytes},f=client(()=>receipt);
 await f.value.remove(environmentId,snapshotId,record.name,false,{allowRunning:true});assert.deepEqual(f.calls[0].p,{id:environmentId,snapshotId,name:record.name,resumeOnly:false,allowRunning:true});
 await f.value.remove(environmentId,snapshotId,record.name,false,{allowRunning:false});assert.equal(Object.hasOwn(f.calls[1].p,'allowRunning'),false);
 await assert.rejects(f.value.remove(environmentId,snapshotId,record.name,false,{allowRunning:'true' as unknown as boolean}));assert.equal(f.calls.length,2);
});

test('Snapshot client accepts native timestamp precision and excludes owner configuration from list records',async()=>{
 const {value}=client(()=>[record]);assert.deepEqual(await value.list(environmentId),[record]);
 const leaked=client(()=>[{...record,ownerConfiguration:cipher}]);await assert.rejects(leaked.value.list(environmentId));
});
test('Snapshot client rejects duplicate or foreign inventory identities',async()=>{
 for(const reply of [[record,record],[{...record,environmentId:randomUUID()}]])await assert.rejects(client(()=>reply).value.list(environmentId));
 await assert.rejects(client(()=>({ids:[environmentId,environmentId]})).value.pending());assert.deepEqual(await client(()=>({ids:[environmentId]})).value.pending(),[environmentId]);
});
test('Snapshot client validates configuration and identities before privileged requests',async()=>{
 const {value,calls}=client(()=>record);
 for(const input of ['plaintext','enc:AA==',cipher+' '])await assert.rejects(value.create(environmentId,'中文',{...owner,ownerConfiguration:input}));
 await assert.rejects(value.create(environmentId,'中文\n',owner));await assert.rejects(value.create('../outside','中文',owner));assert.equal(calls.length,0);
});
test('Snapshot creation binds the original seed digest and environment',async()=>{
 for(const reply of [{...record,seedSha256:'b'.repeat(64)},{...record,environmentId:randomUUID()},{...record,diskGiB:40}])await assert.rejects(client(()=>reply).value.create(environmentId,'中文快照',owner));
 const {value,calls}=client(()=>record);assert.deepEqual(await value.create(environmentId,'中文快照',owner),record);assert.equal(calls[0].action,'snapshot-create');assert.equal(calls[0].p.seedSha256,seedSha256);assert.equal(calls[0].p.diskGiB,32);
});
test('Snapshot preparation rejects incomplete and unrelated transaction replies',async()=>{
 for(const reply of [{pending:false},{...prepared,phase:'prepared'},{...prepared,id:randomUUID()},{...prepared,snapshotId:randomUUID()}])await assert.rejects(client(()=>reply).value.prepare(environmentId,snapshotId,owner));
 assert.deepEqual(await client(()=>prepared).value.prepare(environmentId,snapshotId,owner),prepared);
});
test('Snapshot commit binds the exact transaction, configuration, resource and seed version',async()=>{
 const committed={...prepared,phase:'committed'};
 for(const patch of [{id:randomUUID()},{transactionId:randomUUID()},{snapshotId:randomUUID()},{platformId:randomUUID()},{ownerConfiguration:'enc:'+Buffer.alloc(64,32).toString('base64')},{diskGiB:40},{imageSha256:'b'.repeat(64)},{seedSha256:'b'.repeat(64)},{seedBytes:seed.length+1}])await assert.rejects(client(()=>({...committed,...patch})).value.commit(prepared));
 const {value,calls}=client(()=>committed);assert.deepEqual(await value.commit(prepared),committed);assert.deepEqual(calls[0],{action:'snapshot-commit',p:{id:environmentId,transactionId}});
});
test('Snapshot recovery accepts only a bound persisted decision and never starts the VM',async()=>{
 for(const phase of ['prepared','applied'])await assert.rejects(client(()=>({...prepared,phase})).value.recover(environmentId));
 for(const phase of ['rolled-back','committed']){const {value,calls}=client(()=>({...prepared,phase}));assert.equal((await value.recover(environmentId)).pending,true);assert.deepEqual(calls.map(c=>c.action),['snapshot-recover']);}
 assert.deepEqual(await client(()=>({pending:false})).value.recover(environmentId),{pending:false});
});
test('Snapshot acknowledgement requires a resolved exact transaction',async()=>{
 const {value,calls}=client(()=>({acknowledged:true}));await assert.rejects(value.acknowledge(prepared));assert.equal(calls.length,0);assert.deepEqual(await value.acknowledge({...prepared,phase:'rolled-back'}),{acknowledged:true});assert.deepEqual(calls[0],{action:'snapshot-acknowledge',p:{id:environmentId,transactionId}});
});
test('Recovery binds its expected transaction and archived decisions expose a cipher digest without owner material',async()=>{
 const {value,calls}=client(()=>({...prepared,phase:'rolled-back'}));await value.recover(environmentId,{transactionId});assert.deepEqual(calls[0],{action:'snapshot-recover',p:{id:environmentId,transactionId}});
 await assert.rejects(client(()=>({...prepared,transactionId:randomUUID(),phase:'rolled-back'})).value.recover(environmentId,{transactionId}));
 const {pending,ownerConfiguration,...fields}=prepared,archived={...fields,phase:'committed',acknowledged:true,ownerConfigurationSha256:createHash('sha256').update(cipher).digest('hex')};
 const history=client(()=>archived);assert.deepEqual(await history.value.outcome(environmentId,transactionId),archived);assert.deepEqual(history.calls[0],{action:'snapshot-outcome',p:{id:environmentId,transactionId}});
 for(const patch of [{id:randomUUID()},{transactionId:randomUUID()},{phase:'applied'},{ownerConfiguration:cipher},{ownerConfigurationSha256:'invalid'}])await assert.rejects(client(()=>({...archived,...patch})).value.outcome(environmentId,transactionId));
});
function seedChunk(p:Record<string,unknown>){const offset=Number(p.offset),chunk=seed.subarray(offset,offset+32768);return {data:chunk.toString('base64'),nextOffset:offset+chunk.length,done:offset+chunk.length===seed.length};}
test('Snapshot original seed is fully authenticated before returning to configuration replay',async()=>{
 const {value,calls}=client((_action,p)=>seedChunk(p));const bytes=await value.readSeed(prepared);try{assert.deepEqual(bytes,seed);assert.deepEqual(calls.map(c=>c.p.offset),[0,32768]);assert.ok(calls.every(c=>c.action==='snapshot-seed'&&c.p.id===environmentId&&c.p.transactionId===transactionId));}finally{bytes.fill(0);}
});
test('Snapshot seed rejects truncation, bad sequence, false finality and changed contents',async()=>{
 for(const alter of [(v:ReturnType<typeof seedChunk>)=>({...v,data:v.data.slice(0,-4)}),(v:ReturnType<typeof seedChunk>)=>({...v,nextOffset:v.nextOffset+1}),(v:ReturnType<typeof seedChunk>)=>({...v,done:!v.done}),(v:ReturnType<typeof seedChunk>)=>({...v,data:Buffer.alloc(Buffer.from(v.data,'base64').length,99).toString('base64')})]){
  const {value,calls}=client((_action,p)=>alter(seedChunk(p)));await assert.rejects(value.readSeed(prepared));assert.ok(calls.every(c=>c.action==='snapshot-seed'));
 }
});
test('Snapshot seed cancellation cannot commit or acknowledge a partial read',async()=>{
 const controller=new AbortController(),{value,calls}=client((_action,p)=>{controller.abort();return seedChunk(p);});await assert.rejects(value.readSeed(prepared,{signal:controller.signal}));assert.equal(calls.length,1);assert.equal(calls[0].action,'snapshot-seed');
 const cancelled=new AbortController();cancelled.abort();const before=client(()=>{throw Error('Native request must not begin');});await assert.rejects(before.value.readSeed(prepared,{signal:cancelled.signal}));assert.equal(before.calls.length,0);
});
