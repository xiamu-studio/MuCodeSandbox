public static class MuResourcePolicy {
    public const long GiB=1024L*1024*1024,DiskFloor=8L*GiB,GrowthReserveLimit=16L*GiB,VirtualLimitGiB=1024;
    public static long MemoryReserve(long total){if(total<=0)throw new ArgumentException("Physical memory metric required");return Math.Max(GiB,total/10);}
    public static long MemoryCritical(long total){if(total<=0)throw new ArgumentException("Physical memory metric required");return Math.Max(GiB/2,total/20);}
    public static void Quota(long registeredGiB,long requestedGiB){if(registeredGiB<0||requestedGiB<16||requestedGiB>256)throw new ArgumentException("Invalid virtual disk reservation");if(registeredGiB>VirtualLimitGiB-requestedGiB)throw new MuStorageException("RESOURCE_QUOTA","Per-user virtual disk reservation limit reached");}
    public static void MemoryRequest(long total,long available,long request){
        if(available<0||available>total||request<0)throw new ArgumentException("Invalid physical memory metrics");
        long reserve=MemoryReserve(total);if(request>total-total/5||available<reserve||request>available-reserve)throw new MuStorageException("RESOURCE_MEMORY","Insufficient available memory for the VM and host reserve");
    }
    public static void DiskRequest(long available,long growth,long additional){
        if(available<0||growth<0||additional<0)throw new ArgumentException("Invalid storage metrics");
        // Dynamic disks share a volume and usually do not all grow to their
        // virtual limits. Reserve a bounded growth cushion; the guardian
        // independently stops active sandboxes when the larger floor is hit.
        // Known copies/imports still reserve their complete additional bytes.
        long cushion=Math.Min(growth,GrowthReserveLimit);
        if(available<DiskFloor||cushion>available-DiskFloor||additional>available-DiskFloor-cushion)throw new MuStorageException("RESOURCE_DISK","Insufficient volume space for the growth cushion and the requested operation");
    }
}
public static partial class MuHyperVBroker {
    private static readonly MuEmergencyStopSet EmergencyStops=new MuEmergencyStopSet(TryEmergencyStop);
    private static string EmergencyAuthority(Dictionary<string,object> record){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Json().Serialize(record)+"\0"+EmergencyEpoch()))).Replace("-","").ToLowerInvariant();}
    private static Dictionary<string,string> EmergencyTargets(){
        lock(Gate){var targets=new Dictionary<string,string>();foreach(var record in Records.Values){string id=Id(record);if(Convert.ToString(record["ownerSid"])!=OwnerSid)throw new UnauthorizedAccessException("Emergency allocation owner changed");targets.Add(id,EmergencyAuthority(record));}return targets;}
    }
    private static bool TryEmergencyStop(string id,string authority){
        if(Stopping)return TryShutdownHardwareStop(id,authority);
        object vmGate=VmGate(id);if(!Monitor.TryEnter(vmGate))return false;
        try{
            var record=Owned(id);lock(Gate){if(EmergencyAuthority(record)!=authority)return false;}
            // Retain the ordinary protected identity/provider/record checks.
            // Only the wait is removed: busy allocations retry independently.
            RecoverAllocation(record);return true;
        }finally{Monitor.Exit(vmGate);}
    }
    private static bool SweepEmergencyStops(){
        var targets=EmergencyTargets();bool confirmed=EmergencyStops.Sweep(targets);if(!confirmed)return false;
        lock(Gate){if(Quiescing&&QuiesceWriters!=0)return false;var current=EmergencyTargets();return current.Count==targets.Count&&current.All(pair=>targets.ContainsKey(pair.Key)&&targets[pair.Key]==pair.Value);}
    }
    private static readonly object StartGate=new object();
    private static readonly CancellationTokenSource ResourceCancellation=new CancellationTokenSource();
    private static readonly string ResourceSession=Guid.NewGuid().ToString("N");
    private static volatile string ResourceIssue;
    private static volatile bool ResourceCleanupRunning,ResourceStopsConfirmed;
    private static long LastReservedGrowth,LastAssignedMemory;
    private static int ResourceMutations;
    private static bool ResourceMutation(string action){return new[]{"disk","begin-base","prepare","create","start","seal-base","grow-disk","start-disk-growth","start-disk-review","finish-disk-growth","backup-begin","backup-import","snapshot-create","snapshot-prepare","snapshot-commit","disk-compact-begin","disk-compact-start","disk-compact-trimmed","disk-compact-run","disk-compact-reconcile","disk-compact-verify-start","disk-compact-finish","disk-compact-retry","disk-compact-cancel"}.Contains(action);}
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
    private static void CancelResourceWorkAndCloseChannels(){
        // Cancellation has already closed the token even if a registered
        // callback throws. It must not skip independent channel teardown.
        try{ResourceCancellation.Cancel();}catch{}
        RevokeCompactionChannels();
        foreach(var record in RecordSnapshot())try{CloseChannel(Convert.ToString(record["id"]));}catch{}
        // Channel teardown alone never confirms a VM stop. The guardian still
        // independently reviews every protected allocation below.
    }
    private static void ResourceGuardian(){
        while(!Closing.Token.WaitHandle.WaitOne(2000)){
            try{
                bool active;lock(Gate)active=StartedHere.Count>0||ResourceMutations>0;
                if(ResourceIssue==null&&active){
                    var metrics=MuResourceMetrics.Read(UserRoot);string reason=metrics.freeDisk<MuResourcePolicy.DiskFloor?"disk":metrics.availableMemory<MuResourcePolicy.MemoryCritical(metrics.totalMemory)?"memory":null;
                    if(reason!=null){
                        ResourceIssue=reason;CancelResourceWorkAndCloseChannels();
                        try{File.WriteAllText(Path.Combine(UserRoot,"resource-trip.json"),Json().Serialize(new {session=ResourceSession,reason=reason,availableMemoryBytes=metrics.availableMemory,freeDiskBytes=metrics.freeDisk,time=DateTime.UtcNow.ToString("o")}));}catch{}
                    }
                }
                if(ResourceIssue!=null&&!ResourceStopsConfirmed){
                    bool confirmed=SweepEmergencyStops();ResourceStopsConfirmed=confirmed;ResourceCleanupRunning=!confirmed;
                }
            }catch{if(ResourceIssue==null){ResourceIssue="metrics-unavailable";CancelResourceWorkAndCloseChannels();}ResourceCleanupRunning=false;}
        }
    }
    private static void StartResourceGuardian(){
        File.WriteAllText(Path.Combine(UserRoot,"resource-session.json"),Json().Serialize(new {session=ResourceSession,ownerPid=Owner.Id,ownerSid=OwnerSid}));
        var thread=new Thread(ResourceGuardian);thread.IsBackground=true;thread.Start();
    }
}

