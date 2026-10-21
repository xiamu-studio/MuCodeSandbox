[CmdletBinding()]
param([ValidateSet('seed','change','hold','remove-control','ui-seed','ui-change','permissions','reset','collect')][string]$Action,[string]$Nonce)
$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'MU-CLEAN-LAB' -or (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID -ne 'IoTEnterpriseSEval'){throw 'Dedicated evaluation guest required'}
$sid=(Get-LocalUser MuLabUser).SID.Value;$common=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'MuCodeSandbox-HyperVBroker-v1';$root=Join-Path $common ('users/'+$sid);$images=Join-Path $root 'images';$bases=Join-Path $root 'bases'
if($Nonce -notmatch '^[a-f0-9]{64}$'){throw 'Bound test nonce required'}
function Receipt([string]$name,$value){$value.nonce=$Nonce;[IO.File]::WriteAllText(('C:\MuLab\approved\cache-'+$name+'.json'),($value | ConvertTo-Json -Depth 12 -Compress))}
function Dataset {return (Get-Content -LiteralPath C:\MuLab\approved\cache-seed.json -Raw | ConvertFrom-Json)}
function Assert-Control($data){$vm=Get-VM -Id ([guid]$data.controlVm);if($vm.Name -ne $data.controlName -or $vm.Notes -ne ('MuCodeSandbox cache diagnostic '+$data.controlName) -or $vm.State -ne 'Off'){throw 'Synthetic control VM changed'};return $vm}
if($Action -eq 'seed'){
 if(Test-Path -LiteralPath C:\MuLab\approved\cache-seed.json){
  if(Test-Path -LiteralPath C:\MuLab\approved\cache-changed.json){throw 'The prior diagnostic progressed beyond seeding; inspect its current state before continuing'}
  $data=Dataset;$control=Assert-Control $data
  foreach($key in @('current','dependent','unused')){$digest=[string]$data.$key;if($digest -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath (Join-Path $images ($digest+'.vhdx')) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest){throw 'The prepared cache dataset changed'}}
  $drives=@(Get-VMHardDiskDrive -VM $control);if($drives.Count -ne 1 -or [IO.Path]::GetFullPath($drives[0].Path) -ne [IO.Path]::GetFullPath((Join-Path $data.controlDirectory 'replacement.vhdx'))){throw 'The current control disk must not reference the cache parent'}
  $snapshot=@(Get-VMSnapshot -VM $control | Where-Object {[string]$_.Id -eq $data.snapshot});if($snapshot.Count -ne 1){throw 'The prepared snapshot identity changed'}
  $found=$false;foreach($drive in @(Get-VMHardDiskDrive -VMSnapshot $snapshot[0])){$path=[string]$drive.Path;$depth=0;while($path){if(++$depth -gt 32){throw 'Unexpected test parent chain'};if([IO.Path]::GetFullPath($path) -eq [IO.Path]::GetFullPath((Join-Path $images ($data.dependent+'.vhdx')))){$found=$true;break};$path=[string](Get-VHD -Path $path).ParentPath}}
  if(-not $found){throw 'The checkpoint does not retain its actual cached parent'}
  Receipt 'seed' $data;return $data
 }
 $vms=@(Get-VM);if($vms.Count -ne 1 -or $vms[0].Notes -notlike 'MuCodeSandbox Windows preview mu-win-*'){throw 'Only one native synthetic canary VM may exist'}
 $r=Get-Content -LiteralPath (Join-Path $root 'vms.json') -Raw | ConvertFrom-Json;if($r.version -ne 2 -or $r.ownerSid -ne $sid -or @($r.records.PSObject.Properties).Count -ne 1){throw 'One protected canary allocation required'}
 $source='C:\MuLab\images\nested-base.vhdx';$base=Get-Content C:\MuLab\images\base.json -Raw | ConvertFrom-Json;if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $base.imageSha256){throw 'Approved blank base changed'}
 $lock=[IO.File]::Open((Join-Path $common 'import.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{
  [IO.Directory]::CreateDirectory($bases) | Out-Null;$values=@{}
  foreach($name in @('current','dependent','unused')){
   $next='C:\MuLab\private\cache-seed-'+[guid]::NewGuid().ToString('N')+'.vhdx';Convert-VHD -Path $source -DestinationPath $next -VHDType Dynamic -ErrorAction Stop -Confirm:$false;Set-VHD -Path $next -ResetDiskIdentifier -Force -Confirm:$false
   Set-Acl -LiteralPath $next -AclObject (Get-Acl -LiteralPath (Join-Path $images ($base.imageSha256+'.vhdx')))
   $digest=(Get-FileHash -LiteralPath $next -Algorithm SHA256).Hash.ToLowerInvariant();$target=Join-Path $images ($digest+'.vhdx');[IO.File]::Move($next,$target)
   $catalogue=@{ownerSid=$sid;imageSha256=$digest;sourceSha256='c74a7d3b3476ffb2715bfcaf9c216e9dd1d6c7e01bc6d0380b1744518dfae15c';builderId=[guid]::NewGuid().ToString('D');recipe='windows-amd64-desktop-v1'}
   [IO.File]::WriteAllText((Join-Path $bases ($digest+'.json')),($catalogue | ConvertTo-Json -Compress));$values[$name]=$digest
  }
  $parent=Join-Path $images ($values.dependent+'.vhdx');$parentAcl=Get-Acl -LiteralPath $parent
  $name='mu-cache-control-'+[guid]::NewGuid().ToString('N');$directory='C:\MuLab\private\cache-control-'+[guid]::NewGuid().ToString('N');[IO.Directory]::CreateDirectory($directory) | Out-Null
  $child=Join-Path $directory 'child.vhdx';New-VHD -Path $child -ParentPath $parent -Differencing | Out-Null
  $vm=New-VM -Name $name -Generation 1 -MemoryStartupBytes 512MB -VHDPath $child -Path $directory
  Set-VM -VM $vm -Notes ('MuCodeSandbox cache diagnostic '+$name) -AutomaticStartAction Nothing -AutomaticStopAction TurnOff -CheckpointType Standard
  Get-VMNetworkAdapter -VM $vm | Remove-VMNetworkAdapter -Confirm:$false
  $snapshot=Checkpoint-VM -VM $vm -SnapshotName MuCacheReferenceTest -Passthru -Confirm:$false
  $replacement=Join-Path $directory 'replacement.vhdx';New-VHD -Path $replacement -Dynamic -SizeBytes 16GB | Out-Null;Get-VMHardDiskDrive -VM $vm | Set-VMHardDiskDrive -Path $replacement -Confirm:$false
  Set-Acl -LiteralPath $parent -AclObject $parentAcl
  $temp=Join-Path $images ($base.imageSha256+'.vhdx.'+[guid]::NewGuid().ToString('N')+'.next');[IO.File]::WriteAllText($temp,'synthetic interrupted import')
  $values.controlVm=[string]$vm.Id;$values.controlName=$name;$values.controlDirectory=$directory;$values.snapshot=[string]$snapshot.Id;$values.canarySource=$base.imageSha256;$values.parentSha256=(Get-FileHash -LiteralPath $parent -Algorithm SHA256).Hash.ToLowerInvariant();$values.originalSourceSha256=$base.imageSha256;$values.snapshotOnlyReference=$true
  Receipt 'seed' $values;return $values
 }finally{$lock.Dispose()}
}
$data=Dataset
if($Action -eq 'reset'){
 $result=Get-Content C:\MuLab\approved\cache-result.json -Raw | ConvertFrom-Json;$ui=Get-Content C:\MuLab\approved\cache-ui-result.json -Raw | ConvertFrom-Json
 if(-not $result.complete -or -not $ui.complete -or @(Get-VM).Count -or @(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'}).Count){throw 'Only a completed idle diagnostic can archive its receipts'}
 $registry=Get-Content -LiteralPath (Join-Path $root 'vms.json') -Raw | ConvertFrom-Json;if(@($registry.records.PSObject.Properties).Count){throw 'Protected allocations remain'}
 $archive='C:\MuLab\private\cache-archive-'+[guid]::NewGuid().ToString('N');if([IO.Path]::GetDirectoryName($archive) -ne 'C:\MuLab\private'){throw 'Diagnostic archive boundary changed'};[IO.Directory]::CreateDirectory($archive) | Out-Null
 foreach($name in @('seed','changed','held','released','control-removed','ui-seeded','ui-changed','permissions-changed','permissions-restored','result','ui-result')){$file='C:\MuLab\approved\cache-'+$name+'.json';if(Test-Path -LiteralPath $file){[IO.File]::Move($file,(Join-Path $archive ('cache-'+$name+'.json')))}}
 return @{archivedCompletedReceipts=$true;cacheFilesUnchanged=$true}
}
if($Action -eq 'permissions'){
 if(@(Get-VM).Count){throw 'Only the isolated cache UI dataset may run the directory permission test'}
 $original=Get-Acl -LiteralPath $bases;$modified=Get-Acl -LiteralPath $bases;$modified.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','None','None','Allow'))
 try{Set-Acl -LiteralPath $bases -AclObject $modified;Receipt 'permissions-changed' @{complete=$true};$clock=[Diagnostics.Stopwatch]::StartNew();do{if(Test-Path -LiteralPath C:\MuLab\public\cache-permissions-release.json){$r=Get-Content C:\MuLab\public\cache-permissions-release.json -Raw | ConvertFrom-Json;if($r.nonce -eq $Nonce){break}};if($clock.ElapsedMilliseconds -gt 30000){throw 'Directory permission test did not acknowledge release'};Start-Sleep -Milliseconds 100}while($true)}finally{Set-Acl -LiteralPath $bases -AclObject $original};Receipt 'permissions-restored' @{complete=$true};return
}
if($Action -in @('ui-seed','ui-change')){
 if(@(Get-VM).Count){throw 'Cache UI acceptance requires all synthetic VMs removed'}
 if((Get-FileHash -LiteralPath (Join-Path $images ($data.current+'.vhdx')) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $data.current){throw 'Current test base changed'}
 $lock=[IO.File]::Open((Join-Path $common 'import.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{
  $existing=@(Get-ChildItem -LiteralPath $images -File -Filter ($data.current+'.vhdx.*.next'));foreach($entry in $existing){if([IO.File]::ReadAllText($entry.FullName) -cne 'synthetic UI cache copy'){throw 'Unexpected UI test temporary data'}}
  if($Action -eq 'ui-change' -or -not $existing.Count){$file=Join-Path $images ($data.current+'.vhdx.'+[guid]::NewGuid().ToString('N')+'.next');[IO.File]::WriteAllText($file,'synthetic UI cache copy')}
  Receipt $(if($Action -eq 'ui-seed'){'ui-seeded'}else{'ui-changed'}) @{complete=$true}
 }finally{$lock.Dispose()};return
}
if($Action -eq 'change'){
 $lock=[IO.File]::Open((Join-Path $common 'import.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{[IO.File]::AppendAllText((Join-Path $images ($data.unused+'.vhdx')),'synthetic stale-plan mutation');Receipt 'changed' @{complete=$true}}finally{$lock.Dispose()};return
}
if($Action -eq 'hold'){
 $lock=[IO.File]::Open((Join-Path $common 'import.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{Receipt 'held' @{complete=$true};$clock=[Diagnostics.Stopwatch]::StartNew();do{if(Test-Path -LiteralPath C:\MuLab\public\cache-release.json){$r=Get-Content -LiteralPath C:\MuLab\public\cache-release.json -Raw | ConvertFrom-Json;if($r.nonce -eq $Nonce){break}};if($clock.ElapsedMilliseconds -gt 30000){throw 'The lock test has not acknowledged release'};Start-Sleep -Milliseconds 100}while($true)}finally{$lock.Dispose()};Receipt 'released' @{complete=$true};return
}
if($Action -eq 'remove-control'){
 $vm=Assert-Control $data;$directory=[IO.Path]::GetFullPath([string]$data.controlDirectory)
 if([IO.Path]::GetDirectoryName($directory) -ne 'C:\MuLab\private' -or [IO.Path]::GetFileName($directory) -notmatch '^cache-control-[a-f0-9]{32}$'){throw 'Control storage boundary changed'}
 if((Get-FileHash -LiteralPath (Join-Path $images ($data.dependent+'.vhdx')) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $data.parentSha256){throw 'Snapshot parent changed during cleanup'}
 Remove-VM -VM $vm -Force;if(Get-VM -Id ([guid]$data.controlVm) -ErrorAction SilentlyContinue){throw 'Control VM removal not confirmed'}
 foreach($entry in @(Get-Item -LiteralPath $directory)+@(Get-ChildItem -LiteralPath $directory -Recurse -Force)){if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Control storage reparse point rejected'}}
 Remove-Item -LiteralPath $directory -Recurse -Force;Receipt 'control-removed' @{complete=$true;parentUnchanged=$true};return
}
if($Action -eq 'collect'){
 $result=Get-Content C:\MuLab\approved\cache-result.json -Raw | ConvertFrom-Json
 if(-not $result.complete -or -not $result.nested.removed -or @(Get-VM).Count){throw 'Cache acceptance or nested cleanup is incomplete'}
 $ui=Get-Content C:\MuLab\approved\cache-ui-result.json -Raw | ConvertFrom-Json;if(-not $ui.complete -or -not $ui.nested.realNativeApi){throw 'The real local UI acceptance must pass'}
 if((Get-FileHash -LiteralPath C:\MuLab\images\nested-base.vhdx -Algorithm SHA256).Hash.ToLowerInvariant() -ne $data.originalSourceSha256){throw 'Original reusable source changed'}
 if((Get-FileHash -LiteralPath (Join-Path $images ($data.current+'.vhdx')) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $data.current){throw 'Current base changed'}
 foreach($digest in @($data.canarySource,$data.dependent,$data.unused)){if(Test-Path -LiteralPath (Join-Path $images ($digest+'.vhdx'))){throw 'Unused diagnostic cache remains'}}
 $winlogon='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon';if((Get-ItemProperty -LiteralPath $winlogon).DefaultUserName -eq 'MuLabUser'){Remove-ItemProperty -LiteralPath $winlogon -Name DefaultPassword -ErrorAction SilentlyContinue;Set-ItemProperty -LiteralPath $winlogon -Name AutoAdminLogon -Value '0' -Type String;Set-ItemProperty -LiteralPath $winlogon -Name AutoLogonCount -Value 0 -Type DWord}
 $hashes=@{};foreach($file in @('C:\MuLab\client.mjs','C:\MuLab\cache-client.mjs','C:\MuLab\cache-ui.mjs','C:\MuLab\cache-ui.cjs','C:\MuLab\product\resources\app\dist-server\native\windows\HyperVBroker.cs','C:\MuLab\product\resources\app\dist-server\native\windows\ImageCache.cs','C:\MuLab\product\resources\app\dist-server\scripts\windows\hyperv.ps1','C:\MuLab\product\resources\app\dist-server\server\platform\windows\storage.js','C:\MuLab\product\resources\app\dist-server\server\platform\windows\service.js','C:\MuLab\product\resources\app\dist-server\server\platform\windows\broker.js')){$hashes[$file]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
 return @{result=$result;ui=$ui;sourceHashes=$hashes;originalSourceUnchanged=$true;currentBaseUnchanged=$true;snapshotParentPreservedUntilExplicitRemoval=$true;nestedGuestsRemaining=0;aiWebsitesVisited=0}
}
