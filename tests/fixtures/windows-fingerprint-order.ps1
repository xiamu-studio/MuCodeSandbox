param([Parameter(Mandatory)][string]$Source,[Parameter(Mandatory)][ValidateSet('forward','reverse','changed','error')][string]$Mode)
$ErrorActionPreference='Stop'
function Get-NetAdapter { @() }
function Get-DnsClientServerAddress { @() }
function Get-NetRoute {
 param([string[]]$AddressFamily)
 $items=@(
  [pscustomobject]@{InterfaceAlias='synthetic';DestinationPrefix='0.0.0.0/0';InterfaceIndex=42;NextHop='192.0.2.1';RouteMetric=10},
  [pscustomobject]@{InterfaceAlias='synthetic';DestinationPrefix='0.0.0.0/0';InterfaceIndex=42;NextHop='192.0.2.1';RouteMetric=$(if($Mode -eq 'changed'){21}else{20})}
 )
 if($Mode -eq 'reverse'){[array]::Reverse($items)}
 $items
}
# The production queries use isolated runspaces. Substitute fixed read-only
# fixture expressions into their script blocks instead of parent-scope functions.
$routesJson = @(Get-NetRoute) | ConvertTo-Json -Compress
$script = [IO.File]::ReadAllText($Source)
$script = $script.Replace('Get-NetAdapter', '(& { @() })')
$script = $script.Replace('Get-NetRoute -AddressFamily IPv4,IPv6', "(ConvertFrom-Json '"+$routesJson.Replace("'","''")+"')")
$dnsExpression = if($Mode -eq 'error'){ "(& { throw 'Synthetic DNS query failed' })" }else{ '(& { @() })' }
$script = $script.Replace('Get-DnsClientServerAddress', $dnsExpression)
& ([ScriptBlock]::Create($script)) -Action fingerprint
