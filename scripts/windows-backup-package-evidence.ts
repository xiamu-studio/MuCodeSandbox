// Static package parity is separate from installing or exercising its GUI.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fileHash} from '../server/platform/windows/runtime.ts';
import {brokerSourceDigest} from '../server/platform/windows/broker.ts';
import {WINDOWS_SOURCE_VERSION} from '../shared/windows-release.ts';
let crossUser=false,graphical=false,installedCurrent=false,proInstalledCurrent=false,boundaryCurrent=false,historicalCrossUser=false;
try{const value=JSON.parse(await readFile('.mu-data/windows-run/pro-backup-boundary-complete.json','utf8'));boundaryCurrent=value.version===WINDOWS_SOURCE_VERSION;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
try{const value=JSON.parse(await readFile('.mu-data/windows-run/backup-preview14-installed-complete.json','utf8'));installedCurrent=value.version===WINDOWS_SOURCE_VERSION;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
try{const value=JSON.parse(await readFile('.mu-data/windows-run/pro-installed-backup-complete.json','utf8'));proInstalledCurrent=value.version===WINDOWS_SOURCE_VERSION;installedCurrent ||= proInstalledCurrent;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
try{const value=JSON.parse(await readFile('.mu-data/windows-run/clean-host-backup-cross-complete.json','utf8'));historicalCrossUser=true;crossUser=true;if(boundaryCurrent){const receipt=JSON.parse(await readFile(value.evidenceFile,'utf8'));crossUser=receipt.result.protectedBrokerSourceDigest===await brokerSourceDigest();}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
if(!crossUser&&!boundaryCurrent)try{await readFile('.mu-data/windows-run/clean-host-backup-gui-complete.json');graphical=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
if(crossUser)await import('./windows-backup-cross-evidence.ts');
if(boundaryCurrent)await import('./windows-backup-boundary-evidence.ts');
if(proInstalledCurrent)await import('./windows-pro-installed-backup-evidence.ts');else if(installedCurrent)await import('./windows-backup-preview14-evidence.ts');else if(!crossUser&&!boundaryCurrent){if(graphical)await import('./windows-backup-gui-evidence.ts');else await import('./windows-backup-restore-evidence.ts');}
const metadata=JSON.parse(await readFile('.mu-data/windows-run/desktop-package.json','utf8'));
assert.equal(metadata.stage.release.version,WINDOWS_SOURCE_VERSION);
const output=path.resolve(metadata.output);assert.equal(path.dirname(output),path.resolve('release'));assert.match(path.basename(output),/^windows-preview-[a-f0-9-]{36}$/);
const app=path.join(output,'win-unpacked/resources/app');let compared=0;
async function compareTree(directory:string,relative:string){
 for(const entry of await readdir(directory,{withFileTypes:true})){
  assert.ok(!entry.isSymbolicLink(),'Packaged reparse entry');const file=path.join(directory,entry.name),key=path.posix.join(relative,entry.name);
  if(entry.isDirectory()){await compareTree(file,key);continue;}
  if(key==='dist-server/windows-release.json')continue;
  const source=key.startsWith('dist-server/native/')||key.startsWith('dist-server/scripts/')?key.slice('dist-server/'.length):key;
  assert.equal(await fileHash(file),await fileHash(source),'Packaged code differs from current source/build: '+source);compared++;
 }
}
for(const directory of ['dist','dist-server','desktop'])await compareTree(path.join(app,directory),directory);
const packagedBroker=await import(pathToFileURL(path.join(app,'dist-server/server/platform/windows/broker.js')).href);
assert.equal(await packagedBroker.brokerSourceDigest(),await brokerSourceDigest());
const audit=JSON.parse(await readFile('.mu-data/windows-run/package-audit-'+WINDOWS_SOURCE_VERSION+'.json','utf8'));
assert.equal(audit.complete,true);assert.deepEqual(audit.privateFindings,[]);
const installer=metadata.artifacts.find((file:string)=>file.endsWith('.exe'));assert.ok(installer);assert.equal(await fileHash(installer),audit.installerSha256);
const real=JSON.parse(await readFile(proInstalledCurrent?'.mu-data/windows-run/pro-installed-backup-complete.json':installedCurrent?'.mu-data/windows-run/backup-preview14-installed-complete.json':boundaryCurrent?'.mu-data/windows-run/pro-backup-boundary-complete.json':crossUser?'.mu-data/windows-run/clean-host-backup-cross-complete.json':graphical?'.mu-data/windows-run/clean-host-backup-gui-complete.json':'.mu-data/windows-run/clean-host-backup-restore-complete.json','utf8'));
assert.equal(real.complete,true);if(!boundaryCurrent&&!installedCurrent&&!graphical&&!crossUser){assert.equal(real.productApiExercised,true);assert.equal(real.currentSourcesMatch,true);}
const result={complete:true,scope:'static-preview-package-parity-with-real-vm-acceptance',version:WINDOWS_SOURCE_VERSION,comparedCodeFiles:compared,brokerInputsMatch:true,privateFindings:0,installerSha256:audit.installerSha256,installer,unsigned:true,runtimeAcceptanceScope:real.scope,runtimeRealChecks:real.checks,currentNativeBoundaryValidated:boundaryCurrent,historicalCrossUserEvidenceAvailable:historicalCrossUser,crossUserSourceBackendValidated:crossUser,newPackageInstalledWorkflowExercised:installedCurrent,installedNodeProcessExercised:installedCurrent,installedRendererInDiagnosticHostExercised:graphical&&!installedCurrent,actualInstalledDesktopMainExercised:false};
await writeFile('.mu-data/windows-run/backup-package-complete.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
