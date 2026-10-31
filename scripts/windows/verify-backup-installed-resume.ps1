#Requires -RunAsAdministrator
param([Parameter(Mandatory)][string]$Directory,[Parameter(Mandatory)][int]$OwnerPid,[string]$Action='resume-export',[Parameter(Mandatory)][string]$CaseId)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if($Action -notin @('resume-export','retry-resume') -or $CaseId -notmatch '^[a-f0-9]{32}$'){throw 'Typed existing source continuation required'}
Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs')
$guard=[MuPacketLabGuard]::new($OwnerPid,[IO.Path]::GetFullPath($Directory));$session=$null;$report=$guard.Reserve('preview14-'+[guid]::NewGuid().ToString('N')+'.json')
function Save($state,$value){[IO.File]::WriteAllText($report,(@{state=$state;time=[DateTime]::UtcNow.ToString('o');result=$value}|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))}
try{
 $machine=[IO.File]::ReadAllText((Join-Path $Directory machine.json))|ConvertFrom-Json;$vm=Get-VM -Id ([guid]$machine.id);$disks=@(Get-VMHardDiskDrive -VM $vm)
 if($vm.State -ne 'Running' -or $vm.Name -ne $machine.name -or $vm.Name -notmatch '^mu-win-clean-[a-f0-9]{32}$' -or $vm.Notes -ne ('MuCodeSandbox clean Windows diagnostic '+$vm.Name) -or $disks.Count -ne 1 -or [IO.Path]::GetFullPath($disks[0].Path) -cne [IO.Path]::GetFullPath((Join-Path $Directory trace-artifacts/windows.vhdx)) -or @(Get-VMNetworkAdapter -VM $vm|Where-Object SwitchName).Count){throw 'Disconnected evaluation identity changed'}
 $credentials=[IO.File]::ReadAllText((Join-Path $Directory guest-seed/private/credentials.json))|ConvertFrom-Json;$credential=[pscredential]::new($credentials.adminUser,(ConvertTo-SecureString $credentials.adminPassword -AsPlainText -Force));$session=New-PSSession -VMId $vm.Id -Credential $credential
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot clean-host-backup-installed-resume.mjs) -Destination C:\MuLab\backup-installed-resume.mjs -ToSession $session
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot Preview14Station.cs) -Destination C:\MuLab\private\Preview14ResumeStation.cs -ToSession $session
 Save 'resuming-original-case' @{caseId=$CaseId}
 $result=Invoke-Command -Session $session -ArgumentList $CaseId,($Action -eq 'retry-resume') -ScriptBlock {
  param($id,$retry)
  $ErrorActionPreference='Stop';$case='C:\MuLab\public\backup-preview14-'+$id
  $meta=[IO.File]::ReadAllText((Join-Path $case case.json))|ConvertFrom-Json;$failed=[IO.File]::ReadAllText((Join-Path $case verify-result.json))|ConvertFrom-Json;$diagnostic=[IO.File]::ReadAllText((Join-Path $case diagnostic-result.json))|ConvertFrom-Json;$installation=[IO.File]::ReadAllText((Join-Path $case upgrade-result.json))|ConvertFrom-Json
  if($env:COMPUTERNAME -ne 'MU-CLEAN-LAB' -or $meta.caseId -cne $id -or $meta.version -ne '0.4.66-preview.16' -or $failed.complete -ne $false -or $failed.checks.Count -ne 2 -or -not $diagnostic.complete -or $diagnostic.observed.name -ne 'ZodError' -or $installation.checks.Count -ne 1 -or -not $installation.checks[0].passed){throw 'Original failed case and successful installer check required'}
  if(@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -like '*MuCodeSandbox*' -or $_.ExecutablePath -like 'C:\MuLab\product\*'}).Count){throw 'An original product process is still active'}
  $guests=@(Get-VM);$sid=(Get-LocalUser MuLabUser).SID.Value;if($guests.Count -ne 1 -or $guests[0].State -ne 'Off' -or $guests[0].Name -ne ('mu-win-'+$diagnostic.id.Replace('-',''))){throw 'Original stopped VM changed'};$originalId=[string]$guests[0].Id
  if(@(Get-LocalGroupMember -SID S-1-5-32-544|Where-Object{$_.SID.Value -eq $sid}).Count){throw 'The product user must remain ordinary'}
  if($retry){
   $prior=[IO.File]::ReadAllText((Join-Path $case resume-result.json))|ConvertFrom-Json
   if($prior.complete -ne $false -or $prior.checks.Count -ne 1 -or $prior.error.code -ne 'PROCESS_FAILED' -or $prior.error.message -notlike '*mu-network-lease*status*' -or (Get-Process -Id $prior.pid -ErrorAction SilentlyContinue)){throw 'Only the confirmed terminal missing-configuration fixture can be retried'}
   foreach($name in @('owner','progress','result')){[IO.File]::Move((Join-Path $case ('resume-'+$name+'.json')),(Join-Path $case ('resume-attempt1-'+$name+'.json')))}
   [IO.File]::Move(('C:\MuLab\approved\preview14-resume-launch-'+$id+'.json'),('C:\MuLab\approved\preview14-resume-attempt1-launch-'+$id+'.json'))
  }
  if((Test-Path -LiteralPath (Join-Path $case resume-owner.json)) -or (Test-Path -LiteralPath (Join-Path $case resume-result.json))){throw 'An existing continuation must be inspected rather than restarted'}
  $node=Join-Path $meta.installed resources/node/node.exe;$config=@{caseId=$id;sid=$sid;node=$node;clientSha256=(Get-FileHash C:\MuLab\backup-installed-resume.mjs).Hash.ToLowerInvariant();nodeSha256=(Get-FileHash -LiteralPath $node).Hash.ToLowerInvariant()}
  [IO.File]::WriteAllText(('C:\MuLab\approved\preview14-resume-launch-'+$id+'.json'),($config|ConvertTo-Json -Compress));$launcher='C:\MuLab\private\preview14-resume-'+$id+'-'+$config.clientSha256.Substring(0,12)+'.exe'
  Add-Type -TypeDefinition ([IO.File]::ReadAllText('C:\MuLab\private\Preview14ResumeStation.cs')) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -OutputAssembly $launcher -OutputType ConsoleApplication
  $station=Start-Process -FilePath $launcher -ArgumentList @($id,'resume-export') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $case resume-station-out.log) -RedirectStandardError (Join-Path $case resume-station-error.log) -PassThru
  $until=[DateTime]::UtcNow.AddMinutes(2);do{if(Test-Path -LiteralPath (Join-Path $case resume-owner.json)){break};if($station.HasExited -or [DateTime]::UtcNow -gt $until){throw 'Continuation launch is unconfirmed; original preserved'};Start-Sleep -Milliseconds 250}while($true)
  $owner=[IO.File]::ReadAllText((Join-Path $case resume-owner.json))|ConvertFrom-Json;$actor=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$owner.pid)
  if($owner.caseId -cne $id -or $owner.nonce -notmatch '^[a-f0-9]{64}$' -or $actor.ExecutablePath -cne $node -or (Invoke-CimMethod -InputObject $actor -MethodName GetOwnerSid).Sid -ne $sid){throw 'Installed continuation process binding changed'}
  $controller=Get-Process -Id $owner.pid;$null=$controller.Handle;$bin=Join-Path $env:ProgramData MuCodeSandbox-HyperVBroker-v1/bin;$pointer=[IO.File]::ReadAllText((Join-Path $bin current.json))|ConvertFrom-Json;$broker=Join-Path $bin $pointer.brokerFile
  if((Get-FileHash -LiteralPath $broker).Hash.ToLowerInvariant() -ne $pointer.brokerSha256){throw 'Protected broker changed'}
  $agent=Start-Process -FilePath $broker -ArgumentList @('--owner',[string]$owner.pid,'--pipe',$owner.nonce,'--detect-host') -WorkingDirectory $bin -WindowStyle Hidden -RedirectStandardOutput (Join-Path $case resume-broker-out.log) -RedirectStandardError (Join-Path $case resume-broker-error.log) -PassThru
  $until=[DateTime]::UtcNow.AddMinutes(35);$preserved=$null
  do{
   if(-not $preserved -and (Test-Path -LiteralPath (Join-Path $case resume-preserve-request.json))){
    $request=[IO.File]::ReadAllText((Join-Path $case resume-preserve-request.json))|ConvertFrom-Json
    if($request.caseId -cne $id -or $request.nonce -cne $owner.nonce -or $request.id -ne $diagnostic.id -or $request.platformId -ne $originalId){throw 'Original preservation identity changed'}
    $source=Get-VM -Id ([guid]$originalId);$disk=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid+'/vms/'+$request.id+'/disk.vhdx');$drives=@(Get-VMHardDiskDrive -VM $source)
    if($source.State -ne 'Off' -or $drives.Count -ne 1 -or [IO.Path]::GetFullPath($drives[0].Path) -cne $disk -or (Get-FileHash -LiteralPath $disk).Hash.ToLowerInvariant() -ne $request.disk.sha256){throw 'Original stopped disk changed'}
    $copy='C:\MuLab\private\preview16-resume-original-'+$id+'.vhdx';[IO.File]::Copy($disk,$copy,$false);if((Get-FileHash -LiteralPath $copy).Hash.ToLowerInvariant() -ne $request.disk.sha256){throw 'Independent original copy changed'}
    $preserved=@{nonce=$owner.nonce;sha256=$request.disk.sha256;copy=$copy};[IO.File]::WriteAllText((Join-Path $case resume-preserved.json),($preserved|ConvertTo-Json -Compress))
   }
   if(Test-Path -LiteralPath (Join-Path $case resume-result.json)){break};if([DateTime]::UtcNow -gt $until){throw 'The exact continuation is still pending; do not restart'};Start-Sleep -Milliseconds 500
  }while($true)
  $resumed=[IO.File]::ReadAllText((Join-Path $case resume-result.json))|ConvertFrom-Json
  if(-not $resumed.complete -or $resumed.nonce -cne $owner.nonce -or $resumed.checks.Count -ne 7 -or -not $preserved){throw 'The same-case continuation did not pass; artifacts retained'}
  if(-not $controller.WaitForExit(15000) -or -not $agent.WaitForExit(45000) -or -not $station.WaitForExit(15000) -or $station.ExitCode -ne 0 -or @(Get-VM).Count -or (Get-FileHash -LiteralPath $preserved.copy).Hash.ToLowerInvariant() -ne $preserved.sha256){throw 'Original copy or process/VM cleanup not confirmed'}
  $ledgerRoot=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid);$ledger=[IO.File]::ReadAllText((Join-Path $ledgerRoot vms.json));if($ledger -cne [IO.File]::ReadAllText((Join-Path $ledgerRoot vms.backup.json)) -or @((ConvertFrom-Json $ledger).records.PSObject.Properties).Count){throw 'Protected allocations remain'}
  $r=Get-ItemProperty -LiteralPath ('Registry::HKEY_USERS\'+$sid+'\Software\Microsoft\Windows\CurrentVersion\Uninstall\e88eb670-5944-5236-81aa-7c1d3da3d6df');if($r.DisplayVersion -ne $meta.version -or (Test-Path -LiteralPath ($meta.installed+'.mu-install.json'))){throw 'Installation registration or transaction is not complete'}
  $hashes=@{};function HashTree($dir,$prefix){foreach($entry in Get-ChildItem -LiteralPath $dir){if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Installed reparse entry'};$name=$prefix+'/'+$entry.Name;if($entry.PSIsContainer){HashTree $entry.FullName $name}else{$hashes[$name]=(Get-FileHash -LiteralPath $entry.FullName).Hash.ToLowerInvariant()}}};foreach($name in @('dist','dist-server','desktop')){HashTree (Join-Path $meta.installed ('resources/app/'+$name)) $name}
  @{caseId=$id;originalInstallation=$installation;resumed=$resumed;diagnostic=$diagnostic;originalPlatformId=$originalId;installedCodeHashes=$hashes;installedExecutableSha256=(Get-FileHash -LiteralPath (Join-Path $meta.installed 'MuCodeSandbox Windows Preview.exe')).Hash.ToLowerInvariant();installedNodeSha256=$config.nodeSha256;installerSha256=(Get-FileHash -LiteralPath (Join-Path $case setup.exe)).Hash.ToLowerInvariant();fixtureSha256=$config.clientSha256;brokerSourceDigest=$pointer.sourceDigest;registrationVerified=$true;originalCopyUnchanged=$true;nestedGuestsRemaining=0;installedControllerExited=$true;syntheticAutologonDisabled=((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon').AutoAdminLogon -eq '0')}
 }
 Stop-VM -VM $vm -Confirm:$false;while((Get-VM -Id $vm.Id).State -ne 'Off'){Start-Sleep -Milliseconds 250};Save 'installed-same-case-resume-complete-evaluation-vm-off' $result
}catch{Save 'failed' @{message=$_.Exception.Message;stack=$_.ScriptStackTrace};throw}
finally{if($session){Remove-PSSession $session};$guard.Dispose()}
