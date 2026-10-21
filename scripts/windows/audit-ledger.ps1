#Requires -RunAsAdministrator
[CmdletBinding()]
param([string]$Directory,[int]$OwnerPid)
$ErrorActionPreference='Stop'
$full=[IO.Path]::GetFullPath($Directory);if([IO.Path]::GetFileName($full) -notmatch '^ledger-audit-[a-f0-9-]{36}$'){throw 'Dedicated read-only audit directory required'}
Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs')
$guard=[MuPacketLabGuard]::new($OwnerPid,$full)
try{
 $report=$guard.Reserve('audit.json');$common=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'MuCodeSandbox-HyperVBroker-v1';$root=Join-Path $common ('users/'+$guard.Sid);$bin=Join-Path $common 'bin'
 function Assert-AuditTrust([string]$path,[bool]$public){
  if((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Audit installation reparse point rejected'}
  $acl=Get-Acl -LiteralPath $path;$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;if($owner -notin @('S-1-5-18','S-1-5-32-544')){throw 'Audit installation owner changed'}
  $write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544') -and (-not $public -or ($rule.FileSystemRights -band $write))){throw 'Audit installation permissions changed'}}
 }
 Assert-AuditTrust $common $false;Assert-AuditTrust $bin $true;Assert-AuditTrust (Join-Path $bin 'current.json') $true
 $meta=Get-Content -LiteralPath (Join-Path $bin 'current.json') -Raw | ConvertFrom-Json
 if($meta.brokerFile -notmatch '^hv-broker-[a-f0-9]{16}\.exe$'){throw 'Protected executable filename changed'};$executable=Join-Path $bin $meta.brokerFile;Assert-AuditTrust $executable $true;if((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.brokerSha256){throw 'Protected executable digest changed'}
 $assembly=[Reflection.Assembly]::LoadFile($executable);$type=$assembly.GetType('MuProtectedLedger',$true);$broker=$assembly.GetType('MuHyperVBroker',$true);$flags=[Reflection.BindingFlags]'Static,NonPublic';$validator=$broker.GetMethod('ValidateLedgerFile',$flags)
 $check=[Action[string]]{param($file) $validator.Invoke($null,[object[]]@([string]$file)) | Out-Null};$constructor=$type.GetConstructor([Type[]]@([string],[string],[Action[string]]));$store=$constructor.Invoke([object[]]@([string]$root,[string]$guard.Sid,$check));$read=$type.GetMethod('Read',[Reflection.BindingFlags]'Instance,NonPublic')
 $copies=@();$known=@{}
 foreach($name in @('vms.json','vms.backup.json')){
  $file=Join-Path $root $name;if(-not (Test-Path -LiteralPath $file)){$copies+=@{name=$name;present=$false};continue}
  try{$snapshot=$read.Invoke($store,[object[]]@([string]$file));$snapshotType=$snapshot.GetType();$records=$snapshotType.GetField('Records').GetValue($snapshot);foreach($id in $records.Keys){$known[$id]=$true};$copies+=@{name=$name;present=$true;valid=$true;revision=$snapshotType.GetField('Revision').GetValue($snapshot);records=$records.Count}}
  catch{$copies+=@{name=$name;present=$true;valid=$false;error=$_.Exception.GetBaseException().Message.Replace($root,'[protected store]')}}
 }
 $orphans=@();foreach($entry in @(Get-ChildItem -LiteralPath (Join-Path $root 'vms') -Directory)){if(-not $known.ContainsKey($entry.Name)){$orphans+=$entry.Name}}
 $processes=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($bin+'\',[StringComparison]::OrdinalIgnoreCase)} | Select-Object ProcessId,Name)
 [IO.File]::WriteAllText($report,(@{readOnly=$true;copies=$copies;unregisteredDirectories=$orphans;sourceDigest=$meta.sourceDigest;processes=$processes} | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
}catch{if($report){[IO.File]::WriteAllText($report,(@{readOnly=$true;error=$_.Exception.GetBaseException().Message} | ConvertTo-Json),[Text.UTF8Encoding]::new($false))};throw}finally{$guard.Dispose()}
