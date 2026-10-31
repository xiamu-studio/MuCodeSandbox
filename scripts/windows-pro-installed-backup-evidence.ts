import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {fileHash,powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import {brokerSourceDigest} from '../server/platform/windows/broker.ts';
import {WINDOWS_SOURCE_VERSION} from '../shared/windows-release.ts';
import {run} from '../server/process.ts';

const lab=JSON.parse(await readFile('.mu-data/windows-run/pro-host-lab.json','utf8')),directory=path.resolve(lab.directory);
assert.equal(path.dirname(directory),path.resolve(windowsRuntimeDirectory()));assert.match(path.basename(directory),/^pro-host-[a-f0-9-]{36}$/);
let receipt:any,evidenceFile='';
for(const name of (await readdir(directory)).filter(n=>/^installed-backup-[a-f0-9]{32}\.json$/.test(n))){
 const file=path.join(directory,name),text=await readFile(file,'utf8');if(!text)continue;const value=JSON.parse(text);
 if(value.state==='installed-api-complete-pro-off'&&(!receipt||value.time>receipt.time)){receipt=value;evidenceFile=file;}
}
assert.ok(receipt,'A completed real installed workflow and independent Pro Off are required');
const r=receipt.result,parent=r.bootstrap,actual=parent.nested;
assert.equal(r.version,WINDOWS_SOURCE_VERSION);assert.match(r.caseId,/^[a-f0-9]{32}$/);
for(const value of [parent,actual]){
 assert.equal(value.complete,true);assert.equal(value.version,r.version);assert.equal(value.caseId,r.caseId);
 assert.equal(value.desktopMainExercised,false);assert.equal(value.guiInstallerExercised,false);
 assert.ok(value.checks.every((c:any)=>c.passed===true));
}
assert.notEqual(parent.pid,actual.pid);
const upgraded=Boolean(parent.legacyProof);assert.equal(parent.checks.length,upgraded?2:1);assert.equal(actual.checks.length,upgraded?15:14);
if(upgraded){assert.equal(parent.legacyProof.fromVersion,'0.4.66-preview.1');assert.equal(parent.legacyProof.dataHashesPreservedByInstaller,true);assert.deepEqual(Object.keys(parent.legacyProof.dataHashes).sort(),['credentials.dpapi','retained.bin','state.sqlite']);}
for(const key of ['originalCopyUnchanged','noNestedVms','controllersExited','installedRetained','syntheticAutologonDisabled'])assert.equal(r[key],true,key);
assert.equal(r.registration.elevated,false);assert.equal(r.registration.version,r.version);
for(const key of ['bootRead','noBase','offlineStartFailedClosed','removed','exportCancellation','restoreCancellation'])assert.equal(actual.nested[key],true,key);
assert.notEqual(actual.nested.originalPlatformId,actual.nested.restoredPlatformId);assert.ok(actual.nested.diskBytes>1024**3);assert.match(actual.nested.diskSha256,/^[a-f0-9]{64}$/);
assert.equal(r.fixtureSha256,await fileHash('scripts/windows/pro-installed-backup-client.mjs'));assert.equal(r.brokerSourceDigest,await brokerSourceDigest());
const metadata=JSON.parse(await readFile('.mu-data/windows-run/desktop-package.json','utf8'));assert.equal(metadata.stage.release.version,r.version);
const output=path.resolve(metadata.output);assert.equal(path.dirname(output),path.resolve('release'));assert.match(path.basename(output),/^windows-preview-[a-f0-9-]{36}$/);
const product=path.join(output,'win-unpacked');let files=0;
for(const [relative,digest] of Object.entries(r.installedCodeHashes)){
 assert.match(relative,/^(desktop|dist|dist-server)\//);assert.ok(!relative.split('/').includes('..'));assert.ok(!relative.includes('\\'));
 assert.equal(await fileHash(path.join(product,'resources/app',relative)),digest,relative);files++;
}
assert.equal(files,200);assert.equal(r.installedExecutableSha256,await fileHash(path.join(product,'MuCodeSandbox Windows Preview.exe')));
assert.equal(r.installedNodeSha256,await fileHash(path.join(product,'resources/node/node.exe')));assert.equal(r.installedNodeSha256,metadata.stage.nodeInfo.sha256);
const installer=metadata.artifacts.find((file:string)=>file.endsWith('.exe'));assert.ok(installer);assert.equal(r.installerSha256,await fileHash(installer));
const baseline=JSON.parse(await readFile('.mu-data/windows-run/clean-host-host-baseline.json','utf8'));
const boot=(await run(powershellPath(),powershellArgs("[Console]::Write((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'))"))).trim();
assert.equal(Date.parse(boot),Date.parse(baseline.hostBootId));assert.equal((await run('git',['rev-parse','main'])).trim(),baseline.mainCommit);
const report={complete:true,version:r.version,scope:'real-pro-nsis-cli-upgrade-and-installed-node-product-backup-cancellation-native-retry-and-no-base-boot',checks:parent.checks.length+actual.checks.length,installedCodeFiles:files,installedNodeProcessExercised:true,productApiExercised:true,crossVersionUpgrade:upgraded,originalDpapiProfileDecrypted:upgraded,installerSha256:r.installerSha256,exportCancellation:true,restoreCancellation:true,interruptedNativeRestoreResumed:true,originalCanaryRestored:true,noBaseProductBootRead:true,diskBytes:actual.nested.diskBytes,originalCopyUnchanged:true,proOffAtCollection:true,hostBootUnchanged:true,localMainUnchanged:true,desktopMainExercised:false,guiInstallerExercised:false,systemFileDialogExercised:false,crossMachineRestoreValidated:false,evidenceFile};
await writeFile('.mu-data/windows-run/pro-installed-backup-complete.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
