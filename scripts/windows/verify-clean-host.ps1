#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Directory,[Parameter(Mandatory)][int]$OwnerPid,[Parameter(Mandatory)][ValidateSet('before-reboot','after-reboot','inspect','oobe','reset-hyperv','collect-stop')][string]$Phase)
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
 Assert-LabVM | Out-Null;Save-Probe 'connecting'
 $session=Connect-LabGuest
 $initial=Invoke-Command -Session $session -ScriptBlock {
  if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Synthetic guest administrator required'}
  if(-not (Test-Path -LiteralPath C:\MuLab\public\provisioned.json)){throw 'Guest bootstrap is incomplete'}
  [ordered]@{bootId=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');hypervisor=[bool](Get-CimInstance Win32_ComputerSystem).HypervisorPresent;edition=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID}
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
   $tasks=@();foreach($name in @('MuCleanHost-before-reboot','MuCleanHost-after-reboot')){$task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;if($task){$info=Get-ScheduledTaskInfo -TaskName $name;$tasks+=@{name=$name;state=[string]$task.State;lastResult=$info.LastTaskResult;user=$task.Principal.UserId;runLevel=[string]$task.Principal.RunLevel;execute=$task.Actions.Execute;arguments=$task.Actions.Arguments}}}
   $files=@();foreach($file in @('C:\MuLab','C:\MuLab\public','C:\MuLab\client.mjs','C:\MuLab\product\resources\node\node.exe','C:\MuLab\product\resources\app\dist-server\server\platform\windows\broker.js')){$acl=Get-Acl -LiteralPath $file;$files+=@{path=$file;protected=$acl.AreAccessRulesProtected;access=@($acl.Access | ForEach-Object {@{identity=$_.IdentityReference.Value;rights=[string]$_.FileSystemRights;type=[string]$_.AccessControlType;inherited=$_.IsInherited}})}}
   $logs=@();foreach($file in Get-ChildItem -LiteralPath C:\MuLab\public -File | Where-Object {$_.Name -like '*-stderr.log' -or $_.Name -like '*-stdout.log' -or $_.Name -like '*-launcher.json'}){$logs+=@{name=$file.Name;text=([IO.File]::ReadAllText($file.FullName)).Substring(0,[math]::Min(8000,$file.Length))}}
   $setup=Get-ItemProperty 'HKLM:\SYSTEM\Setup';$owner=$null;if(Test-Path -LiteralPath C:\MuLab\public\before-reboot-owner.json){$owner=Get-Content -LiteralPath C:\MuLab\public\before-reboot-owner.json -Raw | ConvertFrom-Json;$process=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$owner.pid);$owner=@{pid=$owner.pid;executable=$process.ExecutablePath;sid=$(if($process){(Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid}else{$null})}}
   @{tasks=$tasks;files=$files;logs=$logs;owner=$owner;loggedOnUser=(Get-CimInstance Win32_ComputerSystem).UserName;publicFiles=@(Get-ChildItem -LiteralPath C:\MuLab\public -File | Select-Object -ExpandProperty Name);users=@(Get-LocalUser -Name MuLabAdmin,MuLabUser | Select-Object Name,Enabled);groups=@(Get-LocalGroupMember -SID 'S-1-5-32-545' | Select-Object Name);setupInProgress=$setup.SystemSetupInProgress;auditInProgress=$setup.AuditInProgress;oobeInProgress=$setup.OOBEInProgress;sysprep=@(Get-CimInstance Win32_Process -Filter "Name='sysprep.exe'" | Select-Object ProcessId,CommandLine)}
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
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-client.mjs') -Destination C:\MuLab\client.mjs -ToSession $session -Force
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../native/windows/HyperVBroker.cs') -Destination C:\MuLab\product\resources\app\dist-server\native\windows\HyperVBroker.cs -ToSession $session -Force
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'host-components.ps1') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\host-components.ps1 -ToSession $session -Force
 $servicingHash=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'host-components.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
 Invoke-Command -Session $session -ArgumentList $servicingHash -ScriptBlock {param($hash) if(-not (Test-Path -LiteralPath C:\MuLab\private\package-original.json)){Copy-Item -LiteralPath C:\MuLab\private\package.json -Destination C:\MuLab\private\package-original.json};$m=Get-Content -LiteralPath C:\MuLab\private\package.json -Raw | ConvertFrom-Json;$m.hostScriptSha256=$hash;$m | ConvertTo-Json -Compress | Set-Content -LiteralPath C:\MuLab\private\package.json}
 $result=Invoke-Command -Session $session -ArgumentList $Phase -ScriptBlock {
  param($phase)
  $ErrorActionPreference='Stop';$node='C:\MuLab\product\resources\node\node.exe'
  $manifest=Get-Content -LiteralPath C:\MuLab\private\package.json -Raw | ConvertFrom-Json
  if((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.nodeSha256){throw 'Packaged Node digest changed'}
  if((Get-FileHash -LiteralPath C:\MuLab\product\resources\app\dist-server\scripts\windows\host-components.ps1 -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.hostScriptSha256){throw 'Packaged servicing script changed'}
  if($phase -in @('before-reboot','after-reboot')){
   $build=@'
import {buildBroker} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/broker.js';
import {writeFile} from 'node:fs/promises';
await writeFile('C:/MuLab/private/artifact.json',JSON.stringify(await buildBroker('C:/MuLab/private/build')));
'@
   [IO.File]::WriteAllText('C:\MuLab\private\build.mjs',$build)
   & $node --no-warnings C:\MuLab\private\build.mjs
   if($LASTEXITCODE -ne 0){throw 'Guest broker build failed'}
   $artifact=Get-Content -LiteralPath C:\MuLab\private\artifact.json -Raw | ConvertFrom-Json
   & ([ScriptBlock]::Create([IO.File]::ReadAllText('C:\MuLab\product\resources\app\dist-server\scripts\windows\install-broker.ps1'))) -Broker $artifact.broker -ExpectedBrokerHash $artifact.sha256 -Channel $artifact.channel -ExpectedChannelHash $artifact.channelSha256 -SourceDigest $artifact.sourceDigest
   if($LASTEXITCODE -ne 0){throw 'Guest protected broker installation failed'}
  }
  $c=Get-Content -LiteralPath C:\MuLab\private\credentials.json -Raw | ConvertFrom-Json
  $busy=@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'});if($busy.Count){throw 'Actual Windows servicing is still running; keep its owner and this VM alive'}
  foreach($process in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.ExecutablePath -eq $node -and $_.CommandLine -match ('client\.mjs\s+'+[regex]::Escape($phase)+'(?:\s|$)')})){if((Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid -eq (Get-LocalUser -Name $c.user).SID.Value){Stop-Process -Id $process.ProcessId -Force}}
  $task='MuCleanHost-'+$phase;$old=Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  if($old){if($old.Actions.Execute -ne $node -or $old.Principal.UserId -notin @($c.user,($env:COMPUTERNAME+'\'+$c.user),(Get-LocalUser -Name $c.user).SID.Value)){throw 'Existing diagnostic task identity changed'};Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue;Export-ScheduledTask -TaskName $task | Set-Content -LiteralPath ('C:\MuLab\private\'+$task+'-prior.xml');Unregister-ScheduledTask -TaskName $task -Confirm:$false}
  # The supported OOBE autologon opens the synthetic standard user's own
  # interactive desktop. Its fixed Startup link launches the ordinary client.
  $until=[DateTime]::UtcNow.AddMinutes(3);$ownerFile='C:\MuLab\public\'+$phase+'-owner.json'
  $live=$false
  if(Test-Path -LiteralPath $ownerFile){$previousOwner=[IO.File]::ReadAllText($ownerFile) | ConvertFrom-Json;$previousProcess=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$previousOwner.pid);$live=$previousProcess -and $previousProcess.ExecutablePath -eq $node -and (Invoke-CimMethod -InputObject $previousProcess -MethodName GetOwnerSid).Sid -eq (Get-LocalUser -Name $c.user).SID.Value}
  if(-not $live){
   $attempt=[guid]::NewGuid().ToString('N');foreach($name in @(($phase+'-owner.json'),($phase+'-result.json'))){$file=Join-Path C:\MuLab\public $name;if(Test-Path -LiteralPath $file){Copy-Item -LiteralPath $file -Destination (Join-Path C:\MuLab\private ($attempt+'-'+$name));Remove-Item -LiteralPath $file}}
   $principal=New-ScheduledTaskPrincipal -UserId ($env:COMPUTERNAME+'\'+$c.user) -LogonType Interactive -RunLevel Limited
   $action=New-ScheduledTaskAction -Execute $node -Argument ('--no-warnings C:\MuLab\client.mjs '+$phase) -WorkingDirectory C:\MuLab\public
   $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromHours(2)) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;$settings.AllowDemandStart=$true
   Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(10)) | Out-Null;Start-ScheduledTask -TaskName $task
  }
  while(-not (Test-Path -LiteralPath $ownerFile)){
   if([DateTime]::UtcNow -gt $until){throw 'The standard-user client did not start'};Start-Sleep -Milliseconds 250
  }
  $owner=[IO.File]::ReadAllText($ownerFile) | ConvertFrom-Json;$ownerPid=$owner.pid;$nonce=$owner.nonce
  if($nonce -notmatch '^[a-f0-9]{64}$' -or [int]$ownerPid -le 0){throw 'Invalid standard-user endpoint'}
  $process=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$ownerPid)
  $expected=(Get-LocalUser -Name MuLabUser).SID.Value
  if($process.ExecutablePath -ne 'C:\MuLab\product\resources\node\node.exe' -or (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid -ne $expected){throw 'The diagnostic owner must be the synthetic standard-user Node client'}
  $bin=Join-Path $env:ProgramData 'MuCodeSandbox-HyperVBroker-v1/bin';$meta=Get-Content -LiteralPath (Join-Path $bin 'current.json') -Raw | ConvertFrom-Json
  $broker=Join-Path $bin $meta.brokerFile
  if((Get-FileHash -LiteralPath $broker -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.brokerSha256){throw 'Protected broker digest mismatch'}
  $agent=Start-Process -FilePath $broker -ArgumentList @('--owner',[string]$ownerPid,'--pipe',$nonce,'--detect-host') -WorkingDirectory $bin -WindowStyle Hidden -RedirectStandardOutput ('C:\MuLab\private\'+$phase+'-broker-stdout.log') -RedirectStandardError ('C:\MuLab\private\'+$phase+'-broker-stderr.log') -PassThru
  $until=[DateTime]::UtcNow.AddMinutes(65);$resultFile='C:\MuLab\public\'+$phase+'-result.json'
  do{if(Test-Path -LiteralPath $resultFile){$finished=[IO.File]::ReadAllText($resultFile) | ConvertFrom-Json;if($finished.pid -eq $ownerPid -and $finished.nonce -eq $nonce){New-Item -ItemType Directory -Path C:\MuLab\approved -Force | Out-Null;[IO.File]::WriteAllText(('C:\MuLab\approved\'+$phase+'-result.json'),($finished | ConvertTo-Json -Depth 16 -Compress));Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue;return $finished}};if($agent.HasExited){throw ('Protected broker exited: '+[IO.File]::ReadAllText(('C:\MuLab\private\'+$phase+'-broker-stderr.log')))};if([DateTime]::UtcNow -gt $until){throw 'Servicing or the client is still running; no process or VM was stopped'};Start-Sleep -Seconds 2}while($true)
 }
 Assert-LabVM | Out-Null;Save-Probe 'finished' $result;if(-not $result.complete){exit 2};exit 0
}catch{Save-Probe 'failed' @{message=$_.Exception.Message};throw}
finally{if($session){Remove-PSSession $session -ErrorAction SilentlyContinue};$guard.Dispose()}
