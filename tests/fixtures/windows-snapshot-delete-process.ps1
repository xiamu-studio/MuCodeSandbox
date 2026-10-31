param([string]$Directory,[string]$Source,[string]$Harness,[ValidateSet('prepare','recover')][string]$Mode,[ValidateSet('delete-intent-published','delete-removed-disk','delete-completed')][string]$Boundary)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Web.Extensions
Add-Type -TypeDefinition ([IO.File]::ReadAllText($Harness)+[Environment]::NewLine+[IO.File]::ReadAllText($Source)) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
[Console]::Write([MuSnapshotDeleteFixture]::RunProcess($Directory,$Mode,$Boundary))
