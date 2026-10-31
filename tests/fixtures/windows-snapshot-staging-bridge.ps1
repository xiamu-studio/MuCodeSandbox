param([string]$Directory,[string]$Native,[string]$Harness)
$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions
$text=[IO.File]::ReadAllText((Join-Path $Native 'SnapshotOperations.cs'))
function Part([string]$Start,[string]$End){$a=$text.IndexOf($Start,[StringComparison]::Ordinal);$b=$text.IndexOf($End,$a+$Start.Length,[StringComparison]::Ordinal);if($a -lt 0 -or $b -le $a){throw 'Exact production staging method boundary missing'};return $text.Substring($a,$b-$a)}
$parts=@((Part '    private static readonly Dictionary<string,CancellationTokenSource> SnapshotLiveDeletes=' '    private static void SnapshotLiveAuthority('),(Part '    private static string SnapshotDeleteAuthority(' '    private static bool SnapshotIsPending('),(Part '    private static MuSnapshotStaging SnapshotStagingStore(' '    // Provider inventory runs outside'),(Part '    private static object SnapshotStagingAction(' '    private static void SnapshotSealRollback('))
$source=[IO.File]::ReadAllText($Harness)+[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $Native 'OfflineSnapshots.cs'))+[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $Native 'SnapshotStaging.cs'))+[Environment]::NewLine+'public static partial class MuHyperVBroker {'+[Environment]::NewLine+($parts -join [Environment]::NewLine)+[Environment]::NewLine+'}'
Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
[Console]::Write([MuHyperVBroker]::RunStagingBridge($Directory))
