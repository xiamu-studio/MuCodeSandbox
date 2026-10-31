param([string]$Channel,[string]$FixtureRoot,[switch]$BaselineOnly)
$ErrorActionPreference='Stop'
$source=@'
using System;
using System.Reflection;
using System.Threading;
public static class ChannelAdmissionFixture {
 public static int Main(string[] args) {
  // This limit belongs only to this isolated fixture process. It models the
  // pool being occupied by long-lived connections, without touching a VM.
  if(!ThreadPool.SetMinThreads(1,1)||!ThreadPool.SetMaxThreads(2,2))throw new Exception("Fixture pool limit failed");
  using(var release=new ManualResetEvent(false))
  using(var blockers=new CountdownEvent(2))
  using(var finished=new CountdownEvent(2))
  using(var queued=new ManualResetEvent(false))
  using(var independent=new ManualResetEvent(false)) {
   for(int i=0;i<2;i++)ThreadPool.QueueUserWorkItem(_=>{blockers.Signal();release.WaitOne();finished.Signal();});
   try {
    if(!blockers.Wait(5000))throw new Exception("Fixture connections did not start");
    ThreadPool.QueueUserWorkItem(_=>queued.Set());
    if(queued.WaitOne(300))throw new Exception("Fixture pool was not occupied");
    Console.WriteLine("Previous pool admission waits behind occupied connections");
    if(args.Length<2) {
     var type=Assembly.LoadFile(args[0]).GetType("MuHyperVChannel");
     var method=type.GetMethod("StartConnection",BindingFlags.Static|BindingFlags.NonPublic);
     if(method==null)throw new Exception("Production connection scheduler is unavailable");
     method.Invoke(null,new object[]{new ThreadStart(()=>independent.Set())});
     if(!independent.WaitOne(2000))throw new Exception("New connection queued behind occupied pool");
     Console.WriteLine("Production channel admission proceeds with occupied pool");
    }
   } finally {
    release.Set();
    if(!finished.Wait(5000)||!queued.WaitOne(5000))throw new Exception("Fixture workers did not finish");
   }
  }
  return 0;
 }
}
'@
$fixture=Join-Path $FixtureRoot 'channel-admission-fixture.exe'
Add-Type -TypeDefinition $source -OutputAssembly $fixture -OutputType ConsoleApplication
if($BaselineOnly){& $fixture $Channel '--baseline'}else{& $fixture $Channel}
if($LASTEXITCODE -ne 0){throw 'Channel admission fixture failed'}
