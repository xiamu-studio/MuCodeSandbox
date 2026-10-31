using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;

// Data policy only. A broker-owned, pinned Admin/SYSTEM store must establish
// provenance before using this proof. Parsing caller data never grants trust.
public static class MuRestoreOriginProof {
    public const int MaxBytes=16384;
    private static readonly string[] Fields={"format","kind","ownerSid","id","platformId","imageSha256","importDiskSha256","importDiskBytes","importSeedSha256","importSeedBytes","rootFile","diskFile","seedFile","seedSha256","cpus","memoryGiB","diskGiB"};
    private static Exception Invalid(){return new UnauthorizedAccessException("Standalone restore origin proof rejected");}
    private static void Keys(Dictionary<string,object> value,string[] keys){if(value==null||value.Count!=keys.Length||value.Keys.Any(key=>!keys.Contains(key)))throw Invalid();}
    private static string Text(Dictionary<string,object> value,string key){object item;if(!value.TryGetValue(key,out item)||!(item is string))throw Invalid();return (string)item;}
    private static long Number(Dictionary<string,object> value,string key,long min,long max){object item;if(!value.TryGetValue(key,out item)||!(item is int)&&!(item is long))throw Invalid();long number=Convert.ToInt64(item);if(number<min||number>max)throw Invalid();return number;}
    private static void Hex(string text,int length){if(text.Length!=length||text.Any(c=>!(c>='0'&&c<='9'||c>='a'&&c<='f'))||text.All(c=>c=='0'))throw Invalid();}
    private static void Id(string value){Guid id;if(!Guid.TryParseExact(value,"D",out id)||id==Guid.Empty||id.ToString("D")!=value)throw Invalid();}
    private static Dictionary<string,object> FileIdentity(Dictionary<string,object> value,string key){
        object raw;if(!value.TryGetValue(key,out raw))throw Invalid();var identity=raw as Dictionary<string,object>;Keys(identity,new[]{"fileId","birthFileTime"});
        Hex(Text(identity,"fileId"),24);string time=Text(identity,"birthFileTime");long parsed;
        if(time.Length>19||!long.TryParse(time,NumberStyles.None,CultureInfo.InvariantCulture,out parsed)||parsed<=0||parsed.ToString(CultureInfo.InvariantCulture)!=time)throw Invalid();return identity;
    }
    private static bool SameFile(Dictionary<string,object> a,Dictionary<string,object> b){return Text(a,"fileId")==Text(b,"fileId")&&Text(a,"birthFileTime")==Text(b,"birthFileTime");}
    private static bool SameField(Dictionary<string,object> a,Dictionary<string,object> b,string key){return Convert.ToString(a[key],CultureInfo.InvariantCulture)==Convert.ToString(b[key],CultureInfo.InvariantCulture);}
    // ACL policy is intentionally stricter than VM allocation storage. VM and
    // worker identities must not be allowed to author an origin receipt.
    public static void ValidateAcl(FileSystemSecurity acl){
        if(acl==null)throw Invalid();SecurityIdentifier admin=new SecurityIdentifier("S-1-5-32-544"),system=new SecurityIdentifier("S-1-5-18"),owner=(SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier));
        if(!admin.Equals(owner)&&!system.Equals(owner))throw Invalid();
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&!admin.Equals(rule.IdentityReference)&&!system.Equals(rule.IdentityReference))throw Invalid();
    }
    public static void Validate(Dictionary<string,object> value,string expectedSid,string expectedId,string expectedPlatform){
        Keys(value,Fields);Number(value,"format",1,1);if(Text(value,"kind")!="standalone-backup-origin")throw Invalid();
        string sid=Text(value,"ownerSid");try{if(new SecurityIdentifier(sid).Value!=sid||new SecurityIdentifier(expectedSid).Value!=expectedSid)throw Invalid();}catch(ArgumentException){throw Invalid();}
        Id(expectedId);Id(expectedPlatform);Id(Text(value,"id"));Id(Text(value,"platformId"));if(sid!=expectedSid||Text(value,"id")!=expectedId||Text(value,"platformId")!=expectedPlatform)throw Invalid();
        foreach(string key in new[]{"imageSha256","importDiskSha256","importSeedSha256","seedSha256"})Hex(Text(value,key),64);
        Number(value,"cpus",1,16);Number(value,"memoryGiB",2,32);long capacity=Number(value,"diskGiB",16,256)*1024L*1024*1024;
        Number(value,"importDiskBytes",1,capacity+Math.Max(64L*1024*1024,capacity/100));Number(value,"importSeedBytes",32774,8L*1024*1024);
        Dictionary<string,object> root=FileIdentity(value,"rootFile"),disk=FileIdentity(value,"diskFile"),seed=FileIdentity(value,"seedFile");
        if(SameFile(root,disk)||SameFile(root,seed)||SameFile(disk,seed))throw Invalid();
    }
    public static Dictionary<string,object> Parse(string text,string sid,string id,string platform){
        if(text==null||System.Text.Encoding.UTF8.GetByteCount(text)>MaxBytes)throw Invalid();
        var serializer=new JavaScriptSerializer{MaxJsonLength=MaxBytes,RecursionLimit=8};Dictionary<string,object> value;
        try{value=serializer.DeserializeObject(text) as Dictionary<string,object>;}catch(ArgumentException){throw Invalid();}catch(InvalidOperationException){throw Invalid();}
        Validate(value,sid,id,platform);
        // JavaScriptSerializer silently accepts duplicate JSON keys. Require
        // canonical wire bytes, also rejecting hidden fields, duplicate keys,
        // BOMs and alternative numeric spellings in durable proofs.
        if(serializer.Serialize(value)!=text)throw Invalid();return value;
    }
    public static string Encode(Dictionary<string,object> value,string sid,string id,string platform){Validate(value,sid,id,platform);string text=new JavaScriptSerializer{MaxJsonLength=MaxBytes,RecursionLimit=8}.Serialize(value);if(System.Text.Encoding.UTF8.GetByteCount(text)>MaxBytes)throw Invalid();return text;}
    public static void MatchCurrent(Dictionary<string,object> proof,Dictionary<string,object> facts,string sid,string id,string platform){
        Validate(proof,sid,id,platform);Keys(facts,new[]{"rootFile","diskFile","seedFile","seedSha256","cpus","memoryGiB","diskGiB"});
        foreach(string key in new[]{"rootFile","diskFile","seedFile"})if(!SameFile(FileIdentity(proof,key),FileIdentity(facts,key)))throw Invalid();
        foreach(string key in new[]{"seedSha256","cpus","memoryGiB","diskGiB"}){if(key=="seedSha256")Hex(Text(facts,key),64);else Number(facts,key,key=="cpus"?1:key=="memoryGiB"?2:16,key=="cpus"?16:key=="memoryGiB"?32:256);if(!SameField(proof,facts,key))throw Invalid();}
        // Current disk bytes/hash deliberately absent: normal VM writes are
        // legitimate. Origin hashes remain immutable provenance, not freshness.
    }
    public static void Transition(Dictionary<string,object> prior,Dictionary<string,object> next,string operation,string sid,string id,string platform){
        Validate(prior,sid,id,platform);Validate(next,sid,id,platform);
        foreach(string key in new[]{"ownerSid","id","platformId","imageSha256","importDiskSha256","importDiskBytes","importSeedSha256","importSeedBytes"})if(!SameField(prior,next,key))throw Invalid();
        if(!SameFile(FileIdentity(prior,"rootFile"),FileIdentity(next,"rootFile")))throw Invalid();
        if(operation=="grow"){
            foreach(string key in new[]{"diskFile","seedFile"})if(!SameFile(FileIdentity(prior,key),FileIdentity(next,key)))throw Invalid();
            foreach(string key in new[]{"seedSha256","cpus","memoryGiB"})if(!SameField(prior,next,key))throw Invalid();
            if(Convert.ToInt64(next["diskGiB"])<=Convert.ToInt64(prior["diskGiB"]))throw Invalid();
        }else if(operation!="snapshot")throw Invalid();
        // Snapshot replacement is authorized only by the broker's separately
        // verified journal. This policy alone is never permission to replace.
    }
}
