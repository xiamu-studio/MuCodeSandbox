public static class MuOriginProofFixture {
    private const string Sid="S-1-5-21-1-2-3-1001",Id="11111111-1111-4111-8111-111111111111",Platform="22222222-2222-4222-8222-222222222222";
    private static readonly List<object> Results=new List<object>();
    private static Dictionary<string,object> File(string hex){return new Dictionary<string,object>{{"fileId",hex.PadLeft(24,'0')},{"birthFileTime","133000000000000000"}};}
    private static Dictionary<string,object> Proof(){return new Dictionary<string,object>{{"format",1},{"kind","standalone-backup-origin"},{"ownerSid",Sid},{"id",Id},{"platformId",Platform},{"imageSha256",new string('a',64)},{"importDiskSha256",new string('b',64)},{"importDiskBytes",49153},{"importSeedSha256",new string('c',64)},{"importSeedBytes",32774},{"rootFile",File("1")},{"diskFile",File("2")},{"seedFile",File("3")},{"seedSha256",new string('c',64)},{"cpus",2},{"memoryGiB",4},{"diskGiB",32}};}
    private static Dictionary<string,object> Clone(Dictionary<string,object> proof){return MuRestoreOriginProof.Parse(MuRestoreOriginProof.Encode(proof,Sid,Id,Platform),Sid,Id,Platform);}
    private static Dictionary<string,object> Facts(Dictionary<string,object> proof){return proof.Where(pair=>new[]{"rootFile","diskFile","seedFile","seedSha256","cpus","memoryGiB","diskGiB"}.Contains(pair.Key)).ToDictionary(pair=>pair.Key,pair=>pair.Value);}
    private static void Check(string name,bool reject,Action action){bool rejected=false;try{action();}catch(UnauthorizedAccessException){rejected=true;}if(rejected!=reject)throw new Exception("Origin proof fixture failed: "+name);Results.Add(new {name=name,passed=true,rejected=rejected});}
    private static void Mutate(string name,Action<Dictionary<string,object>> mutate){var proof=Proof();mutate(proof);Check(name,true,()=>MuRestoreOriginProof.Validate(proof,Sid,Id,Platform));}
    public static string Run(){
        Check("canonical roundtrip",false,()=>Clone(Proof()));
        foreach(string field in Proof().Keys.ToArray()){string key=field;Mutate("missing "+key,p=>p.Remove(key));}
        Mutate("unknown path",p=>p["path"]="C:\\untrusted");Mutate("wrong format",p=>p["format"]=2);Mutate("wrong kind",p=>p["kind"]="restore-work");
        Mutate("owner mismatch",p=>p["ownerSid"]="S-1-5-21-1-2-3-1002");Mutate("noncanonical SID",p=>p["ownerSid"]="S-01-5-18");
        Mutate("identity mismatch",p=>p["id"]=Platform);Mutate("platform mismatch",p=>p["platformId"]=Id);Mutate("empty UUID",p=>p["platformId"]=Guid.Empty.ToString());
        foreach(string key in new[]{"imageSha256","importDiskSha256","importSeedSha256","seedSha256"}){string field=key;Mutate("uppercase "+key,p=>p[field]=new string('A',64));Mutate("zero "+key,p=>p[field]=new string('0',64));}
        foreach(object value in new object[]{true,"2",2.5,0,17}){object item=value;Mutate("cpu type or bound "+Convert.ToString(item,CultureInfo.InvariantCulture),p=>p["cpus"]=item);}
        Mutate("excess disk bytes",p=>p["importDiskBytes"]=40L*1024*1024*1024);Mutate("short seed",p=>p["importSeedBytes"]=32773);Mutate("large seed",p=>p["importSeedBytes"]=8L*1024*1024+1);
        Mutate("same disk seed",p=>p["seedFile"]=p["diskFile"]);Mutate("same root disk",p=>p["diskFile"]=p["rootFile"]);
        Mutate("file identity unknown field",p=>((Dictionary<string,object>)p["diskFile"])["path"]="disk.vhdx");
        Mutate("birth leading zero",p=>((Dictionary<string,object>)p["diskFile"])["birthFileTime"]="0133");Mutate("birth zero",p=>((Dictionary<string,object>)p["diskFile"])["birthFileTime"]="0");
        string encoded=MuRestoreOriginProof.Encode(Proof(),Sid,Id,Platform);
        Check("duplicate JSON key",true,()=>MuRestoreOriginProof.Parse(encoded.Insert(1,"\"format\":1,"),Sid,Id,Platform));
        Check("noncanonical JSON number",true,()=>MuRestoreOriginProof.Parse(encoded.Replace("\"cpus\":2","\"cpus\":2.0"),Sid,Id,Platform));
        Check("oversized bytes",true,()=>MuRestoreOriginProof.Parse(new string('中',MuRestoreOriginProof.MaxBytes),Sid,Id,Platform));
        Check("truncated JSON",true,()=>MuRestoreOriginProof.Parse(encoded.Substring(0,encoded.Length-1),Sid,Id,Platform));
        Check("ordinary runtime writes need no original disk hash",false,()=>MuRestoreOriginProof.MatchCurrent(Proof(),Facts(Proof()),Sid,Id,Platform));
        foreach(string key in new[]{"rootFile","diskFile","seedFile"}){var facts=Facts(Proof());facts[key]=File("4");Check("current replaced "+key,true,()=>MuRestoreOriginProof.MatchCurrent(Proof(),facts,Sid,Id,Platform));}
        foreach(string key in new[]{"seedSha256","cpus","memoryGiB","diskGiB"}){var facts=Facts(Proof());facts[key]=key=="seedSha256"?(object)new string('d',64):16;Check("current changed "+key,true,()=>MuRestoreOriginProof.MatchCurrent(Proof(),facts,Sid,Id,Platform));}
        var grow=Proof();grow["diskGiB"]=64;Check("legitimate growth",false,()=>MuRestoreOriginProof.Transition(Proof(),grow,"grow",Sid,Id,Platform));
        Check("growth cannot shrink",true,()=>MuRestoreOriginProof.Transition(grow,Proof(),"grow",Sid,Id,Platform));
        Check("growth cannot keep same size",true,()=>MuRestoreOriginProof.Transition(Proof(),Proof(),"grow",Sid,Id,Platform));
        foreach(string key in new[]{"diskFile","seedFile","rootFile"}){var changed=Clone(grow);changed[key]=File("4");Check("growth changed "+key,true,()=>MuRestoreOriginProof.Transition(Proof(),changed,"grow",Sid,Id,Platform));}
        var snapshot=Proof();snapshot["diskFile"]=File("4");snapshot["seedFile"]=File("5");snapshot["seedSha256"]=new string('d',64);snapshot["cpus"]=4;snapshot["diskGiB"]=64;
        Check("verified snapshot replacement",false,()=>MuRestoreOriginProof.Transition(Proof(),snapshot,"snapshot",Sid,Id,Platform));
        Check("verified snapshot rollback",false,()=>MuRestoreOriginProof.Transition(snapshot,Proof(),"snapshot",Sid,Id,Platform));
        var forged=Clone(snapshot);forged["importDiskSha256"]=new string('e',64);Check("snapshot cannot rewrite provenance",true,()=>MuRestoreOriginProof.Transition(Proof(),forged,"snapshot",Sid,Id,Platform));
        Check("unknown transition",true,()=>MuRestoreOriginProof.Transition(Proof(),snapshot,"adopt-current-files",Sid,Id,Platform));
        SecurityIdentifier admin=new SecurityIdentifier("S-1-5-32-544"),system=new SecurityIdentifier("S-1-5-18");
        var acl=new FileSecurity();acl.SetOwner(admin);acl.SetAccessRuleProtection(true,false);acl.AddAccessRule(new FileSystemAccessRule(admin,FileSystemRights.FullControl,AccessControlType.Allow));acl.AddAccessRule(new FileSystemAccessRule(system,FileSystemRights.FullControl,AccessControlType.Allow));
        Check("protected origin ACL",false,()=>MuRestoreOriginProof.ValidateAcl(acl));
        foreach(string sid in new[]{Sid,"S-1-5-83-0","S-1-1-0","S-1-5-83-1-1-2-3-4-5"}){var changed=new FileSecurity();changed.SetSecurityDescriptorBinaryForm(acl.GetSecurityDescriptorBinaryForm());changed.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.Read,AccessControlType.Allow));Check("nonprivileged ACE "+sid,true,()=>MuRestoreOriginProof.ValidateAcl(changed));}
        acl.SetOwner(new SecurityIdentifier(Sid));Check("ordinary owner rejected",true,()=>MuRestoreOriginProof.ValidateAcl(acl));
        return new JavaScriptSerializer().Serialize(new {complete=true,checks=Results,realHyperV=false,realStorage=false,scope="Compiled data and ACL policy only; no receipt store or recovery acceptance enabled"});
    }
}
