using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
public static class MuOriginStoreFixture {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool CreateHardLink(string link,string target,IntPtr attributes);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool DeleteFile(string path);
    private static void WriteAds(string path){using(var handle=CreateFile(path,0x40000000,3,IntPtr.Zero,1,0,IntPtr.Zero)){if(handle.IsInvalid)throw new Exception("ADS fixture failed");using(var stream=new FileStream(handle,FileAccess.Write)){var bytes=System.Text.Encoding.UTF8.GetBytes("preserve stream");stream.Write(bytes,0,bytes.Length);}}}
    private static string ReadAds(string path){using(var handle=CreateFile(path,0x80000000,3,IntPtr.Zero,3,0,IntPtr.Zero))using(var stream=new FileStream(handle,FileAccess.Read))using(var reader=new StreamReader(stream))return reader.ReadToEnd();}
    private const string Id="11111111-1111-4111-8111-111111111111",Platform="22222222-2222-4222-8222-222222222222";
    private static readonly List<object> Results=new List<object>();
    private static string Sid;
    private static int Validations;
    private static void Check(string name,bool reject,Action action){bool rejected=false;Exception detail=null;try{action();}catch(Exception error){if(!(error is IOException)&&!(error is UnauthorizedAccessException)&&!(error is System.Text.DecoderFallbackException))throw;rejected=true;detail=error;}if(rejected!=reject)throw new Exception("Origin store fixture failed: "+name,detail);Results.Add(new{name=name,passed=true,rejected=rejected});}
    private static string Hash(string path){using(var file=File.OpenRead(path))using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(file)).Replace("-","").ToLowerInvariant();}
    private static Dictionary<string,object> Identity(string path){using(var file=File.OpenRead(path))return MuRestoreOriginStore.CaptureIdentity(file.SafeFileHandle);}
    private static Dictionary<string,object> Proof(MuRestoreOriginStore store,string root){
        string disk=Path.Combine(root,"disk.synthetic"),seed=Path.Combine(root,"seed.synthetic");File.WriteAllBytes(disk,new byte[16]);File.WriteAllBytes(seed,new byte[32774]);
        return new Dictionary<string,object>{{"format",1},{"kind","standalone-backup-origin"},{"ownerSid",Sid},{"id",Id},{"platformId",Platform},{"imageSha256",new string('a',64)},{"importDiskSha256",Hash(disk)},{"importDiskBytes",16},{"importSeedSha256",Hash(seed)},{"importSeedBytes",32774},{"rootFile",store.RootIdentity},{"diskFile",Identity(disk)},{"seedFile",Identity(seed)},{"seedSha256",Hash(seed)},{"cpus",2},{"memoryGiB",4},{"diskGiB",32}};
    }
    private static Action<Microsoft.Win32.SafeHandles.SafeFileHandle,bool> Transport=(handle,directory)=>{if(handle.IsInvalid||handle.IsClosed)throw new Exception("Invalid handle");Validations++;};
    private static string DataPath(string root){return Path.Combine(root,"restore-origins",".lock");}
    private static Dictionary<string,object> Parse(string text){return MuRestoreOriginProof.Parse(text,Sid,Id,Platform);}
    private static MuRestoreOriginStore Open(string root,Action<string> point=null){return new MuRestoreOriginStore(root,Sid,Transport,point);}
    private static void Publish(MuRestoreOriginStore store,Dictionary<string,object> proof,string id,string platform){store.PublishInitial(proof,id,platform);store.AcceptInitial(store.ReadSnapshot(id,platform),id,platform,p=>{});}
    private static void Prepare(string root){Directory.CreateDirectory(Path.Combine(root,"restore-origins"));}
    private static void FlipSlot(string root,bool both){string file=DataPath(root);var bytes=File.ReadAllBytes(file);int a=BitConverter.ToInt64(bytes,8)>BitConverter.ToInt64(bytes,MuRestoreOriginStore.SlotBytes+8)?0:1;bytes[a*MuRestoreOriginStore.SlotBytes+MuRestoreOriginStore.HeaderBytes+10]^=1;if(both)bytes[(1-a)*MuRestoreOriginStore.SlotBytes+MuRestoreOriginStore.HeaderBytes+10]^=1;File.WriteAllBytes(file,bytes);}
    public static string Run(string root){
        Sid=WindowsIdentity.GetCurrent().User.Value;Prepare(root);string directory=Path.Combine(root,"restore-origins");
        string existing=Path.Combine(root,"existing-only");Prepare(existing);Check("existing-only session never creates absent storage",true,()=>{using(var invalid=new MuRestoreOriginStore(existing,Sid,Transport,null,true)){};});if(File.Exists(DataPath(existing)))throw new Exception("Missing table silently initialized");
        File.WriteAllBytes(DataPath(existing),new byte[0]);Check("existing-only session never initializes empty storage",true,()=>{using(var invalid=new MuRestoreOriginStore(existing,Sid,Transport,null,true)){};});if(new FileInfo(DataPath(existing)).Length!=0)throw new Exception("Empty table silently initialized");
        Check("default authority rejects ordinary root",true,()=>{using(var rejected=new MuRestoreOriginStore(root,Sid)){};});
        string acceptance=Path.Combine(root,"acceptance");Prepare(acceptance);using(var store=Open(acceptance)){
            var proof=Proof(store,acceptance);store.PublishInitial(proof,Id,Platform);var pending=store.ReadSnapshot(Id,Platform);if(pending.Accepted)throw new Exception("Initial receipt silently accepted");
            Check("pending import is not recovery authority",true,()=>store.ReadAcceptedSnapshot(Id,Platform));var grow=Parse(pending.Text);grow["diskGiB"]=64;
            Check("pending import cannot update lifecycle",true,()=>store.Update(pending,grow,"grow",Id,Platform,p=>{}));
            Check("failed final verification remains pending",true,()=>store.AcceptInitial(pending,Id,Platform,p=>{throw new IOException("Final VM check failed");}));if(store.ReadSnapshot(Id,Platform).Accepted)throw new Exception("Failed acceptance committed");
            Check("final import acceptance commits",false,()=>store.AcceptInitial(pending,Id,Platform,p=>{}));var accepted=store.ReadAcceptedSnapshot(Id,Platform);if(!accepted.Accepted||accepted.Token==pending.Token)throw new Exception("Acceptance did not change trust version");
            Check("accepted recovery authority reads back",false,()=>store.ReadAcceptedSnapshot(Id,Platform));int verified=0;Check("lost acceptance reply revalidates without rewriting",false,()=>store.AcceptInitial(pending,Id,Platform,p=>verified++));if(verified!=1||store.ReadSnapshot(Id,Platform).Token!=accepted.Token)throw new Exception("Acceptance retry skipped verification or changed version");
            Check("pending token cannot retire accepted import",true,()=>store.RetireAfterAbsence(pending,Id,Platform,p=>{}));Check("publication retry never downgrades acceptance",false,()=>store.PublishInitial(proof,Id,Platform));if(!store.ReadSnapshot(Id,Platform).Accepted)throw new Exception("Accepted import downgraded");
            var changed=Parse(pending.Text);changed["importDiskSha256"]=new string('e',64);Check("different acceptance intent refused",true,()=>store.AcceptInitial(new MuRestoreOriginSnapshot(MuRestoreOriginProof.Encode(changed,Sid,Id,Platform),pending.Token),Id,Platform,p=>{}));
        }
        string oldFormat=Path.Combine(root,"legacy-table");Prepare(oldFormat);using(var store=Open(oldFormat)){}var legacyBytes=File.ReadAllBytes(DataPath(oldFormat));foreach(int slot in new[]{0,1})System.Text.Encoding.ASCII.GetBytes("MUORIG02").CopyTo(legacyBytes,slot*MuRestoreOriginStore.SlotBytes);File.WriteAllBytes(DataPath(oldFormat),legacyBytes);Check("old table format is not auto accepted",true,()=>{using(var invalid=Open(oldFormat)){};});if(!legacyBytes.SequenceEqual(File.ReadAllBytes(DataPath(oldFormat))))throw new Exception("Legacy table changed");
        using(var store=Open(root)){
            var proof=Proof(store,root);Publish(store,proof,Id,Platform);var initial=store.ReadSnapshot(Id,Platform);
            Check("initial readback",false,()=>store.Read(Id,Platform));Check("exact retry",false,()=>Publish(store,proof,Id,Platform));if(initial.Token!=store.ReadSnapshot(Id,Platform).Token)throw new Exception("Retry changed nonce");
            var grow=Parse(initial.Text);grow["diskGiB"]=64;var forged=Parse(initial.Text);forged["importDiskSha256"]=new string('e',64);
            Check("conflicting initial cannot replace",true,()=>Publish(store,forged,Id,Platform));
            Check("exclusive OS lock",true,()=>{using(var other=Open(root)){};});Check("root pinned",true,()=>Directory.Move(root,root+"-moved"));
            Check("path id rejected",true,()=>store.Read("../other",Platform));Check("platform mismatch",true,()=>store.Read(Id,Id));
            WriteAds(directory+":extra");Check("directory ADS rejected",true,()=>store.Read(Id,Platform));DeleteFile(directory+":extra");WriteAds(root+":extra");Check("root ADS rejected",true,()=>store.Read(Id,Platform));DeleteFile(root+":extra");
            string unknown=Path.Combine(directory,"unknown.keep");File.WriteAllText(unknown,"preserve");Check("unknown filename retained",true,()=>store.Read(Id,Platform));if(File.ReadAllText(unknown)!="preserve")throw new Exception("Unknown changed");File.Delete(unknown);
            string legacy=Path.Combine(directory,Id+".json");File.WriteAllText(legacy,initial.Text);Check("legacy receipt not auto migrated",true,()=>store.Read(Id,Platform));File.Delete(legacy);
            string orphan=Path.Combine(directory,".origin-unowned.next");File.WriteAllText(orphan,"preserve");Check("unknown orphan not adopted",true,()=>store.Read(Id,Platform));File.Delete(orphan);
            Check("journal failure keeps prior table",true,()=>store.Update(initial,grow,"grow",Id,Platform,p=>{throw new IOException("Journal unavailable");}));
            Check("growth commits",false,()=>store.Update(initial,grow,"grow",Id,Platform,p=>{if(Convert.ToInt32(p["diskGiB"])!=64)throw new IOException("Unexpected capacity");}));
            var grown=store.ReadSnapshot(Id,Platform);Check("lost reply does not rewrite",false,()=>store.Update(initial,grow,"grow",Id,Platform,p=>{}));if(grown.Token!=store.ReadSnapshot(Id,Platform).Token)throw new Exception("Retry changed version");
            var later=Parse(grown.Text);later["diskGiB"]=96;Check("stale update refused",true,()=>store.Update(initial,later,"grow",Id,Platform,p=>{}));
            Check("provenance cannot change",true,()=>store.Update(grown,forged,"snapshot",Id,Platform,p=>{}));Check("unknown operation refused",true,()=>store.Update(grown,later,"replace",Id,Platform,p=>{}));
            Check("snapshot rollback commits",false,()=>store.Update(grown,proof,"snapshot",Id,Platform,p=>{}));var rolled=store.ReadSnapshot(Id,Platform);if(rolled.Text!=initial.Text||rolled.Token==initial.Token)throw new Exception("ABA version was revived");
            Check("ABA stale update refused",true,()=>store.Update(initial,grow,"grow",Id,Platform,p=>{}));Check("ABA stale retirement refused",true,()=>store.RetireAfterAbsence(initial,Id,Platform,p=>{}));
            Check("absence failure retains",true,()=>store.RetireAfterAbsence(rolled,Id,Platform,p=>{throw new IOException("VM not absent");}));Check("retirement commits",false,()=>store.RetireAfterAbsence(rolled,Id,Platform,p=>{}));
            Check("retirement retry verifies",false,()=>{int count=0;if(store.RetireAfterAbsence(rolled,Id,Platform,p=>count++)||count!=1)throw new Exception("Absent retry skipped verifier");});
            Check("missing retirement absence failure",true,()=>store.RetireAfterAbsence(rolled,Id,Platform,p=>{throw new IOException("Missing facts");}));
            Check("publish after retirement",false,()=>Publish(store,proof,Id,Platform));
            for(int i=0;i<31;i++){string id=Guid.NewGuid().ToString("D");var p=Parse(initial.Text);p["id"]=id;Publish(store,p,id,Platform);}
            string excess=Guid.NewGuid().ToString("D");var extra=Parse(initial.Text);extra["id"]=excess;Check("32 record quota",true,()=>Publish(store,extra,excess,Platform));Check("existing read at quota",false,()=>store.Read(Id,Platform));
            Check("reentrant verifier cannot overwrite newer table",true,()=>{var snap=store.ReadSnapshot(Id,Platform);var next=Parse(snap.Text);next["diskGiB"]=64;store.Update(snap,next,"grow",Id,Platform,p=>store.RetireAfterAbsence(snap,Id,Platform,q=>{}));});
            Check("newer retirement preserved",true,()=>store.Read(Id,Platform));
        }
        string alias=Path.Combine(root,"alias");if(!CreateHardLink(alias,DataPath(root),IntPtr.Zero))throw new Exception("Hardlink fixture unavailable");Check("table hardlink rejected",true,()=>{using(var invalid=Open(root)){};});File.Delete(alias);
        WriteAds(DataPath(root)+":extra");Check("table ADS rejected",true,()=>{using(var invalid=Open(root)){};});if(ReadAds(DataPath(root)+":extra")!="preserve stream")throw new Exception("ADS removed");DeleteFile(DataPath(root)+":extra");
        foreach(string phase in new[]{"frame-invalidated","frame-data","frame-committed"}){
            string scenario=Path.Combine(root,phase);Prepare(scenario);bool enabled=false;using(var store=Open(scenario,p=>{if(enabled&&p==phase)throw new IOException("Synthetic interruption "+p);})){
                var proof=Proof(store,scenario);Publish(store,proof,Id,Platform);var original=store.ReadSnapshot(Id,Platform);var grow=Parse(original.Text);grow["diskGiB"]=64;enabled=true;Check("interrupted update "+phase,true,()=>store.Update(original,grow,"grow",Id,Platform,p=>{}));enabled=false;
                var current=store.ReadSnapshot(Id,Platform);if(Convert.ToInt32(Parse(current.Text)["diskGiB"])!=(phase=="frame-committed"?64:32))throw new Exception("Torn state accepted");Check("same intent retries "+phase,false,()=>store.Update(original,grow,"grow",Id,Platform,p=>{}));
                if(Directory.EnumerateFileSystemEntries(Path.Combine(scenario,"restore-origins")).Count()!=1||new FileInfo(DataPath(scenario)).Length!=2L*MuRestoreOriginStore.SlotBytes)throw new Exception("Unbounded files created");
            }
        }
        string corrupt=Path.Combine(root,"corrupt");Prepare(corrupt);MuRestoreOriginSnapshot baseline;Dictionary<string,object> desired;
        using(var store=Open(corrupt)){var originalProof=Proof(store,corrupt);Publish(store,originalProof,Id,Platform);baseline=store.ReadSnapshot(Id,Platform);desired=Parse(baseline.Text);desired["diskGiB"]=64;store.Update(baseline,desired,"grow",Id,Platform,p=>{});}
        FlipSlot(corrupt,false);using(var store=Open(corrupt)){Check("one corrupt slot falls back",false,()=>{if(Convert.ToInt32(store.Read(Id,Platform)["diskGiB"])!=32)throw new Exception("Wrong fallback");});store.Update(baseline,desired,"grow",Id,Platform,p=>{});}
        FlipSlot(corrupt,true);var preserved=File.ReadAllBytes(DataPath(corrupt));Check("both corrupt slots preserved",true,()=>{using(var invalid=Open(corrupt)){};});if(!preserved.SequenceEqual(File.ReadAllBytes(DataPath(corrupt))))throw new Exception("Corrupt table changed");
        string cloned=Path.Combine(root,"copied");Prepare(cloned);File.Copy(DataPath(root),DataPath(cloned));Check("copied table root/file binding refused",true,()=>{using(var invalid=Open(cloned)){};});
        string recursive=Path.Combine(root,"recursive");Prepare(recursive);MuRestoreOriginStore active=null;bool enter=false;Dictionary<string,object> another=null;
        using(active=Open(recursive,p=>{if(enter&&p=="frame-data"){enter=false;Check("recursive writer is rejected",true,()=>Publish(active,another,(string)another["id"],Platform));}})){
            var p=Proof(active,recursive);Publish(active,p,Id,Platform);var snap=active.ReadSnapshot(Id,Platform);another=Parse(snap.Text);another["id"]=Guid.NewGuid().ToString("D");p["diskGiB"]=64;enter=true;active.Update(snap,p,"grow",Id,Platform,q=>{});
        }
        string init=Path.Combine(root,"torn-init");Prepare(init);Check("interrupted initialization fenced",true,()=>{using(var store=Open(init,p=>{if(p=="initialized-length")throw new IOException("Initial length only");})){};});Check("no complete initial slot cannot be guessed empty",true,()=>{using(var invalid=Open(init)){};});
        return new JavaScriptSerializer().Serialize(new{complete=true,checks=Results,realWindowsFilesystem=true,realHyperV=false,trustedAclPublication=false,scope="Fixed-slot native receipt storage; positive ACL and journal/VM facts isolated, no live VM acceptance"});
    }
    public static string Worker(string root,string mode,string phase){
        Sid=WindowsIdentity.GetCurrent().User.Value;Prepare(root);string input=Path.Combine(root,"intent.fixture");
        if(mode=="setup"||mode=="setup-empty"||mode=="setup-pending"){
            using(var store=Open(root)){var p=Proof(store,root);MuRestoreOriginSnapshot snapshot=null;if(mode=="setup"||mode=="setup-pending"){if(mode=="setup")Publish(store,p,Id,Platform);else store.PublishInitial(p,Id,Platform);snapshot=store.ReadSnapshot(Id,Platform);}File.WriteAllText(input,new JavaScriptSerializer().Serialize(new{proof=MuRestoreOriginProof.Encode(p,Sid,Id,Platform),text=snapshot==null?null:snapshot.Text,token=snapshot==null?null:snapshot.Token}));}return "{\"complete\":true}";
        }
        var saved=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(input));var proof=Parse((string)saved["proof"]);var expected=new MuRestoreOriginSnapshot(saved["text"] as string,saved["token"] as string);
        if(mode=="recover"){
            using(var store=Open(root)){bool present,accepted=false;int capacity=0;try{capacity=Convert.ToInt32(store.Read(Id,Platform)["diskGiB"]);present=true;accepted=store.ReadSnapshot(Id,Platform).Accepted;}catch(IOException){present=false;}return new JavaScriptSerializer().Serialize(new{complete=true,present=present,capacity=capacity,accepted=accepted});}
        }
        using(var store=Open(root,p=>{if(p==phase){Console.WriteLine("ORIGIN_CHECKPOINT:"+p);Console.Out.Flush();Console.ReadLine();}})){
            if(mode=="publish")Publish(store,proof,Id,Platform);else if(mode=="accept")store.AcceptInitial(expected,Id,Platform,p=>{});else if(mode=="update"){proof["diskGiB"]=64;store.Update(expected,proof,"grow",Id,Platform,p=>{});}else if(mode=="retire")store.RetireAfterAbsence(expected,Id,Platform,p=>{});else throw new ArgumentException("Unknown worker");
        }return "{\"complete\":true}";
    }
}
