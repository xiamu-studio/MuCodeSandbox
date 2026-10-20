[CmdletBinding()]
param([Parameter(Mandatory)][string]$Broker,[Parameter(Mandatory)][string]$ExpectedBrokerHash,[Parameter(Mandatory)][string]$Channel,[Parameter(Mandatory)][string]$ExpectedChannelHash,[Parameter(Mandatory)][string]$SourceDigest)
$ErrorActionPreference='Stop'
$rootTrusted=$false
trap {
 if($rootTrusted){try{[IO.File]::AppendAllText((Join-Path $root 'install-errors.log'),[DateTime]::UtcNow.ToString('o')+' '+$_.Exception.ToString()+[Environment]::NewLine)}catch{}}
 exit 1
}
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Administrator installation required'}
$admin=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$users=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
function DirectoryAcl([bool]$public){
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($admin)
 $inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
 foreach($sid in @($admin,$system)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)))}
 if($public){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users,[Security.AccessControl.FileSystemRights]::ReadAndExecute,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)))}
 return $acl
}
function EnsureDirectory([string]$path,[bool]$public){
 if(-not [IO.Directory]::Exists($path)){[IO.Directory]::CreateDirectory($path,(DirectoryAcl $public)) | Out-Null}
 if(([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint)){throw 'Installation path is a reparse point'}
 $acl=[IO.Directory]::GetAccessControl($path);$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier])
 if($owner -ne $admin -and $owner -ne $system){throw 'Installation directory owner is not trusted'}
 $write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
 foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference -ne $admin -and $rule.IdentityReference -ne $system -and (($rule.FileSystemRights -band $write) -ne 0 -or -not $public)){throw 'Installation directory ACL is not trusted'}}
}
$root=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'MuCodeSandbox-HyperVBroker-v1'
EnsureDirectory $root $false
$rootTrusted=$true
$bin=Join-Path $root 'bin';EnsureDirectory $bin $true
$stage=Join-Path $root ('install-'+[guid]::NewGuid().ToString('N'));EnsureDirectory $stage $false
try{
 foreach($entry in @(@{source=$Broker;hash=$ExpectedBrokerHash;prefix='hv-broker-'},@{source=$Channel;hash=$ExpectedChannelHash;prefix='hv-channel-'})){
  if($entry.hash -notmatch '^[a-f0-9]{64}$'){throw 'Expected digest required'}
  $name=[IO.Path]::GetFileName($entry.source)
  if($name -notmatch ('^'+$entry.prefix+'[a-f0-9]{16}\.exe$')){throw 'Unexpected executable filename'}
  if($entry.prefix -eq 'hv-broker-' -and $name -ne ('hv-broker-'+$entry.hash.Substring(0,16)+'.exe')){throw 'Broker filename digest mismatch'}
  if($entry.prefix -eq 'hv-channel-' -and $name -ne ('hv-channel-'+$entry.hash.Substring(0,16)+'.exe')){throw 'Channel filename digest mismatch'}
  $staged=Join-Path $stage $name;[IO.File]::Copy($entry.source,$staged,$false)
  if((Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.hash){throw 'Executable digest mismatch'}
  $target=Join-Path $bin $name
  if([IO.File]::Exists($target)){if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.hash){throw 'Existing executable differs'}}else{[IO.File]::Move($staged,$target)}
  $acl=New-Object Security.AccessControl.FileSecurity;$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($admin)
  foreach($sid in @($admin,$system)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow)))}
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users,[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.AccessControlType]::Allow)))
  [IO.File]::SetAccessControl($target,$acl)
 }
 if($SourceDigest -notmatch '^[a-f0-9]{64}$'){throw 'Expected broker source digest'}
 $meta=@{brokerFile=[IO.Path]::GetFileName($Broker);brokerSha256=$ExpectedBrokerHash;channelFile=[IO.Path]::GetFileName($Channel);channelSha256=$ExpectedChannelHash;sourceDigest=$SourceDigest} | ConvertTo-Json -Compress
 $next=Join-Path $bin ('current-'+[guid]::NewGuid().ToString('N')+'.json');[IO.File]::WriteAllText($next,$meta,[Text.UTF8Encoding]::new($false))
 $current=Join-Path $bin 'current.json';if([IO.File]::Exists($current)){[IO.File]::Replace($next,$current,[NullString]::Value)}else{[IO.File]::Move($next,$current)}
}finally{
 # Only this generated, verified private installation staging folder is removed.
 $resolved=[IO.Path]::GetFullPath($stage);if([IO.Path]::GetDirectoryName($resolved) -ne $root -or [IO.Path]::GetFileName($resolved) -notmatch '^install-[a-f0-9]{32}$'){throw 'Staging boundary changed'}
 [IO.Directory]::Delete($resolved,$true)
}
