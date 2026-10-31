// Native restore orchestration fixture: real file I/O; Hyper-V/ACL authority is
// represented by adapters and is NOT certified by this test.
using System;using System.Text;using System.IO;using System.Linq;using System.Collections.Generic;using System.Threading;using System.Security.Principal;using System.Security.Cryptography;using System.IO.Pipes;using System.Web.Script.Serialization;using System.Runtime.InteropServices;
public sealed class MuStorageException:IOException{public readonly string Code;public MuStorageException(string code,string text):base(text){Code=code;}}
// The orchestration adapter has no actual VM account or ACL authority.
public sealed class NTAccount{public NTAccount(string domain,string name){if(domain!="NT VIRTUAL MACHINE"||name!="87654321-4321-4321-8321-210987654321")throw new ArgumentException("Unexpected synthetic VM account");}public IdentityReference Translate(Type target){if(target!=typeof(SecurityIdentifier))throw new ArgumentException("Unexpected synthetic account target");return new SecurityIdentifier("S-1-1-0");}}
public static class MuResourceMetrics{public sealed class Facts{public long totalMemory=16L*1024*1024*1024;}public static Facts Read(string root){return new Facts();}public static long DiskFootprint(long size){return size+64L*1024*1024;}public static long AllocatedBytes(string path){return new FileInfo(path).Length;}}
public static class MuResourcePolicy{public const long GiB=1024L*1024*1024,GrowthReserveLimit=16L*GiB;public static void MemoryRequest(long a,long b,long c){}public static void Quota(long a,long b){}}
public static partial class MuHyperVBroker{
 static readonly object Gate=new object(),ImportGate=new object();static readonly Dictionary<string,Dictionary<string,object>> Records=new Dictionary<string,Dictionary<string,object>>();
 static string UserRoot,OwnerSid="S-1-5-21-1-2-3-1001",CanonicalBuilderDigest=new string('f',64);static int Created,Copied,Verified;static string ExpectedDirectory;static bool RejectFinalVerification;
 static Exception CopyFailure;static CancellationTokenSource CopyCancellation;static FileStream HeldPartial;static long LastPreflight,DiskCopyReserve,SpaceLimit=long.MaxValue;
 static string OriginFaultPhase;static bool RejectOriginVerification,FailFenceSave,FailGrowthSave,FaultOnAcceptance;static int OriginCommits;static CancellationTokenSource OriginCancellation;static MuRestoreOriginStore CurrentOrigins;static int VmCapacity=16;
 static HashSet<string> StartedHere=new HashSet<string>(),CompactionChannels=new HashSet<string>(),CompactionVerifyBoots=new HashSet<string>(),CompactionRunPermits=new HashSet<string>();
 static Dictionary<string,object> BackupReads=new Dictionary<string,object>(),SnapshotExports=new Dictionary<string,object>(),SnapshotLiveDeletes=new Dictionary<string,object>();static string ResourceIssue=null;static bool Quiescing=false,Stopping=false;
 static void QuiesceAdmission(string action){}static void CheckPower(){}static void SnapshotLiveAdmission(string id,string action,Dictionary<string,object> request){}static void CheckBackupBusy(string id,string action){}static void SnapshotPending(string id,string action){}static bool EverReady(Dictionary<string,object> record){return true;}
 static void StartWithResources(Dictionary<string,object> record,CancellationToken cancellation,Action start){start();}
 static object VmGate(string id){return Gate;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
 sealed class HandleOwner:IDisposable{IntPtr handle;public HandleOwner(IntPtr value){handle=value;}public void Dispose(){if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}}
 static Dictionary<string,object> Owned(string id){return Records[id];}
 static MuRestoreOriginStore OpenOriginStore(bool create=false){if(create)Directory.CreateDirectory(Path.Combine(UserRoot,"restore-origins"));CurrentOrigins=new MuRestoreOriginStore(UserRoot,OwnerSid,(handle,directory)=>{},phase=>{if(Created==1&&Copied==2){if(phase=="frame-committed")OriginCommits++;int frame=phase=="frame-committed"?OriginCommits:OriginCommits+1;if(phase==OriginFaultPhase&&(!FaultOnAcceptance||frame==2)){if(OriginCancellation!=null)OriginCancellation.Cancel();else throw new IOException("Synthetic origin publication interruption");}}},!create);return CurrentOrigins;}
 static MuRestoreOriginStore OpenPreparedOriginStore(Dictionary<string,object> plan,Action<Dictionary<string,object>> bind,Action complete){CurrentOrigins=new MuRestoreOriginStore(UserRoot,OwnerSid,(handle,directory)=>{},phase=>{ObserveInitialization(phase);if(Created==1&&Copied==2){if(phase=="frame-committed")OriginCommits++;int frame=phase=="frame-committed"?OriginCommits:OriginCommits+1;if(phase==OriginFaultPhase&&(!FaultOnAcceptance||frame==2)){if(OriginCancellation!=null)OriginCancellation.Cancel();else throw new IOException("Synthetic origin publication interruption");}}},false,plan,bind,complete);return CurrentOrigins;}
 static IDisposable PinOriginAllocation(Dictionary<string,object> record){return new MemoryStream();}
 static bool HostServicingBusy(){return false;}static IDisposable ImportReservation(){return new MemoryStream();}static void CheckDiskRequest(long bytes,CancellationToken token){LastPreflight=bytes;if(bytes>SpaceLimit)throw new MuStorageException("RESOURCE_DISK","Synthetic constrained volume");}static void Save(){if(FailFenceSave&&Records.Values.Any(record=>!record.ContainsKey("backupRestore")))throw new IOException("Synthetic final registry save failure");if(FailGrowthSave&&Records.Values.Any(record=>!record.ContainsKey("diskGrowth")))throw new IOException("Synthetic growth completion save failure");InitializationSave();}static void CloseChannel(string id){}
 static JavaScriptSerializer Json(){return new JavaScriptSerializer();}
 static void ValidateKeys(Dictionary<string,object> r,params string[] keys){if(r.Keys.Except(keys).Any())throw new ArgumentException("Unknown request field");}
 static string Text(Dictionary<string,object> r,string key,int max){string value=Convert.ToString(r[key]);if(value.Length<1||value.Length>max)throw new ArgumentException("Invalid text");return value;}
 static string Id(Dictionary<string,object> r){string value=Text(r,"id",36);if(Guid.Parse(value).ToString("D")!=value)throw new ArgumentException("Invalid id");return value;}
 static string Digest(Dictionary<string,object> r,string key){string value=Text(r,key,64);if(value.Length!=64||value.Any(c=>!"0123456789abcdef".Contains(c)))throw new ArgumentException("Invalid digest");return value;}
 static int Number(Dictionary<string,object> r,string key,int min,int max){int value=Convert.ToInt32(r[key]);if(value<min||value>max)throw new ArgumentException("Invalid number");return value;}
 static bool HasStorage(string p){return File.Exists(p)||Directory.Exists(p);}
 static void PrivateDirectory(string p,bool pin){if(Path.GetFullPath(p)!=ExpectedDirectory&&Path.GetFullPath(p)!=Path.Combine(UserRoot,"restore-origins"))throw new UnauthorizedAccessException("Fixture boundary changed");if(File.Exists(p))throw new IOException("Replaced directory preserved");Directory.CreateDirectory(p);if((File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new UnauthorizedAccessException("Fixture link rejected");}
 static string Hash(Stream s){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(s)).Replace("-","").ToLowerInvariant();}
 static string HashFile(string p){using(var s=File.OpenRead(p))return Hash(s);}
 static FileStream RecoveryFile(string p,SecurityIdentifier sid=null){return File.OpenRead(p);}static string RecoveryHash(FileStream s,CancellationToken token){token.ThrowIfCancellationRequested();return Hash(s);}
 static void CopyCaller(NamedPipeServerStream pipe,string source,string target,string digest,long maximum,CancellationToken token,long reserve){
  if(target.EndsWith("disk.vhdx.restore.next"))DiskCopyReserve=reserve;
  if(CopyFailure!=null){token.ThrowIfCancellationRequested();var partial=File.ReadAllBytes(source).Take(4097).ToArray();using(var output=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None)){output.Write(partial,0,partial.Length);output.Flush(true);}HeldPartial=new FileStream(target,FileMode.Open,FileAccess.Read,FileShare.Read);if(CopyCancellation!=null)CopyCancellation.Cancel();throw CopyFailure;}
  token.ThrowIfCancellationRequested();using(var input=File.OpenRead(source)){if(input.Length>maximum||Hash(input)!=digest)throw new IOException("Fixture source digest mismatch");input.Position=0;using(var output=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None))input.CopyTo(output);}Copied++;
 }
 static Dictionary<string,object> Parameters(Dictionary<string,object> r){string dir=Path.Combine(UserRoot,"vms",Convert.ToString(r["id"]));return new Dictionary<string,object>{{"directory",dir},{"disk",Path.Combine(dir,"disk.vhdx")},{"seed",Path.Combine(dir,"seed.iso")}};}
 static Dictionary<string,object> RecoverAllocation(Dictionary<string,object> r){bool present=r.ContainsKey("platformId");return new Dictionary<string,object>{{"present",present},{"ready",present},{"state","Off"}};}
 static string Invoke(string action,Dictionary<string,object> p,int timeout,CancellationToken token){token.ThrowIfCancellationRequested();if(action=="disk-growth-facts")return Json().Serialize(new{platformId="87654321-4321-4321-8321-210987654321",diskIdentifier="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",diskGiB=VmCapacity,bytes=(long)VmCapacity*MuResourcePolicy.GiB});if(action=="allocation-absence")return Json().Serialize(new{absent=!Directory.Exists(Convert.ToString(p["directory"]))});if(action=="review-allocation")return Json().Serialize(new{platformId="87654321-4321-4321-8321-210987654321",cpus=1,memoryGiB=2,diskGiB=VmCapacity});if(action=="backup-import-verify"){Verified++;if(RejectFinalVerification&&Created>0)throw new IOException("Synthetic post-create policy mismatch");if(RejectOriginVerification&&CurrentOrigins!=null&&CurrentOrigins.Contains(Records.Keys.Single()))throw new IOException("Synthetic post-origin policy mismatch");}if(action=="create"){Created++;return "{\"platformId\":\"87654321-4321-4321-8321-210987654321\"}";}return "{}";}
 public static string RunFixture(string root,string scenario){
  ResetInitialization();
  UserRoot=Path.GetFullPath(root);Created=Copied=Verified=OriginCommits=0;FaultOnAcceptance=false;VmCapacity=16;OriginFaultPhase=null;RejectOriginVerification=FailFenceSave=false;OriginCancellation=null;CurrentOrigins=null;RejectFinalVerification=false;CopyFailure=null;CopyCancellation=null;HeldPartial=null;Records.Clear();bool primaryPreserved=false,partialPreserved=false,cleanupStillReported=false;string originalType=null,originalCode=null;string id="12345678-1234-4234-8234-123456789012",source=Path.Combine(root,"source.bin"),seed=Path.Combine(root,"seed.iso");Directory.CreateDirectory(Path.Combine(root,"vms"));ExpectedDirectory=Path.Combine(root,"vms",id);
  byte[] data=Enumerable.Range(0,131077).Select(i=>(byte)(i%251)).ToArray(),iso=new byte[49152];System.Text.Encoding.ASCII.GetBytes("CD001").CopyTo(iso,32769);File.WriteAllBytes(source,data);File.WriteAllBytes(seed,iso);
  string diskHash=HashFile(source),seedHash=HashFile(seed);var journal=new Dictionary<string,object>{{"diskSha256",diskHash},{"diskBytes",(long)data.Length},{"seedSha256",seedHash},{"seedBytes",(long)iso.Length}};
  var record=new Dictionary<string,object>{{"id",id},{"ownerSid",OwnerSid},{"image",Path.Combine(root,"unused-base.vhdx")},{"imageSha256",new string('a',64)},{"cpus",1},{"memoryGiB",2},{"diskGiB",16},{"stage","allocated"},{"everReady",true},{"backupRestore",journal}};Records.Add(id,record);
  var request=new Dictionary<string,object>{{"action","backup-import"},{"id",id},{"imageSha256",new string('a',64)},{"cpus",1},{"memoryGiB",2},{"diskGiB",16},{"disk",source},{"diskSha256",diskHash},{"diskBytes",(long)data.Length},{"seed",seed},{"seedSha256",seedHash},{"seedBytes",(long)iso.Length}};
  if(scenario=="resource-limited-retry"){
   Records.Clear();request["diskGiB"]=256;VmCapacity=256;long required=checked((long)data.Length+iso.Length+16L*MuResourcePolicy.GiB);SpaceLimit=required-1;
   bool rejected=false;try{BackupImport(null,request,CancellationToken.None);}catch(MuStorageException e){rejected=e.Code=="RESOURCE_DISK";}
   if(!rejected||LastPreflight!=required||Records.Count!=0||Directory.Exists(ExpectedDirectory)||Created!=0||Copied!=0)throw new Exception("Low-space preflight mutated restore state");
   SpaceLimit=required;try{BackupImport(null,request,CancellationToken.None);}finally{SpaceLimit=long.MaxValue;}
   if(Created!=1||Copied!=2||Records[id].ContainsKey("backupRestore")||HashFile(Path.Combine(ExpectedDirectory,"disk.vhdx"))!=diskHash)throw new Exception("Same restore did not finish after space was available");
   record=Records[id];
  }else if(scenario=="resource-cushion"){
   long max=256L*MuResourcePolicy.GiB,small=5L*MuResourcePolicy.GiB;
   if(RestoreGrowthCushion(max,small)!=16L*MuResourcePolicy.GiB||RestoreGrowthCushion(max,max-123)!=123||RestoreGrowthCushion(max,max)!=0)throw new Exception("Restore growth cushion was not bounded");
   bool rejected=false;try{RestoreGrowthCushion(max,max+1);}catch(ArgumentException){rejected=true;}if(!rejected)throw new Exception("Overlarge restore accepted");
   Records.Clear();LastPreflight=DiskCopyReserve=-1;BackupImport(null,request,CancellationToken.None);
   long cushion=RestoreGrowthCushion(MuResourceMetrics.DiskFootprint(16L*MuResourcePolicy.GiB),data.Length);
   if(LastPreflight!=data.Length+iso.Length+cushion||DiskCopyReserve!=cushion+iso.Length||Created!=1||Copied!=2)throw new Exception("Restore copy reservation omitted data, seed, or growth cushion");
   record=Records[id];
  }else
  if(scenario=="copy-cancel-cleanup-locked"||scenario=="copy-resource-cleanup-locked"||scenario=="copy-integrity-cleanup-locked"||scenario=="cleanup-locked-no-primary"){
   string temporary=Path.Combine(ExpectedDirectory,"disk.vhdx.restore.next");bool hasPrimary=scenario!="cleanup-locked-no-primary";Exception primary=null,observed=null;
   if(hasPrimary){CopyCancellation=new CancellationTokenSource();primary=scenario=="copy-cancel-cleanup-locked"?(Exception)new OperationCanceledException("Synthetic copy cancellation",CopyCancellation.Token):scenario=="copy-resource-cleanup-locked"?(Exception)new MuStorageException("RESOURCE_DISK","Synthetic copy space failure"):new ArgumentException("Synthetic copy checksum mismatch");CopyFailure=primary;}
   else{PrivateDirectory(ExpectedDirectory,false);File.WriteAllBytes(temporary,data.Take(4097).ToArray());HeldPartial=new FileStream(temporary,FileMode.Open,FileAccess.Read,FileShare.Read);}
   try{
    try{BackupImport(null,request,CopyCancellation==null?CancellationToken.None:CopyCancellation.Token);}catch(Exception error){observed=error;}
    if(observed==null)throw new Exception("A locked cleanup failure was silently accepted");
    if(!File.Exists(temporary)||!File.ReadAllBytes(temporary).SequenceEqual(data.Take(4097))||File.Exists(Path.Combine(ExpectedDirectory,"disk.vhdx"))||File.Exists(Path.Combine(ExpectedDirectory,"seed.iso"))||Created!=0||Copied!=0||!object.ReferenceEquals(record["backupRestore"],journal))throw new Exception("Locked partial data or its exact restore journal was not retained");partialPreserved=true;
    if(hasPrimary){
     if(!object.ReferenceEquals(observed,primary))throw new Exception("Original copy exception was replaced by cleanup: expected "+primary.GetType().Name+", observed "+observed.GetType().Name,observed);
     var cleanup=observed.Data["MuBackupRestoreCleanupFailure"] as Exception;if(!(cleanup is IOException)||object.ReferenceEquals(cleanup,primary))throw new Exception("The real locked-file cleanup failure was not retained separately");
     primaryPreserved=true;originalType=observed.GetType().Name;originalCode=observed is MuStorageException?((MuStorageException)observed).Code:observed is OperationCanceledException?"CANCELLED":"INVALID_REQUEST";
     if(primary is OperationCanceledException&&((OperationCanceledException)observed).CancellationToken!=CopyCancellation.Token)throw new Exception("The original cancellation token changed");
     cleanupStillReported=true;
    }else{if(!(observed is IOException))throw new Exception("A cleanup-only failure changed type",observed);cleanupStillReported=true;}
   }finally{if(HeldPartial!=null){HeldPartial.Dispose();HeldPartial=null;}if(CopyCancellation!=null){CopyCancellation.Dispose();CopyCancellation=null;}CopyFailure=null;}
   BackupImport(null,request,CancellationToken.None);
   if(Created!=1||Copied!=2||record.ContainsKey("backupRestore")||File.Exists(temporary)||HashFile(Path.Combine(ExpectedDirectory,"disk.vhdx"))!=diskHash||HashFile(Path.Combine(ExpectedDirectory,"seed.iso"))!=seedHash)throw new Exception("Original journal could not resume after releasing the synthetic lock");
  }else if(scenario=="conflicting-journal"){
   request["diskSha256"]=new string('b',64);bool rejected=false;try{BackupImport(null,request,CancellationToken.None);}catch(MuStorageException e){rejected=e.Code=="RESTORE_CONFLICT";}
   if(!rejected||Directory.Exists(ExpectedDirectory)||Created!=0||Copied!=0||!record.ContainsKey("backupRestore"))throw new Exception("Conflicting backup had side effects");
  }else if(scenario=="directory-replaced"){
   File.WriteAllText(ExpectedDirectory,"preserved obstruction");bool rejected=false;try{BackupImport(null,request,CancellationToken.None);}catch(IOException){rejected=true;}
   if(!rejected||File.ReadAllText(ExpectedDirectory)!="preserved obstruction"||Created!=0||!record.ContainsKey("backupRestore"))throw new Exception("Replaced storage was not preserved");
  }else if(scenario=="final-verification"){
   RejectFinalVerification=true;bool rejected=false;try{BackupImport(null,request,CancellationToken.None);}catch(IOException e){rejected=e.Message=="Synthetic post-create policy mismatch";}
   if(!rejected||Created!=1||Copied!=2||!record.ContainsKey("backupRestore"))throw new Exception("Post-create policy failure cleared the recovery fence");
   RejectFinalVerification=false;BackupImport(null,request,CancellationToken.None);
   if(Created!=1||Copied!=2||record.ContainsKey("backupRestore")||HashFile(Path.Combine(ExpectedDirectory,"disk.vhdx"))!=diskHash)throw new Exception("Verified retry replaced the existing restore");
  }else if(scenario.StartsWith("origin-")){
   if(scenario=="origin-slot-interrupted")OriginFaultPhase="frame-data";
   else if(scenario=="origin-cancel-after-publish"){OriginFaultPhase="frame-committed";OriginCancellation=new CancellationTokenSource();}
   else if(scenario=="origin-verification-after-publish")RejectOriginVerification=true;
   else if(scenario=="origin-fence-save")FailFenceSave=true;
   else if(scenario=="origin-accept-slot-interrupted"){OriginFaultPhase="frame-data";FaultOnAcceptance=true;}
   else if(scenario=="origin-cancel-after-accept"){OriginFaultPhase="frame-committed";FaultOnAcceptance=true;OriginCancellation=new CancellationTokenSource();}
   bool failure=scenario!="origin-growth-and-retire";Exception observed=null;
   try{BackupImport(null,request,OriginCancellation==null?CancellationToken.None:OriginCancellation.Token);}catch(Exception error){observed=error;}
   if(failure){if(observed==null||!record.ContainsKey("backupRestore")||Created!=1||Copied!=2)throw new Exception("Origin failure did not preserve restore fence",observed);if(scenario=="origin-cancel-after-publish"&&!(observed is OperationCanceledException))throw new Exception("Origin cancellation lost",observed);}
   else if(observed!=null)throw observed;
   if(scenario=="origin-accept-slot-interrupted"||scenario=="origin-cancel-after-accept")using(var origins=OpenOriginStore()){if(origins.ReadSnapshot(id,Convert.ToString(record["platformId"])).Accepted!=(scenario=="origin-cancel-after-accept"))throw new Exception("Wrong independent import acceptance after interruption");}
   OriginFaultPhase=null;OriginCancellation=null;FaultOnAcceptance=false;RejectOriginVerification=FailFenceSave=false;
   if(failure)BackupImport(null,request,CancellationToken.None);
   using(var origins=OpenOriginStore()){origins.ReadAcceptedSnapshot(id,Convert.ToString(record["platformId"]));var published=origins.Read(id,Convert.ToString(record["platformId"]));if(Convert.ToString(published["importDiskSha256"])!=diskHash||Convert.ToString(published["seedSha256"])!=seedHash||Convert.ToString(published["imageSha256"])!=new string('a',64))throw new Exception("Wrong imported provenance");}
   if(Created!=1||Copied!=2||record.ContainsKey("backupRestore")||!OriginTracked(record))throw new Exception("Origin retry did not settle original restore");
   if(scenario=="origin-growth-and-retire"){
    var growth=new Dictionary<string,object>{{"fromGiB",16},{"targetGiB",32},{"diskIdentifier","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},{"fileIdentity",MuDiskGrowthPolicy.FileIdentity(Convert.ToString(Parameters(record)["disk"]))}};record["diskGrowth"]=growth;record["diskGiB"]=32;VmCapacity=32;
    var finish=new Dictionary<string,object>{{"action","finish-disk-growth"},{"id",id},{"targetGiB",32},{"filesystemBytes",32L*MuResourcePolicy.GiB-1048576},{"partitionStartBytes",1048576}};
    FailGrowthSave=true;bool saveRejected=false;try{DiskGrowthAction("finish-disk-growth",finish,CancellationToken.None);}catch(IOException){saveRejected=true;}if(!saveRejected||!object.ReferenceEquals(record["diskGrowth"],growth))throw new Exception("Growth save failure cleared its journal");FailGrowthSave=false;DiskGrowthAction("finish-disk-growth",finish,CancellationToken.None);if(record.ContainsKey("diskGrowth"))throw new Exception("Growth completion failed to settle");
    using(var origins=OpenOriginStore())if(Convert.ToInt32(origins.Read(id,Convert.ToString(record["platformId"]))["diskGiB"])!=32)throw new Exception("Growth origin not refreshed");
    var original=OriginBeforeRemoval(record);bool rejected=false;try{RetireRemovedOrigin(record,original);}catch(IOException){rejected=true;}if(!rejected)throw new Exception("Live storage incorrectly retired");
    Directory.Delete(ExpectedDirectory,true);RetireRemovedOrigin(record,original);RetireRemovedOrigin(record,original);using(var origins=OpenOriginStore())if(origins.Contains(id))throw new Exception("Retired origin remains");
   }
  }else if(scenario=="missing-directory"){
   if(Directory.Exists(ExpectedDirectory))throw new Exception("The crash boundary must precede directory creation");var result=BackupImport(null,request,CancellationToken.None);
   if(HashFile(Path.Combine(ExpectedDirectory,"disk.vhdx"))!=diskHash||HashFile(Path.Combine(ExpectedDirectory,"seed.iso"))!=seedHash||Created!=1||Copied!=2||record.ContainsKey("backupRestore")||Convert.ToString(record["stage"])!="ready")throw new Exception("Interrupted allocation was not fully restored");
  }else throw new ArgumentException("Unknown fixture");
  if(HashFile(source)!=diskHash||HashFile(seed)!=seedHash)throw new Exception("Source inputs changed");return Json().Serialize(new{complete=true,scenario=scenario,created=Created,copied=Copied,realHyperVExercised=false,realWindowsFileLock=partialPreserved,primaryPreserved=primaryPreserved,partialPreserved=partialPreserved,cleanupStillReported=cleanupStillReported,originalType=originalType,originalCode=originalCode});
 }
}
