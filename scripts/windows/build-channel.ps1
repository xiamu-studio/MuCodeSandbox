[CmdletBinding()]
param([Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $Destination){throw 'Channel helper already exists'}
$source=Join-Path $PSScriptRoot '../../native/windows/HyperVChannel.cs'
Add-Type -Path $source -OutputAssembly $Destination -OutputType ConsoleApplication
