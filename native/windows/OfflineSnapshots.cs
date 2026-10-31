// Offline full-copy snapshots. This core is not an IPC surface: the broker must
// supply its pinned allocation, ACL/handle checks, disk reservation, stopped-VM
// verification and per-VM exclusion before exposing it to the product.
// Configuration is opaque owner-encrypted data; it is never interpreted here.
public sealed class MuOfflineSnapshotStore {
    public interface IStagingWriter:IDisposable {
        FileStream OpenNew(string path);
        void Publish(string destination);
    }
    public interface IStagingFactory {
        IStagingWriter Begin(string path,string operation,string id);
        string[] Pending();
    }
    public sealed class FileRecord { public string key,sha256; public long bytes; }
    public sealed class Snapshot {
        public int version; public string id,environmentId,name,createdAt,configuration;
        public FileRecord[] files;
    }
    public sealed class Restore {
        public int version; public string id,snapshotId,environmentId,phase,previousConfiguration,configuration,coordinator,origin;
        public FileRecord[] previous,files;
    }
    public sealed class DeletePlan {
        public int version; public string id,environmentId,name,createdAt,authoritySha256,manifestSha256;
        public long manifestBytes; public FileRecord[] files;
    }
    public sealed class Deletion {
        public string id,environmentId,name,createdAt,phase; public long bytes;
    }
    public sealed class DeleteReceipt {
        public bool deleted,alreadyDeleted; public string id,environmentId,name; public long bytes;
    }
    // A history export owns the operation lock and the exact manifest/disk/seed
    // handles until release. It never reads or stops the current environment.
    public sealed class ExportRead:IDisposable {
        public const int ChunkBytes=32768;
        private readonly object gate=new object();
        private readonly Snapshot snapshot;
        private readonly Action check;
        private readonly FileStream operation,manifest,disk,seed;
        private readonly System.Diagnostics.Stopwatch lifetime=System.Diagnostics.Stopwatch.StartNew(),idle=System.Diagnostics.Stopwatch.StartNew();
        private bool closed;private long diskOffset,seedOffset;
        internal ExportRead(Snapshot value,Action verify,FileStream held,FileStream metadata,FileStream diskFile,FileStream seedFile){snapshot=value;check=verify;operation=held;manifest=metadata;disk=diskFile;seed=seedFile;}
        public Snapshot Metadata {get{lock(gate){if(closed)throw new ObjectDisposedException("Snapshot export");return CloneSnapshot(snapshot);}}}
        public bool Expired {get{lock(gate)return closed||idle.ElapsedMilliseconds>60000||lifetime.ElapsedMilliseconds>3600000;}}
        public byte[] ReadDisk(long offset,CancellationToken cancel){return Read(false,offset,cancel);}
        public byte[] ReadSeed(long offset,CancellationToken cancel){return Read(true,offset,cancel);}
        private byte[] Read(bool originalSeed,long offset,CancellationToken cancel){lock(gate){
            byte[] bytes=null;try{
                if(Expired)throw new IOException("Snapshot export expired");cancel.ThrowIfCancellationRequested();check();
                var input=originalSeed?seed:disk;var expected=snapshot.files.Single(f=>f.key==(originalSeed?"seed":"disk"));long next=originalSeed?seedOffset:diskOffset;
                if(offset!=next||offset<0||offset>=expected.bytes||input.Position!=next||input.Length!=expected.bytes)throw new InvalidDataException("Snapshot export requires the exact next offset");
                bytes=new byte[(int)Math.Min((long)ChunkBytes,expected.bytes-next)];int total=0,n;while(total<bytes.Length&&(n=input.Read(bytes,total,bytes.Length-total))>0)total+=n;
                if(total!=bytes.Length||input.Length!=expected.bytes)throw new IOException("Pinned snapshot export was incomplete");cancel.ThrowIfCancellationRequested();check();
                if(originalSeed)seedOffset=checked(next+bytes.Length);else diskOffset=checked(next+bytes.Length);idle.Restart();return bytes;
            }catch{if(bytes!=null)Array.Clear(bytes,0,bytes.Length);try{Dispose();}catch{}throw;}
        }}
        public void Dispose(){lock(gate){if(closed)return;closed=true;Exception failure=null;foreach(var file in new[]{seed,disk,manifest,operation})try{file.Dispose();}catch(Exception error){if(failure==null)failure=error;}if(failure!=null)throw failure;}}
    }
    private readonly string allocation,root,environmentId;
    private readonly Action<string> directory;
    private readonly Func<string,FileStream> openRead;
    private readonly Action<long> reserve;
    private readonly Action stopped;
    private readonly Action<string> progress;
    private readonly IStagingFactory stagingFactory;
    private static readonly string[] Keys={"disk","seed"};
    private const long GiB=1024L*1024*1024,MaxDisk=260L*GiB;
    private const int MaxMetadata=2*1024*1024;
    public MuOfflineSnapshotStore(string allocationDirectory,string id,Action<string> protectedDirectory,Func<string,FileStream> protectedRead,Action<long> reserveBytes,Action verifyStopped,Action<string> onProgress):this(allocationDirectory,id,protectedDirectory,protectedRead,reserveBytes,verifyStopped,onProgress,null){}
    public MuOfflineSnapshotStore(string allocationDirectory,string id,Action<string> protectedDirectory,Func<string,FileStream> protectedRead,Action<long> reserveBytes,Action verifyStopped,Action<string> onProgress,IStagingFactory producer) {
        Id(id);environmentId=id;allocation=Path.GetFullPath(allocationDirectory).TrimEnd(Path.DirectorySeparatorChar);
        if(Path.GetFileName(allocation)!=id)throw new ArgumentException("Fixed environment allocation required");
        if(protectedDirectory==null||protectedRead==null||reserveBytes==null||verifyStopped==null)throw new ArgumentNullException("Snapshot protection callbacks required");
        directory=protectedDirectory;openRead=protectedRead;reserve=reserveBytes;stopped=verifyStopped;progress=onProgress??(_=>{});
        root=Path.Combine(allocation,"snapshots");
        stagingFactory=producer;
    }
    private static void Id(string id){Guid value;if(!Guid.TryParseExact(id,"D",out value)||value==Guid.Empty||value.ToString("D")!=id)throw new ArgumentException("Canonical snapshot identity required");}
    private static bool Exists(string file){try{File.GetAttributes(file);return true;}catch(FileNotFoundException){return false;}catch(DirectoryNotFoundException){return false;}}
    private static JavaScriptSerializer Json(){return new JavaScriptSerializer{MaxJsonLength=MaxMetadata,RecursionLimit=12};}
    private static void Configuration(string value){if(string.IsNullOrEmpty(value)||Encoding.UTF8.GetByteCount(value)>600*1024||value.IndexOf('\0')>=0)throw new InvalidDataException("Bounded encrypted configuration required");}
    private static void Coordinator(string value){if(value!=null&&(string.IsNullOrWhiteSpace(value)||Encoding.UTF8.GetByteCount(value)>4096||value.IndexOf('\0')>=0))throw new InvalidDataException("Bounded snapshot coordinator required");}
    private static void Origin(string value){if(value!=null&&(string.IsNullOrWhiteSpace(value)||Encoding.UTF8.GetByteCount(value)>65536||value.IndexOf('\0')>=0))throw new InvalidDataException("Bounded snapshot origin binding required");}
    private static void Fields(Dictionary<string,object> raw,params string[] names){if(raw==null||raw.Count!=names.Length||raw.Keys.Any(key=>!names.Contains(key)))throw new InvalidDataException("Snapshot metadata fields changed");}
    private static void MetadataTypes(Dictionary<string,object> raw,params string[] strings){if(!(raw["version"] is int)||Convert.ToInt32(raw["version"])!=1||strings.Any(key=>!(raw[key] is string)))throw new InvalidDataException("Snapshot metadata types changed");}
    private static void Files(FileRecord[] files){
        if(files==null||files.Length!=2||files.Any(v=>v==null)||files.Select(v=>v.key).Distinct().Count()!=2||files.Any(v=>!Keys.Contains(v.key)))throw new InvalidDataException("Snapshot file inventory changed");
        foreach(var f in files)if(f.sha256==null||f.sha256.Length!=64||f.sha256.Any(c=>!(c>='0'&&c<='9'||c>='a'&&c<='f'))||f.bytes<1||f.bytes>(f.key=="disk"?MaxDisk:8L*1024*1024))throw new InvalidDataException("Snapshot file bounds changed");
    }
    private FileStream Operation(){
        directory(allocation);directory(root);
        string file=Path.Combine(root,"operation.lock");
        if(Exists(file)){using(var old=openRead(file)){}}
        return new FileStream(file,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
    }
    private string Source(string key){return Path.Combine(allocation,key=="disk"?"disk.vhdx":"seed.iso");}
    private string Active {get{return Path.Combine(root,"restore-active");}}
    private string FileAt(string dir,string key){return Path.Combine(dir,key=="disk"?"disk.vhdx":key=="seed"?"seed.iso":key);}
    private FileRecord Inspect(string file,string key,CancellationToken cancel){
        using(var input=openRead(file))using(var hash=SHA256.Create()){
            long length=input.Length;if(length<1||length>(key=="disk"?MaxDisk:8L*1024*1024))throw new InvalidDataException("Snapshot input exceeds its bound");
            var buffer=new byte[1048576];long total=0;int n;while((n=input.Read(buffer,0,buffer.Length))>0){cancel.ThrowIfCancellationRequested();total+=n;hash.TransformBlock(buffer,0,n,null,0);}hash.TransformFinalBlock(new byte[0],0,0);
            if(total!=length||input.Length!=length)throw new IOException("Snapshot input length changed");
            return new FileRecord{key=key,bytes=length,sha256=BitConverter.ToString(hash.Hash).Replace("-","").ToLowerInvariant()};
        }
    }
    private FileRecord Copy(string from,string to,string key,CancellationToken cancel,IStagingWriter producer=null){
        using(var input=openRead(from))using(var output=producer==null?new FileStream(to,FileMode.CreateNew,FileAccess.Write,FileShare.None,1048576):producer.OpenNew(to))using(var hash=SHA256.Create()){
            long length=input.Length;if(length<1||length>(key=="disk"?MaxDisk:8L*1024*1024))throw new InvalidDataException("Snapshot input exceeds its bound");
            var buffer=new byte[1048576];long total=0;int n;while((n=input.Read(buffer,0,buffer.Length))>0){cancel.ThrowIfCancellationRequested();output.Write(buffer,0,n);total+=n;hash.TransformBlock(buffer,0,n,null,0);progress("copy-"+key);}hash.TransformFinalBlock(new byte[0],0,0);output.Flush(true);
            if(total!=length||input.Length!=length)throw new IOException("Snapshot input length changed");
            return new FileRecord{key=key,bytes=length,sha256=BitConverter.ToString(hash.Hash).Replace("-","").ToLowerInvariant()};
        }
    }
    private static bool Same(FileRecord a,FileRecord b){return a.key==b.key&&a.bytes==b.bytes&&a.sha256==b.sha256;}
    private void Match(string file,FileRecord expected,CancellationToken cancel){if(!Same(Inspect(file,expected.key,cancel),expected))throw new InvalidDataException("Snapshot content digest changed; original data retained");}
    private Dictionary<string,object> ReadJson(string file){
        using(var input=openRead(file))return ReadJson(input);
    }
    private Dictionary<string,object> ReadJson(FileStream input){
            if(input.Length<2||input.Length>MaxMetadata)throw new InvalidDataException("Snapshot metadata exceeds its bound");
            using(var reader=new StreamReader(input,new UTF8Encoding(false,true),false,4096,true))return Json().Deserialize<Dictionary<string,object>>(reader.ReadToEnd());
    }
    private void Save(string file,object value,IStagingWriter producer=null){
        byte[] bytes=Encoding.UTF8.GetBytes(Json().Serialize(value));if(bytes.Length>MaxMetadata)throw new InvalidDataException("Snapshot metadata exceeds its bound");
        string next=file+"."+Guid.NewGuid().ToString("N")+".next";
        using(var output=producer==null?new FileStream(next,FileMode.CreateNew,FileAccess.Write,FileShare.None):producer.OpenNew(next)){output.Write(bytes,0,bytes.Length);output.Flush(true);}
        if(Exists(file)){using(var previous=openRead(file)){}File.Replace(next,file,null);}else File.Move(next,file);
    }
    private void FileFields(Dictionary<string,object> raw,string key){
        object value;if(!raw.TryGetValue(key,out value)||!(value is System.Collections.IList))throw new InvalidDataException("Snapshot file inventory missing");
        var list=(System.Collections.IList)value;if(list.Count!=2)throw new InvalidDataException("Snapshot file inventory length changed");
        foreach(var entry in list){var item=entry as Dictionary<string,object>;Fields(item,"key","sha256","bytes");if(!(item["key"] is string)||!(item["sha256"] is string)||!(item["bytes"] is int)&&!(item["bytes"] is long))throw new InvalidDataException("Snapshot file inventory types changed");}
    }
    private Snapshot ReadSnapshot(string id){
        Id(id);if(Exists(DeleteIntent(id)))throw new InvalidOperationException("Snapshot deletion is pending");return ReadSnapshotAt(id,Path.Combine(root,id));
    }
    private Snapshot ReadSnapshotAt(string id,string dir){
        Id(id);if(!Directory.Exists(dir))throw new InvalidOperationException("Snapshot does not exist");directory(dir);var raw=ReadJson(Path.Combine(dir,"manifest.json"));
        return DecodeSnapshot(id,raw);
    }
    private Snapshot DecodeSnapshot(string id,Dictionary<string,object> raw){
        Fields(raw,"version","id","environmentId","name","createdAt","configuration","files");FileFields(raw,"files");
        MetadataTypes(raw,"id","environmentId","name","createdAt","configuration");
        var value=Json().ConvertToType<Snapshot>(raw);DateTimeOffset time;
        if(value.version!=1||value.id!=id||value.environmentId!=environmentId||string.IsNullOrWhiteSpace(value.name)||value.name.Length>60||value.name.Any(char.IsControl)||!DateTimeOffset.TryParse(value.createdAt,out time))throw new InvalidDataException("Snapshot identity changed");
        Configuration(value.configuration);Files(value.files);return value;
    }
    private static Snapshot CloneSnapshot(Snapshot snapshot){return Json().Deserialize<Snapshot>(Json().Serialize(snapshot));}
    private static void ExportTree(string dir){if(Directory.EnumerateDirectories(dir).Any()||!Directory.EnumerateFiles(dir).Select(Path.GetFileName).OrderBy(n=>n,StringComparer.Ordinal).SequenceEqual(new[]{"disk.vhdx","manifest.json","seed.iso"}))throw new InvalidDataException("Snapshot export tree changed; unknown files retained");}
    private static void VerifyExportFile(FileStream input,FileRecord expected,CancellationToken cancel){
        if(input.Position!=0||input.Length!=expected.bytes)throw new InvalidDataException("Snapshot export length changed");
        using(var hash=SHA256.Create()){
            var buffer=new byte[1048576];try{long total=0;int n;while((n=input.Read(buffer,0,buffer.Length))>0){cancel.ThrowIfCancellationRequested();total+=n;hash.TransformBlock(buffer,0,n,null,0);}hash.TransformFinalBlock(new byte[0],0,0);
                if(total!=expected.bytes||input.Length!=expected.bytes||BitConverter.ToString(hash.Hash).Replace("-","").ToLowerInvariant()!=expected.sha256)throw new InvalidDataException("Snapshot export digest changed");
            }finally{Array.Clear(buffer,0,buffer.Length);}
        }input.Position=0;
    }
    public ExportRead OpenExport(string id,Action<Snapshot> authorizeSnapshot,Action verifyAuthority,CancellationToken cancel){
        Id(id);if(authorizeSnapshot==null||verifyAuthority==null)throw new ArgumentNullException("Snapshot export authority required");cancel.ThrowIfCancellationRequested();verifyAuthority();
        FileStream held=null,manifest=null,disk=null,seed=null;bool published=false;
        try{
            held=Operation();NoRestore();if(Exists(DeleteIntent(id)))throw new InvalidOperationException("Snapshot deletion is pending");
            string dir=Path.Combine(root,id);if(!Directory.Exists(dir))throw new InvalidOperationException("Snapshot does not exist");directory(dir);
            ExportTree(dir);
            manifest=openRead(Path.Combine(dir,"manifest.json"));var snapshot=DecodeSnapshot(id,ReadJson(manifest));authorizeSnapshot(CloneSnapshot(snapshot));cancel.ThrowIfCancellationRequested();verifyAuthority();
            disk=openRead(Path.Combine(dir,"disk.vhdx"));seed=openRead(Path.Combine(dir,"seed.iso"));
            VerifyExportFile(disk,snapshot.files.Single(f=>f.key=="disk"),cancel);VerifyExportFile(seed,snapshot.files.Single(f=>f.key=="seed"),cancel);
            cancel.ThrowIfCancellationRequested();verifyAuthority();authorizeSnapshot(CloneSnapshot(snapshot));ExportTree(dir);
            var result=new ExportRead(snapshot,verifyAuthority,held,manifest,disk,seed);published=true;return result;
        }finally{if(!published)foreach(var file in new[]{seed,disk,manifest,held})if(file!=null)try{file.Dispose();}catch{/* Attempt every release without replacing the primary validation error. */}}
    }
    private Restore ReadRestore(){return ReadRestoreAt(Active);}
    private Restore ReadRestoreAt(string path){
        directory(path);var raw=ReadJson(Path.Combine(path,"journal.json"));
        // Older journals predate coordinator binding. Only explicit recovery may
        // adopt them; the native owner boundary decides whether adoption is safe.
        var fields=new List<string>{"version","id","snapshotId","environmentId","phase","previousConfiguration","configuration","previous","files"};
        foreach(string optional in new[]{"coordinator","origin"})if(raw.ContainsKey(optional)){fields.Add(optional);if(raw[optional]!=null&&!(raw[optional] is string))throw new InvalidDataException("Snapshot optional binding type changed");}
        Fields(raw,fields.ToArray());FileFields(raw,"previous");FileFields(raw,"files");
        MetadataTypes(raw,"id","snapshotId","environmentId","phase","previousConfiguration","configuration");
        var value=Json().ConvertToType<Restore>(raw);Id(value.id);Id(value.snapshotId);
        if(value.version!=1||value.environmentId!=environmentId||!new[]{"prepared","applied","committed","rolled-back"}.Contains(value.phase))throw new InvalidDataException("Snapshot restore journal identity changed");
        Configuration(value.configuration);Configuration(value.previousConfiguration);Coordinator(value.coordinator);Origin(value.origin);Files(value.files);Files(value.previous);return value;
    }
    private string DeleteIntent(string id){return Path.Combine(root,"delete-intent-"+id+".json");}
    private string DeleteActive(string id){return Path.Combine(root,"delete-active-"+id);}
    private static void Sha256(string value){if(value==null||value.Length!=64||value.Any(c=>!(c>='0'&&c<='9'||c>='a'&&c<='f')))throw new InvalidDataException("Snapshot deletion authority digest required");}
    private static void DeleteName(string value){if(string.IsNullOrWhiteSpace(value)||value!=value.Trim()||value.Length>60||value.Any(char.IsControl))throw new ArgumentException("Exact snapshot name required");}
    private DeletePlan ReadDeletePlan(string file,string id,string authority){
        var raw=ReadJson(file);Fields(raw,"version","id","environmentId","name","createdAt","authoritySha256","manifestSha256","manifestBytes","files");
        MetadataTypes(raw,"id","environmentId","name","createdAt","authoritySha256","manifestSha256");FileFields(raw,"files");
        if(!(raw["manifestBytes"] is int)&&!(raw["manifestBytes"] is long))throw new InvalidDataException("Snapshot deletion manifest length type changed");
        var plan=Json().ConvertToType<DeletePlan>(raw);DateTimeOffset time;Id(plan.id);DeleteName(plan.name);Sha256(plan.authoritySha256);Sha256(plan.manifestSha256);Files(plan.files);
        if(plan.id!=id||plan.environmentId!=environmentId||plan.authoritySha256!=authority||plan.manifestBytes<2||plan.manifestBytes>MaxMetadata||!DateTimeOffset.TryParse(plan.createdAt,out time))throw new InvalidDataException("Snapshot deletion identity changed");
        return plan;
    }
    private string[] DeleteIds(){
        var ids=new List<string>();foreach(string file in Directory.EnumerateFileSystemEntries(root,"delete-intent-*.json")){
            string name=Path.GetFileName(file),id=name.Substring("delete-intent-".Length,name.Length-"delete-intent-".Length-5);Id(id);ids.Add(id);
            if(ids.Count>32)throw new InvalidDataException("Pending snapshot deletion inventory exceeds its bound");
        }return ids.ToArray();
    }
    private string[] DeleteInventory(string dir){
        if(!Directory.Exists(dir))throw new InvalidDataException("Snapshot deletion directory is missing");directory(dir);
        var allowed=new[]{"disk.vhdx","seed.iso","manifest.json"};var actual=Directory.EnumerateFileSystemEntries(dir).ToArray();
        if(actual.Length>3||actual.Any(file=>!allowed.Contains(Path.GetFileName(file))||(File.GetAttributes(file)&(FileAttributes.Directory|FileAttributes.ReparsePoint))!=0))throw new InvalidDataException("Unknown snapshot deletion content retained");
        if(!Exists(Path.Combine(dir,"manifest.json"))&&actual.Length!=0)throw new InvalidDataException("Snapshot deletion manifest is missing before data removal");return actual;
    }
    private Snapshot VerifyDeleteTree(string dir,DeletePlan plan,bool complete,CancellationToken cancel){
        var actual=DeleteInventory(dir);
        if(complete&&actual.Length!=3)throw new InvalidDataException("Complete snapshot inventory required before deletion");
        bool manifest=Exists(Path.Combine(dir,"manifest.json"));
        foreach(var file in plan.files)if(Exists(FileAt(dir,file.key)))Match(FileAt(dir,file.key),file,cancel);
        if(!manifest)return null;
        Match(Path.Combine(dir,"manifest.json"),new FileRecord{key="manifest",bytes=plan.manifestBytes,sha256=plan.manifestSha256},cancel);
        var snapshot=ReadSnapshotAt(plan.id,dir);
        if(snapshot.name!=plan.name||snapshot.createdAt!=plan.createdAt||snapshot.files.Any(file=>!Same(file,plan.files.Single(expected=>expected.key==file.key))))throw new InvalidDataException("Snapshot deletion plan differs from its manifest");
        return snapshot;
    }
    private static DeleteReceipt Deleted(DeletePlan plan,bool already){return new DeleteReceipt{deleted=true,alreadyDeleted=already,id=plan.id,environmentId=plan.environmentId,name=plan.name,bytes=plan.files.Sum(file=>file.bytes)};}
    public Deletion[] PendingDeletions(string authority){using(Operation()){
        Sha256(authority);return DeleteIds().Select(id=>{var plan=ReadDeletePlan(DeleteIntent(id),id,authority);return new Deletion{id=id,environmentId=environmentId,name=plan.name,createdAt=plan.createdAt,bytes=plan.files.Sum(file=>file.bytes),phase=Exists(DeleteActive(id))?"retired":"intent"};}).ToArray();
    }}
    // Only an explicit broker-owned request may retire a snapshot. The caller
    // binds authority to the protected owner/environment/VM, verifies the opaque
    // envelope and pins the allocation. Its review callback either requires a
    // stopped VM under lifecycle exclusion, or independently fences mutations,
    // verifies no VM/checkpoint/host reference and preserves inspect/stop access.
    // A durable intent precedes the rename. Resumption deletes only the three
    // recorded files; unknown content is never recursively removed.
    public DeleteReceipt Delete(string id,string name,string authority,bool resumeOnly,Action<Snapshot> authorizeSnapshot,CancellationToken cancel){using(Operation()){
        Id(id);DeleteName(name);Sha256(authority);if(authorizeSnapshot==null)throw new ArgumentNullException("authorizeSnapshot");NoRestore();stopped();cancel.ThrowIfCancellationRequested();
        string source=Path.Combine(root,id),retired=DeleteActive(id),intent=DeleteIntent(id),history=Path.Combine(root,"delete-history"),receipt=Path.Combine(history,id+".json");
        if(Exists(receipt)){
            directory(history);var completed=ReadDeletePlan(receipt,id,authority);
            if(completed.name!=name||Exists(source)||Exists(retired)||Exists(intent))throw new InvalidDataException("Completed snapshot deletion identity changed");return Deleted(completed,true);
        }
        DeletePlan plan;
        if(Exists(intent)){
            plan=ReadDeletePlan(intent,id,authority);if(plan.name!=name)throw new InvalidDataException("Snapshot deletion confirmation changed");
        }else{
            if(resumeOnly)throw new InvalidOperationException("No existing snapshot deletion to resume");
            if(Exists(retired))throw new InvalidDataException("Unregistered retired snapshot retained");
            var snapshot=ReadSnapshot(id);if(snapshot.name!=name)throw new InvalidDataException("Snapshot name confirmation changed");authorizeSnapshot(snapshot);
            var manifest=Inspect(Path.Combine(source,"manifest.json"),"manifest",cancel);
            plan=new DeletePlan{version=1,id=id,environmentId=environmentId,name=name,createdAt=snapshot.createdAt,authoritySha256=authority,manifestSha256=manifest.sha256,manifestBytes=manifest.bytes,files=snapshot.files};
            VerifyDeleteTree(source,plan,true,cancel);stopped();cancel.ThrowIfCancellationRequested();Save(intent,plan);progress("delete-intent-published");
        }
        if(Exists(source)){
            if(Exists(retired))throw new InvalidDataException("Duplicate snapshot deletion directories retained");
            var snapshot=VerifyDeleteTree(source,plan,true,cancel);authorizeSnapshot(snapshot);stopped();cancel.ThrowIfCancellationRequested();Directory.Move(source,retired);progress("delete-retired");
        }
        if(Exists(retired)){
            var snapshot=VerifyDeleteTree(retired,plan,false,cancel);if(snapshot!=null)authorizeSnapshot(snapshot);
            foreach(string key in Keys){
                string file=FileAt(retired,key);if(!Exists(file))continue;stopped();cancel.ThrowIfCancellationRequested();DeleteInventory(retired);Match(file,plan.files.Single(value=>value.key==key),cancel);File.Delete(file);progress("delete-removed-"+key);
            }
            string manifest=Path.Combine(retired,"manifest.json");if(Exists(manifest)){
                stopped();cancel.ThrowIfCancellationRequested();DeleteInventory(retired);Match(manifest,new FileRecord{key="manifest",bytes=plan.manifestBytes,sha256=plan.manifestSha256},cancel);File.Delete(manifest);progress("delete-removed-manifest");
            }
            stopped();cancel.ThrowIfCancellationRequested();directory(retired);Directory.Delete(retired,false);progress("delete-folder-removed");
        }
        stopped();cancel.ThrowIfCancellationRequested();directory(history);
        // Move the validated intent itself, preserving its complete identity and
        // hashes even if the final response is lost. No owner ciphertext remains.
        var final=ReadDeletePlan(intent,id,authority);if(Json().Serialize(final)!=Json().Serialize(plan))throw new InvalidDataException("Snapshot deletion intent changed before completion");
        File.Move(intent,receipt);progress("delete-completed");return Deleted(plan,false);
    }}
    private void NoRestore(){if(Exists(Active))throw new InvalidOperationException("Resolve the pending snapshot restore before another operation");}
    public sealed class StagingEntry {public string name,operation;}
    public sealed class StagingInventory {public StagingEntry[] entries;public bool truncated;}
    // These names identify unpublished work, not ownership or permission to
    // delete it. Never read configuration, follow links, or adopt its contents.
    private StagingInventory ReadStaging(){
        var entries=new List<StagingEntry>();
        foreach(string path in Directory.EnumerateFileSystemEntries(root)){
            string name=Path.GetFileName(path),operation=name.StartsWith("create-next-",StringComparison.OrdinalIgnoreCase)?"create":name.StartsWith("restore-next-",StringComparison.OrdinalIgnoreCase)?"restore":null;
            if(operation==null)continue;
            if(entries.Count==32)return new StagingInventory{entries=entries.ToArray(),truncated=true};
            entries.Add(new StagingEntry{name=name,operation=operation});
        }
        if(stagingFactory!=null)foreach(string name in stagingFactory.Pending()){
            if(entries.Any(entry=>entry.name==name))continue;
            if(entries.Count==32)return new StagingInventory{entries=entries.ToArray(),truncated=true};
            entries.Add(new StagingEntry{name=name,operation=name.StartsWith("create-next-",StringComparison.Ordinal)?"create":"restore"});
        }
        return new StagingInventory{entries=entries.OrderBy(entry=>entry.name,StringComparer.Ordinal).ToArray(),truncated=false};
    }
    public StagingInventory Staging(){using(Operation()){return ReadStaging();}}
    public IDisposable AcquireStaging(){var held=Operation();try{NoRestore();return held;}catch{held.Dispose();throw;}}
    private void NoStaging(){if(ReadStaging().entries.Length!=0)throw new InvalidOperationException("Unpublished snapshot copies remain; verify their ownership before cleanup or another copy");}
    public Snapshot Get(string id){using(Operation()){return ReadSnapshot(id);}}
    public Restore Pending(){using(Operation()){return Exists(Active)?ReadRestore():null;}}
    public Restore History(string transactionId){using(Operation()){
        Id(transactionId);string history=Path.Combine(root,"restore-history"),path=Path.Combine(history,transactionId);if(!Directory.Exists(path))throw new InvalidOperationException("Acknowledged snapshot transaction not found");directory(history);
        var journal=ReadRestoreAt(path);if(journal.id!=transactionId||!new[]{"committed","rolled-back"}.Contains(journal.phase))throw new InvalidDataException("Acknowledged snapshot transaction changed");return journal;
    }}
    public Snapshot[] List(){using(Operation()){
        var result=new List<Snapshot>();foreach(var dir in Directory.EnumerateDirectories(root)){
            string id=Path.GetFileName(dir);Guid parsed;if(!Guid.TryParseExact(id,"D",out parsed))continue;
            if(Exists(DeleteIntent(id)))continue;
            result.Add(ReadSnapshot(id));if(result.Count>32)throw new InvalidDataException("Snapshot inventory exceeds its bound");
        }return result.OrderByDescending(v=>v.createdAt).ToArray();
    }}
    public Snapshot Create(string name,string configuration,CancellationToken cancel){using(Operation()){
        NoRestore();NoStaging();stopped();cancel.ThrowIfCancellationRequested();Configuration(configuration);
        if(string.IsNullOrWhiteSpace(name)||name.Trim().Length>60||name.Any(char.IsControl))throw new ArgumentException("Snapshot name required");
        var inventory=new HashSet<string>(Directory.EnumerateDirectories(root).Select(Path.GetFileName).Where(value=>{Guid candidate;return Guid.TryParseExact(value,"D",out candidate);}));inventory.UnionWith(DeleteIds());if(inventory.Count>=32)throw new InvalidOperationException("Snapshot limit reached");
        long bytes=0;foreach(string key in Keys)using(var input=openRead(Source(key)))bytes=checked(bytes+input.Length);reserve(checked(bytes+MaxMetadata));
        string id=Guid.NewGuid().ToString("D"),next=Path.Combine(root,"create-next-"+id);
        using(var producer=stagingFactory==null?null:stagingFactory.Begin(next,"create",id)){
        directory(next);
        var files=new List<FileRecord>();foreach(string key in Keys)files.Add(Copy(Source(key),FileAt(next,key),key,cancel,producer));
        var snapshot=new Snapshot{version=1,id=id,environmentId=environmentId,name=name.Trim(),createdAt=DateTime.UtcNow.ToString("o"),configuration=configuration,files=files.ToArray()};
        Save(Path.Combine(next,"manifest.json"),snapshot,producer);progress("create-before-publish");stopped();cancel.ThrowIfCancellationRequested();
        if(producer==null)Directory.Move(next,Path.Combine(root,id));else producer.Publish(Path.Combine(root,id));progress("create-published");return snapshot;
        }
    }}
    public Restore PrepareRestore(string id,string previousConfiguration,CancellationToken cancel){return PrepareRestore(id,previousConfiguration,cancel,null);}
    public Restore PrepareRestore(string id,string previousConfiguration,CancellationToken cancel,string coordinator){return PrepareRestore(id,previousConfiguration,cancel,coordinator,null);}
    public Restore PrepareRestore(string id,string previousConfiguration,CancellationToken cancel,string coordinator,string origin){using(Operation()){
        NoRestore();NoStaging();stopped();cancel.ThrowIfCancellationRequested();Configuration(previousConfiguration);Coordinator(coordinator);Origin(origin);var snapshot=ReadSnapshot(id);
        var before=Keys.Select(key=>Inspect(Source(key),key,cancel)).ToArray();reserve(checked(snapshot.files.Sum(f=>f.bytes)+MaxMetadata));
        string transactionId=Guid.NewGuid().ToString("D"),next=Path.Combine(root,"restore-next-"+transactionId);Restore journal;
        using(var producer=stagingFactory==null?null:stagingFactory.Begin(next,"restore",transactionId)){
        directory(next);
        foreach(var entry in snapshot.files){var copied=Copy(FileAt(Path.Combine(root,id),entry.key),FileAt(next,entry.key+".next"),entry.key,cancel,producer);if(!Same(copied,entry))throw new InvalidDataException("Snapshot integrity check failed before restore");}
        journal=new Restore{version=1,id=transactionId,snapshotId=id,environmentId=environmentId,phase="prepared",previousConfiguration=previousConfiguration,configuration=snapshot.configuration,previous=before,files=snapshot.files,coordinator=coordinator,origin=origin};
        Save(Path.Combine(next,"journal.json"),journal,producer);progress("restore-before-publish");stopped();cancel.ThrowIfCancellationRequested();foreach(var entry in before)Match(Source(entry.key),entry,cancel);
        if(producer==null)Directory.Move(next,Active);else producer.Publish(Active);progress("restore-prepared");
        }
        foreach(var entry in snapshot.files){
            stopped();cancel.ThrowIfCancellationRequested();Match(Source(entry.key),before.Single(f=>f.key==entry.key),cancel);Match(FileAt(Active,entry.key+".next"),entry,cancel);
            File.Replace(FileAt(Active,entry.key+".next"),Source(entry.key),FileAt(Active,entry.key+".rollback"));progress("restore-replaced-"+entry.key);
        }
        journal.phase="applied";Save(Path.Combine(Active,"journal.json"),journal);progress("restore-applied");return journal;
    }}
    // The native owner boundary must first prove the previous controller has
    // exited. Persist its replacement before disk or ordinary metadata replay.
    public Restore BindCoordinator(string transactionId,string previousCoordinator,string coordinator){using(Operation()){
        stopped();Id(transactionId);Coordinator(coordinator);if(coordinator==null)throw new ArgumentException("Snapshot coordinator required");var journal=ReadRestore();
        if(journal.id!=transactionId||journal.coordinator!=previousCoordinator)throw new InvalidOperationException("Snapshot coordinator transaction changed");
        journal.coordinator=coordinator;Save(Path.Combine(Active,"journal.json"),journal);progress("restore-coordinator-bound");return journal;
    }}
    // Only the broker creates this bounded opaque plan. Persist it before the
    // origin table update so an interrupted acknowledgement can retry exactly.
    public Restore BindRestoreOrigin(string transactionId,string expected,string replacement){using(Operation()){
        stopped();Id(transactionId);Origin(expected);Origin(replacement);var journal=ReadRestore();
        if(expected==null||replacement==null||journal.id!=transactionId||journal.origin!=expected||!new[]{"committed","rolled-back"}.Contains(journal.phase))throw new InvalidOperationException("Final snapshot origin transaction changed");
        if(expected!=replacement){journal.origin=replacement;Save(Path.Combine(Active,"journal.json"),journal);progress("restore-origin-planned");}return journal;
    }}
    // The owner must durably apply and validate the returned encrypted config
    // before calling CommitRestore. Until then all lifecycle operations must be
    // fenced. Recovery replays the old configuration together with old disks.
    public Restore CommitRestore(string transactionId){using(Operation()){
        stopped();Id(transactionId);var journal=ReadRestore();if(journal.id!=transactionId||!new[]{"applied","committed"}.Contains(journal.phase))throw new InvalidOperationException("Snapshot restore cannot commit this transaction");
        foreach(var f in journal.files)Match(Source(f.key),f,CancellationToken.None);
        foreach(var f in journal.previous)Match(FileAt(Active,f.key+".rollback"),f,CancellationToken.None);
        journal.phase="committed";Save(Path.Combine(Active,"journal.json"),journal);progress("restore-committed");return journal;
    }}
    public Restore RecoverRestore(){return RecoverRestore(null);}
    public Restore RecoverRestore(string transactionId){using(Operation()){
        stopped();if(transactionId!=null)Id(transactionId);if(!Exists(Active))return null;var journal=ReadRestore();if(transactionId!=null&&journal.id!=transactionId)throw new InvalidOperationException("Snapshot recovery transaction changed");
        if(journal.phase=="committed"||journal.phase=="rolled-back"){
            foreach(var f in journal.phase=="committed"?journal.files:journal.previous)Match(Source(f.key),f,CancellationToken.None);return journal;
        }
        // Validate the entire rollback plan before changing its first target.
        foreach(var old in journal.previous){
            string target=Source(old.key),rollback=FileAt(Active,old.key+".rollback");var actual=Inspect(target,old.key,CancellationToken.None);var replacement=journal.files.Single(f=>f.key==old.key);
            if(!Same(actual,old)&&!Same(actual,replacement))throw new InvalidDataException("Restore target changed; retained for explicit recovery");
            if(Exists(rollback))Match(rollback,old,CancellationToken.None);else if(!Same(actual,old))throw new InvalidDataException("Original rollback missing; preserved without guessing");
        }
        foreach(var old in journal.previous){
            string target=Source(old.key);if(Same(Inspect(target,old.key,CancellationToken.None),old))continue;
            File.Replace(FileAt(Active,old.key+".rollback"),target,FileAt(Active,old.key+".discarded-"+Guid.NewGuid().ToString("N")));progress("recovery-replaced-"+old.key);
        }
        foreach(var old in journal.previous)Match(Source(old.key),old,CancellationToken.None);
        journal.phase="rolled-back";Save(Path.Combine(Active,"journal.json"),journal);progress("restore-rolled-back");return journal;
    }}
    // Retain the old disk and all intermediate evidence. Space reclamation is
    // a separate explicit product operation, never an implicit recovery step.
    public void AcknowledgeRestore(string transactionId){using(Operation()){
        stopped();Id(transactionId);var journal=ReadRestore();if(journal.id!=transactionId||!new[]{"committed","rolled-back"}.Contains(journal.phase))throw new InvalidOperationException("Unresolved snapshot restore cannot be acknowledged");
        foreach(var f in journal.phase=="committed"?journal.files:journal.previous)Match(Source(f.key),f,CancellationToken.None);
        string history=Path.Combine(root,"restore-history");directory(history);Directory.Move(Active,Path.Combine(history,journal.id));
    }}
}
