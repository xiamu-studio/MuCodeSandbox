// Ordinary file/provider fixtures share the runtime emergency adapters. All
// shutdown, request framing, PID/SID and allocation methods are production.
public static partial class MuHyperVBroker {
 static readonly List<NamedPipeServerStream> Pipes=new List<NamedPipeServerStream>();static readonly ManualResetEvent RequestsIdle=new ManualResetEvent(true),ShutdownComplete=new ManualResetEvent(false);static int ActiveRequests;
 static IntPtr OwnerHandle;static WindowsIdentity OwnerIdentity;
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetNamedPipeClientProcessId(IntPtr pipe,out uint pid);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool GetTokenInformation(IntPtr token,int kind,out int value,int length,out int returned);
 [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
 sealed class HandleOwner:IDisposable {IntPtr handle;public HandleOwner(IntPtr h){handle=h;}public void Dispose(){if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}}
 static bool WriterCancelled=false;static int LateStarts=0;
 static Dictionary<string,object> Object(object value){return Json().Deserialize<Dictionary<string,object>>(Json().Serialize(value));}
 static Dictionary<string,object> CloseRequest(string session=null){var request=new Dictionary<string,object>{{"action","shutdown-status"}};if(session!=null)request["session"]=session;return request;}
 static bool Confirmed(){return (bool)Object(ShutdownStatus(CloseRequest(ShutdownSession)))["stopsConfirmed"];}
 static void Initialize(string directory){UserRoot=Path.GetFullPath(directory);RegistryLoaded=true;ResourceMutations=0;SetupOnly=false;RecoveryOnly=false;Stopping=false;}
 static void NativeNormal(){
  Register(1,"Off");Register(2,"Running");object vmGate=VmGate(Key(1));Monitor.Enter(vmGate);
  try{var first=Object(ShutdownStatus(CloseRequest()));Require((bool)first["fenced"]&&Convert.ToInt32(first["allocationCount"])==2&&!(bool)first["stopsConfirmed"],"Scope was narrowed to an ordinary workspace record");Until(()=>State(2,"Off"),"Graceful fence waited behind an unrelated off-line gate");Require(!Confirmed(),"Busy allocation was guessed stopped");
   foreach(string action in new[]{"create","start","prepare","disk","grow-disk","backup-import","snapshot-create","snapshot-prepare","channel","prepare-host","cache-prune","recovery-adopt"}){bool denied=false;try{QuiesceAdmission(action);}catch(MuStorageException e){denied=e.Code=="BROKER_QUIESCING";}Require(denied,"Closing admission left an unsafe action open: "+action);}
   foreach(string action in new[]{"shutdown-status","shutdown","stop","status","inspect","allocation","close-channel","backup-close"})QuiesceAdmission(action);
   var invalid=CloseRequest(new string('b',32));Require(Reject(()=>ShutdownStatus(invalid)),"Different close session accepted");invalid=CloseRequest();invalid["ids"]=new[]{Key(1)};Require(Reject(()=>ShutdownStatus(invalid)),"Caller could narrow protected close scope");
  }finally{Monitor.Exit(vmGate);}Until(Confirmed,"Released graceful scope did not confirm");Require(Count(1)==1&&Count(2)==1,"Graceful scope repeated confirmed VM work");Pass("graceful-whole-native-scope-keeps-stop-and-read-open-while-fencing-writes-and-channels");
 }
 static void NativeHard(){
  Register(1,"Running");Register(2,"Running");var before=Json().Serialize(Records);var entered=new ManualResetEvent(false);var release=new ManualResetEvent(false);Exception error=null;
  var copy=new Thread(()=>{try{lock(VmGate(Key(1))){using(var output=new FileStream(Path.Combine(UserRoot,"held-copy.bin"),FileMode.CreateNew,FileAccess.Write,FileShare.None)){output.Write(new byte[1024],0,1024);entered.Set();if(!release.WaitOne(10000))throw new TimeoutException("Held copy");output.Flush(true);}}}catch(Exception e){error=e;}});copy.Start();Require(entered.WaitOne(3000),"Copy gate not held");
  try{Stopping=true;BeginQuiescing();var timer=Stopwatch.StartNew();Require(DrainShutdown(()=>timer.ElapsedMilliseconds,ms=>Thread.Sleep(10),5000),"Independent owner-exit hardware pass failed");Require(copy.IsAlive&&State(1,"Off")&&State(2,"Off"),"Owner-exit pass waited for the off-line VM gate");Require(Json().Serialize(Records)==before,"Hardware fallback adopted or overwrote a protected record");Pass("owner-exit-stop-only-pass-does-not-wait-for-copy-gates-or-write-allocation-records");}
  finally{release.Set();Require(copy.Join(3000),"Copy leaked");if(error!=null)throw error;entered.Dispose();release.Dispose();}
 }
 static void NativeLate(){
  Register(1,"Running");Records[Key(1)].Remove("platformId");Records[Key(1)]["stage"]="creating";Records[Key(1)]["everReady"]=false;AbsentTargets.Add(Key(1));QuiesceWriters=1;Stopping=true;BeginQuiescing();
  Require(!ShutdownScopeConfirmed(),"Unfinished producer became confirmed");Until(()=>Count(1)>0,"Early partial-allocation review did not run");Until(()=>EmergencyStops.Sweep(EmergencyTargets()),"Early hardware review did not settle");Require(!ShutdownScopeConfirmed(),"Absence before an active creator drained became final proof");int before=Count(1);
  AbsentTargets.Remove(Key(1));QuiesceWriters=0;Until(Confirmed,"Late creation was not rechecked after producer drain");Require(Count(1)>before&&!Records[Key(1)].ContainsKey("platformId"),"Drain epoch reused an absent receipt or adopted a record");Pass("a-late-creator-with-unchanged-record-cannot-reuse-the-pre-drain-absence-receipt");
 }
 static void NativeReceipts(){
  Register(1,"Running");Stopping=true;BeginQuiescing();foreach(string kind in new[]{"name","platform","state","extra"}){
   ProviderReply=(action,reply)=>{if(kind=="name")reply["name"]="mu-win-foreign";if(kind=="platform")reply["platformId"]=Key(9000);if(kind=="state")reply["state"]="Running";if(kind=="extra")reply["path"]="unapproved";return reply;};bool rejected=false;try{TryShutdownHardwareStop(Key(1),EmergencyTargets()[Key(1)]);}catch(IOException){rejected=true;}catch(UnauthorizedAccessException){rejected=true;}catch(ArgumentException){rejected=true;}Require(rejected,"Bad stop receipt accepted: "+kind);
  }ProviderReply=null;Records[Key(1)].Remove("platformId");Records[Key(1)]["stage"]="creating";ProviderReply=(action,reply)=>{reply["present"]="false";return reply;};bool denied=false;try{TryShutdownHardwareStop(Key(1),EmergencyTargets()[Key(1)]);}catch(IOException){denied=true;}Require(denied,"Nonboolean absence accepted");Pass("hardware-fallback-rejects-wrong-name-platform-running-state-extra-fields-and-false-absence");
 }
 static void NativeModes(){
  RegistryLoaded=false;Require(!ShutdownScopeConfirmed(),"Unknown registry was treated as an empty VM scope");RegistryLoaded=true;SetupOnly=true;Register(1,"Running");Require(!Confirmed(),"Setup session claimed an unreviewed registered VM stopped");long now=0;Require(!DrainShutdown(()=>now,ms=>now+=ms,1000)&&Count(1)==0,"Setup mode attempted to stop a VM");Records.Clear();Require(Confirmed(),"Empty setup scope could not close");RecoveryOnly=true;SetupOnly=false;Register(2,"Running");Records[Key(2)]["ownerSid"]="untrusted-recovery-data";Require(Confirmed()&&Count(2)==0,"Read-only recovery session crossed into VM management");Pass("unknown-registry-and-setup-allocations-remain-unconfirmed-and-recovery-close-does-not-manage-vms");
 }
 static void NativeDeadline(){
  Register(1,"Running");SlowId=Key(1);ProviderRelease.Reset();Stopping=true;QuiesceWriters=1;BeginQuiescing();long now=0;
  try{Require(!DrainShutdown(()=>now,ms=>now+=ms,20),"Deadline turned unknown into success");Require(!ShutdownStopsConfirmed,"Deadline published a stop receipt");Require(ProviderEntered.WaitOne(3000),"Independent deadline worker did not start");Pass("owner-exit-deadline-retains-unconfirmed-producers-without-inventing-completion");}
  finally{ProviderRelease.Set();Until(()=>EmergencyStops.Sweep(EmergencyTargets()),"Deadline worker leaked");}
  SetupOnly=true;lock(Gate)Records.Clear();QuiesceWriters=0;int reads=0;
  Require(!DrainShutdown(()=>++reads<3?0:20,ms=>{},20),"A late confirmed scope bypassed the deadline");
  reads=0;Require(!DrainShutdown(()=>++reads<3?10:9,ms=>{},20),"A reversed confirmation clock was accepted");
 }
 public static string RunShutdownFixture(string directory,string scenario){Initialize(directory);try{switch(scenario){case "normal":NativeNormal();break;case "hard":NativeHard();break;case "late":NativeLate();break;case "receipts":NativeReceipts();break;case "modes":NativeModes();break;case "deadline":NativeDeadline();break;default:throw new ArgumentException("Unknown fixture");}return Json().Serialize(new{complete=true,scenario=scenario,checks=Checks,productionShutdownMethods=true,productionEmergencySet=true,realHyperV=false,protectedAcl=false,realSuspendResume=false});}finally{ProviderRelease.Set();Closing.Cancel();}}
 // The fixture dispatcher substitutes only the VM write/provider boundary.
 // Framing, request bounds, PID/SID, cancellation and close status are actual.
 static object Dispatch(NamedPipeServerStream pipe,Dictionary<string,object> request,CancellationToken cancellation){
  string action=Text(request,"action",32);if(action=="shutdown-status")return ShutdownStatus(request);QuiesceAdmission(action);
  if(action=="backup-import"){
   string id=Id(request);lock(VmGate(id)){QuiesceAdmission(action);File.WriteAllText(Path.Combine(UserRoot,"writer-entered"),"synthetic");while(!File.Exists(Path.Combine(UserRoot,"release-writer"))){if(cancellation.IsCancellationRequested){WriterCancelled=true;File.WriteAllText(Path.Combine(UserRoot,"writer-cancelled"),"synthetic");}Thread.Sleep(5);}return new{completed=true,cancelled=cancellation.IsCancellationRequested};}
  }
  if(action=="host-status"){lock(Gate)return new{quiescing=Quiescing,writerCancelled=WriterCancelled,activeWrites=QuiesceWriters,states=new Dictionary<string,string>(ProviderStates),lateStarts=LateStarts};}
  if(action=="start"){LateStarts++;throw new InvalidOperationException("Unexpected late start reached provider");}
  if(action=="shutdown"){ValidateKeys(request,"action");return "";}throw new ArgumentException("Synthetic dispatcher only supports close boundaries");
 }
 public static void RunShutdownRpc(string directory,int ownerPid,string nonce){
  Initialize(directory);Owner.Dispose();Owner=Process.GetProcessById(ownerPid);OwnerSid=ProcessSid(Owner);Register(1,"Off");Register(2,"Running");
  var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(OwnerSid),PipeAccessRights.FullControl,AccessControlType.Allow));
  Console.WriteLine(Json().Serialize(new{ready=true,ownerPid=ownerPid,scope="synthetic-ordinary-owner"}));Console.Out.Flush();
  try{while(!Stopping){NamedPipeServerStream pipe=null;try{pipe=new NamedPipeServerStream("MuCodeSandbox-Broker-"+nonce,PipeDirection.InOut,16,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,65536,65536,security);lock(Gate)Pipes.Add(pipe);pipe.WaitForConnection();var accepted=pipe;ThreadPool.QueueUserWorkItem(_=>Serve(accepted));}catch{if(pipe!=null){pipe.Dispose();lock(Gate)Pipes.Remove(pipe);}if(!Stopping)throw;}}
   Shutdown();Console.WriteLine(Json().Serialize(new{complete=true,stopsConfirmed=ShutdownStopsConfirmed,writerCancelled=WriterCancelled,lateStarts=LateStarts,actualNamedPipe=true,actualProcessSid=true,productionServe=true,productionShutdownStatus=true,productionDispatch=false,realHyperV=false,protectedAcl=false}));Console.Out.Flush();
  }finally{ProviderRelease.Set();Closing.Cancel();for(int n=Held.Count-1;n>=0;n--)Held[n].Dispose();if(OwnerIdentity!=null)OwnerIdentity.Dispose();Owner.Dispose();}
 }
}
