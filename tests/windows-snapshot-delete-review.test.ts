import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {run} from '../server/process.ts';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';

test('Snapshot deletion dependency review executes production PowerShell against bounded local provider doubles',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-snapshot-delete-review-'));
 const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'",source=path.resolve('scripts/windows/hyperv.ps1');
 try{
  const checks=JSON.parse(await run(powershellPath(),powershellArgs(`& ${quote(path.resolve('tests/fixtures/windows-snapshot-delete-review.ps1'))} -Source ${quote(source)} -Directory ${quote(root)}`),{timeoutMs:30000})) as {name:string;passed:boolean}[];
  assert.equal(checks.length,89);assert.equal(new Set(checks.map(row=>row.name)).size,checks.length);
  for(const row of checks)await t.test(row.name,()=>assert.equal(row.passed,true));
  if(process.env.MU_SNAPSHOT_DELETE_REVIEW_REPORT)await writeFile(path.resolve(process.env.MU_SNAPSHOT_DELETE_REVIEW_REPORT),JSON.stringify({complete:true,at:new Date().toISOString(),productionScriptSha256:createHash('sha256').update(await readFile(source)).digest('hex'),checks,scope:'Exact production PowerShell function ASTs; synthetic temporary ordinary files and provider doubles; no full script entry point, administrator prompt, Hyper-V cmdlet, VM, mount or checkpoint operation',actualHyperV:false,liveDeletionEnabled:false},null,2));
 }finally{
  const safe=path.resolve(root);assert.equal(path.dirname(safe),path.resolve(tmpdir()));assert.match(path.basename(safe),/^mu-snapshot-delete-review-/);await rm(safe,{recursive:true,force:true});
 }
});
