[CmdletBinding()]
param([Parameter(Mandatory)][string]$Destination,[Parameter(Mandatory)][string]$ChannelFile,[Parameter(Mandatory)][string]$SourceDigest,[string]$ScriptDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $Destination){throw 'Broker already exists'}
if($ChannelFile -notmatch '^hv-channel-[0-9a-f]{16}\.exe$'){throw 'Expected a fixed channel helper filename'}
if($SourceDigest -notmatch '^[a-f0-9]{64}$'){throw 'Expected a broker source digest'}
$source=[IO.File]::ReadAllText((Join-Path $ScriptDirectory '../../native/windows/HyperVBroker.cs'))
$source+=[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $ScriptDirectory '../../native/windows/SealedBases.cs'))
$source+=[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $ScriptDirectory '../../native/windows/HostComponents.cs'))
$source+=[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $ScriptDirectory '../../native/windows/ProtectedLedger.cs'))
$source+=[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $ScriptDirectory '../../native/windows/ImageCache.cs'))
$script=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText((Join-Path $ScriptDirectory 'hyperv.ps1'))))
$hostScript=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText((Join-Path $ScriptDirectory 'host-components.ps1'))))
$source=$source.Replace('__HYPERV_SCRIPT_BASE64__',$script).Replace('__HOST_COMPONENTS_SCRIPT_BASE64__',$hostScript).Replace('__CHANNEL_FILE__',$ChannelFile).Replace('__BROKER_SOURCE_DIGEST__',$SourceDigest)
Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -OutputAssembly $Destination -OutputType ConsoleApplication
