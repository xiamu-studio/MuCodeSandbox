param([string]$Source)
$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions
$text=[IO.File]::ReadAllText($Source);$start=$text.IndexOf('    private static object Allocation(',[StringComparison]::Ordinal);$end=$text.IndexOf('    private static void ChannelDiagnostic(', $start,[StringComparison]::Ordinal)
if($start -lt 0 -or $end -le $start){throw 'Production allocation boundary missing'}
$header=@'
using System;using System.Collections.Generic;using System.Web.Script.Serialization;
public static class FixtureAllocation {
 static object Gate=new object();static Dictionary<string,Dictionary<string,object>> Records=new Dictionary<string,Dictionary<string,object>>();
 static bool SnapshotIsPending(Dictionary<string,object> r){return false;}static bool EverReady(Dictionary<string,object> r){return true;}
 public static string Probe(bool pending){var r=new Dictionary<string,object>{{"stage","ready"},{"platformId","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},{"imageSha256",new string('a',64)},{"cpus",2},{"memoryGiB",4},{"diskGiB",32}};if(pending)r["diskCompaction"]=new object();Records["id"]=r;return new JavaScriptSerializer().Serialize(Allocation("id"));}
'@
Add-Type -TypeDefinition ($header+[Environment]::NewLine+$text.Substring($start,$end-$start)+[Environment]::NewLine+'}') -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
$pending=[FixtureAllocation]::Probe($true)|ConvertFrom-Json;$normal=[FixtureAllocation]::Probe($false)|ConvertFrom-Json
if(-not $pending.registered -or -not $pending.diskCompactionPending -or $normal.PSObject.Properties.Name -contains 'diskCompactionPending'){throw 'Pending maintenance allocation receipt changed'}
