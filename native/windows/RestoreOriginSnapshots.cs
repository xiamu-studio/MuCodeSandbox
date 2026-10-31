// Snapshot decisions keep their fence until the journal-bound final file
// identities and resources have been published to the independent origin table.
public static partial class MuHyperVBroker {
    private static void OriginSnapshotEnvelope(Dictionary<string,object> origin,Dictionary<string,object> envelope){
        if(Convert.ToString(envelope["imageSha256"])!=Convert.ToString(origin["imageSha256"])||Convert.ToString(envelope["imageExtension"])!=".vhdx"||(bool)envelope["sealed"])throw new UnauthorizedAccessException("Snapshot cannot change imported source authority");
    }
    private static string CaptureSnapshotOrigin(Dictionary<string,object> record,Dictionary<string,object> envelope,CancellationToken cancellation){
        if(!OriginTracked(record))return null;
        using(var origins=OpenOriginStore())using(PinOriginAllocation(record)){
            string id=Convert.ToString(record["id"]),platform=Convert.ToString(record["platformId"]);var snapshot=origins.ReadAcceptedSnapshot(id,platform);var origin=MuRestoreOriginProof.Parse(snapshot.Text,OwnerSid,id,platform);OriginContext(origin,record);OriginSnapshotEnvelope(origin,envelope);
            var parameters=Parameters(record);var vmSid=(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",platform).Translate(typeof(SecurityIdentifier));
            using(var disk=RecoveryFile(Convert.ToString(parameters["disk"]),vmSid))using(var seed=RecoveryFile(Convert.ToString(parameters["seed"]),vmSid)){
                OriginVmFacts(record,cancellation);MuRestoreOriginProof.MatchCurrent(origin,OriginFacts(origins,record,disk,seed,cancellation),OwnerSid,id,platform);cancellation.ThrowIfCancellationRequested();
                return Json().Serialize(new Dictionary<string,object>{{"version",1},{"text",snapshot.Text},{"token",snapshot.Token},{"next",null}});
            }
        }
    }
    private static void OriginSnapshotJournal(Dictionary<string,object> record,MuOfflineSnapshotStore store,MuOfflineSnapshotStore.Restore journal){
        var actual=store.Pending();
        var serializer=new JavaScriptSerializer{MaxJsonLength=2*1024*1024,RecursionLimit=16};
        if(actual==null||journal.environmentId!=Convert.ToString(record["id"])||!new[]{"committed","rolled-back"}.Contains(journal.phase)||serializer.Serialize(actual)!=serializer.Serialize(journal))throw new UnauthorizedAccessException("Final protected snapshot journal changed");
    }
    private static void OriginSnapshotBytes(MuOfflineSnapshotStore.Restore journal,FileStream disk,FileStream seed){
        var files=journal.phase=="rolled-back"?journal.previous:journal.files;
        foreach(string key in new[]{"disk","seed"}){
            var expected=files.Single(file=>file.key==key);var input=key=="disk"?disk:seed;input.Position=0;
            if(input.Length!=expected.bytes||RecoveryHash(input,CancellationToken.None)!=expected.sha256)throw new UnauthorizedAccessException("Final snapshot bytes differ from protected journal");
        }
    }
    private static MuOfflineSnapshotStore.Restore FinishSnapshotOrigin(Dictionary<string,object> record,MuOfflineSnapshotStore store,MuOfflineSnapshotStore.Restore journal){
        if(!OriginTracked(record)){if(journal.origin!=null)throw new UnauthorizedAccessException("Snapshot origin tracking changed");return journal;}
        if(journal.origin==null||Encoding.UTF8.GetByteCount(journal.origin)>65536)throw new UnauthorizedAccessException("Snapshot origin binding is missing; fence preserved");
        OriginSnapshotJournal(record,store,journal);
        var binding=Json().DeserializeObject(journal.origin) as Dictionary<string,object>;if(binding==null)throw new UnauthorizedAccessException("Snapshot origin binding rejected");ValidateKeys(binding,"version","text","token","next");
        if(binding.Count!=4||Number(binding,"version",1,1)!=1||!(binding["text"] is string)||!(binding["token"] is string)||binding["next"]!=null&&!(binding["next"] is string)||Json().Serialize(binding)!=journal.origin)throw new UnauthorizedAccessException("Snapshot origin encoding rejected");
        string id=Convert.ToString(record["id"]),platform=Convert.ToString(record["platformId"]);Digest(binding,"token");var original=new MuRestoreOriginSnapshot((string)binding["text"],(string)binding["token"]);var prior=MuRestoreOriginProof.Parse(original.Text,OwnerSid,id,platform);OriginContext(prior,record);
        var before=SnapshotEnvelope(record,journal.previousConfiguration,true);var after=SnapshotEnvelope(record,journal.phase=="rolled-back"?journal.previousConfiguration:journal.configuration,true);OriginSnapshotEnvelope(prior,before);OriginSnapshotEnvelope(prior,after);SnapshotRegisteredResources(record,after);
        foreach(string key in new[]{"cpus","memoryGiB","diskGiB"})if(Convert.ToInt64(prior[key])!=Convert.ToInt64(before[key]))throw new UnauthorizedAccessException("Snapshot original resources differ from origin binding");
        using(var origins=OpenOriginStore())using(PinOriginAllocation(record)){
            var parameters=Parameters(record);var vmSid=(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",platform).Translate(typeof(SecurityIdentifier));
            using(var disk=RecoveryFile(Convert.ToString(parameters["disk"]),vmSid))using(var seed=RecoveryFile(Convert.ToString(parameters["seed"]),vmSid)){
                OriginSnapshotBytes(journal,disk,seed);OriginVmFacts(record,CancellationToken.None);var facts=OriginFacts(origins,record,disk,seed,CancellationToken.None);var next=MuRestoreOriginProof.Parse(original.Text,OwnerSid,id,platform);
                foreach(string key in new[]{"rootFile","diskFile","seedFile","seedSha256","cpus","memoryGiB","diskGiB"})next[key]=facts[key];MuRestoreOriginProof.Transition(prior,next,"snapshot",OwnerSid,id,platform);
                string nextText=MuRestoreOriginProof.Encode(next,OwnerSid,id,platform);
                if(binding["next"]!=null&&Convert.ToString(binding["next"])!=nextText)throw new UnauthorizedAccessException("Planned snapshot origin differs; fence preserved");
                if(binding["next"]==null){binding["next"]=nextText;journal=store.BindRestoreOrigin(journal.id,journal.origin,Json().Serialize(binding));}
                var bound=journal;
                origins.Update(original,next,"snapshot",id,platform,p=>{OriginSnapshotJournal(record,store,bound);OriginSnapshotBytes(bound,disk,seed);OriginVmFacts(record,CancellationToken.None);MuRestoreOriginProof.MatchCurrent(p,OriginFacts(origins,record,disk,seed,CancellationToken.None),OwnerSid,id,platform);});
                OriginSnapshotJournal(record,store,bound);OriginVmFacts(record,CancellationToken.None);MuRestoreOriginProof.MatchCurrent(origins.Read(id,platform),OriginFacts(origins,record,disk,seed,CancellationToken.None),OwnerSid,id,platform);return journal;
            }
        }
    }
}
