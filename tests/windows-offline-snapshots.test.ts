import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {run} from '../server/process.ts';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';

test('Native offline snapshot transactions retain complete disk/config versions across interruption boundaries',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-offline-snapshots-')),quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
 try{
  const inputs=['native/windows/OfflineSnapshots.cs','tests/fixtures/windows-offline-snapshots-harness.cs','tests/fixtures/windows-offline-snapshots.ps1'],inputHashes:Record<string,string>={};
  for(const file of inputs)inputHashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
  const call=`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${quote(path.resolve('tests/fixtures/windows-offline-snapshots.ps1'))}))) -Directory ${quote(root)} -Source ${quote(path.resolve('native/windows/OfflineSnapshots.cs'))} -Harness ${quote(path.resolve('tests/fixtures/windows-offline-snapshots-harness.cs'))}`;
  const result=JSON.parse(await run(powershellPath(),powershellArgs(call),{timeoutMs:90000}));
  assert.equal(result.complete,true);assert.equal(result.realFileSystemExercised,true);
  for(const key of ['realHyperVExercised','configurationPersistenceExercised','protectedAclExercised','realDiskFullExercised','actualProcessTerminationExercised','productSnapshotFeatureEnabled'])assert.equal(result[key],false,key);
  assert.equal(result.checks.length,28);assert.equal(new Set(result.checks.map((c:{name:string})=>c.name)).size,28);
  for(const check of result.checks)await t.test(check.name,()=>assert.equal(check.passed,true));
  for(const file of inputs)assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),inputHashes[file]);
  if(process.env.MU_OFFLINE_SNAPSHOT_REPORT)await writeFile(path.resolve(process.env.MU_OFFLINE_SNAPSHOT_REPORT),JSON.stringify({...result,time:new Date().toISOString(),scope:'development core only; not compiled into the installed broker or enabled in the product',inputHashes},null,2));
 }finally{
  const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));assert.match(path.basename(resolved),/^mu-offline-snapshots-/);await rm(resolved,{recursive:true,force:true});
 }
});
