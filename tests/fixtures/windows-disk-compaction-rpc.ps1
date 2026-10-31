param([string]$Directory,[string]$Native,[string]$TransactionFixture,[int]$OwnerPid,[string]$Nonce)
$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions
function Part([string]$Text,[string]$Start,[string]$End){$a=$Text.IndexOf($Start,[StringComparison]::Ordinal);$b=$Text.IndexOf($End,$a+$Start.Length,[StringComparison]::Ordinal);if($a -lt 0 -or $b -le $a){throw ('Source boundary missing: '+$Start)};return $Text.Substring($a,$b-$a)}
$broker=[IO.File]::ReadAllText((Join-Path $Native 'HyperVBroker.cs'));$disk=[IO.File]::ReadAllText((Join-Path $Native 'DiskGrowth.cs'));$resources=[IO.File]::ReadAllText((Join-Path $Native 'Resources.cs'));$fixture=[IO.File]::ReadAllText($TransactionFixture)
$prefix=Part $fixture ('$prefix=@'+"'`n") ("`n'@`nAdd-Type")
$prefix=$prefix.Substring($prefix.IndexOf("`n")+1).Replace('using System;','using System;using System.IO.Pipes;using System.Diagnostics;using System.Security.Principal;using System.Runtime.InteropServices;')
$prefix=$prefix.Replace('public static class MuDiskGrowthPolicy {public static string FileIdentity(string path){return "aaaaaaaaaaaaaaaaaaaaaaaa";}}','').Replace('reservationPath,UserRoot;','reservationPath;')
$prefix=$prefix.Replace('public class MuStorageException:Exception {public MuStorageException(string code,string text):base(code){}}','public class MuStorageException:Exception {public string Code;public MuStorageException(string code,string text):base(text){Code=code;}}')
$hold='calls++;if(mode=="hold"){File.WriteAllText(Path.Combine(UserRoot,"compact-entered"),"fixture");while(!token.IsCancellationRequested)Thread.Sleep(5);token.ThrowIfCancellationRequested();}if(mode=="invoke-fail"||mode=="async-missing")'
if(-not $prefix.Contains('calls++;if(mode=="invoke-fail"||mode=="async-missing")')){throw 'Provider fixture boundary missing'}
$prefix=$prefix.Replace('calls++;if(mode=="invoke-fail"||mode=="async-missing")',$hold)
$prefix=$prefix.Replace('static Dictionary<string,object> Owned(string id){return record;}','static Dictionary<string,object> Owned(string id){if(id!=FixtureId)throw new UnauthorizedAccessException("Foreign fixture");return record;}')
$prefix=$prefix.Replace('static string Id(Dictionary<string,object> request){return Convert.ToString(request["id"]);}','static string Id(Dictionary<string,object> request){return Convert.ToString(request["id"]);}')
$policy=$disk.Substring(0,$disk.IndexOf('public static partial class MuHyperVBroker',[StringComparison]::Ordinal))
$compaction=Part $disk '    private static void CompactionPending(' '    private static Dictionary<string,object> GrowthJournal('
$transaction=Part $disk '    private static void EnsureCompactionIdle(' '    private static object DiskGrowthAction('
$lifecycle=Part $broker '    private static byte[] ReadRequest(Stream pipe)' '    private static void Shutdown()'
$bounds=Part $broker '    private static void RequestBounds(' '    private static bool OwnerExited'
$closing=Part $broker '    private static bool QuiesceWriteAction(' '    private static void BeginQuiescing('
$mutation=Part $resources '    private static bool ResourceMutation(' '    private static FileStream ImportReservation()'
# The transaction fixture already defines a no-op QuiesceAdmission; use the
# real implementation for this separate IPC test instead.
$prefix=$prefix.Replace('static void QuiesceAdmission(string action){}','')
$extra=@'
 static readonly Dictionary<string,Dictionary<string,object>> Records=new Dictionary<string,Dictionary<string,object>>();
 static readonly List<NamedPipeServerStream> Pipes=new List<NamedPipeServerStream>();static readonly ManualResetEvent RequestsIdle=new ManualResetEvent(true);
 static readonly CancellationTokenSource Closing=new CancellationTokenSource(),PowerCancellation=new CancellationTokenSource(),ResourceCancellation=new CancellationTokenSource(),QuiesceCancellation=new CancellationTokenSource();
 static Process Owner;static string OwnerSid,UserRoot,FixtureId="12345678-1234-4234-8234-123456789abc";static int ActiveRequests,ResourceMutations,QuiesceWriters;
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetNamedPipeClientProcessId(IntPtr pipe,out uint pid);
 static bool OwnerExited{get{return Owner==null||Owner.HasExited;}}
 static object Dispatch(NamedPipeServerStream pipe,Dictionary<string,object> request,CancellationToken token){
  string action=Text(request,"action",32);QuiesceAdmission(action);if(action=="shutdown"){ValidateKeys(request,"action");return "";}if(action=="fixture-hold"){mode="hold";return new{held=true};}if(action=="fixture-async-pending"){mode="async-pending";return new{ready=true};}if(action=="fixture-async-ready"){mode="async-ready";return new{ready=true};}
  string id=Id(request);lock(VmGate(id)){CompactionPending(id,action);if(action=="stop"){if(id!=FixtureId)throw new UnauthorizedAccessException("Foreign fixture");CompactionChannels.Remove(id);running=false;return new{state="Off"};}if(action=="start")throw new InvalidOperationException("Ordinary start must remain fenced");return DiskCompactionAction(action,request,token);}
 }
 static void Shutdown(){lock(Gate)Stopping=true;Closing.Cancel();NamedPipeServerStream[] pipes;lock(Gate)pipes=Pipes.ToArray();foreach(var pipe in pipes)try{pipe.Dispose();}catch{}}
 public static void Run(string directory,int ownerPid,string nonce){
  UserRoot=Path.GetFullPath(directory);Owner=Process.GetProcessById(ownerPid);OwnerSid=WindowsIdentity.GetCurrent().User.Value;reservationPath=Path.Combine(UserRoot,"reservation.lock");File.WriteAllText(reservationPath,"");
  record=new Dictionary<string,object>{{"id",FixtureId},{"stage","ready"},{"platformId","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}};Records.Add(FixtureId,record);mode="";Console.WriteLine("READY");Console.Out.Flush();
  try{while(!Stopping){NamedPipeServerStream pipe=null;try{pipe=new NamedPipeServerStream("MuCodeSandbox-Broker-"+nonce,PipeDirection.InOut,16,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,65536,65536);lock(Gate)Pipes.Add(pipe);pipe.WaitForConnection();var accepted=pipe;ThreadPool.QueueUserWorkItem(_=>Serve(accepted));}catch{if(pipe!=null){pipe.Dispose();lock(Gate)Pipes.Remove(pipe);}if(!Stopping)throw;}}}finally{Shutdown();}
 }
'@
$classStart=$prefix.IndexOf('public class MuStorageException',[StringComparison]::Ordinal);if($classStart -lt 0){throw 'Fixture class boundary missing'}
$source=$prefix.Substring(0,$classStart)+[Environment]::NewLine+$policy+[Environment]::NewLine+$prefix.Substring($classStart)+[Environment]::NewLine+$extra+[Environment]::NewLine+$compaction+$transaction+$mutation+$bounds+$closing+$lifecycle+[Environment]::NewLine+'}'
Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
[MuHyperVBroker]::Run($Directory,$OwnerPid,$Nonce)
