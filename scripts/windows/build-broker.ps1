[CmdletBinding()]
param([Parameter(Mandatory)][string]$Destination,[Parameter(Mandatory)][string]$ChannelFile,[Parameter(Mandatory)][string]$SourceDigest)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $Destination){throw 'Broker already exists'}
if($ChannelFile -notmatch '^hv-channel-[0-9a-f]{16}\.exe$'){throw 'Expected a fixed channel helper filename'}
if($SourceDigest -notmatch '^[a-f0-9]{64}$'){throw 'Expected a broker source digest'}
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../native/windows/HyperVBroker.cs'))
$script=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'hyperv.ps1'))))
$source=$source.Replace('__HYPERV_SCRIPT_BASE64__',$script).Replace('__CHANNEL_FILE__',$ChannelFile).Replace('__BROKER_SOURCE_DIGEST__',$SourceDigest)
Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -OutputAssembly $Destination -OutputType ConsoleApplication
