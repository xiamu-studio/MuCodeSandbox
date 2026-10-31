param([ValidateSet('identity','authority')][string]$Mode,[string]$Directory,[string]$Executable,[string]$SourceDigest)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=[Security.Principal.WindowsPrincipal]::new($identity);$sid=$identity.User.Value;$admin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if($admin){throw 'Ordinary-token boundary fixture refuses an administrator process'}
if($Mode -eq 'identity'){[Console]::Write((@{sid=$sid;administrator=$admin}|ConvertTo-Json -Compress));return}
$root=[IO.Path]::GetFullPath($Directory);if([IO.Path]::GetFullPath($Executable) -ne (Join-Path $root 'broker.exe')){throw 'Only the fixture executable may be loaded'}
$assembly=[Reflection.Assembly]::LoadFile($Executable);$embedded=$assembly.GetType('MuHyperVBroker').GetField('SourceDigest',([Reflection.BindingFlags]'NonPublic,Static')).GetRawConstantValue();if($embedded -cne $SourceDigest){throw 'Compiled source digest differs'}
$type=$assembly.GetType('MuRestoreOriginStore');$authority=$type.GetMethod('ValidateAuthority',([Reflection.BindingFlags]'NonPublic,Static'));if($null -eq $authority){throw 'Production native authority method missing'}
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
public static class EntryProbeHandles {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 public static SafeFileHandle Open(string path,bool directory){var h=CreateFile(path,0x20081,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);if(h.IsInvalid){h.Dispose();throw new InvalidOperationException("Cannot open authority fixture object");}return h;}
}
'@
function Reject-Authority($handle,[bool]$directory){$refused=$false;try{$authority.Invoke($null,[object[]]@($handle,$directory))|Out-Null}catch{if($_.Exception.GetBaseException().GetType().Name -ne 'UnauthorizedAccessException'){throw};$refused=$true};if(-not $refused){throw 'Production native authority accepted ordinary storage'}}
$checks=@();foreach($item in @(@($root,$true),@((Join-Path $root 'restore-origins'),$true),@((Join-Path $root 'restore-origins/.lock'),$false))){
 $path=[string]$item[0];$isDirectory=[bool]$item[1];$acl=if($isDirectory){[IO.Directory]::GetAccessControl($path)}else{[IO.File]::GetAccessControl($path)};$before=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All);$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
 if($owner -ne $sid){throw 'Fixture must remain owned by its actual ordinary creator'};$handle=[EntryProbeHandles]::Open($path,$isDirectory);try{Reject-Authority $handle $isDirectory}finally{$handle.Dispose()}
 $after=if($isDirectory){[IO.Directory]::GetAccessControl($path)}else{[IO.File]::GetAccessControl($path)};if($after.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All) -cne $before){throw 'Authority refusal changed an ACL'};$checks+=@{directory=$isDirectory;owner=$owner;rejected=$true;aclUnchanged=$true}
}
$invalid=[Microsoft.Win32.SafeHandles.SafeFileHandle]::new([IntPtr]::Zero,$false);try{Reject-Authority $invalid $false}finally{$invalid.Dispose()}
$ctor=$type.GetConstructor([type[]]@([string],[string],[bool]));$refused=$false;try{$store=$ctor.Invoke([object[]]@($root,$sid,$true));$store.Dispose()}catch{if($_.Exception.GetBaseException().GetType().Name -ne 'UnauthorizedAccessException'){throw};$refused=$true};if(-not $refused){throw 'Public production store constructor accepted ordinary storage'}
[Console]::Write((@{complete=$true;embeddedDigest=$embedded;actualProductionAssembly=$true;realWin32Authority=$true;ordinaryOwnerRejected=$true;checks=$checks;invalidHandleRejected=$true;publicConstructorRejected=$true;administrator=$admin;realHyperV=$false;trustedAclPublication=$false}|ConvertTo-Json -Depth 6 -Compress))
