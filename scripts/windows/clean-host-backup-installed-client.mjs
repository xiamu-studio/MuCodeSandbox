// CLI installation is deliberately distinct from graphical installer acceptance.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {backupProductAcceptance} from 'file:///C:/MuLab/backup-product-client.mjs';
const sha=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const location=value=>value.replace(/^"(.*)"$/,'$1').replaceAll('\\','/').replace(/\/$/,'');
const execute=async(file,args,options={})=>{const child=spawn(file,args,{shell:false,windowsHide:true,...options,stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>error+=bytes);const [code]=await once(child,'exit');assert.equal(code,0,error);return output.trim();};
async function inventory(){const code="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$r=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\e88eb670-5944-5236-81aa-7c1d3da3d6df' -ErrorAction SilentlyContinue;@{elevated=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);present=[bool]$r;version=[string]$r.DisplayVersion;path=[string](Get-ItemProperty 'HKCU:\\Software\\e88eb670-5944-5236-81aa-7c1d3da3d6df' -ErrorAction SilentlyContinue).InstallLocation}|ConvertTo-Json -Compress";return JSON.parse(await execute(process.env.SystemRoot+'/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')]));}
export async function backupInstalledAcceptance(client,nonce,pass,runtime,c,seed){
 assert.equal(process.env.COMPUTERNAME,'MU-CLEAN-LAB');assert.match(nonce,/^[a-f0-9]{64}$/);
 const meta=JSON.parse(await readFile('C:/MuLab/approved/backup-installer.json','utf8'));assert.equal(meta.version,'0.4.66-preview.13');assert.equal(meta.sha256,await sha('C:/MuLab/backup-preview13.exe'));
 const before=await inventory();assert.equal(before.elevated,false);
 const installationNonce=meta.resumeInstallationNonce??nonce;assert.match(installationNonce,/^[a-f0-9]{64}$/);
 const directory='C:/MuLab/public/backup-installed-'+installationNonce,installed=directory+"/程序 O'Brien $ 测试/MuCodeSandbox Windows Preview";
 if(before.present){assert.equal(meta.resumeInstallationPath,installed);assert.equal(location(before.path),installed);assert.equal(before.version,meta.version);}else{assert.equal(meta.resumeInstallationPath,undefined);await mkdir(directory,{recursive:true});await execute('C:/MuLab/backup-preview13.exe',['/S','/currentuser','/D='+installed.replaceAll('/','\\')],{windowsVerbatimArguments:true});}
 const after=await inventory();assert.equal(after.elevated,false);assert.equal(after.present,true);assert.equal(after.version,meta.version);assert.equal(location(after.path),installed);
 const app=installed+'/resources/app';assert.equal(JSON.parse(await readFile(app+'/package.json','utf8')).version,meta.version);assert.equal(JSON.parse(await readFile(app+'/dist-server/windows-release.json','utf8')).version,meta.version);
 assert.equal(await sha(installed+'/resources/node/node.exe'),await sha(process.execPath));
 await writeFile(directory+'/installation.json',JSON.stringify({version:meta.version,installerSha256:meta.sha256,installed,ordinaryUser:true,guiInstallerExercised:false,bundledNodeBytesMatchController:true}));
 pass('The actual preview.13 NSIS CLI installs as an ordinary user into a Unicode and special-character path with consistent registration and bundled Node bytes');
 const result=await backupProductAcceptance(client,nonce,pass,runtime,c,seed,{productRoot:app});
 return {...result,installedApp:app,installedDirectory:installed,installationNonce,installerSha256:meta.sha256,installedProductApiExercised:true,guiInstallerExercised:false,desktopUiExercised:false,installedVersion:meta.version};
}
