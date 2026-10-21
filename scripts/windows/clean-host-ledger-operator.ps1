# This file is copied into the evaluation guest's administrator-only fixture.
# No production IPC endpoint can invoke it or choose its paths.
[CmdletBinding()]
param([ValidateSet('primary-loss','primary-corrupt','both-loss','restore','orphan-create','inspect','deny','collect')][string]$Action,[string]$Nonce)
$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'MU-CLEAN-LAB' -or (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID -ne 'IoTEnterpriseSEval' -or -not (Test-Path -LiteralPath C:\MuLab\public\provisioned.json)){throw 'Only the dedicated Windows evaluation guest may run this diagnostic'}
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'The synthetic guest administrator is required'}
$sid=(Get-LocalUser -Name MuLabUser).SID.Value
if(@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object {$_.SID.Value -eq $sid}).Count){throw 'The application account must remain ordinary'}
$seed=Get-Content -LiteralPath C:\MuLab\approved\ledger-seed-result.json -Raw | ConvertFrom-Json
if(-not $seed.complete -or -not $seed.nested.stopped -or -not $seed.nested.localManifestRemoved){throw 'The actual Linux canary must be seeded first'}
$id=[string]$seed.nested.config.id
if($id -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or ([guid]$id).ToString('D') -ne $id){throw 'Invalid diagnostic allocation'}
$root=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid)
$primary=Join-Path $root 'vms.json';$backup=Join-Path $root 'vms.backup.json';$disk=Join-Path $root ('vms/'+$id+'/disk.vhdx')
function Assert-StoppedOriginal {
 $vms=@(Get-VM);if($vms.Count -ne 1 -or [string]$vms[0].Id -ne $seed.nested.platformId -or $vms[0].Name -ne ('mu-win-'+$id.Replace('-','')) -or $vms[0].State -ne 'Off'){throw 'Only the original stopped diagnostic VM may remain'}
 $drives=@(Get-VMHardDiskDrive -VM $vms[0]);if($drives.Count -ne 1 -or [IO.Path]::GetFullPath($drives[0].Path) -ne [IO.Path]::GetFullPath($disk)){throw 'The original diagnostic disk identity changed'}
 if((Get-Item -LiteralPath $disk).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Diagnostic disk reparse point rejected'}
}
function Read-Replicas {
 $a=[IO.File]::ReadAllText($primary);$b=[IO.File]::ReadAllText($backup)
 if($a -cne $b){throw 'Protected registry copies differ before fault injection'}
 $state=$a | ConvertFrom-Json
 if($state.version -ne 2 -or $state.ownerSid -ne $sid -or @($state.records.PSObject.Properties).Count -ne 1 -or $state.records.$id.platformId -ne $seed.nested.platformId -or $state.records.$id.ownerSid -ne $sid){throw 'The protected registry must contain exactly the synthetic allocation'}
 return $state
}
function Write-Receipt([string]$name,$value){[IO.File]::WriteAllText((Join-Path C:\MuLab\approved ($name+'.json')),($value | ConvertTo-Json -Depth 16 -Compress),[Text.UTF8Encoding]::new($false))}
$sessionLock=$null
try{
 if($Action -in @('primary-loss','primary-corrupt','both-loss','restore','orphan-create')){
  $until=[DateTime]::UtcNow.AddSeconds(45)
  do{try{$sessionLock=[IO.File]::Open((Join-Path $root 'session.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);break}catch [IO.IOException]{if([DateTime]::UtcNow -gt $until){throw 'The previous protected session is still active; no registry file was changed'};Start-Sleep -Milliseconds 200}}while($true)
  Assert-StoppedOriginal
 }
 if($Action -eq 'orphan-create'){
  Read-Replicas | Out-Null;$other=[guid]::NewGuid().ToString('D');$directory=Join-Path $root ('vms/'+$other)
  if(Test-Path -LiteralPath C:\MuLab\approved\ledger-orphan.json){throw 'Inspect prior orphan evidence before creating another one'}
  [IO.Directory]::CreateDirectory($directory) | Out-Null;[IO.File]::WriteAllText((Join-Path $directory 'retained.txt'),'synthetic unregistered storage')
  $value=@{id=$other;createdByThisDiagnostic=$true};Write-Receipt 'ledger-orphan' $value;return $value
 }
 if($Action -in @('primary-loss','primary-corrupt','both-loss')){
  $registry=Read-Replicas;$tag=[guid]::NewGuid().ToString('N');$a='ledger-primary-'+$tag+'.json';$b='ledger-backup-'+$tag+'.json'
  $fault=@{kind=$Action;id=$id;platformId=$seed.nested.platformId;diskSha256=(Get-FileHash -LiteralPath $disk -Algorithm SHA256).Hash.ToLowerInvariant();primaryArchive=$a;backupArchive=$b;registrySha256=(Get-FileHash -LiteralPath $primary -Algorithm SHA256).Hash.ToLowerInvariant();revision=$registry.revision;rejectedBefore=@(Get-ChildItem -LiteralPath $root -File -Filter 'vms.rejected-*.json').Count;bootId=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')}
  [IO.File]::Move($primary,(Join-Path C:\MuLab\private $a))
  if($Action -eq 'primary-corrupt'){[IO.File]::WriteAllText($primary,'{"version":',[Text.UTF8Encoding]::new($false))}
  if($Action -eq 'both-loss'){[IO.File]::Move($backup,(Join-Path C:\MuLab\private $b))}
  Write-Receipt 'ledger-fault' $fault;Write-Receipt ('ledger-fault-'+$Action) $fault;return $fault
 }
 if($Action -eq 'restore'){
  $fault=Get-Content -LiteralPath C:\MuLab\approved\ledger-fault.json -Raw | ConvertFrom-Json
  if($fault.kind -ne 'both-loss' -or (Test-Path -LiteralPath $primary) -or (Test-Path -LiteralPath $backup)){throw 'Restore only the known two-copy-loss diagnostic'}
  foreach($name in @($fault.primaryArchive,$fault.backupArchive)){
   if($name -notmatch '^ledger-(primary|backup)-[a-f0-9]{32}\.json$'){throw 'Archive filename changed'}
   $source=Join-Path C:\MuLab\private $name;if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $fault.registrySha256){throw 'Saved diagnostic registration changed'}
  }
  if((Get-FileHash -LiteralPath $disk -Algorithm SHA256).Hash.ToLowerInvariant() -ne $fault.diskSha256){throw 'The retained guest disk changed'}
  [IO.File]::Copy((Join-Path C:\MuLab\private $fault.backupArchive),$backup,$false);[IO.File]::Copy((Join-Path C:\MuLab\private $fault.primaryArchive),$primary,$false)
  $fault.kind='explicit-restore';Write-Receipt 'ledger-fault' $fault;Read-Replicas | Out-Null;return @{restored=$true;originalDiskUnchanged=$true}
 }
 if($Action -in @('inspect','deny')){
  if($Nonce -notmatch '^[a-f0-9]{64}$'){throw 'A bound ordinary-user probe nonce is required'}
  Assert-StoppedOriginal;$fault=Get-Content -LiteralPath C:\MuLab\approved\ledger-fault.json -Raw | ConvertFrom-Json
  if((Get-FileHash -LiteralPath $disk -Algorithm SHA256).Hash.ToLowerInvariant() -ne $fault.diskSha256){throw 'Recovery replaced or modified the original stopped disk'}
  if($Action -eq 'deny'){
   if($fault.kind -ne 'both-loss' -or (Test-Path -LiteralPath $primary) -or (Test-Path -LiteralPath $backup)){throw 'A rejected broker must not create an empty replacement registry'}
   $value=@{nonce=$Nonce;rejected=$true;originalDiskUnchanged=$true;originalVmOff=$true};Write-Receipt 'ledger-denied' $value;return $value
  }
  $registry=Read-Replicas
  $quarantined=$false
  if($fault.kind -eq 'primary-corrupt'){
   $rejected=@(Get-ChildItem -LiteralPath $root -File -Filter 'vms.rejected-*.json');if($rejected.Count -le $fault.rejectedBefore -or -not @($rejected | Where-Object {[IO.File]::ReadAllText($_.FullName) -ceq '{"version":'}).Count){throw 'Production did not retain the corrupt primary'};$quarantined=$true
  }
  $value=@{nonce=$Nonce;scenario=$fault.kind;originalDiskUnchanged=$true;replicasMatch=$true;quarantinedCorruption=$quarantined;revision=$registry.revision};Write-Receipt 'ledger-inspected' $value;return $value
 }
 if($Action -eq 'collect'){
  $results=@{}
  foreach($name in @('ledger-seed','ledger-primary-loss','ledger-primary-corrupt','ledger-deny','ledger-final')){$r=Get-Content -LiteralPath ('C:\MuLab\approved\'+$name+'-result.json') -Raw | ConvertFrom-Json;if(-not $r.complete){throw ('Incomplete ledger acceptance: '+$name)};$results[$name]=$r}
  if(-not $results['ledger-final'].nested.removed -or @(Get-VM).Count -or (Test-Path -LiteralPath (Split-Path $disk))){throw 'Diagnostic VM and owned disk must be removed'}
  $a=[IO.File]::ReadAllText($primary);if($a -cne [IO.File]::ReadAllText($backup)){throw 'Final registry copies differ'};$registry=$a | ConvertFrom-Json;if($registry.version -ne 2 -or $registry.ownerSid -ne $sid -or @($registry.records.PSObject.Properties).Count){throw 'The final protected registry must be empty'}
  $orphan=Get-Content -LiteralPath C:\MuLab\approved\ledger-orphan.json -Raw | ConvertFrom-Json;$other=[guid]$orphan.id
  if(-not $orphan.createdByThisDiagnostic -or $other.ToString('D') -ne $orphan.id -or $other -eq [guid]::Empty){throw 'Synthetic orphan identity changed'}
  $directory=Join-Path $root ('vms/'+$other.ToString('D'));$entries=@(Get-ChildItem -LiteralPath $directory -Force)
  if((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint -or $entries.Count -ne 1 -or $entries[0].Name -ne 'retained.txt' -or [IO.File]::ReadAllText($entries[0].FullName) -cne 'synthetic unregistered storage'){throw 'Unregistered test data changed or was adopted'}
  [IO.File]::Delete($entries[0].FullName);[IO.Directory]::Delete($directory,$false)
  $winlogon='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  if((Get-ItemProperty -LiteralPath $winlogon).DefaultUserName -ne 'MuLabUser'){throw 'The synthetic logon account changed'}
  Remove-ItemProperty -LiteralPath $winlogon -Name DefaultPassword -ErrorAction SilentlyContinue;Set-ItemProperty -LiteralPath $winlogon -Name AutoAdminLogon -Value '0' -Type String;Set-ItemProperty -LiteralPath $winlogon -Name AutoLogonCount -Value 0 -Type DWord
  $hashes=@{};foreach($file in @('C:\MuLab\client.mjs','C:\MuLab\ledger-client.mjs','C:\MuLab\product\resources\app\dist-server\native\windows\HyperVBroker.cs','C:\MuLab\product\resources\app\dist-server\native\windows\ProtectedLedger.cs','C:\MuLab\product\resources\app\dist-server\native\windows\HostComponents.cs','C:\MuLab\product\resources\app\dist-server\scripts\windows\build-broker.ps1','C:\MuLab\product\resources\app\dist-server\server\platform\windows\broker.js')){$hashes[$file]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
  return @{results=$results;sourceHashes=$hashes;protectedReplicasEmpty=$true;originalCanaryPreserved=$true;unregisteredCanaryPreserved=$true;nestedGuestsRemaining=0;ordinaryUser=$true;syntheticAutologonDisabled=$true;aiWebsitesVisited=0}
 }
}finally{if($sessionLock){$sessionLock.Dispose()}}
