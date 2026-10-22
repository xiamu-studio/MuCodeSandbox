import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {fileHash,powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import {brokerSourceDigest} from '../server/platform/windows/broker.ts';
import {run} from '../server/process.ts';
const index=JSON.parse(await readFile('.mu-data/windows-run/pro-host-lab.json','utf8')),directory=path.resolve(index.directory);
assert.equal(path.dirname(directory),path.resolve(windowsRuntimeDirectory()));assert.match(path.basename(directory),/^pro-host-[a-f0-9-]{36}$/);
const meta=JSON.parse(await readFile(path.join(directory,'upgrade-inputs.json'),'utf8')),reports:{file:string;value:any}[]=[];
for(const name of await readdir(directory))if(/^probe-[a-f0-9]{32}\.json$/.test(name)){const file=path.join(directory,name);reports.push({file,value:JSON.parse(await readFile(file,'utf8'))});}
function latest(phase:string){const record=reports.filter(report=>report.value.phase===phase).sort((a,b)=>Date.parse(b.value.time)-Date.parse(a.value.time))[0];assert.ok(record,'Missing '+phase);return record;}
const phases=['old-install','old-seed','install','current','reject','uninstall','cleanup'],steps=phases.map(phase=>latest('upgrade-'+phase));
for(let i=0;i<steps.length;i++){
 const receipt=steps[i].value.result;assert.equal(steps[i].value.state,'upgrade-result');assert.equal(receipt.caseId,meta.caseId);assert.equal(receipt.phase,phases[i]);
 for(const field of ['complete','processExitConfirmed','brokerExitConfirmed','originalUserUnchanged','defaultBrokerPointerUnchanged'])assert.equal(receipt[field],true,phases[i]+': '+field);
 assert.equal(receipt.guiAuthenticationTested,false);assert.equal(receipt.aiWebsitesVisited,0);assert.ok(receipt.checks.length>0);assert.ok(receipt.checks.every((check:any)=>check.passed===true));
 if(i)assert.ok(Date.parse(steps[i].value.time)>Date.parse(steps[i-1].value.time));
 if(['old-install','install','reject','uninstall'].includes(phases[i]))assert.deepEqual(receipt.before,receipt.after,'Installer altered stopped VM/VHDX');
}
const seed=steps[1].value.result,current=steps[3].value.result,cleanup=steps[6].value.result;
assert.equal(seed.after.registered,1);assert.equal(seed.after.diskGiB,32);assert.equal(current.before.diskGiB,32);assert.equal(current.after.diskGiB,40);
for(const record of steps.slice(2,6))for(const field of ['id','platformId','diskIdentifier','path'])assert.equal(record.value.result.after[field],seed.after[field]);
for(const field of ['id','platformId','diskIdentifier','path'])assert.equal(cleanup.before[field],seed.after[field]);
assert.equal(cleanup.before.diskGiB,40);assert.equal(cleanup.after.registered,0);assert.equal(cleanup.nested.removed,true);
for(const step of [steps[2],steps[4],steps[5]])assert.match(step.value.result.before.sha256,/^[a-f0-9]{64}$/);
const audit=latest('upgrade-audit'),inspection=latest('upgrade-inspect'),collection=latest('collect-state'),observed=audit.value.result;
assert.ok(Date.parse(audit.value.time)>Date.parse(steps[6].value.time));assert.ok(Date.parse(inspection.value.time)>=Date.parse(audit.value.time));assert.ok(Date.parse(collection.value.time)>=Date.parse(inspection.value.time));
assert.equal(observed.complete,true);assert.equal(observed.caseId,meta.caseId);assert.ok(observed.protectedOwners.includes(observed.userSid));
for(const field of ['actors','nestedGuests','privateSwitches','registeredGuests','runtimeDirectories'])assert.equal(observed[field],0);
for(const field of ['registrationCopiesEqual','defaultBrokerPointerUnchanged','vmmsRunning'])assert.equal(observed[field],true);
assert.equal(observed.fixtureParentAclRestored,true);
if(observed.retainedFailure){
 assert.equal(observed.retainedFailure.complete,false);assert.equal(observed.retainedFailure.checksPassed,3);
 for(const field of ['fixtureOnlyRepair','encryptedBytesUnchanged','originalDiskUnchanged'])assert.equal(observed.retainedFailure[field],true);
 const repair=latest('upgrade-repair-fixture');assert.equal(repair.value.result.complete,true);assert.equal(repair.value.result.rights,129);assert.equal(repair.value.result.inherits,false);
 const before=reports.filter(report=>report.value.phase==='upgrade-permissions'&&Date.parse(report.value.time)<Date.parse(repair.value.time)).sort((a,b)=>Date.parse(b.value.time)-Date.parse(a.value.time))[0];assert.ok(before);assert.equal(before.value.result.readOnly,true);assert.equal(before.value.result.paths.filter((entry:any)=>entry.pinError===5).length,1);
 const after=latest('upgrade-permissions');assert.ok(Date.parse(after.value.time)>Date.parse(repair.value.time));assert.ok(Date.parse(after.value.time)<Date.parse(steps[6].value.time));assert.equal(after.value.result.readOnly,true);assert.equal(after.value.result.paths.length,6);assert.ok(after.value.result.paths.every((entry:any)=>entry.pinError===0));
}
assert.equal(inspection.value.result.actors.length,0);assert.equal(inspection.value.result.nested.length,0);
const profile=inspection.value.result.reports.find((report:any)=>report.caseId===meta.caseId&&report.profileLoaded===true);assert.ok(profile);assert.equal(profile.userSid,observed.userSid);
for(const field of ['complete','ordinary','profileLoaded','dpapiRoundtrip','hkcuIsolated'])assert.equal(profile[field],true);assert.equal(profile.interactiveAuthenticationAutomated,false);
assert.equal(observed.clientSha256,await fileHash('scripts/windows/pro-upgrade-client.mjs'));assert.equal(observed.stationSourceSha256,await fileHash('scripts/windows/ProUpgradeStation.cs'));
assert.deepEqual(observed.brokers,meta.brokers);assert.equal(observed.brokers.current.sourceDigest,await brokerSourceDigest());
const pkg=JSON.parse(await readFile('.mu-data/windows-run/desktop-package.json','utf8'));assert.equal(pkg.stage.release.version,meta.versions.current);
const packages=[];for(const version of [meta.versions.old,meta.versions.current]){const record=JSON.parse(await readFile('.mu-data/windows-run/package-audit-'+version+'.json','utf8'));assert.equal(record.complete,true);assert.deepEqual(record.privateFindings,[]);packages.push(record);}
assert.equal(meta.files['installers/old.exe'],packages[0].installerSha256);assert.equal(meta.files['installers/current.exe'],packages[1].installerSha256);
let boundFiles=0;for(const [relative,hash] of Object.entries(observed.artifactHashes)){assert.equal(await fileHash(path.join(pkg.stage.app,relative)),hash,'Retained installed artifact mismatch: '+relative);boundFiles++;}assert.equal(boundFiles,10);
const staged=await import(pathToFileURL(path.join(pkg.stage.app,'dist-server/server/platform/windows/broker.js')).href);assert.equal(await staged.brokerSourceDigest(),observed.brokers.current.sourceDigest);
const collected=collection.value.result;assert.equal(collected.proVmRunning,true);assert.equal(collected.networkDisconnected,true);assert.equal(collected.syntheticAutologonDisabled,true);
const baseline=JSON.parse(await readFile('.mu-data/windows-run/clean-host-host-baseline.json','utf8')),boot=(await run(powershellPath(),powershellArgs("[Console]::Write((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'))"))).trim();assert.equal(Date.parse(boot),Date.parse(baseline.hostBootId));
const main=(await run('git',['rev-parse','main'])).trim(),remote=(await run('git',['ls-remote','origin','refs/heads/main'])).trim().split(/\s/)[0];assert.equal(main,baseline.mainCommit);assert.equal(remote,main);
const checks=steps.flatMap(step=>step.value.result.checks);assert.equal(checks.length,15);
await writeFile('.mu-data/windows-run/pro-upgrade-complete.json',JSON.stringify({complete:true,scope:'actual per-user Pro NSIS preview.5-to-.6 upgrade, original encrypted profile and Linux disk, repair/downgrade/uninstall and cleanup; GUI/UAC and real power loss remain separate',versions:meta.versions,checks,boundFiles,independent:observed,packages,hostBootUnchanged:true,mainUnchanged:true,aiWebsitesVisited:0,reports:{steps:steps.map(step=>step.file),audit:audit.file,inspection:inspection.file,collection:collection.file}},null,2));
console.log(JSON.stringify({complete:true,clientChecks:checks.length,boundFiles,originalVmReused:true,hostBootUnchanged:true,mainUnchanged:true}));
