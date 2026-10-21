public static class MuResourcePolicy {
    public const long GiB=1024L*1024*1024,DiskFloor=2L*GiB,VirtualLimitGiB=1024;
    public static long MemoryReserve(long total){if(total<=0)throw new ArgumentException("Physical memory metric required");return Math.Max(GiB,total/10);}
    public static long MemoryCritical(long total){if(total<=0)throw new ArgumentException("Physical memory metric required");return Math.Max(GiB/2,total/20);}
    public static void Quota(long registeredGiB,long requestedGiB){if(registeredGiB<0||requestedGiB<16||requestedGiB>256)throw new ArgumentException("Invalid virtual disk reservation");if(registeredGiB>VirtualLimitGiB-requestedGiB)throw new MuStorageException("RESOURCE_QUOTA","Per-user virtual disk reservation limit reached");}
    public static void MemoryRequest(long total,long available,long request){
        if(available<0||available>total||request<0)throw new ArgumentException("Invalid physical memory metrics");
        long reserve=MemoryReserve(total);if(request>total-total/5||available<reserve||request>available-reserve)throw new MuStorageException("RESOURCE_MEMORY","Insufficient available memory for the VM and host reserve");
    }
    public static void DiskRequest(long available,long growth,long additional){
        if(available<0||growth<0||additional<0)throw new ArgumentException("Invalid storage metrics");
        if(available<DiskFloor||growth>available-DiskFloor||additional>available-DiskFloor-growth)throw new MuStorageException("RESOURCE_DISK","Insufficient volume space for existing disk growth and the requested operation");
    }
}
public static partial class MuHyperVBroker {
    private static readonly object StartGate=new object();
    private static readonly CancellationTokenSource ResourceCancellation=new CancellationTokenSource();
    private static readonly string ResourceSession=Guid.NewGuid().ToString("N");
    private static volatile string ResourceIssue;
    private static volatile bool ResourceCleanupRunning,ResourceStopsConfirmed;
    private static long LastReservedGrowth,LastAssignedMemory;
    private static int ResourceMutations;
    private static bool ResourceMutation(string action){return new[]{"disk","begin-base","prepare","create","start","seal-base"}.Contains(action);}
    private static FileStream ImportReservation(){
        string common=Directory.GetParent(Directory.GetParent(UserRoot).FullName).FullName;
        try{return new FileStream(Path.Combine(common,"import.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);}catch(IOException){throw new MuStorageException("STORAGE_BUSY","Another image operation is still running");}
    }
    private static long ReservedGrowth(CancellationToken cancellation){
        var result=Json().Deserialize<Dictionary<string,object>>(Invoke("resource-inventory",new Dictionary<string,object>{{"resourceRoot",UserRoot}},60000,cancellation));
        object value;if(!result.TryGetValue("reservedGrowthBytes",out value)||!(value is int)&&!(value is long)||Convert.ToInt64(value)<0)throw new IOException("Invalid disk reservation inventory");
        long bytes=Convert.ToInt64(value);Interlocked.Exchange(ref LastReservedGrowth,bytes);object memory;if(!result.TryGetValue("assignedMemoryBytes",out memory)||!(memory is int)&&!(memory is long)||Convert.ToInt64(memory)<0)throw new IOException("Invalid assigned memory inventory");Interlocked.Exchange(ref LastAssignedMemory,Convert.ToInt64(memory));return bytes;
    }
    private static void CheckDiskRequest(long additional,CancellationToken cancellation){
        if(ResourceIssue!=null)throw new MuStorageException("RESOURCE_FENCED","Host resource protection has closed this session; reopen the application");
        long growth=ReservedGrowth(cancellation);MuResourcePolicy.DiskRequest(MuResourceMetrics.Read(UserRoot).freeDisk,growth,additional);
    }
    private static void CheckNewDisk(Dictionary<string,object> record,CancellationToken cancellation){
        string image=Convert.ToString(record["image"]);long temporary=(File.GetAttributes(image)&FileAttributes.SparseFile)!=0||Convert.ToString(record["imageSha256"])==CanonicalBuilderDigest?new FileInfo(image).Length:0;
        CheckDiskRequest(checked(MuResourceMetrics.DiskFootprint(Convert.ToInt64(record["diskGiB"])*MuResourcePolicy.GiB)+temporary),cancellation);
    }
    private static object ResourceStatus(){
        var metrics=MuResourceMetrics.Read(UserRoot);long registered;lock(Gate)registered=Records.Values.Sum(record=>Convert.ToInt64(record["diskGiB"]));
        return new {session=ResourceSession,totalMemoryBytes=metrics.totalMemory,availableMemoryBytes=metrics.availableMemory,memoryReserveBytes=MuResourcePolicy.MemoryReserve(metrics.totalMemory),memoryCriticalBytes=MuResourcePolicy.MemoryCritical(metrics.totalMemory),freeDiskBytes=metrics.freeDisk,diskFloorBytes=MuResourcePolicy.DiskFloor,lastReservedGrowthBytes=Interlocked.Read(ref LastReservedGrowth),virtualDiskLimitGiB=MuResourcePolicy.VirtualLimitGiB,registeredDiskGiB=registered,fenced=ResourceIssue!=null,issue=ResourceIssue,cleanupRunning=ResourceCleanupRunning,stopsConfirmed=ResourceStopsConfirmed};
    }
    private static void StartWithResources(Dictionary<string,object> record,CancellationToken cancellation,Action start){
        if(!Monitor.TryEnter(StartGate))throw new MuStorageException("RESOURCE_BUSY","Another VM start is still in progress");
        try{
            string common=Directory.GetParent(Directory.GetParent(UserRoot).FullName).FullName;FileStream startLock;
            try{startLock=new FileStream(Path.Combine(common,"start.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);}catch(IOException){throw new MuStorageException("RESOURCE_BUSY","Another user is starting a VM");}
            using(startLock){lock(ImportGate)using(ImportReservation()){
                CheckDiskRequest(0,cancellation);var metrics=MuResourceMetrics.Read(UserRoot);long available=Math.Min(metrics.availableMemory,Math.Max(0,metrics.totalMemory-Interlocked.Read(ref LastAssignedMemory)));MuResourcePolicy.MemoryRequest(metrics.totalMemory,available,checked(Convert.ToInt64(record["memoryGiB"])*MuResourcePolicy.GiB));start();
            }}
        }finally{Monitor.Exit(StartGate);}
    }
    private static void ResourceGuardian(){
        while(!Closing.Token.WaitHandle.WaitOne(2000)){
            try{
                bool active;lock(Gate)active=StartedHere.Count>0||ResourceMutations>0;
                if(ResourceIssue==null&&active){
                    var metrics=MuResourceMetrics.Read(UserRoot);string reason=metrics.freeDisk<MuResourcePolicy.DiskFloor?"disk":metrics.availableMemory<MuResourcePolicy.MemoryCritical(metrics.totalMemory)?"memory":null;
                    if(reason!=null){
                        ResourceIssue=reason;ResourceCancellation.Cancel();
                        foreach(var record in RecordSnapshot())CloseChannel(Convert.ToString(record["id"]));
                        try{File.WriteAllText(Path.Combine(UserRoot,"resource-trip.json"),Json().Serialize(new {session=ResourceSession,reason=reason,availableMemoryBytes=metrics.availableMemory,freeDiskBytes=metrics.freeDisk,time=DateTime.UtcNow.ToString("o")}));}catch{}
                    }
                }
                if(ResourceIssue!=null&&!ResourceStopsConfirmed){
                    ResourceCleanupRunning=true;bool confirmed=true;
                    foreach(var entry in RecordSnapshot())try{string id=Convert.ToString(entry["id"]);lock(VmGate(id))RecoverAllocation(Owned(id));}catch{confirmed=false;}
                    ResourceStopsConfirmed=confirmed;ResourceCleanupRunning=false;
                }
            }catch{if(ResourceIssue==null){ResourceIssue="metrics-unavailable";ResourceCancellation.Cancel();foreach(var entry in RecordSnapshot())CloseChannel(Convert.ToString(entry["id"]));}ResourceCleanupRunning=false;}
        }
    }
    private static void StartResourceGuardian(){
        File.WriteAllText(Path.Combine(UserRoot,"resource-session.json"),Json().Serialize(new {session=ResourceSession,ownerPid=Owner.Id,ownerSid=OwnerSid}));
        var thread=new Thread(ResourceGuardian);thread.IsBackground=true;thread.Start();
    }
}
