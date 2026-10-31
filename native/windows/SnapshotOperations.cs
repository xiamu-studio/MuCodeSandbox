// Owner-bound, stopped full-copy snapshots. The durable core journal fences all
// ordinary mutations until the ordinary controller has replayed configuration.
public static partial class MuHyperVBroker {
    private static readonly Dictionary<string,CancellationTokenSource> SnapshotLiveDeletes=new Dictionary<string,CancellationTokenSource>();
    private static void SnapshotLiveAdmission(string id,string action,Dictionary<string,object> request){
        CancellationTokenSource active;lock(Gate){if(!SnapshotLiveDeletes.TryGetValue(id,out active))return;}
            // These paths never wait for the snapshot operation lock. Stop is
            // independent of snapshot hashing and also retires this request.
            if(action=="stop"||action=="close-channel"){ValidateKeys(request,"action","id");try{active.Cancel();}catch(ObjectDisposedException){}return;}
            if(new[]{"allocation","status","inspect","channel"}.Contains(action))return;
            throw new MuStorageException("SNAPSHOT_BUSY","An independent snapshot copy is being deleted; VM inspection and stop remain available");
    }
    private static void SnapshotLiveAuthority(string id,Dictionary<string,object> original,string binding,CancellationToken cancellation){
        cancellation.ThrowIfCancellationRequested();
        lock(VmGate(id)){
            var current=Owned(id);if(!object.ReferenceEquals(current,original)||Json().Serialize(current)!=binding)throw new UnauthorizedAccessException("Snapshot deletion allocation authority changed");
            CheckPower();if(ResourceIssue!=null)throw new MuStorageException("RESOURCE_FENCED","Host resource protection cancelled snapshot deletion");
            CheckBackupBusy(id,"snapshot-delete");RestorePending(id,"snapshot-delete");SnapshotPending(id,"snapshot-delete");cancellation.ThrowIfCancellationRequested();
        }
    }
    private static object SnapshotLiveDeletion(Dictionary<string,object> request,CancellationToken cancellation){
        ValidateKeys(request,"action","id","snapshotId","name","resumeOnly","allowRunning");
        if(!request.ContainsKey("allowRunning")||!(request["allowRunning"] is bool)||!(bool)request["allowRunning"]||!request.ContainsKey("resumeOnly")||!(request["resumeOnly"] is bool))throw new ArgumentException("Explicit independent snapshot deletion mode required");
        string id=Id(request),snapshotId=Id(new Dictionary<string,object>{{"id",Text(request,"snapshotId",36)}}),name=Text(request,"name",60);
        using(var cancel=CancellationTokenSource.CreateLinkedTokenSource(cancellation,Closing.Token,PowerCancellation.Token,ResourceCancellation.Token)){
            Dictionary<string,object> original,record;string binding;
            lock(VmGate(id)){
                SnapshotLiveAdmission(id,"snapshot-delete",request);CheckPower();if(ResourceIssue!=null)throw new MuStorageException("RESOURCE_FENCED","Host resource protection has closed this session");
                if(HostServicingBusy())throw new InvalidOperationException("Windows component servicing is running");
                CheckBackupBusy(id,"snapshot-delete");RestorePending(id,"snapshot-delete");SnapshotPending(id,"snapshot-delete");
                original=Owned(id);
                if(Convert.ToString(original["stage"])!="ready"||!original.ContainsKey("platformId")||original.ContainsKey("baseBuilder")||original.ContainsKey("baseSealedDigest")||original.ContainsKey("backupRestore")||GrowthJournal(original)!=null)throw new UnauthorizedAccessException("Only a complete work environment can delete an independent snapshot copy");
                binding=Json().Serialize(original);record=Json().Deserialize<Dictionary<string,object>>(binding);cancel.Token.ThrowIfCancellationRequested();
                lock(Gate)SnapshotLiveDeletes.Add(id,cancel);
            }
            try{
                Action review=()=>{
                    SnapshotLiveAuthority(id,original,binding,cancel.Token);
                    var parameters=Parameters(record);parameters["snapshotId"]=snapshotId;
                    // Provider inventory and large file hashing run outside
                    // VmGate and ImportGate. Emergency stop never joins them.
                    var actual=Json().Deserialize<Dictionary<string,object>>(Invoke("review-snapshot-delete",parameters,60000,cancel.Token));
                    ValidateKeys(actual,"platformId","snapshotId","state","cpus","memoryGiB","diskGiB","unreferenced");
                    if(Convert.ToString(actual["platformId"])!=Convert.ToString(record["platformId"])||Convert.ToString(actual["snapshotId"])!=snapshotId||!(actual["unreferenced"] is bool)||!(bool)actual["unreferenced"]||!new[]{"Running","Off"}.Contains(Convert.ToString(actual["state"])))throw new UnauthorizedAccessException("Snapshot deletion dependency receipt changed");
                    foreach(string key in new[]{"cpus","memoryGiB","diskGiB"})if(Convert.ToInt64(actual[key])!=Convert.ToInt64(record[key]))throw new UnauthorizedAccessException("Snapshot deletion resource registration changed");
                    SnapshotLiveAuthority(id,original,binding,cancel.Token);
                };
                using(SnapshotPin(record)){
                    var store=SnapshotDeletionStore(record,review);
                    return store.Delete(snapshotId,name,SnapshotDeleteAuthority(record),(bool)request["resumeOnly"],snapshot=>{SnapshotEnvelope(record,snapshot.configuration,true);},cancel.Token);
                }
            }finally{lock(Gate){CancellationTokenSource active;if(SnapshotLiveDeletes.TryGetValue(id,out active)&&object.ReferenceEquals(active,cancel))SnapshotLiveDeletes.Remove(id);}}
        }
    }
    private static MuOfflineSnapshotStore SnapshotDeletionStore(Dictionary<string,object> record,Action review){
        string id=Id(record),directory=Convert.ToString(Parameters(record)["directory"]);var vmSid=(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",Convert.ToString(record["platformId"])).Translate(typeof(SecurityIdentifier));
        // Deletion never reads the current disk or management seed. Snapshot
        // files retain the administrator-only ACL policy. Capacity reservation
        // is impossible in this lane. Creation/restoration never use this store.
        return new MuOfflineSnapshotStore(directory,id,p=>{if(string.Equals(p,directory,StringComparison.OrdinalIgnoreCase))RecoveryAcl(p,vmSid,true);else PrivateDirectory(p,false);},p=>RecoveryFile(p),bytes=>{throw new InvalidOperationException("Snapshot deletion cannot reserve disk capacity");},review,null);
    }
    private static MuStorageException SnapshotCoordinatorBusy(){return new MuStorageException("SNAPSHOT_BUSY","The snapshot controller is still active or cannot be verified; close its application before recovery");}
    private static string SnapshotCoordinator(Dictionary<string,object> record){
        if(Owner==null||Owner.HasExited)throw SnapshotCoordinatorBusy();
        return Json().Serialize(new Dictionary<string,object>{{"version",1},{"id",record["id"]},{"ownerSid",OwnerSid},{"pid",Owner.Id},{"startedUtcTicks",Owner.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture)}});
    }
    private static void SnapshotCoordinatorGuard(Dictionary<string,object> record,MuOfflineSnapshotStore.Restore journal,bool recovery){
        if(journal.coordinator==null){if(recovery)return;throw new MuStorageException("SNAPSHOT_PENDING","Legacy snapshot transactions require explicit recovery before acknowledgement");}
        if(string.IsNullOrWhiteSpace(journal.coordinator)||Encoding.UTF8.GetByteCount(journal.coordinator)>4096)throw new UnauthorizedAccessException("Snapshot coordinator is invalid");
        var actor=Json().DeserializeObject(journal.coordinator) as Dictionary<string,object>;if(actor==null)throw new UnauthorizedAccessException("Snapshot coordinator is invalid");ValidateKeys(actor,"version","id","ownerSid","pid","startedUtcTicks");
        if(Number(actor,"version",1,1)!=1||Id(actor)!=Convert.ToString(record["id"])||Text(actor,"ownerSid",184)!=OwnerSid)throw new UnauthorizedAccessException("Snapshot coordinator allocation changed");
        int pid=Number(actor,"pid",1,int.MaxValue);string ticks=Text(actor,"startedUtcTicks",19);long started;
        if(!long.TryParse(ticks,System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out started)||started<1||started>DateTime.MaxValue.Ticks||started.ToString(System.Globalization.CultureInfo.InvariantCulture)!=ticks)throw new UnauthorizedAccessException("Snapshot coordinator process identity changed");
        if(Owner==null||Owner.HasExited)throw SnapshotCoordinatorBusy();
        if(pid==Owner.Id&&started==Owner.StartTime.ToUniversalTime().Ticks)return;
        // A different controller never commits a transaction. Recovery first
        // adopts the durable journal and then follows its persisted decision.
        if(!recovery)throw SnapshotCoordinatorBusy();
        try{using(var previous=Process.GetProcessById(pid)){if(previous.HasExited)return;if(previous.StartTime.ToUniversalTime().Ticks!=started)return;}}
        catch(ArgumentException){return;} // The original process no longer exists.
        catch(Exception){throw SnapshotCoordinatorBusy();} // Unknown is not exited.
        throw SnapshotCoordinatorBusy();
    }
    private static string SnapshotDirectory(Dictionary<string,object> record){return Path.Combine(Convert.ToString(Parameters(record)["directory"]),"snapshots");}
    private static string SnapshotDeleteAuthority(Dictionary<string,object> record){
        if(string.IsNullOrWhiteSpace(OwnerSid))throw new UnauthorizedAccessException("Snapshot deletion owner is missing");
        string id=Id(record),vm=Id(new Dictionary<string,object>{{"id",Text(record,"platformId",36)}});
        using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes("MuCodeSandbox snapshot deletion v1\0"+OwnerSid+"\0"+id+"\0"+vm))).Replace("-","").ToLowerInvariant();
    }
    private static bool SnapshotIsPending(Dictionary<string,object> record){return HasStorage(Path.Combine(SnapshotDirectory(record),"restore-active"));}
    private static void SnapshotPending(string id,string action){
        if(new[]{"snapshot-list","snapshot-staging","snapshot-deletions","snapshot-status","snapshot-outcome","snapshot-recover","snapshot-commit","snapshot-acknowledge","snapshot-seed","disk-compact-status","allocation","status","stop","recover","inspect","close-channel"}.Contains(action))return;
        lock(Gate){Dictionary<string,object> record;if(Records.TryGetValue(id,out record)&&SnapshotIsPending(record))throw new MuStorageException("SNAPSHOT_PENDING","Finish configuration replay or recover the pending snapshot before changing this environment");}
    }
    private static string SnapshotCipher(Dictionary<string,object> request,string field){
        string value=Text(request,field,512*1024);if(!value.StartsWith("enc:",StringComparison.Ordinal))throw new ArgumentException("Owner encrypted snapshot configuration required");
        byte[] bytes;try{bytes=Convert.FromBase64String(value.Substring(4));}catch(FormatException){throw new ArgumentException("Snapshot configuration encoding changed");}
        try{if(bytes.Length<=28||Convert.ToBase64String(bytes)!=value.Substring(4))throw new ArgumentException("Canonical encrypted configuration required");}finally{Array.Clear(bytes,0,bytes.Length);}return value;
    }
    private static Dictionary<string,object> SnapshotEnvelope(Dictionary<string,object> record,string cipher){
        return new Dictionary<string,object>{{"version",1},{"id",record["id"]},{"ownerSid",OwnerSid},{"platformId",record["platformId"]},{"imageSha256",record["imageSha256"]},{"imageExtension",Path.GetExtension(Convert.ToString(record["image"])).ToLowerInvariant()},{"sealed",record.ContainsKey("sealedSource")},{"cpus",record["cpus"]},{"memoryGiB",record["memoryGiB"]},{"diskGiB",record["diskGiB"]},{"ownerConfiguration",cipher}};
    }
    private static Dictionary<string,object> SnapshotEnvelope(Dictionary<string,object> record,string serialized,bool parse){
        var value=Json().Deserialize<Dictionary<string,object>>(serialized);ValidateKeys(value,"version","id","ownerSid","platformId","imageSha256","imageExtension","sealed","cpus","memoryGiB","diskGiB","ownerConfiguration");
        if(Number(value,"version",1,1)!=1||Id(value)!=Convert.ToString(record["id"])||Text(value,"ownerSid",184)!=OwnerSid||Id(new Dictionary<string,object>{{"id",Text(value,"platformId",36)}})!=Convert.ToString(record["platformId"]))throw new UnauthorizedAccessException("Snapshot allocation identity changed");
        Digest(value,"imageSha256");string extension=Text(value,"imageExtension",5);if(extension!=".vhd"&&extension!=".vhdx"||!value.ContainsKey("sealed")||!(value["sealed"] is bool)||(bool)value["sealed"]&&extension!=".vhdx")throw new UnauthorizedAccessException("Snapshot image authority changed");
        Number(value,"cpus",1,Math.Min(16,Environment.ProcessorCount));Number(value,"memoryGiB",2,32);Number(value,"diskGiB",16,256);SnapshotCipher(value,"ownerConfiguration");return value;
    }
    private static object SnapshotDescriptor(Dictionary<string,object> record,MuOfflineSnapshotStore.Snapshot snapshot){
        var envelope=SnapshotEnvelope(record,snapshot.configuration,true);return new {id=snapshot.id,environmentId=snapshot.environmentId,name=snapshot.name,createdAt=snapshot.createdAt,bytes=snapshot.files.Sum(f=>f.bytes),seedSha256=snapshot.files.Single(f=>f.key=="seed").sha256,cpus=envelope["cpus"],memoryGiB=envelope["memoryGiB"],diskGiB=envelope["diskGiB"],imageSha256=envelope["imageSha256"]};
    }
    private static void SnapshotOwnerResources(Dictionary<string,object> record,Dictionary<string,object> request){
        foreach(string key in new[]{"cpus","memoryGiB","diskGiB"}){int value=Number(request,key,key=="cpus"?1:key=="memoryGiB"?2:16,key=="cpus"?16:key=="memoryGiB"?32:256);if(value!=Convert.ToInt32(record[key]))throw new UnauthorizedAccessException("Snapshot owner configuration differs from protected resources");}
        if(Digest(request,"imageSha256")!=Convert.ToString(record["imageSha256"]))throw new UnauthorizedAccessException("Snapshot owner base identity changed");
    }
    private static void SnapshotOwnerSeed(Dictionary<string,object> record,string digest,CancellationToken cancellation){
        var vmSid=(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",Convert.ToString(record["platformId"])).Translate(typeof(SecurityIdentifier));using(var seed=RecoveryFile(Convert.ToString(Parameters(record)["seed"]),vmSid)){if(seed.Length<32774||seed.Length>8*1024*1024||RecoveryHash(seed,cancellation)!=digest)throw new UnauthorizedAccessException("Snapshot owner seed differs from the protected original");seed.Position=32769;var signature=new byte[5];if(seed.Read(signature,0,5)!=5||Encoding.ASCII.GetString(signature)!="CD001")throw new UnauthorizedAccessException("Snapshot original ISO signature changed");}
    }
    private static void SnapshotRegisteredResources(Dictionary<string,object> record,Dictionary<string,object> envelope){
        foreach(string key in new[]{"cpus","memoryGiB","diskGiB","imageSha256"})if(Convert.ToString(envelope[key])!=Convert.ToString(record[key]))throw new UnauthorizedAccessException("Snapshot resource registration has not been replayed");
        if(!string.Equals(Convert.ToString(record["image"]),Path.Combine(UserRoot,"images",Convert.ToString(envelope["imageSha256"])+Convert.ToString(envelope["imageExtension"])),StringComparison.OrdinalIgnoreCase)||record.ContainsKey("sealedSource")!=(bool)envelope["sealed"]||(bool)envelope["sealed"]&&Convert.ToString(record["sealedSource"])!="mu-base:"+envelope["imageSha256"])throw new UnauthorizedAccessException("Snapshot protected image authority has not been replayed");
    }
    private static void SnapshotReviewCurrent(Dictionary<string,object> record,CancellationToken cancellation){
        if(Convert.ToString(record["stage"])!="ready"||!record.ContainsKey("platformId")||record.ContainsKey("baseBuilder")||record.ContainsKey("baseSealedDigest")||record.ContainsKey("backupRestore")||GrowthJournal(record)!=null)throw new UnauthorizedAccessException("Only a complete work environment can use snapshots");
        GrowthFacts(record,cancellation);var actual=Json().Deserialize<Dictionary<string,object>>(Invoke("review-allocation",Parameters(record),60000,cancellation));
        foreach(string key in new[]{"cpus","memoryGiB","diskGiB"})if(Convert.ToInt64(actual[key])!=Convert.ToInt64(record[key]))throw new UnauthorizedAccessException("Snapshot resources differ from protected registration");
    }
    private static IDisposable SnapshotPin(Dictionary<string,object> record){
        string directory=Convert.ToString(Parameters(record)["directory"]);var vmSid=(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",Convert.ToString(record["platformId"])).Translate(typeof(SecurityIdentifier));RecoveryAcl(directory,vmSid,true);
        var handle=CreateFile(directory,0x80000000,3,IntPtr.Zero,3,0x02000000|0x00200000,IntPtr.Zero);if(handle==new IntPtr(-1))throw new IOException("Cannot pin the snapshot allocation");return new HandleOwner(handle);
    }
    private static MuOfflineSnapshotStore SnapshotStore(Dictionary<string,object> record,CancellationToken cancellation,long extraReservation=0){
        string directory=Convert.ToString(Parameters(record)["directory"]);var vmSid=(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",Convert.ToString(record["platformId"])).Translate(typeof(SecurityIdentifier));
        string active=Path.Combine(directory,"snapshots","restore-active");
        return new MuOfflineSnapshotStore(directory,Convert.ToString(record["id"]),p=>{if(string.Equals(p,directory,StringComparison.OrdinalIgnoreCase))RecoveryAcl(p,vmSid,true);else PrivateDirectory(p,false);},p=>{bool original=string.Equals(p,Path.Combine(directory,"disk.vhdx"),StringComparison.OrdinalIgnoreCase)||string.Equals(p,Path.Combine(directory,"seed.iso"),StringComparison.OrdinalIgnoreCase);string file=Path.GetFileName(p);bool rollback=string.Equals(Path.GetDirectoryName(p),active,StringComparison.OrdinalIgnoreCase)&&(file=="disk.rollback"||file=="seed.rollback"||System.Text.RegularExpressions.Regex.IsMatch(file,@"^(disk|seed)\.discarded-[a-f0-9]{32}$"));return RecoveryFile(p,original||rollback?vmSid:null);},bytes=>CheckDiskRequest(checked(bytes+extraReservation),cancellation),()=>{cancellation.ThrowIfCancellationRequested();var actual=Json().Deserialize<Dictionary<string,object>>(Invoke("review-allocation",Parameters(record),60000,cancellation));if(Convert.ToString(actual["platformId"])!=Convert.ToString(record["platformId"]))throw new UnauthorizedAccessException("Snapshot stopped VM identity changed");},null,SnapshotStagingStore(record));
    }
    private static MuSnapshotStaging SnapshotStagingStore(Dictionary<string,object> record){
        return new MuSnapshotStaging(Convert.ToString(Parameters(record)["directory"]),Convert.ToString(record["id"]),SnapshotDeleteAuthority(record),ValidateStagingPath,null,StagingCreationSecurity);
    }
    // Provider inventory runs outside VmGate/ImportGate. Stop and owner/power
    // revocation cancel this request without joining the inventory operation.
    private static object SnapshotStagingAction(string action,Dictionary<string,object> request,CancellationToken cancellation){
        bool cleanup=action=="snapshot-staging-cleanup";
        if(cleanup)ValidateKeys(request,"action","id","copyId","operation","token","resumeOnly");else ValidateKeys(request,"action","id","copyId","operation");
        string id=Id(request),copyId=Id(new Dictionary<string,object>{{"id",Text(request,"copyId",36)}}),operation=Text(request,"operation",7);if(operation!="create"&&operation!="restore")throw new ArgumentException("Fixed staging operation required");
        if(cleanup&&(!request.ContainsKey("resumeOnly")||!(request["resumeOnly"] is bool)))throw new ArgumentException("Explicit staging retry mode required");string token=cleanup?Digest(request,"token"):null;
        using(var cancel=CancellationTokenSource.CreateLinkedTokenSource(cancellation,Closing.Token,PowerCancellation.Token)){
            Dictionary<string,object> original,record;string binding;
            lock(VmGate(id)){
                SnapshotLiveAdmission(id,action,request);CheckPower();if(HostServicingBusy())throw new InvalidOperationException("Windows component servicing is running");CheckBackupBusy(id,action);RestorePending(id,action);SnapshotPending(id,action);
                original=Owned(id);if(Convert.ToString(original["stage"])!="ready"||!original.ContainsKey("platformId")||original.ContainsKey("baseBuilder")||original.ContainsKey("baseSealedDigest")||original.ContainsKey("backupRestore")||GrowthJournal(original)!=null)throw new UnauthorizedAccessException("Complete environment authority required for staging cleanup");
                binding=Json().Serialize(original);record=Json().Deserialize<Dictionary<string,object>>(binding);cancel.Token.ThrowIfCancellationRequested();lock(Gate)SnapshotLiveDeletes.Add(id,cancel);
            }
            try{
                Action authority=()=>{cancel.Token.ThrowIfCancellationRequested();lock(VmGate(id)){var current=Owned(id);if(!object.ReferenceEquals(current,original)||Json().Serialize(current)!=binding)throw new UnauthorizedAccessException("Staging allocation authority changed");CheckPower();CheckBackupBusy(id,action);RestorePending(id,action);SnapshotPending(id,action);}};
                Action stopped=()=>{authority();var actual=Json().Deserialize<Dictionary<string,object>>(Invoke("review-allocation",Parameters(record),60000,cancel.Token));if(Convert.ToString(actual["platformId"])!=Convert.ToString(record["platformId"]))throw new UnauthorizedAccessException("Staging stopped VM identity changed");authority();};
                using(SnapshotPin(record)){
                    var store=SnapshotStore(record,cancel.Token);var journal=store.Pending();if(journal!=null)throw new MuStorageException("SNAPSHOT_PENDING","Resolve the pending restore before staging cleanup");
                    using(store.AcquireStaging()){
                    var factory=SnapshotStagingStore(record);stopped();
                    Action unreferenced=()=>{
                        stopped();var parameters=Parameters(record);parameters["snapshotId"]=copyId;parameters["stagingOperation"]=operation;
                        var receipt=Json().Deserialize<Dictionary<string,object>>(Invoke("review-snapshot-staging",parameters,60000,cancel.Token));ValidateKeys(receipt,"platformId","snapshotId","state","cpus","memoryGiB","diskGiB","unreferenced");
                        if(Convert.ToString(receipt["platformId"])!=Convert.ToString(record["platformId"])||Convert.ToString(receipt["snapshotId"])!=copyId||Convert.ToString(receipt["state"])!="Off"||!(receipt["unreferenced"] is bool)||!(bool)receipt["unreferenced"])throw new UnauthorizedAccessException("Staging dependency receipt changed");authority();
                        if(Number(receipt,"cpus",1,16)!=Number(record,"cpus",1,16)||Number(receipt,"memoryGiB",2,32)!=Number(record,"memoryGiB",2,32)||Number(receipt,"diskGiB",16,256)!=Number(record,"diskGiB",16,256))throw new UnauthorizedAccessException("Staging dependency resources changed");
                    };
                    if(!cleanup)return factory.Inspect(copyId,operation,cancel.Token,unreferenced);
                    // The first callback holds every candidate file against
                    // writes/attachment; repeat inventory for each disposition.
                    return factory.Cleanup(copyId,operation,token,(bool)request["resumeOnly"],unreferenced,cancel.Token);
                    }
                }
            }finally{lock(Gate){CancellationTokenSource current;if(SnapshotLiveDeletes.TryGetValue(id,out current)&&object.ReferenceEquals(current,cancel))SnapshotLiveDeletes.Remove(id);}}
        }
    }
    private static void SnapshotSealRollback(Dictionary<string,object> record){
        string active=Path.Combine(SnapshotDirectory(record),"restore-active");if(!HasStorage(active))return;PrivateDirectory(active,false);var vmSid=(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",Convert.ToString(record["platformId"])).Translate(typeof(SecurityIdentifier));
        foreach(string file in Directory.EnumerateFiles(active)){
            string name=Path.GetFileName(file);if(name!="disk.rollback"&&name!="seed.rollback"&&!System.Text.RegularExpressions.Regex.IsMatch(name,@"^(disk|seed)\.discarded-[a-f0-9]{32}$"))continue;
            using(var verified=RecoveryFile(file,vmSid)){}var acl=new FileSecurity();acl.SetAccessRuleProtection(true,false);acl.SetOwner(AdminSid);foreach(var sid in new[]{AdminSid,SystemSid})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));File.SetAccessControl(file,acl);ValidateLedgerFile(file);
        }
    }
    private static void SnapshotApplyResources(Dictionary<string,object> record,Dictionary<string,object> envelope){
        long total;lock(Gate)total=Records.Values.Where(v=>Convert.ToString(v["id"])!=Convert.ToString(record["id"])).Sum(v=>Convert.ToInt64(v["diskGiB"]));MuResourcePolicy.Quota(total,Convert.ToInt64(envelope["diskGiB"]));
        var metrics=MuResourceMetrics.Read(UserRoot);MuResourcePolicy.MemoryRequest(metrics.totalMemory,metrics.totalMemory,Convert.ToInt64(envelope["memoryGiB"])*MuResourcePolicy.GiB);
        var parameters=Parameters(record);var vmSid=(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",Convert.ToString(record["platformId"])).Translate(typeof(SecurityIdentifier));
        foreach(string key in new[]{"disk","seed"}){string file=Convert.ToString(parameters[key]);using(var input=RecoveryFile(file,vmSid)){}var acl=File.GetAccessControl(file);acl.SetAccessRule(new FileSystemAccessRule(vmSid,FileSystemRights.FullControl,AccessControlType.Allow));File.SetAccessControl(file,acl);RecoveryAcl(file,vmSid,false);}
        foreach(string key in new[]{"cpus","memoryGiB","diskGiB"})parameters[key]=envelope[key];
        var result=Json().Deserialize<Dictionary<string,object>>(Invoke("snapshot-apply",parameters,60000,CancellationToken.None));foreach(string key in new[]{"cpus","memoryGiB","diskGiB"})if(Convert.ToInt64(result[key])!=Convert.ToInt64(envelope[key]))throw new IOException("Snapshot VM resources were not confirmed");
        lock(Gate){foreach(string key in new[]{"cpus","memoryGiB","diskGiB","imageSha256"})record[key]=envelope[key];record["image"]=Path.Combine(UserRoot,"images",Convert.ToString(envelope["imageSha256"])+Convert.ToString(envelope["imageExtension"]));if((bool)envelope["sealed"])record["sealedSource"]="mu-base:"+envelope["imageSha256"];else record.Remove("sealedSource");Save();}
        SnapshotReviewCurrent(record,CancellationToken.None);
    }
    private static object SnapshotRestoreReceipt(Dictionary<string,object> record,MuOfflineSnapshotStore.Restore journal){
        var envelope=SnapshotEnvelope(record,journal.phase=="rolled-back"?journal.previousConfiguration:journal.configuration,true);
        return new {pending=true,id=record["id"],platformId=record["platformId"],transactionId=journal.id,snapshotId=journal.snapshotId,phase=journal.phase,ownerConfiguration=envelope["ownerConfiguration"],cpus=envelope["cpus"],memoryGiB=envelope["memoryGiB"],diskGiB=envelope["diskGiB"],imageSha256=envelope["imageSha256"],seedBytes=(journal.phase=="rolled-back"?journal.previous:journal.files).Single(f=>f.key=="seed").bytes,seedSha256=(journal.phase=="rolled-back"?journal.previous:journal.files).Single(f=>f.key=="seed").sha256};
    }
    private static object SnapshotOutcomeReceipt(Dictionary<string,object> record,MuOfflineSnapshotStore.Restore journal){
        if(!new[]{"committed","rolled-back"}.Contains(journal.phase))throw new MuStorageException("SNAPSHOT_PENDING","An acknowledged snapshot decision is required");
        var envelope=SnapshotEnvelope(record,journal.phase=="rolled-back"?journal.previousConfiguration:journal.configuration,true);string digest;using(var sha=SHA256.Create())digest=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Convert.ToString(envelope["ownerConfiguration"])))).Replace("-","").ToLowerInvariant();
        var seed=(journal.phase=="rolled-back"?journal.previous:journal.files).Single(f=>f.key=="seed");
        return new {acknowledged=true,id=record["id"],platformId=record["platformId"],transactionId=journal.id,snapshotId=journal.snapshotId,phase=journal.phase,ownerConfigurationSha256=digest,cpus=envelope["cpus"],memoryGiB=envelope["memoryGiB"],diskGiB=envelope["diskGiB"],imageSha256=envelope["imageSha256"],seedBytes=seed.bytes,seedSha256=seed.sha256};
    }
    private static object SnapshotAction(string action,Dictionary<string,object> request,CancellationToken cancellation){
        string id=Id(request);var record=Owned(id);if(!record.ContainsKey("platformId")||Convert.ToString(record["stage"])!="ready")throw new MuStorageException("SNAPSHOT_UNAVAILABLE","An intact created work environment is required");
        using(SnapshotPin(record)){
            if(action=="snapshot-list"){ValidateKeys(request,"action","id");return SnapshotStore(record,cancellation).List().Select(v=>SnapshotDescriptor(record,v)).ToArray();}
            if(action=="snapshot-staging"){ValidateKeys(request,"action","id");return SnapshotStore(record,cancellation).Staging();}
            if(action=="snapshot-deletions"){ValidateKeys(request,"action","id");return SnapshotStore(record,cancellation).PendingDeletions(SnapshotDeleteAuthority(record));}
            if(action=="snapshot-status"){ValidateKeys(request,"action","id");var pending=SnapshotStore(record,cancellation).Pending();return pending==null?(object)new {pending=false}:SnapshotRestoreReceipt(record,pending);}
            if(action=="snapshot-outcome"){ValidateKeys(request,"action","id","transactionId");string transaction=Id(new Dictionary<string,object>{{"id",Text(request,"transactionId",36)}});return SnapshotOutcomeReceipt(record,SnapshotStore(record,cancellation).History(transaction));}
            if(action=="snapshot-seed"){
                ValidateKeys(request,"action","id","transactionId","offset");string transaction=Id(new Dictionary<string,object>{{"id",Text(request,"transactionId",36)}});var journal=SnapshotStore(record,cancellation).Pending();if(journal==null||journal.id!=transaction||!new[]{"applied","committed","rolled-back"}.Contains(journal.phase))throw new MuStorageException("SNAPSHOT_PENDING","Snapshot seed requires the exact reconciled restore transaction");
                var expected=(journal.phase=="rolled-back"?journal.previous:journal.files).Single(f=>f.key=="seed");long offset=Number(request,"offset",0,8*1024*1024);if(offset>=expected.bytes)throw new ArgumentException("Snapshot seed offset changed");var vmSid=(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",Convert.ToString(record["platformId"])).Translate(typeof(SecurityIdentifier));
                using(var input=RecoveryFile(Convert.ToString(Parameters(record)["seed"]),vmSid)){if(input.Length!=expected.bytes)throw new IOException("Snapshot seed length changed");input.Position=offset;var data=new byte[(int)Math.Min(32768,expected.bytes-offset)];int done=0,n;while(done<data.Length&&(n=input.Read(data,done,data.Length-done))>0)done+=n;if(done!=data.Length)throw new IOException("Snapshot seed incomplete");return new {data=Convert.ToBase64String(data),nextOffset=offset+done,done=offset+done==expected.bytes};}
            }
            if((action=="snapshot-create"||action=="snapshot-prepare")&&SnapshotStore(record,cancellation).Staging().entries.Length!=0)throw new MuStorageException("SNAPSHOT_STAGING_PENDING","Unpublished snapshot copies remain; verify their ownership before cleanup or another copy");
            lock(ImportGate)using(ImportReservation()){
                if(HostServicingBusy())throw new InvalidOperationException("Windows component servicing is running");
                if(action=="snapshot-delete"){
                    ValidateKeys(request,"action","id","snapshotId","name","resumeOnly");if(!request.ContainsKey("resumeOnly")||!(request["resumeOnly"] is bool))throw new ArgumentException("Explicit snapshot deletion mode required");
                    string snapshotId=Id(new Dictionary<string,object>{{"id",Text(request,"snapshotId",36)}}),name=Text(request,"name",60);SnapshotReviewCurrent(record,cancellation);
                    return SnapshotStore(record,cancellation).Delete(snapshotId,name,SnapshotDeleteAuthority(record),(bool)request["resumeOnly"],snapshot=>{SnapshotEnvelope(record,snapshot.configuration,true);},cancellation);
                }
                if(action=="snapshot-create"){
                    ValidateKeys(request,"action","id","name","ownerConfiguration","seedSha256","cpus","memoryGiB","diskGiB","imageSha256");string cipher=SnapshotCipher(request,"ownerConfiguration"),seedDigest=Digest(request,"seedSha256");SnapshotOwnerResources(record,request);SnapshotReviewCurrent(record,cancellation);SnapshotOwnerSeed(record,seedDigest,cancellation);CloseChannel(id);
                    CaptureSnapshotOrigin(record,SnapshotEnvelope(record,cipher),cancellation);
                    var vmSid=(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",Convert.ToString(record["platformId"])).Translate(typeof(SecurityIdentifier));using(var seed=RecoveryFile(Convert.ToString(Parameters(record)["seed"]),vmSid)){if(seed.Length<32774||seed.Length>8*1024*1024||RecoveryHash(seed,cancellation)!=seedDigest)throw new UnauthorizedAccessException("Snapshot owner seed differs from the protected original");var created=SnapshotStore(record,cancellation).Create(Text(request,"name",60),Json().Serialize(SnapshotEnvelope(record,cipher)),cancellation);return SnapshotDescriptor(record,created);}
                }
                if(action=="snapshot-prepare"){
                    ValidateKeys(request,"action","id","snapshotId","ownerConfiguration","seedSha256","cpus","memoryGiB","diskGiB","imageSha256");string snapshotId=Id(new Dictionary<string,object>{{"id",Text(request,"snapshotId",36)}}),cipher=SnapshotCipher(request,"ownerConfiguration");SnapshotOwnerResources(record,request);SnapshotReviewCurrent(record,cancellation);SnapshotOwnerSeed(record,Digest(request,"seedSha256"),cancellation);CloseChannel(id);
                    var snapshot=SnapshotStore(record,cancellation).Get(snapshotId);var envelope=SnapshotEnvelope(record,snapshot.configuration,true);long extra=Math.Max(0,MuResourceMetrics.DiskFootprint(Convert.ToInt64(envelope["diskGiB"])*MuResourcePolicy.GiB)-MuResourceMetrics.DiskFootprint(Convert.ToInt64(record["diskGiB"])*MuResourcePolicy.GiB));
                    long total;lock(Gate)total=Records.Values.Where(v=>Convert.ToString(v["id"])!=id).Sum(v=>Convert.ToInt64(v["diskGiB"]));MuResourcePolicy.Quota(total,Convert.ToInt64(envelope["diskGiB"]));
                    var parameters=Parameters(record);parameters["snapshotDisk"]=Path.Combine(SnapshotDirectory(record),snapshotId,"disk.vhdx");parameters["snapshotDiskGiB"]=envelope["diskGiB"];using(var disk=RecoveryFile(Convert.ToString(parameters["snapshotDisk"]))){Invoke("snapshot-verify",parameters,60000,cancellation);}
                    string origin=CaptureSnapshotOrigin(record,envelope,cancellation);
                    var prepared=SnapshotStore(record,cancellation,extra).PrepareRestore(snapshotId,Json().Serialize(SnapshotEnvelope(record,cipher)),cancellation,SnapshotCoordinator(record),origin);SnapshotSealRollback(record);SnapshotApplyResources(record,envelope);return SnapshotRestoreReceipt(record,prepared);
                }
                if(action=="snapshot-recover"){
                    ValidateKeys(request,"action","id","transactionId");var recoveryStore=SnapshotStore(record,CancellationToken.None);var pending=recoveryStore.Pending();if(pending==null)return new {pending=false};if(request.ContainsKey("transactionId")&&pending.id!=Id(new Dictionary<string,object>{{"id",Text(request,"transactionId",36)}}))throw new MuStorageException("SNAPSHOT_PENDING","The exact pending snapshot transaction is required");SnapshotCoordinatorGuard(record,pending,true);
                    recoveryStore.BindCoordinator(pending.id,pending.coordinator,SnapshotCoordinator(record));CloseChannel(id);var journal=recoveryStore.RecoverRestore(pending.id);SnapshotSealRollback(record);var envelope=SnapshotEnvelope(record,journal.phase=="rolled-back"?journal.previousConfiguration:journal.configuration,true);SnapshotApplyResources(record,envelope);return SnapshotRestoreReceipt(record,journal);
                }
                ValidateKeys(request,"action","id","transactionId");string transactionId=Id(new Dictionary<string,object>{{"id",Text(request,"transactionId",36)}});var store=SnapshotStore(record,CancellationToken.None);var active=store.Pending();if(active==null||active.id!=transactionId)throw new MuStorageException("SNAPSHOT_PENDING","The exact pending snapshot transaction is required");
                SnapshotCoordinatorGuard(record,active,false);
                if(action=="snapshot-commit"){SnapshotReviewCurrent(record,CancellationToken.None);SnapshotRegisteredResources(record,SnapshotEnvelope(record,active.configuration,true));return SnapshotRestoreReceipt(record,store.CommitRestore(transactionId));}
                if(action=="snapshot-acknowledge"){SnapshotReviewCurrent(record,CancellationToken.None);SnapshotRegisteredResources(record,SnapshotEnvelope(record,active.phase=="rolled-back"?active.previousConfiguration:active.configuration,true));active=FinishSnapshotOrigin(record,store,active);SnapshotSealRollback(record);store.AcknowledgeRestore(transactionId);return new {acknowledged=true};}
                throw new ArgumentException("Unknown snapshot action");
            }
        }
    }
}
