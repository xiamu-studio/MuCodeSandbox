import assert from 'node:assert/strict';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';import {run} from '../server/process.ts';import {secureWindowsDirectory} from '../server/platform/windows/credentials.ts';import {fileHash,powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
const index=JSON.parse(await readFile('.mu-data/windows-run/pro-host-lab.json','utf8')),directory=path.resolve(index.directory);assert.equal(path.dirname(directory),path.resolve(windowsRuntimeDirectory()));assert.match(path.basename(directory),/^pro-host-[a-f0-9-]{36}$/);
const config=JSON.parse(await readFile(path.join(directory,'config.json'),'utf8')),reports=(await readdir(directory)).filter(name=>/^deployment-inspection-[a-f0-9]{32}\.json$/.test(name)).sort();
assert.ok(reports.length);let inspected:any;
for(const name of reports){const r=JSON.parse(await readFile(path.join(directory,name),'utf8'));if(r.complete&&r.nonce===config.nonce&&r.vmRegistered===false&&r.diskSize===160*1024**3)inspected=r;}
assert.ok(inspected);assert.equal(inspected.activeOwnWimMounts.length,0);assert.equal(await fileHash(config.image),config.imageSha256);
const tool=path.resolve('.mu-data/tools/wimlib-1.14.5'),binary=path.join(tool,'wimlib-imagex.exe');
// Local pins of the author's official HTTPS release. No separately
// vendor-published tool checksum is claimed; the tool runs without elevation.
for(const [name,hash] of Object.entries({'archive.zip':'2f446d6fa3866582175f1a22a7be198eeee0aec7aba5b4e04ad25c99eae2d265','wimlib-imagex.exe':'34c0c4165591ad1f592837ed99d08273c58d6ed3fe0ed6360cf34e7b0739b353','libwim-15.dll':'ba853ee1e3fc5f5798581f02e8e066ba07a0a2375f0bf444fe981431fd508495'}))assert.equal(await fileHash(path.join(tool,name)),hash);
const build=path.join(directory,'boot-inputs-'+randomUUID()),tree=path.join(build,'media'),updates=path.join(build,'updates'),iso=path.join(build,'pro-boot.iso');await secureWindowsDirectory(build);await mkdir(tree);
const seven=path.join(process.env.ProgramFiles??'C:/Program Files','7-Zip/7z.exe');
await run(seven,['x','-y','-o'+tree,config.image,'boot/*','efi/*','bootmgr','bootmgr.efi','sources/boot.wim'],{timeoutMs:180000});
const env={...process.env,MU_PRO_BOOT_UPDATES:updates,MU_PRO_BOOT_NONCE:config.nonce,MU_PRO_BOOT_EFI:String(inspected.efiPartition),MU_PRO_BOOT_TREE:tree,MU_PRO_BOOT_ISO:iso};
const definitions=". ([ScriptBlock]::Create([IO.File]::ReadAllText('"+path.resolve('scripts/windows/pro-host-boot-media.ps1').replaceAll("'","''")+"')));";
await run(powershellPath(),powershellArgs(definitions+'Write-ProBootStartup $env:MU_PRO_BOOT_UPDATES $env:MU_PRO_BOOT_NONCE ([int]$env:MU_PRO_BOOT_EFI)'),{env,timeoutMs:30000});
const forward=(value:string)=>value.replaceAll('\\','/'),commands='add "'+forward(path.join(updates,'MuProBoot'))+'" "/MuProBoot"\nadd "'+forward(path.join(updates,'winpeshl.ini'))+'" "/Windows/System32/winpeshl.ini"\n';
await writeFile(path.join(build,'update-commands.txt'),commands);
console.log('Updating a private WinPE copy as an ordinary user; the existing Pro VHDX is unchanged.');
await run(binary,['update',path.join(tree,'sources/boot.wim'),'2','--check'],{input:commands,timeoutMs:600000,maxBytes:1000000});
await run(binary,['verify',path.join(tree,'sources/boot.wim')],{timeoutMs:600000,maxBytes:1000000});
await run(powershellPath(),powershellArgs(definitions+'New-ProBootIso $env:MU_PRO_BOOT_TREE $env:MU_PRO_BOOT_ISO'),{env,timeoutMs:180000});
const result={format:1,nonce:config.nonce,iso,isoSha256:await fileHash(iso),efiPartition:inspected.efiPartition,diskIdentifier:inspected.diskIdentifier,toolSource:'https://wimlib.net/downloads/wimlib-1.14.5-windows-x86_64-bin.zip',vendorPublishedToolChecksum:false,ordinaryUserPreparation:true,startupSourceSha256:await fileHash('scripts/windows/pro-host-boot-media.ps1'),bootWimSha256:await fileHash(path.join(tree,'sources/boot.wim'))};
await writeFile(path.join(directory,'boot-inputs.json'),JSON.stringify(result,null,2));console.log('Derived WinPE media verified. The original Pro ISO and deployed VHDX were preserved.');
