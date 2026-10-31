// Creation authority comes from the original protected restore journal, saved
// before this directory exists. It is never reconstructed from damaged bytes.
public static partial class MuHyperVBroker {
    private static Dictionary<string,object> OriginRootIdentity(){
        var handle=CreateFile(UserRoot,0x80000081,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);if(handle==new IntPtr(-1))throw new IOException("Cannot pin origin preparation root");
        using(var owner=new HandleOwner(handle))using(var safe=new Microsoft.Win32.SafeHandles.SafeFileHandle(handle,false))return MuRestoreOriginStore.CaptureIdentity(safe);
    }
    private static bool HasOriginPreparation(Dictionary<string,object> record){object raw;return record.TryGetValue("backupRestore",out raw)&&raw is Dictionary<string,object>&&((Dictionary<string,object>)raw).ContainsKey("originInitialization");}
    private static void GuardOriginPreparation(Dictionary<string,object> record,Dictionary<string,object> journal){
        lock(Gate){Dictionary<string,object> current;object pending;
            if(!Records.TryGetValue(Convert.ToString(record["id"]),out current)||!object.ReferenceEquals(current,record)||!record.TryGetValue("backupRestore",out pending)||!object.ReferenceEquals(journal,pending)||!OriginTracked(record)||Convert.ToString(record["ownerSid"])!=OwnerSid||record.ContainsKey("diskGrowth")||record.ContainsKey("baseBuilder")||record.ContainsKey("sealedSource"))throw new UnauthorizedAccessException("Original protected restore intent required for origin preparation");
            if(Records.Values.Any(value=>!object.ReferenceEquals(value,record)&&(HasOriginPreparation(value)||OriginTracked(value)&&(!value.ContainsKey("backupRestore")||value.ContainsKey("platformId")||HasStorage(Path.Combine(UserRoot,"vms",Convert.ToString(value["id"])))))))throw new MuStorageException("RESTORE_ORIGIN_PREPARING","Resume the original metadata preparation or diagnose the missing origin table; existing resources preserved");
        }
    }
    private static MuRestoreOriginStore OpenOriginStore(Dictionary<string,object> record,CancellationToken cancellation){
        var journal=(Dictionary<string,object>)record["backupRestore"];string directory=Path.Combine(UserRoot,"restore-origins");
        lock(Gate)if(Records.Values.Any(value=>!object.ReferenceEquals(value,record)&&HasOriginPreparation(value)))throw new MuStorageException("RESTORE_ORIGIN_PREPARING","Resume the original backup metadata preparation first");
        if(!journal.ContainsKey("originInitialization")){
            if(HasStorage(directory))return OpenOriginStore();
            GuardOriginPreparation(record,journal);cancellation.ThrowIfCancellationRequested();
            var plan=new Dictionary<string,object>{{"version",1},{"epoch",Guid.NewGuid().ToString("D")},{"rootFile",OriginRootIdentity()},{"directoryFile",null},{"storeFile",null}};
            lock(Gate){journal["originInitialization"]=plan;try{Save();}catch{journal.Remove("originInitialization");throw;}}
        }
        GuardOriginPreparation(record,journal);var original=(Dictionary<string,object>)journal["originInitialization"];MuOriginPreparation.Validate(original);if(!MuOriginPreparation.Same(original["rootFile"],OriginRootIdentity()))throw new UnauthorizedAccessException("Origin preparation root changed");cancellation.ThrowIfCancellationRequested();if(original["directoryFile"]!=null&&!HasStorage(directory))throw new IOException("Bound origin preparation directory missing; preserved");PrivateDirectory(directory,false);
        var active=original;return OpenPreparedOriginStore(original,bound=>{
            GuardOriginPreparation(record,journal);MuOriginPreparation.Validate(bound);if(Json().Serialize(journal["originInitialization"])!=Json().Serialize(original))throw new UnauthorizedAccessException("Origin preparation journal changed");cancellation.ThrowIfCancellationRequested();
            lock(Gate){journal["originInitialization"]=bound;try{Save();active=bound;}catch{journal["originInitialization"]=original;throw;}}
        },()=>{
            GuardOriginPreparation(record,journal);var pending=(Dictionary<string,object>)journal["originInitialization"];MuOriginPreparation.Validate(pending);if(pending["storeFile"]==null||Json().Serialize(pending)!=Json().Serialize(active))throw new UnauthorizedAccessException("Bound origin preparation changed");cancellation.ThrowIfCancellationRequested();
            lock(Gate){journal.Remove("originInitialization");try{Save();}catch{journal["originInitialization"]=pending;throw;}}
        });
    }
}
