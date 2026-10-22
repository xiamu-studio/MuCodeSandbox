function Invoke-ProUpgradeRun($Session,[string]$CaseId,[string]$Step){
 return Invoke-Command -Session $Session -ArgumentList $CaseId,$Step -ScriptBlock {
  param($caseId,$step)
  $ErrorActionPreference='Stop'
  $config=[IO.File]::ReadAllText(('C:\MuLab\approved\upgrade-'+$caseId+'-config.json'))|ConvertFrom-Json
  if($caseId -notmatch '^[a-f0-9]{32}$' -or $config.caseId -ne $caseId -or $config.directory -ne ('C:\MuLab\public\upgrade-'+$caseId) -or (Get-LocalUser $config.userName).SID.Value -ne $config.userSid -or $step -notin @('old-install','old-seed','install','current','reject','uninstall','cleanup')){throw 'Bound ordinary upgrade case required'}
  $prefix=Join-Path $config.directory $step;$resultFile=$prefix+'-result.json';$ownerFile=$prefix+'-owner.json';$bin=Join-Path $env:ProgramData 'MuCodeSandbox-HyperVBroker-v1/bin'
  if((Test-Path -LiteralPath $ownerFile) -or (Test-Path -LiteralPath $resultFile)){throw 'Existing upgrade phase must be inspected; never restart from a timeout'}
  $order=@('old-install','old-seed','install','current','reject','uninstall','cleanup');$position=[Array]::IndexOf($order,$step)
  if($position -gt 0){$prior=[IO.File]::ReadAllText(('C:\MuLab\approved\upgrade-'+$caseId+'-'+$order[$position-1]+'-result.json'))|ConvertFrom-Json;if(-not $prior.complete -or -not $prior.processExitConfirmed){throw 'Prior exact upgrade phase must have completed and exited'}}
  foreach($entry in @(@{file=$config.launcher;hash=$config.launcherSha256},@{file=(Join-Path $config.tools 'pro-upgrade-client.mjs');hash=$config.clientSha256},@{file=(Join-Path $bin 'current.json');hash=$config.defaultBrokerPointerSha256})){if((Get-FileHash -LiteralPath $entry.file).Hash.ToLowerInvariant() -ne $entry.hash){throw 'Upgrade launcher/client/default broker binding changed'}}
  if(@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and ($_.ExecutablePath.StartsWith($config.directory,[StringComparison]::OrdinalIgnoreCase) -or $_.ExecutablePath -eq $config.launcher -or $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1\bin\hv-broker-*.exe')}).Count){throw 'An upgrade actor is already live'}
  function Get-OriginalWitness {
   $package=[IO.File]::ReadAllText('C:\MuLab\approved\package-config.json')|ConvertFrom-Json
   if($package.caseId -notmatch '^[a-f0-9]{32}$' -or $package.userSid -ne (Get-LocalUser MuLabUser).SID.Value -or $package.userSid -eq $config.userSid){throw 'Original ordinary user fixture changed'}
   $root='C:\MuLab\public\package-'+$package.caseId;$installed=Join-Path $root "程序 O'Brien $ 测试\MuCodeSandbox Windows Preview";$hashes=[ordered]@{}
   foreach($name in @('MuCodeSandbox Windows Preview.exe','resources/app/package.json','resources/app/dist-server/windows-release.json','resources/windows-runtime-manifest.json','resources/app/desktop/windows/main.cjs')){$hashes[$name]=(Get-FileHash -LiteralPath (Join-Path $installed $name)).Hash.ToLowerInvariant()}
   foreach($name in @('credentials.dpapi','state.sqlite','retained.bin')){$hashes['data/'+$name]=(Get-FileHash -LiteralPath (Join-Path $root ('independent-data/'+$name))).Hash.ToLowerInvariant()}
   $original=[IO.File]::ReadAllText((Join-Path $root 'state.json'))|ConvertFrom-Json;foreach($entry in $original.applicationHashes.psobject.Properties){if($hashes[$entry.Name] -ne $entry.Value){throw 'Original installation differs from its earlier package-test receipt'}};foreach($entry in $original.dataHashes.psobject.Properties){if($hashes['data/'+$entry.Name] -ne $entry.Value){throw 'Original user data differs from its earlier package-test receipt'}}
   $registry=Get-ItemProperty -LiteralPath ('Registry::HKEY_USERS\'+$package.userSid+'\Software\Microsoft\Windows\CurrentVersion\Uninstall\e88eb670-5944-5236-81aa-7c1d3da3d6df')
   return ([ordered]@{userSid=$package.userSid;hashes=$hashes;registration=[ordered]@{version=$registry.DisplayVersion;path=$registry.InstallLocation;uninstall=$registry.UninstallString}}|ConvertTo-Json -Depth 8 -Compress)
  }
  function Get-Allocation([bool]$HashDisk){
   $all=@(Get-VM);$root=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$config.userSid);$primary=Join-Path $root 'vms.json';$backup=Join-Path $root 'vms.backup.json'
   if(-not(Test-Path -LiteralPath $primary)){if($all.Count){throw 'Unregistered VM in upgrade scope'};return @{registered=0}}
   if((Get-FileHash $primary).Hash -ne (Get-FileHash $backup).Hash){throw 'Upgrade protected ledger copies differ'};$ledger=[IO.File]::ReadAllText($primary)|ConvertFrom-Json;$records=@($ledger.records.psobject.Properties)
   if($ledger.version -ne 2 -or $ledger.ownerSid -ne $config.userSid -or $records.Count -ne $all.Count -or $all.Count -gt 1){throw 'Upgrade protected allocation scope changed'}
   if(-not $records.Count){return @{registered=0}}
   $state=[IO.File]::ReadAllText((Join-Path $config.directory 'state.json'))|ConvertFrom-Json;$entry=$records[0];$record=$entry.Value;$id=[string]$entry.Name;$vm=$all[0];$name='mu-win-'+$id.Replace('-','');$disk=Join-Path $root ('vms/'+$id+'/disk.vhdx');$drives=@(Get-VMHardDiskDrive -VM $vm)
   if($id -ne $state.environmentId -or [string]$vm.Id -ne $state.platformId -or $vm.Name -ne $name -or $vm.Notes -ne ('MuCodeSandbox Windows preview '+$name) -or [string]$vm.State -ne 'Off' -or $record.ownerSid -ne $config.userSid -or $record.platformId -ne [string]$vm.Id -or $record.diskGrowth -or $drives.Count -ne 1 -or [IO.Path]::GetFullPath($drives[0].Path) -ne [IO.Path]::GetFullPath($disk) -or @(Get-VMSnapshot -VM $vm).Count){throw 'Original stopped upgrade VM boundary changed'}
   $vhd=Get-VHD -Path $disk;if([long]$vhd.Size -ne [long]$state.diskGiB*1GB -or [long]$record.diskGiB -ne [long]$state.diskGiB -or $vhd.ParentPath){throw 'Upgrade disk capacity/parent changed'}
   $result=@{registered=1;id=$id;platformId=([guid]$vm.Id).ToString('D');diskIdentifier=([guid]$vhd.DiskIdentifier).ToString('D');diskGiB=[int]$record.diskGiB;path=$disk}
   if($HashDisk){$result.sha256=(Get-FileHash -LiteralPath $disk).Hash.ToLowerInvariant()};return $result
  }
  $installerOnly=$step -in @('old-install','install','reject','uninstall');$before=Get-Allocation $installerOnly;$witness=Get-OriginalWitness
  $launcher=Start-Process -FilePath $config.launcher -ArgumentList @($caseId,$step) -WindowStyle Hidden -RedirectStandardOutput ($prefix+'-station-out.log') -RedirectStandardError ($prefix+'-station-error.log') -PassThru;$null=$launcher.Handle;$agent=$null;$owner=$null;$handle=$null
  if(-not $installerOnly){
   $until=[DateTime]::UtcNow.AddMinutes(3);while(-not(Test-Path -LiteralPath $ownerFile)){if($launcher.HasExited){throw 'Upgrade launcher exited before a backend owner was observed'};if([DateTime]::UtcNow -gt $until){throw 'Backend owner remains unconfirmed; inspect the existing launcher'};Start-Sleep -Milliseconds 200}
   $owner=[IO.File]::ReadAllText($ownerFile)|ConvertFrom-Json;$actor=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$owner.pid);$expectedNode=if($step -eq 'cleanup'){$config.node}else{Join-Path $config.directory "程序 O'Brien $ 测试\MuCodeSandbox Windows Preview\resources\node\node.exe"}
   if($owner.caseId -ne $caseId -or $owner.phase -ne $step -or $owner.nonce -notmatch '^[a-f0-9]{64}$' -or $actor.ExecutablePath -ne $expectedNode -or $actor.CommandLine -notlike ('*'+(Join-Path $config.tools 'pro-upgrade-client.mjs')+'*'+$caseId+'*'+$step+'*') -or (Invoke-CimMethod -InputObject $actor -MethodName GetOwnerSid).Sid -ne $config.userSid){throw 'Actual ordinary upgrade backend process binding changed'}
   $handle=Get-Process -Id $owner.pid;$null=$handle.Handle;$label=if($step -eq 'old-seed'){'old'}else{'current'};$artifact=$config.brokers.$label;$broker=Join-Path $bin $artifact.brokerFile
   if((Get-FileHash -LiteralPath $broker).Hash.ToLowerInvariant() -ne $artifact.brokerSha256){throw 'Exact historical broker changed'}
   $agent=Start-Process -FilePath $broker -ArgumentList @('--owner',[string]$owner.pid,'--pipe',[string]$owner.nonce,'--detect-host') -WorkingDirectory $bin -WindowStyle Hidden -RedirectStandardOutput ('C:\MuLab\private\upgrade-'+$caseId+'-'+$step+'-broker-out.log') -RedirectStandardError ('C:\MuLab\private\upgrade-'+$caseId+'-'+$step+'-broker-error.log') -PassThru;$null=$agent.Handle
  }
  $until=[DateTime]::UtcNow.AddMinutes(46);while(-not $launcher.WaitForExit(500)){if([DateTime]::UtcNow -gt $until){throw 'Upgrade launcher remains live; preserve and inspect its exact handle'}}
  if($handle -and -not $handle.WaitForExit(15000)){throw 'Upgrade backend remains live after launcher exit'};if($agent -and -not $agent.WaitForExit(45000)){throw 'Historical broker exit remains unconfirmed'}
  if(-not(Test-Path -LiteralPath $resultFile)){throw 'Upgrade actor exited without a terminal receipt'}
  $result=[IO.File]::ReadAllText($resultFile)|ConvertFrom-Json;$reportedOwner=[IO.File]::ReadAllText($ownerFile)|ConvertFrom-Json
  if($result.caseId -ne $caseId -or $result.phase -ne $step -or $result.pid -ne $reportedOwner.pid -or $result.nonce -cne $reportedOwner.nonce -or ($owner -and $result.pid -ne $owner.pid)){throw 'Upgrade terminal receipt binding changed'}
  $station=[IO.File]::ReadAllText($prefix+'-station-out.log')|ConvertFrom-Json;if($station.pid -ne $result.pid -or $station.live -or ($result.complete -and ($launcher.ExitCode -ne 0 -or -not $station.complete))){throw 'Actual launcher/child exit evidence differs'}
  $after=Get-Allocation $installerOnly;if((Get-OriginalWitness) -cne $witness){throw 'The original MuLabUser installation, registration or profile changed'}
  if($installerOnly){if(($before|ConvertTo-Json -Compress) -cne ($after|ConvertTo-Json -Compress)){throw 'Installer altered the original VM or whole stopped VHDX bytes'}}
  elseif($before.registered -eq 1 -and $after.registered -eq 1){foreach($field in @('id','platformId','diskIdentifier','path')){if($before.$field -cne $after.$field){throw 'Backend upgrade replaced the original Linux allocation'}}}
  if((Get-FileHash -LiteralPath (Join-Path $bin 'current.json')).Hash.ToLowerInvariant() -ne $config.defaultBrokerPointerSha256){throw 'The existing default broker pointer changed'}
  foreach($entry in @(@('processExitConfirmed',$true),@('brokerExitConfirmed',(-not $agent -or $agent.HasExited)),@('originalUserUnchanged',$true),@('defaultBrokerPointerUnchanged',$true),@('before',$before),@('after',$after))){$result|Add-Member -NotePropertyName $entry[0] -NotePropertyValue $entry[1] -Force}
  [IO.File]::WriteAllText(('C:\MuLab\approved\upgrade-'+$caseId+'-'+$step+'-result.json'),($result|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false));return $result
 }
}
