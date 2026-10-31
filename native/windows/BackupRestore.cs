// Restore only to a fixed current-user allocation. A durable digest journal
// distinguishes retries from unrelated existing disks; no start is performed.
public static partial class MuHyperVBroker {
    private static void RestorePending(string id,string action){
        if(new[]{"backup-import","allocation","recover","status","stop","inspect","delete","absence"}.Contains(action))return;
        lock(Gate){Dictionary<string,object> record;if(Records.TryGetValue(id,out record)&&record.ContainsKey("backupRestore"))throw new MuStorageException("RESTORE_PENDING","Resume the original backup restore or explicitly remove its incomplete allocation");}
    }
    private static long RestoreLength(Dictionary<string,object> request,string key,long maximum){object item;if(!request.TryGetValue(key,out item)||!(item is int)&&!(item is long))throw new ArgumentException("Bounded restore length required");long value=Convert.ToInt64(item);if(value<1||value>maximum)throw new ArgumentException("Restore input exceeds its limit");return value;}
    private static long RestoreGrowthCushion(long maximum,long bytes){if(bytes<1||bytes>maximum)throw new ArgumentException("Invalid restore disk length");return Math.Min(maximum-bytes,MuResourcePolicy.GrowthReserveLimit);}
    private static void RestoreFile(NamedPipeServerStream pipe,string source,string target,string digest,long length,long maximum,long reserve,CancellationToken cancellation,SecurityIdentifier vmSid){
        if(HasStorage(target)){
            using(var existing=RecoveryFile(target,vmSid)){if(existing.Length!=length||RecoveryHash(existing,cancellation)!=digest)throw new UnauthorizedAccessException("Existing restore data differs; preserved without replacement");}return;
        }
        string next=target+".restore.next";
        if(HasStorage(next)){using(var old=RecoveryFile(next)){}File.Delete(next);}
        Exception primary=null;
        try{CopyCaller(pipe,source,next,digest,maximum,cancellation,reserve);if(new FileInfo(next).Length!=length)throw new IOException("Restore length changed");File.Move(next,target);}
        catch(Exception error){primary=error;throw;}
        finally{
            try{if(HasStorage(next)){using(var old=RecoveryFile(next)){}File.Delete(next);}}
            catch(Exception cleanup){
                if(primary==null)throw;
                // Preserve the exact copy/cancellation failure and its storage
                // code. The durable restore journal and occupied partial file
                // remain available for the original backup's checked retry.
                try{primary.Data["MuBackupRestoreCleanupFailure"]=cleanup;}catch{/* Diagnostic attachment cannot replace the original failure. */}
            }
        }
    }
    private static object BackupImport(NamedPipeServerStream pipe,Dictionary<string,object> request,CancellationToken cancellation){
        if(HostServicingBusy())throw new InvalidOperationException("Windows component servicing is running");
        ValidateKeys(request,"action","id","imageSha256","cpus","memoryGiB","diskGiB","disk","diskSha256","diskBytes","seed","seedSha256","seedBytes");
        string id=Id(request),imageDigest=Digest(request,"imageSha256"),diskDigest=Digest(request,"diskSha256"),seedDigest=Digest(request,"seedSha256");
        if(imageDigest==CanonicalBuilderDigest)throw new UnauthorizedAccessException("Official base builders cannot be restored as work environments");
        int cpu=Number(request,"cpus",1,Math.Min(16,Environment.ProcessorCount)),memory=Number(request,"memoryGiB",2,32),capacity=Number(request,"diskGiB",16,256);
        long maximum=MuResourceMetrics.DiskFootprint((long)capacity*MuResourcePolicy.GiB),bytes=RestoreLength(request,"diskBytes",maximum),seedBytes=RestoreLength(request,"seedBytes",8L*1024*1024);
        if(seedBytes<32774)throw new ArgumentException("A complete original NoCloud ISO is required");
        string diskSource=Text(request,"disk",4096),seedSource=Text(request,"seed",4096);
        lock(VmGate(id))lock(ImportGate)using(ImportReservation()){
            Dictionary<string,object> record;lock(Gate)Records.TryGetValue(id,out record);
            if(record!=null){
                object saved;if(!record.TryGetValue("backupRestore",out saved))throw new MuStorageException("RESTORE_CONFLICT","An existing registration was preserved; backup restore cannot replace it");
                var journal=(Dictionary<string,object>)saved;
                if(Convert.ToString(journal["diskSha256"])!=diskDigest||Convert.ToInt64(journal["diskBytes"])!=bytes||Convert.ToString(journal["seedSha256"])!=seedDigest||Convert.ToInt64(journal["seedBytes"])!=seedBytes||Convert.ToString(record["imageSha256"])!=imageDigest||Convert.ToInt32(record["cpus"])!=cpu||Convert.ToInt32(record["memoryGiB"])!=memory||Convert.ToInt32(record["diskGiB"])!=capacity)throw new MuStorageException("RESTORE_CONFLICT","Only the exact interrupted backup can resume this allocation");
                CloseChannel(id);var recovered=RecoverAllocation(record);
                if(Convert.ToBoolean(recovered["present"])){
                    if(!Convert.ToBoolean(recovered["ready"]))throw new MuStorageException("RESTORE_INCOMPLETE","A partial VM was preserved; inspect or explicitly remove it before retrying");
                }
            }else{
                string directory=Path.Combine(UserRoot,"vms",id);
                record=new Dictionary<string,object>{{"id",id},{"ownerSid",OwnerSid},{"image",Path.Combine(UserRoot,"images",imageDigest+".vhdx")},{"imageSha256",imageDigest},{"cpus",cpu},{"memoryGiB",memory},{"diskGiB",capacity},{"stage","allocated"},{"everReady",true},{"backupRestore",new Dictionary<string,object>{{"diskSha256",diskDigest},{"diskBytes",bytes},{"seedSha256",seedDigest},{"seedBytes",seedBytes}}}};
                if(HasStorage(directory))throw new MuStorageException("RESTORE_CONFLICT","Existing allocation storage was preserved");
                var absent=Json().Deserialize<Dictionary<string,object>>(Invoke("allocation-absence",Parameters(record),30000,cancellation));if(!Convert.ToBoolean(absent["absent"]))throw new MuStorageException("RESTORE_CONFLICT","A VM or switch with this identity already exists");
                var metrics=MuResourceMetrics.Read(UserRoot);MuResourcePolicy.MemoryRequest(metrics.totalMemory,metrics.totalMemory,(long)memory*MuResourcePolicy.GiB);CheckDiskRequest(checked(bytes+seedBytes+RestoreGrowthCushion(maximum,bytes)),cancellation);
                lock(Gate){if(Records.ContainsKey(id)||Records.Count>=32)throw new InvalidOperationException("Restore allocation limit reached");MuResourcePolicy.Quota(Records.Values.Sum(value=>Convert.ToInt64(value["diskGiB"])),capacity);Records.Add(id,record);try{Save();}catch{Records.Remove(id);throw;}}
            }
            if(!OriginTracked(record)){lock(Gate){record["restoreOrigin"]=true;try{Save();}catch{record.Remove("restoreOrigin");throw;}}}
            // Initialize/validate protected metadata before materializing new
            // files or creating a VM. Unknown initialization stays fenced.
            using(var origins=OpenOriginStore(record,cancellation)){
            if(!record.ContainsKey("platformId")&&origins.Contains(Convert.ToString(record["id"])))throw new MuStorageException("RESTORE_CONFLICT","A prior origin receipt was preserved; explicit reconciliation required");
            // A durable allocation may survive a process exit before its
            // directory is created. Existing VM storage keeps its VMMS ACLs.
            string restoreDirectory=Path.Combine(UserRoot,"vms",id);
            if(!HasStorage(restoreDirectory))PrivateDirectory(restoreDirectory,false);
            var parameters=Parameters(record);SecurityIdentifier vmSid=record.ContainsKey("platformId")?(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",Convert.ToString(record["platformId"])).Translate(typeof(SecurityIdentifier)):null;
            RestoreFile(pipe,diskSource,Convert.ToString(parameters["disk"]),diskDigest,bytes,maximum,checked(RestoreGrowthCushion(maximum,bytes)+seedBytes),cancellation,vmSid);
            RestoreFile(pipe,seedSource,Convert.ToString(parameters["seed"]),seedDigest,seedBytes,8L*1024*1024,0,cancellation,vmSid);
            using(var iso=File.OpenRead(Convert.ToString(parameters["seed"]))){iso.Position=32769;var signature=new byte[5];if(iso.Read(signature,0,5)!=5||Encoding.ASCII.GetString(signature)!="CD001")throw new ArgumentException("Original ISO signature changed");}
            Invoke("backup-import-verify",parameters,60000,cancellation);
            if(!record.ContainsKey("platformId")){
                cancellation.ThrowIfCancellationRequested();lock(Gate){record["stage"]="creating";Save();}
                Invoke("register-channel",parameters,15000,cancellation);var created=Json().Deserialize<Dictionary<string,object>>(Invoke("create",parameters,60000,cancellation));string platform=Id(new Dictionary<string,object>{{"id",Text(created,"platformId",36)}});
                lock(Gate){record["platformId"]=platform;record["stage"]="ready";Save();}
            }
            var state=RecoverAllocation(record);if(!Convert.ToBoolean(state["ready"])||Convert.ToString(state["state"])!="Off")throw new IOException("Restored VM is not confirmed stopped and protected");
            // Creation or recovery may have published a VM since preflight.
            // Verify that exact platform identity and all reviewed policies
            // again before removing the durable restore fence.
            Invoke("backup-import-verify",Parameters(record),60000,cancellation);
            PublishRestoreOrigin(record,origins,cancellation);
            cancellation.ThrowIfCancellationRequested();
            lock(Gate){var journal=record["backupRestore"];record.Remove("backupRestore");try{Save();}catch{record["backupRestore"]=journal;throw;}}
            return new {restored=true,id=id,platformId=record["platformId"],state="Off",diskSha256=diskDigest};
            }
        }
    }
}
