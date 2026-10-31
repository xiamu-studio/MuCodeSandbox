import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {HyperVRuntime} from '../server/platform/windows/runtime.ts';import {windowsConfigSchema,windowsPaths} from '../server/platform/windows/config.ts';import type {HyperVBrokerClient} from '../server/platform/windows/broker.ts';
import {run} from '../server/process.ts';import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
const id='12345678-1234-4234-8234-123456789abc',platformId='87654321-4321-4321-8321-abcdefabcdef';
const config=windowsConfigSchema.parse({version:1,id,diskGiB:32,image:'C:/fixture/base.vhdx',imageSha256:'a'.repeat(64),proxy:{mode:'http',address:'127.0.0.1',port:12345},expectedIp:'203.0.113.10'});
test('Runtime maintenance starts send fixed broker actions and verify guest readiness',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mu-compact-runtime-'));
 try{
  const manifest=windowsPaths(dir,id).manifest;await mkdir(path.dirname(manifest),{recursive:true});await writeFile(manifest,'fixture');
  const calls:{action:string;parameters:Record<string,unknown>}[]=[],broker={call:async(action:string,parameters:Record<string,unknown>)=>{calls.push({action,parameters});if(action==='allocation')return {registered:false};if(action==='disk-compact-start'||action==='disk-compact-verify-start')return JSON.stringify({platformId});throw Error('unexpected broker operation');}} as unknown as HyperVBrokerClient;
  const runtime=new HyperVRuntime(dir,undefined,broker);let reads=0;runtime.management=async(_c,command)=>{assert.deepEqual(command,['true']);reads++;return '';};
  await runtime.startDiskCompaction(config);await runtime.startDiskCompactionVerify(config);
  assert.equal(reads,2);assert.deepEqual(calls.filter(x=>x.action.startsWith('disk-compact')), [{action:'disk-compact-start',parameters:{id}},{action:'disk-compact-verify-start',parameters:{id}}]);
 }finally{assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));assert.match(path.basename(dir),/^mu-compact-runtime-/);await rm(dir,{recursive:true,force:true});}
});
test('Pending disk maintenance blocks ordinary start, recovery and removal before metadata mutations but permits its own maintenance start',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mu-compact-runtime-'));
 try{
  const manifest=windowsPaths(dir,id).manifest;await mkdir(path.dirname(manifest),{recursive:true});await writeFile(manifest,'fixture');
  const actions:string[]=[],broker={call:async(action:string)=>{actions.push(action);if(action==='allocation')return {registered:true,stage:'ready',everReady:true,platformId,imageSha256:'a'.repeat(64),cpus:2,memoryGiB:4,diskGiB:32,diskCompactionPending:true};if(action==='disk-compact-start')return JSON.stringify({platformId});throw Error('Unexpected operation '+action);}} as unknown as HyperVBrokerClient;
  const runtime=new HyperVRuntime(dir,undefined,broker);runtime.management=async()=>'';
  for(const operation of [()=>runtime.start(config),()=>runtime.recoverCreation(config),()=>runtime.remove(config),()=>runtime.startDiskReview(config)])await assert.rejects(operation(),{code:'DISK_COMPACTION_PENDING'});
  assert.deepEqual(actions,['allocation','allocation','allocation','allocation']);
  await runtime.startDiskCompaction(config);assert.equal(actions.at(-1),'disk-compact-start');
 }finally{assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));assert.match(path.basename(dir),/^mu-compact-runtime-/);await rm(dir,{recursive:true,force:true});}
});
test('Native allocation exposes a pending maintenance flag only for that protected record',{skip:process.platform!=='win32'},async()=>{
 const fixture=path.resolve('tests/fixtures/windows-compaction-allocation.ps1').replaceAll("'","''"),source=path.resolve('native/windows/HyperVBroker.cs').replaceAll("'","''");
 await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop'; & ([ScriptBlock]::Create([IO.File]::ReadAllText('${fixture}'))) -Source '${source}'`),{timeoutMs:20000});
});
