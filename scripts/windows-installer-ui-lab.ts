// Read-only assertions around Computer Use driven NSIS pages. This script does
// not inject UI input, suppress dialogs, install silently or operate on VMs.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,access} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {run} from '../server/process.ts';
import {fileHash,powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';

const index=path.resolve('.mu-data/windows-run/installer-ui-lab.json'),phase=process.argv[2];
const guid='e88eb670-5944-5236-81aa-7c1d3da3d6df';
const sourceFiles=['scripts/windows-installer-ui-lab.ts','desktop/windows/installer.nsh','desktop/windows/install-transaction.ps1','desktop/windows/check-install-version.ps1','scripts/package-windows.ts','desktop/windows/builder.cjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,await fileHash(file)])));
const ps=(source:string)=>run(powershellPath(),powershellArgs(source),{env:{...process.env,MU_LAB_GUID:guid},timeoutMs:15000});
const registry=()=>ps("$rows=@(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'|Get-ItemProperty|Where-Object{$_.DisplayName -like 'MuCodeSandbox Windows Preview*'}|Select-Object DisplayVersion,UninstallString);[Console]::Write((ConvertTo-Json -InputObject $rows -Compress))").then(value=>JSON.parse(value));
if(phase==='prepare'){
 assert.equal((await registry()).length,0,'Existing Windows Preview installation preserved');
 assert.equal((await ps("Test-Path -LiteralPath ('HKCU:\\Software\\MuCodeSandbox\\WindowsPreviewInstaller\\'+$env:MU_LAB_GUID)")).trim(),'False','Pending installer recovery preserved');
 const metadata=JSON.parse(await readFile('.mu-data/windows-run/desktop-package.json','utf8')),installer=metadata.artifacts.find((file:string)=>file.endsWith('.exe'));assert.ok(installer);
 const directory=path.resolve('.mu-data','windows-installer-ui-'+randomUUID()),selected=path.join(directory,"选择目录 O'Brien $ 测试"),installed=path.join(selected,'MuCodeSandbox Windows Preview'),data=path.join(directory,'independent-user-data');
 await mkdir(data,{recursive:true});await writeFile(path.join(data,'retained.bin'),'synthetic original user file\0中文');
 const state={directory,selected,installed,data,installer,installerSha256:await fileHash(installer),version:metadata.stage.release.version,sourceHashes:await hashes(),results:[],complete:false,createdAt:new Date().toISOString()};
 await writeFile(index,JSON.stringify(state,null,2));await writeFile(path.join(directory,'state.json'),JSON.stringify(state,null,2));console.log(JSON.stringify({directory,selected,installed,installer}));
}else{
 const state=JSON.parse(await readFile(index,'utf8'));assert.equal(path.dirname(state.directory),path.resolve('.mu-data'));assert.match(path.basename(state.directory),/^windows-installer-ui-[a-f0-9-]{36}$/);
 assert.deepEqual(await hashes(),state.sourceHashes,'GUI acceptance sources changed');assert.equal(await fileHash(state.installer),state.installerSha256);
 const rows=await registry(),executable=path.join(state.installed,'MuCodeSandbox Windows Preview.exe');
 assert.equal(await readFile(path.join(state.data,'retained.bin'),'utf8'),'synthetic original user file\0中文');
 if(phase==='cancel'){
  assert.equal(rows.length,0);await assert.rejects(access(executable),{code:'ENOENT'});await assert.rejects(access(state.installed+'.mu-install.json'),{code:'ENOENT'});
 }else if(phase==='installed'||phase==='repair'){
  assert.equal(rows.length,1);assert.equal(rows[0].DisplayVersion,state.version);assert.ok(rows[0].UninstallString.toLowerCase().includes(state.installed.toLowerCase()));
  const pkg=JSON.parse(await readFile(path.join(state.installed,'resources/app/package.json'),'utf8'));assert.equal(pkg.version,state.version);await access(executable);
  await assert.rejects(access(state.installed+'.mu-install.json'),{code:'ENOENT'});
  const names=await readdir(path.dirname(state.installed));assert.equal(names.some(name=>name.includes('.mu-backup-')),false);
  const current={executable:await fileHash(executable),package:await fileHash(path.join(state.installed,'resources/app/package.json'))};
  if(phase==='repair')assert.deepEqual(current,state.applicationHashes);else state.applicationHashes=current;
 }else if(phase==='preserved'){
  assert.equal(rows.length,1);assert.equal(await fileHash(executable),state.applicationHashes.executable);
 }else if(phase==='uninstalled'){
  assert.equal(rows.length,0);await assert.rejects(access(executable),{code:'ENOENT'});
 }else if(phase==='finish'){
  assert.equal(rows.length,0);for(const required of ['cancel','installed','repair','preserved','uninstalled'])assert.ok(state.results.some((row:{phase:string})=>row.phase===required));
  const events=(await readFile(path.join(state.directory,'ui-events.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  for(const required of ['control-panel-listed','uninstall-confirmed','uninstall-finished'])assert.ok(events.some(event=>event.phase===required),'Silent cleanup cannot count as verified GUI uninstall');
  state.complete=true;
 }else throw Error('Choose prepare, cancel, installed, repair, preserved, uninstalled or finish');
 state.results.push({phase,passed:true,at:new Date().toISOString()});await writeFile(index,JSON.stringify(state,null,2));await writeFile(path.join(state.directory,'state.json'),JSON.stringify(state,null,2));console.log(JSON.stringify({phase,complete:state.complete,checks:state.results.length}));
}
