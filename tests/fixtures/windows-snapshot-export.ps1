param([string]$Directory,[string]$Source,[string]$Harness,[ValidateSet('run','hold','reopen')][string]$Mode='run')
$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions
Add-Type -TypeDefinition ([IO.File]::ReadAllText($Harness)+[Environment]::NewLine+[IO.File]::ReadAllText($Source)) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
if($Mode -eq 'hold'){[MuSnapshotExportFixture]::Hold($Directory)}elseif($Mode -eq 'reopen'){[Console]::Write([MuSnapshotExportFixture]::Reopen($Directory))}else{[Console]::Write([MuSnapshotExportFixture]::Run($Directory))}
