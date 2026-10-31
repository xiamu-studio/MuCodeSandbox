// Actual BackupImport, protected duplicate-ledger persistence and table bytes.
// VM commands, source impersonation and successful ACLs remain test adapters.
public static partial class MuHyperVBroker {
 static MuProtectedLedger InitializationLedger;static string InitializationFault,InitializationKill;static bool FailInitializationReserve,FailInitializationBind,FailInitializationComplete,InitializationStarted;static CancellationTokenSource InitializationCancellation;
 static void ResetInitialization(){InitializationLedger=null;InitializationFault=InitializationKill=null;FailInitializationReserve=FailInitializationBind=FailInitializationComplete=InitializationStarted=false;if(InitializationCancellation!=null)InitializationCancellation.Dispose();InitializationCancellation=null;}
 static void ObserveInitialization(string phase){
  if(phase==InitializationKill){Console.WriteLine("ORIGIN_INITIALIZATION_CHECKPOINT:"+phase);Console.Out.Flush();Thread.Sleep(60000);throw new TimeoutException("Initialization worker was not terminated");}
  if(phase!=InitializationFault)return;InitializationFault=null;if(InitializationCancellation!=null){InitializationCancellation.Cancel();return;}throw new IOException("Synthetic initialization interruption: "+phase);
 }
 static void InitializationSave(){
  if(InitializationLedger==null)return;
  var pending=Records.Values.Where(r=>r.ContainsKey("backupRestore")).Select(r=>(Dictionary<string,object>)r["backupRestore"]).FirstOrDefault();var plan=pending!=null&&pending.ContainsKey("originInitialization")?(Dictionary<string,object>)pending["originInitialization"]:null;
  if(plan!=null){if(plan["storeFile"]==null&&FailInitializationReserve)throw new IOException("Synthetic reservation save failure");if(plan["storeFile"]!=null&&FailInitializationBind)throw new IOException("Synthetic binding save failure");InitializationStarted=true;}
  else if(InitializationStarted&&pending!=null&&FailInitializationComplete)throw new IOException("Synthetic completion save failure");
  InitializationLedger.Save(Records);if(plan!=null&&plan["storeFile"]==null)ObserveInitialization("reservation-saved");
 }
 static void InitRequire(bool ok,string message){if(!ok)throw new Exception(message);}
 static Exception InitFailure(Action action){try{action();}catch(Exception error){return error;}throw new Exception("Expected initialization refusal");}
 static void InitializationProcess(string root){
  ResetInitialization();UserRoot=Path.GetFullPath(root);Records.Clear();Created=Copied=Verified=OriginCommits=0;VmCapacity=16;OriginFaultPhase=null;OriginCancellation=null;CurrentOrigins=null;RejectOriginVerification=RejectFinalVerification=FailFenceSave=FailGrowthSave=FaultOnAcceptance=false;CopyFailure=null;CopyCancellation=null;HeldPartial=null;Directory.CreateDirectory(Path.Combine(root,"vms"));ExpectedDirectory=Path.Combine(root,"vms","12345678-1234-4234-8234-123456789012");
  InitializationLedger=new MuProtectedLedger(root,OwnerSid,p=>{if(!Path.GetFullPath(p).StartsWith(UserRoot+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new UnauthorizedAccessException("Initialization ledger escaped fixture root");});
 }
 static Dictionary<string,object> InitialRequest(string root,bool fresh){
  string id="12345678-1234-4234-8234-123456789012",source=Path.Combine(root,"source.bin"),seed=Path.Combine(root,"seed.iso");
  if(fresh){var data=Enumerable.Range(0,131077).Select(i=>(byte)(i%251)).ToArray();var iso=new byte[49152];Encoding.ASCII.GetBytes("CD001").CopyTo(iso,32769);File.WriteAllBytes(source,data);File.WriteAllBytes(seed,iso);
   var journal=new Dictionary<string,object>{{"diskSha256",HashFile(source)},{"diskBytes",(long)data.Length},{"seedSha256",HashFile(seed)},{"seedBytes",(long)iso.Length}};
   var record=new Dictionary<string,object>{{"id",id},{"ownerSid",OwnerSid},{"image",Path.Combine(root,"images",new string('a',64)+".vhdx")},{"imageSha256",new string('a',64)},{"cpus",1},{"memoryGiB",2},{"diskGiB",16},{"stage","allocated"},{"everReady",true},{"backupRestore",journal}};Records.Add(id,record);InitializationLedger.Save(Records);
  }else foreach(var entry in InitializationLedger.Load())Records.Add(entry.Key,entry.Value);
  var current=Records[id];var restore=(Dictionary<string,object>)current["backupRestore"];
  return new Dictionary<string,object>{{"action","backup-import"},{"id",id},{"imageSha256",current["imageSha256"]},{"cpus",current["cpus"]},{"memoryGiB",current["memoryGiB"]},{"diskGiB",current["diskGiB"]},{"disk",source},{"diskSha256",restore["diskSha256"]},{"diskBytes",restore["diskBytes"]},{"seed",seed},{"seedSha256",restore["seedSha256"]},{"seedBytes",restore["seedBytes"]}};
 }
 static Dictionary<string,object> InitIdentity(string path,bool directory){var h=CreateFile(path,0x80000081,3,IntPtr.Zero,3,directory?0x02200000U:0x00200000U,IntPtr.Zero);if(h==new IntPtr(-1))throw new IOException("Cannot pin initialization fixture object");using(var owner=new HandleOwner(h))using(var safe=new Microsoft.Win32.SafeHandles.SafeFileHandle(h,false))return MuRestoreOriginStore.CaptureIdentity(safe);}
 public static string RunInitializationFixture(string root,string scenario,string mode){
  InitializationProcess(root);var request=InitialRequest(root,mode!="Resume");string id=Convert.ToString(request["id"]),table=Path.Combine(root,"restore-origins",".lock"),directory=Path.GetDirectoryName(table);var record=Records[id];var journal=(Dictionary<string,object>)record["backupRestore"];bool denied=false,originalPending=false;
  if(mode=="Resume"){
   originalPending=journal.ContainsKey("originInitialization");InitRequire(originalPending||scenario=="initialization-completed","Original initialization witness lost");BackupImport(null,request,CancellationToken.None);
  }else if(mode=="Kill"){
   InitializationKill=scenario;BackupImport(null,request,CancellationToken.None);throw new Exception("Initialization kill checkpoint not reached");
  }else{
   switch(scenario){
    case "init-reserve-save":FailInitializationReserve=true;break;case "init-bind-save":FailInitializationBind=true;break;case "init-complete-save":FailInitializationComplete=true;break;
    case "init-bound":InitializationFault="initialization-bound";break;case "init-length":case "init-partial":case "init-unknown-data":InitializationFault="initialized-length";break;
    case "init-data":InitializationFault="frame-data";break;case "init-ready":InitializationFault="initialization-ready";break;case "init-completed":InitializationFault="initialization-completed";break;
    case "init-cancel":InitializationFault="initialized-length";InitializationCancellation=new CancellationTokenSource();break;case "init-file-replaced":case "init-file-missing":case "init-directory-missing":case "init-other-owner":InitializationFault="initialization-bound";break;
    case "init-unbound-foreign":FailInitializationBind=true;break;
    case "init-unplanned":Directory.CreateDirectory(directory);File.WriteAllBytes(table,new byte[2097152]);break;
    case "init-prior-pending":
     var prior=Json().Deserialize<Dictionary<string,object>>(Json().Serialize(record));string priorId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";prior["id"]=priorId;prior["restoreOrigin"]=true;prior["platformId"]="87654321-4321-4321-8321-210987654321";prior["stage"]="ready";Records.Add(priorId,prior);Directory.CreateDirectory(Path.Combine(root,"vms",priorId));File.WriteAllText(Path.Combine(root,"vms",priorId,"canary.txt"),"prior pending VM data");InitializationLedger.Save(Records);break;
    case "init-populated-plan":
     record["restoreOrigin"]=true;using(var store=OpenOriginStore(true))using(var disk=File.OpenRead(Path.Combine(root,"source.bin")))using(var seed=File.OpenRead(Path.Combine(root,"seed.iso"))){
      var proof=new Dictionary<string,object>{{"format",1},{"kind","standalone-backup-origin"},{"ownerSid",OwnerSid},{"id",id},{"platformId","87654321-4321-4321-8321-210987654321"},{"imageSha256",request["imageSha256"]},{"importDiskSha256",request["diskSha256"]},{"importDiskBytes",disk.Length},{"importSeedSha256",request["seedSha256"]},{"importSeedBytes",seed.Length},{"rootFile",store.RootIdentity},{"diskFile",MuRestoreOriginStore.CaptureIdentity(disk.SafeFileHandle)},{"seedFile",MuRestoreOriginStore.CaptureIdentity(seed.SafeFileHandle)},{"seedSha256",request["seedSha256"]},{"cpus",1},{"memoryGiB",2},{"diskGiB",16}};store.PublishInitial(proof,id,Convert.ToString(proof["platformId"]));
     }
     var tableBytes=File.ReadAllBytes(table);var plan=new Dictionary<string,object>{{"version",1},{"epoch",new Guid(tableBytes.Skip(56).Take(16).ToArray()).ToString("D")},{"rootFile",OriginRootIdentity()},{"directoryFile",InitIdentity(directory,true)},{"storeFile",InitIdentity(table,false)}};journal["originInitialization"]=plan;InitializationLedger.Save(Records);break;
    default:throw new ArgumentException("Unknown initialization fixture");
   }
   byte[] before=scenario=="init-unplanned"||scenario=="init-populated-plan"?File.ReadAllBytes(table):null;
   var first=InitFailure(()=>BackupImport(null,request,InitializationCancellation==null?CancellationToken.None:InitializationCancellation.Token));InitRequire(Created==0&&Copied==0&&record.ContainsKey("backupRestore"),"Initialization failure materialized or unfenced an allocation");originalPending=journal.ContainsKey("originInitialization");
   if(scenario=="init-prior-pending"){InitRequire(first is MuStorageException&&((MuStorageException)first).Code=="RESTORE_ORIGIN_PREPARING"&&!Directory.Exists(directory)&&!originalPending&&File.ReadAllText(Path.Combine(root,"vms","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","canary.txt"))=="prior pending VM data","Missing prior pending origin table was recreated");return Json().Serialize(new{complete=true,scenario=scenario,denied=true,realDuplicateLedger=true,actualBackupImport=true,realHyperV=false,trustedAclPublication=false});}
   if(scenario=="init-reserve-save")InitRequire(!Directory.Exists(directory)&&!originalPending,"Failed reservation created metadata");
   if(scenario=="init-bind-save"||scenario=="init-unbound-foreign")InitRequire(new FileInfo(table).Length==0&&((Dictionary<string,object>)journal["originInitialization"])["storeFile"]==null,"Data written before binding was durable");
   if(scenario=="init-cancel")InitRequire(first is OperationCanceledException,"Initialization cancellation lost");
   InitializationFault=null;FailInitializationReserve=FailInitializationBind=FailInitializationComplete=false;if(InitializationCancellation!=null){InitializationCancellation.Dispose();InitializationCancellation=null;}
   if(scenario=="init-partial")using(var stream=new FileStream(table,FileMode.Open,FileAccess.Write,FileShare.None))stream.SetLength(8192);
   if(scenario=="init-unknown-data"){var changed=File.ReadAllBytes(table);changed[200]=255;File.WriteAllBytes(table,changed);}
   if(scenario=="init-file-replaced"){File.Move(table,Path.Combine(root,"original-table.retained"));File.WriteAllBytes(table,new byte[0]);}
   if(scenario=="init-file-missing"||scenario=="init-directory-missing"){
    File.Move(table,Path.Combine(root,"original-table.retained"));if(scenario=="init-directory-missing")Directory.Delete(directory);InitFailure(()=>BackupImport(null,request,CancellationToken.None));InitRequire(!File.Exists(table)&&(scenario!="init-directory-missing"||!Directory.Exists(directory))&&Created==0&&Copied==0,"Missing bound preparation was recreated");return Json().Serialize(new{complete=true,scenario=scenario,denied=true,realDuplicateLedger=true,actualBackupImport=true,realHyperV=false,trustedAclPublication=false});
   }
   if(scenario=="init-unbound-foreign")File.WriteAllText(table,"unclaimed bytes");
   denied=new[]{"init-unknown-data","init-file-replaced","init-unbound-foreign","init-unplanned","init-populated-plan"}.Contains(scenario);
   if(denied){before=File.ReadAllBytes(table);InitFailure(()=>BackupImport(null,request,CancellationToken.None));InitRequire(before.SequenceEqual(File.ReadAllBytes(table))&&Created==0&&Copied==0&&record.ContainsKey("backupRestore"),"Unsafe initialization retry changed data");return Json().Serialize(new{complete=true,scenario=scenario,denied=true,realDuplicateLedger=true,actualBackupImport=true,realHyperV=false,trustedAclPublication=false});}
   if(scenario=="init-other-owner"){
    string other="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";var sibling=Json().Deserialize<Dictionary<string,object>>(Json().Serialize(record));sibling["id"]=other;((Dictionary<string,object>)sibling["backupRestore"]).Remove("originInitialization");Records.Add(other,sibling);InitializationLedger.Save(Records);var second=new Dictionary<string,object>(request);second["id"]=other;before=File.ReadAllBytes(table);var error=InitFailure(()=>BackupImport(null,second,CancellationToken.None));InitRequire(error is MuStorageException&&((MuStorageException)error).Code=="RESTORE_ORIGIN_PREPARING"&&before.SequenceEqual(File.ReadAllBytes(table)),"Another restore took over the preparation");Records.Remove(other);InitializationLedger.Save(Records);
   }
   // Reload the actual duplicate ledger, rather than trusting in-memory flags.
   Records.Clear();InitializationLedger=new MuProtectedLedger(root,OwnerSid,p=>{});foreach(var entry in InitializationLedger.Load())Records.Add(entry.Key,entry.Value);record=Records[id];BackupImport(null,request,CancellationToken.None);
  }
  record=Records[id];InitRequire(Created==1&&Copied==2&&!record.ContainsKey("backupRestore")&&HashFile(Path.Combine(ExpectedDirectory,"disk.vhdx"))==Convert.ToString(request["diskSha256"]),"Initialization retry did not settle the original restore");using(var store=OpenOriginStore())store.ReadAcceptedSnapshot(id,Convert.ToString(record["platformId"]));var reloaded=new MuProtectedLedger(root,OwnerSid,p=>{}).Load();InitRequire(!reloaded[id].ContainsKey("backupRestore"),"Final duplicate ledger retained preparation");
  return Json().Serialize(new{complete=true,scenario=scenario,mode=mode,denied=false,created=Created,copied=Copied,realDuplicateLedger=true,actualBackupImport=true,originalWitnessSurvived=originalPending,realHyperV=false,trustedAclPublication=false});
 }
}
