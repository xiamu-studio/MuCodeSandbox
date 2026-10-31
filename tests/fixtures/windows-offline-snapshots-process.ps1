param([string]$Directory,[string]$Source,[string]$Harness,[ValidateSet('prepare','recover')][string]$Mode,[ValidateSet('restore-replaced-disk','restore-committed')][string]$Boundary)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Web.Extensions
Add-Type -TypeDefinition ([IO.File]::ReadAllText($Harness)+[Environment]::NewLine+[IO.File]::ReadAllText($Source)) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
[Console]::Write([MuOfflineSnapshotFixture]::RunProcess($Directory,$Mode,$Boundary))
