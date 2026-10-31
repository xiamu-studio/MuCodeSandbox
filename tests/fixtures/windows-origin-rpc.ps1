param([string]$Directory,[string]$Native,[string]$Harness,[string]$RpcHarness,[int]$OwnerPid,[string]$Nonce,[string]$SourceDigest,[ValidateSet('missing-ledgers','corrupt-ledgers')][string]$Case='missing-ledgers')
$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions
function Source-Part([string]$Source,[string]$Start,[string]$End){$a=$Source.IndexOf($Start,[StringComparison]::Ordinal);$b=$Source.IndexOf($End,$a+$Start.Length,[StringComparison]::Ordinal);if($a -lt 0 -or $b -le $a){throw 'Exact production method boundary missing'};return $Source.Substring($a,$b-$a)}
$broker=[IO.File]::ReadAllText((Join-Path $Native 'HyperVBroker.cs'))
$serve=Source-Part $broker '    private static byte[] ReadRequest(Stream pipe)' '    private static void Shutdown()'
$bounds=Source-Part $broker '    private static void RequestBounds(' '    private static bool OwnerExited'
$owner=Source-Part $broker '    private static bool OwnerExited' '    private static DirectorySecurity PrivateAcl()'
$resources=[IO.File]::ReadAllText((Join-Path $Native 'Resources.cs'));$mutation=Source-Part $resources '    private static bool ResourceMutation(' '    private static FileStream ImportReservation()'
$dispatch=Source-Part $broker '    private static object Dispatch(' '    private static byte[] ReadRequest(Stream pipe)'
$policy=Source-Part $resources 'public static class MuResourcePolicy {' 'public static partial class MuHyperVBroker {'
$harnessText=[IO.File]::ReadAllText($Harness);$oldPolicy='public static class MuResourcePolicy {public static void Quota(long current,long capacity){if(current+capacity>1024)throw new IOException("Quota exceeded");}}';if(-not $harnessText.Contains($oldPolicy)){throw 'Exact fixture policy boundary changed'};$harnessText=$harnessText.Replace($oldPolicy,'')
$core='using System.IO.Pipes;using System.Diagnostics;'+[Environment]::NewLine+$harnessText+[Environment]::NewLine+[IO.File]::ReadAllText($RpcHarness)+[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path (Split-Path $RpcHarness) 'windows-origin-dispatch.cs'))+[Environment]::NewLine+$policy
foreach($name in @('ProtectedLedger.cs','RecoveryPermissions.cs','Recovery.cs','RestoreOriginOperations.cs')){$core+=[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $Native $name))}
$core+=[Environment]::NewLine+'public static partial class MuHyperVBroker {'+[Environment]::NewLine+$dispatch+$serve+$bounds+$owner+$mutation+[Environment]::NewLine+'}'
$path=Join-Path $Directory 'rpc-core.cs';[IO.File]::WriteAllText($path,$core,[Text.UTF8Encoding]::new($false))
Add-Type -Path @($path,(Join-Path $Native 'RestoreOriginProof.cs'),(Join-Path $Native 'RestoreOriginStore.cs'),(Join-Path $Native 'RestoreOriginFrames.cs'),(Join-Path $Native 'OriginPreparation.cs')) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
$hash=[Security.Cryptography.SHA256]::Create();try{$dispatchHash=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($dispatch)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
[MuHyperVBroker]::RunRecoveryRpc($Directory,$OwnerPid,$Nonce,$Case,$SourceDigest,$dispatchHash)
