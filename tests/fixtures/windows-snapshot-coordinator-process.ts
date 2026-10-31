import assert from 'node:assert/strict';import {writeFile,open,rename} from 'node:fs/promises';import path from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
import {openSnapshotCoordinatorFixture} from './windows-snapshot-coordinator.ts';
const [root,boundary,mode]=process.argv.slice(2);assert.ok(['before-commit','after-commit'].includes(boundary));assert.ok(['restore','recover'].includes(mode));
const f=await openSnapshotCoordinatorFixture(root);
try{
 if(mode==='restore'){
  const pause=async()=>{const current=f.broker.state.active;assert.ok(current);const ready={pid:process.pid,id:f.id,snapshotId:f.snapshotId,transactionId:current.transactionId,phase:current.phase,boundary,configurationName:f.environment().name};const next=path.join(root,'ready.next'),output=await open(next,'wx');try{await output.writeFile(JSON.stringify(ready));await output.sync();}finally{await output.close();}await rename(next,path.join(root,'ready.json'));await delay(60000);throw Error('Bound child process was not terminated');};
  if(boundary==='before-commit')f.broker.faults.beforeCommit=pause;else f.broker.faults.afterCommit=pause;
  await f.coordinator.restore(f.environment(),f.snapshotId);throw Error('Process fixture did not reach interruption');
 }else{
  const result=await f.coordinator.recoverAll();assert.deepEqual(result,{recovered:[f.id],issues:[]});const role=f.broker.state.roles[boundary==='before-commit'?'prior':'target'],current=f.environment();assert.equal(current.name,role.config.name);assert.equal(current.network.password,role.config.network.password);assert.equal(current.state,'stopped');assert.equal(f.broker.state.active,null);assert.deepEqual(f.coordinator.journal.pending(),[]);
  const history=f.store.db.prepare('SELECT transaction_id,payload FROM windows_snapshot_replay_history').get() as {transaction_id:string;payload:string};assert.ok(history.payload.startsWith('enc:'));
  console.log(JSON.stringify({complete:true,pid:process.pid,id:f.id,snapshotId:f.snapshotId,transactionId:history.transaction_id,boundary,decision:boundary==='before-commit'?'rolled-back':'committed',actualDpapiAndConfigurationPersistence:true,actualOrdinaryFileAndAclReplay:true,nativeAuthorityIsFixture:true,actualHyperV:false,actualProtectedNativeIpc:false,vmStarted:false}));
 }
}finally{f.close();}
