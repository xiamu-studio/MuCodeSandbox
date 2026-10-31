#Requires -RunAsAdministrator
param([Parameter(Mandatory)][string]$Directory,[Parameter(Mandatory)][int]$OwnerPid,[ValidateSet('run','inspect','resources','retry-start','retry-stage')][string]$Action,[string]$CaseId)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs');$guard=[MuPacketLabGuard]::new($OwnerPid,[IO.Path]::GetFullPath($Directory));$report=$guard.Reserve('backup-boundary-'+[guid]::NewGuid().ToString('N')+'.json');$session=$null
function Save($state,$value){[IO.File]::WriteAllText($report,(@{state=$state;time=[DateTime]::UtcNow.ToString('o');caseId=$CaseId;result=$value}|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))}
try{
 $m=$guard.ReadCommand('machine.json')|ConvertFrom-Json;$config=$guard.ReadCommand('config.json')|ConvertFrom-Json;$credentials=$guard.ReadGuestCredentials()|ConvertFrom-Json;$vm=Get-VM -Id ([guid]$m.id);$drives=@(Get-VMHardDiskDrive -VM $vm)
 if($config.flavor -ne 'pro26300' -or $vm.Name -ne $m.name -or $vm.Name -ne $config.name -or $vm.Name -notmatch '^mu-win-pro-[a-f0-9]{32}$' -or $vm.Notes -ne ('MuCodeSandbox isolated Pro diagnostic '+$vm.Name) -or $drives.Count -ne 1 -or [IO.Path]::GetFullPath($drives[0].Path) -cne [IO.Path]::GetFullPath((Join-Path $Directory trace-artifacts/windows.vhdx)) -or @(Get-VMNetworkAdapter -VM $vm|Where-Object SwitchName).Count){throw 'Independent disconnected Pro identity changed'}
 if($Action -eq 'resources'){$memory=Get-VMMemory -VM $vm;$os=Get-CimInstance Win32_OperatingSystem;Save 'resources-inspected' @{state=[string]$vm.State;startupBytes=$memory.Startup;dynamic=$memory.DynamicMemoryEnabled;hostFreeBytes=([long]$os.FreePhysicalMemory*1024);hostTotalBytes=([long]$os.TotalVisibleMemorySize*1024)};exit 0}
 if($Action -in @('run','retry-start') -and $vm.State -eq 'Off'){Start-VM -VM $vm|Out-Null;$vm=Get-VM -Id $vm.Id}
 if($vm.State -ne 'Running'){Save 'pro-off' @{state=[string]$vm.State};exit 0}
 Save 'connecting' @{proName=$vm.Name};$credential=[pscredential]::new($credentials.adminUser,(ConvertTo-SecureString $credentials.adminPassword -AsPlainText -Force));$until=[DateTime]::UtcNow.AddMinutes(8)
 do{try{$session=New-PSSession -VMId $vm.Id -Credential $credential;break}catch{if([DateTime]::UtcNow -gt $until){throw 'PowerShell Direct pending; Pro retained'};Start-Sleep -Seconds 2}}while($true)
 if($Action -eq 'inspect'){
  $r=Invoke-Command -Session $session -ScriptBlock {
   @{installationErrors=$(if(Test-Path -LiteralPath (Join-Path $env:ProgramData MuCodeSandbox-HyperVBroker-v1/install-errors.log)){@(Get-Content -LiteralPath (Join-Path $env:ProgramData MuCodeSandbox-HyperVBroker-v1/install-errors.log) -Tail 8 -Encoding UTF8)});pointer=$(if(Test-Path -LiteralPath (Join-Path $env:ProgramData MuCodeSandbox-HyperVBroker-v1/bin/current.json)){[IO.File]::ReadAllText((Join-Path $env:ProgramData MuCodeSandbox-HyperVBroker-v1/bin/current.json))|ConvertFrom-Json});vms=@(Get-VM|Select-Object Name,@{Name='state';Expression={[string]$_.State}});processes=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker*' -or $_.ExecutablePath -like 'C:\MuLab\product\*' -or $_.ExecutablePath -like 'C:\MuLab\private\boundary-*'}|Select-Object ProcessId,ExecutablePath);cases=@(Get-ChildItem C:\MuLab\public -Directory -Filter 'backup-boundary-*'|ForEach-Object{$root=$_.FullName;foreach($phase in @('seed','resume')){$ownerFile=Join-Path $root ($phase+'-owner.json');if(Test-Path -LiteralPath $ownerFile){$o=[IO.File]::ReadAllText($ownerFile)|ConvertFrom-Json;$p=Get-Process -Id $o.pid -ErrorAction SilentlyContinue;$progress=Join-Path $root ($phase+'-progress.json');$result=Join-Path $root ($phase+'-result.json');@{case=$_.Name;phase=$phase;pid=$o.pid;alive=[bool]$p;cpu=$(if($p){$p.CPU}else{0});progress=$(if(Test-Path -LiteralPath $progress){[IO.File]::ReadAllText($progress)|ConvertFrom-Json});result=$(if(Test-Path -LiteralPath $result){[IO.File]::ReadAllText($result)|ConvertFrom-Json})}}}})}
  };Save 'inspected' $r;exit 0
 }
 if($CaseId -notmatch '^[a-f0-9]{32}$'){throw 'An explicit new case is required'};$case='C:\MuLab\public\backup-boundary-'+$CaseId
 Invoke-Command -Session $session -ArgumentList $case,($Action -eq 'retry-stage') -ScriptBlock {
  param($case,$retry)
  if($env:COMPUTERNAME -ne 'MU-PRO-LAB' -or @(Get-VM).Count -or @(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker*' -or $_.ExecutablePath -like 'C:\MuLab\product\*'}).Count){throw 'Existing Pro allocations/processes are preserved'}
  if(Test-Path -LiteralPath $case){if(-not $retry -or ([IO.File]::GetAttributes($case) -band [IO.FileAttributes]::ReparsePoint) -or (Test-Path -LiteralPath (Join-Path $case seed-owner.json)) -or (Test-Path -LiteralPath (Join-Path $case resume-owner.json)) -or (Test-Path -LiteralPath (Join-Path $case state.json))){throw 'Only an unstarted staging case can continue'}}elseif($retry){throw 'Original staging directory missing'}
  $sid=(Get-LocalUser MuLabUser).SID.Value;if(@(Get-LocalGroupMember -SID S-1-5-32-544|Where-Object{$_.SID.Value -eq $sid}).Count){throw 'The test user must remain ordinary'}
  $ledger=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid+'/vms.json');if((Test-Path -LiteralPath $ledger) -and @(([IO.File]::ReadAllText($ledger)|ConvertFrom-Json).records.PSObject.Properties).Count){throw 'Existing user allocations are preserved'}
  if(-not(Test-Path -LiteralPath $case)){New-Item -ItemType Directory -Path $case|Out-Null;Copy-Item -LiteralPath C:\MuLab\product -Destination (Join-Path $case product) -Recurse}
 }
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot ../../dist-server) -Destination (Join-Path $case product/resources/app) -Recurse -Force -ToSession $session
 foreach($name in @('HyperVBroker.cs','SealedBases.cs','HostComponents.cs','ProtectedLedger.cs','ImageCache.cs','ResourceMetrics.cs','Resources.cs','DiskGrowth.cs','BackupRead.cs','BackupRestore.cs','BackupCursor.cs','Recovery.cs','RecoveryPermissions.cs','PowerWatch.cs','PowerProtection.cs','HyperVChannel.cs','RuntimeMetadataCleanup.cs')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../../native/windows/'+$name)) -Destination (Join-Path $case ('product/resources/app/dist-server/native/windows/'+$name)) -ToSession $session -Force}
 foreach($name in @('hyperv.ps1','host-components.ps1','seed-iso.ps1','build-channel.ps1','build-broker.ps1','install-broker.ps1','clean-runtime-metadata.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $case ('product/resources/app/dist-server/scripts/windows/'+$name)) -ToSession $session -Force}
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot pro-backup-boundary-client.mjs) -Destination C:\MuLab\backup-boundary.mjs -ToSession $session
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot ProBackupBoundaryStation.cs) -Destination C:\MuLab\private\ProBackupBoundaryStation.cs -ToSession $session
 $artifact=[IO.File]::ReadAllText((Join-Path $PSScriptRoot ../../.mu-data/windows-run/preview17-directory-native.json))|ConvertFrom-Json
 foreach($file in @($artifact.broker,$artifact.channel)){Copy-Item -LiteralPath (Join-Path (Join-Path $PSScriptRoot ../..) $file) -Destination (Join-Path $case ([IO.Path]::GetFileName($file))) -ToSession $session}
 Save 'staged' @{caseId=$CaseId;sourceDigest=$artifact.sourceDigest}
 $r=Invoke-Command -Session $session -ArgumentList $CaseId,$case,$artifact -ScriptBlock {
  param($id,$case,$artifact)
  $ErrorActionPreference='Stop';$sid=(Get-LocalUser MuLabUser).SID.Value;$node='C:\MuLab\product\resources\node\node.exe';$app=Join-Path $case product/resources/app
  $broker=Join-Path $case $artifact.brokerFile;$channel=Join-Path $case $artifact.channelFile
  if((Get-FileHash $broker).Hash.ToLowerInvariant() -ne $artifact.sha256 -or (Get-FileHash $channel).Hash.ToLowerInvariant() -ne $artifact.channelSha256){throw 'Transferred native artifacts changed'}
  $currentFile=Join-Path $env:ProgramData MuCodeSandbox-HyperVBroker-v1/bin/current.json;$installed=$null;if(Test-Path -LiteralPath $currentFile){$installed=[IO.File]::ReadAllText($currentFile)|ConvertFrom-Json}
  if(-not $installed -or $installed.sourceDigest -ne $artifact.sourceDigest){& ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $app dist-server/scripts/windows/install-broker.ps1)))) -Broker $broker -ExpectedBrokerHash $artifact.sha256 -Channel $channel -ExpectedChannelHash $artifact.channelSha256 -SourceDigest $artifact.sourceDigest}
  $installed=[IO.File]::ReadAllText($currentFile)|ConvertFrom-Json
  if($installed.sourceDigest -ne $artifact.sourceDigest -or (Get-FileHash -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($currentFile)) $installed.brokerFile)).Hash.ToLowerInvariant() -ne $artifact.sha256){throw 'Protected native artifact verification failed'}
  $cfg=@{caseId=$id;sid=$sid;clientSha256=(Get-FileHash C:\MuLab\backup-boundary.mjs).Hash.ToLowerInvariant();nodeSha256=(Get-FileHash $node).Hash.ToLowerInvariant()};[IO.File]::WriteAllText(('C:\MuLab\approved\backup-boundary-'+$id+'.json'),($cfg|ConvertTo-Json -Compress));$launcher='C:\MuLab\private\boundary-station-'+$id+'.exe'
  Add-Type -TypeDefinition ([IO.File]::ReadAllText('C:\MuLab\private\ProBackupBoundaryStation.cs')) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -OutputAssembly $launcher -OutputType ConsoleApplication
  $preserved=$null;$seedChecks=$null;$gap=$null;$resumed=$null;$killedPid=0
  foreach($phase in @('seed','resume')){
   $station=Start-Process -FilePath $launcher -ArgumentList @($id,$phase) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $case ($phase+'-station-out.log')) -RedirectStandardError (Join-Path $case ($phase+'-station-error.log')) -PassThru;$null=$station.Handle
   $ownerFile=Join-Path $case ($phase+'-owner.json');$until=[DateTime]::UtcNow.AddMinutes(2)
   do{if(Test-Path -LiteralPath $ownerFile){break};if($station.HasExited -or [DateTime]::UtcNow -gt $until){throw 'Ordinary boundary controller not confirmed; retain case'};Start-Sleep -Milliseconds 250}while($true)
   $owner=[IO.File]::ReadAllText($ownerFile)|ConvertFrom-Json;$actor=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$owner.pid)
   if($owner.caseId -cne $id -or $owner.phase -cne $phase -or $owner.nonce -notmatch '^[a-f0-9]{64}$' -or $actor.ExecutablePath -cne $node -or (Invoke-CimMethod -InputObject $actor -MethodName GetOwnerSid).Sid -ne $sid){throw 'Bound ordinary controller changed'}
   $controller=Get-Process -Id $owner.pid;$null=$controller.Handle;$bin=Join-Path $env:ProgramData MuCodeSandbox-HyperVBroker-v1/bin;$pointer=[IO.File]::ReadAllText((Join-Path $bin current.json))|ConvertFrom-Json;$exe=Join-Path $bin $pointer.brokerFile
   if($pointer.sourceDigest -ne $artifact.sourceDigest -or (Get-FileHash $exe).Hash.ToLowerInvariant() -ne $artifact.sha256){throw 'Installed broker digest differs'}
   $agent=Start-Process -FilePath $exe -ArgumentList @('--owner',[string]$owner.pid,'--pipe',$owner.nonce,'--detect-host') -WorkingDirectory $bin -WindowStyle Hidden -RedirectStandardOutput (Join-Path $case ($phase+'-broker-out.log')) -RedirectStandardError (Join-Path $case ($phase+'-broker-error.log')) -PassThru;$null=$agent.Handle
   $until=[DateTime]::UtcNow.AddMinutes(30)
   do{
    $requestFile=Join-Path $case ($phase+'-request.json')
    if($phase -eq 'seed' -and -not $preserved -and (Test-Path -LiteralPath $requestFile)){
     $request=[IO.File]::ReadAllText($requestFile)|ConvertFrom-Json;if($request.nonce -cne $owner.nonce -or $request.action -ne 'preserve-source' -or $request.id -notmatch '^[a-f0-9-]{36}$'){throw 'Original preservation request changed'}
     $v=Get-VM -Id ([guid]$request.platformId);$disk=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid+'/vms/'+$request.id+'/disk.vhdx');$d=@(Get-VMHardDiskDrive -VM $v)
     if($v.State -ne 'Off' -or $d.Count -ne 1 -or [IO.Path]::GetFullPath($d[0].Path) -cne $disk -or (Get-FileHash $disk).Hash.ToLowerInvariant() -ne $request.diskSha256){throw 'Original stopped disk changed'}
     $copy='C:\MuLab\private\boundary-original-'+$id+'.vhdx';[IO.File]::Copy($disk,$copy,$false);if((Get-FileHash $copy).Hash.ToLowerInvariant() -ne $request.diskSha256){throw 'Independent original copy changed'}
     $preserved=@{id=$request.id;copy=$copy;sha256=$request.diskSha256};[IO.File]::WriteAllText((Join-Path $case seed-operator.json),(@{nonce=$owner.nonce;action='preserve-source';complete=$true}|ConvertTo-Json -Compress))
    }
    $readyFile=Join-Path $case seed-kill-ready.json
    if($phase -eq 'seed' -and (Test-Path -LiteralPath $readyFile)){
     $ready=[IO.File]::ReadAllText($readyFile)|ConvertFrom-Json;if($ready.nonce -cne $owner.nonce -or $ready.pid -ne $owner.pid -or $ready.id -ne $preserved.id -or $ready.checks.Count -ne 4 -or @(Get-VM).Count){throw 'Only the exact idle pending restore controller can be killed'}
     $seedChecks=$ready.checks;$killedPid=$owner.pid;$controller.Kill();if(-not $controller.WaitForExit(15000) -or -not $agent.WaitForExit(60000) -or -not $station.WaitForExit(15000)){throw 'The original controller/broker exit is unconfirmed'}
     $userRoot=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid);$primary=Join-Path $userRoot vms.json;$replica=Join-Path $userRoot vms.backup.json;$before=[IO.File]::ReadAllText($primary);$ledger=$before|ConvertFrom-Json;$record=$ledger.records.($preserved.id);$dir=Join-Path $userRoot ('vms/'+$preserved.id)
     if($before -cne [IO.File]::ReadAllText($replica) -or -not $record.backupRestore -or $record.stage -ne 'allocated' -or $record.platformId -or $record.backupRestore.diskSha256 -ne $preserved.sha256 -or @(Get-ChildItem -LiteralPath $dir -Force).Count -or ([IO.File]::GetAttributes($dir) -band [IO.FileAttributes]::ReparsePoint)){throw 'Only an empty pending protected allocation can model the directory gap'}
     $moved='C:\MuLab\private\boundary-empty-'+$id;[IO.Directory]::Move($dir,$moved)
     if((Test-Path -LiteralPath $dir) -or $before -cne [IO.File]::ReadAllText($primary) -or $before -cne [IO.File]::ReadAllText($replica)){throw 'Gap simulation modified the durable journal'}
     $gap=@{actualControllerKilled=$true;oldOwnerPid=$owner.pid;directoryAbsenceIndependentlySimulated=$true;journalCopiesUnchanged=$true;newControllerRequired=$true};break
    }
    $resultFile=Join-Path $case ($phase+'-result.json');if(Test-Path -LiteralPath $resultFile){$value=[IO.File]::ReadAllText($resultFile)|ConvertFrom-Json;if(-not $value.complete -or $value.nonce -cne $owner.nonce){throw 'Boundary phase failed; retain exact case'};$resumed=$value;break}
    if([DateTime]::UtcNow -gt $until){throw 'The exact boundary phase remains pending; do not restart'};Start-Sleep -Milliseconds 500
   }while($true)
   if($phase -eq 'resume' -and (-not $controller.WaitForExit(15000) -or -not $agent.WaitForExit(60000) -or -not $station.WaitForExit(15000) -or $station.ExitCode -ne 0)){throw 'Resumed process cleanup is unconfirmed'}
  }
  if(-not $gap -or -not $resumed.complete -or $resumed.checks.Count -ne 5 -or @(Get-VM).Count -or (Get-FileHash $preserved.copy).Hash.ToLowerInvariant() -ne $preserved.sha256){throw 'Complete boundary recovery and preserved original required'}
  $ledgerRoot=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid);$primary=[IO.File]::ReadAllText((Join-Path $ledgerRoot vms.json));if($primary -cne [IO.File]::ReadAllText((Join-Path $ledgerRoot vms.backup.json)) -or @((ConvertFrom-Json $primary).records.PSObject.Properties).Count){throw 'Final ledger must be empty'}
  $hashes=@{};function HashCode($dir,$prefix){foreach($e in Get-ChildItem -LiteralPath $dir){if($e.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Case code reparse entry'};$name=$prefix+'/'+$e.Name;if($e.PSIsContainer){HashCode $e.FullName $name}else{$hashes[$name]=(Get-FileHash $e.FullName).Hash.ToLowerInvariant()}}};HashCode (Join-Path $app dist-server) dist-server
  @{caseId=$id;version='0.4.66-preview.17';seedChecks=$seedChecks;resumed=$resumed;gap=$gap;codeHashes=$hashes;fixtureSha256=$cfg.clientSha256;nodeSha256=$cfg.nodeSha256;brokerSourceDigest=$artifact.sourceDigest;brokerSha256=$artifact.sha256;originalCopyUnchanged=$true;noNestedVms=$true;controllersExited=$true;actualControllerKilled=$true;directoryGapSimulated=$true;syntheticAutologonDisabled=((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon').AutoAdminLogon -eq '0')}
 }
 Stop-VM -VM $vm -Confirm:$false;while((Get-VM -Id $vm.Id).State -ne 'Off'){Start-Sleep -Milliseconds 250};Save 'backup-boundary-complete-pro-off' $r
}catch{Save 'failed' @{message=$_.Exception.Message;stack=$_.ScriptStackTrace};throw}
finally{if($session){Remove-PSSession $session};$guard.Dispose()}
