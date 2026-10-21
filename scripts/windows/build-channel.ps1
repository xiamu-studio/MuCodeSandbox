[CmdletBinding()]
param([Parameter(Mandatory)][string]$Destination,[string]$ScriptDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $Destination){throw 'Channel helper already exists'}
$source=[IO.File]::ReadAllText((Join-Path $ScriptDirectory '../../native/windows/HyperVChannel.cs'))+[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $ScriptDirectory '../../native/windows/PowerWatch.cs'))
Add-Type -TypeDefinition $source -OutputAssembly $Destination -OutputType ConsoleApplication
