// Only non-recovery dependencies needed to compile the exact production
// Dispatch method. Recovery-mode tests require every one to stay unreachable.
public static partial class MuHyperVBroker {
 static readonly HashSet<string> StartedHere=new HashSet<string>();static bool SetupOnly=false;static string ResourceIssue=null,SourceDigest;static int UnreachableDispatchCalls;
 static Exception DispatchBackend(){UnreachableDispatchCalls++;return new InvalidOperationException("Non-recovery dispatch backend entered");}
 static bool Quiescing=false;
 static object ShutdownStatus(Dictionary<string,object> request){throw DispatchBackend();}static void QuiesceAdmission(string action){throw DispatchBackend();}
 static object SnapshotStagingAction(string action,Dictionary<string,object> request,CancellationToken cancellation){throw DispatchBackend();}
 static object SnapshotExportAction(string action,Dictionary<string,object> request,CancellationToken cancellation){throw DispatchBackend();}static void SnapshotExportAdmission(string id,string action){throw DispatchBackend();}
 static object HostStatus(){throw DispatchBackend();}static object PowerStatus(){throw DispatchBackend();}static object ResourceStatus(){throw DispatchBackend();}static object PrepareHost(){throw DispatchBackend();}
 static IEnumerable<Dictionary<string,object>> RecordSnapshot(){throw DispatchBackend();}static bool SnapshotIsPending(Dictionary<string,object> r){throw DispatchBackend();}
 static void ResolveSealedBase(string source,string digest){throw DispatchBackend();}static object BaseReceipt(string digest){throw DispatchBackend();}static object CacheAction(string a,string b,string c,CancellationToken t){throw DispatchBackend();}
 static bool HostServicingBusy(){throw DispatchBackend();}static void CheckBackupBusy(string id,string action){throw DispatchBackend();}static void RestorePending(string id,string action){throw DispatchBackend();}static void SnapshotPending(string id,string action){throw DispatchBackend();}
 static object SnapshotAction(string a,Dictionary<string,object> r,CancellationToken t){throw DispatchBackend();}static object BackupImport(NamedPipeServerStream p,Dictionary<string,object> r,CancellationToken t){throw DispatchBackend();}static object BackupReadAction(string a,Dictionary<string,object> r,CancellationToken t){throw DispatchBackend();}
 static object SnapshotLiveDeletion(Dictionary<string,object> r,CancellationToken t){throw DispatchBackend();}static void SnapshotLiveAdmission(string id,string a,Dictionary<string,object> r){throw DispatchBackend();}
 static object SealBase(string id,CancellationToken t){throw DispatchBackend();}static Dictionary<string,object> Owned(string id){throw DispatchBackend();}static object Allocation(string id){throw DispatchBackend();}static object DiskGrowthAction(string a,Dictionary<string,object> r,CancellationToken t){throw DispatchBackend();}
 static void CloseChannel(string id){throw DispatchBackend();}static Dictionary<string,object> RecoverAllocation(Dictionary<string,object> r){throw DispatchBackend();}static bool EverReady(Dictionary<string,object> r){throw DispatchBackend();}static void RemoveAllocationFiles(Dictionary<string,object> r){throw DispatchBackend();}
 static void Save(){throw DispatchBackend();}static void PrivateDirectory(string d,bool pin=true){throw DispatchBackend();}static void CopyCaller(NamedPipeServerStream p,string s,string d,string h,long max,CancellationToken t,long reserve=0){throw DispatchBackend();}static string HashFile(string p){throw DispatchBackend();}static void CheckNewDisk(Dictionary<string,object> r,CancellationToken t){throw DispatchBackend();}
 static object Channel(string id){throw DispatchBackend();}static Dictionary<string,object> GrowthJournal(Dictionary<string,object> r){throw DispatchBackend();}static void StartWithResources(Dictionary<string,object> r,CancellationToken t,Action start){throw DispatchBackend();}
}
public sealed class MuResourceMetrics {
 public long totalMemory=0;public static MuResourceMetrics Read(string root){throw new InvalidOperationException("Host metrics entered from recovery dispatch");}public static long DiskFootprint(long bytes){throw new InvalidOperationException("Disk reservation entered from recovery dispatch");}
}
