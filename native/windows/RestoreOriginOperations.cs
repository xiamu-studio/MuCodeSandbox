// Broker-owned provenance operations. Paths and identities come only from the
// protected registration, never the caller's import source path. No VM starts.
public static partial class MuHyperVBroker {
    private static bool OriginTracked(Dictionary<string,object> record){object value;return record.TryGetValue("restoreOrigin",out value)&&value is bool&&(bool)value;}
    private static void OriginContext(Dictionary<string,object> proof,Dictionary<string,object> record){
        MuRestoreOriginProof.Validate(proof,OwnerSid,Convert.ToString(record["id"]),Convert.ToString(record["platformId"]));
        if(Convert.ToString(proof["imageSha256"])!=Convert.ToString(record["imageSha256"]))throw new UnauthorizedAccessException("Restore origin source differs from registration");
    }
    private static void OriginVmFacts(Dictionary<string,object> record,CancellationToken cancellation){
        var facts=Json().Deserialize<Dictionary<string,object>>(Invoke("review-allocation",Parameters(record),60000,cancellation));
        if(facts.Count!=4||Text(facts,"platformId",36)!=Convert.ToString(record["platformId"]))throw new UnauthorizedAccessException("Restore origin VM identity changed");
        foreach(string key in new[]{"cpus","memoryGiB","diskGiB"})if(Convert.ToInt64(facts[key])!=Convert.ToInt64(record[key]))throw new UnauthorizedAccessException("Restore origin VM resources changed");
    }
    private static void PublishRestoreOrigin(Dictionary<string,object> record,MuRestoreOriginStore origins,CancellationToken cancellation){
        if(!OriginTracked(record)||!record.ContainsKey("backupRestore")||!record.ContainsKey("platformId"))throw new UnauthorizedAccessException("Pending protected restore required for provenance");
        var journal=(Dictionary<string,object>)record["backupRestore"];var parameters=Parameters(record);var vmSid=(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",Convert.ToString(record["platformId"])).Translate(typeof(SecurityIdentifier));
        using(PinOriginAllocation(record))using(var disk=RecoveryFile(Convert.ToString(parameters["disk"]),vmSid))using(var seed=RecoveryFile(Convert.ToString(parameters["seed"]),vmSid)){
            if(disk.Length!=Convert.ToInt64(journal["diskBytes"])||seed.Length!=Convert.ToInt64(journal["seedBytes"])||RecoveryHash(disk,cancellation)!=Convert.ToString(journal["diskSha256"])||RecoveryHash(seed,cancellation)!=Convert.ToString(journal["seedSha256"]))throw new UnauthorizedAccessException("Imported original bytes changed before origin publication");
            var proof=new Dictionary<string,object>{{"format",1},{"kind","standalone-backup-origin"},{"ownerSid",OwnerSid},{"id",record["id"]},{"platformId",record["platformId"]},{"imageSha256",record["imageSha256"]},{"importDiskSha256",journal["diskSha256"]},{"importDiskBytes",journal["diskBytes"]},{"importSeedSha256",journal["seedSha256"]},{"importSeedBytes",journal["seedBytes"]},{"rootFile",origins.RootIdentity},{"diskFile",MuRestoreOriginStore.CaptureIdentity(disk.SafeFileHandle)},{"seedFile",MuRestoreOriginStore.CaptureIdentity(seed.SafeFileHandle)},{"seedSha256",journal["seedSha256"]},{"cpus",record["cpus"]},{"memoryGiB",record["memoryGiB"]},{"diskGiB",record["diskGiB"]}};
            OriginVmFacts(record,cancellation);cancellation.ThrowIfCancellationRequested();origins.PublishInitial(proof,Convert.ToString(record["id"]),Convert.ToString(record["platformId"]));
            var published=origins.Read(Convert.ToString(record["id"]),Convert.ToString(record["platformId"]));OriginContext(published,record);
            cancellation.ThrowIfCancellationRequested();OriginVmFacts(record,cancellation);Invoke("backup-import-verify",Parameters(record),60000,cancellation);
            var pending=origins.ReadSnapshot(Convert.ToString(record["id"]),Convert.ToString(record["platformId"]));
            origins.AcceptInitial(pending,Convert.ToString(record["id"]),Convert.ToString(record["platformId"]),p=>{OriginContext(p,record);OriginVmFacts(record,cancellation);MuRestoreOriginProof.MatchCurrent(p,OriginFacts(origins,record,disk,seed,cancellation),OwnerSid,Convert.ToString(record["id"]),Convert.ToString(record["platformId"]));Invoke("backup-import-verify",Parameters(record),60000,cancellation);cancellation.ThrowIfCancellationRequested();});
            origins.ReadAcceptedSnapshot(Convert.ToString(record["id"]),Convert.ToString(record["platformId"]));
        }
    }
    private static Dictionary<string,object> OriginFacts(MuRestoreOriginStore origins,Dictionary<string,object> record,FileStream disk,FileStream seed,CancellationToken cancellation){
        seed.Position=0;return new Dictionary<string,object>{{"rootFile",origins.RootIdentity},{"diskFile",MuRestoreOriginStore.CaptureIdentity(disk.SafeFileHandle)},{"seedFile",MuRestoreOriginStore.CaptureIdentity(seed.SafeFileHandle)},{"seedSha256",RecoveryHash(seed,cancellation)},{"cpus",record["cpus"]},{"memoryGiB",record["memoryGiB"]},{"diskGiB",record["diskGiB"]}};
    }
    private static void FinishOriginGrowth(Dictionary<string,object> record,Dictionary<string,object> journal,CancellationToken cancellation){
        if(!OriginTracked(record))return;
        object pending;if(journal==null||!record.TryGetValue("diskGrowth",out pending)||!object.ReferenceEquals(journal,pending)||record.ContainsKey("backupRestore")||Convert.ToString(record["stage"])!="ready"||Convert.ToInt64(journal["targetGiB"])!=Convert.ToInt64(record["diskGiB"]))throw new UnauthorizedAccessException("Origin growth journal required");
        using(var origins=OpenOriginStore())using(PinOriginAllocation(record)){
            string id=Convert.ToString(record["id"]),platform=Convert.ToString(record["platformId"]);var snapshot=origins.ReadAcceptedSnapshot(id,platform);var prior=MuRestoreOriginProof.Parse(snapshot.Text,OwnerSid,id,platform);OriginContext(prior,record);
            long priorSize=Convert.ToInt64(prior["diskGiB"]),target=Convert.ToInt64(journal["targetGiB"]);if(priorSize!=Convert.ToInt64(journal["fromGiB"])&&priorSize!=target)throw new UnauthorizedAccessException("Origin growth source capacity changed");
            var parameters=Parameters(record);var vmSid=(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",platform).Translate(typeof(SecurityIdentifier));
            using(var disk=RecoveryFile(Convert.ToString(parameters["disk"]),vmSid))using(var seed=RecoveryFile(Convert.ToString(parameters["seed"]),vmSid)){
                var next=MuRestoreOriginProof.Parse(snapshot.Text,OwnerSid,id,platform);next["diskGiB"]=record["diskGiB"];
                MuRestoreOriginProof.MatchCurrent(next,OriginFacts(origins,record,disk,seed,cancellation),OwnerSid,id,platform);OriginVmFacts(record,cancellation);cancellation.ThrowIfCancellationRequested();
                if(priorSize!=target)origins.Update(snapshot,next,"grow",id,platform,p=>{OriginVmFacts(record,cancellation);MuRestoreOriginProof.MatchCurrent(p,OriginFacts(origins,record,disk,seed,cancellation),OwnerSid,id,platform);cancellation.ThrowIfCancellationRequested();});
                OriginVmFacts(record,cancellation);MuRestoreOriginProof.MatchCurrent(origins.Read(id,platform),OriginFacts(origins,record,disk,seed,cancellation),OwnerSid,id,platform);
            }
        }
    }
    private static MuRestoreOriginSnapshot OriginBeforeRemoval(Dictionary<string,object> record){
        if(!OriginTracked(record)||!HasStorage(Path.Combine(UserRoot,"restore-origins")))return null;
        using(var origins=OpenOriginStore()){
            string id=Convert.ToString(record["id"]);if(!origins.Contains(id))return null;if(!record.ContainsKey("platformId"))throw new UnauthorizedAccessException("A prior origin has an unknown platform; preserved");
            string platform=Convert.ToString(record["platformId"]);var snapshot=origins.ReadSnapshot(id,platform);OriginContext(MuRestoreOriginProof.Parse(snapshot.Text,OwnerSid,id,platform),record);return snapshot;
        }
    }
    private static void RetireRemovedOrigin(Dictionary<string,object> record,MuRestoreOriginSnapshot snapshot){
        if(snapshot==null)return;
        using(var origins=OpenOriginStore()){
            string id=Convert.ToString(record["id"]),platform=Convert.ToString(record["platformId"]);
            origins.RetireAfterAbsence(snapshot,id,platform,p=>{OriginContext(p,record);var parameters=Parameters(record);var absent=Json().Deserialize<Dictionary<string,object>>(Invoke("allocation-absence",parameters,30000,CancellationToken.None));
                if(!Convert.ToBoolean(absent["absent"])||HasStorage(Convert.ToString(parameters["directory"])))throw new IOException("Exact VM, switch and storage absence is unconfirmed; origin preserved");});
        }
    }
}
