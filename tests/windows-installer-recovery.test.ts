import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,rename,symlink,access} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {run} from '../server/process.ts';
import {powershellArgs,powershellPath} from '../server/platform/windows/runtime.ts';

const windows={skip:process.platform!=='win32'};
const script=path.resolve('desktop/windows/install-transaction.ps1');
const loader="& ([ScriptBlock]::Create([IO.File]::ReadAllText($env:MU_WINDOWS_TRANSACTION_SCRIPT)))";
const old='0.4.66-preview.1',updated='0.4.66-preview.2';
async function app(root:string,version=old){
 await mkdir(path.join(root,'resources/app/dist-server'),{recursive:true});
 const fileVersion=version===old?'0.4.66.1':'0.4.66.2';
 await writeFile(path.join(root,'MuCodeSandbox Windows Preview.exe'),'synthetic exe '+version);
 await writeFile(path.join(root,'resources/app/package.json'),JSON.stringify({name:'mucodesandbox-windows-preview',version}));
 await writeFile(path.join(root,'resources/windows-runtime-manifest.json'),JSON.stringify({format:1,channel:'unsigned-windows-preview',release:{version,fileVersion}}));
 await writeFile(path.join(root,'resources/app/dist-server/windows-release.json'),JSON.stringify({format:1,version,fileVersion}));
}
async function fixture(installed=true){
 const directory=await mkdtemp(path.join(tmpdir(),'mu-installer-recovery-')),root=path.join(directory,'installed'),guid=randomUUID(),data=path.join(directory,'profile.bin');
 await writeFile(data,'independent synthetic encrypted profile');if(installed)await app(root);
 const owner=spawn(process.execPath,['-e',"console.log('ready');setInterval(()=>{},1000)"],{windowsHide:true,stdio:['ignore','pipe','ignore']});await once(owner.stdout!,'data');
 const env={...process.env,MU_WINDOWS_TRANSACTION_SCRIPT:script,MU_WINDOWS_INSTALL_ROOT:root,MU_WINDOWS_APP_GUID:guid,MU_WINDOWS_INSTALL_PID:String(owner.pid),MU_WINDOWS_INSTALL_VERSION:updated};
 const ps=(source:string)=>run(powershellPath(),powershellArgs(source),{env,timeoutMs:30000});
 const register=()=>ps("$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\'+$env:MU_WINDOWS_APP_GUID);$k.SetValue('InstallLocation',$env:MU_WINDOWS_INSTALL_ROOT);$k.Dispose();$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$env:MU_WINDOWS_APP_GUID);$k.SetValue('DisplayVersion','0.4.66-preview.1');$k.Dispose()");
 if(installed)await register();
 const stop=async()=>{if(owner.exitCode===null&&owner.signalCode===null){const exited=once(owner,'exit');owner.kill();await exited;}};
 return {directory,root,guid,env,data,ps,register,stop,journal:root+'.mu-install.json',
  action:(action:string)=>run(powershellPath(),powershellArgs(loader),{env:{...env,MU_WINDOWS_TRANSACTION_ACTION:action},timeoutMs:30000}),
  cleanup:async()=>{await stop();await ps("foreach($k in @(('Software\\'+$env:MU_WINDOWS_APP_GUID), ('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$env:MU_WINDOWS_APP_GUID), ('Software\\MuCodeSandbox\\WindowsPreviewInstaller\\'+$env:MU_WINDOWS_APP_GUID))){[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($k,$false)}");assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));await rm(directory,{recursive:true,force:true});}
 };
}
test('Installer recovery restores removed application bytes and registration while retaining a partial replacement',windows,async()=>{
 const f=await fixture();try{
  await writeFile(path.join(f.root,'retained-extension.bin'),'original extension');
  await f.action('prepare');const record=JSON.parse(await readFile(f.journal,'utf8'));assert.equal(record.state,'prepared');
  await f.stop();await rename(f.root,path.join(f.directory,'removed-old'));await app(f.root,updated);await writeFile(path.join(f.root,'new-file.bin'),'partial new bytes');
  await f.ps("[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('Software\\'+$env:MU_WINDOWS_APP_GUID,$false)");
  await f.action('recover');assert.equal(await readFile(path.join(f.root,'MuCodeSandbox Windows Preview.exe'),'utf8'),'synthetic exe '+old);assert.equal(await readFile(path.join(f.root,'retained-extension.bin'),'utf8'),'original extension');
  const partial=f.root+'.mu-incomplete-'+record.nonce;assert.equal(await readFile(path.join(partial,'new-file.bin'),'utf8'),'partial new bytes');
  assert.equal((await f.ps("[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\'+$env:MU_WINDOWS_APP_GUID).GetValue('InstallLocation')")).trim(),f.root);
  assert.equal(await readFile(f.data,'utf8'),'independent synthetic encrypted profile');await assert.rejects(access(f.journal));
 }finally{await f.cleanup();}
});
test('A live installer or live backup writer prevents another recovery attempt',windows,async()=>{
 const f=await fixture();try{await f.action('prepare');await assert.rejects(f.action('recover'),/Another installation is still active/);await f.stop();
  const original=await readFile(f.journal,'utf8');const record=JSON.parse(original);
  const ticks=(await f.ps("(Get-Process -Id "+process.pid+").StartTime.ToUniversalTime().Ticks.ToString()")).trim();
  record.writer={id:process.pid,ticks};await writeFile(f.journal,JSON.stringify(record));await assert.rejects(f.action('recover'),/Another installation is still active/);
  await writeFile(f.journal,original);await f.action('recover');assert.equal((await readdir(f.directory)).some(name=>name.includes('mu-backup')),false);
 }finally{await f.cleanup();}
});
test('A changed recovery backup refuses all restoration and preserves the partial application',windows,async()=>{
 const f=await fixture();try{await f.action('prepare');await f.stop();const record=JSON.parse(await readFile(f.journal,'utf8'));await writeFile(path.join(f.root,'MuCodeSandbox Windows Preview.exe'),'partial replacement');await writeFile(path.join(f.root+'.mu-backup-'+record.nonce,'unexpected.bin'),'changed backup');await assert.rejects(f.action('recover'),/backup incomplete or changed/);assert.equal(await readFile(path.join(f.root,'MuCodeSandbox Windows Preview.exe'),'utf8'),'partial replacement');await access(f.journal);}finally{await f.cleanup();}
});
test('A copying interruption retains the unchanged original and quarantines its incomplete backup',windows,async()=>{
 const f=await fixture();try{await f.action('prepare');await f.stop();const record=JSON.parse(await readFile(f.journal,'utf8'));record.state='copying';await writeFile(f.journal,JSON.stringify(record));const backup=f.root+'.mu-backup-'+record.nonce;await writeFile(path.join(backup,'MuCodeSandbox Windows Preview.exe'),'partial copy');await f.action('recover');assert.equal(await readFile(path.join(f.root,'MuCodeSandbox Windows Preview.exe'),'utf8'),'synthetic exe '+old);await access(backup+'.mu-incomplete-'+record.nonce);}finally{await f.cleanup();}
});
test('Fresh installation interruption retains partial files and removes only its own partial registration',windows,async()=>{
 const f=await fixture(false);try{await f.action('prepare');await f.stop();await app(f.root,updated);await f.register();await f.action('recover');await assert.rejects(access(f.root));assert.equal((await readdir(f.directory)).filter(name=>name.startsWith('installed.mu-incomplete-')).length,1);assert.equal((await f.ps("Test-Path -LiteralPath ('HKCU:\\Software\\'+$env:MU_WINDOWS_APP_GUID)")).trim(),'False');}finally{await f.cleanup();}
});
test('Relocating an installation backs up and restores both distinct application roots',windows,async()=>{
 const f=await fixture();try{const registered=f.root;f.env.MU_WINDOWS_INSTALL_ROOT=path.join(f.directory,'new-location');await app(f.env.MU_WINDOWS_INSTALL_ROOT);await f.action('prepare');await f.stop();await writeFile(path.join(registered,'MuCodeSandbox Windows Preview.exe'),'old path removed');await writeFile(path.join(f.env.MU_WINDOWS_INSTALL_ROOT,'MuCodeSandbox Windows Preview.exe'),'new path partial');await f.action('recover');for(const root of [registered,f.env.MU_WINDOWS_INSTALL_ROOT])assert.equal(await readFile(path.join(root,'MuCodeSandbox Windows Preview.exe'),'utf8'),'synthetic exe '+old);}finally{await f.cleanup();}
});
test('Commit requires consistent installed metadata before discarding verified old application copies',windows,async()=>{
 const f=await fixture();try{await f.action('prepare');await assert.rejects(f.action('commit'),/Installed release/);await app(f.root,updated);await f.action('commit');await assert.rejects(access(f.journal));assert.equal((await readdir(f.directory)).some(name=>name.includes('mu-backup')),false);assert.equal(await readFile(f.data,'utf8'),'independent synthetic encrypted profile');}finally{await f.cleanup();}
});
test('A retry after committed cleanup interruption keeps the completed release and retains an altered leftover backup',windows,async()=>{
 const f=await fixture();try{await f.action('prepare');await f.stop();const record=JSON.parse(await readFile(f.journal,'utf8'));record.state='committed';await writeFile(f.journal,JSON.stringify(record));await app(f.root,updated);const backup=f.root+'.mu-backup-'+record.nonce;await writeFile(path.join(backup,'unexpected-retained.bin'),'retained cleanup remainder');await f.action('recover');assert.equal(await readFile(path.join(f.root,'MuCodeSandbox Windows Preview.exe'),'utf8'),'synthetic exe '+updated);assert.equal(await readFile(path.join(backup+'.mu-incomplete-'+record.nonce,'unexpected-retained.bin'),'utf8'),'retained cleanup remainder');await assert.rejects(access(f.journal));}finally{await f.cleanup();}
});
test('Installer transactions reject links and changed journal ownership before changing application files',windows,async()=>{
 const f=await fixture();try{const external=path.join(f.directory,'external');await mkdir(external);const link=path.join(f.root,'redirect');await symlink(external,link,'junction');await assert.rejects(f.action('prepare'),/link preserved/);await rm(link);await f.action('prepare');await f.stop();const record=JSON.parse(await readFile(f.journal,'utf8'));record.sid='S-1-0-0';await writeFile(f.journal,JSON.stringify(record));await assert.rejects(f.action('recover'),/Unknown transaction/);assert.equal(await readFile(path.join(f.root,'MuCodeSandbox Windows Preview.exe'),'utf8'),'synthetic exe '+old);}finally{await f.cleanup();}
});
test('A nested registered application directory is rejected before writing a backup or journal',windows,async()=>{
 const f=await fixture();try{f.env.MU_WINDOWS_INSTALL_ROOT=path.join(f.root,'nested');await app(f.env.MU_WINDOWS_INSTALL_ROOT);await assert.rejects(f.action('prepare'),/Nested application roots rejected/);assert.equal((await readdir(f.directory)).some(name=>name.includes('mu-backup')||name.includes('mu-install')),false);assert.equal(await readFile(path.join(f.root,'MuCodeSandbox Windows Preview.exe'),'utf8'),'synthetic exe '+old);}finally{await f.cleanup();}
});
