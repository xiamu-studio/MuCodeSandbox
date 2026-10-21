[CmdletBinding()]
param([Parameter(Mandatory)][string]$Destination,[string]$ScriptDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $Destination){throw 'Channel helper already exists'}
$source=Join-Path $ScriptDirectory '../../native/windows/HyperVChannel.cs'
Add-Type -Path $source -OutputAssembly $Destination -OutputType ConsoleApplication
