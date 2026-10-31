import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import path from 'node:path';
import {HyperVRuntime} from '../server/platform/windows/runtime.ts';import {windowsConfigSchema} from '../server/platform/windows/config.ts';import type {HyperVBrokerClient} from '../server/platform/windows/broker.ts';
const id=randomUUID(),config=windowsConfigSchema.parse({version:1,id,image:path.resolve('snapshot-synthetic-base.vhdx'),imageSha256:'a'.repeat(64),cpus:2,memoryGiB:2,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:7897},expectedIp:'198.51.100.25'});
function fixture(){const requests:string[]=[],sideEffects:string[]=[];const allocation={registered:true,stage:'ready',everReady:true,platformId:randomUUID(),imageSha256:config.imageSha256,cpus:2,memoryGiB:2,diskGiB:32,snapshotRestorePending:true};const broker={call:async(action:string)=>{requests.push(action);if(action==='allocation')return allocation;throw Error('Unexpected native mutation '+action);}} as unknown as HyperVBrokerClient;const runtime=new HyperVRuntime(path.resolve('synthetic-snapshot-runtime-not-created'),async()=>{sideEffects.push('filesystem-or-SSH');throw Error('Unexpected local side effect');},broker);return {runtime,requests,sideEffects};}
test('Pending snapshot prevents new provisioning and ordinary recovery before metadata publication',async()=>{
 for(const method of ['create','recoverCreation'] as const){const f=fixture();await assert.rejects(f.runtime[method](config),{code:'SNAPSHOT_PENDING'});assert.deepEqual(f.requests,['allocation']);assert.deepEqual(f.sideEffects,[]);}
});
test('Pending snapshot refuses removal before metadata checks, marker writes or cleanup',async()=>{
 const f=fixture();await assert.rejects(f.runtime.remove(config),{code:'SNAPSHOT_PENDING'});assert.deepEqual(f.requests,['allocation']);assert.deepEqual(f.sideEffects,[]);
});
test('Pending snapshot prevents all normal and maintenance starts before local metadata or guest access',async()=>{
 for(const method of ['start','startDiskMaintenance','startDiskReview'] as const){const f=fixture();await assert.rejects(f.runtime[method](config),{code:'SNAPSHOT_PENDING'});assert.deepEqual(f.requests,['allocation']);assert.deepEqual(f.sideEffects,[]);}
});
