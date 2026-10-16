import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {Manager} from '../server/manager.ts';
import {LimaRuntime} from '../server/runtime.ts';
import type {Environment,NetworkProtection} from '../shared/types.ts';

test('Guard monitor quarantines changed rules independently of UI polling and revokes terminals',async()=>{
  const root=await mkdtemp(path.join(homedir(),'.mu-monitor-'));
  const runtime=new LimaRuntime(root);
  let stopped=0,revoked=0,healthy=true;
  runtime.info=async()=>({available:true,path:'/test/limactl',version:'test',error:null});
  runtime.list=async()=>[];
  runtime.networkProtection=async()=>({active:healthy,issues:healthy?[]:['规则内容变化']} as NetworkProtection);
  runtime.stop=async(_e:Environment)=>{stopped++;};
  runtime.renewLease=async()=>{};
  const manager=new Manager(root,undefined,runtime);
  try{
    const e=await manager.create({name:'Monitor test',network:{mode:'http',host:'proxy.test',strict:true}});
    manager.store.state(e.id,'running');manager.onQuarantine=()=>{revoked++;};
    await manager.monitorProtection();assert.equal(stopped,0);
    healthy=false;await manager.monitorProtection();
    assert.equal(stopped,1);assert.equal(revoked,2);
    assert.equal(manager.store.get(e.id).state,'error');
    assert.match(manager.store.get(e.id).lastError??'',/规则内容变化/);
    await manager.monitorProtection();assert.equal(stopped,1);
    manager.store.state(e.id,'running');
    manager.onQuarantine=()=>{throw new Error('simulated cleanup failure');};
    await manager.monitorProtection();assert.equal(stopped,2);
    assert.equal(manager.store.get(e.id).state,'error');
    assert.ok(manager.store.logs(e.id).some(log=>log.message.includes('simulated cleanup failure')));
  }finally{await manager.close();await rm(root,{recursive:true,force:true});}
});
