import {test} from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {once} from 'node:events';import {readFile,writeFile} from 'node:fs/promises';import path from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
import {snapshotCoordinatorFixture} from './fixtures/windows-snapshot-coordinator.ts';

test('Production owner coordinator resumes actual DPAPI/SQL/files in a new Windows process after death on either side of native commit',{skip:process.platform!=='win32'},async t=>{
 const checks:unknown[]=[];
 for(const boundary of ['before-commit','after-commit'])await t.test(boundary,async()=>{
  const f=await snapshotCoordinatorFixture();f.store.close();const launch=(mode:string)=>{const child=spawn(process.execPath,[path.resolve('tests/fixtures/windows-snapshot-coordinator-process.ts'),f.root,boundary,mode],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',error='';child.stdout.on('data',bytes=>out+=String(bytes));child.stderr.on('data',bytes=>error+=String(bytes));return{child,exit:once(child,'exit'),out:()=>out,error:()=>error};};
  const first=launch('restore');let second:ReturnType<typeof launch>|undefined;
  try{
   const deadline=Date.now()+30000;let ready:{pid:number;id:string;transactionId:string;phase:string;boundary:string;configurationName:string}|undefined;
   while(Date.now()<deadline){assert.equal(first.child.exitCode,null,first.error());assert.equal(first.child.signalCode,null,first.error());try{ready=JSON.parse(await readFile(path.join(f.root,'ready.json'),'utf8'));break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await delay(50);}
   assert.ok(ready,'Coordinator did not reach its bound durable boundary');assert.equal(ready.pid,first.child.pid);assert.equal(ready.id,f.id);assert.equal(ready.boundary,boundary);assert.equal(ready.phase,boundary==='before-commit'?'applied':'committed');assert.equal(ready.configurationName,'快照时配置');
   assert.equal(first.child.kill('SIGKILL'),true);const [oldCode,oldSignal]=await first.exit;assert.equal(oldCode,null);assert.equal(oldSignal,'SIGKILL');
   second=launch('recover');const timer=setTimeout(()=>second?.child.kill('SIGKILL'),30000);let result:Record<string,unknown>;
   try{const [code,signal]=await second.exit;assert.equal(code,0,second.error());assert.equal(signal,null,second.error());result=JSON.parse(second.out());}finally{clearTimeout(timer);}
   assert.notEqual(result.pid,ready.pid);assert.equal(result.pid,second.child.pid);assert.equal(result.id,f.id);assert.equal(result.transactionId,ready.transactionId);assert.equal(result.complete,true);assert.equal(result.decision,boundary==='before-commit'?'rolled-back':'committed');assert.equal(result.actualDpapiAndConfigurationPersistence,true);assert.equal(result.actualOrdinaryFileAndAclReplay,true);assert.equal(result.actualHyperV,false);assert.equal(result.actualProtectedNativeIpc,false);assert.equal(result.vmStarted,false);checks.push({...result,oldPid:ready.pid,oldProcessExitObserved:true});
  }finally{for(const child of [first,second])if(child&&child.child.exitCode===null&&child.child.signalCode===null){child.child.kill('SIGKILL');await child.exit;}await f.close();}
 });
 if(process.env.MU_SNAPSHOT_COORDINATOR_PROCESS_REPORT)await writeFile(path.resolve(process.env.MU_SNAPSHOT_COORDINATOR_PROCESS_REPORT),JSON.stringify({complete:true,at:new Date().toISOString(),scope:'production Windows owner coordinator, DPAPI, SQLite and ordinary file/ACL replay in separately terminated and replacement Node processes; native authority and disk selection use a fixture; not Hyper-V/protected native IPC acceptance',checks},null,2));
});
