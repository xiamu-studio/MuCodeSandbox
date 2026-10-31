param([string]$Directory,[string]$Native,[string]$Harness,[string]$Case)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Web.Extensions
$core=[IO.File]::ReadAllText($Harness)
foreach($name in @('ProtectedLedger.cs','RecoveryPermissions.cs','Recovery.cs','RestoreOriginOperations.cs')){$core+=[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $Native $name))}
$file=Join-Path $Directory 'recovery-core.cs';[IO.File]::WriteAllText($file,$core,[Text.UTF8Encoding]::new($false))
Add-Type -Path @($file,(Join-Path $Native 'RestoreOriginProof.cs'),(Join-Path $Native 'RestoreOriginStore.cs'),(Join-Path $Native 'RestoreOriginFrames.cs'),(Join-Path $Native 'OriginPreparation.cs')) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
[Console]::Write([MuHyperVBroker]::RunOriginRecoveryFixture($Directory,$Case))
