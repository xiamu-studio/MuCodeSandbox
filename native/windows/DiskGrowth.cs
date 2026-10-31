// Windows-only disk growth. A durable journal reserves the requested capacity
// before VHDX mutation. Never shrink or discard a disk after an interruption.
public static class MuDiskGrowthPolicy {
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(IntPtr file,[Out]byte[] info);
    public static string FileIdentity(string path){
        if((File.GetAttributes(path)&(FileAttributes.ReparsePoint|FileAttributes.Directory))!=0)throw new UnauthorizedAccessException("Disk must be a regular protected file");
        using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){byte[] info=new byte[52];if(!GetFileInformationByHandle(file.SafeFileHandle.DangerousGetHandle(),info)||BitConverter.ToUInt32(info,40)!=1)throw new UnauthorizedAccessException("Disk hard links or unavailable file identity rejected");return (BitConverter.ToString(info,28,4)+BitConverter.ToString(info,44,8)).Replace("-","").ToLowerInvariant();}
    }
    public static void Request(long current,long target){if(current<16||current>256||target<16||target>256||target<current)throw new ArgumentException("Only bounded disk growth is supported");}
    public static void Filesystem(long target,long bytes,long start){Request(target,target);long disk=checked(target*MuResourcePolicy.GiB);if(start<1024*1024||start>2L*MuResourcePolicy.GiB||bytes>disk-start||bytes<disk-start-64L*1024*1024)throw new ArgumentException("The expanded filesystem capacity is unconfirmed");}
    public static bool CompactionBlocks(bool pending,string action){
        if(!pending)return false;
        switch(action){case "allocation":case "status":case "stop":case "inspect":case "close-channel":case "disk-compact-status":case "disk-compact-start":case "disk-compact-trimmed":case "disk-compact-run":case "disk-compact-reconcile":case "disk-compact-verify-start":case "disk-compact-review":case "disk-compact-finish":case "disk-compact-retry":case "disk-compact-cancel":return false;default:return true;}
    }
    public static bool CompactionChannelAllowed(bool pending,string phase,bool currentSession){return pending&&currentSession&&(phase=="trimming"||phase=="verifying");}
}
public static partial class MuHyperVBroker {
    private static void CompactionPending(string id,string action){
        lock(Gate){Dictionary<string,object> record;if(!Records.TryGetValue(id,out record))return;object value;bool pending=record.TryGetValue("diskCompaction",out value);var journal=value as Dictionary<string,object>;object phase;
            if(action=="channel"&&journal!=null&&journal.TryGetValue("phase",out phase)&&MuDiskGrowthPolicy.CompactionChannelAllowed(pending,Convert.ToString(phase),CompactionChannels.Contains(id)))return;
            if(MuDiskGrowthPolicy.CompactionBlocks(pending,action))throw new MuStorageException("DISK_COMPACTION_PENDING","Disk maintenance was interrupted; preserve the disk for recovery");}
    }
    private static Dictionary<string,object> GrowthJournal(Dictionary<string,object> record){object value;return record.TryGetValue("diskGrowth",out value)?(Dictionary<string,object>)value:null;}
    private static Dictionary<string,object> GrowthFacts(Dictionary<string,object> record,CancellationToken cancellation){
        var facts=Json().Deserialize<Dictionary<string,object>>(Invoke("disk-growth-facts",Parameters(record),60000,cancellation));
        string path=Convert.ToString(Parameters(record)["disk"]),identity=MuDiskGrowthPolicy.FileIdentity(path);
        long allocated=MuResourceMetrics.AllocatedBytes(path);
        if(MuDiskGrowthPolicy.FileIdentity(path)!=identity)throw new UnauthorizedAccessException("Disk file identity changed while measuring allocation");
        facts["fileIdentity"]=identity;facts["allocatedBytes"]=allocated;
        if(Text(facts,"platformId",36)!=Convert.ToString(record["platformId"]))throw new UnauthorizedAccessException("Disk growth VM changed");
        string disk=Text(facts,"diskIdentifier",36);Guid parsed;if(!Guid.TryParseExact(disk,"D",out parsed)||parsed==Guid.Empty||parsed.ToString("D")!=disk)throw new IOException("Disk identity unavailable");
        long size=Convert.ToInt64(facts["diskGiB"]);MuDiskGrowthPolicy.Request(size,size);if(Convert.ToInt64(facts["bytes"])!=size*MuResourcePolicy.GiB)throw new IOException("Disk capacity is not integral");
        var journal=GrowthJournal(record);if(journal!=null){if(disk!=Convert.ToString(journal["diskIdentifier"])||Convert.ToString(facts["fileIdentity"])!=Convert.ToString(journal["fileIdentity"])||size!=Convert.ToInt64(journal["fromGiB"])&&size!=Convert.ToInt64(journal["targetGiB"]))throw new UnauthorizedAccessException("Pending disk growth identity changed");}
        else if(size!=Convert.ToInt64(record["diskGiB"]))throw new UnauthorizedAccessException("Disk capacity changed without an application journal");
        return facts;
    }
    // Internal broker operations. The product entry remains disabled until
    // interrupted-compaction recovery and end-to-end validation are ready.
    private static void EnsureCompactionIdle(string id){
        lock(Gate)if(BackupReads.ContainsKey(id)||SnapshotExports.ContainsKey(id)||SnapshotLiveDeletes.ContainsKey(id))throw new MuStorageException("DISK_COMPACTION_BUSY","A disk or snapshot operation is still active");
    }
    private static void GrantCompactionChannel(string id,bool verifying){lock(Gate){CheckPower();if(Quiescing||Stopping||ResourceIssue!=null)throw new InvalidOperationException("Maintenance authority was revoked");CompactionChannels.Add(id);if(verifying)CompactionVerifyBoots.Add(id);}}
    private static void CompactionIdentity(Dictionary<string,object> record,Dictionary<string,object> journal,Dictionary<string,object> facts){
        if(Convert.ToString(facts["platformId"])!=Convert.ToString(record["platformId"])||Convert.ToString(facts["diskIdentifier"])!=Convert.ToString(journal["diskIdentifier"])||Convert.ToString(facts["fileIdentity"])!=Convert.ToString(journal["fileIdentity"])||Convert.ToInt64(facts["diskGiB"])!=Convert.ToInt64(journal["diskGiB"]))throw new UnauthorizedAccessException("Compaction disk identity changed");
    }
    private static void BeginDiskCompaction(string id,CancellationToken cancellation){
        lock(VmGate(id)){
            var request=new Dictionary<string,object>{{"action","disk-compact-begin"},{"id",id}};
            QuiesceAdmission("disk-compact-begin");CheckPower();if(ResourceIssue!=null||HostServicingBusy())throw new InvalidOperationException("Host maintenance or resource protection is active");
            SnapshotLiveAdmission(id,"disk-compact-begin",request);CheckBackupBusy(id,"disk-compact-begin");RestorePending(id,"disk-compact-begin");SnapshotPending(id,"disk-compact-begin");EnsureCompactionIdle(id);
            var record=Owned(id);if(Convert.ToString(record["stage"])!="ready"||!EverReady(record)||record.ContainsKey("baseBuilder")||record.ContainsKey("baseSealedDigest")||record.ContainsKey("backupRestore")||record.ContainsKey("diskCompaction")||GrowthJournal(record)!=null)throw new InvalidOperationException("A complete stopped environment is required");
            lock(ImportGate)using(ImportReservation()){
                cancellation.ThrowIfCancellationRequested();var facts=GrowthFacts(record,cancellation);EnsureCompactionIdle(id);cancellation.ThrowIfCancellationRequested();
                long allocated=Convert.ToInt64(facts["allocatedBytes"]);if(allocated<0||allocated>9007199254740991L)throw new IOException("Disk allocation measurement is unavailable");
                var journal=new Dictionary<string,object>{{"diskIdentifier",facts["diskIdentifier"]},{"fileIdentity",facts["fileIdentity"]},{"diskGiB",facts["diskGiB"]},{"beforeBytes",allocated},{"phase","preparing"}};
                // Do not roll back in memory on a failed replicated Save: its
                // newer backup copy may already contain the maintenance intent.
                lock(Gate){record["diskCompaction"]=journal;Save();}
            }
        }
    }
    private static string StartDiskCompactionTrim(string id,CancellationToken cancellation){
        lock(VmGate(id)){
            QuiesceAdmission("disk-compact-start");CheckPower();if(ResourceIssue!=null||HostServicingBusy())throw new InvalidOperationException("Host maintenance or resource protection is active");
            EnsureCompactionIdle(id);var record=Owned(id);var journal=record.ContainsKey("diskCompaction")?record["diskCompaction"] as Dictionary<string,object>:null;
            if(journal==null||Convert.ToString(journal["phase"])!="preparing")throw new InvalidOperationException("Prepared compaction required");
            lock(ImportGate)using(ImportReservation()){
                cancellation.ThrowIfCancellationRequested();var facts=GrowthFacts(record,cancellation);CompactionIdentity(record,journal,facts);EnsureCompactionIdle(id);cancellation.ThrowIfCancellationRequested();
                lock(Gate){journal["phase"]="trimming";Save();}
            }
            // StartWithResources acquires the cross-process import reservation
            // itself. Do not hold another FileStream reservation across it.
            lock(Gate){CompactionChannels.Remove(id);CompactionVerifyBoots.Remove(id);}CloseChannel(id);lock(Gate)StartedHere.Add(id);string started=null;
            try{StartWithResources(record,cancellation,()=>{started=Invoke("start",Parameters(record),30000,cancellation);});cancellation.ThrowIfCancellationRequested();GrantCompactionChannel(id,false);return started;}
            catch(Exception startError){lock(Gate){CompactionChannels.Remove(id);CompactionVerifyBoots.Remove(id);}CloseChannel(id);try{Invoke("stop",Parameters(record),30000,CancellationToken.None);}catch(Exception stopError){throw new AggregateException("Maintenance start failed and stop was not confirmed",startError,stopError);}throw;}
        }
    }
    private static void FinishDiskCompactionTrim(string id,CancellationToken cancellation){
        lock(VmGate(id)){
            QuiesceAdmission("disk-compact-trimmed");CheckPower();if(ResourceIssue!=null||HostServicingBusy())throw new InvalidOperationException("Host maintenance or resource protection is active");
            EnsureCompactionIdle(id);var record=Owned(id);var journal=record.ContainsKey("diskCompaction")?record["diskCompaction"] as Dictionary<string,object>:null;
            if(journal==null||Convert.ToString(journal["phase"])!="trimming")throw new InvalidOperationException("Trimming phase required");
            lock(ImportGate)using(ImportReservation()){
                cancellation.ThrowIfCancellationRequested();var facts=GrowthFacts(record,cancellation);CompactionIdentity(record,journal,facts);EnsureCompactionIdle(id);cancellation.ThrowIfCancellationRequested();
                lock(Gate){journal["phase"]="armed";Save();CheckPower();if(Quiescing||Stopping||ResourceIssue!=null)throw new InvalidOperationException("Compaction authority was revoked");CompactionRunPermits.Add(id);}
            }
        }
    }
    private static void ResetPreCompaction(string id,bool cancel,CancellationToken cancellation){
        lock(VmGate(id)){
            QuiesceAdmission(cancel?"disk-compact-cancel":"disk-compact-retry");CheckPower();if(ResourceIssue!=null||HostServicingBusy())throw new InvalidOperationException("Host maintenance or resource protection is active");
            EnsureCompactionIdle(id);var record=Owned(id);var journal=record.ContainsKey("diskCompaction")?record["diskCompaction"] as Dictionary<string,object>:null;
            if(journal==null||!new[]{"preparing","trimming","armed"}.Contains(Convert.ToString(journal["phase"])))throw new InvalidOperationException("Only pre-compaction work can be reset");
            lock(Gate)if(CompactionChannels.Contains(id))throw new InvalidOperationException("Stop the maintenance guest before resetting its journal");
            lock(ImportGate)using(ImportReservation()){
                cancellation.ThrowIfCancellationRequested();var facts=GrowthFacts(record,cancellation);CompactionIdentity(record,journal,facts);EnsureCompactionIdle(id);cancellation.ThrowIfCancellationRequested();
                lock(Gate){
                    CompactionRunPermits.Remove(id);
                    if(cancel){record.Remove("diskCompaction");try{Save();}catch{record["diskCompaction"]=journal;throw;}}
                    else{journal["phase"]="preparing";Save();}
                }
            }
        }
    }
    private static void CompactStoppedDisk(string id,CancellationToken cancellation){
        lock(VmGate(id)){
            QuiesceAdmission("disk-compact-run");CheckPower();if(ResourceIssue!=null||HostServicingBusy())throw new InvalidOperationException("Host maintenance or resource protection is active");
            EnsureCompactionIdle(id);var record=Owned(id);var journal=record.ContainsKey("diskCompaction")?record["diskCompaction"] as Dictionary<string,object>:null;
            if(journal==null||Convert.ToString(journal["phase"])!="armed")throw new InvalidOperationException("Prepared compaction phase required");
            lock(ImportGate)using(ImportReservation()){
                cancellation.ThrowIfCancellationRequested();var before=GrowthFacts(record,cancellation);CompactionIdentity(record,journal,before);EnsureCompactionIdle(id);
                // A timed-out or disconnected Optimize-VHD may still be active
                // in the Hyper-V provider. Never rerun after this permit is
                // consumed, including after a broker restart or lost reply.
                PrivateDirectory(Path.Combine(UserRoot,"compaction-receipts"));
                cancellation.ThrowIfCancellationRequested();lock(Gate){CheckPower();if(Quiescing||Stopping||ResourceIssue!=null||!CompactionRunPermits.Remove(id))throw new InvalidOperationException("Compaction outcome requires independent recovery");journal["phase"]="compacting";journal["operationId"]=Guid.NewGuid().ToString("D");Save();}
                var parameters=Parameters(record);parameters["compactDiskIdentifier"]=journal["diskIdentifier"];parameters["compactOperationId"]=journal["operationId"];
                var receipt=Json().Deserialize<Dictionary<string,object>>(Invoke("compact-disk-submit",parameters,30000,cancellation));
                if(receipt.Count!=2||!receipt.ContainsKey("jobId"))throw new IOException("Compaction submission receipt changed");
                string submitted=Text(receipt,"submitted",16);bool completed=submitted=="completed"&&receipt["jobId"]==null;
                if(!completed){
                    if(submitted!="started"||!(receipt["jobId"] is string))throw new IOException("Compaction submission is unconfirmed");
                    string job=(string)receipt["jobId"];Guid parsed;if(!Guid.TryParseExact(job,"D",out parsed)||parsed==Guid.Empty||parsed.ToString("D")!=job)throw new IOException("Compaction job identity is unconfirmed");
                    // Retain the job in memory even if replicated Save fails:
                    // one copy may already contain the newer durable identity.
                    lock(Gate){journal["jobId"]=job;Save();}
                }
                // Verify the durable recovery receipt while its matching reply
                // is still available. A later restart must not depend on a
                // receipt that this broker cannot read or bind to this job.
                bool publishedCompleted=RecoverPublishedCompactionReceipt(record,journal,true,completed,completed?null:(string)receipt["jobId"]);
                if(publishedCompleted!=completed)throw new IOException("Compaction receipt result changed");
                FinishObservedCompaction(id,record,journal,completed,cancellation);
            }
        }
    }
    private static bool RecoverPublishedCompactionReceipt(Dictionary<string,object> record,Dictionary<string,object> journal,bool compareReply=false,bool expectedCompleted=false,string expectedJob=null){
        object token;if(!journal.TryGetValue("operationId",out token)||!(token is string))throw new InvalidOperationException("Compaction operation identity is unavailable; preserve the disk");
        string operation=(string)token;Guid parsed;if(!Guid.TryParseExact(operation,"D",out parsed)||parsed==Guid.Empty||parsed.ToString("D")!=operation)throw new IOException("Compaction operation identity changed");
        string directory=Path.Combine(UserRoot,"compaction-receipts");PrivateDirectory(directory);string file=Path.Combine(directory,operation+".json");
        if(!File.Exists(file))throw new InvalidOperationException("Compaction receipt is unavailable; preserve the disk");
        ValidateLedgerFile(file);string identity=MuDiskGrowthPolicy.FileIdentity(file),raw;
        using(var input=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read)){if(input.Length<1||input.Length>1024)throw new IOException("Compaction receipt length changed");using(var reader=new StreamReader(input,Encoding.UTF8,true,1024))raw=reader.ReadToEnd();}
        if(MuDiskGrowthPolicy.FileIdentity(file)!=identity)throw new UnauthorizedAccessException("Compaction receipt file changed");
        var receipt=Json().Deserialize<Dictionary<string,object>>(raw);
        if(receipt==null||receipt.Count!=5||!receipt.ContainsKey("jobId")||Text(receipt,"operationId",36)!=operation||Text(receipt,"platformId",36)!=Convert.ToString(record["platformId"])||Text(receipt,"diskIdentifier",36)!=Convert.ToString(journal["diskIdentifier"]))throw new UnauthorizedAccessException("Compaction receipt identity changed");
        string submitted=Text(receipt,"submitted",16);
        if(submitted=="completed"&&receipt["jobId"]==null){if(compareReply&&!expectedCompleted)throw new IOException("Compaction receipt does not match provider reply");return true;}
        string job=receipt["jobId"] as string;Guid jobGuid;if(submitted!="started"||job==null||!Guid.TryParseExact(job,"D",out jobGuid)||jobGuid==Guid.Empty||jobGuid.ToString("D")!=job)throw new IOException("Compaction receipt result is unconfirmed");
        if(compareReply&&(expectedCompleted||job!=expectedJob))throw new IOException("Compaction receipt does not match provider reply");
        lock(Gate){object existing;if(!journal.TryGetValue("jobId",out existing)){journal["jobId"]=job;Save();}else if(!String.Equals(existing as string,job,StringComparison.Ordinal))throw new IOException("Compaction receipt job changed");}return false;
    }
    private static void FinishObservedCompaction(string id,Dictionary<string,object> record,Dictionary<string,object> journal,bool completedInline,CancellationToken cancellation){
        cancellation.ThrowIfCancellationRequested();
        if(!completedInline&&!journal.ContainsKey("jobId")&&journal.ContainsKey("operationId"))completedInline=RecoverPublishedCompactionReceipt(record,journal);
        if(!completedInline){
            object raw;if(!journal.TryGetValue("jobId",out raw)||!(raw is string))throw new InvalidOperationException("Compaction job identity is unavailable; preserve the disk");
            string job=(string)raw;Guid parsed;if(!Guid.TryParseExact(job,"D",out parsed)||parsed==Guid.Empty||parsed.ToString("D")!=job)throw new IOException("Compaction job identity changed");
            var parameters=Parameters(record);parameters["compactJobId"]=job;
            var observed=Json().Deserialize<Dictionary<string,object>>(Invoke("compact-disk-job",parameters,30000,cancellation));
            if(observed.Count!=4||Text(observed,"jobId",36)!=job)throw new InvalidOperationException("Compaction job identity is not confirmed; preserve the disk");
            long state=CompactionNumber(observed,"state"),error=CompactionNumber(observed,"errorCode"),completion=CompactionNumber(observed,"completionCode");
            if(new long[]{2,3,4,6}.Contains(state)&&error==0&&completion==0)throw new MuStorageException("DISK_COMPACTION_RUNNING","The original compaction job is still running");
            if(state!=7||error!=0||completion!=0)throw new InvalidOperationException("Compaction job completion is not confirmed; preserve the disk");
        }
        cancellation.ThrowIfCancellationRequested();var after=GrowthFacts(record,cancellation);CompactionIdentity(record,journal,after);EnsureCompactionIdle(id);cancellation.ThrowIfCancellationRequested();
        lock(Gate){CheckPower();if(Quiescing||Stopping||ResourceIssue!=null)throw new InvalidOperationException("Compaction verification authority was revoked");object job,operation;bool hadJob=journal.TryGetValue("jobId",out job),hadOperation=journal.TryGetValue("operationId",out operation);journal.Remove("jobId");journal.Remove("operationId");journal["phase"]="verifying";try{Save();}catch{journal["phase"]="compacting";if(hadJob)journal["jobId"]=job;if(hadOperation)journal["operationId"]=operation;throw;}}
    }
    private static void ReconcileDiskCompaction(string id,CancellationToken cancellation){
        lock(VmGate(id)){
            QuiesceAdmission("disk-compact-reconcile");CheckPower();if(ResourceIssue!=null||HostServicingBusy())throw new InvalidOperationException("Host maintenance or resource protection is active");
            EnsureCompactionIdle(id);var record=Owned(id);var journal=record.ContainsKey("diskCompaction")?record["diskCompaction"] as Dictionary<string,object>:null;
            if(journal==null||Convert.ToString(journal["phase"])!="compacting")throw new InvalidOperationException("A pending compaction result is required");
            lock(ImportGate)using(ImportReservation()){FinishObservedCompaction(id,record,journal,false,cancellation);}
        }
    }
    private static object ReviewDiskCompaction(string id,CancellationToken cancellation){
        lock(VmGate(id)){
            QuiesceAdmission("disk-compact-review");CheckPower();if(ResourceIssue!=null||HostServicingBusy())throw new InvalidOperationException("Host maintenance or resource protection is active");
            EnsureCompactionIdle(id);var record=Owned(id);var journal=record.ContainsKey("diskCompaction")?record["diskCompaction"] as Dictionary<string,object>:null;
            if(journal==null||Convert.ToString(journal["phase"])!="verifying")throw new InvalidOperationException("A confirmed compact operation is required");
            lock(ImportGate)using(ImportReservation()){
                cancellation.ThrowIfCancellationRequested();var facts=GrowthFacts(record,cancellation);CompactionIdentity(record,journal,facts);EnsureCompactionIdle(id);cancellation.ThrowIfCancellationRequested();
                long before=Convert.ToInt64(journal["beforeBytes"]),after=Convert.ToInt64(facts["allocatedBytes"]);if(before<0||after<0||before>9007199254740991L||after>9007199254740991L)throw new IOException("Disk allocation measurement is unavailable");
                // Net change is only a measurement. It is not a filesystem
                // integrity proof and never clears the maintenance journal.
                return new {platformId=record["platformId"],diskIdentifier=journal["diskIdentifier"],diskGiB=journal["diskGiB"],phase="verifying",beforeBytes=before,afterBytes=after};
            }
        }
    }
    private static string StartDiskCompactionVerify(string id,CancellationToken cancellation){
        lock(VmGate(id)){
            QuiesceAdmission("disk-compact-verify-start");CheckPower();if(ResourceIssue!=null||HostServicingBusy())throw new InvalidOperationException("Host maintenance or resource protection is active");
            EnsureCompactionIdle(id);var record=Owned(id);var journal=record.ContainsKey("diskCompaction")?record["diskCompaction"] as Dictionary<string,object>:null;
            if(journal==null||Convert.ToString(journal["phase"])!="verifying")throw new InvalidOperationException("Confirmed compaction verification phase required");
            lock(ImportGate)using(ImportReservation()){
                cancellation.ThrowIfCancellationRequested();var facts=GrowthFacts(record,cancellation);CompactionIdentity(record,journal,facts);EnsureCompactionIdle(id);cancellation.ThrowIfCancellationRequested();
            }
            lock(Gate){CompactionChannels.Remove(id);CompactionVerifyBoots.Remove(id);}CloseChannel(id);lock(Gate)StartedHere.Add(id);string started=null;
            try{StartWithResources(record,cancellation,()=>{started=Invoke("start",Parameters(record),30000,cancellation);});cancellation.ThrowIfCancellationRequested();GrantCompactionChannel(id,true);return started;}
            catch(Exception startError){lock(Gate){CompactionChannels.Remove(id);CompactionVerifyBoots.Remove(id);}CloseChannel(id);try{Invoke("stop",Parameters(record),30000,CancellationToken.None);}catch(Exception stopError){throw new AggregateException("Verification start failed and stop was not confirmed",startError,stopError);}throw;}
        }
    }
    private static long CompactionNumber(Dictionary<string,object> request,string field){object value;if(!request.TryGetValue(field,out value)||!(value is int)&&!(value is long))throw new ArgumentException("Integer verification receipt required");long number=Convert.ToInt64(value);if(number<0||number>9007199254740991L)throw new ArgumentException("Verification receipt exceeds bounds");return number;}
    private static object FinishDiskCompaction(string id,Dictionary<string,object> request,CancellationToken cancellation){
        lock(VmGate(id)){
            QuiesceAdmission("disk-compact-finish");CheckPower();if(ResourceIssue!=null||HostServicingBusy())throw new InvalidOperationException("Host maintenance or resource protection is active");
            EnsureCompactionIdle(id);var record=Owned(id);var journal=record.ContainsKey("diskCompaction")?record["diskCompaction"] as Dictionary<string,object>:null;
            if(journal==null||Convert.ToString(journal["phase"])!="verifying")throw new InvalidOperationException("Confirmed compaction verification phase required");
            lock(Gate)if(!CompactionVerifyBoots.Contains(id)||CompactionChannels.Contains(id))throw new InvalidOperationException("Stopped current-session verification required");
            long fs=CompactionNumber(request,"filesystemBytes"),partition=CompactionNumber(request,"partitionBytes"),start=CompactionNumber(request,"partitionStartBytes"),expectedAfter=CompactionNumber(request,"afterBytes"),disk=checked(Convert.ToInt64(journal["diskGiB"])*MuResourcePolicy.GiB);
            if(fs<1||start<1024*1024||start>2L*MuResourcePolicy.GiB||partition<fs||start>disk||partition>disk-start)throw new ArgumentException("Guest filesystem geometry is not confirmed");
            lock(ImportGate)using(ImportReservation()){
                cancellation.ThrowIfCancellationRequested();var facts=GrowthFacts(record,cancellation);CompactionIdentity(record,journal,facts);EnsureCompactionIdle(id);
                long before=Convert.ToInt64(journal["beforeBytes"]),after=Convert.ToInt64(facts["allocatedBytes"]);if(after!=expectedAfter)throw new IOException("Disk allocation changed after review");
                cancellation.ThrowIfCancellationRequested();lock(Gate){
                    if(!CompactionVerifyBoots.Contains(id)||CompactionChannels.Contains(id)||Quiescing||Stopping||ResourceIssue!=null)throw new InvalidOperationException("Verification authority was revoked");
                    CheckPower();record.Remove("diskCompaction");try{Save();}catch{record["diskCompaction"]=journal;throw;}CompactionVerifyBoots.Remove(id);
                }
                return new {completed=true,platformId=record["platformId"],diskIdentifier=journal["diskIdentifier"],diskGiB=journal["diskGiB"],beforeBytes=before,afterBytes=after};
            }
        }
    }
    // Fixed internal operation boundary; product entry remains disabled.
    private static object DiskCompactionAction(string action,Dictionary<string,object> request,CancellationToken cancellation){
        if(action=="disk-compact-finish")ValidateKeys(request,"action","id","filesystemBytes","partitionBytes","partitionStartBytes","afterBytes");else ValidateKeys(request,"action","id");if(Text(request,"action",32)!=action)throw new ArgumentException("Disk maintenance action changed");string id=Id(request);
        lock(VmGate(id)){
            QuiesceAdmission(action);
            switch(action){
                case "disk-compact-begin":BeginDiskCompaction(id,cancellation);break;
                case "disk-compact-start":return StartDiskCompactionTrim(id,cancellation);
                case "disk-compact-trimmed":FinishDiskCompactionTrim(id,cancellation);break;
                case "disk-compact-retry":ResetPreCompaction(id,false,cancellation);break;
                case "disk-compact-cancel":ResetPreCompaction(id,true,cancellation);return new {cancelled=true};
                case "disk-compact-run":CompactStoppedDisk(id,cancellation);break;
                case "disk-compact-reconcile":ReconcileDiskCompaction(id,cancellation);break;
                case "disk-compact-verify-start":return StartDiskCompactionVerify(id,cancellation);
                case "disk-compact-review":return ReviewDiskCompaction(id,cancellation);
                case "disk-compact-finish":return FinishDiskCompaction(id,request,cancellation);
                case "disk-compact-status":break;
                default:throw new ArgumentException("Unknown disk maintenance operation");
            }
            var record=Owned(id);var journal=record.ContainsKey("diskCompaction")?record["diskCompaction"] as Dictionary<string,object>:null;
            if(journal==null){if(action=="disk-compact-status")return new {pending=false};throw new InvalidOperationException("Disk maintenance authority is unavailable");}
            if(action=="disk-compact-status")return new {pending=true,platformId=record["platformId"],diskIdentifier=journal["diskIdentifier"],diskGiB=journal["diskGiB"],phase=journal["phase"],beforeBytes=journal["beforeBytes"],jobTracked=Convert.ToString(journal["phase"])!="compacting"?(bool?)null:journal.ContainsKey("jobId")?(bool?)true:journal.ContainsKey("operationId")?(bool?)null:false};
            return new {platformId=record["platformId"],diskIdentifier=journal["diskIdentifier"],diskGiB=journal["diskGiB"],phase=journal["phase"]};
        }
    }
    private static object DiskGrowthAction(string action,Dictionary<string,object> request,CancellationToken cancellation){
        string id=Id(request);ValidateKeys(request,action=="disk-growth-status"?new[]{"action","id"}:action=="finish-disk-growth"?new[]{"action","id","targetGiB","filesystemBytes","partitionStartBytes"}:new[]{"action","id","targetGiB"});
        lock(VmGate(id)){
            var record=Owned(id);if(Convert.ToString(record["stage"])!="ready"||record.ContainsKey("baseBuilder")||record.ContainsKey("baseSealedDigest"))throw new InvalidOperationException("Only a registered environment disk may grow");
            var journal=GrowthJournal(record);
            if(action=="start-disk-growth"||action=="start-disk-review"){
                long target=Number(request,"targetGiB",16,256);if(action=="start-disk-growth"?(journal==null||Convert.ToInt64(journal["targetGiB"])!=target):(journal!=null||Convert.ToInt64(record["diskGiB"])!=target))throw new InvalidOperationException("Maintenance disk phase changed");
                var facts=GrowthFacts(record,cancellation);if(Convert.ToInt64(facts["diskGiB"])!=target)throw new InvalidOperationException("Virtual disk growth is not finished");
                CloseChannel(id);lock(Gate)StartedHere.Add(id);string started=null;
                try{StartWithResources(record,cancellation,()=>{started=Invoke("start",Parameters(record),30000,cancellation);});return started;}
                finally{if(cancellation.IsCancellationRequested){CloseChannel(id);try{Invoke("stop",Parameters(record),30000,CancellationToken.None);}catch{}}}
            }
            lock(ImportGate)using(ImportReservation()){
                var facts=GrowthFacts(record,cancellation);long actual=Convert.ToInt64(facts["diskGiB"]),registered=Convert.ToInt64(record["diskGiB"]);
                if(action=="disk-growth-status")return new {platformId=record["platformId"],diskIdentifier=facts["diskIdentifier"],actualGiB=actual,allocatedBytes=facts["allocatedBytes"],registeredGiB=registered,pending=journal!=null,fromGiB=journal==null?registered:journal["fromGiB"],targetGiB=journal==null?registered:journal["targetGiB"]};
                long target=Number(request,"targetGiB",16,256);MuDiskGrowthPolicy.Request(registered,target);
                if(journal!=null&&Convert.ToInt64(journal["targetGiB"])!=target)throw new InvalidOperationException("Resume the original disk target before requesting another size");
                if(action=="finish-disk-growth"){
                    if(journal==null||actual!=target)throw new InvalidOperationException("Pending grown disk required");object bytes,start;if(!request.TryGetValue("filesystemBytes",out bytes)||!(bytes is long)&&!(bytes is int)||!request.TryGetValue("partitionStartBytes",out start)||!(start is long)&&!(start is int))throw new ArgumentException("Filesystem capacity and partition offset required");MuDiskGrowthPolicy.Filesystem(target,Convert.ToInt64(bytes),Convert.ToInt64(start));
                    FinishOriginGrowth(record,journal,cancellation);
                    lock(Gate){record.Remove("diskGrowth");try{Save();}catch{record["diskGrowth"]=journal;throw;}}return new {completed=true,diskGiB=target,platformId=record["platformId"],diskIdentifier=facts["diskIdentifier"]};
                }
                if(journal==null&&target==registered)return new {grown=true,diskGiB=target,pending=false};
                if(journal==null){
                    long total;lock(Gate)total=Records.Values.Sum(value=>Convert.ToInt64(value["diskGiB"]));MuResourcePolicy.Quota(total-registered,target);
                    CheckDiskRequest(checked(MuResourceMetrics.DiskFootprint(target*MuResourcePolicy.GiB)-MuResourceMetrics.DiskFootprint(actual*MuResourcePolicy.GiB)),cancellation);
                    journal=new Dictionary<string,object>{{"fromGiB",registered},{"targetGiB",target},{"diskIdentifier",facts["diskIdentifier"]},{"fileIdentity",facts["fileIdentity"]}};
                    lock(Gate){record["diskGrowth"]=journal;record["diskGiB"]=target;Save();}
                }else CheckDiskRequest(checked(MuResourceMetrics.DiskFootprint(target*MuResourcePolicy.GiB)-MuResourceMetrics.DiskFootprint(actual*MuResourcePolicy.GiB)),cancellation);
                cancellation.ThrowIfCancellationRequested();CloseChannel(id);var parameters=Parameters(record);parameters["growthDiskIdentifier"]=journal["diskIdentifier"];
                var result=Json().Deserialize<Dictionary<string,object>>(Invoke("grow-disk",parameters,120000,cancellation));if(Convert.ToInt64(result["diskGiB"])!=target||Text(result,"diskIdentifier",36)!=Convert.ToString(journal["diskIdentifier"]))throw new IOException("Disk growth receipt changed");
                GrowthFacts(record,cancellation);
                return new {grown=true,diskGiB=target,pending=true};
            }
        }
    }
}
