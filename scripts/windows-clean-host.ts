import {randomUUID,randomBytes} from 'node:crypto';import {mkdir,readFile,writeFile,copyFile,cp,access} from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {run} from '../server/process.ts';import {powershellPath,powershellArgs,fileHash} from '../server/platform/windows/runtime.ts';import {secureWindowsDirectory} from '../server/platform/windows/credentials.ts';import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
async function main(){
const root=windowsRuntimeDirectory(),resume=process.argv.indexOf('--resume'),directory=resume>=0?path.resolve(process.argv[resume+1]):path.join(root,'clean-host-'+randomUUID()),seed=path.join(directory,'guest-seed');
assert.equal(path.dirname(directory),path.resolve(root));assert.match(path.basename(directory),/^clean-host-[a-f0-9-]{36}$/);let name:string;
if(resume>=0){
 const staged=JSON.parse(await readFile(path.join(directory,'staged.json'),'utf8'));name=staged.name;assert.match(name,/^mu-win-clean-[a-f0-9]{32}$/);
 for(const file of ['state.json','machine.json'])await assert.rejects(access(path.join(directory,file)),{code:'ENOENT'},'An attempted deployment must be inspected rather than recreated');
 assert.equal(await fileHash(path.join(seed,'client.mjs')),staged.clientSha256);assert.equal(staged.clientSha256,await fileHash('scripts/windows/clean-host-client.mjs'));
 const pkg=JSON.parse(await readFile(path.join(seed,'private/package.json'),'utf8'));
 for(const [file,digest] of [['resources/node/node.exe',pkg.nodeSha256],['resources/app/dist-server/scripts/windows/host-components.ps1',pkg.hostScriptSha256],['resources/app/dist-server/server/platform/windows/broker.js',pkg.brokerSha256],['resources/app/dist-server/server/platform/windows/runtime.js',pkg.runtimeSha256]])assert.equal(await fileHash(path.join(seed,'product',file)),digest);
 assert.equal(await fileHash(path.join(seed,'images/nested-base.vhdx')),staged.baseSha256);
}else{
await secureWindowsDirectory(directory);name='mu-win-clean-'+randomUUID().replaceAll('-','');
const adminPassword='Mu!a9'+randomBytes(24).toString('base64url'),userPassword='Mu!u9'+randomBytes(24).toString('base64url');await mkdir(path.join(seed,'private'),{recursive:true});await mkdir(path.join(seed,'public'));
const packaged=JSON.parse(await readFile('.mu-data/windows-run/desktop-package.json','utf8')),product=path.resolve(packaged.output,'win-unpacked');
assert.equal(path.dirname(path.resolve(packaged.output)),path.resolve('release'));assert.match(path.basename(path.dirname(product)),/^windows-preview-[a-f0-9-]{36}$/);
console.log('Staging the local Windows preview and diagnostic client.');
await cp(product,path.join(seed,'product'),{recursive:true,errorOnExist:true,force:false});
await copyFile('scripts/windows/clean-host-client.mjs',path.join(seed,'client.mjs'));
const nestedBase=JSON.parse(await readFile('.mu-data/windows-runtime/protected-desktop-base.json','utf8'));
assert.equal(nestedBase.imageSha256,'e8e417e029281d7e250212ee67cb2b32e6bf89960f1b432df9a629de529eefbb');assert.equal(await fileHash(nestedBase.image),nestedBase.imageSha256);
await mkdir(path.join(seed,'images'));await copyFile(nestedBase.image,path.join(seed,'images/nested-base.vhdx'));
await writeFile(path.join(seed,'images/base.json'),JSON.stringify({image:'C:/MuLab/images/nested-base.vhdx',imageSha256:nestedBase.imageSha256}));
await writeFile(path.join(seed,'private/package.json'),JSON.stringify({sourceDirectory:product,nodeSha256:await fileHash(path.join(product,'resources/node/node.exe')),hostScriptSha256:await fileHash(path.join(product,'resources/app/dist-server/scripts/windows/host-components.ps1')),brokerSha256:await fileHash(path.join(product,'resources/app/dist-server/server/platform/windows/broker.js')),runtimeSha256:await fileHash(path.join(product,'resources/app/dist-server/server/platform/windows/runtime.js'))}));
await writeFile(path.join(seed,'private/credentials.json'),JSON.stringify({adminUser:'MuLabAdmin',adminPassword,user:'MuLabUser',userPassword}));
await writeFile(path.join(seed,'bootstrap.ps1'),`$ErrorActionPreference='Stop'
$c=Get-Content -LiteralPath C:\\MuLab\\private\\credentials.json -Raw | ConvertFrom-Json
foreach($pair in @(@($c.adminUser,$c.adminPassword),@($c.user,$c.userPassword))){if(-not (Get-LocalUser -Name $pair[0] -ErrorAction SilentlyContinue)){New-LocalUser -Name $pair[0] -Password (ConvertTo-SecureString $pair[1] -AsPlainText -Force) -PasswordNeverExpires | Out-Null}}
foreach($name in @($c.adminUser,$c.user)){Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $name -ErrorAction SilentlyContinue}
Add-LocalGroupMember -SID 'S-1-5-32-544' -Member $c.adminUser -ErrorAction SilentlyContinue
$sid=(Get-LocalUser -Name $c.user).SID;$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
foreach($value in @($sid.Value,'S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($value),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
[IO.Directory]::SetAccessControl('C:\\MuLab\\public',$acl)
[IO.File]::WriteAllText('C:\\MuLab\\public\\provisioned.json','{"localSyntheticAccounts":true,"networkRequired":false}')
`);
const xml=`<?xml version="1.0" encoding="utf-8"?><unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><settings pass="specialize"><component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><ComputerName>MU-CLEAN-LAB</ComputerName><TimeZone>UTC</TimeZone></component></settings><settings pass="oobeSystem"><component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><Reseal><Mode>Audit</Mode><ForceShutdownNow>false</ForceShutdownNow></Reseal></component></settings><settings pass="auditSystem"><component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><UserAccounts><AdministratorPassword><Value>${adminPassword}</Value><PlainText>true</PlainText></AdministratorPassword></UserAccounts><AutoLogon><Username>Administrator</Username><Password><Value>${adminPassword}</Value><PlainText>true</PlainText></Password><Enabled>true</Enabled><LogonCount>3</LogonCount></AutoLogon></component></settings><settings pass="auditUser"><component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><RunSynchronous><RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>powershell.exe -NoProfile -NonInteractive -Command &quot;&amp; ([ScriptBlock]::Create([IO.File]::ReadAllText('C:\\MuLab\\bootstrap.ps1')))&quot;</Path><Description>Prepare synthetic local diagnostic accounts</Description></RunSynchronousCommand></RunSynchronous></component></settings></unattend>`;
await writeFile(path.join(directory,'unattend.xml'),xml);
assert.equal(await fileHash(path.join(seed,'images/nested-base.vhdx')),nestedBase.imageSha256);
await writeFile(path.join(directory,'staged.json'),JSON.stringify({name,clientSha256:await fileHash(path.join(seed,'client.mjs')),baseSha256:nestedBase.imageSha256},null,2));
}
const config=path.join(directory,'config.json');await writeFile('.mu-data/windows-run/clean-host-lab.json',JSON.stringify({directory,name,config},null,2));
if(process.argv.includes('--stage-only')){console.log('Clean-host inputs staged. No VM or virtual disk has been created.');return;}
const image=JSON.parse(await readFile('.mu-data/windows-clean-host-assets/verified-iso.json','utf8'));assert.equal(image.imageSha256,'2cee70bd183df42b92a2e0da08cc2bb7a2a9ce3a3841955a012c0f77aeb3cb29');assert.equal(await fileHash(image.image),image.imageSha256);
await writeFile(config,JSON.stringify({...image,ownerPid:process.pid,name},null,2));
const body=`& '${path.resolve('scripts/windows/create-clean-host.ps1').replaceAll("'","''")}' -ConfigPath '${config.replaceAll("'","''")}'`,encoded=Buffer.from(body,'utf16le').toString('base64');
console.log('Applying verified Windows only to a fresh protected diagnostic VHDX.');
await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop';$p=Start-Process -FilePath '${powershellPath()}' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -WorkingDirectory '${directory.replaceAll("'","''")}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru;if($p.ExitCode -ne 0){throw 'Clean Windows VM creation failed; inspect the private fixture state'}`),{timeoutMs:1800000,onOutput:value=>process.stdout.write(value)});
console.log('Windows image prepared. Use the pe-boot probe to prepare boot files inside the disconnected VM.');
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Clean-host preparation failed');process.exitCode=1;});
