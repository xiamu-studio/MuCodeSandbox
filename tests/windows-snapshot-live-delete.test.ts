import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {run} from '../server/process.ts';import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
test('Production live snapshot deletion releases lifecycle locks and retains durable cancellation boundaries',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-snapshot-live-delete-')),quote=(v:string)=>"'"+path.resolve(v).replaceAll("'","''")+"'";
 try{
  const result=JSON.parse(await run(powershellPath(),powershellArgs(`& ${quote('tests/fixtures/windows-snapshot-live-delete.ps1')} -Directory ${quote(root)} -Native ${quote('native/windows')} -Harness ${quote('tests/fixtures/windows-snapshot-live-delete.cs')}`),{timeoutMs:30000}));
  assert.equal(result.complete,true);assert.equal(result.checks.length,11);assert.equal(new Set(result.checks.map((r:{name:string})=>r.name)).size,11);for(const row of result.checks)await t.test(row.name,()=>assert.equal(row.passed,true));
  if(process.env.MU_SNAPSHOT_LIVE_NATIVE_REPORT)await writeFile(path.resolve(process.env.MU_SNAPSHOT_LIVE_NATIVE_REPORT),JSON.stringify({...result,at:new Date().toISOString(),scope:'Exact production live deletion methods and durable snapshot store compiled with synthetic privileged/provider adapters, actual temporary ordinary files and host threads; no broker Main, UAC, actual VM, ACL or disk image'},null,2));
 }finally{const safe=path.resolve(root);assert.equal(path.dirname(safe),path.resolve(tmpdir()));assert.match(path.basename(safe),/^mu-snapshot-live-delete-/);await rm(safe,{recursive:true,force:true});}
});
