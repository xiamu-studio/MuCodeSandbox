public static partial class MuHyperVBroker {
    private sealed class BackupReadState:IDisposable {
        public string Id,Session;
        public MuBackupReadCursor Cursor,Seed;
        public IDisposable Directory;
        public NamedPipeServerStream Pipe;
        public string PipeName;
        public void Dispose(){if(Pipe!=null)try{Pipe.Dispose();}catch{}if(Seed!=null)Seed.Dispose();if(Cursor!=null)Cursor.Dispose();if(Directory!=null)Directory.Dispose();}
    }
    private static readonly Dictionary<string,BackupReadState> BackupReads=new Dictionary<string,BackupReadState>();
    private static void CloseBackup(string id,BackupReadState expected=null){BackupReadState state;lock(Gate){if(!BackupReads.TryGetValue(id,out state)||expected!=null&&!object.ReferenceEquals(state,expected))return;}state.Dispose();lock(Gate){BackupReadState current;if(BackupReads.TryGetValue(id,out current)&&object.ReferenceEquals(current,state))BackupReads.Remove(id);}}
    private static void CloseAllBackups(){string[] ids;lock(Gate)ids=BackupReads.Keys.ToArray();foreach(string id in ids)try{CloseBackup(id);}catch{}}
    private static void CheckBackupBusy(string id,string action){
        CompactionPending(id,action);
        SnapshotExportAdmission(id,action);
        if(new[]{"backup-begin","backup-read","backup-seed","backup-stream","backup-close","allocation","status","inspect","stop","recover","absence","disk-growth-status"}.Contains(action))return;
        lock(Gate)if(BackupReads.ContainsKey(id))throw new MuStorageException("BACKUP_BUSY","Release the stopped disk backup before mutating this environment");
    }
    private static object BackupReadAction(string action,Dictionary<string,object> request,CancellationToken cancellation){
        string id=Id(request);
        if(action=="backup-begin"){
            ValidateKeys(request,"action","id");CheckPower();cancellation.ThrowIfCancellationRequested();
            lock(Gate)if(BackupReads.Count!=0||SnapshotExports.Count!=0)throw new MuStorageException("BACKUP_BUSY","A disk backup is already open");
            var record=Owned(id);if(Convert.ToString(record["stage"])!="ready"||record.ContainsKey("baseBuilder")||record.ContainsKey("baseSealedDigest")||record.ContainsKey("backupRestore")||GrowthJournal(record)!=null)throw new UnauthorizedAccessException("Only a complete stopped environment without pending disk growth may be backed up");
            // GrowthFacts is read-only and requires the original Off VM, private
            // topology, detached standalone VHDX and no foreign parent references.
            var before=GrowthFacts(record,cancellation);var parameters=Parameters(record);string platform=Convert.ToString(record["platformId"]),directory=Convert.ToString(parameters["directory"]);
            var vmSid=(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",platform).Translate(typeof(SecurityIdentifier));RecoveryAcl(directory,vmSid,true);CheckRemovalTree(directory);
            var handle=CreateFile(directory,0x80000000,3,IntPtr.Zero,3,0x02000000|0x00200000,IntPtr.Zero);if(handle==new IntPtr(-1))throw new IOException("Cannot pin the backup allocation directory");
            var state=new BackupReadState{Id=id,Session=Guid.NewGuid().ToString("D"),Directory=new HandleOwner(handle)};FileStream source=null,seed=null;
            try{
                source=RecoveryFile(Convert.ToString(parameters["disk"]),vmSid);
                seed=RecoveryFile(Convert.ToString(parameters["seed"]),vmSid);if(seed.Length<32774||seed.Length>8L*1024*1024)throw new IOException("Seed exceeds its fixed backup bounds");string seedHash=RecoveryHash(seed,cancellation);seed.Position=0;
                if(source.Length>MuResourceMetrics.DiskFootprint(Convert.ToInt64(record["diskGiB"])*MuResourcePolicy.GiB))throw new IOException("Disk file exceeds bounded backup capacity");
                string hash=RecoveryHash(source,cancellation);source.Position=0;
                var after=GrowthFacts(record,cancellation);if(before.Count!=after.Count||before.Any(pair=>!after.ContainsKey(pair.Key)||Convert.ToString(pair.Value)!=Convert.ToString(after[pair.Key])))throw new IOException("Backup disk identity changed");
                CheckPower();cancellation.ThrowIfCancellationRequested();
                state.Cursor=new MuBackupReadCursor(source,CheckPower);source=null;
                state.Seed=new MuBackupReadCursor(seed,CheckPower);seed=null;
                lock(Gate){if(Stopping||PowerCancellation.IsCancellationRequested||ResourceCancellation.IsCancellationRequested)throw new OperationCanceledException("Backup session was revoked");if(BackupReads.Count!=0||SnapshotExports.Count!=0)throw new MuStorageException("BACKUP_BUSY","Another disk backup opened during review");BackupReads.Add(id,state);}
                return new {id=id,session=state.Session,bytes=state.Cursor.Length,sha256=hash,seed=new {bytes=state.Seed.Length,sha256=seedHash},chunkBytes=MuBackupReadCursor.ChunkBytes,platformId=platform,imageSha256=record["imageSha256"],cpus=record["cpus"],memoryGiB=record["memoryGiB"],diskGiB=record["diskGiB"],diskIdentifier=after["diskIdentifier"],state="Off"};
            }catch{if(source!=null)source.Dispose();if(seed!=null)seed.Dispose();state.Dispose();throw;}
        }
        ValidateKeys(request,action=="backup-read"||action=="backup-seed"?new[]{"action","id","session","offset"}:new[]{"action","id","session"});
        string session=Text(request,"session",36);Guid parsed;if(!Guid.TryParseExact(session,"D",out parsed)||parsed==Guid.Empty||parsed.ToString("D")!=session)throw new ArgumentException("Canonical backup session required");
        BackupReadState current;lock(Gate)BackupReads.TryGetValue(id,out current);
        if(current==null){if(action=="backup-close")return new {closed=true};throw new MuStorageException("BACKUP_EXPIRED","Backup session is closed; start a new export");}
        if(current.Session!=session)throw new UnauthorizedAccessException("Backup session changed");
        if(action=="backup-close"){CloseBackup(id);return new {closed=true};}
        if(action=="backup-stream"){
            if(current.Pipe!=null||current.Cursor.Offset!=0)throw new MuStorageException("BACKUP_BUSY","This backup already has a reader");
            current.PipeName="MuCodeSandbox-Backup-"+Guid.NewGuid().ToString("N");
            var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(OwnerSid),PipeAccessRights.ReadWrite,AccessControlType.Allow));security.AddAccessRule(new PipeAccessRule(SystemSid,PipeAccessRights.FullControl,AccessControlType.Allow));security.AddAccessRule(new PipeAccessRule(AdminSid,PipeAccessRights.FullControl,AccessControlType.Allow));
            current.Pipe=new NamedPipeServerStream(current.PipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,65536,65536,security);
            var worker=new Thread(()=>StreamBackup(current));worker.IsBackground=true;worker.Start();return new {pipeName=current.PipeName};
        }
        if(current.Pipe!=null)throw new MuStorageException("BACKUP_BUSY","The binary stream owns this backup cursor");
        object offset;if(!request.TryGetValue("offset",out offset)||!(offset is int)&&!(offset is long))throw new ArgumentException("Exact backup offset required");
        byte[] bytes=null;
        try{cancellation.ThrowIfCancellationRequested();var cursor=action=="backup-seed"?current.Seed:current.Cursor;bytes=cursor.Read(Convert.ToInt64(offset));return new {data=Convert.ToBase64String(bytes),nextOffset=cursor.Offset,done=cursor.Offset==cursor.Length};}
        catch{CloseBackup(id);throw;}finally{if(bytes!=null)Array.Clear(bytes,0,bytes.Length);}
    }
    private static void StreamBackup(BackupReadState state){
        try{
            // Authenticate a short client hello before emitting disk bytes.
            // The data pipe has the same SID and exact process binding as IPC.
            using(var helloTimeout=new Timer(_=>{try{state.Pipe.Dispose();}catch{}},null,15000,Timeout.Infinite)){
                state.Pipe.WaitForConnection();if(state.Pipe.ReadByte()!=46)throw new UnauthorizedAccessException("Backup stream handshake rejected");
                uint pid;if(!GetNamedPipeClientProcessId(state.Pipe.SafePipeHandle.DangerousGetHandle(),out pid)||pid!=Owner.Id||OwnerExited)throw new UnauthorizedAccessException("Backup stream owner rejected");
                string sid=null;state.Pipe.RunAsClient(()=>sid=WindowsIdentity.GetCurrent(true).User.Value);if(sid!=OwnerSid)throw new UnauthorizedAccessException("Backup stream user rejected");CheckPower();helloTimeout.Change(Timeout.Infinite,Timeout.Infinite);
                while(state.Cursor.Offset<state.Cursor.Length){byte[] bytes=null;try{bytes=state.Cursor.Read(state.Cursor.Offset);state.Pipe.Write(bytes,0,bytes.Length);}finally{if(bytes!=null)Array.Clear(bytes,0,bytes.Length);}}
                state.Pipe.Flush();
                // Keep the source pin until the authorized consumer closes its
                // input, including after it receives the expected final byte.
                state.Pipe.ReadByte();
            }
        }catch{}finally{CloseBackup(state.Id,state);}
    }
    private static void StartBackupCleanup(){
        StartSnapshotExportCleanup();
        Held.Add(Closing.Token.Register(CloseAllBackups));Held.Add(PowerCancellation.Token.Register(CloseAllBackups));Held.Add(ResourceCancellation.Token.Register(CloseAllBackups));
        Held.Add(new Timer(_=>{BackupReadState[] states;lock(Gate)states=BackupReads.Values.ToArray();foreach(var state in states)if(state.Cursor.Expired){lock(VmGate(state.Id)){lock(Gate){BackupReadState current;if(!BackupReads.TryGetValue(state.Id,out current)||!object.ReferenceEquals(current,state))continue;}if(state.Cursor.Expired)CloseBackup(state.Id);}}},null,5000,5000));
    }
}

