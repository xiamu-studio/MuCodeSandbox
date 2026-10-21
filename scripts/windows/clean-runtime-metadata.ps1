[CmdletBinding()]
param([string]$ScriptDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
$inputValue=[Console]::In.ReadToEnd() | ConvertFrom-Json
if(@($inputValue.PSObject.Properties.Name | Where-Object {$_ -notin @('root','id','reset','checkOnly')}).Count -or $inputValue.reset -isnot [bool] -or ($null -ne $inputValue.checkOnly -and $inputValue.checkOnly -isnot [bool])){throw 'Unexpected metadata cleanup request'}
Add-Type -Path (Join-Path $ScriptDirectory '../../native/windows/RuntimeMetadataCleanup.cs')
[MuRuntimeMetadataCleanup]::Remove([string]$inputValue.root,[string]$inputValue.id,[bool]$inputValue.reset,[bool]$inputValue.checkOnly)
