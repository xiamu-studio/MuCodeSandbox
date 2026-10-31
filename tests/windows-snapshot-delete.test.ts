import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {run} from '../server/process.ts';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';

test('Explicit snapshot copy deletion validates a durable bounded plan and resumes after each interruption',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-snapshot-delete-')),quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
 const inputs=['native/windows/OfflineSnapshots.cs','tests/fixtures/windows-snapshot-delete-harness.cs','tests/fixtures/windows-snapshot-delete.ps1'],inputHashes:Record<string,string>={};
 try{
  for(const file of inputs)inputHashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
  const command=`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${quote(path.resolve(inputs[2]))}))) -Directory ${quote(root)} -Source ${quote(path.resolve(inputs[0]))} -Harness ${quote(path.resolve(inputs[1]))}`;
  const result=JSON.parse(await run(powershellPath(),powershellArgs(command),{timeoutMs:90000}));
  assert.equal(result.complete,true);assert.equal(result.realFileSystemExercised,true);assert.ok(result.checks.length>=30);
  assert.equal(new Set(result.checks.map((check:{name:string})=>check.name)).size,result.checks.length);
  for(const key of ['actualProcessTerminationExercised','realHyperVExercised','protectedAclExercised','realDiskFullExercised','productSnapshotFeatureEnabled'])assert.equal(result[key],false,key);
  for(const check of result.checks)await t.test(check.name,()=>assert.equal(check.passed,true));
  for(const file of inputs)assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),inputHashes[file]);
  if(process.env.MU_SNAPSHOT_DELETE_REPORT)await writeFile(path.resolve(process.env.MU_SNAPSHOT_DELETE_REPORT),JSON.stringify({...result,at:new Date().toISOString(),inputHashes,scope:'development core with real temporary Windows files and injected exceptions; no broker IPC, VM, native ACL or product deletion acceptance'},null,2));
 }finally{
  const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));assert.match(path.basename(resolved),/^mu-snapshot-delete-/);await rm(resolved,{recursive:true,force:true});
 }
});
