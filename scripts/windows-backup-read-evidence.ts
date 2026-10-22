import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileHash,powershellArgs,powershellPath} from '../server/platform/windows/runtime.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import {run} from '../server/process.ts';
import {brokerSourceDigest} from '../server/platform/windows/broker.ts';
const lab=JSON.parse(await readFile('.mu-data/windows-run/clean-host-lab.json','utf8')),directory=path.resolve(lab.directory);
assert.equal(path.dirname(directory),path.resolve(windowsRuntimeDirectory()));assert.match(path.basename(directory),/^clean-host-[a-f0-9-]{36}$/);
let evidence:any,evidenceFile='';for(const name of (await readdir(directory)).filter(value=>/^probe-[a-f0-9]{32}\.json$/.test(value))){const file=path.join(directory,name),value=JSON.parse(await readFile(file,'utf8'));if(value.phase==='adoption-backup-collect'&&value.state==='adoption-complete-and-evaluation-vm-off'&&(!evidence||value.time>evidence.time)){evidence=value;evidenceFile=file;}}
assert.ok(evidence,'A completed actual backup run with independent cleanup and outer VM Off is required');const result=evidence.result;
assert.equal(result.nestedGuestsRemaining,0);assert.equal(result.syntheticAutologonDisabled,true);assert.equal(result.originalCanaryPreserved,true);assert.equal(result.aiWebsitesVisited,0);
assert.equal(result.protectedBrokerSourceDigest,await brokerSourceDigest(),'The final installed broker differs from the complete current native/script input set');
let checks=0;for(const phase of ['adoption-seed','adoption-backup','adoption-final']){const value=result.results[phase];assert.equal(value.complete,true,phase);assert.ok(value.checks.every((check:any)=>check.passed));checks+=value.checks.length;}
assert.equal(checks,17);const actual=result.results['adoption-backup'].nested;assert.equal(actual.encryptedRoundTrip,true);assert.equal(actual.originalDiskUnchanged,true);assert.equal(actual.vmRestoreExercised,false);assert.ok(actual.diskBytes>1024*1024);
assert.equal(result.results['adoption-seed'].nested.config.id,actual.id);assert.equal(result.results['adoption-final'].nested.id,actual.id);assert.equal(result.results['adoption-final'].nested.platformId,actual.platformId);assert.equal(result.results['adoption-final'].nested.originalCanaryPreserved,true);assert.equal(result.results['adoption-final'].nested.removed,true);
const source:Record<string,string>={
 'scripts/windows/clean-host-client.mjs':'C:\\MuLab\\client.mjs',
 'scripts/windows/clean-host-adoption-client.mjs':'C:\\MuLab\\adoption-client.mjs',
 'scripts/windows/clean-host-backup-read-client.mjs':'C:\\MuLab\\backup-read-client.mjs',
};
for(const file of ['native/windows/HyperVBroker.cs','native/windows/ProtectedLedger.cs','native/windows/Recovery.cs','native/windows/RecoveryPermissions.cs','native/windows/BackupRead.cs','native/windows/BackupCursor.cs','native/windows/DiskGrowth.cs','scripts/windows/hyperv.ps1','scripts/windows/build-broker.ps1','server/platform/windows/broker.js','server/platform/windows/recovery.js','server/platform/windows/backup-reader.js','server/platform/windows/backup-archive.js'])source[file.endsWith('.js')?'dist-server/'+file:file]='C:\\MuLab\\product\\resources\\app\\dist-server\\'+file.replaceAll('/','\\');
for(const [file,guest] of Object.entries(source))assert.equal(await fileHash(file),result.sourceHashes[guest],'Executed backup source differs: '+file);
const baseline=JSON.parse(await readFile('.mu-data/windows-run/clean-host-host-baseline.json','utf8')),boot=(await run(powershellPath(),powershellArgs("[Console]::Write((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'))"),{timeoutMs:10000})).trim();assert.equal(Date.parse(boot),Date.parse(baseline.hostBootId));assert.equal((await run('git',['rev-parse','main'])).trim(),baseline.mainCommit);assert.equal((await run('git',['ls-remote','origin','refs/heads/main'])).trim().split(/\s+/)[0],baseline.mainCommit);
const verified={complete:true,scope:'source-native-stopped-disk-read-and-authenticated-encrypted-file-roundtrip',checks,currentSourcesMatch:true,sourceFiles:Object.keys(source).length,diskBytes:actual.diskBytes,originalCanaryPreserved:true,originalDiskUnchanged:true,vmRestoreExercised:false,productBackupAvailable:false,plaintextAndEncryptedTestFilesRemoved:true,nestedGuestsRemaining:0,evaluationVmOff:true,syntheticAutologonDisabled:true,hostBootUnchanged:true,mainUnchanged:true,aiWebsitesVisited:0,evidenceFile,directory};
await writeFile('.mu-data/windows-run/clean-host-backup-read-complete.json',JSON.stringify(verified,null,2));console.log(JSON.stringify({complete:true,checks,diskBytes:actual.diskBytes,sourceFiles:verified.sourceFiles,evaluationVmOff:true,productBackupAvailable:false}));
