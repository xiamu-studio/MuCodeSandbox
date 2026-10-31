import './windows-backup-restore-evidence.ts';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileHash} from '../server/platform/windows/runtime.ts';
const backend=JSON.parse(await readFile('.mu-data/windows-run/clean-host-backup-restore-complete.json','utf8'));
const evidence=JSON.parse(await readFile(backend.evidenceFile,'utf8')),actual=evidence.result.results['adoption-backup-restore'].nested,installed=evidence.result.installedPackage;
assert.equal(actual.installedProductApiExercised,true);assert.equal(actual.desktopUiExercised,false);assert.equal(actual.guiInstallerExercised,false);assert.equal(installed.registrationVerified,true);assert.equal(installed.preserved,true);assert.equal(installed.version,'0.4.66-preview.13');
const metadata=JSON.parse(await readFile('.mu-data/windows-run/desktop-package.json','utf8'));assert.equal(metadata.stage.release.version,installed.version);
const output=path.resolve(metadata.output);assert.equal(path.dirname(output),path.resolve('release'));assert.match(path.basename(output),/^windows-preview-[a-f0-9-]{36}$/);
const product=path.join(output,'win-unpacked');let files=0;
for(const [relative,digest] of Object.entries(installed.sourceHashes)){
 assert.match(relative,/^(?:desktop|dist|dist-server)\//);assert.ok(!relative.split('/').includes('..'));assert.equal(await fileHash(path.join(product,'resources/app',relative)),digest,'Installed payload differs from the actual package: '+relative);files++;
}
assert.equal(files,200);assert.equal(installed.executableSha256,await fileHash(path.join(product,'MuCodeSandbox Windows Preview.exe')));assert.equal(installed.nodeSha256,await fileHash(path.join(product,'resources/node/node.exe')));
assert.equal(installed.installerSha256,actual.installerSha256);assert.equal(installed.installerSha256,await fileHash(metadata.artifacts.find((file:string)=>file.endsWith('.exe'))));
const result={complete:true,scope:'ordinary-user-real-nsis-cli-install-and-installed-backend-backup-to-new-bootable-vm',version:installed.version,checks:backend.checks,executedSourceFiles:backend.sourceFiles,installedCodeFiles:files,installerSha256:installed.installerSha256,installedExecutableMatchesPackage:true,installedNodeBytesMatchController:true,installedProductApiExercised:true,actualInstalledDesktopMainExercised:false,guiInstallerExercised:false,systemFileDialogExercised:false,sameUserOnly:true,originalCanaryRestored:true,evaluationVmOffAtCollection:true,installationRetainedForDesktopAcceptance:true,evidenceFile:backend.evidenceFile};
await writeFile('.mu-data/windows-run/clean-host-backup-installed-complete.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
