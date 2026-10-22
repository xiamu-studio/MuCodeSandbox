param([string]$CaseId)
$ErrorActionPreference='Stop';$env:PSModulePath=Join-Path $PSHOME 'Modules'
if($env:COMPUTERNAME -ne 'MU-PRO-LAB' -or $CaseId -notmatch '^[a-f0-9]{32}$'){throw 'Dedicated Pro upgrade case required'}
$config=[IO.File]::ReadAllText(('C:\MuLab\approved\upgrade-'+$CaseId+'-config.json'))|ConvertFrom-Json
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$elevated=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if($elevated -or $identity.User.Value -ne $config.userSid -or $env:USERNAME -ne $config.userName){throw 'Synthetic ordinary upgrade token required'}
$prefix=Join-Path $config.directory 'profile';$nonce=[guid]::NewGuid().ToString('N')
[IO.File]::WriteAllText($prefix+'-owner.json',(@{caseId=$CaseId;pid=$PID;nonce=$nonce}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Add-Type -AssemblyName System.Security
$clear=[Text.Encoding]::UTF8.GetBytes('synthetic-upgrade-profile-'+$CaseId);$file=Join-Path $config.directory 'profile-probe.dpapi'
if(-not(Test-Path -LiteralPath $file)){[IO.File]::WriteAllBytes($file,[Security.Cryptography.ProtectedData]::Protect($clear,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))}
$opened=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
if([Convert]::ToBase64String($opened) -cne [Convert]::ToBase64String($clear)){throw 'The upgrade profile cannot decrypt its original probe'}
$key='HKCU:\Software\MuCodeSandbox-UpgradeLab';New-Item -Path $key -Force|Out-Null
$stored=(Get-ItemProperty -Path $key -Name CaseId -ErrorAction SilentlyContinue).CaseId
if($stored -and $stored -ne $CaseId){throw 'Foreign upgrade profile registry preserved'}
Set-ItemProperty -Path $key -Name CaseId -Value $CaseId
$root=[Environment]::GetFolderPath('UserProfile');if([IO.Path]::GetFileName($root) -ne $config.userName){throw 'The task did not receive its dedicated loaded profile'}
[IO.File]::WriteAllText($prefix+'-result.json',(@{complete=$true;caseId=$CaseId;pid=$PID;nonce=$nonce;userSid=$identity.User.Value;ordinary=$true;profileLoaded=$true;dpapiRoundtrip=$true;hkcuIsolated=$true;interactiveAuthenticationAutomated=$false;aiWebsitesVisited=0}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
