// Verify the completed disconnected-lab restore against the current build.
// This reads existing private evidence; it does not launch or modify a VM.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileHash,powershellArgs,powershellPath} from '../server/platform/windows/runtime.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import {brokerSourceDigest} from '../server/platform/windows/broker.ts';
import {run} from '../server/process.ts';

const lab=JSON.parse(await readFile('.mu-data/windows-run/clean-host-lab.json','utf8')),directory=path.resolve(lab.directory);
assert.equal(path.dirname(directory),path.resolve(windowsRuntimeDirectory()));
assert.match(path.basename(directory),/^clean-host-[a-f0-9-]{36}$/);
let evidence:any,evidenceFile='';
for(const name of (await readdir(directory)).filter(value=>/^probe-[a-f0-9]{32}\.json$/.test(value))){
 const file=path.join(directory,name),value=JSON.parse(await readFile(file,'utf8'));
 if(value.phase==='adoption-backup-restore-collect'&&value.state==='adoption-complete-and-evaluation-vm-off'&&(!evidence||value.time>evidence.time)){evidence=value;evidenceFile=file;}
}
assert.ok(evidence,'A completed restore with independent cleanup and evaluation VM Off is required');
const result=evidence.result;
assert.equal(result.nestedGuestsRemaining,0);assert.equal(result.syntheticAutologonDisabled,true);assert.equal(result.aiWebsitesVisited,0);
assert.equal(result.protectedBrokerSourceDigest,await brokerSourceDigest(),'Installed broker differs from the current complete native/script input set');
let checks=0;
for(const phase of ['adoption-seed','adoption-backup-restore']){
 const value=result.results[phase];assert.equal(value.complete,true,phase);assert.ok(value.checks.length>0);assert.ok(value.checks.every((check:any)=>check.passed===true));checks+=value.checks.length;
}
assert.equal(checks,17);
const seed=result.results['adoption-seed'].nested,actual=result.results['adoption-backup-restore'].nested;
assert.equal(actual.id,seed.config.id);assert.equal(actual.originalPlatformId,seed.platformId);
assert.match(actual.restoredPlatformId,/^[a-f0-9-]{36}$/);assert.notEqual(actual.restoredPlatformId,seed.platformId);
for(const key of ['originalCopyPreserved','originalCanaryRestored','newDpapiStore','sameUserOnly','vmRestoreExercised','productApiExercised','installedProductApiExercised','removed'])assert.equal(actual[key],true,key);
assert.ok(Number.isSafeInteger(actual.diskBytes)&&actual.diskBytes>1024*1024);
const sources:Record<string,string>={
 'scripts/windows/clean-host-client.mjs':'C:\\MuLab\\client.mjs',
 'scripts/windows/clean-host-adoption-client.mjs':'C:\\MuLab\\adoption-client.mjs',
 'scripts/windows/clean-host-backup-product-client.mjs':'C:\\MuLab\\backup-product-client.mjs',
 'scripts/windows/clean-host-backup-installed-client.mjs':'C:\\MuLab\\backup-installed-client.mjs',
 'scripts/windows/clean-host-backup-restore-client.mjs':'C:\\MuLab\\backup-restore-client.mjs',
};
for(const file of ['native/windows/HyperVBroker.cs','native/windows/ProtectedLedger.cs','native/windows/Recovery.cs','native/windows/RecoveryPermissions.cs','native/windows/BackupRead.cs','native/windows/BackupRestore.cs','native/windows/RuntimeMetadataCleanup.cs','scripts/windows/hyperv.ps1','server/platform/windows/broker.js','server/platform/windows/recovery.js','server/platform/windows/backup-bundle.js','server/platform/windows/backup-reader.js','server/platform/windows/backup-archive.js','server/platform/windows/runtime.js','server/platform/windows/recovery-candidates.js','server/platform/windows/backup-service.js','server/platform/windows/service.js','server/platform/windows/manager.js','server/platform/windows/host-components.js','server/platform/windows/credentials.js','server/platform/windows/config.js','server/platform/windows/guest.js'])sources[file.endsWith('.js')?'dist-server/'+file:file]='C:\\MuLab\\product\\resources\\app\\dist-server\\'+file.replaceAll('/','\\');
for(const [file,guest] of Object.entries(sources))assert.equal(await fileHash(file),result.sourceHashes[guest],'Executed restore source differs: '+file);
const baseline=JSON.parse(await readFile('.mu-data/windows-run/clean-host-host-baseline.json','utf8'));
const boot=(await run(powershellPath(),powershellArgs("[Console]::Write((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'))"),{timeoutMs:10000})).trim();
assert.equal(Date.parse(boot),Date.parse(baseline.hostBootId));assert.equal((await run('git',['rev-parse','main'])).trim(),baseline.mainCommit);
const verified={complete:true,scope:'source-product-api-authenticated-backup-to-bootable-new-hyperv-vm',checks,currentSourcesMatch:true,sourceFiles:Object.keys(sources).length,diskBytes:actual.diskBytes,vmRestoreExercised:true,productApiExercised:true,installedProductApiExercised:actual.installedProductApiExercised===true,desktopUiExercised:false,originalCanaryRestored:true,newDpapiStore:true,sameUserOnly:true,crossUserRestoreValidated:false,productBackupAvailable:false,restoredResourcesRemoved:true,independentOriginalCopyRetained:true,nestedGuestsRemaining:0,evaluationVmOffAtCollection:true,syntheticAutologonDisabled:true,hostBootUnchanged:true,localMainUnchanged:true,aiWebsitesVisited:0,evidenceFile,directory};
await writeFile('.mu-data/windows-run/clean-host-backup-restore-complete.json',JSON.stringify(verified,null,2));
console.log(JSON.stringify({complete:true,checks,diskBytes:actual.diskBytes,sourceFiles:verified.sourceFiles,vmRestoreExercised:true,sameUserOnly:true,productBackupAvailable:false}));
