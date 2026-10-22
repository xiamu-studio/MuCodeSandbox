public static partial class MuHyperVBroker {
    private sealed class BackupReadState:IDisposable {
        public string Id,Session;
        public MuBackupReadCursor Cursor;
        public IDisposable Directory;
        public NamedPipeServerStream Pipe;
        public string PipeName;
        public void Dispose(){if(Pipe!=null)try{Pipe.Dispose();}catch{}if(Cursor!=null)Cursor.Dispose();if(Directory!=null)Directory.Dispose();}
    }
    private static readonly Dictionary<string,BackupReadState> BackupReads=new Dictionary<string,BackupReadState>();
    private static void CloseBackup(string id,BackupReadState expected=null){BackupReadState state;lock(Gate){if(!BackupReads.TryGetValue(id,out state)||expected!=null&&!object.ReferenceEquals(state,expected))return;}state.Dispose();lock(Gate){BackupReadState current;if(BackupReads.TryGetValue(id,out current)&&object.ReferenceEquals(current,state))BackupReads.Remove(id);}}
    private static void CloseAllBackups(){string[] ids;lock(Gate)ids=BackupReads.Keys.ToArray();foreach(string id in ids)try{CloseBackup(id);}catch{}}
    private static void CheckBackupBusy(string id,string action){
        if(new[]{"backup-begin","backup-read","backup-stream","backup-close","allocation","status","inspect","stop","recover","absence","disk-growth-status"}.Contains(action))return;
        lock(Gate)if(BackupReads.ContainsKey(id))throw new MuStorageException("BACKUP_BUSY","Release the stopped disk backup before mutating this environment");
    }
    private static object BackupReadAction(string action,Dictionary<string,object> request,CancellationToken cancellation){
        string id=Id(request);
        if(action=="backup-begin"){
            ValidateKeys(request,"action","id");CheckPower();cancellation.ThrowIfCancellationRequested();
            lock(Gate)if(BackupReads.Count!=0)throw new MuStorageException("BACKUP_BUSY","A stopped disk backup is already open");
            var record=Owned(id);if(Convert.ToString(record["stage"])!="ready"||record.ContainsKey("baseBuilder")||record.ContainsKey("baseSealedDigest")||GrowthJournal(record)!=null)throw new UnauthorizedAccessException("Only a complete stopped environment without pending disk growth may be backed up");
            // GrowthFacts is read-only and requires the original Off VM, private
            // topology, detached standalone VHDX and no foreign parent references.
            var before=GrowthFacts(record,cancellation);var parameters=Parameters(record);string platform=Convert.ToString(record["platformId"]),directory=Convert.ToString(parameters["directory"]);
            var vmSid=(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",platform).Translate(typeof(SecurityIdentifier));RecoveryAcl(directory,vmSid,true);CheckRemovalTree(directory);
            var handle=CreateFile(directory,0x80000000,3,IntPtr.Zero,3,0x02000000|0x00200000,IntPtr.Zero);if(handle==new IntPtr(-1))throw new IOException("Cannot pin the backup allocation directory");
            var state=new BackupReadState{Id=id,Session=Guid.NewGuid().ToString("D"),Directory=new HandleOwner(handle)};FileStream source=null;
            try{
                source=RecoveryFile(Convert.ToString(parameters["disk"]),vmSid);
                if(source.Length>MuResourceMetrics.DiskFootprint(Convert.ToInt64(record["diskGiB"])*MuResourcePolicy.GiB))throw new IOException("Disk file exceeds bounded backup capacity");
                string hash=RecoveryHash(source,cancellation);source.Position=0;
                var after=GrowthFacts(record,cancellation);if(before.Count!=after.Count||before.Any(pair=>!after.ContainsKey(pair.Key)||Convert.ToString(pair.Value)!=Convert.ToString(after[pair.Key])))throw new IOException("Backup disk identity changed");
                CheckPower();cancellation.ThrowIfCancellationRequested();
                state.Cursor=new MuBackupReadCursor(source,CheckPower);source=null;
                lock(Gate){if(Stopping||PowerCancellation.IsCancellationRequested||ResourceCancellation.IsCancellationRequested)throw new OperationCanceledException("Backup session was revoked");if(BackupReads.Count!=0)throw new MuStorageException("BACKUP_BUSY","Another stopped disk backup opened during review");BackupReads.Add(id,state);}
                return new {id=id,session=state.Session,bytes=state.Cursor.Length,sha256=hash,chunkBytes=MuBackupReadCursor.ChunkBytes,platformId=platform,imageSha256=record["imageSha256"],cpus=record["cpus"],memoryGiB=record["memoryGiB"],diskGiB=record["diskGiB"],diskIdentifier=after["diskIdentifier"],state="Off"};
            }catch{if(source!=null)source.Dispose();state.Dispose();throw;}
        }
        ValidateKeys(request,action=="backup-read"?new[]{"action","id","session","offset"}:new[]{"action","id","session"});
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
        try{cancellation.ThrowIfCancellationRequested();bytes=current.Cursor.Read(Convert.ToInt64(offset));return new {data=Convert.ToBase64String(bytes),nextOffset=current.Cursor.Offset,done=current.Cursor.Offset==current.Cursor.Length};}
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
        Held.Add(Closing.Token.Register(CloseAllBackups));Held.Add(PowerCancellation.Token.Register(CloseAllBackups));Held.Add(ResourceCancellation.Token.Register(CloseAllBackups));
        Held.Add(new Timer(_=>{BackupReadState[] states;lock(Gate)states=BackupReads.Values.ToArray();foreach(var state in states)if(state.Cursor.Expired){lock(VmGate(state.Id)){lock(Gate){BackupReadState current;if(!BackupReads.TryGetValue(state.Id,out current)||!object.ReferenceEquals(current,state))continue;}if(state.Cursor.Expired)CloseBackup(state.Id);}}},null,5000,5000));
    }
}
