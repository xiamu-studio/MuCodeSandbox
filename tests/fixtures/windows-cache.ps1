[CmdletBinding()]
param([string]$Directory,[string]$Source,[string]$Case)
$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions
$sourceText=[IO.File]::ReadAllText($Source).Split(@('public static partial class MuHyperVBroker'),[StringSplitOptions]::None)[0]
$header='using System;using System.IO;using System.Linq;using System.Text;using System.Collections.Generic;using System.Threading;using System.Security.Cryptography;using System.Runtime.InteropServices;using System.Web.Script.Serialization;'
Add-Type -TypeDefinition ($header+[Environment]::NewLine+$sourceText) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
$root=[IO.Path]::GetFullPath($Directory);$images=Join-Path $root 'images';$bases=Join-Path $root 'bases';[IO.Directory]::CreateDirectory($images) | Out-Null;[IO.Directory]::CreateDirectory($bases) | Out-Null
$sid='S-1-5-21-1-2-3-1001';$a='a'*64;$b='b'*64;$c='c'*64;$d='d'*64;$refs=[string[]]@($b);$blocked=[string[]]@();$json=[System.Web.Script.Serialization.JavaScriptSerializer]::new()
$noop=[Action[string]]{param($file)};$cache=[MuImageCache]::new($root,$sid,$noop)
function Check([bool]$value,[string]$message){if(-not $value){throw $message}}
function Reject([scriptblock]$work,[string]$code){$rejected=$false;try{& $work}catch{$e=$_.Exception.GetBaseException();if(($e -is [MuStorageException] -and $e.Code -ne $code) -or ($e -isnot [MuStorageException] -and $e.GetType().Name -ne $code)){throw ('Unexpected failure '+$e.GetType().Name+': '+$e.Message)};$rejected=$true};Check $rejected 'Unsafe cache operation was accepted'}
function Image([string]$digest){[IO.File]::WriteAllText((Join-Path $images ($digest+'.vhdx')),('synthetic cached copy '+$digest))}
function Catalogue([string]$digest){$value=@{ownerSid=$sid;imageSha256=$digest;sourceSha256='c74a7d3b3476ffb2715bfcaf9c216e9dd1d6c7e01bc6d0380b1744518dfae15c';recipe='windows-amd64-desktop-v1'};[IO.File]::WriteAllText((Join-Path $bases ($digest+'.json')),($value | ConvertTo-Json -Compress))}
Image $a;Image $b;Image $c;Image $d;Catalogue $a;Catalogue $b;Catalogue $d
$original=Join-Path $root 'original-vm-disk.vhdx';[IO.File]::WriteAllText($original,'original guest bytes')
$none=[Threading.CancellationToken]::None
switch($Case){
 'pins' {
  $temp=Join-Path $images ($a+'.vhdx.'+[guid]::NewGuid().ToString('N')+'.next');[IO.File]::WriteAllText($temp,'interrupted import')
  $plan=$cache.Inspect($refs,$a,$blocked);Check ($plan.imageCount -eq 4 -and $plan.reclaimableFiles -eq 4) 'Unexpected cache candidates';$cache.Prune($refs,$a,$blocked,$plan.plan,$none) | Out-Null
  foreach($digest in @($a,$b)){Check ([IO.File]::ReadAllText((Join-Path $images ($digest+'.vhdx'))) -ceq ('synthetic cached copy '+$digest)) 'A retained image changed';Check ([IO.File]::Exists((Join-Path $bases ($digest+'.json')))) 'A retained catalogue was removed'}
  foreach($path in @((Join-Path $images ($c+'.vhdx')),(Join-Path $images ($d+'.vhdx')),(Join-Path $bases ($d+'.json')),$temp)){Check (-not [IO.File]::Exists($path)) 'An unused cache candidate remains'}
 }
 'recovery' {
  $plan=$cache.Inspect($refs,[NullString]::Value,$blocked);$cache.Prune($refs,[NullString]::Value,$blocked,$plan.plan,$none) | Out-Null
  foreach($digest in @($a,$b,$d)){Check ([IO.File]::Exists((Join-Path $images ($digest+'.vhdx')))) 'A recoverable sealed base was removed'};Check (-not [IO.File]::Exists((Join-Path $images ($c+'.vhdx')))) 'Unused raw copy was not reclaimed'
 }
 'dependencies' {
  $blocked=[string[]]@(($c+'.vhdx'),($d+'.vhdx'));$plan=$cache.Inspect($refs,$a,$blocked);Check ($plan.reclaimableFiles -eq 0) 'A dependent disk became a candidate';$cache.Prune($refs,$a,$blocked,$plan.plan,$none) | Out-Null;Check ([IO.File]::Exists((Join-Path $bases ($d+'.json')))) 'Dependent catalogue was removed'
 }
 'stale' {
  $plan=$cache.Inspect($refs,$a,$blocked);[IO.File]::AppendAllText((Join-Path $images ($c+'.vhdx')),'changed');Reject {$cache.Prune($refs,$a,$blocked,$plan.plan,$none) | Out-Null} 'CACHE_PLAN_CHANGED';Check ([IO.File]::Exists((Join-Path $images ($d+'.vhdx')))) 'A stale plan partially deleted candidates'
 }
 'unknown' {
  $unknown=Join-Path $images 'unrecognized-data';[IO.Directory]::CreateDirectory($unknown) | Out-Null;[IO.File]::WriteAllText((Join-Path $unknown 'keep.txt'),'preserved');$plan=$cache.Inspect($refs,$a,$blocked);Check ($plan.unrecognizedEntries -eq 1) 'Unknown storage was not reported';Reject {$cache.Prune($refs,$a,$blocked,$plan.plan,$none) | Out-Null} 'CACHE_UNKNOWN_DATA';Check ([IO.File]::ReadAllText((Join-Path $unknown 'keep.txt')) -ceq 'preserved') 'Unknown storage changed'
 }
 'links' {
  $target=Join-Path $root 'external-copy.vhdx';[IO.File]::Move((Join-Path $images ($c+'.vhdx')),$target);New-Item -ItemType HardLink -Path (Join-Path $images ($c+'.vhdx')) -Value $target | Out-Null;Reject {$cache.Inspect($refs,$a,$blocked) | Out-Null} 'CACHE_INTEGRITY';[IO.File]::Delete((Join-Path $images ($c+'.vhdx')))
  $outside=Join-Path $root 'outside';[IO.Directory]::CreateDirectory($outside) | Out-Null;[IO.File]::WriteAllText((Join-Path $outside 'keep.txt'),'outside retained');New-Item -ItemType Junction -Path (Join-Path $images ($c+'.vhdx')) -Value $outside | Out-Null;Reject {$cache.Inspect($refs,$a,$blocked) | Out-Null} 'CACHE_INTEGRITY';Check ([IO.File]::ReadAllText((Join-Path $outside 'keep.txt')) -ceq 'outside retained') 'Reparse target changed'
 }
 'catalogue' {
  $file=Join-Path $bases ($d+'.json');$value=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json;$value.ownerSid='S-1-5-21-1-2-3-9999';[IO.File]::WriteAllText($file,($value | ConvertTo-Json -Compress));Reject {$cache.Inspect($refs,$a,$blocked) | Out-Null} 'CACHE_INTEGRITY';Check ([IO.File]::Exists((Join-Path $images ($c+'.vhdx')))) 'Invalid catalogue allowed deletion'
 }
 'cancel' {
  $plan=$cache.Inspect($refs,$a,$blocked);$cancel=[Threading.CancellationTokenSource]::new();$cancel.Cancel();Reject {$cache.Prune($refs,$a,$blocked,$plan.plan,$cancel.Token) | Out-Null} 'OperationCanceledException';Check ([IO.File]::Exists((Join-Path $images ($c+'.vhdx')))) 'Cancelled cleanup removed a file';$cancel.Dispose()
 }
 'access' {
  $plan=$cache.Inspect($refs,$a,$blocked);[IO.File]::SetLastAccessTimeUtc((Join-Path $images ($c+'.vhdx')),[DateTime]::UtcNow.AddHours(-1));Check ($cache.Inspect($refs,$a,$blocked).plan -ceq $plan.plan) 'Access time invalidated a stable file identity';$cache.Prune($refs,$a,$blocked,$plan.plan,$none) | Out-Null
 }
 'replay' {
  $plan=$cache.Inspect($refs,$a,$blocked);$cache.Prune($refs,$a,$blocked,$plan.plan,$none) | Out-Null;Reject {$cache.Prune($refs,$a,$blocked,$plan.plan,$none) | Out-Null} 'CACHE_PLAN_CHANGED'
 }
}
Check ([IO.File]::ReadAllText($original) -ceq 'original guest bytes') 'Original VM data was changed'
