// Production Serve, ProcessSid, bounds and resource classification are appended
// verbatim by the fixture compiler, including complete production Dispatch.
// Main, VM facts and successful protected-file ACL authority remain adapters.
public static partial class MuHyperVBroker {
 static Process Owner;static IntPtr OwnerHandle;static WindowsIdentity OwnerIdentity;static readonly List<IDisposable> Held=new List<IDisposable>();
 static readonly CancellationTokenSource Closing=new CancellationTokenSource(),ResourceCancellation=new CancellationTokenSource(),PowerCancellation=new CancellationTokenSource();
 static readonly CancellationTokenSource QuiesceCancellation=new CancellationTokenSource();static int QuiesceWriters;
 static bool QuiesceWriteAction(string action){return false;} // Recovery RPC fixture does not request the new closing mode.
 static readonly ManualResetEvent RequestsIdle=new ManualResetEvent(true);static readonly HashSet<NamedPipeServerStream> Pipes=new HashSet<NamedPipeServerStream>();static int ActiveRequests,ResourceMutations;static bool Stopping;
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetNamedPipeClientProcessId(IntPtr pipe,out uint pid);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool GetTokenInformation(IntPtr token,int kind,out int information,int length,out int returned);
 [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 static void Shutdown(){Stopping=true;Closing.Cancel();}
 sealed class Segmented:MemoryStream {int segment;public Segmented(byte[] value,int size):base(value){segment=size;}public override int Read(byte[] b,int o,int count){return base.Read(b,o,Math.Min(count,segment));}}
 static int CheckRequestReader(){
  byte[] unicode=Encoding.UTF8.GetBytes("{\"text\":\"中文输入😀\"}\r");foreach(int segment in new[]{1,3,4096})using(var stream=new Segmented(unicode.Concat(new byte[]{10}).ToArray(),segment))Require(ReadRequest(stream).SequenceEqual(unicode),"Fragmented UTF-8 request changed");
  byte[] maximum=Enumerable.Repeat((byte)'x',1048576).Concat(new byte[]{10}).ToArray();using(var stream=new MemoryStream(maximum))Require(ReadRequest(stream).Length==1048576,"Exact transport byte limit changed");
  foreach(byte[] invalid in new[]{new byte[]{123},Encoding.UTF8.GetBytes("{}\n{}\n"),Enumerable.Repeat((byte)'x',1048577).Concat(new byte[]{10}).ToArray()})using(var stream=new MemoryStream(invalid)){bool refused=false;try{ReadRequest(stream);}catch(ArgumentException){refused=true;}Require(refused,"Malformed or over-limit transport request accepted");}return 7;
 }
 public static void RunRecoveryRpc(string root,int ownerPid,string nonce,string scenario,string sourceDigest,string dispatchHash){
  if(nonce.Length!=64||nonce.Any(c=>!"0123456789abcdef".Contains(c)))throw new ArgumentException("Fixture nonce rejected");Stopping=false;Owner=Process.GetProcessById(ownerPid);OwnerSid=ProcessSid(Owner);
  Require(OwnerSid==WindowsIdentity.GetCurrent().User.Value,"RPC owner must be this fixture's ordinary user");Require(sourceDigest.Length==64&&sourceDigest.All(c=>"0123456789abcdef".Contains(c)),"Fixture broker digest required");SourceDigest=sourceDigest;UnreachableDispatchCalls=0;
  try{
   int readerChecks=CheckRequestReader();RunOriginRecoveryFixture(root,"wrong-confirmation");Require(Records.Count==0&&!RecoveryPublicationAttempted,"RPC fixture unexpectedly registered resources");Reviews=0;
   if(scenario=="corrupt-ledgers"){System.IO.File.WriteAllText(Path.Combine(root,"vms.json"),"{broken-primary");System.IO.File.WriteAllText(Path.Combine(root,"vms.backup.json"),"{broken-backup");LedgerStore=new MuProtectedLedger(root,OwnerSid,ValidateLedgerFile);Require(LedgerStore.InspectRecovery().Count==0,"Corrupt RPC setup unexpectedly registered resources");RecoveryLedgerFingerprint=LedgerStore.RecoveryFingerprint();}else if(scenario!="missing-ledgers")throw new ArgumentException("Unknown RPC fixture scenario");
   var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(OwnerSid),PipeAccessRights.ReadWrite|PipeAccessRights.CreateNewInstance,AccessControlType.Allow));foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid),PipeAccessRights.FullControl,AccessControlType.Allow));
   int requests=0;var durations=new List<long>();NamedPipeServerStream listener=null;IAsyncResult waiting=null;
   try{
    listener=RpcListener(nonce,security);waiting=listener.BeginWaitForConnection(null,null);Console.WriteLine("ORIGIN_RPC_READY");Console.Out.Flush();
    while(Records.Count==0){
     if(++requests>64||OwnerExited)throw new IOException("RPC fixture did not finish its bounded recovery");if(!waiting.AsyncWaitHandle.WaitOne(30000))throw new TimeoutException("Recovery RPC connection wait expired");listener.EndWaitForConnection(waiting);
     var pipe=listener;listener=null;
     try{
      // Keep a waiting instance before Serve can return a reply. Production
      // Main also keeps accepting independently of its Serve worker threads.
      listener=RpcListener(nonce,security);waiting=listener.BeginWaitForConnection(null,null);
      lock(Gate)Pipes.Add(pipe);var elapsed=Stopwatch.StartNew();Serve(pipe);durations.Add(elapsed.ElapsedMilliseconds);Console.WriteLine("ORIGIN_RPC_REQUEST:"+requests+":"+elapsed.ElapsedMilliseconds);Console.Out.Flush();
     }finally{pipe.Dispose();}
    }
   }finally{if(listener!=null)listener.Dispose();}
   var reopened=new MuProtectedLedger(UserRoot,OwnerSid,ValidateLedgerFile).Load();Require(reopened.Count==1&&OriginTracked(reopened.Values.Single()),"RPC restored registration did not reopen");Require(UnreachableDispatchCalls==0,"Recovery dispatch entered a non-recovery backend");Require(ActiveRequests==0&&ResourceMutations==0&&Pipes.Count==0&&RequestsIdle.WaitOne(0),"Production request lifecycle did not settle");
   string id=reopened.Keys.Single(),directory=Path.Combine(UserRoot,"vms",id);using(var store=OpenOriginStore()){store.ReadAcceptedSnapshot(id,Convert.ToString(reopened[id]["platformId"]));}
   int retained=System.IO.Directory.EnumerateFiles(UserRoot,"vms.before-recovery-*.json").Count();Require(retained==(scenario=="corrupt-ledgers"?2:0),"RPC recovery did not retain exact corrupt copies");
   Console.WriteLine(Json().Serialize(new{complete=true,diagnostic="native-origin-rpc",scenario=scenario,actualNamedPipe=true,productionServe=true,productionProcessSid=true,productionBounds=true,productionBufferedReader=true,readerChecks=readerChecks,fixtureListenerKeptReady=true,fixtureServerCreateInstanceRight=true,productionPipeAcl=false,productionDispatch=true,dispatchSourceSha256=dispatchHash,unreachableDispatchCalls=UnreachableDispatchCalls,productionMain=false,ordinaryOwnerVerified=true,ownerPid=ownerPid,requests=requests,requestDurationsMs=durations,readOnlyVmReviews=Reviews,vmMutations=0,registered=true,ledgerReopened=true,originAccepted=true,baseImageAbsent=!System.IO.File.Exists(Convert.ToString(reopened[id]["image"])),diskSha256=Hash(Path.Combine(directory,"disk.vhdx")),seedSha256=Hash(Path.Combine(directory,"seed.iso")),retainedCorruptCopies=retained,trustedAclPublication=false,realHyperV=false}));Console.Out.Flush();
  }catch(Exception error){Console.Error.WriteLine("ORIGIN_RPC_SERVER_FAILURE:"+error.ToString());Console.Error.Flush();throw;}
  finally{for(int i=Held.Count-1;i>=0;i--)Held[i].Dispose();if(OwnerIdentity!=null)OwnerIdentity.Dispose();Owner.Dispose();}
 }
 static NamedPipeServerStream RpcListener(string nonce,PipeSecurity security){return new NamedPipeServerStream("MuCodeSandbox-Broker-"+nonce,PipeDirection.InOut,16,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,65536,65536,security);}
}
