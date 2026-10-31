#Requires -RunAsAdministrator
param([Parameter(Mandatory)][string]$Directory,[Parameter(Mandatory)][int]$OwnerPid,[ValidateSet('run','inspect','prepare-desktop','park-desktop','start-pending-task','diagnose-export')][string]$Action='inspect',[string]$CaseId)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs')
$guard=[MuPacketLabGuard]::new($OwnerPid,[IO.Path]::GetFullPath($Directory));$session=$null;$report=$guard.Reserve('preview14-'+[guid]::NewGuid().ToString('N')+'.json')
function Save($state,$value){[IO.File]::WriteAllText($report,(@{time=[DateTime]::UtcNow.ToString('o');state=$state;result=$value}|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))}
try{
 $machine=Get-Content -LiteralPath (Join-Path $Directory machine.json) -Raw -Encoding UTF8|ConvertFrom-Json;$config=Get-Content -LiteralPath (Join-Path $Directory config.json) -Raw -Encoding UTF8|ConvertFrom-Json
 $vm=Get-VM -Id ([guid]$machine.id);$disks=@(Get-VMHardDiskDrive -VM $vm);$expected=[IO.Path]::GetFullPath((Join-Path $Directory trace-artifacts/windows.vhdx))
 if($vm.Name -ne $machine.name -or $vm.Name -ne $config.name -or $vm.Name -notmatch '^mu-win-clean-[a-f0-9]{32}$' -or $vm.Notes -ne ('MuCodeSandbox clean Windows diagnostic '+$vm.Name) -or $disks.Count -ne 1 -or [IO.Path]::GetFullPath($disks[0].Path) -ne $expected -or @(Get-VMNetworkAdapter -VM $vm|Where-Object SwitchName).Count){throw 'Disconnected evaluation VM identity changed'}
 if($Action -in @('run','prepare-desktop') -and $vm.State -eq 'Off'){Start-VM -VM $vm|Out-Null;$vm=Get-VM -Id $vm.Id}
 if($Action -eq 'prepare-desktop'){Save 'disconnected-desktop-vm-prepared' @{name=$vm.Name;platformId=[string]$vm.Id;state=[string]$vm.State;networkAdapterConnected=$false;automaticLogonChanged=$false;productLaunched=$false};exit 0}
 if($vm.State -ne 'Running'){Save 'evaluation-vm-off' @{state=[string]$vm.State};exit 0}
 $credentials=Get-Content -LiteralPath (Join-Path $Directory guest-seed/private/credentials.json) -Raw -Encoding UTF8|ConvertFrom-Json;$credential=[pscredential]::new($credentials.adminUser,(ConvertTo-SecureString $credentials.adminPassword -AsPlainText -Force))
 $until=[DateTime]::UtcNow.AddMinutes(5);do{try{$session=New-PSSession -VMId $vm.Id -Credential $credential;break}catch{if([DateTime]::UtcNow -gt $until){throw 'PowerShell Direct pending; keep this VM'};Start-Sleep -Seconds 2}}while($true)
 if($Action -eq 'park-desktop'){
  $idle=Invoke-Command -Session $session -ScriptBlock {
   $query=Join-Path $env:SystemRoot System32/quser.exe;if(-not(Test-Path -LiteralPath $query)){throw 'User-session inspection unavailable'}
   $prior=$ErrorActionPreference;try{$ErrorActionPreference='Continue';$users=& $query 2>$null;$code=$LASTEXITCODE}finally{$ErrorActionPreference=$prior}
   if($code -ne 1 -or $users -or (Get-CimInstance Win32_ComputerSystem).UserName -or @(Get-Process explorer -ErrorAction SilentlyContinue).Count -or @(Get-VM).Count -or @(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -like '*MuCodeSandbox*' -or $_.ExecutablePath -like 'C:\MuLab\product\*'}).Count){throw 'An interactive user, job or VM may be active; desktop fixture preserved'}
   @{noInteractiveUsers=$true;noProductProcesses=$true;noNestedVms=$true}
  }
  Stop-VM -VM $vm -Confirm:$false;$until=[DateTime]::UtcNow.AddMinutes(2);do{$vm=Get-VM -Id $vm.Id;if($vm.State -eq 'Off'){break};if([DateTime]::UtcNow -gt $until){throw 'Normal shutdown remains pending; no force stop'};Start-Sleep -Milliseconds 500}while($true)
  Save 'idle-desktop-normally-parked' $idle;exit 0
 }
 if($Action -eq 'inspect'){
  $value=Invoke-Command -Session $session -ScriptBlock {
   $results=@(Get-ChildItem C:\MuLab\public -Directory -Filter 'backup-preview14-*'|ForEach-Object{$dir=$_.FullName;$owner=$null;$p=$null;$result=$null;if(Test-Path -LiteralPath (Join-Path $dir owner.json)){$owner=Get-Content -LiteralPath (Join-Path $dir owner.json) -Raw -Encoding UTF8|ConvertFrom-Json;$p=Get-Process -Id $owner.pid -ErrorAction SilentlyContinue};if(Test-Path -LiteralPath (Join-Path $dir verify-result.json)){$result=Get-Content -LiteralPath (Join-Path $dir verify-result.json) -Raw -Encoding UTF8|ConvertFrom-Json};@{case=[IO.Path]::GetFileName($dir);pid=$owner.pid;files=@(Get-ChildItem -LiteralPath $dir -File|Where-Object{$_.Name -in @('archive.mucwin','resume-archive.mucwin','resume-preserved.json','preserved.json','preserve-request.json','verify-result.json')}|Select-Object Name,Length,LastWriteTimeUtc);staging=@(Get-ChildItem -LiteralPath (Join-Path $dir target-runtime) -Directory -Filter 'backup-work-*' -ErrorAction SilentlyContinue|ForEach-Object{Get-ChildItem -LiteralPath $_.FullName -File|Select-Object Name,Length,LastWriteTimeUtc});ownerAlive=[bool]$p;cpu=$(if($p){$p.CPU}else{0});result=$result}})
   @{restoredLogs=@(Get-ChildItem C:\MuLab\public -Directory -Filter 'backup-preview14-*'|ForEach-Object{$dir=$_.FullName;foreach($name in @('restored-station-out.log','restored-station-error.log','restored-broker-error.log')){$file=Join-Path $dir $name;if(Test-Path -LiteralPath $file){@{case=$_.Name;file=$name;text=$(try{[IO.File]::ReadAllText($file)}catch{'held by running process'})}}}});restoredContinuations=@(Get-ChildItem C:\MuLab\public -Directory -Filter 'backup-preview14-*'|ForEach-Object{$dir=$_.FullName;$owner=Join-Path $dir restored-owner.json;if(Test-Path -LiteralPath $owner){$o=[IO.File]::ReadAllText($owner)|ConvertFrom-Json;$p=Get-Process -Id $o.pid -ErrorAction SilentlyContinue;$progress=Join-Path $dir restored-progress.json;$result=Join-Path $dir restored-result.json;@{case=$_.Name;pid=$o.pid;alive=[bool]$p;cpu=$(if($p){$p.CPU}else{0});progress=$(if(Test-Path -LiteralPath $progress){[IO.File]::ReadAllText($progress)|ConvertFrom-Json});result=$(if(Test-Path -LiteralPath $result){[IO.File]::ReadAllText($result)|ConvertFrom-Json})}}});continuations=@(Get-ChildItem C:\MuLab\public -Directory -Filter 'backup-preview14-*'|ForEach-Object{$dir=$_.FullName;$owner=Join-Path $dir resume-owner.json;if(Test-Path -LiteralPath $owner){$o=[IO.File]::ReadAllText($owner)|ConvertFrom-Json;$p=Get-Process -Id $o.pid -ErrorAction SilentlyContinue;$progress=Join-Path $dir resume-progress.json;$result=Join-Path $dir resume-result.json;@{case=$_.Name;pid=$o.pid;alive=[bool]$p;cpu=$(if($p){$p.CPU}else{0});progress=$(if(Test-Path -LiteralPath $progress){[IO.File]::ReadAllText($progress)|ConvertFrom-Json});result=$(if(Test-Path -LiteralPath $result){[IO.File]::ReadAllText($result)|ConvertFrom-Json})}}});freeBytes=([IO.DriveInfo]::new('C:\')).AvailableFreeSpace;diagnostics=@(Get-ChildItem C:\MuLab\public -Directory -Filter 'backup-preview14-*'|ForEach-Object{$meta=Get-Content -LiteralPath (Join-Path $_.FullName case.json) -Raw -Encoding UTF8|ConvertFrom-Json;$trace=Join-Path $_.FullName installer-trace.txt;$package=Join-Path $meta.installed resources/app/package.json;@{case=$_.Name;postInstallRecovery=$(if(Test-Path -LiteralPath (Join-Path $_.FullName transaction-recover-diagnostic.json)){[IO.File]::ReadAllText((Join-Path $_.FullName transaction-recover-diagnostic.json))|ConvertFrom-Json});prepareDiagnostic=$(if(Test-Path -LiteralPath (Join-Path $_.FullName transaction-prepare-diagnostic.json)){[IO.File]::ReadAllText((Join-Path $_.FullName transaction-prepare-diagnostic.json))|ConvertFrom-Json});recovery=$(if(Test-Path -LiteralPath (Join-Path $_.FullName transaction-recovery.json)){[IO.File]::ReadAllText((Join-Path $_.FullName transaction-recovery.json))|ConvertFrom-Json});installedVersion=$(if(Test-Path -LiteralPath $package){(Get-Content -LiteralPath $package -Raw -Encoding UTF8|ConvertFrom-Json).version}else{'missing'});journalPresent=(Test-Path -LiteralPath ($meta.installed+'.mu-install.json'));journal=$(if(Test-Path -LiteralPath ($meta.installed+'.mu-install.json')){$j=[IO.File]::ReadAllText($meta.installed+'.mu-install.json')|ConvertFrom-Json;@{state=$j.state;owner=$j.owner;writer=$j.writer;roots=$j.roots;nonce=$j.nonce}});trace=$(if(Test-Path -LiteralPath $trace){[IO.File]::ReadAllText($trace)}else{''})}});schedulerEvents=@(Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-TaskScheduler/Operational';StartTime=(Get-Date).AddMinutes(-10)} -ErrorAction SilentlyContinue|Select-Object -First 8 Id,Message);userEnabled=(Get-LocalUser MuLabUser).Enabled;stationLogs=@(Get-ChildItem C:\MuLab\public -Directory -Filter 'backup-preview14-*'|ForEach-Object{$log=Join-Path $_.FullName station-error.log;if(Test-Path -LiteralPath $log){try{[IO.File]::ReadAllText($log)}catch{'log held by running launcher'}}});cases=$results;upgradeResults=@(Get-ChildItem C:\MuLab\public -Directory -Filter 'backup-preview14-*'|ForEach-Object{$file=Join-Path $_.FullName upgrade-result.json;if(Test-Path -LiteralPath $file){Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json}});tasks=@(Get-ScheduledTask -TaskName 'MuBackupPreview14-*' -ErrorAction SilentlyContinue|ForEach-Object{$info=$_|Get-ScheduledTaskInfo;@{name=$_.TaskName;state=[string]$_.State;lastResult=$info.LastTaskResult;lastRun=$info.LastRunTime.ToString('o');settings=@{demand=$_.Settings.AllowDemandStart;enabled=$_.Settings.Enabled};principal=@{user=$_.Principal.UserId;logon=[string]$_.Principal.LogonType}}});vms=@(Get-VM|Select-Object Name,@{Name='state';Expression={[string]$_.State}});productProcesses=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -like '*MuCodeSandbox*' -or $_.ExecutablePath -like 'C:\MuLab\product\*' -or $_.ExecutablePath -like '*backup-preview14*' -or $_.Name -like '*.tmp' -or $_.Name -eq 'setup.exe' -or $_.Name -like '*uninst*'}|Select-Object ProcessId,ParentProcessId,Name,ExecutablePath)}
  };Save 'inspected' $value;exit 0
 }
 if($Action -eq 'diagnose-export'){
  if($CaseId -notmatch '^[a-f0-9]{32}$'){throw 'An explicit failed case is required'}
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot clean-host-backup-export-diagnostic.mjs) -Destination C:\MuLab\backup-export-diagnostic.mjs -ToSession $session
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot Preview14Station.cs) -Destination C:\MuLab\private\Preview14DiagnosticStation.cs -ToSession $session
  $value=Invoke-Command -Session $session -ArgumentList $CaseId -ScriptBlock {
   param($id)
   $ErrorActionPreference='Stop';$case='C:\MuLab\public\backup-preview14-'+$id
   $failed=Get-Content -LiteralPath (Join-Path $case verify-result.json) -Raw -Encoding UTF8|ConvertFrom-Json;$meta=Get-Content -LiteralPath (Join-Path $case case.json) -Raw -Encoding UTF8|ConvertFrom-Json
   if($env:COMPUTERNAME -ne 'MU-CLEAN-LAB' -or $meta.caseId -cne $id -or $meta.version -ne '0.4.66-preview.16' -or $failed.complete -ne $false -or $failed.checks.Count -ne 2 -or (Get-Process -Id $failed.pid -ErrorAction SilentlyContinue) -or @(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -like '*MuCodeSandbox*' -or $_.ExecutablePath -like 'C:\MuLab\product\*'}).Count){throw 'The failed installed controller must be terminal'}
   $vms=@(Get-VM);if($vms.Count -ne 1 -or $vms[0].State -ne 'Off'){throw 'Preserve the exact stopped source VM'};$originalId=[string]$vms[0].Id
   $materials=@(Get-ChildItem -LiteralPath (Join-Path $case source-runtime) -Directory -Filter 'mu-win-*');if($materials.Count -ne 1 -or $materials[0].Name -cne $vms[0].Name){throw 'Source management directory changed'}
   $manifest=Get-Content -LiteralPath (Join-Path $materials[0].FullName manifest.json) -Raw -Encoding UTF8|ConvertFrom-Json;if($manifest.platformId -ne $originalId){throw 'Source VM identity changed'}
   if((Test-Path -LiteralPath (Join-Path $case diagnostic-owner.json)) -or (Test-Path -LiteralPath (Join-Path $case diagnostic-result.json))){throw 'An existing diagnostic must be inspected rather than restarted'}
   $sid=(Get-LocalUser MuLabUser).SID.Value;$node=Join-Path $meta.installed resources/node/node.exe
   $config=@{caseId=$id;sid=$sid;node=$node;clientSha256=(Get-FileHash C:\MuLab\backup-export-diagnostic.mjs).Hash.ToLowerInvariant();nodeSha256=(Get-FileHash -LiteralPath $node).Hash.ToLowerInvariant()}
   [IO.File]::WriteAllText(('C:\MuLab\approved\preview14-diagnostic-launch-'+$id+'.json'),($config|ConvertTo-Json -Compress));$launcher='C:\MuLab\private\preview14-diagnostic-'+$id+'.exe'
   Add-Type -TypeDefinition ([IO.File]::ReadAllText('C:\MuLab\private\Preview14DiagnosticStation.cs')) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -OutputAssembly $launcher -OutputType ConsoleApplication
   $station=Start-Process -FilePath $launcher -ArgumentList @($id,'diagnose-export') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $case diagnostic-station-out.log) -RedirectStandardError (Join-Path $case diagnostic-station-error.log) -PassThru
   $until=[DateTime]::UtcNow.AddMinutes(2);do{if(Test-Path -LiteralPath (Join-Path $case diagnostic-owner.json)){break};if($station.HasExited -or [DateTime]::UtcNow -gt $until){throw 'Diagnostic launch not confirmed; preserve original'};Start-Sleep -Milliseconds 250}while($true)
   $owner=Get-Content -LiteralPath (Join-Path $case diagnostic-owner.json) -Raw -Encoding UTF8|ConvertFrom-Json;$actor=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$owner.pid)
   if($owner.caseId -cne $id -or $owner.nonce -notmatch '^[a-f0-9]{64}$' -or $actor.ExecutablePath -cne $node -or (Invoke-CimMethod -InputObject $actor -MethodName GetOwnerSid).Sid -ne $sid){throw 'Diagnostic installed process binding changed'}
   $controller=Get-Process -Id $owner.pid;$null=$controller.Handle
   $bin=Join-Path $env:ProgramData MuCodeSandbox-HyperVBroker-v1/bin;$pointer=Get-Content -LiteralPath (Join-Path $bin current.json) -Raw -Encoding UTF8|ConvertFrom-Json;$broker=Join-Path $bin $pointer.brokerFile
   if((Get-FileHash -LiteralPath $broker).Hash.ToLowerInvariant() -ne $pointer.brokerSha256){throw 'Protected broker changed'}
   $agent=Start-Process -FilePath $broker -ArgumentList @('--owner',[string]$owner.pid,'--pipe',$owner.nonce,'--detect-host') -WorkingDirectory $bin -WindowStyle Hidden -RedirectStandardOutput (Join-Path $case diagnostic-broker-out.log) -RedirectStandardError (Join-Path $case diagnostic-broker-error.log) -PassThru
   $until=[DateTime]::UtcNow.AddMinutes(20);do{if(Test-Path -LiteralPath (Join-Path $case diagnostic-result.json)){break};if([DateTime]::UtcNow -gt $until){throw 'Diagnostic is still pending; preserve its exact process'};Start-Sleep -Milliseconds 500}while($true)
   $result=Get-Content -LiteralPath (Join-Path $case diagnostic-result.json) -Raw -Encoding UTF8|ConvertFrom-Json
   if($result.nonce -cne $owner.nonce -or -not $controller.WaitForExit(15000) -or -not $agent.WaitForExit(45000) -or -not $station.WaitForExit(15000) -or (Get-VM -Id ([guid]$originalId)).State -ne 'Off'){throw 'Diagnostic exit or original stopped VM is unconfirmed'}
   @{caseId=$id;diagnostic=$result;originalPlatformId=$originalId;originalVmPreservedOff=$true;fixtureSha256=$config.clientSha256}
  };Save 'export-diagnostic-collected-original-vm-off' $value;exit 0
 }
 if($Action -eq 'start-pending-task'){
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot Preview14Station.cs) -Destination C:\MuLab\private\Preview14Station.cs -ToSession $session -Force
  $value=Invoke-Command -Session $session -ScriptBlock {
   $tasks=@(Get-ScheduledTask -TaskName 'MuBackupPreview14-*');if($tasks.Count -ne 1){throw 'Exactly one pending task required'};$task=$tasks[0];$info=$task|Get-ScheduledTaskInfo
   $id=$task.TaskName.Substring('MuBackupPreview14-'.Length);if($id -notmatch '^[a-f0-9]{32}$' -or $task.State -ne 'Ready' -or $info.LastTaskResult -ne 267011 -or $task.Actions.Execute -ne 'C:\MuLab\product\resources\node\node.exe' -or (Test-Path -LiteralPath ('C:\MuLab\public\backup-preview14-'+$id+'\owner.json'))){throw 'Only a verified never-started task can be started'}
   $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromHours(2)) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;$settings.AllowDemandStart=$true
   $directory='C:\MuLab\public\backup-preview14-'+$id;$launcher='C:\MuLab\private\preview14-launch-'+$id+'.exe'
   if(Test-Path -LiteralPath $launcher){throw 'An existing launcher must be inspected'}
   $sid=(Get-LocalUser MuLabUser).SID.Value;$cfg=@{caseId=$id;sid=$sid;clientSha256=(Get-FileHash C:\MuLab\backup-preview14.mjs).Hash.ToLowerInvariant();nodeSha256=(Get-FileHash C:\MuLab\product\resources\node\node.exe).Hash.ToLowerInvariant()}
   [IO.File]::WriteAllText(('C:\MuLab\approved\preview14-launch-'+$id+'.json'),($cfg|ConvertTo-Json -Compress))
   Add-Type -TypeDefinition ([IO.File]::ReadAllText('C:\MuLab\private\Preview14Station.cs')) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -OutputAssembly $launcher -OutputType ConsoleApplication
   Disable-ScheduledTask -TaskName $task.TaskName|Out-Null
   $station=Start-Process -FilePath $launcher -ArgumentList @($id) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $directory station-out.log) -RedirectStandardError (Join-Path $directory station-error.log) -PassThru
   @{caseId=$id;neverStartedTaskDisabled=$true;privateStationPid=$station.Id}
  };Save 'pending-task-start-requested' $value;exit 0
 }
 $package=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../.mu-data/windows-run/desktop-package.json') -Raw -Encoding UTF8|ConvertFrom-Json
 $audit=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../.mu-data/windows-run/backup-package-complete.json') -Raw -Encoding UTF8|ConvertFrom-Json
 if($package.stage.release.version -ne '0.4.66-preview.16' -or -not $audit.complete -or $audit.version -ne $package.stage.release.version){throw 'Audited preview.14 package required'}
 $installer=@($package.artifacts|Where-Object{$_ -like '*.exe'})[0];if((Get-FileHash -LiteralPath $installer).Hash.ToLowerInvariant() -ne $audit.installerSha256){throw 'Installer changed'}
 $caseId=[guid]::NewGuid().ToString('N');$case='C:\MuLab\public\backup-preview14-'+$caseId
 $meta=Invoke-Command -Session $session -ArgumentList $caseId,$case,$audit.installerSha256 -ScriptBlock {
  param($caseId,$case,$hash)
  if($env:COMPUTERNAME -ne 'MU-CLEAN-LAB' -or @(Get-VM).Count -or @(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -like '*MuCodeSandbox*' -or $_.ExecutablePath -like 'C:\MuLab\product\*'}).Count){throw 'An existing VM or product process is preserved'}
  foreach($prior in @(Get-ChildItem C:\MuLab\public -Directory -Filter 'backup-preview14-*')){
   $failureFile=Join-Path $prior.FullName upgrade-result.json;if(-not(Test-Path -LiteralPath $failureFile)){throw 'An earlier case is not terminal; inspect rather than restart'}
   $failure=Get-Content -LiteralPath $failureFile -Raw -Encoding UTF8|ConvertFrom-Json
   if($failure.complete -ne $false -or $failure.checks.Count -ne 0 -or (Test-Path -LiteralPath (Join-Path $prior.FullName owner.json)) -or (Get-Process -Id $failure.pid -ErrorAction SilentlyContinue)){throw 'Prior case cannot be replaced; preserve and inspect it'}
  }
  $old=Get-Content C:\MuLab\approved\adoption-backup-restore-result.json -Raw -Encoding UTF8|ConvertFrom-Json
  if(-not $old.complete -or $old.nested.installedVersion -ne '0.4.66-preview.13' -or $old.nested.installationNonce -notmatch '^[a-f0-9]{64}$'){throw 'Retained preview.13 installation proof required'}
  $installed=$old.nested.installedDirectory;$prefix='C:\MuLab\public\backup-installed-'+$old.nested.installationNonce+'\'
  if(-not ([IO.Path]::GetFullPath($installed)).StartsWith($prefix,[StringComparison]::Ordinal) -or (Get-Content -LiteralPath (Join-Path $installed resources/app/package.json) -Raw -Encoding UTF8|ConvertFrom-Json).version -notin @('0.4.66-preview.13','0.4.66-preview.15','0.4.66-preview.16')){throw 'Prior installed path or version changed'}
  New-Item -ItemType Directory -Path $case|Out-Null
  $meta=@{caseId=$caseId;installed=[IO.Path]::GetFullPath($installed);installerSha256=$hash;version='0.4.66-preview.16'};[IO.File]::WriteAllText((Join-Path $case case.json),($meta|ConvertTo-Json -Compress));$meta
 }
 Copy-Item -LiteralPath $installer -Destination (Join-Path $case setup.exe) -ToSession $session
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot clean-host-backup-preview14.mjs) -Destination C:\MuLab\backup-preview14.mjs -ToSession $session
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot Preview14Station.cs) -Destination C:\MuLab\private\Preview14Station.cs -ToSession $session -Force
 Save 'running' @{caseId=$caseId;installed=$meta.installed}
 $result=Invoke-Command -Session $session -ArgumentList $caseId,$case,$meta -ScriptBlock {
  param($caseId,$case,$meta)
  $ErrorActionPreference='Stop';$c=Get-Content C:\MuLab\private\credentials.json -Raw -Encoding UTF8|ConvertFrom-Json;$sid=(Get-LocalUser $c.user).SID.Value
  if(@(Get-LocalGroupMember -SID S-1-5-32-544|Where-Object{$_.SID.Value -eq $sid}).Count){throw 'The app user must remain ordinary'}
  $launchConfig=@{caseId=$caseId;sid=$sid;clientSha256=(Get-FileHash C:\MuLab\backup-preview14.mjs).Hash.ToLowerInvariant();nodeSha256=(Get-FileHash C:\MuLab\product\resources\node\node.exe).Hash.ToLowerInvariant()}
  [IO.File]::WriteAllText(('C:\MuLab\approved\preview14-launch-'+$caseId+'.json'),($launchConfig|ConvertTo-Json -Compress));$launcher='C:\MuLab\private\preview14-launch-'+$caseId+'.exe'
  Add-Type -TypeDefinition ([IO.File]::ReadAllText('C:\MuLab\private\Preview14Station.cs')) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -OutputAssembly $launcher -OutputType ConsoleApplication
  $station=Start-Process -FilePath $launcher -ArgumentList @($caseId) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $case station-out.log) -RedirectStandardError (Join-Path $case station-error.log) -PassThru
  $until=[DateTime]::UtcNow.AddMinutes(5)
  do{if(Test-Path -LiteralPath (Join-Path $case owner.json)){break};if(Test-Path -LiteralPath (Join-Path $case upgrade-result.json)){throw 'Upgrade ended before installed Node handshake; inspect receipt'};if([DateTime]::UtcNow -gt $until){throw 'Upgrade still pending; retain original task'};Start-Sleep -Milliseconds 250}while($true)
  $owner=Get-Content -LiteralPath (Join-Path $case owner.json) -Raw -Encoding UTF8|ConvertFrom-Json;$actor=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$owner.pid);$node=Join-Path $meta.installed resources/node/node.exe
  if($owner.caseId -cne $caseId -or $owner.nonce -notmatch '^[a-f0-9]{64}$' -or $actor.ExecutablePath -cne $node -or (Invoke-CimMethod -InputObject $actor -MethodName GetOwnerSid).Sid -ne $sid){throw 'Installed Node process identity changed'}
  $controller=Get-Process -Id $owner.pid;$null=$controller.Handle
  $bin=Join-Path $env:ProgramData MuCodeSandbox-HyperVBroker-v1/bin;$pointer=Get-Content -LiteralPath (Join-Path $bin current.json) -Raw -Encoding UTF8|ConvertFrom-Json;$broker=Join-Path $bin $pointer.brokerFile
  if((Get-FileHash -LiteralPath $broker).Hash.ToLowerInvariant() -ne $pointer.brokerSha256){throw 'Protected broker changed'}
  $agent=Start-Process -FilePath $broker -ArgumentList @('--owner',[string]$owner.pid,'--pipe',$owner.nonce,'--detect-host') -WorkingDirectory $bin -WindowStyle Hidden -RedirectStandardOutput (Join-Path $case broker-out.log) -RedirectStandardError (Join-Path $case broker-error.log) -PassThru
  $until=[DateTime]::UtcNow.AddMinutes(35);$preserved=$null
  do{
   if(-not $preserved -and (Test-Path -LiteralPath (Join-Path $case preserve-request.json))){
    $request=Get-Content -LiteralPath (Join-Path $case preserve-request.json) -Raw -Encoding UTF8|ConvertFrom-Json
    if($request.caseId -cne $caseId -or $request.nonce -cne $owner.nonce -or $request.id -notmatch '^[a-f0-9-]{36}$'){throw 'Preservation request changed'}
    $vm=Get-VM -Id ([guid]$request.platformId);$disk=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid+'/vms/'+$request.id+'/disk.vhdx');$drives=@(Get-VMHardDiskDrive -VM $vm)
    if($vm.State -ne 'Off' -or $drives.Count -ne 1 -or [IO.Path]::GetFullPath($drives[0].Path) -cne $disk -or (Get-FileHash -LiteralPath $disk).Hash.ToLowerInvariant() -ne $request.disk.sha256){throw 'Original stopped disk changed'}
    $copy='C:\MuLab\private\preview14-original-'+$caseId+'.vhdx';[IO.File]::Copy($disk,$copy,$false);if((Get-FileHash -LiteralPath $copy).Hash.ToLowerInvariant() -ne $request.disk.sha256){throw 'Independent copy changed'}
    $preserved=@{caseId=$caseId;nonce=$owner.nonce;sha256=$request.disk.sha256;copy=$copy};[IO.File]::WriteAllText((Join-Path $case preserved.json),($preserved|ConvertTo-Json -Compress))
   }
   if(Test-Path -LiteralPath (Join-Path $case upgrade-result.json)){break};if([DateTime]::UtcNow -gt $until){throw 'The exact installed process remains pending; inspect without restart'};Start-Sleep -Milliseconds 500
  }while($true)
  $result=Get-Content -LiteralPath (Join-Path $case upgrade-result.json) -Raw -Encoding UTF8|ConvertFrom-Json
  if(-not $result.complete -or $result.caseId -cne $caseId -or -not $preserved){throw 'Installed round trip did not pass; artifacts retained'}
  if(-not $controller.WaitForExit(15000) -or -not $agent.WaitForExit(45000) -or @(Get-VM).Count -or (Get-FileHash -LiteralPath $preserved.copy).Hash.ToLowerInvariant() -ne $preserved.sha256){throw 'Independent final cleanup or original copy check failed'}
  $ledgerRoot=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid);$ledger=[IO.File]::ReadAllText((Join-Path $ledgerRoot vms.json));if($ledger -cne [IO.File]::ReadAllText((Join-Path $ledgerRoot vms.backup.json)) -or @((ConvertFrom-Json $ledger).records.PSObject.Properties).Count){throw 'Protected allocations remain'}
  $registration=Get-ItemProperty -LiteralPath ('Registry::HKEY_USERS\'+$sid+'\Software\Microsoft\Windows\CurrentVersion\Uninstall\e88eb670-5944-5236-81aa-7c1d3da3d6df');if($registration.DisplayVersion -ne $meta.version){throw 'Installed registration version differs'}
  $hashes=@{};function HashTree($dir,$prefix){foreach($entry in Get-ChildItem -LiteralPath $dir){if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Installed reparse entry'};$name=$prefix+'/'+$entry.Name;if($entry.PSIsContainer){HashTree $entry.FullName $name}else{$hashes[$name]=(Get-FileHash -LiteralPath $entry.FullName).Hash.ToLowerInvariant()}}}
  foreach($name in @('dist','dist-server','desktop')){HashTree (Join-Path $meta.installed ('resources/app/'+$name)) $name}
  if(-not $station.WaitForExit(15000) -or $station.ExitCode -ne 0){throw 'The private standard-user station exit is unconfirmed'}
  @{caseId=$caseId;client=$result;installedCodeHashes=$hashes;installedExecutableSha256=(Get-FileHash -LiteralPath (Join-Path $meta.installed 'MuCodeSandbox Windows Preview.exe')).Hash.ToLowerInvariant();installedNodeSha256=(Get-FileHash -LiteralPath $node).Hash.ToLowerInvariant();fixtureSha256=(Get-FileHash C:\MuLab\backup-preview14.mjs).Hash.ToLowerInvariant();brokerSourceDigest=$pointer.sourceDigest;registrationVerified=$true;originalCopyUnchanged=$true;nestedGuestsRemaining=0;installedControllerExited=$true;syntheticAutologonDisabled=((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon').AutoAdminLogon -eq '0')}
 }
 Stop-VM -VM $vm -Confirm:$false;while((Get-VM -Id $vm.Id).State -ne 'Off'){Start-Sleep -Milliseconds 250};Save 'installed-round-trip-complete-evaluation-vm-off' $result
}catch{Save 'failed' @{message=$_.Exception.Message;stack=$_.ScriptStackTrace};throw}
finally{if($session){Remove-PSSession $session};$guard.Dispose()}
