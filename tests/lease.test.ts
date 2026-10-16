import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import type { NetworkProtection } from '../shared/types.ts';

async function fixture() {
  const directory=await mkdtemp(path.join(homedir(),'.mu-lease-unit-'));
  const runtime=new LimaRuntime(directory);
  let running=false,instance='',healthy=true,failRenew=false;
  const events:string[]=[];
  runtime.info=async()=>({available:true,path:'/test/lima',version:'test',error:null});
  runtime.list=async()=>instance?[{name:instance,status:running?'Running':'Stopped'}]:[];
  runtime.start=async e=>{instance=e.instanceName;running=true;events.push('closed-start');};
  runtime.stop=async()=>{running=false;events.push('stop');};
  runtime.networkProtection=async(_e,requireLease=true)=>{events.push(requireLease?'guard-live':'guard-closed');return {active:healthy,issues:healthy?[]:['许可已过期']} as NetworkProtection;};
  runtime.renewLease=async(_e,activate=false)=>{events.push(activate?'activate':'renew');if(failRenew)throw new Error('Expired session');};
  runtime.revokeLease=async()=>{events.push('revoke');};
  const manager=new Manager(directory,undefined,runtime);
  const e=await manager.create({name:'Lease test',memoryGiB:1,network:{mode:'http',host:'proxy.test',strict:true,transparent:true,egressLock:{expectedIp:'8.8.8.8'}}});
  manager.measureExit=async()=>{events.push('exit');return {ip:'8.8.8.8',country:'',city:'',latencyMs:1,source:'guest'};};
  const start=async()=>{const job=await manager.lifecycle(e.id,'start');await manager.tasks.get(job.id)?.promise;return manager.store.jobs().find(item=>item.id===job.id)!;};
  return {manager,e,events,start,setHealthy:(value:boolean)=>{healthy=value;},failRenew:()=>{failRenew=true;},clean:async()=>{await manager.close();await rm(directory,{recursive:true,force:true});}};
}

test('Business activation follows closed-start guard and exit approval; failed approval never activates',async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.start()).status,'succeeded');
    assert.deepEqual(f.events.slice(0,4),['closed-start','guard-closed','exit','activate']);
    const stop=await f.manager.lifecycle(f.e.id,'stop');await f.manager.tasks.get(stop.id)?.promise;
    f.events.length=0;f.manager.measureExit=async()=>{throw new Error('No trusted receipt');};
    assert.equal((await f.start()).status,'failed');assert.ok(!f.events.includes('activate'));assert.ok(f.events.includes('stop'));
  } finally { await f.clean(); }
});

test('A failed guard cannot refresh a lease and causes quarantine',async()=>{
  const f=await fixture();
  try {
    await f.start();f.events.length=0;f.setHealthy(false);
    await f.manager.monitorProtection();
    assert.ok(!f.events.includes('renew'));assert.ok(f.events.includes('stop'));
    assert.equal(f.manager.store.get(f.e.id).state,'error');
  } finally { await f.clean(); }
});

test('Kernel-expired renewal cannot be healed by another access check and manager exit revokes',async()=>{
  const f=await fixture();
  try {
    await f.start();f.failRenew();
    await assert.rejects(f.manager.assertAccess(f.e.id),/Expired session/);
    await Promise.all([...f.manager.quarantines.values()]);
    assert.equal(f.manager.store.get(f.e.id).state,'error');
    await assert.rejects(f.manager.assertAccess(f.e.id));
    await f.manager.close();assert.ok(f.events.includes('revoke'));
  } finally { if(!f.manager.closing)await f.manager.close();await rm(f.manager.store.dataDir,{recursive:true,force:true}); }
});
