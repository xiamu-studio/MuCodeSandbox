import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import type {Environment} from '../shared/types.ts';
import {WINDOWS_BROWSER_ADOPTION_PYTHON,windowsBrowserAdoptionPrelude} from '../server/platform/windows/browser-adoption.ts';import {WINDOWS_BROWSER_PROFILE_WORKER} from '../server/platform/windows/browser-profile-worker.ts';import {WINDOWS_COMPONENT_PACKAGE_PYTHON} from '../server/platform/windows/component-package.ts';import {WINDOWS_BROWSER_RESET_HELPERS} from '../server/platform/windows/browser-reset.ts';import {WINDOWS_BROWSER_REPAIR_PYTHON} from '../server/platform/windows/browser-repair.ts';import {LEASE_HELPER} from '../server/guest-lease.ts';import {WINDOWS_BROWSER_TRIAL_PREFERENCES} from '../server/platform/windows/browser-trial-preferences.ts';import {windowsBrowserTrialLaunchProgram,windowsBrowserTrialStopProgram} from '../server/platform/windows/browser-trial-guest.ts';

test('Actual generated root launch gate verifies the checkpoint and candidate before the dev-only exec boundary',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-trial-launch-'));
 try{
  const values=[WINDOWS_COMPONENT_PACKAGE_PYTHON,WINDOWS_BROWSER_RESET_HELPERS,WINDOWS_BROWSER_REPAIR_PYTHON,WINDOWS_BROWSER_ADOPTION_PYTHON,WINDOWS_BROWSER_PROFILE_WORKER,LEASE_HELPER],files=values.map((_,i)=>path.join(root,i+'.py')),cases=path.join(root,'cases');await mkdir(cases);await Promise.all(files.map((file,i)=>writeFile(file,values[i])));await writeFile(path.join(root,'trial-preferences.py'),WINDOWS_BROWSER_TRIAL_PREFERENCES);
  const epoch='a'.repeat(32),binding='b'.repeat(64);await writeFile(path.join(root,'trial-programs.json'),JSON.stringify({epoch,binding,prelude:windowsBrowserAdoptionPrelude(),launch:windowsBrowserTrialLaunchProgram({cpus:1,identity:{locale:'zh-TW',timezone:'UTC'}} as Environment,epoch),stop:windowsBrowserTrialStopProgram(epoch,binding)}));
  const output=await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I',path.resolve('tests/fixtures/windows-browser-adoption.py'),...files,cases],{windowsHide:true,timeout:120000,maxBuffer:2097152}),result=JSON.parse(output.stdout);
  assert.equal(result.complete,true);assert.equal(result.checks.length,25);assert.equal(result.actualHostFiles,true);assert.equal(result.actualWorker,true);assert.equal(result.actualGeneratedGate,true);assert.equal(result.realLinux,false);assert.equal(result.browserExecuted,false);
  for(const check of result.checks)await t.test(check.case,()=>assert.equal(check.passed,true));console.log(JSON.stringify({...result,diagnostic:'windows-browser-trial-launch'}));
 }finally{assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-trial-launch-/);await rm(root,{recursive:true,force:true});}
});
