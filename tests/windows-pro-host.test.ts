import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm,open} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {run} from '../server/process.ts';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
import {secureWindowsDirectory} from '../server/platform/windows/credentials.ts';

const windows={skip:process.platform!=='win32'};
test('Volume pressure requests reject wrong owners, identities, actions and caller-selected paths before servicing',windows,async()=>{
 const source=path.resolve('scripts/windows/pro-volume-operator.ps1');
 const script=`$ErrorActionPreference='Stop';$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:MU_VOLUME_SOURCE,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Volume operator syntax error'};$definition=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-ProVolumeRequest'},$true);. ([ScriptBlock]::Create($definition.Extent.Text));$owner=[pscustomobject]@{caseId=('a'*32);nonce=('b'*64);pid=42};foreach($kind in @('valid','case','nonce','pid','phase','action','id','platform','request','extra')){$request=[pscustomobject]@{caseId=$owner.caseId;nonce=$owner.nonce;ownerPid=42;phase='run';action='hold-work';id='12345678-1234-4234-8234-123456789012';platformId='22345678-1234-4234-8234-123456789012';requestId='32345678-1234-4234-8234-123456789012'};switch($kind){case{$request.caseId='c'*32}nonce{$request.nonce='d'*64}pid{$request.ownerPid=43}phase{$request.phase='recover'}action{$request.action='format'}id{$request.id='../outside'}platform{$request.platformId='00000000-0000-0000-0000-000000000000'}request{$request.requestId='{32345678-1234-4234-8234-123456789012}'}extra{$request|Add-Member -NotePropertyName path -NotePropertyValue 'C:\\outside'}};$accepted=$true;try{Assert-ProVolumeRequest $request $owner}catch{$accepted=$false};if($accepted -ne ($kind -eq 'valid')){throw ('Unsafe volume request boundary: '+$kind)}}`;
 await run(powershellPath(),powershellArgs(script),{env:{...process.env,MU_VOLUME_SOURCE:source},timeoutMs:15000});
});
async function ownerFixture(){
 const root=path.resolve('.mu-data','windows-pro-guard-'+randomUUID());await secureWindowsDirectory(root);await mkdir(path.join(root,'guest-seed/nested'),{recursive:true});await writeFile(path.join(root,'guest-seed/nested/retained.bin'),'synthetic original input');
 const prefix="$ErrorActionPreference='Stop';Add-Type -Path $env:MU_PRO_GUARD_SOURCE;$guard=[MuPacketLabGuard]::new([int]$env:MU_PRO_OWNER,$env:MU_PRO_ROOT);";
 return {root,run:(script:string)=>run(powershellPath(),powershellArgs(prefix+script),{env:{...process.env,MU_PRO_GUARD_SOURCE:path.resolve('native/windows/PacketLabGuard.cs'),MU_PRO_OWNER:String(process.pid),MU_PRO_ROOT:root},timeoutMs:20000}),cleanup:async()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve('.mu-data'));await rm(root,{recursive:true,force:true});}};
}
test('Pro deployment copies regular owner inputs and rejects a seed junction without following it',windows,async()=>{
 const f=await ownerFixture();try{
  await f.run("try{$guard.CopyGuestSeed((Join-Path $env:MU_PRO_ROOT 'copied'));$outside=Join-Path $env:MU_PRO_ROOT 'outside';New-Item -ItemType Directory -Path $outside|Out-Null;[IO.File]::WriteAllText((Join-Path $outside 'must-not-copy.bin'),'outside tree');$link=Join-Path $env:MU_PRO_ROOT 'guest-seed/redirect';New-Item -ItemType Junction -Path $link -Target $outside|Out-Null;$rejected=$false;try{$guard.CopyGuestSeed((Join-Path $env:MU_PRO_ROOT 'rejected'))}catch{$rejected=$true};if(-not $rejected){throw 'Seed junction was followed'};if(Test-Path -LiteralPath (Join-Path $env:MU_PRO_ROOT 'rejected/redirect/must-not-copy.bin')){throw 'Outside input copied'}}finally{$guard.Dispose()}");
  assert.equal(await readFile(path.join(f.root,'copied/nested/retained.bin'),'utf8'),'synthetic original input');assert.equal(await readFile(path.join(f.root,'outside/must-not-copy.bin'),'utf8'),'outside tree');
 }finally{await f.cleanup();}
});
test('A pinned Pro input cannot be replaced until its ordinary-owner guard is disposed',windows,async()=>{
 const f=await ownerFixture();try{
  await f.run("$source=Join-Path $env:MU_PRO_ROOT 'guest-seed/nested/retained.bin';$destination=$source+'.moved';try{$guard.PinInputFile($source);$rejected=$false;try{[IO.File]::Move($source,$destination)}catch{$rejected=$true};if(-not $rejected){throw 'Pinned input replaced'}}finally{$guard.Dispose()};[IO.File]::Move($source,$destination)");
  assert.equal(await readFile(path.join(f.root,'guest-seed/nested/retained.bin.moved'),'utf8'),'synthetic original input');
 }finally{await f.cleanup();}
});
test('Pro credential inputs are bounded owner reads and reject a redirected private directory',windows,async()=>{
 const f=await ownerFixture();try{
  await mkdir(path.join(f.root,'guest-seed/private'));await writeFile(path.join(f.root,'guest-seed/private/credentials.json'),'{"user":"synthetic"}');
  assert.equal((await f.run("try{[Console]::Write($guard.ReadGuestCredentials())}finally{$guard.Dispose()}")).trim(),'{"user":"synthetic"}');
  await f.run("try{$private=Join-Path $env:MU_PRO_ROOT 'guest-seed/private';$outside=Join-Path $env:MU_PRO_ROOT 'saved-private';[IO.Directory]::Move($private,$outside);New-Item -ItemType Junction -Path $private -Target $outside|Out-Null;$rejected=$false;try{$null=$guard.ReadGuestCredentials()}catch{$rejected=$true};if(-not $rejected){throw 'Redirected credentials were accepted'}}finally{$guard.Dispose()}");
 }finally{await f.cleanup();}
});
test('Pro deployment rejects host disks, parent disks and any mismatched fresh VHD identity',windows,async()=>{
 const source=path.resolve('scripts/windows/create-pro-host.ps1');
 await run(powershellPath(),powershellArgs("$ErrorActionPreference='Stop';$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:MU_PRO_SOURCE,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Pro source syntax error'};$function=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-DiagnosticDisk'},$true);if(-not $function){throw 'Pro disk guard missing'};. ([ScriptBlock]::Create($function.Extent.Text));$disk=[pscustomobject]@{Number=12345};$diskFile='X:\\synthetic-pro\\windows.vhdx';$script:kind='valid';function Get-VHD{[CmdletBinding()]param([int]$DiskNumber)if($DiskNumber -ne 12345){throw 'Wrong disk'};if($script:kind -eq 'physical'){throw 'Not a VHD'};[pscustomobject]@{Path=$(if($script:kind -eq 'other'){'X:\\other\\windows.vhdx'}else{$diskFile});ParentPath=$(if($script:kind -eq 'parent'){'X:\\parent.vhdx'}else{''})}};function Get-Disk{[CmdletBinding()]param([int]$Number)if($Number -ne 12345){throw 'Wrong disk'};[pscustomobject]@{IsBoot=($script:kind -eq 'boot');IsSystem=($script:kind -eq 'system');Size=$(if($script:kind -eq 'size'){96GB}else{160GB})}};Assert-DiagnosticDisk;foreach($kind in @('physical','other','parent','boot','system','size')){$script:kind=$kind;$rejected=$false;try{Assert-DiagnosticDisk}catch{$rejected=$true};if(-not $rejected){throw ('Invalid Pro disk accepted: '+$kind)}}"),{env:{...process.env,MU_PRO_SOURCE:source},timeoutMs:15000});
});
test('Derived EFI media preserves MICROSOFT in its primary ISO directory rather than an 8.3 alias',windows,async()=>{
 const root=path.resolve('.mu-data','windows-pro-guard-'+randomUUID()),tree=path.join(root,'media'),destination=path.join(root,'boot.iso');
 await secureWindowsDirectory(root);await mkdir(path.join(tree,'efi/microsoft/boot'),{recursive:true});await writeFile(path.join(tree,'efi/microsoft/boot/efisys_noprompt.bin'),Buffer.alloc(2048));await writeFile(path.join(tree,'efi/microsoft/boot/bcd'),'synthetic BCD layout fixture');
 try{
  await run(powershellPath(),powershellArgs(". ([ScriptBlock]::Create([IO.File]::ReadAllText($env:MU_PRO_MEDIA_SOURCE)));New-ProBootIso $env:MU_PRO_MEDIA_TREE $env:MU_PRO_MEDIA_DEST"),{env:{...process.env,MU_PRO_MEDIA_SOURCE:path.resolve('scripts/windows/pro-host-boot-media.ps1'),MU_PRO_MEDIA_TREE:tree,MU_PRO_MEDIA_DEST:destination},timeoutMs:30000});
  const stream=await open(destination,'r');try{
   const block=async(lba:number,size=2048)=>{assert.ok(size>0&&size<65536);const bytes=Buffer.alloc(size);let done=0;while(done<size){const read=await stream.read(bytes,done,size-done,lba*2048+done);assert.ok(read.bytesRead);done+=read.bytesRead;}return bytes;};
   const pvd=await block(16);assert.equal(pvd[0],1);assert.equal(pvd.subarray(1,6).toString('ascii'),'CD001');
   const list=async(lba:number,size:number)=>{const bytes=await block(lba,size),entries:{name:string;lba:number;size:number}[]=[];for(let offset=0;offset<bytes.length;){const length=bytes[offset];if(!length){offset=(Math.floor(offset/2048)+1)*2048;continue;}const entry=bytes.subarray(offset,offset+length);entries.push({name:entry.subarray(33,33+entry[32]).toString('ascii'),lba:entry.readUInt32LE(2),size:entry.readUInt32LE(10)});offset+=length;}return entries;};
   const top=await list(pvd.readUInt32LE(158),pvd.readUInt32LE(166)),efi=top.find(entry=>entry.name==='EFI');assert.ok(efi);
   const children=await list(efi.lba,efi.size);assert.ok(children.some(entry=>entry.name==='MICROSOFT'));assert.equal(children.some(entry=>entry.name==='MICROS~1'),false);
  }finally{await stream.close();}
 }finally{assert.equal(path.dirname(root),path.resolve('.mu-data'));await rm(root,{recursive:true,force:true});}
});
test('The exact WinPE marker matcher works without findstr and rejects absent or wrong deployment markers',windows,async()=>{
 const root=path.resolve('.mu-data','windows-pro-guard-'+randomUUID()),updates=path.join(root,'updates'),nonce='a'.repeat(64);
 await secureWindowsDirectory(root);
 try{
  await run(powershellPath(),powershellArgs(". ([ScriptBlock]::Create([IO.File]::ReadAllText($env:MU_PRO_MEDIA_SOURCE)));Write-ProBootStartup $env:MU_PRO_UPDATES $env:MU_PRO_NONCE 2"),{env:{...process.env,MU_PRO_MEDIA_SOURCE:path.resolve('scripts/windows/pro-host-boot-media.ps1'),MU_PRO_UPDATES:updates,MU_PRO_NONCE:nonce},timeoutMs:15000});
  const startup=await readFile(path.join(updates,'MuProBoot/finish.cmd'),'utf8'),label=/^:match_marker\r?$/m.exec(startup);assert.ok(label);
  const check=path.join(root,'marker-check.cmd');await writeFile(check,'@echo off\r\nsetlocal EnableExtensions EnableDelayedExpansion\r\ncall :match_marker "%~1"\r\nexit /b %errorlevel%\r\n'+startup.slice(label.index));
  const valid=path.join(root,'valid marker.json'),wrong=path.join(root,'wrong.json');await writeFile(valid,JSON.stringify({flavor:'pro26300',nonce}));await writeFile(wrong,JSON.stringify({flavor:'pro26300',nonce:'b'.repeat(64)}));
  const command=path.join(process.env.SystemRoot??'C:/Windows','System32/cmd.exe');await run(command,['/d','/c',check,valid]);await assert.rejects(run(command,['/d','/c',check,wrong]),{code:'PROCESS_FAILED'});await assert.rejects(run(command,['/d','/c',check,path.join(root,'absent.json')]),{code:'PROCESS_FAILED'});
 }finally{assert.equal(path.dirname(root),path.resolve('.mu-data'));await rm(root,{recursive:true,force:true});}
});
test('Pro restart reconnect discards an old live session until the guest boot identity changes',windows,async()=>{
 const source=path.resolve('scripts/windows/verify-pro-host.ps1');
 const script="$ErrorActionPreference='Stop';$env:PSModulePath=Join-Path $PSHOME 'Modules';$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:MU_PRO_SOURCE,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Invalid Pro probe'};$definition=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Connect-ProGuest'},$true);. ([ScriptBlock]::Create($definition.Extent.Text));$credentials=[pscustomobject]@{adminUser='synthetic';adminPassword='synthetic-only'};$guard=[pscustomobject]@{Owner=[pscustomobject]@{HasExited=$false}};$script:attempts=0;$script:removed=0;function Assert-ProFixture{[pscustomobject]@{State='Running';Id=[guid]'12345678-1234-4234-8234-123456789012'}};function New-PSSession{[CmdletBinding()]param($VMId,$Credential)$script:attempts++;[pscustomobject]@{Boot=$(if($script:attempts -eq 1){'old-boot'}else{'new-boot'})}};function Invoke-Command{[CmdletBinding()]param($Session,$ScriptBlock)$Session.Boot};function Remove-PSSession{[CmdletBinding()]param([Parameter(Position=0)]$Session)$script:removed++};function Start-Sleep{param($Seconds)};$result=Connect-ProGuest 'old-boot';if($result.Boot -ne 'new-boot' -or $script:attempts -ne 2 -or $script:removed -ne 1){throw 'A prior Windows session was treated as completed restart'}";
 await run(powershellPath(),powershellArgs(script),{env:{...process.env,MU_PRO_SOURCE:source},timeoutMs:15000});
});
