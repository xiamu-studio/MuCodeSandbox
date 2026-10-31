import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {WINDOWS_BROWSER_REPAIR_OBSERVATION,parseWindowsBrowserRepairObservation} from '../server/platform/windows/browser-repair-observation.ts';import {WINDOWS_BROWSER_RELEASES} from '../server/platform/windows/browser-releases.ts';

test('Actual repair observation reads only the approved selector and bound pending journal, including when the executable is broken',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-repair-observation-'));
 try{
  await mkdir(path.join(root,'cases'));await writeFile(path.join(root,'catalog.json'),JSON.stringify(WINDOWS_BROWSER_RELEASES));await writeFile(path.join(root,'observation.py'),WINDOWS_BROWSER_REPAIR_OBSERVATION);
  const result=JSON.parse((await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I',path.resolve('tests/fixtures/windows-browser-repair-observation.py'),root],{windowsHide:true,timeout:20000,maxBuffer:1048576})).stdout);
  assert.equal(result.complete,true);assert.equal(result.checks.length,47);assert.equal(result.actualApprovedCatalog,true);assert.equal(result.actualFilesAndIds,true);assert.equal(result.actualHardlinks,true);assert.equal(result.syntheticDigestAdapter,false);assert.equal(result.executableOpened,false);assert.equal(result.mutatingCalls,0);assert.equal(result.realLinux,false);assert.equal(result.realVm,false);
  for(const check of result.checks)await t.test(check.case,()=>{assert.equal(check.passed,true);assert.equal(check.readonly,true);assert.equal(check.handlesClosed,true);});console.log(JSON.stringify({...result,diagnostic:'windows-browser-repair-observation'}));
 }finally{assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-repair-observation-/);await rm(root,{recursive:true,force:true});}
});
test('Repair observations reject unknown recipes, incomplete metadata and extra authority fields',()=>{
 for(const release of WINDOWS_BROWSER_RELEASES){const receipt={version:1,selectedVersion:release.version,pending:null};assert.deepEqual(parseWindowsBrowserRepairObservation(JSON.stringify(receipt)),receipt);for(const phase of ['receiving','archive-ready','prepared','published']){const pending={epoch:'a'.repeat(32),phase};assert.deepEqual(parseWindowsBrowserRepairObservation(JSON.stringify({...receipt,pending})),{...receipt,pending});}}
 for(const value of [null,{}, {version:1,selectedVersion:'157.0.0.0',pending:null},{version:1,selectedVersion:WINDOWS_BROWSER_RELEASES[0].version},{version:1,selectedVersion:WINDOWS_BROWSER_RELEASES[0].version,pending:null,path:'/foreign'},{version:1,selectedVersion:WINDOWS_BROWSER_RELEASES[0].version,pending:{epoch:'a'.repeat(32),phase:'exec'}},{version:1,selectedVersion:WINDOWS_BROWSER_RELEASES[0].version,pending:{epoch:'../x',phase:'receiving'}}])assert.throws(()=>parseWindowsBrowserRepairObservation(JSON.stringify(value)),{code:'BROWSER_REPAIR_OBSERVATION'});
});
