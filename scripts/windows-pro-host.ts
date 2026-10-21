import assert from 'node:assert/strict';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,copyFile,cp,access} from 'node:fs/promises';
import {run} from '../server/process.ts';
import {fileHash,powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
import {secureWindowsDirectory} from '../server/platform/windows/credentials.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';

const root=windowsRuntimeDirectory(),resume=process.argv.indexOf('--resume'),continuing=process.argv.indexOf('--continue-boot'),resumingBoot=process.argv.indexOf('--resume-boot'),selected=Math.max(resume,continuing,resumingBoot),directory=selected<0?path.join(root,'pro-host-'+randomUUID()):path.resolve(process.argv[selected+1]);
assert.equal(path.dirname(directory),path.resolve(root));assert.match(path.basename(directory),/^pro-host-[a-f0-9-]{36}$/);
const seed=path.join(directory,'guest-seed'),configFile=path.join(directory,'config.json');
const sources=['scripts/windows-pro-host.ts','scripts/windows/create-pro-host.ps1','scripts/windows/start-pro-host.ps1','scripts/windows/pro-host-bootstrap.ps1','scripts/windows/pro-host-boot-media.ps1','native/windows/PacketLabGuard.cs'];
const sourceHashes=async()=>Object.fromEntries(await Promise.all(sources.map(async file=>[file,await fileHash(file)])));
let config:any;
if(continuing>=0||resumingBoot>=0){
 config=JSON.parse(await readFile(configFile,'utf8'));
 const state=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));assert.ok(['failed','pro-image-prepared'].includes(state.phase));if(resumingBoot<0)await assert.rejects(access(path.join(directory,'machine.json')),{code:'ENOENT'});else await access(path.join(directory,'machine.json'));
 const boot=JSON.parse(await readFile(path.join(directory,'boot-inputs.json'),'utf8'));assert.equal(boot.nonce,config.nonce);assert.equal(await fileHash(boot.iso),boot.isoSha256);
 assert.equal(await fileHash(path.join(seed,'bootstrap.ps1')),await fileHash('scripts/windows/pro-host-bootstrap.ps1'));
 for(const name of ['private/credentials.json','private/deployment.json'])config.stagedHashes[name]=await fileHash(path.join(seed,name));
 config.creationSourceHashes??=config.sourceHashes;config.sourceHashes=await sourceHashes();
}else if(resume>=0){
 config=JSON.parse(await readFile(configFile,'utf8'));assert.deepEqual(await sourceHashes(),config.sourceHashes);
 for(const file of ['state.json','machine.json'])await assert.rejects(access(path.join(directory,file)),{code:'ENOENT'},'An attempted Pro deployment must be inspected, not recreated');
 for(const [name,digest] of Object.entries(config.stagedHashes))assert.equal(await fileHash(path.join(seed,name)),digest);
}else{
 await secureWindowsDirectory(directory);await mkdir(path.join(seed,'private'),{recursive:true});await mkdir(path.join(seed,'public'));
 const media=JSON.parse(await readFile('.mu-data/windows-pro-assets/verified-iso.json','utf8'));
 assert.equal(media.imageSha256,'b795b52d598bf8fdea5975844731f4a50c5713876cefc513884354272b023af0');assert.equal(await fileHash(media.image),media.imageSha256);
 const packages=JSON.parse(await readFile('.mu-data/windows-run/desktop-package.json','utf8')),product=path.resolve(packages.output,'win-unpacked');
 assert.equal(path.dirname(path.resolve(packages.output)),path.resolve('release'));assert.match(path.basename(path.dirname(product)),/^windows-preview-[a-f0-9-]{36}$/);
 console.log('Staging verified Pro media, the current Windows package and a blank Linux base. No existing VM is changed.');
 await cp(product,path.join(seed,'product'),{recursive:true,errorOnExist:true,force:false});
 await mkdir(path.join(seed,'installers'));const installer=packages.artifacts.find((file:string)=>file.endsWith('.exe'));assert.ok(installer);await copyFile(installer,path.join(seed,'installers/preview.exe'));
 await copyFile('scripts/windows/clean-host-client.mjs',path.join(seed,'client.mjs'));
 await copyFile('scripts/windows/pro-host-bootstrap.ps1',path.join(seed,'bootstrap.ps1'));
 const base=JSON.parse(await readFile('.mu-data/windows-runtime/protected-desktop-base.json','utf8'));
 assert.equal(base.imageSha256,'e8e417e029281d7e250212ee67cb2b32e6bf89960f1b432df9a629de529eefbb');assert.equal(await fileHash(base.image),base.imageSha256);
 await mkdir(path.join(seed,'images'));await copyFile(base.image,path.join(seed,'images/nested-base.vhdx'));
 await writeFile(path.join(seed,'images/base.json'),JSON.stringify({image:'C:/MuLab/images/nested-base.vhdx',imageSha256:base.imageSha256}));
 const adminPassword='Mu!a9'+randomBytes(24).toString('base64url'),userPassword='Mu!u9'+randomBytes(24).toString('base64url'),nonce=randomBytes(32).toString('hex');
 await writeFile(path.join(seed,'private/credentials.json'),JSON.stringify({adminUser:'MuLabAdmin',adminPassword,user:'MuLabUser',userPassword}));
 await writeFile(path.join(seed,'private/deployment.json'),JSON.stringify({flavor:'pro26300',nonce}));
 const header=(name:string)=>'<component name="'+name+'" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">';
 const xml=[
  '<?xml version="1.0" encoding="utf-8"?><unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">',
  '<settings pass="specialize">',
  header('Microsoft-Windows-Shell-Setup')+'<ComputerName>MU-PRO-LAB</ComputerName><TimeZone>UTC</TimeZone></component>',
  header('Microsoft-Windows-Deployment')+'<RunSynchronous><RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>powershell.exe -NoProfile -NonInteractive -Command &quot;&amp; ([ScriptBlock]::Create([IO.File]::ReadAllText(\'C:\\MuLab\\bootstrap.ps1\')))&quot;</Path><Description>Prepare synthetic local Pro diagnostic accounts</Description></RunSynchronousCommand></RunSynchronous></component>',
  '</settings><settings pass="oobeSystem">',
  header('Microsoft-Windows-International-Core')+'<InputLocale>zh-CN</InputLocale><SystemLocale>zh-CN</SystemLocale><UILanguage>zh-CN</UILanguage><UserLocale>zh-CN</UserLocale></component>',
  header('Microsoft-Windows-Shell-Setup')+'<AutoLogon><Password><Value>'+userPassword+'</Value><PlainText>true</PlainText></Password><Domain>MU-PRO-LAB</Domain><Username>MuLabUser</Username><Enabled>true</Enabled><LogonCount>3</LogonCount></AutoLogon><OOBE><HideEULAPage>true</HideEULAPage><HideOEMRegistrationScreen>true</HideOEMRegistrationScreen><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC></OOBE><TimeZone>UTC</TimeZone></component>',
  '</settings></unattend>'
 ].join('\n');await writeFile(path.join(directory,'unattend.xml'),xml);
 const stagedHashes=Object.fromEntries(await Promise.all(['client.mjs','bootstrap.ps1','private/credentials.json','private/deployment.json','images/nested-base.vhdx','images/base.json','installers/preview.exe','product/resources/node/node.exe','product/resources/app/dist-server/server/platform/windows/broker.js'].map(async file=>[file,await fileHash(path.join(seed,file))])));
 config={format:1,flavor:'pro26300',name:'mu-win-pro-'+randomUUID().replaceAll('-',''),nonce,image:media.image,imageSha256:media.imageSha256,imageIndex:4,edition:'Professional',virtualSizeGiB:160,sourceHashes:await sourceHashes(),stagedHashes,unattendSha256:await fileHash(path.join(directory,'unattend.xml'))};
}
config.ownerPid=process.pid;await writeFile(configFile,JSON.stringify(config,null,2));
await writeFile('.mu-data/windows-run/pro-host-lab.json',JSON.stringify({directory,name:config.name,config:configFile},null,2));
if(process.argv.includes('--stage-only'))console.log('Pro deployment inputs staged; no VM or virtual disk created.');
else{
 const script=path.resolve(continuing>=0||resumingBoot>=0?'scripts/windows/start-pro-host.ps1':'scripts/windows/create-pro-host.ps1'),body="& '"+script.replaceAll("'","''")+"' -ConfigPath '"+configFile.replaceAll("'","''")+"' -OwnerPid "+process.pid+(resumingBoot>=0?' -ResumeBoot':''),encoded=Buffer.from(body,'utf16le').toString('base64');
 await run(powershellPath(),powershellArgs("$ErrorActionPreference='Stop';$p=Start-Process -FilePath '"+powershellPath()+"' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','"+encoded+"') -WorkingDirectory '"+directory.replaceAll("'","''")+"' -Verb RunAs -WindowStyle Hidden -Wait -PassThru;if($p.ExitCode -ne 0){throw 'Pro deployment failed; inspect the retained dedicated fixture before retrying'}"),{timeoutMs:2700000,onOutput:value=>process.stdout.write(value)});
 console.log(continuing>=0||resumingBoot>=0?'The isolated Pro VM has booted from its own disk; readiness still requires a separate probe.':'The Pro disk is prepared. Inspect its layout, prepare ordinary-user boot media, then continue boot.');
}
