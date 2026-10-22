// Windows-only disk growth. A durable journal reserves the requested capacity
// before VHDX mutation. Never shrink or discard a disk after an interruption.
public static class MuDiskGrowthPolicy {
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(IntPtr file,[Out]byte[] info);
    public static string FileIdentity(string path){
        if((File.GetAttributes(path)&(FileAttributes.ReparsePoint|FileAttributes.Directory))!=0)throw new UnauthorizedAccessException("Disk must be a regular protected file");
        using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){byte[] info=new byte[52];if(!GetFileInformationByHandle(file.SafeFileHandle.DangerousGetHandle(),info)||BitConverter.ToUInt32(info,40)!=1)throw new UnauthorizedAccessException("Disk hard links or unavailable file identity rejected");return (BitConverter.ToString(info,28,4)+BitConverter.ToString(info,44,8)).Replace("-","").ToLowerInvariant();}
    }
    public static void Request(long current,long target){if(current<16||current>256||target<16||target>256||target<current)throw new ArgumentException("Only bounded disk growth is supported");}
    public static void Filesystem(long target,long bytes,long start){Request(target,target);long disk=checked(target*MuResourcePolicy.GiB);if(start<1024*1024||start>2L*MuResourcePolicy.GiB||bytes>disk-start||bytes<disk-start-64L*1024*1024)throw new ArgumentException("The expanded filesystem capacity is unconfirmed");}
}
public static partial class MuHyperVBroker {
    private static Dictionary<string,object> GrowthJournal(Dictionary<string,object> record){object value;return record.TryGetValue("diskGrowth",out value)?(Dictionary<string,object>)value:null;}
    private static Dictionary<string,object> GrowthFacts(Dictionary<string,object> record,CancellationToken cancellation){
        var facts=Json().Deserialize<Dictionary<string,object>>(Invoke("disk-growth-facts",Parameters(record),60000,cancellation));
        facts["fileIdentity"]=MuDiskGrowthPolicy.FileIdentity(Convert.ToString(Parameters(record)["disk"]));
        if(Text(facts,"platformId",36)!=Convert.ToString(record["platformId"]))throw new UnauthorizedAccessException("Disk growth VM changed");
        string disk=Text(facts,"diskIdentifier",36);Guid parsed;if(!Guid.TryParseExact(disk,"D",out parsed)||parsed==Guid.Empty||parsed.ToString("D")!=disk)throw new IOException("Disk identity unavailable");
        long size=Convert.ToInt64(facts["diskGiB"]);MuDiskGrowthPolicy.Request(size,size);if(Convert.ToInt64(facts["bytes"])!=size*MuResourcePolicy.GiB)throw new IOException("Disk capacity is not integral");
        var journal=GrowthJournal(record);if(journal!=null){if(disk!=Convert.ToString(journal["diskIdentifier"])||Convert.ToString(facts["fileIdentity"])!=Convert.ToString(journal["fileIdentity"])||size!=Convert.ToInt64(journal["fromGiB"])&&size!=Convert.ToInt64(journal["targetGiB"]))throw new UnauthorizedAccessException("Pending disk growth identity changed");}
        else if(size!=Convert.ToInt64(record["diskGiB"]))throw new UnauthorizedAccessException("Disk capacity changed without an application journal");
        return facts;
    }
    private static object DiskGrowthAction(string action,Dictionary<string,object> request,CancellationToken cancellation){
        string id=Id(request);ValidateKeys(request,action=="disk-growth-status"?new[]{"action","id"}:action=="finish-disk-growth"?new[]{"action","id","targetGiB","filesystemBytes","partitionStartBytes"}:new[]{"action","id","targetGiB"});
        lock(VmGate(id)){
            var record=Owned(id);if(Convert.ToString(record["stage"])!="ready"||record.ContainsKey("baseBuilder")||record.ContainsKey("baseSealedDigest"))throw new InvalidOperationException("Only a registered environment disk may grow");
            var journal=GrowthJournal(record);
            if(action=="start-disk-growth"||action=="start-disk-review"){
                long target=Number(request,"targetGiB",16,256);if(action=="start-disk-growth"?(journal==null||Convert.ToInt64(journal["targetGiB"])!=target):(journal!=null||Convert.ToInt64(record["diskGiB"])!=target))throw new InvalidOperationException("Maintenance disk phase changed");
                var facts=GrowthFacts(record,cancellation);if(Convert.ToInt64(facts["diskGiB"])!=target)throw new InvalidOperationException("Virtual disk growth is not finished");
                CloseChannel(id);lock(Gate)StartedHere.Add(id);string started=null;
                try{StartWithResources(record,cancellation,()=>{started=Invoke("start",Parameters(record),30000,cancellation);});return started;}
                finally{if(cancellation.IsCancellationRequested){CloseChannel(id);try{Invoke("stop",Parameters(record),30000,CancellationToken.None);}catch{}}}
            }
            lock(ImportGate)using(ImportReservation()){
                var facts=GrowthFacts(record,cancellation);long actual=Convert.ToInt64(facts["diskGiB"]),registered=Convert.ToInt64(record["diskGiB"]);
                if(action=="disk-growth-status")return new {platformId=record["platformId"],diskIdentifier=facts["diskIdentifier"],actualGiB=actual,registeredGiB=registered,pending=journal!=null,fromGiB=journal==null?registered:journal["fromGiB"],targetGiB=journal==null?registered:journal["targetGiB"]};
                long target=Number(request,"targetGiB",16,256);MuDiskGrowthPolicy.Request(registered,target);
                if(journal!=null&&Convert.ToInt64(journal["targetGiB"])!=target)throw new InvalidOperationException("Resume the original disk target before requesting another size");
                if(action=="finish-disk-growth"){
                    if(journal==null||actual!=target)throw new InvalidOperationException("Pending grown disk required");object bytes,start;if(!request.TryGetValue("filesystemBytes",out bytes)||!(bytes is long)&&!(bytes is int)||!request.TryGetValue("partitionStartBytes",out start)||!(start is long)&&!(start is int))throw new ArgumentException("Filesystem capacity and partition offset required");MuDiskGrowthPolicy.Filesystem(target,Convert.ToInt64(bytes),Convert.ToInt64(start));
                    lock(Gate){record.Remove("diskGrowth");Save();}return new {completed=true,diskGiB=target,platformId=record["platformId"],diskIdentifier=facts["diskIdentifier"]};
                }
                if(journal==null&&target==registered)return new {grown=true,diskGiB=target,pending=false};
                if(journal==null){
                    long total;lock(Gate)total=Records.Values.Sum(value=>Convert.ToInt64(value["diskGiB"]));MuResourcePolicy.Quota(total-registered,target);
                    CheckDiskRequest(checked(MuResourceMetrics.DiskFootprint(target*MuResourcePolicy.GiB)-MuResourceMetrics.DiskFootprint(actual*MuResourcePolicy.GiB)),cancellation);
                    journal=new Dictionary<string,object>{{"fromGiB",registered},{"targetGiB",target},{"diskIdentifier",facts["diskIdentifier"]},{"fileIdentity",facts["fileIdentity"]}};
                    lock(Gate){record["diskGrowth"]=journal;record["diskGiB"]=target;Save();}
                }else CheckDiskRequest(checked(MuResourceMetrics.DiskFootprint(target*MuResourcePolicy.GiB)-MuResourceMetrics.DiskFootprint(actual*MuResourcePolicy.GiB)),cancellation);
                cancellation.ThrowIfCancellationRequested();CloseChannel(id);var parameters=Parameters(record);parameters["growthDiskIdentifier"]=journal["diskIdentifier"];
                var result=Json().Deserialize<Dictionary<string,object>>(Invoke("grow-disk",parameters,120000,cancellation));if(Convert.ToInt64(result["diskGiB"])!=target||Text(result,"diskIdentifier",36)!=Convert.ToString(journal["diskIdentifier"]))throw new IOException("Disk growth receipt changed");
                GrowthFacts(record,cancellation);
                return new {grown=true,diskGiB=target,pending=true};
            }
        }
    }
}