public static partial class MuHyperVBroker {
    private sealed class SnapshotExportState {
        public readonly object Sync=new object();
        public string Id,Session,SnapshotId,Binding,PipeName;
        public Dictionary<string,object> Original;
        public CancellationTokenSource Cancellation;
        public IDisposable Directory;
        public MuOfflineSnapshotStore.ExportRead History;
        public MuOfflineSnapshotStore.Snapshot Metadata;
        public NamedPipeServerStream Pipe;
        public bool Opening=true,CloseQueued;
        public long Offset,SeedOffset;
        public readonly Stopwatch Preparing=Stopwatch.StartNew();
    }
    private static readonly Dictionary<string,SnapshotExportState> SnapshotExports=new Dictionary<string,SnapshotExportState>();
    private static bool CloseSnapshotExport(string id,SnapshotExportState expected=null){
        SnapshotExportState state;lock(Gate){if(!SnapshotExports.TryGetValue(id,out state)||expected!=null&&!object.ReferenceEquals(expected,state))return true;}
        try{state.Cancellation.Cancel();}catch(ObjectDisposedException){}
        lock(Gate)if(state.Opening)return false;
        lock(state.Sync){
            if(state.Pipe!=null){state.Pipe.Dispose();state.Pipe=null;}if(state.History!=null){state.History.Dispose();state.History=null;}if(state.Directory!=null){state.Directory.Dispose();state.Directory=null;}
            lock(Gate){SnapshotExportState current;if(SnapshotExports.TryGetValue(id,out current)&&object.ReferenceEquals(current,state))SnapshotExports.Remove(id);}state.Cancellation.Dispose();
        }return true;
    }
    private static void CancelSnapshotExport(SnapshotExportState state){
        try{state.Cancellation.Cancel();}catch(ObjectDisposedException){}
        lock(Gate){if(state.CloseQueued)return;state.CloseQueued=true;}
        ThreadPool.QueueUserWorkItem(_=>{try{CloseSnapshotExport(state.Id,state);}catch{}finally{lock(Gate)state.CloseQueued=false;}});
    }
    private static void SnapshotExportAdmission(string id,string action){
        SnapshotExportState state;lock(Gate){if(!SnapshotExports.TryGetValue(id,out state))return;}
        if(action=="stop"||action=="close-channel"){CancelSnapshotExport(state);return;}
        if(new[]{"allocation","status","inspect","channel","backup-read","backup-seed","backup-stream","backup-close"}.Contains(action))return;
        throw new MuStorageException("BACKUP_BUSY","A historical snapshot read is active; VM access and stop remain available");
    }
    private static void SnapshotExportAuthority(SnapshotExportState state){
        state.Cancellation.Token.ThrowIfCancellationRequested();CheckPower();if(ResourceIssue!=null)throw new MuStorageException("RESOURCE_FENCED","Snapshot export was revoked");QuiesceAdmission("snapshot-export-begin");
        lock(Gate){SnapshotExportState active;var record=Owned(state.Id);if(!SnapshotExports.TryGetValue(state.Id,out active)||!object.ReferenceEquals(active,state)||!object.ReferenceEquals(record,state.Original)||Json().Serialize(record)!=state.Binding)throw new UnauthorizedAccessException("Snapshot export allocation changed");}
        state.Cancellation.Token.ThrowIfCancellationRequested();
    }
    private static object SnapshotExportBegin(Dictionary<string,object> request,CancellationToken cancellation){
        ValidateKeys(request,"action","id","snapshotId");string id=Id(request),snapshotId=Id(new Dictionary<string,object>{{"id",Text(request,"snapshotId",36)}});SnapshotExportState state=null;
        try{
            lock(VmGate(id)){
                QuiesceAdmission("snapshot-export-begin");CheckPower();cancellation.ThrowIfCancellationRequested();if(ResourceIssue!=null)throw new MuStorageException("RESOURCE_FENCED","Snapshot export was revoked");SnapshotLiveAdmission(id,"snapshot-export-begin",request);CheckBackupBusy(id,"snapshot-export-begin");RestorePending(id,"snapshot-export-begin");SnapshotPending(id,"snapshot-export-begin");
                var original=Owned(id);if(Convert.ToString(original["stage"])!="ready"||!original.ContainsKey("platformId")||original.ContainsKey("baseBuilder")||original.ContainsKey("baseSealedDigest")||original.ContainsKey("backupRestore")||GrowthJournal(original)!=null)throw new UnauthorizedAccessException("Only a complete work allocation can export historical snapshots");
                state=new SnapshotExportState{Id=id,Session=Guid.NewGuid().ToString("D"),SnapshotId=snapshotId,Original=original,Binding=Json().Serialize(original),Cancellation=CancellationTokenSource.CreateLinkedTokenSource(Closing.Token,PowerCancellation.Token,ResourceCancellation.Token,QuiesceCancellation.Token)};
                lock(Gate){if(BackupReads.Count!=0||SnapshotExports.Count!=0)throw new MuStorageException("BACKUP_BUSY","Another disk read is active");SnapshotExports.Add(id,state);}
                state.Directory=SnapshotPin(original);
            }
            // No VmGate, ImportGate, current disk read or provider wait during
            // historical hashing. The reservation above fences source removal.
            using(var opening=CancellationTokenSource.CreateLinkedTokenSource(cancellation,state.Cancellation.Token)){
                var record=Json().Deserialize<Dictionary<string,object>>(state.Binding);
                var store=SnapshotDeletionStore(record,()=>{throw new InvalidOperationException("Historical export must not stop or mutate the current VM");});
                state.History=store.OpenExport(snapshotId,s=>{SnapshotExportAuthority(state);SnapshotEnvelope(record,s.configuration,true);},()=>SnapshotExportAuthority(state),opening.Token);
                var metadata=state.History.Metadata;var envelope=SnapshotEnvelope(record,metadata.configuration,true);var disk=metadata.files.Single(f=>f.key=="disk");var seed=metadata.files.Single(f=>f.key=="seed");
                if(seed.bytes<32774||disk.bytes>MuResourceMetrics.DiskFootprint(Convert.ToInt64(envelope["diskGiB"])*MuResourcePolicy.GiB))throw new IOException("Historical files exceed snapshot resource bounds");
                SnapshotExportAuthority(state);opening.Token.ThrowIfCancellationRequested();lock(Gate){state.Cancellation.Token.ThrowIfCancellationRequested();state.Metadata=metadata;state.Opening=false;}
                return new {kind="snapshot",id=id,session=state.Session,snapshotId=snapshotId,name=metadata.name,createdAt=metadata.createdAt,bytes=disk.bytes,sha256=disk.sha256,seed=new{bytes=seed.bytes,sha256=seed.sha256},chunkBytes=MuOfflineSnapshotStore.ExportRead.ChunkBytes,platformId=record["platformId"],imageSha256=envelope["imageSha256"],cpus=envelope["cpus"],memoryGiB=envelope["memoryGiB"],diskGiB=envelope["diskGiB"],ownerConfiguration=envelope["ownerConfiguration"]};
            }
        }catch{if(state!=null){lock(Gate)state.Opening=false;try{CloseSnapshotExport(id,state);}catch{}state.Cancellation.Dispose();}throw;}
    }
    private static byte[] ReadSnapshotExport(SnapshotExportState state,bool seed,long offset,CancellationToken cancellation){lock(state.Sync){
        SnapshotExportAuthority(state);if(state.Opening||state.History==null)throw new MuStorageException("BACKUP_EXPIRED","Snapshot read is closed");
        var bytes=seed?state.History.ReadSeed(offset,cancellation):state.History.ReadDisk(offset,cancellation);if(seed)state.SeedOffset=checked(offset+bytes.Length);else state.Offset=checked(offset+bytes.Length);return bytes;
    }}
    private static object SnapshotExportAction(string action,Dictionary<string,object> request,CancellationToken cancellation){
        if(action=="snapshot-export-begin")return SnapshotExportBegin(request,cancellation);
        ValidateKeys(request,action=="snapshot-export-read"||action=="snapshot-export-seed"?new[]{"action","id","session","offset"}:new[]{"action","id","session"});string id=Id(request),session=Id(new Dictionary<string,object>{{"id",Text(request,"session",36)}});
        SnapshotExportState state;lock(Gate)SnapshotExports.TryGetValue(id,out state);if(state==null){if(action=="snapshot-export-close")return new {closed=true};throw new MuStorageException("BACKUP_EXPIRED","Snapshot read is closed");}if(state.Session!=session)throw new UnauthorizedAccessException("Snapshot read session changed");
        if(action=="snapshot-export-close")return new {closed=CloseSnapshotExport(id,state)};
        SnapshotExportAuthority(state);if(state.Opening||state.History==null)throw new MuStorageException("BACKUP_BUSY","Snapshot review is still pending");
        if(action=="snapshot-export-stream"){
            lock(state.Sync){if(state.Pipe!=null||state.Offset!=0)throw new MuStorageException("BACKUP_BUSY","Snapshot already has a disk reader");state.PipeName="MuCodeSandbox-SnapshotExport-"+Guid.NewGuid().ToString("N");var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(OwnerSid),PipeAccessRights.ReadWrite,AccessControlType.Allow));security.AddAccessRule(new PipeAccessRule(SystemSid,PipeAccessRights.FullControl,AccessControlType.Allow));security.AddAccessRule(new PipeAccessRule(AdminSid,PipeAccessRights.FullControl,AccessControlType.Allow));state.Pipe=new NamedPipeServerStream(state.PipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,65536,65536,security);var worker=new Thread(()=>StreamSnapshotExport(state));worker.IsBackground=true;worker.Start();return new {pipeName=state.PipeName};}
        }
        if(state.Pipe!=null)throw new MuStorageException("BACKUP_BUSY","Binary stream owns the snapshot cursor");object offset;if(!request.TryGetValue("offset",out offset)||!(offset is int)&&!(offset is long))throw new ArgumentException("Exact snapshot offset required");byte[] bytes=null;
        try{bytes=ReadSnapshotExport(state,action=="snapshot-export-seed",Convert.ToInt64(offset),cancellation);return new {data=Convert.ToBase64String(bytes),nextOffset=action=="snapshot-export-seed"?state.SeedOffset:state.Offset,done=(action=="snapshot-export-seed"?state.SeedOffset:state.Offset)==state.Metadata.files.Single(f=>f.key==(action=="snapshot-export-seed"?"seed":"disk")).bytes};}
        catch{CancelSnapshotExport(state);throw;}finally{if(bytes!=null)Array.Clear(bytes,0,bytes.Length);}
    }
    private static void StreamSnapshotExport(SnapshotExportState state){
        try{
            using(var timeout=new Timer(_=>{try{state.Pipe.Dispose();}catch{}},null,15000,Timeout.Infinite)){
                state.Pipe.WaitForConnection();if(state.Pipe.ReadByte()!=46)throw new UnauthorizedAccessException("Snapshot stream handshake rejected");uint pid;if(!GetNamedPipeClientProcessId(state.Pipe.SafePipeHandle.DangerousGetHandle(),out pid)||pid!=Owner.Id||OwnerExited)throw new UnauthorizedAccessException("Snapshot stream owner rejected");string sid=null;state.Pipe.RunAsClient(()=>sid=WindowsIdentity.GetCurrent(true).User.Value);if(sid!=OwnerSid)throw new UnauthorizedAccessException("Snapshot stream user rejected");SnapshotExportAuthority(state);timeout.Change(Timeout.Infinite,Timeout.Infinite);
                long length=state.Metadata.files.Single(f=>f.key=="disk").bytes;while(state.Offset<length){byte[] bytes=null;try{bytes=ReadSnapshotExport(state,false,state.Offset,CancellationToken.None);state.Pipe.Write(bytes,0,bytes.Length);}finally{if(bytes!=null)Array.Clear(bytes,0,bytes.Length);}}state.Pipe.Flush();state.Pipe.ReadByte();
            }
        }catch{}finally{try{CloseSnapshotExport(state.Id,state);}catch{}}
    }
    private static void StartSnapshotExportCleanup(){
        Action close=()=>{SnapshotExportState[] states;lock(Gate)states=SnapshotExports.Values.ToArray();foreach(var state in states)CancelSnapshotExport(state);};
        Held.Add(Closing.Token.Register(close));Held.Add(PowerCancellation.Token.Register(close));Held.Add(ResourceCancellation.Token.Register(close));Held.Add(QuiesceCancellation.Token.Register(close));
        Held.Add(new Timer(_=>{SnapshotExportState[] states;lock(Gate)states=SnapshotExports.Values.ToArray();foreach(var state in states){var history=state.History;if(state.Opening?state.Preparing.ElapsedMilliseconds>1200000:history==null||history.Expired)CancelSnapshotExport(state);}},null,5000,5000));
    }
}
