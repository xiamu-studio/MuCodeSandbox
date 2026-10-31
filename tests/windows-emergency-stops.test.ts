import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {run} from '../server/process.ts';import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
test('Production resource and power shutdown isolate held allocation gates and slow providers',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-emergency-stops-')),quote=(v:string)=>"'"+path.resolve(v).replaceAll("'","''")+"'";
 try{
  const reports=[];
  for(const scenario of ['pressure','metrics']){
  const scenarioRoot=path.join(root,scenario);await mkdir(scenarioRoot);
  const report=JSON.parse(await run(powershellPath(),powershellArgs(`& ${quote('tests/fixtures/windows-emergency-stops.ps1')} -Directory ${quote(scenarioRoot)} -Native ${quote('native/windows')} -Harness ${quote('tests/fixtures/windows-emergency-stops.cs')} -Case ${scenario}`),{timeoutMs:45000}));assert.equal(report.complete,true);assert.equal(report.checks.length,19);assert.equal(new Set(report.checks.map((c:{name:string})=>c.name)).size,19);
  for(const [name,hash] of Object.entries(report.sourceHashes))assert.equal(createHash('sha256').update(await readFile(path.join('native/windows',name))).digest('hex'),hash);for(const check of report.checks)await t.test(scenario+': '+check.name,()=>assert.equal(check.passed,true));
  assert.equal(report.realHyperV,false);assert.equal(report.realPowerEvents,false);assert.equal(report.productionResourceGuardian,true);assert.equal(report.productionPowerTrip,true);assert.equal(report.productionRecoverAllocation,true);assert.equal(report.metricFailureInjected,scenario==='metrics');assert.equal(report.cancellationCallbackCalls,1);assert.equal(report.channelCloseFailureInjected,1);reports.push({scenario,...report});
  }
  if(process.env.MU_EMERGENCY_STOP_REPORT)await writeFile(path.resolve(process.env.MU_EMERGENCY_STOP_REPORT),JSON.stringify({reports,at:new Date().toISOString(),scope:'Complete production Resources.cs and PowerProtection.cs plus exact protected ownership/parameters/RecoverAllocation methods; both low-resource and unavailable-metric trip paths include throwing cancellation callback and channel disposal. Actual ordinary temporary file copy and host threads, synthetic metrics/power/provider/ledger adapters; no Hyper-V, real suspend/resume, elevated broker or protected ACL'},null,2));
 }finally{const safe=path.resolve(root);assert.equal(path.dirname(safe),path.resolve(tmpdir()));assert.match(path.basename(safe),/^mu-emergency-stops-/);await rm(safe,{recursive:true,force:true});}
});