// One bounded independent worker per protected allocation. A slow VM gate or
// provider must not serialize the shutdown of unrelated running environments.
// Success is cached only for the exact authority supplied by the broker.
public sealed class MuEmergencyStopSet {
    public const int Limit=32;
    public const int MaxWorkers=4;
    public const long RetryMs=1000;
    private sealed class Entry {public string Id,Authority;public bool Running,Confirmed;public long NextTry;}
    private readonly object gate=new object();
    private readonly Dictionary<string,Entry> entries=new Dictionary<string,Entry>();
    private int running;
    private readonly Func<string,string,bool> stop;
    private readonly Func<long> clock;
    private readonly Action<Action> schedule;
    private readonly System.Diagnostics.Stopwatch elapsed=System.Diagnostics.Stopwatch.StartNew();
    public MuEmergencyStopSet(Func<string,string,bool> stop,Func<long> clock=null,Action<Action> schedule=null){
        if(stop==null)throw new ArgumentNullException("stop");this.stop=stop;this.clock=clock??(()=>elapsed.ElapsedMilliseconds);this.schedule=schedule??(work=>{var thread=new Thread(()=>work());thread.IsBackground=true;thread.Start();});
    }
    public bool Sweep(IDictionary<string,string> targets){
        if(targets==null)throw new ArgumentNullException("targets");var snapshot=targets.ToArray();
        if(snapshot.Length>Limit)throw new ArgumentException("Emergency stop allocation limit changed");
        foreach(var target in snapshot){Guid id;if(!Guid.TryParseExact(target.Key,"D",out id)||id==Guid.Empty||id.ToString("D")!=target.Key||target.Value==null||target.Value.Length!=64||target.Value.Any(c=>!(c>='0'&&c<='9'||c>='a'&&c<='f')))throw new ArgumentException("Bounded protected emergency authority required");}
        long now=clock();if(now<0||now>long.MaxValue-RetryMs)throw new InvalidOperationException("Emergency retry clock is unavailable");
        var pending=new List<Entry>();bool confirmed=true;
        lock(gate){
            foreach(string old in entries.Keys.Where(id=>!snapshot.Any(target=>target.Key==id)&&!entries[id].Running).ToArray())entries.Remove(old);
            foreach(var target in snapshot){
                Entry entry;if(entries.TryGetValue(target.Key,out entry)){
                    if(entry.Authority==target.Value&&entry.Confirmed)continue;
                    confirmed=false;if(entry.Running)continue;
                    if(entry.Authority!=target.Value){entries.Remove(target.Key);entry=null;}
                }else{confirmed=false;entry=null;}
                if(entry==null){if(entries.Count>=Limit)continue;entry=new Entry{Id=target.Key,Authority=target.Value};entries.Add(target.Key,entry);}
            }
            // Four PowerShell providers bound pressure on an already stressed
            // host. Never-attempted targets precede retries, so failed targets
            // cannot monopolize every slot on each sweep.
            foreach(var entry in entries.Values.Where(e=>!e.Running&&!e.Confirmed&&now>=e.NextTry&&snapshot.Any(target=>target.Key==e.Id&&target.Value==e.Authority)).OrderBy(e=>e.NextTry).ThenBy(e=>e.Id,StringComparer.Ordinal).Take(Math.Max(0,MaxWorkers-running)).ToArray()){
                entry.Running=true;entry.NextTry=now+RetryMs;running++;pending.Add(entry);
            }
        }
        foreach(var entry in pending){
            var queued=entry;
            try{schedule(()=>{bool stopped=false;try{stopped=stop(queued.Id,queued.Authority);}catch{}finally{Complete(queued,stopped);}});}
            catch{Complete(queued,false);}
        }
        return confirmed;
    }
    private void Complete(Entry entry,bool confirmed){lock(gate){if(!entry.Running)return;entry.Confirmed=confirmed;entry.Running=false;running--;}}
}
