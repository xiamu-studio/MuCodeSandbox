param([string]$Broker,[string]$FixtureRoot)
$ErrorActionPreference='Stop'
$type=[Reflection.Assembly]::LoadFrom($Broker).GetType('MuHyperVBroker')
$flags=[Reflection.BindingFlags]'Static,NonPublic'
$type.GetField('UserRoot',$flags).SetValue($null,$FixtureRoot)
$read=$type.GetMethod('ChannelDiagnostics',$flags)
$path=Join-Path $FixtureRoot 'channel-diagnostics.log'
$empty=$read.Invoke($null,@())
if($empty.events.Count -ne 0 -or $empty.full){throw 'Missing file did not yield empty diagnostics'}
$rows=1..40 | ForEach-Object {'2026-10-30T01:02:03.0000000Z MU_CHANNEL:guest-connect-timeout'}
$rows+=@('2026-10-30T01:02:03.0000000Z MU_CHANNEL:private-data','invalid MU_CHANNEL:capacity')
[IO.File]::WriteAllLines($path,[string[]]$rows)
$result=$read.Invoke($null,@())
if($result.events.Count -ne 32 -or $result.full){throw 'Unexpected bounded result'}
foreach($event in $result.events){if($event.code -ne 'guest-connect-timeout' -or $event.at -ne '2026-10-30T01:02:03.0000000Z'){throw 'Unexpected event'}}
[IO.File]::WriteAllText($path,('x'*65536))
$full=$read.Invoke($null,@())
if(!$full.full -or $full.events.Count -ne 0){throw 'Full log not reported correctly'}
Write-Output 'Channel diagnostics whitelist and bounds verified'
