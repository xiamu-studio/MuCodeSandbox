param([string]$Broker,[string]$FixtureRoot)
$ErrorActionPreference='Stop'
$helper=Join-Path $FixtureRoot 'hv-channel-1111111111111111.exe'
Add-Type -TypeDefinition 'using System;using System.Threading;public static class FixtureChannel {public static void Main(){Console.Read();Thread.Sleep(1200);Console.WriteLine("{\"port\":12345}");Console.Out.Flush();Thread.Sleep(10000);}}' -OutputAssembly $helper -OutputType ConsoleApplication
$source=@'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
public static class ChannelCloseRaceFixture {
 public static void Main(string[] args){
  string path=args[0];
  var a=Assembly.LoadFile(path);var t=a.GetType("MuHyperVBroker");var f=BindingFlags.Static|BindingFlags.NonPublic;
  var gate=t.GetField("Gate",f).GetValue(null);var records=(IDictionary)t.GetField("Records",f).GetValue(null);
  var launches=(IDictionary)t.GetField("ChannelLaunches",f).GetValue(null);var channels=(IDictionary)t.GetField("Channels",f).GetValue(null);
  string id="11111111-1111-4111-8111-111111111111";
  t.GetField("OwnerSid",f).SetValue(null,"synthetic");t.GetField("Owner",f).SetValue(null,Process.GetCurrentProcess());
  records.Add(id,new Dictionary<string,object>{{"ownerSid","synthetic"},{"platformId","22222222-2222-4222-8222-222222222222"}});
  var power=Activator.CreateInstance(a.GetType("MuPowerWatch"),new object[]{new Action(()=>{}),null});t.GetField("PowerGuard",f).SetValue(null,power);
  var method=t.GetMethod("Channel",f);var close=t.GetMethod("CloseChannel",f);
  try{
   var pending=Task.Run(()=>{try{method.Invoke(null,new object[]{id});return "published";}catch(TargetInvocationException e){return e.InnerException.GetType().Name+":"+e.InnerException.Message;}});
   var timer=Stopwatch.StartNew();bool begun=false;while(timer.ElapsedMilliseconds<3000){lock(gate){begun=launches.Contains(id);}if(begun)begun=Process.GetProcessesByName("hv-channel-1111111111111111").Length>0;if(begun||pending.IsCompleted)break;Thread.Sleep(10);}
   if(!begun)throw new Exception("Channel launch did not begin: "+(pending.IsCompleted?pending.Result:"pending"));close.Invoke(null,new object[]{id});
   if(!pending.Wait(6000)||!pending.Result.StartsWith("OperationCanceledException:"))throw new Exception("Retired startup was published or did not finish: "+(pending.IsCompleted?pending.Result:"pending"));
   lock(gate){if(channels.Contains(id)||launches.Contains(id))throw new Exception("Retired channel survived");}
  }finally{((IDisposable)power).Dispose();}
 }
}
'@
$fixture=Join-Path $FixtureRoot 'channel-close-fixture.exe'
Add-Type -TypeDefinition $source -OutputAssembly $fixture -OutputType ConsoleApplication
& $fixture $Broker
if($LASTEXITCODE -ne 0){throw 'Channel close fixture failed'}
Write-Output 'Retired channel startup was not published'
