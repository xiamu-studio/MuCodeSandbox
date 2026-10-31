param([string]$Source)
$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions
$text=[IO.File]::ReadAllText($Source)
$start=$text.IndexOf('    private static void EnsureCompactionIdle(',[StringComparison]::Ordinal)
$end=$text.IndexOf('    private static object DiskGrowthAction(', $start,[StringComparison]::Ordinal)
if($start -lt 0 -or $end -le $start){throw 'Production transaction boundary missing'}
$fragment=$text.Substring($start,$end-$start)
$resources=[IO.File]::ReadAllText((Join-Path (Split-Path $Source) 'Resources.cs'))
$rstart=$resources.IndexOf('    private static bool ResourceMutation(',[StringComparison]::Ordinal)
$rend=$resources.IndexOf('    private static FileStream ImportReservation(', $rstart,[StringComparison]::Ordinal)
if($rstart -lt 0 -or $rend -le $rstart){throw 'Resource admission boundary missing'}
$fragment+=[Environment]::NewLine+$resources.Substring($rstart,$rend-$rstart)
$prefix=@'
using System;using System.IO;using System.Linq;using System.Collections.Generic;using System.Threading;using System.Text;using System.Web.Script.Serialization;
public class MuStorageException:Exception {public MuStorageException(string code,string text):base(code){}}
public static class MuResourcePolicy {public const long GiB=1073741824;}
public static class MuDiskGrowthPolicy {public static string FileIdentity(string path){return "aaaaaaaaaaaaaaaaaaaaaaaa";}}
public static partial class MuHyperVBroker {
 static object Gate=new object(),ImportGate=new object(),vm=new object();static string ResourceIssue=null,mode="",reservationPath,UserRoot;static int factsCount=0,calls=0,saves=0,starts=0,submissions=0;static bool running=false,Quiescing=false,Stopping=false;static HashSet<string> StartedHere=new HashSet<string>(),CompactionChannels=new HashSet<string>(),CompactionVerifyBoots=new HashSet<string>(),CompactionRunPermits=new HashSet<string>();
 static Dictionary<string,object> record,journal;
 static Dictionary<string,object> BackupReads=new Dictionary<string,object>(),SnapshotExports=new Dictionary<string,object>(),SnapshotLiveDeletes=new Dictionary<string,object>();
 public static void ConfigureReservation(string path){reservationPath=path;UserRoot=Path.GetDirectoryName(path);}static void PrivateDirectory(string path){Directory.CreateDirectory(path);}static void ValidateLedgerFile(string path){}static object VmGate(string id){return vm;} static IDisposable ImportReservation(){return new FileStream(reservationPath,FileMode.Open,FileAccess.ReadWrite,FileShare.None);}
 public static bool CountsAsResourceMutation(string action){return ResourceMutation(action);}
 public static void AssertReservationExclusive(){try{using(ImportReservation())using(ImportReservation()){} }catch(IOException){return;}throw new Exception("The fixture did not enforce a real exclusive reservation");}
 static void QuiesceAdmission(string action){}static void CheckPower(){}static bool HostServicingBusy(){return false;}
 static void CloseChannel(string id){}static void StartWithResources(Dictionary<string,object> r,CancellationToken t,Action start){lock(ImportGate)using(ImportReservation()){start();}}
 static void SnapshotLiveAdmission(string id,string action,Dictionary<string,object> request){}static void CheckBackupBusy(string id,string action){}static void RestorePending(string id,string action){}static void SnapshotPending(string id,string action){}
 static Dictionary<string,object> Owned(string id){return record;}static bool EverReady(Dictionary<string,object> v){return true;}
 static Dictionary<string,object> GrowthJournal(Dictionary<string,object> v){return null;}
 static Dictionary<string,object> Parameters(Dictionary<string,object> v){return new Dictionary<string,object>();}
 static JavaScriptSerializer Json(){return new JavaScriptSerializer();}static string Text(Dictionary<string,object> v,string k,int n){return Convert.ToString(v[k]);}
 static string Id(Dictionary<string,object> request){return Convert.ToString(request["id"]);}static void ValidateKeys(Dictionary<string,object> request,params string[] keys){foreach(string key in request.Keys)if(Array.IndexOf(keys,key)<0)throw new ArgumentException("Unexpected field");}
 static object Call(string action){var request=new Dictionary<string,object>{{"action",action},{"id","id"}};if(mode=="foreign-field")request["path"]="C:\\foreign.vhdx";return DiskCompactionAction(action,request,CancellationToken.None);}
 static Dictionary<string,object> GrowthFacts(Dictionary<string,object> r,CancellationToken t){factsCount++;if(running)throw new IOException("guest still running");return new Dictionary<string,object>{{"platformId","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},{"diskIdentifier",mode=="changed-before"&&factsCount==4||mode=="changed-after"&&factsCount==5||mode=="changed-trim"&&factsCount==3||mode=="changed-review"&&factsCount==7||mode=="reset-identity"&&factsCount==2||mode=="finish-identity"&&factsCount==3?"changed":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},{"fileIdentity","aaaaaaaaaaaaaaaaaaaaaaaa"},{"diskGiB",32L},{"allocatedBytes",factsCount==1?5L*MuResourcePolicy.GiB:mode=="grows"?6L*MuResourcePolicy.GiB:3L*MuResourcePolicy.GiB},{"bytes",32L*MuResourcePolicy.GiB}};}
 static void Save(){saves++;if(mode=="save-begin"&&saves==1||mode=="save-start"&&saves==2||mode=="save-reset"&&saves==2||mode=="finish-save"&&saves==2||mode=="save-submit"&&saves==4||mode=="save-end"&&saves==5)throw new IOException("save failed");}
 static string Invoke(string action,Dictionary<string,object> p,int timeout,CancellationToken token){if(action=="start"){starts++;running=true;if(mode=="start-fail"||mode=="verify-start-fail"&&starts==2)throw new IOException("start failed");if(mode=="revoked-at-start")Quiescing=true;return "started";}if(action=="stop"){running=false;return "stopped";}calls++;if(mode=="invoke-fail"||mode=="async-missing")throw new IOException("failed");if(action=="compact-disk-submit"){submissions++;bool async=mode.StartsWith("async-");string job=async?"cccccccc-cccc-4ccc-8ccc-cccccccccccc":null;string submitted=async?"started":"completed";if(mode=="bad-receipt")return Json().Serialize(new{submitted="started",jobId="invalid"});var current=(Dictionary<string,object>)record["diskCompaction"];string file=Path.Combine(UserRoot,"compaction-receipts",Convert.ToString(current["operationId"])+".json");if(mode!="published-missing")File.WriteAllText(file,Json().Serialize(new{operationId=current["operationId"],platformId=record["platformId"],diskIdentifier=current["diskIdentifier"],submitted=mode=="published-mismatch"?"started":submitted,jobId=mode=="published-mismatch"?"cccccccc-cccc-4ccc-8ccc-cccccccccccc":job}));return Json().Serialize(new{submitted=submitted,jobId=job});}if(action=="compact-disk-job")return Json().Serialize(new{jobId=mode=="async-wrong"?"dddddddd-dddd-4ddd-8ddd-dddddddddddd":"cccccccc-cccc-4ccc-8ccc-cccccccccccc",state=mode=="async-pending"?4:7,errorCode=mode=="async-error"?1:0,completionCode=mode=="async-hresult"?1:0});throw new IOException("Unexpected provider action "+action);}
 public static string Exercise(string requested){
  mode=requested;factsCount=0;calls=0;saves=0;starts=0;running=false;Quiescing=false;StartedHere.Clear();CompactionChannels.Clear();CompactionVerifyBoots.Clear();CompactionRunPermits.Clear();BackupReads.Clear();SnapshotExports.Clear();SnapshotLiveDeletes.Clear();record=new Dictionary<string,object>{{"stage","ready"},{"platformId","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}};
  if(mode=="busy")BackupReads.Add("id",new object());string error=null;object review=null;
  try{if(mode=="valid"){var empty=Json().Deserialize<Dictionary<string,object>>(Json().Serialize(Call("disk-compact-status")));if(Convert.ToBoolean(empty["pending"]))throw new Exception("unexpected pending status");}if(mode=="unknown-action")Call("disk-compact-unknown");else Call("disk-compact-begin");journal=(Dictionary<string,object>)record["diskCompaction"];if(mode=="valid"){var pending=Json().Deserialize<Dictionary<string,object>>(Json().Serialize(Call("disk-compact-status")));if(!Convert.ToBoolean(pending["pending"])||Convert.ToString(pending["phase"])!="preparing"||Convert.ToInt64(pending["beforeBytes"])!=5L*MuResourcePolicy.GiB)throw new Exception("incorrect pending status");}Call("disk-compact-start");if(!CompactionChannels.Contains("id"))throw new Exception("missing trim channel authority");if(mode!="still-running"){CompactionChannels.Remove("id");CloseChannel("id");running=false;}Call("disk-compact-trimmed");if(mode=="lost-permit")CompactionRunPermits.Clear();if(mode=="wrong-phase")journal["phase"]="trimming";Call("disk-compact-run");Call("disk-compact-verify-start");if(!CompactionChannels.Contains("id"))throw new Exception("missing verify channel authority");CompactionChannels.Remove("id");CloseChannel("id");running=false;review=Call("disk-compact-review");}catch(Exception e){error=e.GetType().Name;}
  if(mode=="invoke-fail"||mode=="bad-receipt"||mode=="changed-after"){try{Call("disk-compact-run");throw new Exception("A consumed compaction permit was reused");}catch(InvalidOperationException){}}
  string phase=record.ContainsKey("diskCompaction")?Convert.ToString(((Dictionary<string,object>)record["diskCompaction"])["phase"]):"none";
  return Json().Serialize(new {error=error,phase=phase,calls=calls,saves=saves,running=running,channel=CompactionChannels.Contains("id"),review=review});
 }
 public static string ExerciseReset(string requested){
  mode=requested;factsCount=0;calls=0;saves=0;starts=0;running=false;Quiescing=false;StartedHere.Clear();CompactionChannels.Clear();CompactionVerifyBoots.Clear();CompactionRunPermits.Clear();BackupReads.Clear();SnapshotExports.Clear();SnapshotLiveDeletes.Clear();record=new Dictionary<string,object>{{"stage","ready"},{"platformId","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}};
  string error=null;try{
   Call("disk-compact-begin");journal=(Dictionary<string,object>)record["diskCompaction"];
   if(mode!="cancel-preparing")journal["phase"]=mode=="reset-compacting"?"compacting":mode=="reset-verifying"?"verifying":mode=="cancel-armed"||mode=="retry-armed"?"armed":"trimming";
   if(mode=="reset-running")running=true;if(mode=="reset-channel")CompactionChannels.Add("id");
   Call(mode=="retry-trimming"||mode=="retry-armed"?"disk-compact-retry":"disk-compact-cancel");
  }catch(Exception e){error=e.GetType().Name;}
  string phase=record.ContainsKey("diskCompaction")?Convert.ToString(((Dictionary<string,object>)record["diskCompaction"])["phase"]):"none";
  return Json().Serialize(new {error=error,phase=phase,calls=calls});
 }
 public static string ExerciseFinish(string requested){
  mode=requested;factsCount=0;calls=0;saves=0;starts=0;running=false;Quiescing=false;StartedHere.Clear();CompactionChannels.Clear();CompactionVerifyBoots.Clear();CompactionRunPermits.Clear();BackupReads.Clear();SnapshotExports.Clear();SnapshotLiveDeletes.Clear();record=new Dictionary<string,object>{{"stage","ready"},{"platformId","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}};string error=null;object result=null;
  try{
   Call("disk-compact-begin");journal=(Dictionary<string,object>)record["diskCompaction"];journal["phase"]="verifying";
   if(mode!="finish-no-boot"){Call("disk-compact-verify-start");if(mode!="finish-running")running=false;if(mode!="finish-channel")CompactionChannels.Remove("id");if(mode=="finish-revoked")CompactionVerifyBoots.Clear();}
   var request=new Dictionary<string,object>{{"action","disk-compact-finish"},{"id","id"},{"filesystemBytes",mode=="finish-number"?(object)1.5:mode=="finish-geometry"?32L*MuResourcePolicy.GiB:31L*MuResourcePolicy.GiB},{"partitionBytes",31L*MuResourcePolicy.GiB},{"partitionStartBytes",128L*1024*1024},{"afterBytes",(mode=="finish-measure"?4L:3L)*MuResourcePolicy.GiB}};
   result=DiskCompactionAction("disk-compact-finish",request,CancellationToken.None);
  }catch(Exception e){error=e.GetType().Name;}
  string phase=record.ContainsKey("diskCompaction")?Convert.ToString(((Dictionary<string,object>)record["diskCompaction"])["phase"]):"none";
  return Json().Serialize(new {error=error,phase=phase,result=result,token=CompactionVerifyBoots.Contains("id")});
 }
 public static string ExerciseAsync(string requested){
  mode="async-pending";factsCount=0;calls=0;saves=0;starts=0;submissions=0;running=false;Quiescing=false;StartedHere.Clear();CompactionChannels.Clear();CompactionVerifyBoots.Clear();CompactionRunPermits.Clear();BackupReads.Clear();SnapshotExports.Clear();SnapshotLiveDeletes.Clear();record=new Dictionary<string,object>{{"stage","ready"},{"platformId","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}};
  Call("disk-compact-begin");journal=(Dictionary<string,object>)record["diskCompaction"];Call("disk-compact-start");CompactionChannels.Remove("id");running=false;Call("disk-compact-trimmed");
  bool pendingRejected=false;try{Call("disk-compact-run");}catch(MuStorageException){pendingRejected=true;}
  if(!pendingRejected||Convert.ToString(journal["phase"])!="compacting"||Convert.ToString(journal["jobId"])!="cccccccc-cccc-4ccc-8ccc-cccccccccccc"||submissions!=1)throw new Exception("Pending job was not durably fenced");
  mode=requested;string receiptFile=null;if(mode=="async-no-id"||mode=="async-receipt"||mode=="async-receipt-wrong"||mode=="async-receipt-sync"){journal.Remove("jobId");File.Delete(Path.Combine(UserRoot,"compaction-receipts",Convert.ToString(journal["operationId"])+".json"));if(mode!="async-no-id"){
   string directory=Path.Combine(UserRoot,"compaction-receipts");Directory.CreateDirectory(directory);receiptFile=Path.Combine(directory,Convert.ToString(journal["operationId"])+".json");
   var receipt=new {operationId=journal["operationId"],platformId=record["platformId"],diskIdentifier=mode=="async-receipt-wrong"?"dddddddd-dddd-4ddd-8ddd-dddddddddddd":Convert.ToString(journal["diskIdentifier"]),submitted=mode=="async-receipt-sync"?"completed":"started",jobId=mode=="async-receipt-sync"?null:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"};File.WriteAllText(receiptFile,Json().Serialize(receipt));
  }}string error=null;try{Call("disk-compact-reconcile");}catch(Exception e){error=e.GetType().Name;}finally{if(receiptFile!=null)File.Delete(receiptFile);}
  return Json().Serialize(new{error=error,phase=journal["phase"],jobPresent=journal.ContainsKey("jobId"),submissions=submissions});
 }
'@
Add-Type -TypeDefinition ($prefix+[Environment]::NewLine+$fragment+[Environment]::NewLine+'}') -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
$reservation=[IO.Path]::GetTempFileName()
try{
[MuHyperVBroker]::ConfigureReservation($reservation)
[MuHyperVBroker]::AssertReservationExclusive()
foreach($action in @('disk-compact-begin','disk-compact-start','disk-compact-trimmed','disk-compact-run','disk-compact-reconcile','disk-compact-verify-start','disk-compact-finish','disk-compact-retry','disk-compact-cancel')){if(-not [MuHyperVBroker]::CountsAsResourceMutation($action)){throw ('Maintenance mutation omitted resource cancellation: '+$action)}}
foreach($action in @('disk-compact-status','disk-compact-review')){if([MuHyperVBroker]::CountsAsResourceMutation($action)){throw ('Read-only maintenance inspection was counted as mutation: '+$action)}}
foreach($mode in @('async-ready','async-pending','async-error','async-hresult','async-wrong','async-missing','async-no-id','async-receipt','async-receipt-wrong','async-receipt-sync')){
 $r=[MuHyperVBroker]::ExerciseAsync($mode)|ConvertFrom-Json
 if($r.submissions -ne 1){throw ('Reconciliation resubmitted compaction: '+$mode)}
 if($mode -in @('async-ready','async-receipt','async-receipt-sync')){if($r.error -or $r.phase -ne 'verifying' -or $r.jobPresent){throw 'Confirmed job did not advance to verification'}}
 else{if(-not $r.error -or $r.phase -ne 'compacting'){throw ('Unconfirmed job cleared its fence: '+$mode)}}
}
foreach($mode in @('valid','grows','foreign-field','unknown-action','busy','save-begin','save-start','start-fail','revoked-at-start','still-running','changed-trim','wrong-phase','lost-permit','changed-before','save-submit','invoke-fail','bad-receipt','published-missing','published-mismatch','changed-after','save-end','verify-start-fail','changed-review')){
 $r=[MuHyperVBroker]::Exercise($mode)|ConvertFrom-Json
 if($mode -in @('valid','grows')){if($r.error -or $r.phase -ne 'verifying' -or $r.calls -ne 1 -or $r.saves -ne 5 -or $r.review.beforeBytes -ne 5GB -or $r.review.afterBytes -ne $(if($mode -eq 'grows'){6GB}else{3GB})){throw 'Measured transaction receipt changed'}}
 else{
  if(-not $r.error){throw ('Failure was accepted: '+$mode)}
  if($mode -in @('foreign-field','unknown-action') -and ($r.phase -ne 'none' -or $r.calls -ne 0)){throw 'Invalid request created a journal or reached compact'}
  if($mode -eq 'busy' -and ($r.phase -ne 'none' -or $r.calls -ne 0)){throw 'Busy operation created a journal or invoked compact'}
  if($mode -eq 'save-begin' -and ($r.phase -ne 'preparing' -or $r.calls -ne 0)){throw 'Failed journal publication did not remain fenced'}
  if($mode -in @('save-start','start-fail','revoked-at-start','still-running','changed-trim') -and ($r.phase -ne 'trimming' -or $r.calls -ne 0)){throw ('Trim failure did not retain its fence: '+$mode)}
  if($mode -eq 'start-fail' -and ($r.running -or $r.channel)){throw 'Failed start was not stopped or channel revoked'}
  if($mode -eq 'revoked-at-start' -and ($r.running -or $r.channel)){throw 'Revocation during start restored maintenance authority'}
  if($mode -eq 'verify-start-fail' -and ($r.running -or $r.channel -or $r.phase -ne 'verifying')){throw 'Failed verification start did not stop or keep its fence'}
  if($mode -in @('wrong-phase','lost-permit','changed-before','save-submit') -and $r.calls -ne 0){throw 'Unsafe operation reached compact'}
  if($mode -eq 'save-submit' -and $r.phase -ne 'compacting'){throw 'Ambiguous submit journal was not preserved'}
  if($mode -in @('invoke-fail','bad-receipt','published-missing','published-mismatch','changed-after') -and $r.phase -ne 'compacting'){throw 'Unconfirmed compact lost its journal'}
  if($mode -eq 'save-end' -and $r.phase -ne 'compacting'){throw 'Failed verification publication lost its original fence'}
 }
}
foreach($mode in @('cancel-preparing','cancel-trimming','cancel-armed','retry-trimming','retry-armed','reset-running','reset-channel','reset-identity','reset-compacting','reset-verifying','save-reset')){
 $r=[MuHyperVBroker]::ExerciseReset($mode)|ConvertFrom-Json
 if($mode -in @('cancel-preparing','cancel-trimming','cancel-armed')){if($r.error -or $r.phase -ne 'none'){throw ('Safe cancellation failed: '+$mode)}}
 elseif($mode -in @('retry-trimming','retry-armed')){if($r.error -or $r.phase -ne 'preparing'){throw 'Safe retry did not retain preparation'}}
 else{if(-not $r.error -or $r.phase -eq 'none' -or $r.calls -ne 0){throw ('Unsafe reset was accepted: '+$mode)}}
}
foreach($mode in @('finish-valid','finish-no-boot','finish-running','finish-channel','finish-revoked','finish-number','finish-geometry','finish-identity','finish-measure','finish-save')){
 $r=[MuHyperVBroker]::ExerciseFinish($mode)|ConvertFrom-Json
 if($mode -eq 'finish-valid'){if($r.error -or $r.phase -ne 'none' -or -not $r.result.completed -or $r.result.beforeBytes -ne 5GB -or $r.result.afterBytes -ne 3GB -or $r.token){throw 'Verified completion failed'}}
 else{if(-not $r.error -or $r.phase -ne 'verifying' -or $null -ne $r.result){throw ('Unsafe verification was accepted: '+$mode)}}
}
}finally{[IO.File]::Delete($reservation)}
