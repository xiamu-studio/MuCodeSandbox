// Compiled with HyperVBroker.cs imports. All paths are derived from the pinned
// per-user store; IPC callers can retain a digest, never choose a deletion path.
public sealed class MuStorageException:IOException {
    public readonly string Code;
    public MuStorageException(string code,string message):base(message){Code=code;}
}
public sealed class MuCacheView {
    public long imageBytes,imageAllocatedBytes,temporaryBytes,catalogueBytes,reclaimableBytes,retainedBytes;
    public int imageCount,reclaimableFiles,unrecognizedEntries;
    public string plan;
}
public sealed class MuImageCache {
    private readonly string root,sid;
    private readonly Action<string> validate;
    private sealed class Entry {public string Path,Name,Digest,Identity;public long Bytes,AllocatedBytes;public int Kind;}
    private sealed class Plan {public MuCacheView View;public List<Entry> Delete;}
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(IntPtr file,[Out]byte[] info);
    [StructLayout(LayoutKind.Sequential)] private struct FileStandardInformation {public long AllocationSize,EndOfFile;public uint NumberOfLinks;[MarshalAs(UnmanagedType.U1)] public bool DeletePending;[MarshalAs(UnmanagedType.U1)] public bool Directory;}
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandleEx(IntPtr file,int informationClass,out FileStandardInformation info,int size);
    public MuImageCache(string directory,string ownerSid,Action<string> validator){root=Path.GetFullPath(directory);sid=ownerSid;if(validator==null)throw new ArgumentNullException("validator");validate=validator;}
    private static bool Match(string value,string expression){return System.Text.RegularExpressions.Regex.IsMatch(value,expression);}
    private static bool Digest(string value){return value!=null&&Match(value,"^[a-f0-9]{64}$");}
    private Entry ReadEntry(string path,int kind,string digest){
        if((File.GetAttributes(path)&(FileAttributes.ReparsePoint|FileAttributes.Directory))!=0)throw new MuStorageException("CACHE_INTEGRITY","Cache entries must be regular protected files");validate(path);
        using(var input=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){
            byte[] info=new byte[52];if(!GetFileInformationByHandle(input.SafeFileHandle.DangerousGetHandle(),info))throw new IOException("Cache identity unavailable");
            if(BitConverter.ToUInt32(info,40)!=1)throw new MuStorageException("CACHE_INTEGRITY","Cache hard links are not allowed");
            FileStandardInformation allocation;if(!GetFileInformationByHandleEx(input.SafeFileHandle.DangerousGetHandle(),1,out allocation,Marshal.SizeOf(typeof(FileStandardInformation)))||allocation.AllocationSize<0||allocation.EndOfFile!=input.Length||allocation.NumberOfLinks!=1||allocation.DeletePending||allocation.Directory)throw new IOException("Cache allocation metric unavailable or file changed");
            string identity=BitConverter.ToUInt32(info,28)+":"+BitConverter.ToUInt32(info,44)+":"+BitConverter.ToUInt32(info,48)+":"+BitConverter.ToUInt64(info,20)+":"+input.Length;
            return new Entry{Path=path,Name=Path.GetFileName(path),Digest=digest,Bytes=input.Length,AllocatedBytes=allocation.AllocationSize,Kind=kind,Identity=identity};
        }
    }
    private void ValidateCatalogue(Entry entry){
        if(entry.Bytes>4096)throw new MuStorageException("CACHE_INTEGRITY","Base catalogue exceeds its fixed limit");
        var value=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(entry.Path));
        if(value==null||!value.ContainsKey("ownerSid")||Convert.ToString(value["ownerSid"])!=sid||!value.ContainsKey("imageSha256")||Convert.ToString(value["imageSha256"])!=entry.Digest||!value.ContainsKey("sourceSha256")||Convert.ToString(value["sourceSha256"])!="c74a7d3b3476ffb2715bfcaf9c216e9dd1d6c7e01bc6d0380b1744518dfae15c"||!value.ContainsKey("recipe")||Convert.ToString(value["recipe"])!="windows-amd64-desktop-v1")throw new MuStorageException("CACHE_INTEGRITY","Base catalogue ownership or recipe changed");
    }
    private Plan Build(IEnumerable<string> references,string currentBase,IEnumerable<string> external){
        if(currentBase!=null&&!Digest(currentBase))throw new ArgumentException("Current base digest required");
        var retained=new HashSet<string>(references,StringComparer.Ordinal);if(retained.Any(value=>!Digest(value)))throw new ArgumentException("Registered image digest changed");if(currentBase!=null)retained.Add(currentBase);
        var blocked=new HashSet<string>(external,StringComparer.OrdinalIgnoreCase);if(blocked.Any(name=>Path.GetFileName(name)!=name))throw new ArgumentException("Cache dependency name required");
        foreach(string name in blocked)if(Match(name,"^[a-f0-9]{64}\\.vhdx?$"))retained.Add(name.Substring(0,64));
        var entries=new List<Entry>();var view=new MuCacheView();
        foreach(string directory in new[]{Path.Combine(root,"images"),Path.Combine(root,"bases")}){
            if(!Directory.Exists(directory))continue;if((File.GetAttributes(directory)&FileAttributes.ReparsePoint)!=0)throw new MuStorageException("CACHE_INTEGRITY","Cache directory reparse point rejected");
            foreach(string path in Directory.EnumerateFileSystemEntries(directory).OrderBy(value=>value,StringComparer.Ordinal)){
                string name=Path.GetFileName(path);bool image=directory.EndsWith(Path.DirectorySeparatorChar+"images",StringComparison.OrdinalIgnoreCase);
                Entry entry=null;
                if(image&&Match(name,"^[a-f0-9]{64}\\.vhdx?$")){entry=ReadEntry(path,1,name.Substring(0,64));view.imageCount++;view.imageBytes=checked(view.imageBytes+entry.Bytes);view.imageAllocatedBytes=checked(view.imageAllocatedBytes+entry.AllocatedBytes);}
                else if(!image&&Match(name,"^[a-f0-9]{64}\\.json$")){entry=ReadEntry(path,0,name.Substring(0,64));ValidateCatalogue(entry);view.catalogueBytes=checked(view.catalogueBytes+entry.Bytes);if(currentBase==null)retained.Add(entry.Digest);}
                else if(image&&Match(name,"^(?:[a-f0-9]{64}\\.vhdx?\\.[a-f0-9]{32}|base-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.[a-f0-9]{32})\\.next$")||!image&&Match(name,"^[a-f0-9]{64}\\.json\\.[a-f0-9]{32}\\.next$")){entry=ReadEntry(path,2,null);view.temporaryBytes=checked(view.temporaryBytes+entry.Bytes);}
                else{view.unrecognizedEntries++;continue;}
                entries.Add(entry);
            }
        }
        var deletion=entries.Where(entry=>!blocked.Contains(entry.Name)&&(entry.Digest==null||!retained.Contains(entry.Digest))).OrderBy(entry=>entry.Kind).ThenBy(entry=>entry.Name,StringComparer.Ordinal).ToList();
        foreach(var entry in deletion)view.reclaimableBytes=checked(view.reclaimableBytes+entry.Bytes);view.reclaimableFiles=deletion.Count;
        view.retainedBytes=checked(view.imageBytes+view.temporaryBytes+view.catalogueBytes-view.reclaimableBytes);
        var identity=new StringBuilder(sid+"\n"+(currentBase??"all-sealed")+"\n");
        foreach(string digest in retained.OrderBy(value=>value,StringComparer.Ordinal))identity.Append(digest).Append('\n');
        foreach(string name in blocked.OrderBy(value=>value,StringComparer.Ordinal))identity.Append(name).Append('\n');
        foreach(var entry in entries)identity.Append(entry.Kind).Append(':').Append(entry.Name).Append(':').Append(entry.Identity).Append(':').Append(entry.Bytes).Append('\n');
        identity.Append("unknown:").Append(view.unrecognizedEntries);
        using(var sha=SHA256.Create())view.plan=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(identity.ToString()))).Replace("-","").ToLowerInvariant();
        return new Plan{View=view,Delete=deletion};
    }
    public MuCacheView Inspect(IEnumerable<string> references,string currentBase,IEnumerable<string> external){return Build(references,currentBase,external).View;}
    public object Prune(IEnumerable<string> references,string currentBase,IEnumerable<string> external,string expected,CancellationToken cancellation){
        var plan=Build(references,currentBase,external);
        if(plan.View.unrecognizedEntries!=0)throw new MuStorageException("CACHE_UNKNOWN_DATA","Unrecognized cache data is preserved");
        if(!Digest(expected)||plan.View.plan!=expected)throw new MuStorageException("CACHE_PLAN_CHANGED","Cache contents or references changed; inspect again");
        int files=0;long bytes=0;
        foreach(var entry in plan.Delete){
            cancellation.ThrowIfCancellationRequested();var actual=ReadEntry(entry.Path,entry.Kind,entry.Digest);if(actual.Identity!=entry.Identity||actual.Bytes!=entry.Bytes)throw new MuStorageException("CACHE_PLAN_CHANGED","Cache file identity changed");
            // Catalogue first: an interrupted cleanup can leave an unreferenced
            // image copy, never a ready catalogue whose image was just removed.
            File.Delete(entry.Path);files++;bytes=checked(bytes+entry.Bytes);
        }
        return new {deletedFiles=files,reclaimedBytes=bytes};
    }
}
public static partial class MuHyperVBroker {
    private static object CacheAction(string action,string currentBase,string expected,CancellationToken cancellation){
        if(!Monitor.TryEnter(ImportGate))throw new MuStorageException("STORAGE_BUSY","An image operation is still running");
        try{
            string common=Directory.GetParent(Directory.GetParent(UserRoot).FullName).FullName;
            FileStream reservation;try{reservation=new FileStream(Path.Combine(common,"import.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);}catch(IOException){throw new MuStorageException("STORAGE_BUSY","Another image operation is still running");}
            using(reservation){
                PrivateDirectory(Path.Combine(UserRoot,"bases"),false);
                var references=new HashSet<string>();var registered=new HashSet<string>();int allocatedGiB=0;
                lock(Gate)foreach(var record in Records.Values){registered.Add(Convert.ToString(record["id"]));references.Add(Convert.ToString(record["imageSha256"]));if(record.ContainsKey("baseSealedDigest"))references.Add(Convert.ToString(record["baseSealedDigest"]));allocatedGiB=checked(allocatedGiB+Convert.ToInt32(record["diskGiB"]));}
                int unregistered=Directory.EnumerateFileSystemEntries(Path.Combine(UserRoot,"vms")).Count(path=>!registered.Contains(Path.GetFileName(path)));
                string reason=SetupOnly||HostServicingBusy()?"host-unavailable":unregistered>0?"unregistered-storage":null;string[] dependencies=new string[0];
                if(reason==null)try{
                    var value=Json().Deserialize<Dictionary<string,object>>(Invoke("cache-dependencies",new Dictionary<string,object>{{"cacheRoot",UserRoot}},30000,cancellation));
                    dependencies=((System.Collections.IEnumerable)value["referenced"]).Cast<object>().Select(item=>Convert.ToString(item)).ToArray();
                }catch(OperationCanceledException){throw;}catch{reason="dependencies-unavailable";}
                var cache=new MuImageCache(UserRoot,OwnerSid,ValidateLedgerFile);var view=cache.Inspect(references,currentBase,dependencies);if(reason==null&&view.unrecognizedEntries>0)reason="unrecognized-cache-data";
                if(action=="cache-prune"){
                    if(reason!=null)throw new MuStorageException("CACHE_NOT_READY","Cache cleanup is disabled: "+reason);
                    return cache.Prune(references,currentBase,dependencies,expected,cancellation);
                }
                return new {imageBytes=view.imageBytes,imageAllocatedBytes=view.imageAllocatedBytes,temporaryBytes=view.temporaryBytes,catalogueBytes=view.catalogueBytes,reclaimableBytes=reason==null?view.reclaimableBytes:0,retainedBytes=reason==null?view.retainedBytes:view.imageBytes+view.temporaryBytes+view.catalogueBytes,imageCount=view.imageCount,reclaimableFiles=reason==null?view.reclaimableFiles:0,unrecognizedEntries=view.unrecognizedEntries,quotaBytes=64L*1024*1024*1024,freeBytes=MuResourceMetrics.Read(UserRoot).freeDisk,allocatedDiskGiB=allocatedGiB,unregisteredStorage=unregistered,plan=view.plan,canPrune=reason==null&&view.reclaimableFiles>0,reason=reason};
            }
        }finally{Monitor.Exit(ImportGate);}
    }
}
