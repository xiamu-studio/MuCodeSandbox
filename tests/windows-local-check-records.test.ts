import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';import {environmentSchema} from '../server/validation.ts';import type {Environment} from '../shared/types.ts';
import {WindowsLocalCheckRecords} from '../server/platform/windows/local-check-records.ts';import {syntheticCheckReport,syntheticBrowserCheck} from './fixtures/windows-local-check-data.ts';

async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'mu-local-check-records-')),key=Buffer.alloc(32,45),store=new Store(root,key),now=new Date().toISOString();
 const environment={...environmentSchema.parse({name:'合成检测记录',identity:{locale:'en-US',timezone:'UTC'}}),id:randomUUID(),instanceName:'synthetic',state:'running',browserRunning:false,lastError:null,createdAt:now,updatedAt:now} as Environment;store.save(environment);
 const actual=store.get(environment.id),records=new WindowsLocalCheckRecords(store),job=store.newJob(actual.id,'lab-check'),report=syntheticCheckReport(actual,job,'running');
 return {root,key,store,records,environment:actual,job,report,payload:()=>String((store.db.prepare('SELECT payload FROM windows_local_checks WHERE environment_id=?').get(actual.id) as {payload:string})?.payload),close:async()=>{store.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-local-check-records-/);await rm(root,{recursive:true,force:true});}};
}
test('Reports use the real private SQLite store and authenticated encryption, and restore only with the matching successful job',async()=>{
 const f=await fixture();try{
  f.records.writable(f.environment.id);f.records.save(f.report,true);const first=f.payload();assert.ok(first.startsWith('enc:'));
  f.report.result=syntheticBrowserCheck();f.report.checks=f.report.result.checks;f.report.state='passed';f.records.save(f.report);f.store.finishJob(f.job.id,'succeeded','Synthetic complete');
  const payload=f.payload();assert.notEqual(payload,first);assert.equal(payload.includes('SYNTHETIC_GPU_PRIVATE_MARKER'),false);assert.deepEqual(new WindowsLocalCheckRecords(f.store).restore(),[f.report]);assert.deepEqual(JSON.parse(f.store.decrypt(payload)),f.report);
  f.store.finishJob(f.job.id,'failed','Synthetic interruption');const failed=new WindowsLocalCheckRecords(f.store).restore()[0];assert.equal(failed.state,'failed');assert.match(failed.error!,/未完成/);assert.equal(f.payload(),payload);
  console.log(JSON.stringify({diagnostic:'windows-local-check-records',actualSqlite:true,actualAesGcm:true,matchingJobRequired:true,originalBytesRetained:true,actualDpapi:false,realVm:false}));
 }finally{await f.close();}
});
test('Interrupted and malformed reports are never restored as success or overwritten by a new check',async()=>{
 for(const kind of ['running','bad-cipher','oversized','foreign-environment','foreign-report','unknown-field']){
  const f=await fixture();try{
   f.records.writable(f.environment.id);f.records.save(f.report,true);
   if(kind!=='running'){let payload=kind==='bad-cipher'?'enc:invalid':kind==='oversized'?'x'.repeat(131073):f.store.encrypt(JSON.stringify({...f.report,...kind==='foreign-environment'?{environmentId:randomUUID()}:kind==='foreign-report'?{id:randomUUID()}:{unknown:'retained'}}));f.store.db.prepare('UPDATE windows_local_checks SET payload=? WHERE environment_id=?').run(payload,f.environment.id);}
   const before=f.payload(),reader=new WindowsLocalCheckRecords(f.store),restored=reader.restore();
   if(kind==='running'){assert.equal(restored[0].state,'failed');assert.equal(restored[0].result,undefined);}else{assert.deepEqual(restored,[]);assert.ok(reader.issue);assert.throws(()=>reader.writable(f.environment.id),{code:'LOCAL_CHECK_RECORD_INVALID'});}
   assert.equal(f.payload(),before);
  }finally{await f.close();}
 }
});
test('A report appearing after preflight and a changed bound cipher are retained before any replacement',async()=>{
 for(const phase of ['before-insert','after-bind']){
  const f=await fixture();try{
   f.records.writable(f.environment.id);
   if(phase==='after-bind')f.records.save(f.report,true);
   const replacement=syntheticCheckReport(f.environment,f.job,'failed'),payload=f.store.encrypt(JSON.stringify(replacement));
   if(phase==='before-insert')f.store.db.prepare('INSERT INTO windows_local_checks VALUES(?,?,?)').run(f.environment.id,replacement.id,payload);else f.store.db.prepare('UPDATE windows_local_checks SET report_id=?,payload=? WHERE environment_id=?').run(replacement.id,payload,f.environment.id);
   assert.throws(()=>f.records.save(f.report,phase==='before-insert'),{code:'LOCAL_CHECK_RECORD_SAVE_FAILED'});assert.equal(f.payload(),payload);
  }finally{await f.close();}
 }
});
