using System;using System.IO;using System.Linq;using System.Text;using System.Collections.Generic;using System.Threading;using System.Runtime.InteropServices;using System.Security.Principal;using System.Security.AccessControl;using System.Security.Cryptography;using System.Web.Script.Serialization;
// Real RecoveryAction/ledger/origin code and Windows file identities. VM facts
// and ACL authority are explicit adapters; no real VM, elevation or IPC.
public static class FixtureAcl {
 public static FileSecurity File(){var acl=new FileSecurity();acl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));foreach(string sid in new[]{"S-1-5-32-544","S-1-5-18"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));return acl;}
 public static DirectorySecurity Directory(){var acl=new DirectorySecurity();acl.SetSecurityDescriptorBinaryForm(File().GetSecurityDescriptorBinaryForm());return acl;}
}
public static class File {
 public static FileAttributes GetAttributes(string p){return System.IO.File.GetAttributes(p);}public static bool Exists(string p){return System.IO.File.Exists(p);}public static FileSecurity GetAccessControl(string p){return FixtureAcl.File();}
 public static void Copy(string a,string b,bool overwrite){System.IO.File.Copy(a,b,overwrite);}public static void Delete(string p){System.IO.File.Delete(p);}public static void Move(string a,string b){System.IO.File.Move(a,b);}public static void Replace(string a,string b,string c){System.IO.File.Replace(a,b,c);}
 public static void AppendAllText(string p,string text){System.IO.File.AppendAllText(p,text);}
 public static FileStream OpenRead(string p){throw new InvalidOperationException("Non-recovery file read entered");}
}
public static class Directory {
 public static bool Exists(string p){return System.IO.Directory.Exists(p);}public static DirectoryInfo CreateDirectory(string p){return System.IO.Directory.CreateDirectory(p);}public static DirectorySecurity GetAccessControl(string p){return FixtureAcl.Directory();}public static IEnumerable<string> EnumerateFileSystemEntries(string p){return System.IO.Directory.EnumerateFileSystemEntries(p);}
 public static string[] GetFiles(string p){return System.IO.Directory.GetFiles(p);}
}
public sealed class NTAccount {public NTAccount(string domain,string name){Guid id;if(domain!="NT VIRTUAL MACHINE"||!Guid.TryParseExact(name,"D",out id))throw new UnauthorizedAccessException("Synthetic platform changed");}public IdentityReference Translate(Type t){return new SecurityIdentifier("S-1-5-83-1-1-2-3-4-5");}}
public sealed class MuStorageException:IOException {public string Code;public MuStorageException(string code,string message):base(message){Code=code;}}
public static class MuResourcePolicy {public static void Quota(long current,long capacity){if(current+capacity>1024)throw new IOException("Quota exceeded");}}
public static partial class MuHyperVBroker {
 static readonly object Gate=new object(),ImportGate=new object();static readonly Dictionary<string,Dictionary<string,object>> Records=new Dictionary<string,Dictionary<string,object>>();
 static string UserRoot,OwnerSid="S-1-5-21-1-2-3-1001",CanonicalBuilderDigest=new string('f',64),ReturnedPlatform;static MuProtectedLedger LedgerStore;static int VmCapacity=32,Reviews;static bool ChangeVm,RejectVm;
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateFile(string p,uint a,uint s,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
 sealed class HandleOwner:IDisposable {IntPtr h;public HandleOwner(IntPtr value){h=value;}public void Dispose(){if(h!=IntPtr.Zero){CloseHandle(h);h=IntPtr.Zero;}}}
 static JavaScriptSerializer Json(){return new JavaScriptSerializer{MaxJsonLength=1048576,RecursionLimit=16};}
 static object VmGate(string id){return Gate;}static IDisposable ImportReservation(){return new MemoryStream();}static void CheckPower(){}
 static void ValidateKeys(Dictionary<string,object> v,params string[] keys){if(v.Keys.Except(keys).Any())throw new ArgumentException("Unknown request field");}
 static string Text(Dictionary<string,object> v,string key,int max){object item;if(!v.TryGetValue(key,out item)||!(item is string)||((string)item).Length<1||((string)item).Length>max||((string)item).IndexOf('\0')>=0)throw new ArgumentException("Text rejected");return (string)item;}
 static int Number(Dictionary<string,object> v,string key,int min,int max){object n;if(!v.TryGetValue(key,out n)||!(n is int)&&!(n is long)||Convert.ToInt64(n)<min||Convert.ToInt64(n)>max)throw new ArgumentException("Number rejected");return Convert.ToInt32(n);}
 static string Id(Dictionary<string,object> v){string id=Text(v,"id",36);if(Guid.Parse(id).ToString("D")!=id)throw new ArgumentException("ID rejected");return id;}
 static string Digest(Dictionary<string,object> v,string key){string digest=Text(v,key,64);if(digest.Length!=64||digest.Any(c=>!"0123456789abcdef".Contains(c)))throw new ArgumentException("Digest rejected");return digest;}
 static void PathCheck(string p){if(!Path.GetFullPath(p).StartsWith(UserRoot+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new UnauthorizedAccessException("Fixture root escaped");}
 static bool HasStorage(string p){PathCheck(p);return File.Exists(p)||Directory.Exists(p);}
 static void ValidateLedgerFile(string p){PathCheck(p);MuRestoreOriginProof.ValidateAcl(File.GetAccessControl(p));}
 static void CheckRemovalTree(string p){PathCheck(p);foreach(string f in System.IO.Directory.EnumerateFileSystemEntries(p,"*",SearchOption.AllDirectories))if((File.GetAttributes(f)&FileAttributes.ReparsePoint)!=0)throw new UnauthorizedAccessException("Fixture reparse refused");}
 static Dictionary<string,object> Parameters(Dictionary<string,object> record){string directory=Path.Combine(UserRoot,"vms",Convert.ToString(record["id"]));var value=new Dictionary<string,object>{{"directory",directory},{"disk",Path.Combine(directory,"disk.vhdx")},{"seed",Path.Combine(directory,"seed.iso")}};if(record.ContainsKey("platformId"))value["expectedPlatformId"]=record["platformId"];return value;}
 static MuRestoreOriginStore OpenOriginStore(bool create=false){if(create)Directory.CreateDirectory(Path.Combine(UserRoot,"restore-origins"));return new MuRestoreOriginStore(UserRoot,OwnerSid,(h,d)=>{},null,!create);}
 static IDisposable PinOriginAllocation(Dictionary<string,object> r){return new MemoryStream();}
 static string Invoke(string action,Dictionary<string,object> p,int timeout,CancellationToken cancellation){cancellation.ThrowIfCancellationRequested();if(action!="review-allocation")throw new Exception("Recovery attempted a VM mutation: "+action);PathCheck(Convert.ToString(p["directory"]));Reviews++;if(RejectVm)throw new IOException("Synthetic running/mismatched VM refused");if(ChangeVm&&Reviews%2==0)VmCapacity=64;return Json().Serialize(new{platformId=ReturnedPlatform,cpus=1,memoryGiB=2,diskGiB=VmCapacity});}
 static void Require(bool ok,string reason){if(!ok)throw new Exception(reason);}static Exception Fails(Action action){try{action();}catch(Exception e){return e;}throw new Exception("Expected recovery refusal");}
 static string Hash(string p){using(var f=System.IO.File.OpenRead(p))return RecoveryHash(f,CancellationToken.None);}
 static Dictionary<string,string> Files(){return System.IO.Directory.EnumerateFiles(UserRoot,"*",SearchOption.AllDirectories).ToDictionary(p=>p.Substring(UserRoot.Length+1),p=>Hash(p));}
 static void SameFiles(Dictionary<string,string> before){var after=Files();Require(before.Count==after.Count&&before.All(p=>after.ContainsKey(p.Key)&&after[p.Key]==p.Value),"Read-only/refused recovery changed files");}
 public static string RunOriginRecoveryFixture(string root,string scenario){
  UserRoot=Path.GetFullPath(root);Records.Clear();Reviews=0;VmCapacity=32;ChangeVm=RejectVm=false;RecoveryPublicationAttempted=false;RecoveryOnly=true;Require(RecoveryOnly,"Recovery fixture mode missing");string id="12345678-1234-4234-8234-123456789012",platform="87654321-4321-4321-8321-210987654321";ReturnedPlatform=platform;Directory.CreateDirectory(Path.Combine(root,"vms",id));Directory.CreateDirectory(Path.Combine(root,"images"));
  string directory=Path.Combine(root,"vms",id),disk=Path.Combine(directory,"disk.vhdx"),seed=Path.Combine(directory,"seed.iso");var bytes=Enumerable.Range(0,131077).Select(n=>(byte)(n%251)).ToArray();System.IO.File.WriteAllBytes(disk,bytes);var iso=new byte[49152];Encoding.ASCII.GetBytes("CD001").CopyTo(iso,32769);System.IO.File.WriteAllBytes(seed,iso);string originalHash=Hash(disk),seedHash=Hash(seed),digest;
  using(var sha=SHA256.Create())digest=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes("Synthetic independent base"))).Replace("-","").ToLowerInvariant();string image=Path.Combine(root,"images",digest+".vhdx");bool baseMode=scenario=="base-image"||scenario=="base-file-replaced";bool hasBase=baseMode||scenario=="pending-with-base"||scenario=="base-with-origin"||scenario=="ambiguous-base";
  if(hasBase)System.IO.File.WriteAllText(image,"Synthetic independent base");if(scenario=="ambiguous-base")System.IO.File.Copy(image,Path.ChangeExtension(image,".vhd"));
  if(!baseMode&&scenario!="missing-origin")using(var store=OpenOriginStore(true))using(var d=System.IO.File.OpenRead(disk))using(var s=System.IO.File.OpenRead(seed)){
   var proof=new Dictionary<string,object>{{"format",1},{"kind","standalone-backup-origin"},{"ownerSid",OwnerSid},{"id",id},{"platformId",platform},{"imageSha256",scenario=="wrong-source"?new string('b',64):digest},{"importDiskSha256",originalHash},{"importDiskBytes",d.Length},{"importSeedSha256",seedHash},{"importSeedBytes",s.Length},{"rootFile",store.RootIdentity},{"diskFile",MuRestoreOriginStore.CaptureIdentity(d.SafeFileHandle)},{"seedFile",MuRestoreOriginStore.CaptureIdentity(s.SafeFileHandle)},{"seedSha256",seedHash},{"cpus",1},{"memoryGiB",2},{"diskGiB",32}};
   store.PublishInitial(proof,id,platform);if(scenario!="pending-origin"&&scenario!="pending-with-base")store.AcceptInitial(store.ReadSnapshot(id,platform),id,platform,p=>{});
  }
  if(scenario=="legitimate-disk-writes")System.IO.File.WriteAllBytes(disk,bytes.Select(b=>(byte)(b^57)).ToArray());
  if(scenario=="seed-changed")System.IO.File.WriteAllBytes(seed,iso.Select(b=>(byte)(b^31)).ToArray());
  if(scenario=="disk-replaced"){System.IO.File.Move(disk,Path.Combine(root,"preserved-disk"));System.IO.File.WriteAllBytes(disk,bytes);}
  if(scenario=="wrong-resources")VmCapacity=64;if(scenario=="vm-changed")ChangeVm=true;if(scenario=="vm-refused")RejectVm=true;
  if(scenario=="vm-replaced")ReturnedPlatform="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  if(scenario=="origin-corrupt"){string table=Path.Combine(root,"restore-origins",".lock");var contents=System.IO.File.ReadAllBytes(table);contents[MuRestoreOriginStore.HeaderBytes+10]^=1;contents[MuRestoreOriginStore.SlotBytes+MuRestoreOriginStore.HeaderBytes+10]^=1;System.IO.File.WriteAllBytes(table,contents);}
  if(scenario=="snapshot-pending")Directory.CreateDirectory(Path.Combine(directory,"snapshots","restore-active"));
  string primary=Path.Combine(root,"vms.json"),backup=Path.Combine(root,"vms.backup.json");if(scenario=="corrupt-ledgers"){System.IO.File.WriteAllText(primary,"{broken-primary");System.IO.File.WriteAllText(backup,"{broken-backup");}
  LedgerStore=new MuProtectedLedger(root,OwnerSid,ValidateLedgerFile);foreach(var pair in LedgerStore.InspectRecovery())Records.Add(pair.Key,pair.Value);RecoveryLedgerFingerprint=LedgerStore.RecoveryFingerprint();
  var request=new Dictionary<string,object>{{"action","recovery-review"},{"id",id},{"imageSha256",digest}};var before=Files();
  bool early=new[]{"missing-origin","pending-origin","pending-with-base","wrong-source","seed-changed","disk-replaced","wrong-resources","vm-changed","vm-refused","snapshot-pending","ambiguous-base","vm-replaced","origin-corrupt"}.Contains(scenario);
  if(early){Fails(()=>RecoveryAction("recovery-review",request,CancellationToken.None));SameFiles(before);Require(Records.Count==0&&!RecoveryPublicationAttempted,"Refusal published registration");return Json().Serialize(new{complete=true,scenario=scenario,actualRecoveryAction=true,actualLedger=true,realHyperV=false,trustedAclPublication=false,refused=true});}
  var review=Json().Deserialize<Dictionary<string,object>>(Json().Serialize(RecoveryAction("recovery-review",request,CancellationToken.None)));SameFiles(before);var reviewed=(Dictionary<string,object>)review["review"];Require(Convert.ToString(reviewed["sourceAuthority"])==(baseMode?"base-image":"import-origin")&&Convert.ToString(reviewed["diskSha256"])==Hash(disk),"Wrong review authority or current disk digest");
  request["action"]="recovery-adopt";request["plan"]=review["plan"];request["confirmName"]="mu-win-"+id.Replace("-","");
  if(scenario=="wrong-confirmation")request["confirmName"]="wrong";
  if(scenario=="receipt-aba")using(var store=OpenOriginStore()){var original=store.ReadAcceptedSnapshot(id,platform);var p=MuRestoreOriginProof.Parse(original.Text,OwnerSid,id,platform);p["diskGiB"]=64;store.Update(original,p,"grow",id,platform,v=>{});var changed=store.ReadSnapshot(id,platform);p["diskGiB"]=32;store.Update(changed,p,"snapshot",id,platform,v=>{});}
  if(scenario=="base-file-replaced"){System.IO.File.Move(disk,Path.Combine(root,"preserved-disk"));System.IO.File.WriteAllBytes(disk,bytes);}
  if(scenario=="ledger-changed")System.IO.File.WriteAllText(primary,"{external-change");
  var cancelled=new CancellationTokenSource();if(scenario=="cancelled")cancelled.Cancel();
  bool late=new[]{"wrong-confirmation","receipt-aba","base-file-replaced","ledger-changed","cancelled"}.Contains(scenario);if(late){before=Files();Fails(()=>RecoveryAction("recovery-adopt",request,cancelled.Token));SameFiles(before);Require(Records.Count==0&&!RecoveryPublicationAttempted,"Changed plan published registration");return Json().Serialize(new{complete=true,scenario=scenario,actualRecoveryAction=true,actualLedger=true,realHyperV=false,trustedAclPublication=false,refused=true});}
  RecoveryAction("recovery-adopt",request,CancellationToken.None);Require(Records.Count==1&&RecoveryPublicationAttempted&&Hash(disk)==Convert.ToString(reviewed["diskSha256"])&&Hash(seed)==seedHash,"Adoption changed original data");
  var reopened=new MuProtectedLedger(root,OwnerSid,ValidateLedgerFile).Load();Require(reopened.Count==1&&Convert.ToString(reopened[id]["platformId"])==platform&&reopened[id].ContainsKey("restoreOrigin")==!baseMode,"Reopened ledger lost origin tracking");Require(hasBase==File.Exists(image),"Recovery created or removed a base image");
  int retained=System.IO.Directory.EnumerateFiles(root,"vms.before-recovery-*.json").Count();if(scenario=="corrupt-ledgers")Require(retained==2&&System.IO.Directory.EnumerateFiles(root,"vms.before-recovery-*.json").Select(p=>System.IO.File.ReadAllText(p)).OrderBy(x=>x).SequenceEqual(new[]{"{broken-backup","{broken-primary"}),"Original corrupt copies not retained exactly");
  return Json().Serialize(new{complete=true,scenario=scenario,actualRecoveryAction=true,actualLedger=true,realHyperV=false,trustedAclPublication=false,refused=false,reopened=true,sourceAuthority=reviewed["sourceAuthority"],retainedCorruptCopies=retained,vmMutations=0,baseImageCreated=false});
 }
}
