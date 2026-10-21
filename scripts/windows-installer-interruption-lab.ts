// Real installer process interruption, confined to a fresh application identity
// and an ignored fixture. No host reboot, VM operation or external website.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,access,copyFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {run} from '../server/process.ts';
import {fileHash,powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';

const metadata=JSON.parse(await readFile('.mu-data/windows-run/desktop-package.json','utf8'));
const previous=JSON.parse(await readFile('.mu-data/windows-run/upgrade-baseline-package.json','utf8'));
const installer=metadata.artifacts.find((file:string)=>file.endsWith('.exe')),baseline=previous.artifacts.find((file:string)=>file.endsWith('.exe'));
assert.ok(installer&&baseline);
const directory=path.resolve('.mu-data','windows-installer-interruption-'+randomUUID()),installed=path.join(directory,'programs','personal-install','installed'),data=path.join(directory,'user-data');
assert.equal(path.dirname(directory),path.resolve('.mu-data'));await mkdir(data,{recursive:true});
const trace=path.join(directory,'installer-trace.log'),journal=installed+'.mu-install.json',exe=path.join(installed,'MuCodeSandbox Windows Preview.exe');
const env={...process.env,MU_WINDOWS_INSTALL_TRACE:trace};
const guid='e88eb670-5944-5236-81aa-7c1d3da3d6df';
const ps=(source:string,extra:NodeJS.ProcessEnv={})=>run(powershellPath(),powershellArgs(source),{env:{...env,...extra},timeoutMs:30000});
const registration=()=>ps("$rows=@(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'|Get-ItemProperty|Where-Object{$_.DisplayName -like 'MuCodeSandbox Windows Preview*'}|Select-Object DisplayVersion,UninstallString);[Console]::Write((ConvertTo-Json -InputObject $rows -Compress))").then(value=>JSON.parse(value));
assert.equal((await registration()).length,0,'Existing application registration preserved');
assert.equal((await ps("Test-Path -LiteralPath ('HKCU:\\Software\\MuCodeSandbox\\WindowsPreviewInstaller\\'+$env:MU_LAB_GUID)",{MU_LAB_GUID:guid})).trim(),'False','Existing installer recovery preserved');
const sourceFiles=['scripts/windows-installer-interruption-lab.ts','desktop/windows/installer.nsh','desktop/windows/install-transaction.ps1','scripts/package-windows.ts'],hashes=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,await fileHash(file)]))),sourceHashes=await hashes();
const results:{name:string;passed:boolean}[]=[],pass=(name:string)=>{results.push({name,passed:true});console.log('PASS '+name);};
const install=(file:string,target=true)=>run(file,['/S','/currentuser',...(target?['/D='+installed]:[])],{env,timeoutMs:600000});
const exists=(file:string)=>access(file).then(()=>true,()=>false);
async function interrupt(upgrade:boolean){
 const child=spawn(installer,['/S','/currentuser','/D='+installed],{env,windowsHide:true,stdio:'ignore'});
 const exited=once(child,'exit');let observed:any;
 const deadline=Date.now()+300000;
 while(Date.now()<deadline){
  if(child.exitCode!==null||child.signalCode!==null)throw Error('Installer ended before the intended interruption: '+child.exitCode);
  try{
   const record=JSON.parse(await readFile(journal,'utf8'));
   // Observe actual removal/extraction rather than injecting a production hook.
   if(record.state==='prepared'&&(!upgrade||!(await exists(path.join(installed,'resources/app/package.json'))))&&await exists(installed)){
    if(upgrade&&await exists(exe)){await delay(10);continue;}
    const rows=await readdir(installed);if(!rows.length){await delay(10);continue;}
    observed=record;break;
   }
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  await delay(10);
 }
 assert.ok(observed,'The real installer never reached partial extraction');
 // Pin the process to the exact installer selected above before killing only
 // this fixture's installer tree, including any still-running old uninstaller.
 await ps("$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:MU_LAB_INSTALLER_PID);if(-not $p -or $p.ExecutablePath -ine $env:MU_LAB_INSTALLER_FILE){throw 'Installer identity changed'};& \"$env:SystemRoot\\System32\\taskkill.exe\" /PID $env:MU_LAB_INSTALLER_PID /T /F;if($LASTEXITCODE -ne 0){throw 'Installer tree did not stop'}",{MU_LAB_INSTALLER_PID:String(child.pid),MU_LAB_INSTALLER_FILE:path.resolve(installer)});
 await exited;
 const finalRecord=JSON.parse(await readFile(journal,'utf8'));assert.equal(finalRecord.state,'prepared');assert.equal(finalRecord.nonce,observed.nonce);
 await writeFile(path.join(installed,'partial-canary.bin'),'retained interrupted application '+observed.nonce);
 return observed;
}
async function uninstall(){
 const name=(await readdir(installed)).find(name=>/^Uninstall .*\.exe$/.test(name));assert.ok(name);
 const target=path.join(directory,'uninstall-'+randomUUID()+'.exe');await copyFile(path.join(installed,name),target);
 await run(target,['/S','/currentuser','_?='+installed],{env,timeoutMs:180000});
 assert.equal((await registration()).length,0);await assert.rejects(access(exe));
}
const marker=path.join(data,'retained.bin');await writeFile(marker,'independent synthetic user file');
let complete=false;
try{
 const fresh=await interrupt(false);pass('A real fresh installer is terminated during actual application extraction');
 await install(installer,false);assert.equal((await registration())[0].DisplayVersion,metadata.stage.release.version);
 assert.equal(await readFile(path.join(installed+'.mu-incomplete-'+fresh.nonce,'partial-canary.bin'),'utf8'),'retained interrupted application '+fresh.nonce);
 await assert.rejects(access(journal));assert.equal(await readFile(marker,'utf8'),'independent synthetic user file');
 pass('Retry without a directory argument finds the interrupted target, retains partial files and completes installation');await uninstall();
 await install(baseline);
 const node=path.join(installed,'resources/node/node.exe'),credentials=pathToFileURL(path.join(installed,'resources/app/dist-server/server/platform/windows/credentials.js')).href,id=randomUUID(),secret='synthetic-'+randomUUID();
 const open="const {openWindowsStore}=await import(process.argv[1]);const store=await openWindowsStore(process.argv[2]);";
 await run(node,['--no-warnings','--input-type=module','-e',open+"try{const now=new Date().toISOString();store.save({id:process.argv[3],name:'Retained interrupted upgrade',instanceName:'mu-win-'+process.argv[3].replaceAll('-',''),description:'',kind:'vm',color:'blue',cpus:1,memoryGiB:2,diskGiB:32,mounts:[],ports:[],identity:{timezone:'UTC',locale:'en-US'},state:'stopped',lastError:null,browserRunning:false,browserUrl:'about:blank',createdAt:now,updatedAt:now,network:{mode:'http',host:'127.0.0.1',port:9,username:'',password:process.argv[4],strict:true,transparent:true,noProxy:'',egressLock:{expectedIp:'203.0.113.90'}}});}finally{store.close();store.key.fill(0)}",credentials,data,id,secret],{timeoutMs:30000});
 const original=Object.fromEntries(await Promise.all(['credentials.dpapi','state.sqlite', 'retained.bin'].map(async name=>[name,await fileHash(path.join(data,name))])));
 const upgrade=await interrupt(true);pass('A real old-to-new upgrade is terminated after old application removal and before new extraction completes');
 assert.ok(await exists(installed+'.mu-backup-'+upgrade.nonce));
 await install(installer,false);assert.equal((await registration())[0].DisplayVersion,metadata.stage.release.version);
 for(const [name,hash] of Object.entries(original))assert.equal(await fileHash(path.join(data,name)),hash);
 assert.equal(await readFile(path.join(installed+'.mu-incomplete-'+upgrade.nonce,'partial-canary.bin'),'utf8'),'retained interrupted application '+upgrade.nonce);
 const probe=await run(node,['--no-warnings','--input-type=module','-e',open+"try{if(store.get(process.argv[3]).network.password!==process.argv[4])throw Error('Original credential changed');console.log('ORIGINAL_PROFILE_OK')}finally{store.close();store.key.fill(0)}",credentials,data,id,secret],{timeoutMs:30000});assert.match(probe,/ORIGINAL_PROFILE_OK/);
 pass('A real retry restores the old installation before upgrading; the original DPAPI profile still decrypts and partial files remain retained');
 await uninstall();assert.equal(await readFile(marker,'utf8'),'independent synthetic user file');pass('Final uninstall removes application registration and retains independent original data');complete=true;
}finally{
 const changed=JSON.stringify(sourceHashes)!==JSON.stringify(await hashes());
 await writeFile(path.join(directory,'results.json'),JSON.stringify({scope:'real-installer-process-interruption',sourceHashes,sourceChangedDuringTest:changed,installer,installerHash:await fileHash(installer),baseline,baselineHash:await fileHash(baseline),results,complete:complete&&!changed,hostPowerOperations:0,aiWebsitesVisited:0},null,2));
 await writeFile('.mu-data/windows-run/installer-interruption-lab.json',JSON.stringify({directory,complete:complete&&!changed,checks:results.length},null,2));
 if(changed)throw Error('Installer interruption source changed during acceptance');
}
console.log(JSON.stringify({complete,checks:results.length}));
