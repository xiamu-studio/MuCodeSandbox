import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,access,readdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {run} from '../server/process.ts';
import {fileHash,powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';

const metadata=JSON.parse(await readFile('.mu-data/windows-run/desktop-package.json','utf8')),installer=metadata.artifacts.find((file:string)=>file.endsWith('.exe')&&!file.includes('__uninstaller')) as string|undefined;if(!installer)throw Error('Build the Windows NSIS test installer first');
const sourceFiles=['scripts/windows-install-lab.ts','desktop/windows/installer.nsh','desktop/windows/check-running.ps1','desktop/windows/builder.cjs','scripts/package-windows.ts','scripts/windows/package-runtime.ts'],hashes=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,await fileHash(file)]))),sourceHashes=await hashes();
const resumeIndex=process.argv.indexOf('--resume'),resuming=resumeIndex>=0,directory=resuming?path.resolve(process.argv[resumeIndex+1]):path.resolve('.mu-data','windows-install-lab-'+randomUUID());if(path.dirname(directory)!==path.resolve('.mu-data')||!/^windows-install-lab-[a-f0-9-]{36}$/.test(path.basename(directory)))throw Error('Installer fixture boundary changed');const installed=path.join(directory,'installed'),data=path.join(directory,'user-data');await mkdir(data,{recursive:true});const marker=path.join(data,'keep.json');await writeFile(marker,JSON.stringify({synthetic:true,preserve:'upgrade and uninstall'}));
process.env.MU_WINDOWS_INSTALL_TRACE=path.join(directory,'installer-trace.log');
const results:{name:string;passed:boolean}[]=[],pass=(name:string)=>{results.push({name,passed:true});console.log('PASS '+name);};
const registrations=async()=>JSON.parse(await run(powershellPath(),powershellArgs("$ErrorActionPreference='Stop';$rows=@(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object {$_.DisplayName -like 'MuCodeSandbox Windows Preview*'} | Select-Object UninstallString);[Console]::Write((ConvertTo-Json -InputObject $rows -Compress))"),{timeoutMs:10000})) as {UninstallString:string}[];
const beforeRegistration=await registrations();assert.equal(beforeRegistration.length,resuming?1:0,'Existing Windows Preview installation preserved; installer lab requires an unused application identity');if(resuming)assert.ok(beforeRegistration[0].UninstallString.toLowerCase().includes(installed.toLowerCase()),'A different user installation was preserved');let complete=false;
try{
 if(!resuming)await run(installer,['/S','/currentuser','/D='+installed],{timeoutMs:180000});const executable=path.join(installed,'MuCodeSandbox Windows Preview.exe');await access(executable);assert.equal((await registrations()).length,1);pass('Unsigned NSIS preview installs into a fresh per-user directory');
 const uninstaller=(await readdir(installed)).find(name=>/^Uninstall .*\.exe$/.test(name));assert.ok(uninstaller);
 const busy=spawn(path.join(installed,'resources/node/node.exe'),['-e',"console.log('READY');setInterval(()=>{},1000)"],{windowsHide:true,stdio:['ignore','pipe','ignore']});
 try{
  await once(busy.stdout,'data');
  await assert.rejects(run(installer,['/S','/currentuser','/D='+installed],{timeoutMs:30000}),{code:'PROCESS_FAILED'});assert.equal(busy.exitCode,null);await access(executable);pass('A busy installation rejects replacement without terminating its management runtime');
  // NSIS normally relaunches a temporary copy and its outer process returns 0
  // before the check. _?= makes this bounded negative check wait in place.
  await assert.rejects(run(path.join(installed,uninstaller),['/S','/currentuser','_?='+installed],{timeoutMs:30000}),{code:'PROCESS_FAILED'});assert.equal(busy.exitCode,null);await access(executable);pass('A busy uninstaller preserves the live management runtime and application files');
 }finally{const exited=once(busy,'exit');busy.kill('SIGKILL');await exited;}
 const before=await fileHash(executable);await run(installer,['/S','/currentuser','/D='+installed],{timeoutMs:180000});assert.equal(await fileHash(executable),before);assert.equal(JSON.parse(await readFile(marker,'utf8')).preserve,'upgrade and uninstall');pass('An in-place reinstall preserves independent user data and consistent executable bytes');
 await writeFile(path.join(directory,'installed.json'),JSON.stringify({executable,installer,installerSha256:await fileHash(installer),dataDir:data},null,2));
 if(process.argv.includes('--desktop-lab')){
  const args=['scripts/windows-desktop-lab.ts','--executable',executable],reuse=process.argv.indexOf('--reuse-fixture');if(reuse>=0)args.push('--reuse-fixture',path.resolve(process.argv[reuse+1]));
  await run(process.execPath,args,{timeoutMs:900000,onOutput:text=>process.stdout.write(text)});pass('The installed application passes the real protected-VM desktop matrix before uninstall');
 }
 if(process.argv.includes('--setup-package-lab')){
  const prepared=process.argv.indexOf('--prepared-fixture');if(prepared<0)throw Error('Explicit prepared setup fixture required');
  await run(process.execPath,['scripts/windows-setup-package-lab.ts','--executable',executable,'--prepared-fixture',path.resolve(process.argv[prepared+1])],{timeoutMs:600000,onOutput:text=>process.stdout.write(text)});pass('The installed application passes protected setup recovery and cancellation before uninstall');
 }
 // As in NSIS's upgrade path, pin an external uninstaller copy and use _?=
 // so its result is observed directly instead of an asynchronous launcher.
 // A browser launcher can exit before its Chromium descendants finish. The
 // installer deliberately refuses those live processes; wait for that actual
 // prerequisite rather than treating the launcher receipt as sufficient.
 await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop';$root='${(installed+'\\').replaceAll("'","''")}';$until=[DateTime]::UtcNow.AddSeconds(30);do{$busy=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)});if(-not $busy.Count){Start-Sleep -Milliseconds 500;$again=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)});if(-not $again.Count){exit 0}};Start-Sleep -Milliseconds 250}while([DateTime]::UtcNow -lt $until);throw 'Fixture application processes have not fully exited'`),{timeoutMs:40000});
 const uninstallCopy=path.join(directory,'verified-uninstaller.exe');await copyFile(path.join(installed,uninstaller),uninstallCopy);assert.equal(await fileHash(uninstallCopy),await fileHash(path.join(installed,uninstaller)));
 try{await run(uninstallCopy,['/S','/currentuser','_?='+installed],{timeoutMs:180000});}catch(error){
  const handle=path.resolve('.mu-data/tools/sysinternals-handle/handle64.exe');try{await access(handle);const report=path.join(directory,'open-handles-at-failure.txt'),body=`$ErrorActionPreference='Stop';$sig=Get-AuthenticodeSignature -LiteralPath '${handle.replaceAll("'","''")}';if($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notlike '*Microsoft Corporation*'){throw 'Diagnostic signature rejected'};& '${handle.replaceAll("'","''")}' -accepteula -nobanner -a '${installed.replaceAll("'","''")}' | Out-File -LiteralPath '${report.replaceAll("'","''")}' -Encoding utf8`,encoded=Buffer.from(body,'utf16le').toString('base64');await run(powershellPath(),powershellArgs(`$p=Start-Process -FilePath '${powershellPath().replaceAll("'","''")}' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Verb RunAs -WindowStyle Hidden -Wait -PassThru;if($p.ExitCode -ne 0){throw 'Read-only handle inspection failed'}`),{timeoutMs:30000});}catch{}throw error;
 }
 const until=Date.now()+30000;for(;;){try{await access(executable);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw error;}assert.ok(Date.now()<until,'Uninstaller cleanup did not finish');await delay(100);}
 assert.equal((await registrations()).length,0);assert.equal(JSON.parse(await readFile(marker,'utf8')).synthetic,true);assert.deepEqual((await readdir(directory,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name),['user-data'],'Application and sibling removal staging must be gone');pass('Uninstall removes its application registration and executable while retaining user data');complete=true;
}finally{const sourceChangedDuringTest=JSON.stringify(sourceHashes)!==JSON.stringify(await hashes());await writeFile(path.join(directory,'results.json'),JSON.stringify({scope:'windows-user-installer',installerSha256:await fileHash(installer),sourceHashes,sourceChangedDuringTest,results,complete:complete&&!sourceChangedDuringTest,aiWebsitesVisited:0},null,2));if(sourceChangedDuringTest)throw Error('Installer acceptance source changed during the experiment');}
console.log(JSON.stringify({passed:results.length,complete}));
