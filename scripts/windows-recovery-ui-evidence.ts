// Read-only verification of the exact recovery GUI run, code and package.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileHash,powershellArgs,powershellPath} from '../server/platform/windows/runtime.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import {WINDOWS_SOURCE_VERSION} from '../shared/windows-release.ts';
import {run} from '../server/process.ts';
const lab=JSON.parse(await readFile('.mu-data/windows-run/clean-host-lab.json','utf8')),directory=path.resolve(lab.directory);
assert.equal(path.dirname(directory),path.resolve(windowsRuntimeDirectory()));assert.match(path.basename(directory),/^clean-host-[a-f0-9-]{36}$/);
const files=(await readdir(directory)).filter(name=>/^probe-[a-f0-9]{32}\.json$/.test(name));let evidence:any,evidenceFile='';
for(const name of files){const file=path.join(directory,name),value=JSON.parse(await readFile(file,'utf8'));if(value.phase==='adoption-ui-collect'&&value.state==='adoption-complete-and-evaluation-vm-off'&&(!evidence||value.time>evidence.time)){evidence=value;evidenceFile=file;}}
assert.ok(evidence,'A completed GUI run with confirmed shutdown is required');const result=evidence.result;
assert.equal(result.nestedGuestsRemaining,0);assert.equal(result.syntheticAutologonDisabled,true);assert.equal(result.originalCanaryPreserved,true);assert.equal(result.aiWebsitesVisited,0);
let checks=0;for(const phase of ['adoption-seed','adoption-ui','adoption-final']){const tested=result.results[phase];assert.equal(tested.complete,true,phase);assert.ok(tested.checks.every((check:any)=>check.passed));checks+=tested.checks.length;}
assert.equal(checks,19);const ui=result.results['adoption-ui'];
for(const name of ['known-hosts','manifest','DPAPI'])assert.ok(ui.checks.some((check:any)=>check.passed&&check.name.includes(name+' replacement after native disk review')),'Missing actual material replacement: '+name);
assert.equal(ui.nested.originalManagementUnchanged,true);assert.equal(ui.nested.originalDiskUnchanged,true);assert.equal(result.results['adoption-final'].nested.originalCanaryPreserved,true);
const pkg=JSON.parse(await readFile('.mu-data/windows-run/desktop-package.json','utf8'));assert.equal(pkg.stage.release.version,WINDOWS_SOURCE_VERSION);const app=path.join(pkg.output,'win-unpacked/resources/app');
const matches:Record<string,string>={
 'scripts/windows/clean-host-client.mjs':'C:\\MuLab\\client.mjs',
 'scripts/windows/clean-host-adoption-client.mjs':'C:\\MuLab\\adoption-client.mjs',
 'scripts/windows/clean-host-recovery-ui.mjs':'C:\\MuLab\\recovery-ui.mjs',
 'scripts/windows/clean-host-recovery-ui.cjs':'C:\\MuLab\\recovery-ui.cjs',
};
const packaged=[
 'native/windows/HyperVBroker.cs','native/windows/ProtectedLedger.cs','native/windows/Recovery.cs','native/windows/RecoveryPermissions.cs','scripts/windows/hyperv.ps1',
 ...['recovery.js','broker.js','recovery-service.js','recovery-wizard.js','recovery-candidates.js'].map(name=>'server/platform/windows/'+name),
];
for(const name of packaged){const source=name.endsWith('.js')?'dist-server/'+name:name,relative='dist-server/'+name;matches[source]='C:\\MuLab\\product\\resources\\app\\'+relative.replaceAll('/','\\');assert.equal(await fileHash(source),await fileHash(path.join(app,relative)),'Packaged recovery source differs: '+source);}
for(const [source,guest] of Object.entries(matches))assert.equal(await fileHash(source),result.sourceHashes[guest],'Executed recovery code differs: '+source);
let rendererFiles=0;for(const [guest,hash] of Object.entries(result.sourceHashes)){const prefix='C:\\MuLab\\product\\resources\\app\\dist\\';if(!guest.startsWith(prefix))continue;const relative=guest.slice(prefix.length);assert.equal(await fileHash(path.join('dist',relative)),hash);assert.equal(await fileHash(path.join(app,'dist',relative)),hash);rendererFiles++;}assert.ok(rendererFiles>=26);
const baseline=JSON.parse(await readFile('.mu-data/windows-run/clean-host-host-baseline.json','utf8'));
const boot=(await run(powershellPath(),powershellArgs("[Console]::Write((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'))"),{timeoutMs:10000})).trim();assert.equal(Date.parse(boot),Date.parse(baseline.hostBootId));
assert.equal((await run('git',['rev-parse','main'])).trim(),baseline.mainCommit);assert.equal((await run('git',['ls-remote','origin','refs/heads/main'])).trim().split(/\s+/)[0],baseline.mainCommit);
const verified={complete:true,version:WINDOWS_SOURCE_VERSION,scope:'real-recovery-gui-material-binding-refusal-and-original-disk-reopen',checks,currentSourcesMatch:true,packagedRecoveryFiles:packaged.length,rendererBuildFilesMatch:rendererFiles,originalManagementUnchanged:true,originalCanaryPreserved:true,evaluationVmOff:true,nestedGuestsRemaining:0,syntheticAutologonDisabled:true,hostBootUnchanged:true,mainUnchanged:true,aiWebsitesVisited:0,evidenceFile,directory,screenshot:result.screenshot};
await writeFile('.mu-data/windows-run/clean-host-recovery-materials-complete.json',JSON.stringify(verified,null,2));console.log(JSON.stringify({complete:true,version:WINDOWS_SOURCE_VERSION,checks,rendererFiles,packagedRecoveryFiles:packaged.length,evaluationVmOff:true}));
