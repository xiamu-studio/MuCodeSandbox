using System;using System.IO;using System.Text;using System.Linq;using System.Collections.Generic;using System.Threading;using System.Web.Script.Serialization;using System.Security.Cryptography;
public sealed class MuStorageException:IOException {public string Code;public MuStorageException(string code,string message):base(message){Code=code;}}
// Only operating-system/privileged boundaries are doubled. SnapshotLiveDeletion,
// SnapshotLiveAuthority, SnapshotLiveAdmission and the complete durable deletion
// store are extracted verbatim from production and compiled together below.
public static partial class MuHyperVBroker {
 static readonly object Gate=new object(),fixtureVmGate=new object();
 static CancellationTokenSource Closing,PowerCancellation,ResourceCancellation;
 static Dictionary<string,object> fixtureRecord;static string fixtureDirectory,fixtureState,ResourceIssue,pause;
 static ManualResetEvent entered,released;static int reviews,mutations;static Action<string> fixtureProgress;
 static JavaScriptSerializer Json(){return new JavaScriptSerializer{MaxJsonLength=1048576};}
 static string Text(Dictionary<string,object> r,string key,int max){object v;if(!r.TryGetValue(key,out v)||!(v is string)||((string)v).Length>max)throw new ArgumentException("Fixture bounded string");return(string)v;}
 static string Id(Dictionary<string,object> r){string id=Text(r,"id",36);Guid value;if(!Guid.TryParseExact(id,"D",out value)||value==Guid.Empty||value.ToString("D")!=id)throw new ArgumentException("Canonical fixture identity");return id;}
 static void ValidateKeys(Dictionary<string,object> r,params string[] allowed){if(r.Keys.Any(k=>!allowed.Contains(k)))throw new ArgumentException("Unknown field");}
 static object VmGate(string id){return fixtureVmGate;}
 static Dictionary<string,object> Owned(string id){if(id!=Convert.ToString(fixtureRecord["id"]))throw new UnauthorizedAccessException("Foreign allocation");return fixtureRecord;}
 static Dictionary<string,object> Parameters(Dictionary<string,object> r){return new Dictionary<string,object>(r);}
 static void CheckPower(){if(PowerCancellation.IsCancellationRequested)throw new MuStorageException("POWER_FENCED","Fixture power fence");}
 static bool HostServicingBusy(){return false;}
 static void CheckBackupBusy(string id,string a){if(fixtureRecord.ContainsKey("backupBusy"))throw new MuStorageException("BACKUP_BUSY","Fixture active backup");}
 static void RestorePending(string id,string a){if(fixtureRecord.ContainsKey("restorePending"))throw new MuStorageException("RESTORE_PENDING","Fixture restore fence");}
 static void SnapshotPending(string id,string a){if(fixtureRecord.ContainsKey("snapshotPending"))throw new MuStorageException("SNAPSHOT_PENDING","Fixture snapshot fence");}
 static object GrowthJournal(Dictionary<string,object> r){return r.ContainsKey("growthPending")?new object():null;}
 sealed class Pin:IDisposable {public void Dispose(){}}
 static IDisposable SnapshotPin(Dictionary<string,object> r){return new Pin();}
 static string SnapshotDeleteAuthority(Dictionary<string,object> r){return new string('a',64);}
 static object SnapshotEnvelope(Dictionary<string,object> r,string serialized,bool parse){if(serialized!="synthetic-owner-cipher")throw new UnauthorizedAccessException("Fixture owner mismatch");return null;}
 static MuOfflineSnapshotStore SnapshotDeletionStore(Dictionary<string,object> r,Action review){return Store(review);}
 static MuOfflineSnapshotStore Store(Action review){return new MuOfflineSnapshotStore(fixtureDirectory,Id(fixtureRecord),p=>{Directory.CreateDirectory(p);},p=>new FileStream(p,FileMode.Open,FileAccess.Read,FileShare.Read),bytes=>{},review,phase=>{if(fixtureProgress!=null)fixtureProgress(phase);});}
 static void Pause(string phase){if(pause==phase){entered.Set();if(!released.WaitOne(10000))throw new TimeoutException("Fixture barrier timeout");}}
 static string Invoke(string action,Dictionary<string,object> p,int timeout,CancellationToken cancel){
  if(action!="review-snapshot-delete"){mutations++;throw new InvalidOperationException("VM mutation is forbidden in this fixture");}reviews++;Pause("provider-review");
  return Json().Serialize(new{platformId=fixtureRecord["platformId"],snapshotId=p["snapshotId"],state=fixtureState,cpus=2,memoryGiB=2,diskGiB=32,unreferenced=true});
 }
 static void Require(bool condition,string message){if(!condition)throw new Exception(message);}
 static string Hash(string file){using(var sha=SHA256.Create())using(var input=File.OpenRead(file))return Convert.ToBase64String(sha.ComputeHash(input));}
 static Dictionary<string,object> Request(string action){return new Dictionary<string,object>{{"action",action},{"id",fixtureRecord["id"]}};}
 static void Stop(){lock(VmGate(Id(fixtureRecord))){SnapshotLiveAdmission(Id(fixtureRecord),"stop",Request("stop"));fixtureState="Off";}}
 static void Reset(string root,string name){
  fixtureDirectory=Path.Combine(root,name,"12345678-1234-4234-8234-123456789abc");Directory.CreateDirectory(fixtureDirectory);fixtureState="Running";ResourceIssue=null;pause=null;fixtureProgress=null;reviews=0;mutations=0;
  Closing=new CancellationTokenSource();PowerCancellation=new CancellationTokenSource();ResourceCancellation=new CancellationTokenSource();entered=new ManualResetEvent(false);released=new ManualResetEvent(false);
  fixtureRecord=new Dictionary<string,object>{{"id","12345678-1234-4234-8234-123456789abc"},{"platformId","22345678-1234-4234-8234-123456789abc"},{"stage","ready"},{"directory",fixtureDirectory},{"cpus",2},{"memoryGiB",2},{"diskGiB",32}};
  File.WriteAllText(Path.Combine(fixtureDirectory,"disk.vhdx"),"synthetic CURRENT disk: no VHD metadata");File.WriteAllText(Path.Combine(fixtureDirectory,"seed.iso"),"synthetic CURRENT seed");
 }
 static void DisposeFixture(){Closing.Dispose();PowerCancellation.Dispose();ResourceCancellation.Dispose();entered.Dispose();released.Dispose();Require(SnapshotLiveDeletes.Count==0,"Passive fence leaked");}
 static Dictionary<string,object> DeleteRequest(){var snap=Store(()=>{}).Create("旧快照","synthetic-owner-cipher",CancellationToken.None);var r=Request("snapshot-delete");r["snapshotId"]=snap.id;r["name"]=snap.name;r["resumeOnly"]=false;r["allowRunning"]=true;return r;}
 static void IndependentStop(){Exception error=null;var thread=new Thread(()=>{try{Stop();}catch(Exception e){error=e;}});thread.Start();Require(thread.Join(1500),"Stop joined long snapshot IO");if(error!=null)throw error;}
 static bool Reject(Action work){try{work();return false;}catch(ArgumentException){return true;}catch(UnauthorizedAccessException){return true;}catch(MuStorageException){return true;}}
 public static string RunLiveDeleteFixture(string root,string sourceHash){
  var checks=new List<object>();Action<string> pass=name=>checks.Add(new{name=name,passed=true});
  Reset(root,"complete");try{var r=DeleteRequest();string disk=Hash(Path.Combine(fixtureDirectory,"disk.vhdx")),seed=Hash(Path.Combine(fixtureDirectory,"seed.iso"));SnapshotLiveDeletion(r,CancellationToken.None);Require(fixtureState=="Running"&&reviews>=6&&mutations==0,"Live deletion changed VM state or skipped repeated review");Require(Hash(Path.Combine(fixtureDirectory,"disk.vhdx"))==disk&&Hash(Path.Combine(fixtureDirectory,"seed.iso"))==seed,"Current storage changed");Require(Store(()=>{}).List().Length==0,"Snapshot not deleted");pass("production-live-route-deletes-only-independent-copy-with-repeated-review");}finally{DisposeFixture();}
  foreach(string cause in new[]{"stop","power","resource","owner-exit","authority-change"}){
   Reset(root,cause);try{
    var r=DeleteRequest();pause="provider-review";Exception error=null;var thread=new Thread(()=>{try{SnapshotLiveDeletion(r,CancellationToken.None);}catch(Exception e){error=e;}});thread.Start();Require(entered.WaitOne(5000),"Live route did not reach review barrier");
    foreach(string action in new[]{"allocation","status","inspect","channel"})lock(VmGate(Id(fixtureRecord)))SnapshotLiveAdmission(Id(fixtureRecord),action,Request(action));
    foreach(string action in new[]{"start","prepare","delete","grow-disk","backup-begin","snapshot-list","snapshot-status","snapshot-create","snapshot-prepare","snapshot-delete"})Require(Reject(()=>{lock(VmGate(Id(fixtureRecord)))SnapshotLiveAdmission(Id(fixtureRecord),action,Request(action));}),"Mutation or blocking snapshot read bypassed passive fence: "+action);
    Require(Reject(()=>SnapshotLiveDeletion(r,CancellationToken.None)),"Concurrent deletion entered the same allocation");
    if(cause=="stop")IndependentStop();else if(cause=="power")PowerCancellation.Cancel();else if(cause=="resource")ResourceCancellation.Cancel();else if(cause=="owner-exit")Closing.Cancel();else fixtureRecord["cpus"]=4;
    Require(thread.IsAlive,"Long provider was not held independently of stop");released.Set();Require(thread.Join(5000),"Cancelled deletion did not settle");Require(error!=null,"Invalidated deletion succeeded");Require(Store(()=>{}).List().Length==1,"Invalidated deletion removed snapshot");Require(mutations==0,"Live route performed a VM mutation");pass("production-live-route-"+cause+"-does-not-join-io-or-publish-stale-success");
   }finally{released.Set();DisposeFixture();}
  }
  Reset(root,"retired-stop");try{
   var r=DeleteRequest();pause="delete-retired";fixtureProgress=Pause;Exception error=null;var thread=new Thread(()=>{try{SnapshotLiveDeletion(r,CancellationToken.None);}catch(Exception e){error=e;}});thread.Start();Require(entered.WaitOne(5000),"Durable retirement not reached");IndependentStop();released.Set();Require(thread.Join(5000)&&error!=null,"Retired cancellation did not settle");Require(fixtureState=="Off","Stopped state overwritten");Require(Store(()=>{}).PendingDeletions(new string('a',64)).Length==1,"Deletion intent was lost");fixtureProgress=null;Store(()=>{}).Delete(Convert.ToString(r["snapshotId"]),"旧快照",new string('a',64),true,s=>{},CancellationToken.None);Require(Store(()=>{}).PendingDeletions(new string('a',64)).Length==0,"Stopped resume failed");pass("production-retired-stop-retains-durable-intent-and-stopped-retry");
  }finally{released.Set();DisposeFixture();}
  foreach(object mode in new object[]{false,"true",1,null}){Reset(root,"bad-mode-"+checks.Count);try{var r=DeleteRequest();r["allowRunning"]=mode;Require(Reject(()=>SnapshotLiveDeletion(r,CancellationToken.None)),"Malformed live mode accepted");Require(reviews==0,"Invalid request reached VM review");pass("production-rejects-invalid-live-mode-"+checks.Count);}finally{DisposeFixture();}}
  return Json().Serialize(new{complete=true,sourceHash=sourceHash,checks=checks,actualHyperV=false,actualAcl=false,productionLiveMethods=true,productionDurableStore=true});
 }
}
