param([string]$Directory,[string]$Native,[string]$Harness,[ValidateSet('pressure','metrics')][string]$Case='pressure')
$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions
function Source-Part([string]$Source,[string]$Start,[string]$End){$a=$Source.IndexOf($Start,[StringComparison]::Ordinal);$b=$Source.IndexOf($End,$a+$Start.Length,[StringComparison]::Ordinal);if($a -lt 0 -or $b -le $a){throw 'Exact production boundary missing'};return $Source.Substring($a,$b-$a)}
$broker=[IO.File]::ReadAllText((Join-Path $Native 'HyperVBroker.cs'))
$ownership=Source-Part $broker '    private static Dictionary<string,object> Owned(' '    private static string Invoke('
$recover=Source-Part $broker '    private static Dictionary<string,object> RecoverAllocation(' '    private static void CheckRemovalTree('
$ever=@($broker -split '\r?\n'|Where-Object{$_.StartsWith('    private static bool EverReady(')})
if($ever.Count -ne 1){throw 'Exact readiness boundary missing'}
$revoke=@($broker -split '\r?\n'|Where-Object{$_.StartsWith('    private static void RevokeCompactionChannels(')})
if($revoke.Count -ne 1){throw 'Exact maintenance revocation boundary missing'}
$resources=[IO.File]::ReadAllText((Join-Path $Native 'Resources.cs'));$power=[IO.File]::ReadAllText((Join-Path $Native 'PowerProtection.cs'))
$core=[IO.File]::ReadAllText($Harness)+[Environment]::NewLine+$resources+[Environment]::NewLine+$power+[Environment]::NewLine+'public static partial class MuHyperVBroker {'+[Environment]::NewLine+$ownership+$recover+$ever[0]+[Environment]::NewLine+$revoke[0]+[Environment]::NewLine+'}'
Add-Type -TypeDefinition $core -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
$sha=[Security.Cryptography.SHA256]::Create();try{$hashes=@{};foreach($name in @('HyperVBroker.cs','Resources.cs','PowerProtection.cs')){$hashes[$name]=([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes((Join-Path $Native $name))))).Replace('-','').ToLowerInvariant()}}finally{$sha.Dispose()}
[MuResourceMetrics]::Unavailable=($Case -eq 'metrics')
[Console]::Write([MuHyperVBroker]::RunEmergencyFixture($Directory,($hashes|ConvertTo-Json -Compress)))
