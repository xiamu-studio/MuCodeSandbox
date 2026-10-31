#Requires -RunAsAdministrator
param([Parameter(Mandatory)][string]$Directory,[Parameter(Mandatory)][int]$OwnerPid,[ValidateSet('run','upgrade','inspect')][string]$Action,[string]$CaseId)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs')
$guard=[MuPacketLabGuard]::new($OwnerPid,[IO.Path]::GetFullPath($Directory));$report=$guard.Reserve('installed-backup-'+[guid]::NewGuid().ToString('N')+'.json');$session=$null
function Save($state,$value){[IO.File]::WriteAllText($report,(@{state=$state;time=[DateTime]::UtcNow.ToString('o');caseId=$CaseId;result=$value}|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))}
try{
 $m=$guard.ReadCommand('machine.json')|ConvertFrom-Json;$config=$guard.ReadCommand('config.json')|ConvertFrom-Json;$credentials=$guard.ReadGuestCredentials()|ConvertFrom-Json;$vm=Get-VM -Id ([guid]$m.id);$drives=@(Get-VMHardDiskDrive -VM $vm)
 if($config.flavor -ne 'pro26300' -or $vm.Name -ne $m.name -or $vm.Name -ne $config.name -or $vm.Notes -ne ('MuCodeSandbox isolated Pro diagnostic '+$vm.Name) -or $drives.Count -ne 1 -or [IO.Path]::GetFullPath($drives[0].Path) -cne [IO.Path]::GetFullPath((Join-Path $Directory trace-artifacts/windows.vhdx)) -or @(Get-VMNetworkAdapter -VM $vm|Where-Object SwitchName).Count){throw 'Dedicated disconnected Pro identity changed'}
 if($Action -in @('run','upgrade') -and $vm.State -eq 'Off'){Start-VM -VM $vm|Out-Null;$vm=Get-VM -Id $vm.Id};if($vm.State -ne 'Running'){Save 'pro-off' @{state=[string]$vm.State};exit 0}
 Save 'connecting' $null;$credential=[pscredential]::new($credentials.adminUser,(ConvertTo-SecureString $credentials.adminPassword -AsPlainText -Force));$until=[DateTime]::UtcNow.AddMinutes(8)
 do{try{$session=New-PSSession -VMId $vm.Id -Credential $credential;break}catch{if([DateTime]::UtcNow -gt $until){throw 'Pro connection pending; retain original'};Start-Sleep -Seconds 2}}while($true)
 if($Action -eq 'inspect'){
  $r=Invoke-Command -Session $session -ScriptBlock {
   @{vms=@(Get-VM|Select-Object Name,@{Name='state';Expression={[string]$_.State}});processes=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -like '*MuCodeSandbox*' -or $_.ExecutablePath -like 'C:\MuLab\product\*' -or $_.ExecutablePath -like 'C:\MuLab\private\installed-station-*'}|Select-Object ProcessId,ExecutablePath);cases=@(Get-ChildItem C:\MuLab\public -Directory -Filter 'installed-backup-*'|ForEach-Object{$root=$_.FullName;foreach($phase in @('bootstrap','verify')){$file=Join-Path $root ($phase+'-owner.json');$p=$null;$owner=$null;if(Test-Path -LiteralPath $file){$owner=[IO.File]::ReadAllText($file)|ConvertFrom-Json;$p=Get-Process -Id $owner.pid -ErrorAction SilentlyContinue};$result=Join-Path $root ($phase+'-result.json');$progress=Join-Path $root ($phase+'-progress.json');$inventory=Join-Path $root bootstrap-inventory.json;@{case=$_.Name;phase=$phase;pid=$owner.pid;alive=[bool]$p;cpu=$(if($p){$p.CPU}else{0});progress=$(if(Test-Path -LiteralPath $progress){[IO.File]::ReadAllText($progress)|ConvertFrom-Json});result=$(if(Test-Path -LiteralPath $result){[IO.File]::ReadAllText($result)|ConvertFrom-Json});inventory=$(if(Test-Path -LiteralPath $inventory){[IO.File]::ReadAllText($inventory)|ConvertFrom-Json})}}})}
  }
  $r.diagnostics=Invoke-Command -Session $session -ScriptBlock {
   @{setupProcesses=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'setup.exe' -or $_.Name -like '*.tmp'}|Select-Object ProcessId,ParentProcessId,Name,ExecutablePath);installations=@(Get-ChildItem C:\MuLab\public -Directory -Filter 'installed-backup-*'|ForEach-Object{
    $metaFile=Join-Path $_.FullName case.json;if(Test-Path -LiteralPath $metaFile){$meta=[IO.File]::ReadAllText($metaFile)|ConvertFrom-Json;$trace=Join-Path $_.FullName installer-trace.txt;$pkg=Join-Path $meta.installed resources/app/package.json;@{case=$_.Name;version=$(if(Test-Path -LiteralPath $pkg){([IO.File]::ReadAllText($pkg)|ConvertFrom-Json).version});trace=$(if(Test-Path -LiteralPath $trace){@(Get-Content -LiteralPath $trace -Tail 12)});journal=$(if(Test-Path -LiteralPath ($meta.installed+'.mu-install.json')){([IO.File]::ReadAllText($meta.installed+'.mu-install.json')|ConvertFrom-Json).state})}}
   })}
  };Save 'inspected' $r;exit 0
 }
 if($CaseId -notmatch '^[a-f0-9]{32}$'){throw 'An explicit fresh installation case required'};$case='C:\MuLab\public\installed-backup-'+$CaseId
 $package=[IO.File]::ReadAllText((Join-Path $PSScriptRoot ../../.mu-data/windows-run/desktop-package.json))|ConvertFrom-Json;$audit=[IO.File]::ReadAllText((Join-Path $PSScriptRoot ../../.mu-data/windows-run/backup-package-complete.json))|ConvertFrom-Json
 if($package.stage.release.version -ne '0.4.66-preview.17' -or -not $audit.complete -or $audit.version -ne $package.stage.release.version){throw 'The audited actual preview.17 package required'};$installer=@($package.artifacts|Where-Object{$_ -like '*.exe'})[0];if((Get-FileHash $installer).Hash.ToLowerInvariant() -ne $audit.installerSha256){throw 'Installer changed'}
 Invoke-Command -Session $session -ArgumentList $case,$CaseId,$audit.installerSha256,$package.stage.nodeInfo.sha256,($Action -eq 'upgrade') -ScriptBlock {
  param($case,$id,$hash,$nodeHash,$upgrade)
  if($env:COMPUTERNAME -ne 'MU-PRO-LAB' -or @(Get-VM).Count -or @(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -like '*MuCodeSandbox*' -or $_.ExecutablePath -like 'C:\MuLab\product\*'}).Count -or (Test-Path -LiteralPath $case)){throw 'Existing installation cases, VMs and processes are preserved'}
  $sid=(Get-LocalUser MuLabUser).SID.Value;if(@(Get-LocalGroupMember -SID S-1-5-32-544|Where-Object{$_.SID.Value -eq $sid}).Count){throw 'Ordinary synthetic user required'}
  New-Item -ItemType Directory -Path $case|Out-Null;$suffix=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('56iL5bqPIE8nQnJpZW4gJCDmtYvor5VcTXVDb2RlU2FuZGJveCBXaW5kb3dzIFByZXZpZXc='));$installed=Join-Path (Join-Path $case ('long-install-'+$id.Substring(0,20))) $suffix
  $meta=@{caseId=$id;version='0.4.66-preview.17';installed=$installed;installerSha256=$hash;nodeSha256=$nodeHash}
  if($upgrade){
   $prior=[IO.File]::ReadAllText('C:\MuLab\approved\package-config.json')|ConvertFrom-Json
   if($prior.caseId -notmatch '^[a-f0-9]{32}$' -or $prior.userSid -ne $sid -or $prior.version -ne '0.4.66-preview.1'){throw 'Only the independently recorded original Pro package may be upgraded'}
   $oldRoot='C:\MuLab\public\package-'+$prior.caseId;$stateFile=Join-Path $oldRoot state.json;$original=[IO.File]::ReadAllText($stateFile)|ConvertFrom-Json;$expected=Join-Path $oldRoot $suffix
   if($original.caseId -ne $prior.caseId -or [IO.Path]::GetFullPath($original.installed) -cne $expected -or [IO.Path]::GetFullPath($original.data) -cne (Join-Path $oldRoot independent-data)){throw 'Original installation/data paths changed'}
   foreach($entry in $original.applicationHashes.psobject.Properties){if((Get-FileHash -LiteralPath (Join-Path $expected $entry.Name)).Hash.ToLowerInvariant() -ne $entry.Value){throw 'Original installed application differs from its package receipt'}}
   foreach($entry in $original.dataHashes.psobject.Properties){if((Get-FileHash -LiteralPath (Join-Path $original.data $entry.Name)).Hash.ToLowerInvariant() -ne $entry.Value){throw 'Original encrypted/user data differs from its package receipt'}}
   $meta.installed=$expected;$meta.expectedPrior=@{version=$prior.version;path=$expected};$meta.legacyStateFile=$stateFile;$meta.legacyCaseId=$prior.caseId;$meta.legacyData=$original.data
  }
  [IO.File]::WriteAllText((Join-Path $case case.json),($meta|ConvertTo-Json -Depth 8 -Compress))
 }
 Copy-Item -LiteralPath $installer -Destination (Join-Path $case setup.exe) -ToSession $session
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot pro-installed-backup-client.mjs) -Destination C:\MuLab\installed-backup.mjs -ToSession $session
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot ProInstalledBackupStation.cs) -Destination C:\MuLab\private\ProInstalledBackupStation.cs -ToSession $session
 Save 'installing-and-waiting-for-installed-node' @{caseId=$CaseId}
 $r=Invoke-Command -Session $session -ArgumentList $CaseId,$case -ScriptBlock {
  param($id,$case)
  $ErrorActionPreference='Stop';$meta=[IO.File]::ReadAllText((Join-Path $case case.json))|ConvertFrom-Json;$sid=(Get-LocalUser MuLabUser).SID.Value;$node='C:\MuLab\product\resources\node\node.exe';$cfg=@{caseId=$id;sid=$sid;clientSha256=(Get-FileHash C:\MuLab\installed-backup.mjs).Hash.ToLowerInvariant();nodeSha256=(Get-FileHash $node).Hash.ToLowerInvariant()};[IO.File]::WriteAllText(('C:\MuLab\approved\installed-backup-'+$id+'.json'),($cfg|ConvertTo-Json -Compress));$launcher='C:\MuLab\private\installed-station-'+$id+'.exe'
  Add-Type -TypeDefinition ([IO.File]::ReadAllText('C:\MuLab\private\ProInstalledBackupStation.cs')) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -OutputAssembly $launcher -OutputType ConsoleApplication
  $station=Start-Process -FilePath $launcher -ArgumentList @($id,'bootstrap') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $case station-out.log) -RedirectStandardError (Join-Path $case station-error.log) -PassThru;$null=$station.Handle
  $until=[DateTime]::UtcNow.AddMinutes(8);do{if(Test-Path -LiteralPath (Join-Path $case verify-owner.json)){break};if(Test-Path -LiteralPath (Join-Path $case bootstrap-result.json)){throw 'Installation/bootstrap ended before installed controller; inspect preserved result'};if($station.HasExited -or [DateTime]::UtcNow -gt $until){throw 'Installation remains pending; do not restart'};Start-Sleep -Milliseconds 250}while($true)
  $owner=[IO.File]::ReadAllText((Join-Path $case verify-owner.json))|ConvertFrom-Json;$actualNode=Join-Path $meta.installed resources/node/node.exe;$actor=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$owner.pid)
  if($owner.caseId -cne $id -or $owner.phase -ne 'verify' -or $owner.nonce -notmatch '^[a-f0-9]{64}$' -or $actor.ExecutablePath -cne $actualNode -or (Invoke-CimMethod -InputObject $actor -MethodName GetOwnerSid).Sid -ne $sid){throw 'Actual installed Node identity changed'}
  $controller=Get-Process -Id $owner.pid;$null=$controller.Handle;$bin=Join-Path $env:ProgramData MuCodeSandbox-HyperVBroker-v1/bin;$pointer=[IO.File]::ReadAllText((Join-Path $bin current.json))|ConvertFrom-Json;$broker=Join-Path $bin $pointer.brokerFile
  if((Get-FileHash $broker).Hash.ToLowerInvariant() -ne $pointer.brokerSha256){throw 'Protected broker changed'}
  $agent=Start-Process -FilePath $broker -ArgumentList @('--owner',[string]$owner.pid,'--pipe',$owner.nonce,'--detect-host') -WorkingDirectory $bin -WindowStyle Hidden -RedirectStandardOutput (Join-Path $case broker-out.log) -RedirectStandardError (Join-Path $case broker-error.log) -PassThru;$null=$agent.Handle
  $preserved=$null;$until=[DateTime]::UtcNow.AddMinutes(40)
  do{
   if(-not $preserved -and (Test-Path -LiteralPath (Join-Path $case verify-preserve-request.json))){
    $request=[IO.File]::ReadAllText((Join-Path $case verify-preserve-request.json))|ConvertFrom-Json;if($request.nonce -cne $owner.nonce -or $request.id -notmatch '^[a-f0-9-]{36}$'){throw 'Bound original preservation request required'}
    $source=Get-VM -Id ([guid]$request.platformId);$disk=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid+'/vms/'+$request.id+'/disk.vhdx');$d=@(Get-VMHardDiskDrive -VM $source)
    if($source.State -ne 'Off' -or $d.Count -ne 1 -or [IO.Path]::GetFullPath($d[0].Path) -cne $disk -or (Get-FileHash $disk).Hash.ToLowerInvariant() -ne $request.diskSha256){throw 'Original stopped source changed'}
    $copy='C:\MuLab\private\installed17-original-'+$id+'.vhdx';[IO.File]::Copy($disk,$copy,$false);if((Get-FileHash $copy).Hash.ToLowerInvariant() -ne $request.diskSha256){throw 'Independent original copy changed'};$preserved=@{copy=$copy;sha256=$request.diskSha256};[IO.File]::WriteAllText((Join-Path $case preserved.json),(@{nonce=$owner.nonce;sha256=$preserved.sha256}|ConvertTo-Json -Compress))
   }
   if(Test-Path -LiteralPath (Join-Path $case bootstrap-result.json)){break};if([DateTime]::UtcNow -gt $until){throw 'The exact installed controller remains pending; preserve its handles'};Start-Sleep -Milliseconds 500
  }while($true)
  $result=[IO.File]::ReadAllText((Join-Path $case bootstrap-result.json))|ConvertFrom-Json
  if(-not $result.complete -or $result.caseId -cne $id -or -not $preserved){throw 'Installed API round trip failed; original artifacts retained'}
  if(-not $controller.WaitForExit(15000) -or -not $agent.WaitForExit(60000) -or -not $station.WaitForExit(15000) -or $station.ExitCode -ne 0 -or @(Get-VM).Count -or (Get-FileHash $preserved.copy).Hash.ToLowerInvariant() -ne $preserved.sha256){throw 'Independent controller, VM or original copy cleanup unconfirmed'}
  $userRoot=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid);$ledger=[IO.File]::ReadAllText((Join-Path $userRoot vms.json));if($ledger -cne [IO.File]::ReadAllText((Join-Path $userRoot vms.backup.json)) -or @((ConvertFrom-Json $ledger).records.PSObject.Properties).Count){throw 'Protected allocations remain'}
  $registration=[IO.File]::ReadAllText((Join-Path $case bootstrap-installation.json))|ConvertFrom-Json;if($registration.sid -ne $sid -or $registration.version -ne $meta.version -or $registration.elevated -or $registration.installed -ne $meta.installed.Replace('\','/')){throw 'Ordinary-user installation registration differs'}
  $hashes=@{};function HashCode($dir,$prefix){foreach($e in Get-ChildItem -LiteralPath $dir){if($e.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Installed reparse input'};$name=$prefix+'/'+$e.Name;if($e.PSIsContainer){HashCode $e.FullName $name}else{$hashes[$name]=(Get-FileHash $e.FullName).Hash.ToLowerInvariant()}}};foreach($name in @('dist','dist-server','desktop')){HashCode (Join-Path $meta.installed ('resources/app/'+$name)) $name}
  @{caseId=$id;version=$meta.version;bootstrap=$result;registration=$registration;installedCodeHashes=$hashes;installedNodeSha256=(Get-FileHash $actualNode).Hash.ToLowerInvariant();installedExecutableSha256=(Get-FileHash (Join-Path $meta.installed 'MuCodeSandbox Windows Preview.exe')).Hash.ToLowerInvariant();installerSha256=(Get-FileHash (Join-Path $case setup.exe)).Hash.ToLowerInvariant();fixtureSha256=$cfg.clientSha256;brokerSourceDigest=$pointer.sourceDigest;originalCopyUnchanged=$true;noNestedVms=$true;controllersExited=$true;installedRetained=$true;syntheticAutologonDisabled=((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon').AutoAdminLogon -eq '0')}
 }
 Stop-VM -VM $vm -Confirm:$false;while((Get-VM -Id $vm.Id).State -ne 'Off'){Start-Sleep -Milliseconds 250};Save 'installed-api-complete-pro-off' $r
}catch{Save 'failed' @{message=$_.Exception.Message;stack=$_.ScriptStackTrace};throw}
finally{if($session){Remove-PSSession $session};$guard.Dispose()}
