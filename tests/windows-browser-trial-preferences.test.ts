import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {WINDOWS_BROWSER_ADOPTION_PYTHON} from '../server/platform/windows/browser-adoption.ts';import {WINDOWS_BROWSER_PROFILE_WORKER} from '../server/platform/windows/browser-profile-worker.ts';import {WINDOWS_COMPONENT_PACKAGE_PYTHON} from '../server/platform/windows/component-package.ts';import {WINDOWS_BROWSER_RESET_HELPERS} from '../server/platform/windows/browser-reset.ts';import {WINDOWS_BROWSER_REPAIR_PYTHON} from '../server/platform/windows/browser-repair.ts';import {LEASE_HELPER} from '../server/guest-lease.ts';import {WINDOWS_BROWSER_TRIAL_PREFERENCES} from '../server/platform/windows/browser-trial-preferences.ts';

test('Actual candidate preference worker preserves unrelated data, refuses unsafe inputs and recovers real process deaths',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-trial-preferences-'));
 try{
  const values=[WINDOWS_COMPONENT_PACKAGE_PYTHON,WINDOWS_BROWSER_RESET_HELPERS,WINDOWS_BROWSER_REPAIR_PYTHON,WINDOWS_BROWSER_ADOPTION_PYTHON,WINDOWS_BROWSER_PROFILE_WORKER,LEASE_HELPER],files=values.map((_,i)=>path.join(root,i+'.py')),cases=path.join(root,'cases');await mkdir(cases);await Promise.all(files.map((file,i)=>writeFile(file,values[i])));await writeFile(path.join(root,'trial-preferences.py'),WINDOWS_BROWSER_TRIAL_PREFERENCES);
  const output=await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I',path.resolve('tests/fixtures/windows-browser-adoption.py'),...files,cases],{windowsHide:true,timeout:180000,maxBuffer:2097152}),result=JSON.parse(output.stdout);
  assert.equal(result.complete,true);assert.equal(result.checks.length,15);assert.equal(result.realProcessKills,3);assert.equal(result.actualHostFiles,true);assert.equal(result.actualWorker,true);assert.equal(result.realLinux,false);assert.equal(result.browserExecuted,false);
  for(const check of result.checks)await t.test(check.case,()=>assert.equal(check.passed,true));console.log(JSON.stringify({...result,diagnostic:'windows-browser-trial-preferences'}));
 }finally{assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-trial-preferences-/);await rm(root,{recursive:true,force:true});}
});
