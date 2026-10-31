param([string]$Directory,[string]$Native,[string]$Harness)
$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions
$source=[IO.File]::ReadAllText((Join-Path $Native 'SnapshotOperations.cs'))
$start=$source.IndexOf('    private static readonly Dictionary<string,CancellationTokenSource> SnapshotLiveDeletes=',[StringComparison]::Ordinal)
$end=$source.IndexOf('    private static MuOfflineSnapshotStore SnapshotDeletionStore(',[StringComparison]::Ordinal)
if($start -lt 0 -or $end -le $start){throw 'Exact production live deletion boundary missing'}
$methods=$source.Substring($start,$end-$start)
$core=[IO.File]::ReadAllText($Harness)+[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $Native 'OfflineSnapshots.cs'))+[Environment]::NewLine+'public static partial class MuHyperVBroker {'+[Environment]::NewLine+$methods+[Environment]::NewLine+'}'
Add-Type -TypeDefinition $core -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
$sha=[Security.Cryptography.SHA256]::Create();try{$hash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($methods)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
[Console]::Write([MuHyperVBroker]::RunLiveDeleteFixture($Directory,$hash))
