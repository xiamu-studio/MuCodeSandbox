import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {buildBroker} from '../server/platform/windows/broker.ts';import {run} from '../server/process.ts';import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
test('Compiled production snapshot broker policies bind authority and fence pending restores',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-snapshot-policy-')),quote=(v:string)=>"'"+v.replaceAll("'","''")+"'";
 try{
  const artifact=await buildBroker(root),directory=path.join(root,'synthetic-records');await mkdir(directory);
  const checks=JSON.parse(await run(powershellPath(),powershellArgs(`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${quote(path.resolve('tests/fixtures/windows-snapshot-policy.ps1'))}))) -Broker ${quote(artifact.broker)} -Directory ${quote(directory)}`),{timeoutMs:20000}));
  assert.equal(checks.length,39);assert.equal(new Set(checks.map((c:{name:string})=>c.name)).size,39);for(const check of checks)await t.test(check.name,()=>assert.equal(check.passed,true));
  if(process.env.MU_SNAPSHOT_POLICY_REPORT)await writeFile(path.resolve(process.env.MU_SNAPSHOT_POLICY_REPORT),JSON.stringify({complete:true,time:new Date().toISOString(),scope:'reflection against the actual fully compiled production broker; synthetic in-process registration and temporary pending directory; no broker Main, IPC, ACL or Hyper-V operations',sourceDigest:artifact.sourceDigest,brokerSha256:artifact.sha256,checks,actualHyperV:false,actualBrokerIpc:false,actualProtectedAcl:false},null,2));
 }finally{const safe=path.resolve(root);assert.equal(path.dirname(safe),path.resolve(tmpdir()));assert.match(path.basename(safe),/^mu-snapshot-policy-/);await rm(safe,{recursive:true,force:true});}
});
