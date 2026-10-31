import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile,readFile} from 'node:fs/promises';
import {snapshotCoordinatorFixture} from './fixtures/windows-snapshot-coordinator.ts';
import {WindowsManager,type WindowsBackend} from '../server/platform/windows/manager.ts';
import {WindowsSnapshotProduct} from '../server/platform/windows/snapshot-product.ts';
import {windowsPaths} from '../server/platform/windows/config.ts';

async function fixture(){
 const f=await snapshotCoordinatorFixture();
 const forbidden=async()=>{throw Error('Integration fixture must never start, create or access a VM');};
 const runtime:WindowsBackend={info:async()=>({available:true,issues:[]}),state:async()=>({state:'Off'}),stop:async()=>{},create:forbidden,start:forbidden,connect:forbidden,session:forbidden,inspectGuard:forbidden};
 const manager=new WindowsManager(f.store,runtime,{runtimeRoot:path.join(f.root,'runtime'),base:{image:path.join(f.root,'base.vhdx'),imageSha256:'a'.repeat(64)}});
 const product=new WindowsSnapshotProduct(manager,f.coordinator,{enabled:true});await product.initialize();
 return {...f,manager,product,close:async()=>{await manager.close();await f.close();}};
}
test('Product restore jobs run the real encrypted journal and identity-file coordinator before releasing admission',async()=>{
 const f=await fixture();try{
  let fenced=false;f.broker.faults.beforeCommit=()=>{assert.throws(()=>f.product.assertWritable(f.id),{code:'SNAPSHOT_BUSY'});assert.equal(f.coordinator.journal.has(f.id),true);fenced=true;};
  const job=f.product.restore(f.id,f.snapshotId,f.environment().name);await f.manager.wait(job.id);
  assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'succeeded');assert.equal(f.environment().name,'快照时配置');assert.equal(f.environment().state,'stopped');assert.equal(fenced,true);assert.equal(f.broker.state.active,null);assert.equal(f.coordinator.journal.has(f.id),false);assert.deepEqual(f.product.status().pendingIds,[]);f.product.assertWritable(f.id);assert.equal(f.broker.calls.includes('start'),false);
 }finally{await f.close();}
});
test('A lost acknowledgement and later legitimate edit survive product job completion without stale configuration replay',async()=>{
 const f=await fixture();try{
  f.broker.faults.ackLost=true;f.broker.faults.afterAck=()=>{f.store.save({...f.environment(),name:'确认后的合法编辑',network:{...f.environment().network,password:'SYNTHETIC_LATER_PASSWORD'}});};
  const job=f.product.restore(f.id,f.snapshotId,f.environment().name);await f.manager.wait(job.id);
  assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'succeeded');assert.equal(f.environment().name,'确认后的合法编辑');assert.equal(f.environment().network.password,'SYNTHETIC_LATER_PASSWORD');assert.equal(f.environment().state,'stopped');assert.deepEqual(f.product.status().pendingIds,[]);assert.equal(f.coordinator.journal.has(f.id),false);
 }finally{await f.close();}
});
test('Unknown identity files after native commit retain the product fence and real replay journal',async()=>{
 const f=await fixture();try{
  const file=path.join(windowsPaths(path.join(f.root,'runtime'),f.id).directory,'known_hosts'),unknown=Buffer.from('SYNTHETIC_UNKNOWN_OWNER_FILE');f.broker.faults.afterCommit=()=>writeFile(file,unknown);
  const job=f.product.restore(f.id,f.snapshotId,f.environment().name);await f.manager.wait(job.id);
  assert.equal(f.store.jobs().find(value=>value.id===job.id)?.status,'failed');assert.equal(f.environment().state,'error');assert.deepEqual(await readFile(file),unknown);assert.equal(f.coordinator.journal.has(f.id),true);assert.deepEqual(f.product.status().pendingIds,[f.id]);await assert.rejects(f.manager.action(f.id,'start'),{code:'SNAPSHOT_PENDING'});assert.equal(f.broker.calls.includes('snapshot-acknowledge'),false);assert.equal(f.broker.calls.includes('start'),false);
 }finally{await f.close();}
});
