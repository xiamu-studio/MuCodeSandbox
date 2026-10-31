using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Threading;
using System.Web.Script.Serialization;

// Actual ordinary Windows files and sharing/operation locks. Directory and
// protected-read callbacks are adapters; no protected ACL, broker IPC or VM.
public static class MuSnapshotExportFixture {
 static readonly List<object> Checks=new List<object>();
 static void Require(bool ok,string message){if(!ok)throw new Exception(message);}
 static void Pass(string name){Checks.Add(new{name=name,passed=true});}
 static bool Reject(Action work){try{work();return false;}catch(IOException){return true;}catch(InvalidDataException){return true;}catch(InvalidOperationException){return true;}catch(UnauthorizedAccessException){return true;}catch(ArgumentException){return true;}catch(OperationCanceledException){return true;}}
 static byte[] Bytes(int length,byte value){return Enumerable.Repeat(value,length).ToArray();}
 static string Hash(byte[] bytes){using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
 sealed class Case {
  public readonly string root,id,allocation,disk,seed,dir,manifest;
  public readonly MuOfflineSnapshotStore store;public readonly MuOfflineSnapshotStore.Snapshot snapshot;
  public readonly byte[] oldDisk=Bytes(100003,31),oldSeed=Bytes(65539,41);public bool running;public int stops;public readonly List<string> reads=new List<string>();
  public Case(string parent,string name){root=Path.Combine(parent,name);Directory.CreateDirectory(root);id=Guid.NewGuid().ToString("D");allocation=Path.Combine(root,id);Directory.CreateDirectory(allocation);disk=Path.Combine(allocation,"disk.vhdx");seed=Path.Combine(allocation,"seed.iso");File.WriteAllBytes(disk,oldDisk);File.WriteAllBytes(seed,oldSeed);
   store=new MuOfflineSnapshotStore(allocation,id,DirectoryGuard,Read,p=>{},()=>{stops++;if(running)throw new InvalidOperationException("Current VM is running");},null);snapshot=store.Create("历史版本","owner-encrypted-history",CancellationToken.None);dir=Path.Combine(allocation,"snapshots",snapshot.id);manifest=Path.Combine(dir,"manifest.json");File.WriteAllBytes(disk,Bytes(oldDisk.Length,91));File.WriteAllBytes(seed,Bytes(oldSeed.Length,92));running=true;stops=0;reads.Clear();
  }
  void Boundary(string file){string full=Path.GetFullPath(file),boundary=Path.GetFullPath(root)+Path.DirectorySeparatorChar;if(!full.StartsWith(boundary,StringComparison.OrdinalIgnoreCase))throw new UnauthorizedAccessException("Fixture root changed");for(string current=full;current!=null&&current.StartsWith(boundary,StringComparison.OrdinalIgnoreCase);current=Path.GetDirectoryName(current))if((File.Exists(current)||Directory.Exists(current))&&(File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new UnauthorizedAccessException("Fixture link rejected");}
  void DirectoryGuard(string file){Boundary(file);Directory.CreateDirectory(file);}
  FileStream Read(string file){Boundary(file);reads.Add(file);return new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read);}
  public MuOfflineSnapshotStore.ExportRead Open(Action<MuOfflineSnapshotStore.Snapshot> authorize=null,Action guard=null,CancellationToken cancel=default(CancellationToken)){return store.OpenExport(snapshot.id,authorize??(s=>Require(s.id==snapshot.id&&s.environmentId==id&&s.configuration=="owner-encrypted-history","Historical authorization changed")),guard??(()=>{}),cancel);}
  public void Released(){Require(store.Get(snapshot.id).id==snapshot.id,"Operation lock leaked");foreach(string file in new[]{manifest,Path.Combine(dir,"disk.vhdx"),Path.Combine(dir,"seed.iso")})using(var stream=new FileStream(file,FileMode.Open,FileAccess.ReadWrite,FileShare.None)){} }
 }
 static byte[] Consume(MuOfflineSnapshotStore.ExportRead lease,bool seed,long length){using(var output=new MemoryStream()){long offset=0;while(offset<length){byte[] bytes=seed?lease.ReadSeed(offset,CancellationToken.None):lease.ReadDisk(offset,CancellationToken.None);Require(bytes.Length==Math.Min(MuOfflineSnapshotStore.ExportRead.ChunkBytes,length-offset),"Unbounded export block");output.Write(bytes,0,bytes.Length);offset+=bytes.Length;Array.Clear(bytes,0,bytes.Length);}return output.ToArray();}}
 static void Basic(string parent){var c=new Case(parent,"history");using(var lease=c.Open()){
  Require(lease.Metadata.configuration=="owner-encrypted-history"&&lease.Metadata.files.Single(f=>f.key=="disk").sha256==Hash(c.oldDisk),"Export selected current metadata");Require(Consume(lease,false,c.oldDisk.Length).SequenceEqual(c.oldDisk)&&Consume(lease,true,c.oldSeed.Length).SequenceEqual(c.oldSeed),"Disk and seed historical pair changed");Pass("exact-history-disk-seed-and-owner-configuration-are-read-in-bounded-order");
  Require(c.stops==0&&!c.reads.Contains(c.disk)&&!c.reads.Contains(c.seed),"History export accessed or stopped the current environment");Pass("a-running-current-environment-is-never-read-or-stopped");
 }c.Released();Pass("release-closes-every-file-pin-and-operation-lock");}
 static void Pins(string parent){var c=new Case(parent,"pins");var lease=c.Open();try{
  foreach(string file in new[]{c.manifest,Path.Combine(c.dir,"disk.vhdx"),Path.Combine(c.dir,"seed.iso")}){
   Require(Reject(()=>File.WriteAllText(file,"replacement")),"Pinned file could be overwritten");Require(Reject(()=>File.Delete(file)),"Pinned file could be deleted");string next=file+".replacement";File.WriteAllText(next,"untrusted");try{Require(Reject(()=>File.Replace(next,file,null)),"Pinned file could be replaced");}finally{if(File.Exists(next))File.Delete(next);}
  }Pass("real-windows-sharing-denies-writes-deletes-and-atomic-replacement-of-all-three-files");
  Require(Reject(()=>c.store.Get(c.snapshot.id)),"Other instance could enter the operation lock");Require(Reject(()=>c.Open()),"A second history lease opened");c.running=false;Require(Reject(()=>c.store.Create("并发版本","opaque",CancellationToken.None)),"Concurrent snapshot creation entered");Require(Reject(()=>c.store.PrepareRestore(c.snapshot.id,"opaque",CancellationToken.None)),"Concurrent restore entered");Require(Reject(()=>c.store.Delete(c.snapshot.id,c.snapshot.name,new string('a',64),false,s=>{},CancellationToken.None)),"Concurrent deletion entered");Pass("history-read-excludes-concurrent-create-restore-delete-and-another-export");
  var other=new Case(parent,"independent");using(var independent=other.Open())Require(independent.ReadDisk(0,CancellationToken.None)[0]==31,"Independent allocation was blocked");Pass("another-environment-retains-its-own-independent-read-lock");
 }finally{lease.Dispose();lease.Dispose();}c.Released();Pass("release-is-idempotent-after-complete-or-abandoned-read");}
 static void Copies(string parent){var c=new Case(parent,"copies");using(var lease=c.Open(s=>{s.configuration="changed";s.files[0].sha256=new string('0',64);s.id=Guid.NewGuid().ToString("D");})){
  var metadata=lease.Metadata;metadata.configuration="caller-change";metadata.files[0].bytes=1;Require(lease.Metadata.configuration=="owner-encrypted-history"&&lease.Metadata.files.All(f=>f.bytes>1),"Caller mutated lease authority");Require(Consume(lease,false,c.oldDisk.Length).SequenceEqual(c.oldDisk),"Mutation changed selected bytes");
 }c.Released();Pass("authorization-and-public-metadata-use-independent-deep-copies");}
 static void FailedReads(string parent){foreach(string kind in new[]{"wrong-offset","repeat","past-end","cancel","revoked-before","revoked-after"}){
  var c=new Case(parent,kind);bool revoked=false;int guardCalls=0;var lease=c.Open(null,()=>{guardCalls++;if(revoked)throw new UnauthorizedAccessException("Synthetic authority revoked");});
  try{var cancel=new CancellationTokenSource();long offset=0;if(kind=="wrong-offset")offset=1;if(kind=="repeat")lease.ReadDisk(0,CancellationToken.None);if(kind=="past-end")offset=c.oldDisk.Length;if(kind=="cancel")cancel.Cancel();if(kind=="revoked-before")revoked=true;
   if(kind=="revoked-after"){// Revocation between the pre-read and post-read guard must discard the block.
    lease.Dispose();int n=0;lease=c.Open(null,()=>{if(++n==5)throw new UnauthorizedAccessException("Synthetic post-read revocation");});
   }
   Require(Reject(()=>lease.ReadDisk(offset,cancel.Token)),"Invalid read became data: "+kind);Require(lease.Expired&&Reject(()=>{var unused=lease.Metadata;}),"Failed read retained live authority");
  }finally{lease.Dispose();}c.Released();Pass("failed-read-"+kind+"-releases-pins-without-returning-a-successful-block");
 }}
 static void FailOpen(string parent){foreach(string kind in new[]{"disk-digest","seed-digest","wrong-environment","extra-file","extra-directory","denied","cancel","late-tree","pending-restore"}){
  var c=new Case(parent,kind);Action<MuOfflineSnapshotStore.Snapshot> authorize=s=>{};Action guard=()=>{};var cancel=new CancellationTokenSource();
  if(kind=="disk-digest")File.WriteAllBytes(Path.Combine(c.dir,"disk.vhdx"),Bytes(c.oldDisk.Length,33));
  if(kind=="seed-digest")File.WriteAllBytes(Path.Combine(c.dir,"seed.iso"),Bytes(c.oldSeed.Length,44));
  if(kind=="wrong-environment"){var json=new JavaScriptSerializer();var metadata=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(c.manifest));metadata["environmentId"]=Guid.NewGuid().ToString("D");File.WriteAllText(c.manifest,json.Serialize(metadata));}
  if(kind=="extra-file")File.WriteAllText(Path.Combine(c.dir,"unknown.bin"),"preserve");if(kind=="extra-directory")Directory.CreateDirectory(Path.Combine(c.dir,"unknown"));
  if(kind=="denied")authorize=s=>{throw new UnauthorizedAccessException("Synthetic caller refused");};if(kind=="cancel")cancel.Cancel();
  if(kind=="late-tree"){int calls=0;authorize=s=>{if(++calls==2)File.WriteAllText(Path.Combine(c.dir,"late.bin"),"preserve");};}
  if(kind=="pending-restore"){c.running=false;c.store.PrepareRestore(c.snapshot.id,"current-owner",CancellationToken.None);}
  var retained=Directory.GetFiles(c.dir).ToDictionary(f=>f,f=>Hash(File.ReadAllBytes(f)));int before=c.reads.Count;
  Require(Reject(()=>c.Open(authorize,guard,cancel.Token)),"Invalid history source opened: "+kind);using(var unlocked=new FileStream(Path.Combine(c.allocation,"snapshots","operation.lock"),FileMode.Open,FileAccess.ReadWrite,FileShare.None)){}
  foreach(var entry in retained)Require(File.Exists(entry.Key)&&Hash(File.ReadAllBytes(entry.Key))==entry.Value,"Failed open changed original history");
  if(kind=="denied")Require(!c.reads.Skip(before).Any(f=>f==Path.Combine(c.dir,"disk.vhdx")||f==Path.Combine(c.dir,"seed.iso")),"Unauthorized caller opened payload handles");
  if(kind=="late-tree")Require(File.ReadAllText(Path.Combine(c.dir,"late.bin"))=="preserve","Late unknown file was removed");
  Pass("open-refuses-"+kind+"-and-preserves-original-history");
 }}
 public static string Run(string root){Basic(root);Pins(root);Copies(root);FailedReads(root);FailOpen(root);return new JavaScriptSerializer().Serialize(new{complete=true,checks=Checks,realWindowsFiles=true,realSharingLocks=true,productionOfflineCore=true,realHyperV=false,protectedAcl=false,brokerIpc=false,publicProductExport=false});}
 public static void Hold(string root){var c=new Case(root,"death");using(var lease=c.Open()){
  File.WriteAllText(Path.Combine(root,"witness.json"),new JavaScriptSerializer().Serialize(new{id=c.id,snapshotId=c.snapshot.id,configuration=c.snapshot.configuration,diskSha256=Hash(c.oldDisk),seedSha256=Hash(c.oldSeed)}));Console.WriteLine("EXPORT_PINNED");Console.Out.Flush();using(var hold=new ManualResetEvent(false))hold.WaitOne(60000);
 }}
 public static string Reopen(string root){var json=new JavaScriptSerializer();var witness=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"witness.json")));string id=Convert.ToString(witness["id"]),snapshotId=Convert.ToString(witness["snapshotId"]),allocation=Path.Combine(root,"death",id);Guid parsed;Require(Guid.TryParseExact(id,"D",out parsed)&&parsed.ToString("D")==id,"Witness id changed");var store=new MuOfflineSnapshotStore(allocation,id,p=>{Require(Path.GetFullPath(p).StartsWith(Path.GetFullPath(allocation),StringComparison.OrdinalIgnoreCase),"Reopen boundary changed");Directory.CreateDirectory(p);},p=>new FileStream(p,FileMode.Open,FileAccess.Read,FileShare.Read),p=>{},()=>{throw new Exception("Export must not stop the VM");},null);
  using(var lease=store.OpenExport(snapshotId,s=>Require(s.configuration==Convert.ToString(witness["configuration"]),"Recovered history config changed"),()=>{},CancellationToken.None))foreach(string key in new[]{"disk","seed"}){var expected=lease.Metadata.files.Single(f=>f.key==key);Require(Hash(Consume(lease,key=="seed",expected.bytes))==Convert.ToString(witness[key+"Sha256"]),"Process death changed historical bytes");}
  return json.Serialize(new{complete=true,actualProcessDeath=true,actualReopen=true,originalHistoryUnchanged=true,currentVmStopped=false,realHyperV=false,protectedAcl=false,brokerIpc=false,publicProductExport=false});
 }
}
