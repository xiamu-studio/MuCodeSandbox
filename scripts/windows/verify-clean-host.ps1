#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Directory,[Parameter(Mandatory)][int]$OwnerPid,[Parameter(Mandatory)][ValidateSet('before-reboot','after-reboot','upgrade-stage','upgrade-seed','upgrade-baseline','upgrade-current','upgrade-compare-current','upgrade-current-check','upgrade-baseline-next','upgrade-next','upgrade-compare-next','upgrade-next-check','upgrade-reject','upgrade-final','upgrade-inspect','upgrade-collect','power-inspect','power-discard-failed','power-clear-failed','power-prepare-reset','power-run','power-recover','power-progress','power-collect','inspect','ssh-inspect','ssh-remove','ssh-source','ssh-install','ssh-ready','ssh-collect','network-inspect','network-prepare','network','network-collect','adoption-seed','adoption-backup','adoption-backup-restore','adoption-backup-cross','adoption-backup-cross-recover','adoption-backup-cross-finish','adoption-backup-cross-progress','adoption-backup-cross-collect','adoption-backup-gui','adoption-backup-gui-collect','adoption-backup-gui-progress','adoption-backup-gui-dialog-release','adoption-backup-restore-collect','adoption-backup-progress','adoption-backup-collect','adoption-loss','adoption-review','adoption-approve','adoption-ui','adoption-ui-stage','adoption-ui-collect','adoption-final','adoption-inspect','adoption-collect','resource-prepare','resource-inspect','resource-seed','resource-disk','resource-memory','resource-recover','resource-collect','cache','cache-reset','cache-inspect','cache-ui-stage','cache-ui','cache-collect','ledger-seed','ledger-logon','ledger-orphan-create','ledger-check','ledger-final','ledger-deny','ledger-primary-loss','ledger-primary-corrupt','ledger-both-loss','ledger-restore','ledger-collect','oobe','reset-hyperv','collect-stop')][string]$Phase)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$directoryPath=[IO.Path]::GetFullPath($Directory)
if([IO.Path]::GetFileName($directoryPath) -notmatch '^clean-host-[a-f0-9-]{36}$'){throw 'Dedicated clean-host fixture required'}
Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs')
$guard=[MuPacketLabGuard]::new($OwnerPid,$directoryPath)
$session=$null;$report=$guard.Reserve('probe-'+[guid]::NewGuid().ToString('N')+'.json')
$machine=[IO.File]::ReadAllText((Join-Path $directoryPath 'machine.json')) | ConvertFrom-Json
$config=[IO.File]::ReadAllText((Join-Path $directoryPath 'config.json')) | ConvertFrom-Json
$credentials=[IO.File]::ReadAllText((Join-Path $directoryPath 'guest-seed/private/credentials.json')) | ConvertFrom-Json
function Save-Probe([string]$state,$result=$null) {
 [IO.File]::WriteAllText($report,(@{phase=$Phase;state=$state;time=[DateTime]::UtcNow.ToString('o');result=$result} | ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false))
}
function Assert-LabVM {
 if($machine.name -ne $config.name -or $machine.name -notmatch '^mu-win-clean-[a-f0-9]{32}$'){throw 'Diagnostic name changed'}
 $vm=Get-VM -Id ([guid]$machine.id) -ErrorAction Stop
 $expectedDisk=[IO.Path]::GetFullPath((Join-Path $directoryPath 'trace-artifacts/windows.vhdx'))
 $disks=@(Get-VMHardDiskDrive -VM $vm)
 if($vm.Name -ne $machine.name -or $vm.Notes -ne ('MuCodeSandbox clean Windows diagnostic '+$machine.name) -or $disks.Count -ne 1 -or [IO.Path]::GetFullPath($disks[0].Path) -ne $expectedDisk -or [IO.Path]::GetFullPath($machine.disk) -ne $expectedDisk){throw 'Diagnostic VM identity changed'}
 if(@(Get-VMNetworkAdapter -VM $vm | Where-Object {$_.SwitchName}).Count){throw 'The clean Windows diagnostic must remain disconnected'}
 if(-not (Get-VMProcessor -VM $vm).ExposeVirtualizationExtensions){throw 'Nested virtualization is not exposed'}
 return $vm
}
function Connect-LabGuest {
 $vm=Assert-LabVM
 if($vm.State -ne 'Running'){throw 'Diagnostic guest must already be running'}
 $credential=[pscredential]::new([string]$credentials.adminUser,(ConvertTo-SecureString $credentials.adminPassword -AsPlainText -Force))
 $until=[DateTime]::UtcNow.AddMinutes(15)
 do{
  try{return New-PSSession -VMId $vm.Id -Credential $credential -ErrorAction Stop}catch{if([DateTime]::UtcNow -gt $until){throw 'PowerShell Direct is not ready; the evaluation guest is retained for inspection'};Start-Sleep -Seconds 3}
 }while($true)
}
try{
 $selected=Assert-LabVM
 if($Phase -eq 'resource-prepare'){
  if($selected.State -ne 'Off'){throw 'Capacity fixture expansion requires the evaluation VM Off'}
  $disk=[IO.Path]::GetFullPath((Join-Path $directoryPath 'trace-artifacts/windows.vhdx'));$vhd=Get-VHD -Path $disk
  if($vhd.ParentPath -or $vhd.Size -notin @(96GB,160GB)){throw 'Expected the known standalone evaluation VHDX'}
  if([IO.DriveInfo]::new([IO.Path]::GetPathRoot($disk)).AvailableFreeSpace -lt 176GB){throw 'Host free space is insufficient for the bounded 160 GiB pressure fixture'}
  if($vhd.Size -lt 160GB){Resize-VHD -Path $disk -SizeBytes 160GB}
  Start-VM -VM $selected | Out-Null
 }
 if($Phase -in @('ssh-inspect','network-prepare','ledger-seed','ledger-logon','power-inspect') -and $selected.State -eq 'Off'){Start-VM -VM $selected | Out-Null}
 Save-Probe 'connecting'
 $session=Connect-LabGuest
 $initial=Invoke-Command -Session $session -ScriptBlock {
  if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Synthetic guest administrator required'}
  if(-not (Test-Path -LiteralPath C:\MuLab\public\provisioned.json)){throw 'Guest bootstrap is incomplete'}
  [ordered]@{bootId=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');hypervisor=[bool](Get-CimInstance Win32_ComputerSystem).HypervisorPresent;edition=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID}
 }
 if($Phase -eq 'adoption-backup-cross-collect'){
  $value=Invoke-Command -Session $session -ScriptBlock {
   $source=[IO.File]::ReadAllText('C:\MuLab\approved\adoption-backup-cross-result.json')|ConvertFrom-Json;$seed=[IO.File]::ReadAllText('C:\MuLab\approved\adoption-seed-result.json')|ConvertFrom-Json
   if(-not $source.complete -or $source.nested.caseId -notmatch '^[a-f0-9]{32}$' -or -not $seed.complete -or $source.nested.id -ne $seed.nested.config.id){throw 'Completed source and seed results are required'}
   $id=$source.nested.caseId;$cfg=[IO.File]::ReadAllText(('C:\MuLab\approved\backup-user-'+$id+'-config.json'))|ConvertFrom-Json;if($cfg.directory -cne ('C:\MuLab\backup-user-'+$id) -or $source.nonce.Substring(0,32) -cne $id){throw 'Cross-user collection identity changed'}
   $conflict=[IO.File]::ReadAllText((Join-Path $cfg.directory conflict-result.json))|ConvertFrom-Json;$recovered=[IO.File]::ReadAllText((Join-Path $cfg.directory recover-result.json))|ConvertFrom-Json;$failed=[IO.File]::ReadAllText((Join-Path $cfg.directory restore-result.json))|ConvertFrom-Json;$preboot=[IO.File]::ReadAllText(('C:\MuLab\private\backup-user-'+$id+'-preboot-audit.json'))|ConvertFrom-Json
   if(-not $conflict.complete -or -not $recovered.complete -or $failed.complete -ne $false -or $failed.checks.Count -ne 4 -or -not $recovered.bootRead -or $recovered.nested.platformId -ne $preboot.platformId -or -not $preboot.newOwnerConfirmed -or $cfg.userSid -eq $cfg.sourceSid -or (Get-LocalUser $cfg.userName).Enabled){throw 'Cross-user target results or disabled profile proof is incomplete'}
   if(@(Get-VM).Count -or @(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1\bin\hv-broker-*.exe' -or $_.ExecutablePath -eq 'C:\MuLab\product\resources\node\node.exe'}).Count){throw 'A cross-user VM or controller/broker is still live'}
   foreach($sid in @($cfg.sourceSid,$cfg.userSid)){$root=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid);$primary=[IO.File]::ReadAllText((Join-Path $root vms.json));if($primary -cne [IO.File]::ReadAllText((Join-Path $root vms.backup.json)) -or @((ConvertFrom-Json $primary).records.PSObject.Properties).Count -or (Test-Path -LiteralPath (Join-Path $root ('vms/'+$cfg.config.id)))){throw 'A user allocation or protected disk remains'}}
   $permissions=[IO.File]::ReadAllText(('C:\MuLab\private\backup-user-'+$id+'-permissions.json'))|ConvertFrom-Json;foreach($item in $permissions){if((Get-Acl -LiteralPath $item.path).Sddl -cne $item.before){throw 'Shared fixture permissions were not restored'}}
   $preserved=[IO.File]::ReadAllText('C:\MuLab\approved\adoption-preserve-restore-source.json')|ConvertFrom-Json;if($preserved.nonce -cne $source.nonce -or (Get-FileHash -LiteralPath (Join-Path C:\MuLab\private $preserved.archive)).Hash.ToLowerInvariant() -ne $cfg.diskSha256){throw 'Independent original disk copy changed'}
   if(Test-Path -LiteralPath ('C:\MuLab\public\backup-cross-'+$source.nonce+'.mucwin')){throw 'Source encrypted fixture remains'}
   if(@(Get-ChildItem -LiteralPath (Join-Path $cfg.directory runtime) -Directory -Filter 'backup-work-*').Count){throw 'Target plaintext staging remains'}
   $archive=Join-Path $cfg.directory archive.mucwin;if(Test-Path -LiteralPath $archive){$entry=Get-Item -LiteralPath $archive;if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint -or [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($archive)) -cne $cfg.directory){throw 'Encrypted target fixture identity changed'};[IO.File]::Delete($archive)}
   $hashes=@{};foreach($file in @('C:\MuLab\client.mjs','C:\MuLab\adoption-client.mjs','C:\MuLab\backup-cross-source.mjs','C:\MuLab\backup-cross-target.mjs','C:\MuLab\BackupUserStation.cs')){$hashes[$file]=(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
   foreach($name in @('manager','service','runtime','backup-bundle','backup-archive','backup-reader','credentials','broker','setup','config','guest','session','ssh-process')){$file='C:\MuLab\product\resources\app\dist-server\server\platform\windows\'+$name+'.js';$hashes[$file]=(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
   foreach($name in @('manager','service','runtime','backup-bundle','backup-archive','backup-reader','credentials','broker','setup','config','guest','session','ssh-process')){if(-not(Test-Path -LiteralPath ('C:\MuLab\product\resources\app\dist-server\server\platform\windows\'+$name+'.js'))){throw 'A runtime input is missing'}}
   $pointer=[IO.File]::ReadAllText((Join-Path $env:ProgramData 'MuCodeSandbox-HyperVBroker-v1/bin/current.json'))|ConvertFrom-Json;$winlogon='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon';if((Get-ItemProperty $winlogon).DefaultUserName -ne 'MuLabUser'){throw 'Synthetic logon identity changed'};Remove-ItemProperty -LiteralPath $winlogon -Name DefaultPassword -ErrorAction SilentlyContinue;Set-ItemProperty -LiteralPath $winlogon -Name AutoAdminLogon -Value '0' -Type String;Set-ItemProperty -LiteralPath $winlogon -Name AutoLogonCount -Value 0 -Type DWord
   @{complete=$true;source=$source;seed=$seed;conflict=$conflict;recovered=$recovered;failedObservation=$failed;prebootAudit=$preboot;sourceHashes=$hashes;protectedBrokerSourceDigest=$pointer.sourceDigest;sourceSid=$cfg.sourceSid;targetSid=$cfg.userSid;targetDisabled=$true;sharedFixturePermissionsRestored=$true;encryptedFixturesRemoved=$true;plaintextStagingRemoved=$true;originalCopyUnchanged=$true;syntheticAutologonDisabled=$true;nestedGuestsRemaining=0;aiWebsitesVisited=0}
  }
  Assert-LabVM|Out-Null;Save-Probe 'cross-user-evidence-collected' $value
  try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{};Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$clock=[Diagnostics.Stopwatch]::StartNew()
  do{if((Assert-LabVM).State -eq 'Off'){Save-Probe 'cross-user-complete-and-evaluation-vm-off' $value;exit 0};if($clock.ElapsedMilliseconds -gt 120000){throw 'Evaluation shutdown remains unconfirmed'};Start-Sleep -Seconds 2}while($true)
 }
 if($Phase -eq 'adoption-backup-cross-finish'){
  $source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'clean-host-adoption-operator.ps1'));$cross=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'clean-host-backup-cross-operator.ps1'))
  $value=Invoke-Command -Session $session -ArgumentList $source,$cross -ScriptBlock {
   param($source,$cross)
   $owner=[IO.File]::ReadAllText('C:\MuLab\public\adoption-backup-cross-owner.json')|ConvertFrom-Json;if($owner.nonce -notmatch '^[a-f0-9]{64}$' -or -not(Get-Process -Id $owner.pid -ErrorAction SilentlyContinue)){throw 'The original source controller is not live'}
   foreach($action in @('verify-preserved-source','cross-final')){
    $file='C:\MuLab\public\adoption-'+$action+'-request.json';$until=[DateTime]::UtcNow.AddMinutes(3)
    do{$request=$null;if(Test-Path -LiteralPath $file){$request=[IO.File]::ReadAllText($file)|ConvertFrom-Json};if($request -and $request.nonce -ceq $owner.nonce -and $request.action -eq $action){break};if([DateTime]::UtcNow -gt $until -or -not(Get-Process -Id $owner.pid -ErrorAction SilentlyContinue)){throw 'The original source follow-up request is not available'};Start-Sleep -Milliseconds 200}while($true)
    if($action -eq 'cross-final'){& ([ScriptBlock]::Create($cross)) -Action $action -Nonce $owner.nonce|Out-Null}else{& ([ScriptBlock]::Create($source)) -Action $action -Nonce $owner.nonce|Out-Null}
   }
   $until=[DateTime]::UtcNow.AddMinutes(3);do{if(Test-Path -LiteralPath C:\MuLab\public\adoption-backup-cross-result.json){$result=[IO.File]::ReadAllText('C:\MuLab\public\adoption-backup-cross-result.json')|ConvertFrom-Json;if($result.nonce -ceq $owner.nonce){if(-not$result.complete){throw 'The original source controller did not finish successfully'};[IO.File]::WriteAllText('C:\MuLab\approved\adoption-backup-cross-result.json',($result|ConvertTo-Json -Depth 16 -Compress));return $result}};if([DateTime]::UtcNow -gt $until){throw 'The original source terminal result remains pending'};Start-Sleep -Milliseconds 200}while($true)
  }
  Save-Probe 'cross-user-source-finished' $value;exit 0
 }
 if($Phase -eq 'adoption-backup-cross-recover'){
  $nonce=Invoke-Command -Session $session -ScriptBlock {
   $owner=[IO.File]::ReadAllText('C:\MuLab\public\adoption-backup-cross-owner.json')|ConvertFrom-Json;if($owner.nonce -notmatch '^[a-f0-9]{64}$' -or -not(Get-Process -Id $owner.pid -ErrorAction SilentlyContinue)){throw 'Original cross-user source controller is no longer live'}
   $id=$owner.nonce.Substring(0,32);$cfg=[IO.File]::ReadAllText(('C:\MuLab\approved\backup-user-'+$id+'-config.json'))|ConvertFrom-Json;$failed=[IO.File]::ReadAllText((Join-Path $cfg.directory restore-result.json))|ConvertFrom-Json
   if($failed.complete -ne $false -or $failed.checks.Count -ne 4 -or $failed.error.code -ne 'PROCESS_FAILED' -or (Get-Process -Id $failed.pid -ErrorAction SilentlyContinue)){throw 'Only the exact terminal post-restore observation failure may continue'}
   $owner.nonce
  }
  foreach($pair in @(@('clean-host-backup-cross-target.mjs','backup-cross-target.mjs'),@('BackupUserStation.cs','BackupUserStation.cs'))){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $pair[0]) -Destination ('C:\MuLab\'+$pair[1]) -ToSession $session -Force}
  $operator=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'clean-host-backup-cross-operator.ps1'))
  $value=Invoke-Command -Session $session -ArgumentList $nonce,$operator -ScriptBlock {
   param($nonce,$operator)
   $id=$nonce.Substring(0,32);$file='C:\MuLab\approved\backup-user-'+$id+'-config.json';$cfg=[IO.File]::ReadAllText($file)|ConvertFrom-Json;if($cfg.directory -cne ('C:\MuLab\backup-user-'+$id)){throw 'Cross-user recovery directory changed'};$old=[IO.File]::ReadAllText(('C:\MuLab\approved\backup-user-'+$id+'-audit.json'))|ConvertFrom-Json;$vm=Get-VM -Id ([guid]$old.platformId);$disk=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$cfg.userSid+'/vms/'+$cfg.config.id+'/disk.vhdx');$drives=@(Get-VMHardDiskDrive -VM $vm)
   if(-not $old.newOwnerConfirmed -or $old.userSid -ne $cfg.userSid -or $vm.State -ne 'Off' -or $drives.Count -ne 1 -or [IO.Path]::GetFullPath($drives[0].Path) -cne $disk){throw 'The existing stopped target allocation changed'}
   $preserved='C:\MuLab\private\backup-user-'+$id+'-preboot-audit.json'
   if(Test-Path -LiteralPath $preserved){
    $failed=[IO.File]::ReadAllText((Join-Path $cfg.directory recover-result.json))|ConvertFrom-Json;if($failed.complete -ne $false -or $failed.bootRead -ne $false -or $failed.checks.Count -notin @(3,4) -or $failed.error.code -ne 'ERR_ASSERTION' -or (Get-Process -Id $failed.pid -ErrorAction SilentlyContinue)){throw 'The terminal recovery observation could not be verified'}
    if($failed.checks.Count -eq 3 -and ((Get-FileHash -LiteralPath $disk).Hash.ToLowerInvariant() -ne $cfg.recoveryDiskSha256 -or (Get-Item -LiteralPath $disk).Length -ne $cfg.recoveryDiskBytes)){throw 'The pre-boot recovery disk changed'}
    if($failed.checks.Count -eq 4 -and ([string]$vm.Id -ne $cfg.recoveryPlatformId -or -not $old.newOwnerConfirmed -or $old.userSid -ne $cfg.userSid)){throw 'The previously booted target VM identity changed'}
    $history='C:\MuLab\private\backup-user-'+$id+'-recover-failed-'+[guid]::NewGuid().ToString('N');[IO.Directory]::CreateDirectory($history)|Out-Null
    foreach($name in @('recover-owner.json','recover-result.json','recover-station-out.log','recover-station-error.log','recover-broker-out.log','recover-broker-error.log','recover-audit-request.json')){$from=[IO.Path]::GetFullPath((Join-Path $cfg.directory $name));$to=[IO.Path]::GetFullPath((Join-Path $history $name));if([IO.Path]::GetDirectoryName($from) -cne $cfg.directory -or [IO.Path]::GetDirectoryName($to) -cne $history){throw 'Recovery history retention path changed'};if(Test-Path -LiteralPath $from){[IO.File]::Move($from,$to)}}
   }else{[IO.File]::WriteAllText($preserved,($old|ConvertTo-Json -Compress))}
   $revision=(Get-FileHash C:\MuLab\backup-cross-target.mjs).Hash.ToLowerInvariant().Substring(0,16);$launcher='C:\MuLab\approved\backup-user-'+$id+'-station-recover-'+$revision+'.exe';Add-Type -TypeDefinition ([IO.File]::ReadAllText('C:\MuLab\BackupUserStation.cs').Replace('MuBackupUserStation',('MuBackupUserStationRecover'+$revision))) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -OutputAssembly $launcher -OutputType ConsoleApplication
   foreach($pair in @(@('recoveryLauncher',$launcher),@('recoveryPlatformId',[string]$vm.Id),@('recoveryDiskSha256',(Get-FileHash -LiteralPath $disk).Hash.ToLowerInvariant()),@('recoveryDiskBytes',(Get-Item -LiteralPath $disk).Length))){$cfg|Add-Member -NotePropertyName $pair[0] -NotePropertyValue $pair[1] -Force};$cfg.clientSha256=(Get-FileHash C:\MuLab\backup-cross-target.mjs).Hash.ToLowerInvariant();[IO.File]::WriteAllText($file,($cfg|ConvertTo-Json -Depth 12 -Compress))
   & ([ScriptBlock]::Create($operator)) -Action cross-restore -Nonce $nonce -Recovery
  }
  Save-Probe 'existing-cross-user-restore-recovered' $value;exit 0
 }
 if($Phase -eq 'resource-prepare'){
  $result=Invoke-Command -Session $session -ScriptBlock {
   if($env:COMPUTERNAME -ne 'MU-CLEAN-LAB' -or @(Get-VM).Count){throw 'Only the empty evaluation guest volume may be extended'}
   $partition=Get-Partition -DriveLetter C;$supported=Get-PartitionSupportedSize -DriveLetter C
   if($supported.SizeMax -gt $partition.Size){Resize-Partition -DriveLetter C -Size $supported.SizeMax | Out-Null}
   @{guestVolumeExtended=$true;guestVolumeBytes=(Get-Volume -DriveLetter C).Size;nestedGuests=0}
  }
  Save-Probe 'capacity-evaluation-volume-ready' $result;exit 0
 }
 if($Phase -eq 'power-inspect'){
  $value=Invoke-Command -Session $session -ScriptBlock {
   if($env:COMPUTERNAME -ne 'MU-CLEAN-LAB' -or (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID -ne 'IoTEnterpriseSEval' -or @(Get-VM -ErrorAction Stop).Count){throw 'Power inspection requires the empty isolated evaluation guest'}
   $power=Join-Path $env:SystemRoot System32/powercfg.exe;$states=(& $power /a 2>&1|Out-String);if($LASTEXITCODE -ne 0){throw 'Power capabilities query failed'}
   $settings=Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Power'
   @{availableStates=$states;hibernateEnabled=$settings.HibernateEnabled;hiberbootEnabled=$settings.HiberbootEnabled;bootId=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');nestedGuests=0;settingsChanged=$false}
  }
  Assert-LabVM|Out-Null;Save-Probe 'power-capabilities-inspected' $value
  try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
  Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$clock=[Diagnostics.Stopwatch]::StartNew()
  do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'power-capabilities-inspected-and-evaluation-vm-off' $value;exit 0};if($clock.ElapsedMilliseconds -gt 120000){throw 'Evaluation shutdown not confirmed'};Start-Sleep -Seconds 2}while($true)
 }
 if($Phase.StartsWith('upgrade-')){
  $operatorSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'clean-host-upgrade-operator.ps1'))
  if($Phase -eq 'upgrade-stage'){
   Invoke-Command -Session $session -ScriptBlock {if($env:COMPUTERNAME -ne 'MU-CLEAN-LAB' -or @(Get-VM).Count){throw 'Upgrade staging requires the empty isolated guest'};[void][IO.Directory]::CreateDirectory('C:\MuLab\upgrade-payload')}
   $packages=@{};foreach($role in @('baseline','current','next')){$packageMetadata=Get-Content -LiteralPath (Join-Path $PSScriptRoot ('../../.mu-data/windows-run/upgrade-'+$role+'-package.json')) -Raw|ConvertFrom-Json;$installer=@($packageMetadata.artifacts|Where-Object{$_ -like '*.exe'})[0];$pkg=Get-Content -LiteralPath (Join-Path $packageMetadata.stage.app package.json) -Raw|ConvertFrom-Json;$target='C:\MuLab\upgrade-payload\'+$role+'.exe';Copy-Item -LiteralPath $installer -Destination $target -ToSession $session -Force;$packages[$role]=@{file=$target;version=$pkg.version;sha256=(Get-FileHash -LiteralPath $installer).Hash.ToLowerInvariant()}}
   Invoke-Command -Session $session -ArgumentList ($packages|ConvertTo-Json -Depth 5 -Compress) -ScriptBlock {param($json) $packages=$json|ConvertFrom-Json;foreach($role in @('baseline','current','next')){if((Get-FileHash -LiteralPath $packages.$role.file).Hash.ToLowerInvariant() -ne $packages.$role.sha256){throw 'Upgrade payload digest changed'}};[IO.File]::WriteAllText('C:\MuLab\approved\upgrade-packages.json',$json)}
   Save-Probe 'verified-upgrade-installers-staged';exit 0
  }
  if($Phase -in @('upgrade-baseline','upgrade-compare-current','upgrade-baseline-next','upgrade-compare-next','upgrade-inspect','upgrade-collect')){
   $action=$Phase.Substring(8);$value=Invoke-Command -Session $session -ArgumentList $operatorSource,$action -ScriptBlock {param($source,$action) & ([ScriptBlock]::Create($source)) -Action $action};Save-Probe 'upgrade-diagnostic-evidence' $value
   if($Phase -eq 'upgrade-collect'){
    Assert-LabVM|Out-Null;try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{};Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$clock=[Diagnostics.Stopwatch]::StartNew()
    do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'upgrade-complete-and-evaluation-vm-off' $value;exit 0};if($clock.ElapsedMilliseconds -gt 120000){throw 'Evaluation shutdown not confirmed'};Start-Sleep -Seconds 2}while($true)
   };exit 0
  }
 }
 if($Phase.StartsWith('power-')){
  $operatorSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'clean-host-power-operator.ps1'))
  if($Phase -eq 'power-prepare-reset'){$value=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action prepare-reset};Save-Probe 'failed-synthetic-power-allocations-identified' $value;exit 0}
  if($Phase -eq 'power-progress'){$value=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action inspect};Save-Probe 'native-power-progress-inspected' $value;exit 0}
  if($Phase -eq 'power-collect'){
   $value=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action collect}
   Assert-LabVM|Out-Null;Save-Probe 'native-power-evidence-collected' $value
   try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
   Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$clock=[Diagnostics.Stopwatch]::StartNew()
   do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'native-power-complete-and-evaluation-vm-off' $value;exit 0};if($clock.ElapsedMilliseconds -gt 120000){throw 'Evaluation shutdown not confirmed'};Start-Sleep -Seconds 2}while($true)
  }
 }
 if($Phase.StartsWith('resource-')){
  $operatorSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'clean-host-resource-operator.ps1')).Replace('__METRICS_SOURCE__',[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot '../../native/windows/ResourceMetrics.cs'))))
  if($Phase -eq 'resource-inspect'){$value=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action inspect -Nonce ('0'*64)};Save-Probe 'resource-progress-inspected' $value;exit 0}
  if($Phase -eq 'resource-collect'){
   $evidence=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action collect -Nonce ('0'*64)}
   Assert-LabVM | Out-Null;Save-Probe 'resource-evidence-collected' $evidence
   try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
   Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$clock=[Diagnostics.Stopwatch]::StartNew()
   do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'resources-complete-and-evaluation-vm-off' $evidence;exit 0};if($clock.ElapsedMilliseconds -gt 120000){throw 'Evaluation shutdown not confirmed'};Start-Sleep -Seconds 2}while($true)
  }
 }
 if($Phase -eq 'adoption-backup-gui-dialog-release'){
  $image=Get-ChildItem -LiteralPath $directoryPath -File -Filter 'console-*.png'|Sort-Object LastWriteTime -Descending|Select-Object -First 1
  if(-not $image -or $image.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddMinutes(-5)){throw 'A fresh independently observed VM console image is required'}
  $guard.PinInputFile($image.FullName);$hash=(Get-FileHash -LiteralPath $image.FullName).Hash.ToLowerInvariant()
  $value=Invoke-Command -Session $session -ArgumentList $hash -ScriptBlock {param($hash)$owner=[IO.File]::ReadAllText('C:\MuLab\public\adoption-backup-gui-owner.json')|ConvertFrom-Json;$request=[IO.File]::ReadAllText('C:\MuLab\public\backup-gui-dialog-request.json')|ConvertFrom-Json;if($request.nonce -cne $owner.nonce -or $request.action -notin @('export','restore') -or -not(Get-Process -Id $owner.pid -ErrorAction SilentlyContinue)){throw 'Native dialog owner changed'};$value=@{nonce=$owner.nonce;action=$request.action;imageSha256=$hash};[IO.File]::WriteAllText('C:\MuLab\approved\backup-gui-dialog-observed.json',($value|ConvertTo-Json -Compress));$value}
  $value.image=$image.FullName;Save-Probe 'native-backup-dialog-observation-recorded' $value;exit 0
 }
 if($Phase -in @('adoption-backup-progress','adoption-backup-gui-progress','adoption-backup-cross-progress')){
  $name=if($Phase -eq 'adoption-backup-cross-progress'){'adoption-backup-cross'}elseif($Phase -eq 'adoption-backup-gui-progress'){'adoption-backup-gui'}else{'adoption-backup-restore'}
  $value=Invoke-Command -Session $session -ArgumentList $name -ScriptBlock {
   param($name)
   $owner=[IO.File]::ReadAllText(('C:\MuLab\public\'+$name+'-owner.json'))|ConvertFrom-Json
   $p=Get-Process -Id $owner.pid -ErrorAction SilentlyContinue
   $result=$null;$file='C:\MuLab\public\'+$name+'-result.json'
   if(Test-Path -LiteralPath $file){$r=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json;if($r.nonce -eq $owner.nonce){$result=@{complete=$r.complete;checks=$r.checks;error=$r.error}}}
   $outputs=@(Get-ChildItem -LiteralPath C:\MuLab\public -File|Where-Object{$_.Name -match ('^(backup-restore-'+$owner.nonce+'\.mucwin|\.mucwin-partial-[a-f0-9-]{36})$')}|ForEach-Object{
    $length=$_.Length;try{$f=[IO.File]::Open($_.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete));try{$length=$f.Length}finally{$f.Dispose()}}catch{}
    @{name=$_.Name;bytes=$length}
   })
   $staging=@();$root=Join-Path C:\MuLab\public ('restored-runtime-'+$owner.nonce)
   if(Test-Path -LiteralPath $root){$staging=@(Get-ChildItem -LiteralPath $root -Directory -Filter 'backup-work-*'|ForEach-Object{$disk=Join-Path $_.FullName disk.vhdx;if(Test-Path -LiteralPath $disk){$length=(Get-Item -LiteralPath $disk).Length;try{$f=[IO.File]::Open($disk,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete));try{$length=$f.Length}finally{$f.Dispose()}}catch{};@{bytes=$length}}})}
   $sid=(Get-LocalUser MuLabUser).SID.Value;$registration=Get-ItemProperty -LiteralPath ('Registry::HKEY_USERS\'+$sid+'\Software\Microsoft\Windows\CurrentVersion\Uninstall\e88eb670-5944-5236-81aa-7c1d3da3d6df') -ErrorAction SilentlyContinue
   $dialog=$null;if(Test-Path -LiteralPath C:\MuLab\public\backup-gui-dialog-request.json){$r=[IO.File]::ReadAllText('C:\MuLab\public\backup-gui-dialog-request.json')|ConvertFrom-Json;if($r.nonce -ceq $owner.nonce){$dialog=$r}}
   $cross=$null;if($name -eq 'adoption-backup-cross'){$id=$owner.nonce.Substring(0,32);$configFile='C:\MuLab\approved\backup-user-'+$id+'-config.json';if(Test-Path -LiteralPath $configFile){$config=[IO.File]::ReadAllText($configFile)|ConvertFrom-Json;$steps=@();foreach($step in @('conflict','restore','recover')){$actor=$null;$r=$null;$ownerFile=Join-Path $config.directory ($step+'-owner.json');$resultFile=Join-Path $config.directory ($step+'-result.json');if(Test-Path -LiteralPath $ownerFile){$o=[IO.File]::ReadAllText($ownerFile)|ConvertFrom-Json;$actor=Get-Process -Id $o.pid -ErrorAction SilentlyContinue};if(Test-Path -LiteralPath $resultFile){$r=[IO.File]::ReadAllText($resultFile)|ConvertFrom-Json};$steps+=@{phase=$step;ownerAlive=[bool]$actor;cpuSeconds=$(if($actor){$actor.CPU}else{0});complete=$r.complete;error=$r.error}};$jobs=@();try{$script='const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[2],{readOnly:true});console.log(Buffer.from(JSON.stringify(db.prepare("SELECT action,status,message FROM jobs ORDER BY created_at DESC LIMIT 3").all())).toString("base64"));db.close();';$encoded=$script|& C:\MuLab\product\resources\node\node.exe --no-warnings - (Join-Path $config.directory app/state.sqlite);$jobs=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))|ConvertFrom-Json}catch{};$cross=@{userName=$config.userName;userSid=$config.userSid;targetEnabled=(Get-LocalUser $config.userName).Enabled;steps=$steps;jobs=$jobs}}}
   if($cross){$permissions=[IO.File]::ReadAllText(('C:\MuLab\private\backup-user-'+$id+'-permissions.json'))|ConvertFrom-Json;$cross.permissions=@(foreach($item in $permissions){$acl=Get-Acl -LiteralPath $item.path;@{path=$item.path;restored=($acl.Sddl -ceq $item.before);expectedTemporary=($acl.Sddl -ceq $item.after);current=$acl.Sddl;before=$item.before;after=$item.after}})}
   @{crossUser=$cross;dialogObservationRequest=$dialog;installation=@{present=[bool]$registration;version=[string]$registration.DisplayVersion;location=[string](Get-ItemProperty -LiteralPath ('Registry::HKEY_USERS\'+$sid+'\Software\e88eb670-5944-5236-81aa-7c1d3da3d6df') -ErrorAction SilentlyContinue).InstallLocation};ownerAlive=[bool]$p;cpuSeconds=$(if($p){$p.CPU}else{0});nestedVMs=@(Get-VM|Select-Object Name,@{Name='state';Expression={[string]$_.State}});outputs=$outputs;staging=$staging;result=$result}
  }
  Save-Probe 'backup-product-progress-inspected' $value;exit 0
 }
 if($Phase.StartsWith('adoption-')){
  Invoke-Command -Session $session -ScriptBlock {
   $clock=[Diagnostics.Stopwatch]::StartNew();do{$busy=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -like 'C:\MuLab\product\*' -or $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'});if(-not $busy.Count){break};if($clock.ElapsedMilliseconds -gt 10000){throw 'A product process is still active; inspect its original owner instead of replacing the payload'};Start-Sleep -Milliseconds 250}while($true)
  }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../dist-server') -Destination C:\MuLab\product\resources\app -ToSession $session -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-backup-restore-client.mjs') -Destination C:\MuLab\backup-restore-client.mjs -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-backup-product-client.mjs') -Destination C:\MuLab\backup-product-client.mjs -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-backup-installed-client.mjs') -Destination C:\MuLab\backup-installed-client.mjs -ToSession $session -Force
  if($Phase -eq 'adoption-backup-cross'){
   foreach($pair in @(@('clean-host-backup-cross-source.mjs','backup-cross-source.mjs'),@('clean-host-backup-cross-target.mjs','backup-cross-target.mjs'),@('BackupUserStation.cs','BackupUserStation.cs'))){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $pair[0]) -Destination ('C:\MuLab\'+$pair[1]) -ToSession $session -Force}
  }
  if($Phase -eq 'adoption-backup-gui'){
   Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-backup-gui-client.mjs') -Destination C:\MuLab\backup-gui-client.mjs -ToSession $session -Force
   Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-backup-gui.cjs') -Destination C:\MuLab\backup-gui.cjs -ToSession $session -Force
   Invoke-Command -Session $session -ScriptBlock {
    foreach($file in @('C:\MuLab\test-tools\playwright-core\index.mjs','C:\MuLab\test-tools\electron\electron.exe')){if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw 'The previously staged graphical test tools are required'}}
    $previous=[IO.File]::ReadAllText('C:\MuLab\approved\adoption-backup-restore-result.json')|ConvertFrom-Json;$n=$previous.nested
    if(-not $previous.complete -or -not $n.installedProductApiExercised -or $n.installedVersion -ne '0.4.66-preview.13' -or $n.installationNonce -notmatch '^[a-f0-9]{64}$'){throw 'A completed installed backup case is required'}
    $suffix=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('56iL5bqPIE8nQnJpZW4gJCDmtYvor5VcTXVDb2RlU2FuZGJveCBXaW5kb3dzIFByZXZpZXc='));$expected='C:\MuLab\public\backup-installed-'+$n.installationNonce+'\'+$suffix
    if([IO.Path]::GetFullPath($n.installedDirectory) -cne $expected -or [IO.Path]::GetFullPath($n.installedApp) -cne (Join-Path $expected resources/app)){throw 'Installed graphical payload identity changed'}
    $sid=(Get-LocalUser MuLabUser).SID.Value;$r=Get-ItemProperty -LiteralPath ('Registry::HKEY_USERS\'+$sid+'\Software\e88eb670-5944-5236-81aa-7c1d3da3d6df');if([IO.Path]::GetFullPath($r.InstallLocation) -cne $expected){throw 'Installed graphical registration changed'}
    [IO.File]::WriteAllText('C:\MuLab\approved\backup-gui-installation.json',($n|ConvertTo-Json -Depth 8 -Compress))
   }
  }
  if($Phase -eq 'adoption-backup-restore'){
   $package=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../.mu-data/windows-run/desktop-package.json') -Raw|ConvertFrom-Json
   if($package.stage.release.version -ne '0.4.66-preview.13'){throw 'The exact preview.13 installer is required'}
   $installer=@($package.artifacts|Where-Object{$_ -like '*.exe'})[0];$hash=(Get-FileHash -LiteralPath $installer).Hash.ToLowerInvariant()
   if($hash -ne 'f4a06ae77855a2ca25f67218551b67213e85982e4edde17171d70b95cd5e3baa'){throw 'Expected preview.13 artifact changed'}
   Copy-Item -LiteralPath $installer -Destination C:\MuLab\backup-preview13.exe -ToSession $session -Force
   Invoke-Command -Session $session -ArgumentList $hash -ScriptBlock {
    param($hash)
    if((Get-FileHash -LiteralPath C:\MuLab\backup-preview13.exe).Hash.ToLowerInvariant() -ne $hash){throw 'Transferred installer changed'}
    $meta=@{version='0.4.66-preview.13';sha256=$hash};$sid=(Get-LocalUser MuLabUser).SID.Value
    $registration=Get-ItemProperty -LiteralPath ('Registry::HKEY_USERS\'+$sid+'\Software\Microsoft\Windows\CurrentVersion\Uninstall\e88eb670-5944-5236-81aa-7c1d3da3d6df') -ErrorAction SilentlyContinue
    if($registration){
     $previous=Get-Content -LiteralPath C:\MuLab\approved\adoption-backup-restore-result.json -Raw|ConvertFrom-Json
     if($previous.complete -ne $false -or $previous.checks.Count -ne 1 -or $previous.nested -or $previous.error.code -ne 'ERR_ASSERTION' -or $previous.nonce -notmatch '^[a-f0-9]{64}$' -or (Get-Process -Id $previous.pid -ErrorAction SilentlyContinue)){throw 'Existing installation cannot be resumed from this receipt'}
     $suffix=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('56iL5bqPIE8nQnJpZW4gJCDmtYvor5VcTXVDb2RlU2FuZGJveCBXaW5kb3dzIFByZXZpZXc='))
     $expected="C:\MuLab\public\backup-installed-"+$previous.nonce+'\'+$suffix
     if($registration.DisplayVersion -ne $meta.version -or [IO.Path]::GetFullPath(([string](Get-ItemProperty -LiteralPath ('Registry::HKEY_USERS\'+$sid+'\Software\e88eb670-5944-5236-81aa-7c1d3da3d6df')).InstallLocation).Trim('"')).TrimEnd('\') -cne $expected){throw 'An unrelated existing installation was preserved'}
     $retained='C:\MuLab\private\backup-installed-failed-'+$previous.nonce+'.json'
     if(Test-Path -LiteralPath $retained){$saved=[IO.File]::ReadAllText($retained)|ConvertFrom-Json;if($saved.nonce -cne $previous.nonce -or $saved.pid -ne $previous.pid -or $saved.complete -ne $false -or $saved.checks.Count -ne 1 -or $saved.error.code -ne 'ERR_ASSERTION'){throw 'The retained failed receipt differs; inspect before retrying'}}else{[IO.File]::WriteAllText($retained,($previous|ConvertTo-Json -Depth 16 -Compress))}
     $meta.resumeInstallationPath=$expected.Replace('\','/');$meta.resumeInstallationNonce=$previous.nonce
    }
    [IO.File]::WriteAllText('C:\MuLab\approved\backup-installer.json',($meta|ConvertTo-Json -Compress))
   }
  }
  foreach($name in @('backup-bundle.js','runtime.js','recovery-candidates.js')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../../dist-server/server/platform/windows/'+$name)) -Destination ('C:\MuLab\product\resources\app\dist-server\server\platform\windows\'+$name) -ToSession $session -Force}
  $operatorSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'clean-host-adoption-operator.ps1'))
  if($Phase -eq 'adoption-inspect'){
   $value=Invoke-Command -Session $session -ScriptBlock {@{vms=@(Get-VM|Select-Object Name,@{Name='state';Expression={[string]$_.State}});clients=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object{$_.CommandLine -like '*client.mjs*adoption-*'}|Select-Object ProcessId,CreationDate);results=@(Get-ChildItem -LiteralPath C:\MuLab\public -File -Filter 'adoption-*-result.json'|ForEach-Object{Get-Content -LiteralPath $_.FullName -Raw|ConvertFrom-Json});errors=@(Get-ChildItem -LiteralPath C:\MuLab\private -File -Filter 'adoption-*-broker-stderr.log'|ForEach-Object{@{name=$_.Name;bytes=$_.Length;text=$(if($_.Length){try{Get-Content -LiteralPath $_.FullName -Raw}catch{'log is still open by a running process'}}else{''})}})}}
   $value.storageAcl=Invoke-Command -Session $session -ScriptBlock {$seed=Get-Content -LiteralPath C:\MuLab\approved\adoption-seed-result.json -Raw|ConvertFrom-Json;$sid=(Get-LocalUser MuLabUser).SID.Value;$dir=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid+'/vms/'+$seed.nested.config.id);foreach($file in @($dir,(Join-Path $dir disk.vhdx),(Join-Path $dir seed.iso))){if(Test-Path -LiteralPath $file){$acl=Get-Acl -LiteralPath $file;@{file=[IO.Path]::GetFileName($file);owner=$acl.Owner;rules=@($acl.Access|ForEach-Object{@{principal=$_.IdentityReference.Value;rights=[string]$_.FileSystemRights;type=[string]$_.AccessControlType}})}}}}
   $value.backupFiles=Invoke-Command -Session $session -ScriptBlock {@(Get-ChildItem -LiteralPath C:\MuLab\public -File -Filter 'backup-read-*'|ForEach-Object{$info=@{name=$_.Name;directoryLength=$_.Length;modifiedUtc=$_.LastWriteTimeUtc.ToString('o')};try{$file=[IO.File]::Open($_.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete));try{$info.openLength=$file.Length;$bytes=[byte[]]::new(8);$count=$file.Read($bytes,0,8);$info.encryptedHeader=($count -eq 8 -and [Text.Encoding]::ASCII.GetString($bytes) -eq 'MUCWIN01')}finally{$file.Dispose()}}catch{$info.openError=$_.Exception.Message};$info})}
   $value.backupProcesses=Invoke-Command -Session $session -ScriptBlock {@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -like '*client.mjs*adoption-backup*'}|ForEach-Object{$process=Get-Process -Id $_.ProcessId -ErrorAction Stop;@{pid=$process.Id;cpuSeconds=$process.CPU;workingSet=$process.WorkingSet64;responding=$process.Responding}})}
   Save-Probe 'adoption-progress-inspected' $value;exit 0
  }
  if($Phase -eq 'adoption-loss'){$value=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action loss};Save-Probe 'synthetic-copies-removed-for-explicit-adoption' $value;exit 0}
  if($Phase -in @('adoption-collect','adoption-ui-collect','adoption-backup-collect','adoption-backup-restore-collect','adoption-backup-gui-collect')){
   $action=if($Phase -eq 'adoption-backup-gui-collect'){'collect-backup-gui'}elseif($Phase -eq 'adoption-backup-restore-collect'){'collect-restore'}elseif($Phase -eq 'adoption-backup-collect'){'collect-backup'}elseif($Phase -eq 'adoption-ui-collect'){'collect-ui'}else{'collect'}
   $value=Invoke-Command -Session $session -ArgumentList $operatorSource,$action -ScriptBlock {param($source,$action) & ([ScriptBlock]::Create($source)) -Action $action}
   if($Phase -eq 'adoption-ui-collect'){$screenshot=$guard.Reserve(('recovery-ui-'+[guid]::NewGuid().ToString('N')+'.png'));Copy-Item -LiteralPath C:\MuLab\public\adoption-ui.png -Destination $screenshot -FromSession $session -Force;$value.screenshot=$screenshot}
   if($Phase -eq 'adoption-backup-gui-collect'){$screenshot=$guard.Reserve(('backup-gui-review-'+[guid]::NewGuid().ToString('N')+'.png'));Copy-Item -LiteralPath C:\MuLab\public\backup-gui-review.png -Destination $screenshot -FromSession $session -Force;$value.screenshot=$screenshot}
   Assert-LabVM | Out-Null;Save-Probe 'adoption-evidence-collected' $value
   try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
   Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$clock=[Diagnostics.Stopwatch]::StartNew()
   do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'adoption-complete-and-evaluation-vm-off' $value;exit 0};if($clock.ElapsedMilliseconds -gt 120000){throw 'Evaluation shutdown not confirmed'};Start-Sleep -Seconds 2}while($true)
  }
 }
 if($Phase -eq 'cache-inspect'){
  $evidence=Invoke-Command -Session $session -ScriptBlock {
   @{vms=@(Get-VM | Select-Object Name,@{Name='state';Expression={[string]$_.State}});receipts=@(Get-ChildItem -LiteralPath C:\MuLab\approved -File -Filter 'cache-*.json' | Select-Object Name,LastWriteTime);clients=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -like '*client.mjs*cache*'} | Select-Object ProcessId,CreationDate);result=$(if(Test-Path -LiteralPath C:\MuLab\public\cache-result.json){Get-Content C:\MuLab\public\cache-result.json -Raw | ConvertFrom-Json}else{$null})}
  }
  Save-Probe 'cache-progress-inspected' $evidence;exit 0
 }
 if($Phase -in @('cache-ui-stage','adoption-ui-stage')){
  # Retain older renderer evidence separately. Merging hashed asset directories
  # leaves stale executable files and cannot prove an exact current payload.
  Invoke-Command -Session $session -ScriptBlock {
   if($env:COMPUTERNAME -ne 'MU-CLEAN-LAB' -or @(Get-VM|Where-Object{$_.State -ne 'Off'}).Count){throw 'Renderer staging requires stopped diagnostic VMs'}
   $busy=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -like 'C:\MuLab\product\*' -or $_.ExecutablePath -like 'C:\MuLab\test-tools\electron\*' -or $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'})
   if($busy.Count){throw 'A diagnostic product process is still using the payload; inspect before restaging'}
   $renderer='C:\MuLab\product\resources\app\dist';if(Test-Path -LiteralPath $renderer){
    $entries=@(Get-Item -LiteralPath $renderer)+@(Get-ChildItem -LiteralPath $renderer -Recurse -Force);if(@($entries|Where-Object{$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Renderer archive rejects reparse entries'}
    $archive='C:\MuLab\private\renderer-before-stage-'+[guid]::NewGuid().ToString('N');[IO.Directory]::Move($renderer,$archive)
   }
   [void][IO.Directory]::CreateDirectory($renderer)
  }
  Invoke-Command -Session $session -ScriptBlock {[IO.Directory]::CreateDirectory('C:\MuLab\test-tools') | Out-Null}
  foreach($tool in @(@{source='../../node_modules/electron/dist';target='C:\MuLab\test-tools\electron';file='electron.exe'},@{source='../../node_modules/playwright-core';target='C:\MuLab\test-tools\playwright-core';file='index.mjs'})){
   $source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot $tool.source));$present=Invoke-Command -Session $session -ArgumentList $tool.target,$tool.file -ScriptBlock {param($root,$file) Test-Path -LiteralPath (Join-Path $root $file)}
   if(-not $present){Copy-Item -LiteralPath $source -Destination $tool.target -ToSession $session -Recurse}
  }
  $dist=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../dist'));foreach($file in @(Get-ChildItem -LiteralPath $dist -File -Recurse)){$relative=$file.FullName.Substring($dist.Length+1);$target='C:\MuLab\product\resources\app\dist\'+$relative;Invoke-Command -Session $session -ArgumentList ([IO.Path]::GetDirectoryName($target)) -ScriptBlock {param($path) [IO.Directory]::CreateDirectory($path) | Out-Null};Copy-Item -LiteralPath $file.FullName -Destination $target -ToSession $session -Force}
  $uiFiles=if($Phase -eq 'adoption-ui-stage'){@('clean-host-recovery-ui.cjs','clean-host-recovery-ui.mjs')}else{@('clean-host-cache-ui.cjs','clean-host-cache-ui.mjs')}
  foreach($name in $uiFiles){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination ('C:\MuLab\'+$name.Replace('clean-host-','')) -ToSession $session -Force}
  Save-Probe 'local-only-cache-ui-tools-staged';exit 0
 }
 if($Phase -in @('cache','cache-ui','cache-reset','cache-collect')){
  $operatorSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'clean-host-cache-operator.ps1'))
  if($Phase -eq 'cache-reset'){$value=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action reset -Nonce ('0'*64)};Save-Probe 'completed-cache-receipts-archived' $value;exit 0}
  if($Phase -eq 'cache-collect'){
   $evidence=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action collect -Nonce ('0'*64)}
   $screenshot=$guard.Reserve('cache-ui.png');Copy-Item -LiteralPath C:\MuLab\public\cache-ui.png -Destination $screenshot -FromSession $session -Force
   Assert-LabVM | Out-Null;Save-Probe 'cache-evidence-collected' $evidence
   try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
   Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$until=[DateTime]::UtcNow.AddMinutes(2)
   do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'cache-complete-and-evaluation-vm-off' $evidence;exit 0};if([DateTime]::UtcNow -gt $until){throw 'The evaluation VM has not confirmed shutdown'};Start-Sleep -Seconds 2}while($true)
  }
 }
 if($Phase.StartsWith('ledger-')){
  if($Phase -eq 'ledger-logon'){
   Invoke-Command -Session $session -ScriptBlock {
    $ErrorActionPreference='Stop';$node='C:\MuLab\product\resources\node\node.exe';$c=Get-Content -LiteralPath C:\MuLab\private\credentials.json -Raw | ConvertFrom-Json
    if(@(Get-VM).Count -or @(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $node -or $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'}).Count){throw 'Synthetic logon preparation requires no nested VM or live product process'}
    $task=Get-ScheduledTask -TaskName MuCleanHost-ledger-seed -ErrorAction SilentlyContinue
    if($task){if($task.State -eq 'Running' -or $task.Actions.Execute -ne $node -or $task.Actions.Arguments -ne '--no-warnings C:\MuLab\client.mjs ledger-seed'){throw 'Unexpected pending seed task'};Unregister-ScheduledTask -TaskName MuCleanHost-ledger-seed -Confirm:$false}
    $winlogon='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    foreach($pair in @(@('DefaultUserName',$c.user),@('DefaultDomainName',$env:COMPUTERNAME),@('DefaultPassword',$c.userPassword),@('AutoAdminLogon','1'))){Set-ItemProperty -LiteralPath $winlogon -Name $pair[0] -Value $pair[1] -Type String}
    Set-ItemProperty -LiteralPath $winlogon -Name AutoLogonCount -Value 2 -Type DWord
   }
   Save-Probe 'restarting-only-empty-evaluation-guest-for-synthetic-user-logon'
   try{Invoke-Command -Session $session -ScriptBlock {Restart-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
   exit 0
  }
  $operatorSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'clean-host-ledger-operator.ps1'))
  if($Phase -in @('ledger-primary-loss','ledger-primary-corrupt','ledger-both-loss','ledger-restore','ledger-orphan-create','ledger-collect')){
   $action=$Phase.Substring(7);$evidence=Invoke-Command -Session $session -ArgumentList $action,$operatorSource -ScriptBlock {param($action,$source) & ([ScriptBlock]::Create($source)) -Action $action}
   Assert-LabVM | Out-Null;Save-Probe 'ledger-operator-complete' $evidence
   if($Phase -eq 'ledger-collect'){
    try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
    Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$until=[DateTime]::UtcNow.AddMinutes(2)
    do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'ledger-complete-and-evaluation-vm-off' $evidence;exit 0};if([DateTime]::UtcNow -gt $until){throw 'The evaluation VM has not confirmed shutdown'};Start-Sleep -Seconds 2}while($true)
   }
   exit 0
  }
 }
 if($Phase -eq 'network-inspect'){
  $evidence=Invoke-Command -Session $session -ScriptBlock {$outer=Get-NetAdapter | Where-Object {$_.InterfaceDescription -eq 'Microsoft Hyper-V Network Adapter'};@{switches=@(Get-VMSwitch | Select-Object Name,Id,SwitchType);adapters=@(Get-NetAdapter -IncludeHidden | Select-Object Name,InterfaceGuid,InterfaceDescription,Status,MacAddress,ifIndex);outerDns=@(Get-DnsClientServerAddress -InterfaceIndex $outer.ifIndex | Select-Object AddressFamily,ServerAddresses);outerIp=@(Get-NetIPAddress -InterfaceIndex $outer.ifIndex | Select-Object AddressFamily,IPAddress,PrefixOrigin);outerDhcp=[string](Get-NetIPInterface -InterfaceIndex $outer.ifIndex -AddressFamily IPv4).Dhcp;nested=@(Get-VM | Select-Object Name,@{Name='state';Expression={[string]$_.State}});networkReceipts=@(Get-ChildItem -LiteralPath C:\MuLab\approved -File -Filter 'network-*.json' | Select-Object Name,LastWriteTime)}}
  Save-Probe 'network-inventory-complete' $evidence;exit 0
 }
 if($Phase -eq 'network-prepare'){
  $inputs=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../.mu-data/windows-run/clean-host-network-inputs.json') -Raw | ConvertFrom-Json
  $inputsDirectory=[IO.Path]::GetFullPath($inputs.directory)
  if([IO.Path]::GetDirectoryName($inputsDirectory) -ne [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.mu-data/windows-clean-host-assets')) -or [IO.Path]::GetFileName($inputsDirectory) -notmatch '^network-[a-f0-9-]{36}$'){throw 'Synthetic TLS fixture boundary changed'}
  foreach($name in @('fixture-key.pem','fixture-cert.pem','local-fixtures.js')){if((Get-FileHash -LiteralPath (Join-Path $inputsDirectory $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $inputs.hashes.$name){throw 'Synthetic TLS input changed'}}
  Invoke-Command -Session $session -ScriptBlock {if(@(Get-VM).Count -or (Get-VMSwitch -Name MuCleanNetwork -ErrorAction SilentlyContinue)){throw 'Network acceptance requires empty dedicated resources'};New-Item -ItemType Directory -Path C:\MuLab\network-fixtures -Force | Out-Null}
  foreach($name in @('fixture-key.pem','fixture-cert.pem')){Copy-Item -LiteralPath (Join-Path $inputsDirectory $name) -Destination ('C:\MuLab\network-fixtures\'+$name) -ToSession $session -Force}
  Copy-Item -LiteralPath (Join-Path $inputsDirectory 'local-fixtures.js') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\local-fixtures.js -ToSession $session -Force
  $outerAdapters=@(Get-VMNetworkAdapter -VM (Assert-LabVM));if($outerAdapters.Count -ne 1){throw 'Exactly one disconnected evaluation NIC is required'}
  $evidence=Invoke-Command -Session $session -ArgumentList $outerAdapters[0].MacAddress -ScriptBlock {
   param($mac) $ErrorActionPreference='Stop'
   if(Test-Path -LiteralPath C:\MuLab\approved\network-adapter.json){throw 'Network preparation evidence already exists; inspect it instead of replacing it'}
   $adapters=@(Get-NetAdapter | Where-Object {$_.MacAddress.Replace('-','') -eq $mac});if($adapters.Count -ne 1){throw 'Cannot uniquely bind the evaluation NIC'};$adapter=$adapters[0]
   $dhcp=[string](Get-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4).Dhcp
   $dns4=@((Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4).ServerAddresses);$dns6=@((Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv6).ServerAddresses)
   $legacy=@('fec0:0:0:ffff::1','fec0:0:0:ffff::2','fec0:0:0:ffff::3')
   if($adapter.Status -ne 'Disconnected' -or $dhcp -ne 'Enabled' -or $dns4.Count -or ($dns6.Count -and ($dns6 -join ',') -ne ($legacy -join ',')) -or @(Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.PrefixOrigin -eq 'Manual'}).Count){throw 'Only the unused DHCP evaluation NIC may be changed'}
   $record=@{interfaceGuid=[string]$adapter.InterfaceGuid;name=$adapter.Name;originalDhcp=$dhcp;originalDnsDefault=$true;originalDns6=$dns6;scope='the-outer-disconnected-nic-inside-the-windows-evaluation-guest'}
   [IO.File]::WriteAllText('C:\MuLab\approved\network-adapter.json',($record | ConvertTo-Json -Compress))
   New-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress 192.0.2.1 -PrefixLength 24 -AddressFamily IPv4 -PolicyStore ActiveStore | Out-Null
   return $record
  }
  Save-Probe 'synthetic-windows-network-prepared' $evidence;exit 0
 }
 if($Phase -eq 'network-collect'){
  $evidence=Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop';$result=Get-Content -LiteralPath C:\MuLab\approved\network-result.json -Raw | ConvertFrom-Json
   if(-not $result.complete -or -not $result.nested.removed -or @($result.nested.cases).Count -ne 3){throw 'All actual Windows network cases must pass'}
   $kinds=@($result.nested.cases | ForEach-Object {$_.kind} | Sort-Object);if(($kinds -join ',') -ne 'dns,link,route'){throw 'The three distinct Windows transitions are required'}
   foreach($case in $result.nested.cases){
    if(-not $case.started -or -not $case.detected -or -not $case.confirmedOff -or -not $case.removed){throw 'A Windows transition was not fully verified'}
    $receipt=Get-Content -LiteralPath ('C:\MuLab\approved\network-'+$case.kind+'-mutate.json') -Raw | ConvertFrom-Json
    if(-not $receipt.complete -or $receipt.nonce -ne $result.nonce -or $receipt.operation -ne 'mutate' -or $receipt.kind -ne $case.kind){throw 'The privileged network mutation receipt differs from the current owner result'}
   }
   if(@(Get-VM).Count){throw 'Nested VMs still remain'}
   $sid=(Get-LocalUser -Name MuLabUser).SID.Value;if(@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object {$_.SID.Value -eq $sid}).Count){throw 'The application user must remain ordinary'}
   $record=Get-Content -LiteralPath C:\MuLab\approved\network-adapter.json -Raw | ConvertFrom-Json
   $adapter=Get-NetAdapter -Name $record.name;if([string]$adapter.InterfaceGuid -ne $record.interfaceGuid -or $record.originalDhcp -ne 'Enabled' -or -not $record.originalDnsDefault){throw 'The diagnostic NIC identity changed'}
   if($adapter.Status -eq 'Disabled'){Enable-NetAdapter -Name $record.name -Confirm:$false}
   foreach($route in @(Get-NetRoute -InterfaceIndex $adapter.ifIndex -DestinationPrefix '198.51.100.0/24' -ErrorAction SilentlyContinue)){if($route.NextHop -ne '0.0.0.0' -or $route.RouteMetric -ne 1919){throw 'Unexpected synthetic route'};Remove-NetRoute -InputObject $route -Confirm:$false}
   Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress 192.0.2.1 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false
   Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -Dhcp Enabled;Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ResetServerAddresses
   if((Get-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4).Dhcp -ne 'Enabled' -or @(Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress 192.0.2.1 -ErrorAction SilentlyContinue).Count -or @((Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4).ServerAddresses).Count -or (@((Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv6).ServerAddresses) -join ',') -ne (@($record.originalDns6) -join ',')){throw 'Original diagnostic NIC configuration was not restored'}
   $hashes=@{};foreach($file in @('C:\MuLab\client.mjs','C:\MuLab\network-client.mjs','C:\MuLab\product\resources\app\dist-server\scripts\windows\local-fixtures.js','C:\MuLab\product\resources\app\dist-server\server\platform\windows\service.js','C:\MuLab\product\resources\app\dist-server\server\platform\windows\monitor.js','C:\MuLab\product\resources\app\dist-server\server\platform\windows\manager.js','C:\MuLab\product\resources\app\dist-server\server\platform\windows\runtime.js')){$hashes[$file]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
   @{result=$result;sourceHashes=$hashes;nestedGuestsRemaining=0;evaluationNicRestored=$true;physicalNetworkSwitchTested=$false;actualOsSleepTested=$false;aiWebsitesVisited=0}
  }
  Assert-LabVM | Out-Null;Save-Probe 'network-evidence-collected' $evidence
  try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
  Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$until=[DateTime]::UtcNow.AddMinutes(2)
  do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'network-complete-and-evaluation-vm-off' $evidence;exit 0};if([DateTime]::UtcNow -gt $until){throw 'The evaluation VM has not confirmed shutdown'};Start-Sleep -Seconds 2}while($true)
 }
 if($Phase -eq 'ssh-inspect'){
  $evidence=Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop'
   @{capability=[string](Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0').State;hyperV=[string](Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All).State;nestedGuests=@(Get-VM).Count;sshFile=(Test-Path -LiteralPath C:\Windows\System32\OpenSSH\ssh.exe);packages=@(Get-WindowsPackage -Online | Where-Object {$_.PackageName -match 'OpenSSH'} | Select-Object PackageName,PackageState);sources=@(Get-ChildItem -LiteralPath C:\Windows\servicing\Packages -Filter '*OpenSSH*' | Select-Object Name,Length);pendingReboot=(Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending');bootId=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');servicing=@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'} | Select-Object ProcessId)}
  }
  Save-Probe 'ssh-inventory-complete' $evidence;exit 0
 }
 if($Phase -eq 'ssh-remove'){
  Save-Probe 'removing-only-the-evaluation-guest-ssh-client'
  $removed=Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop'
   if(@(Get-VM).Count){throw 'The isolated evaluation guest must contain no nested VMs'}
   if(@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'}).Count){throw 'Windows servicing is still running'}
   $capability=Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0'
   if($capability.State -ne 'Installed'){throw 'Inspect the previous removal instead of repeating it'}
   if(Test-Path -LiteralPath C:\MuLab\approved\ssh-removal.json){throw 'SSH removal evidence already exists; inspect it before another attempt'}
   $startup='C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\MuCleanHostProbe.lnk'
   if(Test-Path -LiteralPath $startup){if(Test-Path -LiteralPath C:\MuLab\private\ssh-prior-startup.lnk){throw 'Prior startup evidence already exists'};Move-Item -LiteralPath $startup -Destination C:\MuLab\private\ssh-prior-startup.lnk}
   $before=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
   $r=Remove-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' -ErrorAction Stop
   $result=@{restartNeeded=[bool]$r.RestartNeeded;capability=[string](Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0').State;sshFile=(Test-Path -LiteralPath C:\Windows\System32\OpenSSH\ssh.exe);keygenFile=(Test-Path -LiteralPath C:\Windows\System32\OpenSSH\ssh-keygen.exe);bootBefore=$before;bootAfter=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');scope='only-disconnected-evaluation-guest'}
   [IO.File]::WriteAllText('C:\MuLab\approved\ssh-removal.json',($result | ConvertTo-Json -Compress));return $result
  }
  Save-Probe 'ssh-client-removed-from-evaluation-guest' $removed;exit 0
 }
 if($Phase -eq 'ssh-source'){
  # Fixed diagnostic-only source. Production servicing still uses Windows'
  # configured component source and never accepts caller-selected packages.
  $cab=Join-Path $PSScriptRoot '../../.mu-data/windows-clean-host-assets/fod-26100/OpenSSH-Client-Package~31bf3856ad364e35~amd64~~.cab'
  if((Get-FileHash -LiteralPath $cab -Algorithm SHA256).Hash.ToLowerInvariant() -ne '6d2259ebe546ff24c7a54fd40b8e14988b66dcc76968324c9839568d617e9256'){throw 'Pinned official client CAB changed'}
  Invoke-Command -Session $session -ScriptBlock {
   if(@(Get-VM).Count -or @(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'}).Count){throw 'Guests or servicing still remain'}
   if((Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0').State -ne 'NotPresent'){throw 'This test requires an actually missing client'}
   New-Item -ItemType Directory -Path C:\MuLab\private\fod -ErrorAction Stop | Out-Null
  }
  Copy-Item -LiteralPath $cab -Destination C:\MuLab\private\fod\OpenSSH-Client-Package~31bf3856ad364e35~amd64~~.cab -ToSession $session
  $evidence=Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop';$cab='C:\MuLab\private\fod\OpenSSH-Client-Package~31bf3856ad364e35~amd64~~.cab'
   if((Get-FileHash -LiteralPath $cab -Algorithm SHA256).Hash.ToLowerInvariant() -ne '6d2259ebe546ff24c7a54fd40b8e14988b66dcc76968324c9839568d617e9256'){throw 'Guest CAB digest mismatch'}
   $policy='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Servicing'
   if(Test-Path -LiteralPath $policy){throw 'Do not replace an existing component source policy'}
   New-Item -Path $policy -Force | Out-Null;New-ItemProperty -LiteralPath $policy -Name LocalSourcePath -Value C:\MuLab\private\fod -PropertyType ExpandString | Out-Null
   @{cabSha256='6d2259ebe546ff24c7a54fd40b8e14988b66dcc76968324c9839568d617e9256';source='Microsoft official Windows 11 24H2 FoD';policyScope='only-empty-evaluation-guest';productionScriptUnchanged=$true;networkDisconnected=$true}
  }
  Save-Probe 'offline-component-source-prepared' $evidence;exit 0
 }
 if($Phase -eq 'ssh-collect'){
  $evidence=Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop'
   $removed=Get-Content -LiteralPath C:\MuLab\approved\ssh-removal.json -Raw | ConvertFrom-Json
   $installed=Get-Content -LiteralPath C:\MuLab\approved\ssh-install-result.json -Raw | ConvertFrom-Json
   $ready=Get-Content -LiteralPath C:\MuLab\approved\ssh-ready-result.json -Raw | ConvertFrom-Json
   $sid=(Get-LocalUser -Name MuLabUser).SID.Value;$id=[guid]$installed.after.operation.id
   $job=Get-Content -LiteralPath (Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid+'/host-components/job-'+$id.ToString('D')+'.json')) -Raw | ConvertFrom-Json
   if(-not $installed.complete -or -not $ready.complete -or -not $installed.actualSshInstallationExercised -or -not $ready.nested.removed -or $job.status -ne 'completed' -or $job.changed -notcontains 'ssh-client' -or $removed.sshFile -or $removed.keygenFile){throw 'Actual missing-client installation and nested Linux acceptance must pass'}
   $offline=$null
   foreach($file in @(Get-ChildItem -LiteralPath C:\MuLab\private -File -Filter '*-ssh-install-result.json')){
    $prior=Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    if($prior.before.sshClientPresent -eq $false -and $prior.after.sshClientPresent -eq $false -and $prior.after.runtimeActive -eq $false -and $prior.after.operation.status -eq 'failed' -and $prior.after.operation.errorCode -eq -2145107924){
     $failedId=[guid]$prior.after.operation.id;$failedJob=Get-Content -LiteralPath (Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid+'/host-components/job-'+$failedId.ToString('D')+'.json')) -Raw | ConvertFrom-Json
     if($failedJob.status -eq 'failed' -and $failedJob.errorCode -eq -2145107924 -and $failedJob.bootId -eq $prior.before.bootId){$offline=@{operation=$prior.after.operation;runtimeActive=$false;ready=$false;protectedReceiptMatches=$true};break}
    }
   }
   if(-not $offline){throw 'The disconnected-source failure must also have a protected matching receipt'}
   if(@(Get-VM).Count -or @(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'}).Count){throw 'Nested guests or servicing still remain'}
   if(@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object {$_.SID.Value -eq $sid}).Count){throw 'The application user must remain a standard user'}
   $policy='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Servicing'
   $key=Get-Item -LiteralPath $policy
   if($key.GetValue('LocalSourcePath') -ne 'C:\MuLab\private\fod' -or @($key.GetValueNames()).Count -ne 1 -or $key.SubKeyCount){throw 'The synthetic component policy changed; preserve it for inspection'}
   Remove-Item -LiteralPath $policy
   $hashes=@{};foreach($file in @('C:\MuLab\client.mjs','C:\MuLab\product\resources\app\dist-server\scripts\windows\host-components.ps1','C:\MuLab\product\resources\app\dist-server\native\windows\HyperVBroker.cs')){$hashes[$file]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
   @{removed=$removed;installed=$installed;ready=$ready;offlineFailure=$offline;protectedJob=$job;sourceHashes=$hashes;syntheticSourcePolicyRemoved=$true;components=@{ssh=[string](Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0').State;sshFile=(Test-Path -LiteralPath C:\Windows\System32\OpenSSH\ssh.exe);keygenFile=(Test-Path -LiteralPath C:\Windows\System32\OpenSSH\ssh-keygen.exe)};nestedGuestsRemaining=0;applicationIsAdministrator=$false;aiWebsitesVisited=0}
  }
  Assert-LabVM | Out-Null;Save-Probe 'ssh-evidence-collected' $evidence
  try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
  Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$until=[DateTime]::UtcNow.AddMinutes(2)
  do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'ssh-complete-and-evaluation-vm-off' $evidence;exit 0};if([DateTime]::UtcNow -gt $until){throw 'The evaluation VM has not confirmed shutdown'};Start-Sleep -Seconds 2}while($true)
 }
 if($Phase -eq 'collect-stop'){
  $evidence=Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop';$before=Get-Content -LiteralPath C:\MuLab\approved\before-reboot-result.json -Raw | ConvertFrom-Json;$after=Get-Content -LiteralPath C:\MuLab\approved\after-reboot-result.json -Raw | ConvertFrom-Json
   if(-not $before.complete -or -not $after.complete -or $before.after.operation.status -ne 'completed' -or -not $after.nested.removed){throw 'Both verified phases and nested cleanup must pass'}
   if(@(Get-VM).Count){throw 'Nested guest resources remain'}
   if(@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'}).Count){throw 'Windows servicing is still running'}
   $admins=@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Select-Object -ExpandProperty SID | ForEach-Object {$_.Value});$userSid=(Get-LocalUser -Name MuLabUser).SID.Value;if($admins -contains $userSid){throw 'The application account must remain a standard user'}
   $hashes=@{};foreach($file in @('C:\MuLab\client.mjs','C:\MuLab\product\resources\node\node.exe','C:\MuLab\product\resources\app\dist-server\native\windows\HyperVBroker.cs','C:\MuLab\product\resources\app\dist-server\scripts\windows\host-components.ps1','C:\MuLab\product\resources\app\dist-server\server\platform\windows\runtime.js','C:\MuLab\product\resources\app\dist-server\server\platform\windows\broker.js')){$hashes[$file]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
   @{before=$before;after=$after;components=@{hyperV=[string](Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All).State;ssh=[string](Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0').State;vmms=[string](Get-Service vmms).Status};applicationIsAdministrator=$false;nestedGuestsRemaining=0;sourceHashes=$hashes;aiWebsitesVisited=0}
  }
  Assert-LabVM | Out-Null;Save-Probe 'evidence-collected' $evidence
  try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
  Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$until=[DateTime]::UtcNow.AddMinutes(2)
  do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'complete-and-evaluation-vm-off' $evidence;exit 0};if([DateTime]::UtcNow -gt $until){throw 'The evaluation VM has not confirmed shutdown'};Start-Sleep -Seconds 2}while($true)
 }
 if($Phase -eq 'reset-hyperv'){
  Save-Probe 'resetting-only-the-empty-evaluation-guest-role'
  try{Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop'
   if(@(Get-VM).Count){throw 'Nested guests must be removed before resetting this diagnostic role'}
   if(@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'}).Count){throw 'Windows component servicing is still running'}
   $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut('C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\MuCleanHostProbe.lnk');$link.Arguments='--no-warnings C:\MuLab\client.mjs before-reboot';$link.Save()
   Set-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name AutoLogonCount -Value 4 -Type DWord
   $result=Disable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -NoRestart -ErrorAction Stop
   [IO.File]::WriteAllText('C:\MuLab\public\reset-role.json',(@{nestedGuestsAbsent=$true;restartNeeded=[bool]$result.RestartNeeded;scope='only-this-evaluation-guest'} | ConvertTo-Json -Compress))
   Restart-Computer -Force
  }}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
  Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null
  $until=[DateTime]::UtcNow.AddMinutes(15)
  do{Start-Sleep -Seconds 5;try{$session=Connect-LabGuest;$boot=Invoke-Command -Session $session -ScriptBlock {(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')};if($boot -ne $initial.bootId){break};Remove-PSSession $session;$session=$null}catch{if($session){Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null}};if([DateTime]::UtcNow -gt $until){throw 'Evaluation role reset reboot has not completed'}}while($true)
  Save-Probe 'evaluation-role-reset-complete';exit 0
 }
 if($Phase -eq 'oobe'){
  Save-Probe 'preparing-supported-local-user-oobe'
  try{Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop';$c=Get-Content -LiteralPath C:\MuLab\private\credentials.json -Raw | ConvertFrom-Json
   $xml=@"
<?xml version="1.0" encoding="utf-8"?><unattend xmlns="urn:schemas-microsoft-com:unattend"><settings pass="oobeSystem"><component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><Reseal><Mode>OOBE</Mode><ForceShutdownNow>false</ForceShutdownNow></Reseal></component><component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><AutoLogon><Password><Value>$($c.userPassword)</Value><PlainText>true</PlainText></Password><Domain>MU-CLEAN-LAB</Domain><Username>$($c.user)</Username><Enabled>true</Enabled><LogonCount>3</LogonCount></AutoLogon><OOBE><HideEULAPage>true</HideEULAPage><HideOEMRegistrationScreen>true</HideOEMRegistrationScreen><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC></OOBE><TimeZone>UTC</TimeZone></component></settings></unattend>
"@
   [IO.File]::WriteAllText('C:\MuLab\private\oobe-unattend.xml',$xml,[Text.UTF8Encoding]::new($false))
   foreach($file in @('C:\Windows\Panther\Unattend\Unattend.xml','C:\Windows\Panther\Unattend.xml')){if(Test-Path -LiteralPath $file){Copy-Item -LiteralPath $file -Destination ('C:\MuLab\private\prior-audit-'+[guid]::NewGuid().ToString('N')+'.xml');Remove-Item -LiteralPath $file}}
   $task=Get-ScheduledTask -TaskName MuCleanHost-before-reboot -ErrorAction SilentlyContinue;if($task){if($task.State -eq 'Running'){throw 'Stop the synthetic probe before OOBE transition'};Unregister-ScheduledTask -TaskName MuCleanHost-before-reboot -Confirm:$false}
   $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut('C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\MuCleanHostProbe.lnk');$link.TargetPath='C:\MuLab\product\resources\node\node.exe';$link.Arguments='--no-warnings C:\MuLab\client.mjs before-reboot';$link.WorkingDirectory='C:\MuLab\public';$link.WindowStyle=7;$link.Save()
   foreach($process in @(Get-CimInstance Win32_Process -Filter "Name='sysprep.exe'")){if($process.ExecutablePath -eq 'C:\Windows\System32\Sysprep\sysprep.exe' -and $process.CommandLine -notmatch '/(oobe|audit|generalize|quiet)'){Stop-Process -Id $process.ProcessId -Force}}
   $started=Start-Process -FilePath C:\Windows\System32\Sysprep\sysprep.exe -ArgumentList @('/oobe','/reboot','/quiet','/unattend:C:\MuLab\private\oobe-unattend.xml') -WindowStyle Hidden -PassThru
   [IO.File]::WriteAllText('C:\MuLab\public\oobe-transition.json',(@{requested=$true;pid=$started.Id;syntheticStandardUser=$c.user} | ConvertTo-Json -Compress))
  }}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
  Save-Probe 'evaluation-guest-oobe-restart-requested';exit 0
 }
 if($Phase -eq 'inspect'){
  $diagnostic=Invoke-Command -Session $session -ScriptBlock {
   $tasks=@();foreach($name in @('MuCleanHost-before-reboot','MuCleanHost-after-reboot','MuCleanHost-ledger-seed','MuCleanHost-ledger-check','MuCleanHost-ledger-final','MuCleanHost-ledger-deny')){$task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;if($task){$info=Get-ScheduledTaskInfo -TaskName $name;$tasks+=@{name=$name;state=[string]$task.State;lastResult=$info.LastTaskResult;user=$task.Principal.UserId;runLevel=[string]$task.Principal.RunLevel;logonType=[string]$task.Principal.LogonType;execute=$task.Actions.Execute;arguments=$task.Actions.Arguments}}}
   $files=@();foreach($file in @('C:\MuLab','C:\MuLab\public','C:\MuLab\client.mjs','C:\MuLab\product\resources\node\node.exe','C:\MuLab\product\resources\app\dist-server\server\platform\windows\broker.js')){$acl=Get-Acl -LiteralPath $file;$files+=@{path=$file;protected=$acl.AreAccessRulesProtected;access=@($acl.Access | ForEach-Object {@{identity=$_.IdentityReference.Value;rights=[string]$_.FileSystemRights;type=[string]$_.AccessControlType;inherited=$_.IsInherited}})}}
   $logs=@();foreach($file in Get-ChildItem -LiteralPath C:\MuLab\public -File | Where-Object {$_.Name -like '*-stderr.log' -or $_.Name -like '*-stdout.log' -or $_.Name -like '*-launcher.json'}){$logs+=@{name=$file.Name;text=([IO.File]::ReadAllText($file.FullName)).Substring(0,[math]::Min(8000,$file.Length))}}
   $setup=Get-ItemProperty 'HKLM:\SYSTEM\Setup';$owner=$null;if(Test-Path -LiteralPath C:\MuLab\public\before-reboot-owner.json){$owner=Get-Content -LiteralPath C:\MuLab\public\before-reboot-owner.json -Raw | ConvertFrom-Json;$process=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$owner.pid);$owner=@{pid=$owner.pid;executable=$process.ExecutablePath;sid=$(if($process){(Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid}else{$null})}}
   $ledgerProcesses=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -like '*client.mjs*ledger-*'} | Select-Object ProcessId,CreationDate,ExecutablePath)
   $ledgerEvents=@(Get-WinEvent -FilterHashtable @{LogName='Application';StartTime=(Get-Date).AddMinutes(-15)} -ErrorAction SilentlyContinue | Where-Object {$_.Message -like '*node.exe*'} | Select-Object -First 4 Id,@{Name='message';Expression={$_.Message.Substring(0,[Math]::Min(1200,$_.Message.Length))}})
   @{tasks=$tasks;files=$files;logs=$logs;ledgerProcesses=$ledgerProcesses;ledgerEvents=$ledgerEvents;owner=$owner;loggedOnUser=(Get-CimInstance Win32_ComputerSystem).UserName;publicFiles=@(Get-ChildItem -LiteralPath C:\MuLab\public -File | Select-Object -ExpandProperty Name);users=@(Get-LocalUser -Name MuLabAdmin,MuLabUser | Select-Object Name,Enabled);groups=@(Get-LocalGroupMember -SID 'S-1-5-32-545' | Select-Object Name);setupInProgress=$setup.SystemSetupInProgress;auditInProgress=$setup.AuditInProgress;oobeInProgress=$setup.OOBEInProgress;sysprep=@(Get-CimInstance Win32_Process -Filter "Name='sysprep.exe'" | Select-Object ProcessId,CommandLine)}
  };Save-Probe 'inspected' @{initial=$initial;diagnostic=$diagnostic};exit 0
 }
 if($Phase -eq 'after-reboot'){
  $candidate=$null;foreach($file in @(Get-ChildItem -LiteralPath $directoryPath -File -Filter 'probe-*.json' | Sort-Object LastWriteTime -Descending)){$record=[IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json;if($record.phase -eq 'before-reboot' -and $record.result.complete -and $record.result.after.operation.status -eq 'completed'){$candidate=$record.result;break}}
  if(-not $candidate){throw 'A verified successful installation receipt is required'}
  $previous=Invoke-Command -Session $session -ArgumentList ($candidate | ConvertTo-Json -Depth 16 -Compress) -ScriptBlock {
   param($json) $r=$json | ConvertFrom-Json;$id=[guid]$r.after.operation.id;$sid=(Get-LocalUser -Name MuLabUser).SID.Value
   $job=Get-Content -LiteralPath (Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid+'/host-components/job-'+$id.ToString('D')+'.json')) -Raw | ConvertFrom-Json
   if($job.status -ne 'completed' -or $job.bootId -ne $r.before.bootId -or $job.changed -notcontains 'hyperv'){throw 'Protected Windows servicing receipt differs from the tested owner result'}
   New-Item -ItemType Directory -Path C:\MuLab\approved -Force | Out-Null;[IO.File]::WriteAllText('C:\MuLab\approved\before-reboot-result.json',$json);return $r
  }
  if(-not $previous.after.operation.changed.Contains('hyperv') -or $previous.after.operation.status -in @('starting','running')){throw 'A terminal actual Hyper-V installation receipt is required before the operator restart'}
  if($initial.bootId -eq $previous.before.bootId){
   Invoke-Command -Session $session -ScriptBlock {$shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut('C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\MuCleanHostProbe.lnk');$link.Arguments='--no-warnings C:\MuLab\client.mjs after-reboot';$link.Save()}
   Save-Probe 'operator-restarting-evaluation-guest'
   Assert-LabVM | Out-Null
   # This explicit diagnostic action restarts only the selected evaluation VM.
   # The application never performs this transition or reboots the host.
   try{Invoke-Command -Session $session -ScriptBlock {Restart-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
   Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null
   Start-Sleep -Seconds 5;$session=Connect-LabGuest
  }
 }
 Save-Probe 'preparing-standard-user-probe'
 if($Phase.StartsWith('upgrade-')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-upgrade-client.mjs') -Destination C:\MuLab\upgrade-client.mjs -ToSession $session -Force}
 if($Phase.StartsWith('power-')){
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-power-client.mjs') -Destination C:\MuLab\power-client.mjs -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'build-channel.ps1') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\build-channel.ps1 -ToSession $session -Force
  foreach($name in @('runtime.js','manager.js','service.js','power.js')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../../dist-server/server/platform/windows/'+$name)) -Destination ('C:\MuLab\product\resources\app\dist-server\server\platform\windows\'+$name) -ToSession $session -Force}
 }
 if($Phase.StartsWith('adoption-')){
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-backup-read-client.mjs') -Destination C:\MuLab\backup-read-client.mjs -ToSession $session -Force
  foreach($name in @('backup-reader.js','backup-archive.js')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../../dist-server/server/platform/windows/'+$name)) -Destination ('C:\MuLab\product\resources\app\dist-server\server\platform\windows\'+$name) -ToSession $session -Force}
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-adoption-client.mjs') -Destination C:\MuLab\adoption-client.mjs -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../dist-server/server/platform/windows/recovery.js') -Destination C:\MuLab\product\resources\app\dist-server\server\platform\windows\recovery.js -ToSession $session -Force
  if($Phase -eq 'adoption-ui'){foreach($name in @('recovery-service.js','recovery-candidates.js','recovery-wizard.js')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../../dist-server/server/platform/windows/'+$name)) -Destination ('C:\MuLab\product\resources\app\dist-server\server\platform\windows\'+$name) -ToSession $session -Force}}
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'hyperv.ps1') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\hyperv.ps1 -ToSession $session -Force
 }
 if($Phase -eq 'network'){Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-network-client.mjs') -Destination C:\MuLab\network-client.mjs -ToSession $session -Force}
 if($Phase.StartsWith('ledger-') -or $Phase.StartsWith('resource-') -or $Phase.StartsWith('adoption-') -or $Phase.StartsWith('power-') -or $Phase -in @('cache','cache-ui')){
  # The broker digest covers its full compilation recipe, including helpers
  # unused by the current phase. Never retain older digest inputs by omission.
  foreach($name in @('HyperVBroker.cs','SealedBases.cs','HostComponents.cs','ProtectedLedger.cs','ImageCache.cs','ResourceMetrics.cs','Resources.cs','DiskGrowth.cs','BackupRead.cs','BackupRestore.cs','BackupCursor.cs','Recovery.cs','RecoveryPermissions.cs','PowerWatch.cs','PowerProtection.cs','HyperVChannel.cs','RuntimeMetadataCleanup.cs')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../../native/windows/'+$name)) -Destination ('C:\MuLab\product\resources\app\dist-server\native\windows\'+$name) -ToSession $session -Force}
  foreach($name in @('hyperv.ps1','host-components.ps1','build-channel.ps1','build-broker.ps1','install-broker.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination ('C:\MuLab\product\resources\app\dist-server\scripts\windows\'+$name) -ToSession $session -Force}
  $sourcePackage=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../.mu-data/windows-run/desktop-package.json') -Raw|ConvertFrom-Json
  if($sourcePackage.stage.release){
   Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../dist-server/server/platform/windows/release.js') -Destination C:\MuLab\product\resources\app\dist-server\server\platform\windows\release.js -ToSession $session -Force
   Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../dist-server/shared/windows-release.js') -Destination C:\MuLab\product\resources\app\dist-server\shared\windows-release.js -ToSession $session -Force
   Copy-Item -LiteralPath (Join-Path $sourcePackage.stage.app 'dist-server/windows-release.json') -Destination C:\MuLab\product\resources\app\dist-server\windows-release.json -ToSession $session -Force
   Invoke-Command -Session $session -ArgumentList $sourcePackage.stage.release.version -ScriptBlock {param($version) $package=Get-Content -LiteralPath C:\MuLab\product\resources\app\package.json -Raw|ConvertFrom-Json;$package.version=$version;[IO.File]::WriteAllText('C:\MuLab\product\resources\app\package.json',($package|ConvertTo-Json -Depth 12 -Compress))}
  }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-ledger-client.mjs') -Destination C:\MuLab\ledger-client.mjs -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../native/windows/ProtectedLedger.cs') -Destination C:\MuLab\product\resources\app\dist-server\native\windows\ProtectedLedger.cs -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../native/windows/HostComponents.cs') -Destination C:\MuLab\product\resources\app\dist-server\native\windows\HostComponents.cs -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../native/windows/ImageCache.cs') -Destination C:\MuLab\product\resources\app\dist-server\native\windows\ImageCache.cs -ToSession $session -Force
  foreach($name in @('ResourceMetrics.cs','Resources.cs','DiskGrowth.cs','BackupRead.cs','BackupRestore.cs','BackupCursor.cs','Recovery.cs','RecoveryPermissions.cs','PowerWatch.cs','PowerProtection.cs','HyperVChannel.cs','RuntimeMetadataCleanup.cs')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../../native/windows/'+$name)) -Destination ('C:\MuLab\product\resources\app\dist-server\native\windows\'+$name) -ToSession $session -Force}
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'build-channel.ps1') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\build-channel.ps1 -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'build-broker.ps1') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\build-broker.ps1 -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../dist-server/server/platform/windows/broker.js') -Destination C:\MuLab\product\resources\app\dist-server\server\platform\windows\broker.js -ToSession $session -Force
  if($Phase -in @('cache','cache-ui')){
   Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-cache-client.mjs') -Destination C:\MuLab\cache-client.mjs -ToSession $session -Force
   Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'hyperv.ps1') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\hyperv.ps1 -ToSession $session -Force
   foreach($name in @('storage.js','service.js')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../../dist-server/server/platform/windows/'+$name)) -Destination ('C:\MuLab\product\resources\app\dist-server\server\platform\windows\'+$name) -ToSession $session -Force}
  }
  if($Phase.StartsWith('resource-')){
   Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-resource-client.mjs') -Destination C:\MuLab\resource-client.mjs -ToSession $session -Force
   Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'hyperv.ps1') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\hyperv.ps1 -ToSession $session -Force
   foreach($name in @('resources.js','runtime.js')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../../dist-server/server/platform/windows/'+$name)) -Destination ('C:\MuLab\product\resources\app\dist-server\server\platform\windows\'+$name) -ToSession $session -Force}
  }
 }
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-client.mjs') -Destination C:\MuLab\client.mjs -ToSession $session -Force
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../native/windows/HyperVBroker.cs') -Destination C:\MuLab\product\resources\app\dist-server\native\windows\HyperVBroker.cs -ToSession $session -Force
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'host-components.ps1') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\host-components.ps1 -ToSession $session -Force
 $servicingHash=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'host-components.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
 Invoke-Command -Session $session -ArgumentList $servicingHash -ScriptBlock {param($hash) if(-not (Test-Path -LiteralPath C:\MuLab\private\package-original.json)){Copy-Item -LiteralPath C:\MuLab\private\package.json -Destination C:\MuLab\private\package-original.json};$m=Get-Content -LiteralPath C:\MuLab\private\package.json -Raw | ConvertFrom-Json;$m.hostScriptSha256=$hash;$m | ConvertTo-Json -Compress | Set-Content -LiteralPath C:\MuLab\private\package.json}
 $crossOperator=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'clean-host-backup-cross-operator.ps1'))
 $result=Invoke-Command -Session $session -ArgumentList $Phase,$operatorSource,$crossOperator -ScriptBlock {
  param($phase,$operatorSource,$crossOperator)
  $ErrorActionPreference='Stop';$node='C:\MuLab\product\resources\node\node.exe'
  $manifest=Get-Content -LiteralPath C:\MuLab\private\package.json -Raw | ConvertFrom-Json
  if((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.nodeSha256){throw 'Packaged Node digest changed'}
  if((Get-FileHash -LiteralPath C:\MuLab\product\resources\app\dist-server\scripts\windows\host-components.ps1 -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.hostScriptSha256){throw 'Packaged servicing script changed'}
  if($phase -in @('before-reboot','after-reboot','ssh-install','ssh-ready','network','resource-seed','resource-disk','resource-memory','resource-recover','cache','cache-ui','ledger-seed','ledger-check','ledger-final','ledger-deny') -or $phase.StartsWith('resource-') -or $phase.StartsWith('adoption-') -or $phase.StartsWith('power-') -or $phase.StartsWith('upgrade-')){
   $build=@'
import {buildBroker} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/broker.js';
import {writeFile} from 'node:fs/promises';
await writeFile('C:/MuLab/private/artifact.json',JSON.stringify(await buildBroker('C:/MuLab/private/build')));
'@
   [IO.File]::WriteAllText('C:\MuLab\private\build.mjs',$build)
   $priorPreference=$ErrorActionPreference;$ErrorActionPreference='Continue';$buildOutput=@(& $node --no-warnings C:\MuLab\private\build.mjs 2>&1);$buildExit=$LASTEXITCODE;$ErrorActionPreference=$priorPreference
   $buildText=$buildOutput | Out-String;[IO.File]::WriteAllText(('C:\MuLab\private\'+$phase+'-build.log'),$buildText)
   if($buildExit -ne 0){throw ('Guest broker build failed: '+$buildText.Substring([Math]::Max(0,$buildText.Length-6000)))}
   $artifact=Get-Content -LiteralPath C:\MuLab\private\artifact.json -Raw | ConvertFrom-Json
   & ([ScriptBlock]::Create([IO.File]::ReadAllText('C:\MuLab\product\resources\app\dist-server\scripts\windows\install-broker.ps1'))) -Broker $artifact.broker -ExpectedBrokerHash $artifact.sha256 -Channel $artifact.channel -ExpectedChannelHash $artifact.channelSha256 -SourceDigest $artifact.sourceDigest
   if($LASTEXITCODE -ne 0){throw 'Guest protected broker installation failed'}
  }
  $c=Get-Content -LiteralPath C:\MuLab\private\credentials.json -Raw | ConvertFrom-Json
  $busy=@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'});if($busy.Count){throw 'Actual Windows servicing is still running; keep its owner and this VM alive'}
  $task='MuCleanHost-'+$phase;$old=Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  # The supported OOBE autologon opens the synthetic standard user's own
  # interactive desktop. Its fixed Startup link launches the ordinary client.
  $ownerClock=[Diagnostics.Stopwatch]::StartNew();$ownerFile='C:\MuLab\public\'+$phase+'-owner.json'
  $live=$false
  if(Test-Path -LiteralPath $ownerFile){$previousOwner=[IO.File]::ReadAllText($ownerFile) | ConvertFrom-Json;$previousProcess=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$previousOwner.pid);$live=$previousProcess -and $previousProcess.ExecutablePath -eq $node -and (Invoke-CimMethod -InputObject $previousProcess -MethodName GetOwnerSid).Sid -eq (Get-LocalUser -Name $c.user).SID.Value}
  if($old){
   if($old.Actions.Execute -ne $node -or $old.Principal.UserId -notin @($c.user,($env:COMPUTERNAME+'\'+$c.user),(Get-LocalUser -Name $c.user).SID.Value)){throw 'Existing diagnostic task identity changed'}
   if(-not $live){if($old.State -eq 'Running'){throw 'The previous diagnostic task is running without a verified owner; inspect it instead of restarting it'};Export-ScheduledTask -TaskName $task | Set-Content -LiteralPath ('C:\MuLab\private\'+$task+'-prior.xml');Unregister-ScheduledTask -TaskName $task -Confirm:$false}
  }
  if(-not $live){
   $attempt=[guid]::NewGuid().ToString('N');foreach($name in @(($phase+'-owner.json'),($phase+'-result.json'))){$file=Join-Path C:\MuLab\public $name;if(Test-Path -LiteralPath $file){Copy-Item -LiteralPath $file -Destination (Join-Path C:\MuLab\private ($attempt+'-'+$name));Remove-Item -LiteralPath $file}}
   $principal=New-ScheduledTaskPrincipal -UserId ($env:COMPUTERNAME+'\'+$c.user) -LogonType Interactive -RunLevel Limited
   $action=New-ScheduledTaskAction -Execute $node -Argument ('--no-warnings C:\MuLab\client.mjs '+$phase) -WorkingDirectory C:\MuLab\public
   $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromHours(2)) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;$settings.AllowDemandStart=$true
   Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(10)) | Out-Null;Start-ScheduledTask -TaskName $task
  }
  while(-not (Test-Path -LiteralPath $ownerFile)){
   if($ownerClock.ElapsedMilliseconds -gt 180000){throw 'The standard-user client did not start'};Start-Sleep -Milliseconds 250
  }
  $owner=[IO.File]::ReadAllText($ownerFile) | ConvertFrom-Json;$ownerPid=$owner.pid;$nonce=$owner.nonce
  if($nonce -notmatch '^[a-f0-9]{64}$' -or [int]$ownerPid -le 0){throw 'Invalid standard-user endpoint'}
  $process=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$ownerPid)
  $expected=(Get-LocalUser -Name MuLabUser).SID.Value
  if($process.ExecutablePath -ne 'C:\MuLab\product\resources\node\node.exe' -or (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid -ne $expected){throw 'The diagnostic owner must be the synthetic standard-user Node client'}
  $bin=Join-Path $env:ProgramData 'MuCodeSandbox-HyperVBroker-v1/bin';$meta=Get-Content -LiteralPath (Join-Path $bin 'current.json') -Raw | ConvertFrom-Json
  $broker=Join-Path $bin $meta.brokerFile
  if((Get-FileHash -LiteralPath $broker -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.brokerSha256){throw 'Protected broker digest mismatch'}
  if($phase -in @('adoption-review','adoption-ui')){
   $start=[Diagnostics.ProcessStartInfo]::new($broker,('--owner '+$ownerPid+' --pipe '+$nonce+' --detect-host'));$start.WorkingDirectory=$bin;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardError=$true;$start.RedirectStandardOutput=$true
   $ordinary=[Diagnostics.Process]::Start($start);if(-not $ordinary.WaitForExit(30000)){throw 'Normal startup did not refuse missing registration copies'};$failure=$ordinary.StandardError.ReadToEnd()
   [IO.File]::WriteAllText('C:\MuLab\private\adoption-default-denied.log',$failure)
   if($ordinary.ExitCode -ne 1 -or $failure -notlike '*Unregistered VM storage remains*'){throw 'Normal startup failed for an unexpected reason'}
   [IO.File]::WriteAllText('C:\MuLab\approved\adoption-default-denied.json',(@{nonce=$nonce;normalStartupRejected=$true}|ConvertTo-Json -Compress))
  }
  if($phase -eq 'ledger-deny'){
   # Retain the actual process handle when startup is expected to exit quickly.
   $start=[Diagnostics.ProcessStartInfo]::new($broker,('--owner '+$ownerPid+' --pipe '+$nonce+' --detect-host'));$start.WorkingDirectory=$bin;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardError=$true;$start.RedirectStandardOutput=$true
   $agent=[Diagnostics.Process]::Start($start)
   if(-not $agent.WaitForExit(30000)){throw 'The missing-registry broker did not refuse startup'}
   $brokerFailure=$agent.StandardError.ReadToEnd();[IO.File]::WriteAllText('C:\MuLab\private\ledger-deny-broker-stderr.log',$brokerFailure)
   if($agent.ExitCode -ne 1 -or $brokerFailure -notlike '*Unregistered VM storage remains*'){throw ('The broker failed for an unexpected reason (exit '+$agent.ExitCode+'): '+$brokerFailure)}
   & ([ScriptBlock]::Create($operatorSource)) -Action deny -Nonce $nonce | Out-Null
  }else{$agent=Start-Process -FilePath $broker -ArgumentList @('--owner',[string]$ownerPid,'--pipe',$nonce,$(if($phase -in @('adoption-review','adoption-approve','adoption-ui')){'--recover-storage'}else{'--detect-host'})) -WorkingDirectory $bin -WindowStyle Hidden -RedirectStandardOutput ('C:\MuLab\private\'+$phase+'-broker-stdout.log') -RedirectStandardError ('C:\MuLab\private\'+$phase+'-broker-stderr.log') -PassThru}
  $handled=@{}
  function Invoke-SyntheticNetworkRequests {
   $record=Get-Content -LiteralPath C:\MuLab\approved\network-adapter.json -Raw | ConvertFrom-Json
   $adapter=Get-NetAdapter -Name $record.name;if([string]$adapter.InterfaceGuid -ne $record.interfaceGuid){throw 'The synthetic interface changed'}
   foreach($kind in @('link','dns','route')){foreach($operation in @('reset','mutate')){
    $name='network-'+$kind+'-'+$operation;$file=Join-Path C:\MuLab\public ($name+'.json')
    if($handled.ContainsKey($name) -or -not (Test-Path -LiteralPath $file)){continue}
    $request=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json;if($request.nonce -ne $nonce){continue}
    if($request.kind -ne $kind -or $request.operation -ne $operation){throw 'Invalid synthetic network request'}
    if($operation -eq 'reset'){
     if($adapter.Status -eq 'Disabled'){Enable-NetAdapter -Name $record.name -Confirm:$false}
     Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ResetServerAddresses
     foreach($route in @(Get-NetRoute -InterfaceIndex $adapter.ifIndex -DestinationPrefix '198.51.100.0/24' -ErrorAction SilentlyContinue)){if($route.NextHop -ne '0.0.0.0' -or $route.RouteMetric -ne 1919){throw 'Unexpected synthetic route'};Remove-NetRoute -InputObject $route -Confirm:$false}
     Start-Sleep -Seconds 2
    }elseif($kind -eq 'link'){Disable-NetAdapter -Name $record.name -Confirm:$false}
    elseif($kind -eq 'dns'){Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ServerAddresses '203.0.113.53'}
    else{New-NetRoute -InterfaceIndex $adapter.ifIndex -DestinationPrefix '198.51.100.0/24' -NextHop '0.0.0.0' -RouteMetric 1919 -PolicyStore ActiveStore | Out-Null}
    [IO.File]::WriteAllText((Join-Path C:\MuLab\approved ($name+'.json')),(@{nonce=$nonce;kind=$kind;operation=$operation;complete=$true;scope='only-the-disconnected-nic-inside-the-windows-evaluation-guest'} | ConvertTo-Json -Compress));$handled[$name]=$true
   }}
  }
  $probeClock=[Diagnostics.Stopwatch]::StartNew();$resultFile='C:\MuLab\public\'+$phase+'-result.json'
  $ledgerInspected=$false
  do{
   if(Test-Path -LiteralPath $resultFile){$finished=[IO.File]::ReadAllText($resultFile) | ConvertFrom-Json;if($finished.pid -eq $ownerPid -and $finished.nonce -eq $nonce){
    New-Item -ItemType Directory -Path C:\MuLab\approved -Force | Out-Null;[IO.File]::WriteAllText(('C:\MuLab\approved\'+$phase+'-result.json'),($finished | ConvertTo-Json -Depth 16 -Compress))
    if($phase -eq 'ledger-check' -and $finished.complete){$scenario=$finished.nested.scenario;if($scenario -notin @('primary-loss','primary-corrupt')){throw 'Unexpected ledger recovery scenario'};[IO.File]::WriteAllText(('C:\MuLab\approved\ledger-'+$scenario+'-result.json'),($finished | ConvertTo-Json -Depth 16 -Compress))}
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue;return $finished
   }}
   if($agent.HasExited -and $phase -ne 'ledger-deny'){throw ('Protected broker exited: '+[IO.File]::ReadAllText(('C:\MuLab\private\'+$phase+'-broker-stderr.log')))}
   if($probeClock.ElapsedMilliseconds -gt 3900000){throw 'Servicing or the client is still running; no process or VM was stopped'}
   if($phase -eq 'network'){Invoke-SyntheticNetworkRequests}
   if($phase -eq 'power-run' -and -not $handled.ContainsKey('native-pause') -and (Test-Path -LiteralPath C:\MuLab\public\power-pause-request.json)){
    $request=Get-Content -LiteralPath C:\MuLab\public\power-pause-request.json -Raw|ConvertFrom-Json;if($request.nonce -eq $nonce){& ([ScriptBlock]::Create($operatorSource)) -Action broker-pause -Nonce $nonce -OwnerPid $ownerPid|Out-Null;$handled['native-pause']=$true}
   }
   if($phase -in @('adoption-review','adoption-approve','adoption-ui','adoption-backup-restore','adoption-backup-gui')){
    foreach($action in @('inspect-plan','inspect-material-known-hosts','inspect-material-manifest','inspect-material-DPAPI','change-seed','restore-seed','break-acl','restore-acl','break-permissions','restore-permissions','add-dependency','remove-dependency','inspect-adopted','preserve-restore-source','verify-preserved-source')){
     $name='adoption-'+$action;$file='C:\MuLab\public\'+$name+'-request.json'
     if(-not $handled.ContainsKey($name) -and (Test-Path -LiteralPath $file)){$request=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json;if($request.nonce -eq $nonce){if($request.action -ne $action){throw 'Unexpected adoption operator action'};& ([ScriptBlock]::Create($operatorSource)) -Action $action -Nonce $nonce|Out-Null;$handled[$name]=$true}}
    }
   }
   if($phase -eq 'adoption-backup-cross'){
    foreach($action in @('cross-prepare','cross-conflict','cross-restore','cross-final','preserve-restore-source','verify-preserved-source')){
     $name='adoption-'+$action;$file='C:\MuLab\public\'+$name+'-request.json'
     if(-not $handled.ContainsKey($name) -and (Test-Path -LiteralPath $file)){$request=[IO.File]::ReadAllText($file)|ConvertFrom-Json;if($request.nonce -ceq $nonce){if($request.action -ne $action){throw 'Unexpected cross-user action'};if($action.StartsWith('cross-')){& ([ScriptBlock]::Create($crossOperator)) -Action $action -Nonce $nonce|Out-Null}else{& ([ScriptBlock]::Create($operatorSource)) -Action $action -Nonce $nonce|Out-Null};$handled[$name]=$true}}
    }
   }
   if($phase -in @('cache','cache-ui')){
    foreach($action in @('seed','change','hold','remove-control','ui-seed','ui-change','permissions')){
     $name='cache-'+$action;$file='C:\MuLab\public\'+$name+'-request.json'
     if(-not $handled.ContainsKey($name) -and (Test-Path -LiteralPath $file)){
      $request=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
      if($request.nonce -eq $nonce){if($request.action -ne $action){throw 'Unexpected cache operator request'};& ([ScriptBlock]::Create($operatorSource)) -Action $action -Nonce $nonce | Out-Null;$handled[$name]=$true}
     }
    }
   }
   if($phase.StartsWith('resource-')){
    foreach($action in @('hold-start','disk','memory')){
     $name='resource-'+$action;$file='C:\MuLab\public\'+$name+'-request.json'
     if(-not $handled.ContainsKey($name) -and (Test-Path -LiteralPath $file)){$request=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json;if($request.nonce -eq $nonce){if($request.action -ne $action){throw 'Unexpected pressure operator action'};& ([ScriptBlock]::Create($operatorSource)) -Action $action -Nonce $nonce | Out-Null;$handled[$name]=$true}}
    }
   }
   if($phase -in @('ledger-check','ledger-final') -and -not $ledgerInspected -and (Test-Path -LiteralPath C:\MuLab\public\ledger-inspect-request.json)){
    $request=Get-Content -LiteralPath C:\MuLab\public\ledger-inspect-request.json -Raw | ConvertFrom-Json
    if($request.nonce -eq $nonce){& ([ScriptBlock]::Create($operatorSource)) -Action inspect -Nonce $nonce | Out-Null;$ledgerInspected=$true}
   }
   Start-Sleep -Seconds 2
  }while($true)
 }
 Assert-LabVM | Out-Null;Save-Probe 'finished' $result;if(-not $result.complete){exit 2};exit 0
}catch{Save-Probe 'failed' @{message=$_.Exception.Message;detail=$_.Exception.ToString();scriptStack=$_.ScriptStackTrace};throw}
finally{if($session){Remove-PSSession $session -ErrorAction SilentlyContinue};$guard.Dispose()}
