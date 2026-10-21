using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Linq;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

// Source preview authority boundary. Requests contain typed VM operations, never
// executable text. Hyper-V inputs and disks live in an administrator-owned store.
// User-selected images/seeds are opened while impersonating the pipe caller.
public static partial class MuHyperVBroker {
    private const string HyperVScript = "__HYPERV_SCRIPT_BASE64__";
    private const string ChannelFile = "__CHANNEL_FILE__";
    private const string SourceDigest = "__BROKER_SOURCE_DIGEST__";
    private static readonly SecurityIdentifier SystemSid = new SecurityIdentifier("S-1-5-18");
    private static readonly SecurityIdentifier AdminSid = new SecurityIdentifier("S-1-5-32-544");
    private static readonly object Gate = new object();
    private static readonly object ImportGate = new object();
    private static readonly Dictionary<string, Dictionary<string, object>> Records = new Dictionary<string, Dictionary<string, object>>();
    private static readonly Dictionary<string, object> VmGates = new Dictionary<string, object>();
    private static readonly Dictionary<string, Process> Channels = new Dictionary<string, Process>();
    private static readonly Dictionary<string, int> ChannelPorts = new Dictionary<string, int>();
    private static readonly HashSet<string> StartedHere = new HashSet<string>();
    private static readonly List<NamedPipeServerStream> Pipes = new List<NamedPipeServerStream>();
    private static readonly List<IDisposable> Held = new List<IDisposable>();
    private static readonly ManualResetEvent RequestsIdle=new ManualResetEvent(true),ShutdownComplete=new ManualResetEvent(false);
    private static readonly CancellationTokenSource Closing = new CancellationTokenSource();
    private static int ActiveRequests;
    private static Process Owner;
    private static IntPtr OwnerHandle;
    private static WindowsIdentity OwnerIdentity;
    private static string OwnerSid, UserRoot, ScriptFile;
    private static MuProtectedLedger LedgerStore;
    // The OS releases this lock only after the entire process has exited.
    private static FileStream ProcessSessionLock;
    private static volatile bool Stopping;
    private static bool SetupOnly;
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
    [DllImport("advapi32.dll", SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool GetTokenInformation(IntPtr token,int kind,out int value,int length,out int returned);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll")] private static extern uint GetFileType(IntPtr file);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode,SetLastError=true)] private static extern uint GetFinalPathNameByHandle(IntPtr file,StringBuilder path,uint length,uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);

    private static JavaScriptSerializer Json() { return new JavaScriptSerializer{ MaxJsonLength=65536, RecursionLimit=16 }; }
    private static bool OwnerExited {get{return OwnerHandle==IntPtr.Zero||WaitForSingleObject(OwnerHandle,0)!=258;}}
    private static string ProcessSid(Process process) {
        // Pin only process query/synchronization rights and query the owner's
        // identity/elevation. Source files use the validated pipe caller's token;
        // another administrator need not duplicate the owner's primary token.
            OwnerHandle=OpenProcess(0x1000|0x100000,false,process.Id);if(OwnerHandle==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Bound owner process unavailable");Held.Add(new HandleOwner(OwnerHandle));
            IntPtr token;if(!OpenProcessToken(OwnerHandle,8,out token)){int error=Marshal.GetLastWin32Error();throw new System.ComponentModel.Win32Exception(error,"Bound owner identity unavailable (Win32 "+error+")");}
            try{int elevated,returned;if(!GetTokenInformation(token,20,out elevated,4,out returned))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Bound owner elevation unavailable");if(elevated!=0)throw new UnauthorizedAccessException("Application must run without administrator privileges");OwnerIdentity=new WindowsIdentity(token);return OwnerIdentity.User.Value;}finally{CloseHandle(token);}
    }
    private static DirectorySecurity PrivateAcl() {
        var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);acl.SetOwner(AdminSid);
        foreach(var sid in new[]{SystemSid,AdminSid})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        return acl;
    }
    private static void PrivateDirectory(string path,bool pin=true) {
        if(!Directory.Exists(path))Directory.CreateDirectory(path,PrivateAcl());
        if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)throw new UnauthorizedAccessException("Reparse directory rejected");
        var acl=Directory.GetAccessControl(path);var owner=(SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier));
        if(!owner.Equals(AdminSid)&&!owner.Equals(SystemSid))throw new UnauthorizedAccessException("Storage owner rejected");
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&!rule.IdentityReference.Equals(AdminSid)&&!rule.IdentityReference.Equals(SystemSid))throw new UnauthorizedAccessException("Storage ACL rejected");
        var handle=CreateFile(path,0x80000000,3,IntPtr.Zero,3,0x02000000|0x00200000,IntPtr.Zero);
        if(handle==new IntPtr(-1))throw new IOException("Cannot lock protected directory");if(pin){lock(Gate)Held.Add(new HandleOwner(handle));}else CloseHandle(handle);
    }
    private static void TrustedExecutable(string common){
        string file=System.Reflection.Assembly.GetExecutingAssembly().Location,expected=Path.Combine(common,"bin");
        if(!string.Equals(Path.GetDirectoryName(file),expected,StringComparison.OrdinalIgnoreCase)||(File.GetAttributes(expected)&FileAttributes.ReparsePoint)!=0||(File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)throw new UnauthorizedAccessException("Protected installation required");
        string channel=Path.Combine(expected,ChannelFile);if((File.GetAttributes(channel)&FileAttributes.ReparsePoint)!=0||Path.GetFileName(channel)!="hv-channel-"+HashFile(channel).Substring(0,16)+".exe")throw new UnauthorizedAccessException("Channel installation rejected");
        foreach(string entry in new[]{expected,file,channel}){
            FileSystemSecurity acl=Directory.Exists(entry)?(FileSystemSecurity)Directory.GetAccessControl(entry):File.GetAccessControl(entry);var owner=(SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier));if(!owner.Equals(AdminSid)&&!owner.Equals(SystemSid))throw new UnauthorizedAccessException("Installation owner rejected");
            var writable=FileSystemRights.Write|FileSystemRights.Delete|FileSystemRights.DeleteSubdirectoriesAndFiles|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership;
            foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&!rule.IdentityReference.Equals(AdminSid)&&!rule.IdentityReference.Equals(SystemSid)&&(rule.FileSystemRights&writable)!=0)throw new UnauthorizedAccessException("Installation is user-writable");
        }
        if(Path.GetFileName(file)!="hv-broker-"+HashFile(file).Substring(0,16)+".exe")throw new UnauthorizedAccessException("Installation digest rejected");
    }
    private sealed class HandleOwner:IDisposable {private IntPtr value;public HandleOwner(IntPtr handle){value=handle;}public void Dispose(){var old=Interlocked.Exchange(ref value,IntPtr.Zero);if(old!=IntPtr.Zero)CloseHandle(old);}}
    private static void ValidateKeys(Dictionary<string,object> value,params string[] keys) { if(value.Keys.Any(key=>!keys.Contains(key)))throw new ArgumentException("Unexpected request field"); }
    private static string Text(Dictionary<string,object> value,string key,int max) {object item;if(!value.TryGetValue(key,out item)||!(item is string)||((string)item).Length==0||((string)item).Length>max||((string)item).IndexOf('\0')>=0)throw new ArgumentException("Invalid string");return (string)item;}
    private static int Number(Dictionary<string,object> value,string key,int min,int max) {object item;if(!value.TryGetValue(key,out item)||!(item is int)&&!(item is long))throw new ArgumentException("Invalid integer");long n=Convert.ToInt64(item);if(n<min||n>max)throw new ArgumentException("Resource limit");return (int)n;}
    private static string Id(Dictionary<string,object> value){string id=Text(value,"id",36);Guid parsed;if(!Guid.TryParseExact(id,"D",out parsed)||parsed==Guid.Empty||parsed.ToString("D")!=id)throw new ArgumentException("Canonical VM ID required");return id;}
    private static string Digest(Dictionary<string,object> value,string key){string hash=Text(value,key,64);if(hash.Length!=64||hash.Any(c=>!(c>='0'&&c<='9'||c>='a'&&c<='f')))throw new ArgumentException("Digest required");return hash;}
    private static string Hash(Stream input){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(input)).Replace("-","").ToLowerInvariant();}
    private static string HashFile(string file){using(var input=File.OpenRead(file))return Hash(input);}
    private static void ValidateLedgerFile(string file){
        var attributes=File.GetAttributes(file);if((attributes&(FileAttributes.ReparsePoint|FileAttributes.Directory))!=0)throw new UnauthorizedAccessException("Registry must be a regular protected file");
        var acl=File.GetAccessControl(file);var owner=(SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier));if(!owner.Equals(AdminSid)&&!owner.Equals(SystemSid))throw new UnauthorizedAccessException("Registry owner changed");
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&!rule.IdentityReference.Equals(AdminSid)&&!rule.IdentityReference.Equals(SystemSid))throw new UnauthorizedAccessException("Registry permissions changed");
    }
    private static void Save() {lock(Gate)LedgerStore.Save(Records);}
    private static Dictionary<string,object> Owned(string id){lock(Gate){Dictionary<string,object> record;if(!Records.TryGetValue(id,out record)||Convert.ToString(record["ownerSid"])!=OwnerSid)throw new UnauthorizedAccessException("VM is not registered to this user");return record;}}
    private static Dictionary<string,object>[] RecordSnapshot(){lock(Gate)return Records.Values.Select(record=>new Dictionary<string,object>(record)).ToArray();}
    private static Dictionary<string,object>[] ShutdownSnapshot(){lock(Gate)return Records.Values.OrderByDescending(record=>StartedHere.Contains(Convert.ToString(record["id"]))||Channels.ContainsKey(Convert.ToString(record["id"]))).Select(record=>new Dictionary<string,object>(record)).ToArray();}
    private static object VmGate(string id){lock(Gate){object value;if(!VmGates.TryGetValue(id,out value)){value=new object();VmGates[id]=value;}return value;}}
    private static Dictionary<string,object> Parameters(Dictionary<string,object> record) {
        string id=Convert.ToString(record["id"]),name="mu-win-"+id.Replace("-","");byte[] hash;using(var sha=SHA256.Create())hash=sha.ComputeHash(Encoding.UTF8.GetBytes(id));
        int slot=((hash[0]<<8)|hash[1])%16384,third=slot>>6,fourth=(slot&63)*4;string dir=Path.Combine(UserRoot,"vms",id);
        var result=new Dictionary<string,object>{{"name",name},{"directory",dir},{"disk",Path.Combine(dir,"disk.vhdx")},{"seed",Path.Combine(dir,"seed.iso")},{"image",record["image"]},{"cpus",record["cpus"]},{"memoryGiB",record["memoryGiB"]},{"diskGiB",record["diskGiB"]},{"brokerResourceLimit",true},{"host","172.29."+third+"."+(fourth+1)},{"guest","172.29."+third+"."+(fourth+2)},{"mac","00155D"+BitConverter.ToString(hash,2,3).Replace("-","")}};
        if(record.ContainsKey("platformId"))result["expectedPlatformId"]=record["platformId"];
        result["allowPartialAllocation"]=!record.ContainsKey("everReady")&&Convert.ToString(record["stage"])!="ready";
        if(Convert.ToString(record["imageSha256"])=="c74a7d3b3476ffb2715bfcaf9c216e9dd1d6c7e01bc6d0380b1744518dfae15c")result["imagePatch"]=new Dictionary<string,object>{{"offset",2495315968L},{"before",Convert.ToBase64String(Encoding.ASCII.GetBytes("# to update this file, run dpkg-reconfigure cloud-init\ndatasource_list: [ Azure ]\n"))},{"after",Convert.ToBase64String(Encoding.ASCII.GetBytes("# to update this file, run dpkg-reconfigure cloud-init\ndatasource_list: [NoCloud]\n"))}};
        return result;
    }
    private static string Invoke(string action,Dictionary<string,object> parameters,int timeout,CancellationToken cancellation) {
        if(action!="stop"&&action!="recover-allocation"&&action!="delete-allocation"){cancellation.ThrowIfCancellationRequested();if(Stopping)throw new OperationCanceledException("Broker is closing");}
        string system=Environment.GetFolderPath(Environment.SpecialFolder.Windows),script="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);try { & ([ScriptBlock]::Create([IO.File]::ReadAllText('"+ScriptFile.Replace("'","''")+"'))) -Action '"+action+"' } catch { [Console]::Error.WriteLine($_.Exception.ToString());[Console]::Error.WriteLine($_.ScriptStackTrace);exit 1 }";
        var info=new ProcessStartInfo(Path.Combine(system,"System32/WindowsPowerShell/v1.0/powershell.exe"),"-NoLogo -NoProfile -NonInteractive -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(script))){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=UserRoot,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8};
        info.EnvironmentVariables.Clear();info.EnvironmentVariables["SystemRoot"]=system;info.EnvironmentVariables["WINDIR"]=system;info.EnvironmentVariables["SystemDrive"]=Path.GetPathRoot(system).TrimEnd('\\');info.EnvironmentVariables["COMPUTERNAME"]=Environment.MachineName;info.EnvironmentVariables["ProgramData"]=Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);info.EnvironmentVariables["ProgramFiles"]=Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);info.EnvironmentVariables["ComSpec"]=Path.Combine(system,"System32/cmd.exe");info.EnvironmentVariables["USERPROFILE"]=UserRoot;info.EnvironmentVariables["PATH"]=Path.Combine(system,"System32");info.EnvironmentVariables["PSModulePath"]=Path.Combine(system,"System32/WindowsPowerShell/v1.0/Modules");info.EnvironmentVariables["TEMP"]=UserRoot;info.EnvironmentVariables["TMP"]=UserRoot;
        using(var process=Process.Start(info)) {
            var output=new StringBuilder();var errors=new StringBuilder();process.OutputDataReceived+=(s,e)=>{if(e.Data!=null)lock(output){if(output.Length<131072)output.AppendLine(e.Data);}};process.ErrorDataReceived+=(s,e)=>{if(e.Data!=null)lock(errors){if(errors.Length<16384)errors.AppendLine(e.Data);}};process.BeginOutputReadLine();process.BeginErrorReadLine();
            process.StandardInput.Write(parameters==null?"":Json().Serialize(parameters));process.StandardInput.Close();var clock=Stopwatch.StartNew();
            while(!process.WaitForExit(100)){if(clock.ElapsedMilliseconds>timeout||cancellation.IsCancellationRequested){try{process.Kill();}catch{}throw new OperationCanceledException("Hyper-V operation did not complete");}}
            process.WaitForExit();if(process.ExitCode!=0)throw new IOException("Hyper-V "+action+" failed: "+errors.ToString());return output.ToString();
        }
    }
    private static FileStream CallerFile(NamedPipeServerStream pipe,string source,long max) {
        if(source.Length>4096||source.Length<4||source[1]!=':'||source[2]!='\\'||source.Substring(2).Contains(":"))throw new ArgumentException("Local disk file required");
        FileStream input=null;pipe.RunAsClient(()=>input=new FileStream(source,FileMode.Open,FileAccess.Read,FileShare.Read,1048576,FileOptions.SequentialScan));
        try{if(GetFileType(input.SafeFileHandle.DangerousGetHandle())!=1||input.Length<1||input.Length>max)throw new ArgumentException("Input file exceeds bounds");var path=new StringBuilder(32768);if(GetFinalPathNameByHandle(input.SafeFileHandle.DangerousGetHandle(),path,(uint)path.Capacity,0)==0||path.ToString().StartsWith("\\\\?\\UNC\\",StringComparison.OrdinalIgnoreCase))throw new ArgumentException("Network input rejected");return input;}catch{input.Dispose();throw;}
    }
    private static void CopyCaller(NamedPipeServerStream pipe,string source,string destination,string digest,long max,CancellationToken cancellation,long reserve=0) {
        using(var input=CallerFile(pipe,source,max))using(var output=new FileStream(destination,FileMode.CreateNew,FileAccess.Write,FileShare.None,1048576))using(var sha=SHA256.Create()){
            if(max>8L*1024*1024)CheckDiskRequest(checked(input.Length+reserve+(reserve>0&&digest==CanonicalBuilderDigest?input.Length:0)),cancellation);
            else MuResourcePolicy.DiskRequest(MuResourceMetrics.Read(UserRoot).freeDisk,0,input.Length);
            var buffer=new byte[1048576];int count;while((count=input.Read(buffer,0,buffer.Length))>0){cancellation.ThrowIfCancellationRequested();sha.TransformBlock(buffer,0,count,null,0);output.Write(buffer,0,count);}sha.TransformFinalBlock(new byte[0],0,0);output.Flush(true);if(BitConverter.ToString(sha.Hash).Replace("-","").ToLowerInvariant()!=digest)throw new ArgumentException("Input checksum mismatch");
        }
    }
    private static void CloseChannel(string id){lock(Gate){Process child;ChannelPorts.Remove(id);if(!Channels.TryGetValue(id,out child))return;Channels.Remove(id);try{if(!child.HasExited)child.Kill();}catch{}child.Dispose();}}
    private static bool EverReady(Dictionary<string,object> record){return record.ContainsKey("everReady")&&Convert.ToBoolean(record["everReady"])||Convert.ToString(record["stage"])=="ready";}
    private static Dictionary<string,object> RecoverAllocation(Dictionary<string,object> record){
        var value=Json().Deserialize<Dictionary<string,object>>(Invoke("recover-allocation",Parameters(record),30000,CancellationToken.None));
        if(Convert.ToString(value["state"])!="Off")throw new IOException("Allocation shutdown was not confirmed");
        lock(Gate){
            if(EverReady(record))record["everReady"]=true;
            if(Convert.ToBoolean(value["present"])){
                string platform=Text(value,"platformId",36);Guid parsed;if(!Guid.TryParseExact(platform,"D",out parsed)||parsed==Guid.Empty)throw new IOException("Allocation identity missing");record["platformId"]=platform;
                if(Convert.ToBoolean(value["ready"])){record["stage"]="ready";record["everReady"]=true;}else record["stage"]="create-failed";
            }else if(record.ContainsKey("platformId"))record["stage"]="vm-missing";
            Save();
        }
        return value;
    }
    private static void CheckRemovalTree(string directory){
        if((File.GetAttributes(directory)&FileAttributes.ReparsePoint)!=0)throw new UnauthorizedAccessException("Reparse storage cannot be removed");
        foreach(string entry in Directory.EnumerateFileSystemEntries(directory)){
            var attributes=File.GetAttributes(entry);if((attributes&FileAttributes.ReparsePoint)!=0)throw new UnauthorizedAccessException("Reparse storage cannot be removed");
            if((attributes&FileAttributes.Directory)!=0)CheckRemovalTree(entry);
        }
    }
    private static void RemoveAllocationFiles(Dictionary<string,object> record){
        string id=Convert.ToString(record["id"]),parent=Path.Combine(UserRoot,"vms"),directory=Path.GetFullPath(Path.Combine(parent,id));
        Guid parsed;if(!Guid.TryParseExact(id,"D",out parsed)||parsed.ToString("D")!=id||Path.GetDirectoryName(directory)!=parent)throw new UnauthorizedAccessException("Allocation removal boundary changed");
        // Parent directories remain pinned and deny user writes. No caller path
        // participates in this recursive deletion, and reparse entries fail closed.
        if(HasStorage(directory)){if(!Directory.Exists(directory))throw new IOException("Allocation directory was replaced by a file");CheckRemovalTree(directory);Directory.Delete(directory,true);}
        if(HasStorage(directory))throw new IOException("Allocation storage removal was not confirmed");
    }
    private static bool HasStorage(string directory){try{File.GetAttributes(directory);return true;}catch(FileNotFoundException){return false;}catch(DirectoryNotFoundException){return false;}}
    private static object Allocation(string id){
        lock(Gate){Dictionary<string,object> record;if(!Records.TryGetValue(id,out record))return new {registered=false};
            return new {registered=true,stage=record["stage"],everReady=EverReady(record),platformId=record.ContainsKey("platformId")?record["platformId"]:null,imageSha256=record["imageSha256"],cpus=record["cpus"],memoryGiB=record["memoryGiB"],diskGiB=record["diskGiB"]};}
    }
    private static object Channel(string id) {
        lock(VmGate(id)){
        var record=Owned(id);if(!record.ContainsKey("platformId"))throw new InvalidOperationException("VM is not ready");lock(Gate){Process existing;if(Channels.TryGetValue(id,out existing)&&!existing.HasExited)return new {port=ChannelPorts[id]};}CloseChannel(id);
        string executable=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,ChannelFile);var info=new ProcessStartInfo(executable,"--listen "+Convert.ToString(record["platformId"])+" "+Owner.Id){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=AppDomain.CurrentDomain.BaseDirectory};
        var process=Process.Start(info);process.StandardInput.BaseStream.WriteByte(46);process.StandardInput.BaseStream.Flush();process.ErrorDataReceived+=(s,e)=>{};process.BeginErrorReadLine();var reading=process.StandardOutput.ReadLineAsync();if(!reading.Wait(10000)){process.Kill();throw new IOException("Guest channel did not start");}var value=Json().Deserialize<Dictionary<string,object>>(reading.Result);int port=Number(value,"port",1,65535);lock(Gate){Channels[id]=process;ChannelPorts[id]=port;}StartChannelHeartbeat(id,process);return value;
        }
    }
    private static object Dispatch(NamedPipeServerStream pipe,Dictionary<string,object> request,CancellationToken cancellation) {
        string action=Text(request,"action",32);
        if(action=="hello"){ValidateKeys(request,"action");return new {version=1,ownerPid=Owner.Id,ownerSid=OwnerSid,elevated=true,protectedStorage=true,sourceDigest=SourceDigest};}
        if(RecoveryOnly&&action!="shutdown")return RecoveryAction(action,request,cancellation);
        if(action=="host-status"){ValidateKeys(request,"action");return HostStatus();}
        if(action=="power-status"){ValidateKeys(request,"action");return PowerStatus();}
        if(action=="resource-status"){ValidateKeys(request,"action");return ResourceStatus();}
        if(action=="prepare-host"){ValidateKeys(request,"action");return PrepareHost();}
        if(action=="doctor"&&SetupOnly){ValidateKeys(request,"action");return Json().Serialize(new {available=false,issues=new[]{"请完成 Windows 系统组件准备后重新打开软件"}});}
        if(action=="doctor"||action=="fingerprint"){ValidateKeys(request,"action");return Invoke(action,null,10000,cancellation);}
        if(action=="shutdown"){ValidateKeys(request,"action");return "";}
        if(action=="base-status"){ValidateKeys(request,"action","imageSha256");string digest=Digest(request,"imageSha256");lock(ImportGate){if(!File.Exists(Path.Combine(UserRoot,"bases",digest+".json")))return new {ready=false};ResolveSealedBase("mu-base:"+digest,digest);return BaseReceipt(digest);}}
        if(action=="cache-status"||action=="cache-prune"){
            if(action=="cache-prune")ValidateKeys(request,"action","keepDigest","plan");else ValidateKeys(request,"action","keepDigest");
            string keep=request.ContainsKey("keepDigest")&&request["keepDigest"]!=null?Digest(request,"keepDigest"):null;
            return CacheAction(action,keep,action=="cache-prune"?Digest(request,"plan"):null,cancellation);
        }
        if(SetupOnly)throw new UnauthorizedAccessException("This session only prepares Windows components; reopen the application for virtual machines");
        if(ResourceMutation(action)||action=="channel")CheckPower();if(ResourceIssue!=null&&(ResourceMutation(action)||action=="channel"))throw new MuStorageException("RESOURCE_FENCED","Host resource protection has closed this session; reopen the application");
        if((action=="disk"||action=="begin-base"||action=="create"||action=="start")&&HostServicingBusy())throw new InvalidOperationException("Windows component servicing is running");
        string id=Id(request);
        if(action=="seal-base"){ValidateKeys(request,"action","id");return SealBase(id,cancellation);}
        if(action=="discard-base-builder"){ValidateKeys(request,"action","id");lock(VmGate(id)){var builder=Owned(id);if(!builder.ContainsKey("baseBuilder")||!Convert.ToBoolean(builder["baseBuilder"]))throw new UnauthorizedAccessException("Only a marked base builder may be discarded by setup");return Dispatch(pipe,new Dictionary<string,object>{{"action","delete"},{"id",id}},cancellation);}}
        if(action=="absence"){
            ValidateKeys(request,"action","id","platformId");var record=new Dictionary<string,object>{{"id",id},{"image",""},{"imageSha256",""},{"cpus",1},{"memoryGiB",2},{"diskGiB",16},{"stage","unregistered"}};var parameters=Parameters(record);
            if(request.ContainsKey("platformId")){string platform=Text(request,"platformId",36);Guid parsed;if(!Guid.TryParseExact(platform,"D",out parsed)||parsed==Guid.Empty)throw new ArgumentException("VM identity required");parameters["expectedPlatformId"]=platform;}
            var state=Json().Deserialize<Dictionary<string,object>>(Invoke("allocation-absence",parameters,15000,cancellation));return new {absent=Convert.ToBoolean(state["absent"])&&!HasStorage(Convert.ToString(parameters["directory"]))};
        }
        if(action=="allocation"){ValidateKeys(request,"action","id");return Allocation(id);}
        if(action=="recover"||action=="prepare"||action=="delete"){
            if(action=="prepare")ValidateKeys(request,"action","id","image");else ValidateKeys(request,"action","id");lock(VmGate(id)){
                var record=Owned(id);CloseChannel(id);cancellation.ThrowIfCancellationRequested();var recovered=RecoverAllocation(record);
                if(action=="recover")return recovered;
                if(action=="prepare"&&Convert.ToBoolean(recovered["ready"]))return recovered;
                if(action=="prepare"&&EverReady(record))throw new InvalidOperationException("An existing guest cannot be rebuilt");
                lock(Gate){record["stage"]=action=="delete"?"deleting":"preparing";Save();}
                var removed=Json().Deserialize<Dictionary<string,object>>(Invoke("delete-allocation",Parameters(record),30000,CancellationToken.None));
                if(!Convert.ToBoolean(removed["vmAbsent"])||!Convert.ToBoolean(removed["switchAbsent"]))throw new IOException("Allocation removal was not confirmed");RemoveAllocationFiles(record);
                if(action=="delete"){
                    lock(Gate){Records.Remove(id);try{Save();}catch{Records.Add(id,record);throw;}}return new {deleted=true,vmAbsent=true,switchAbsent=true,storageAbsent=true};
                }
                lock(Gate){record.Remove("platformId");record["stage"]="allocated";Save();}PrivateDirectory(Convert.ToString(Parameters(record)["directory"]),false);
                lock(ImportGate)using(ImportReservation()){
                string image=Convert.ToString(record["image"]);if(record.ContainsKey("sealedSource")){string reference=Text(request,"image",4096);if(reference!=Convert.ToString(record["sealedSource"]))throw new ArgumentException("Sealed source changed");ResolveSealedBase(reference,Convert.ToString(record["imageSha256"]));}if(!File.Exists(image)){
                        long remaining=64L*1024*1024*1024-Directory.GetFiles(Path.Combine(UserRoot,"images")).Sum(file=>new FileInfo(file).Length);if(remaining<1)throw new IOException("Image cache quota reached");
                        string next=image+"."+Guid.NewGuid().ToString("N")+".next";try{CopyCaller(pipe,Text(request,"image",4096),next,Convert.ToString(record["imageSha256"]),remaining,cancellation,MuResourceMetrics.DiskFootprint(Convert.ToInt64(record["diskGiB"])*MuResourcePolicy.GiB));File.Move(next,image);}finally{if(File.Exists(next))File.Delete(next);}
                }
                if(HashFile(Convert.ToString(record["image"]))!=Convert.ToString(record["imageSha256"]))throw new UnauthorizedAccessException("Protected image changed");
                CheckNewDisk(record,cancellation);Invoke("disk",Parameters(record),1200000,cancellation);lock(Gate){record["stage"]="disk-ready";Save();}return new {state="Off",present=false,ready=false};
                }
            }
        }
        if(action=="disk"||action=="begin-base") {
            ValidateKeys(request,"action","id","image","imageSha256","cpus","memoryGiB","diskGiB");string source=Text(request,"image",4096),digest=Digest(request,"imageSha256");bool sealedSource=source.StartsWith("mu-base:",StringComparison.Ordinal);string extension=sealedSource?".vhdx":Path.GetExtension(source).ToLowerInvariant();if(extension!=".vhd"&&extension!=".vhdx")throw new ArgumentException("Disk image required");
            int cpu=Number(request,"cpus",1,Math.Min(16,Environment.ProcessorCount)),memory=Number(request,"memoryGiB",2,32),disk=Number(request,"diskGiB",16,256);
            if(action=="begin-base"&&(sealedSource||digest!=CanonicalBuilderDigest||cpu!=2||memory!=4||disk!=32))throw new ArgumentException("A new base requires the fixed official builder source and resources");
            lock(VmGate(id)) {
                string dir=Path.Combine(UserRoot,"vms",id),image=Path.Combine(UserRoot,"images",digest+extension);
                var record=new Dictionary<string,object>{{"id",id},{"ownerSid",OwnerSid},{"image",image},{"imageSha256",digest},{"cpus",cpu},{"memoryGiB",memory},{"diskGiB",disk},{"stage","allocated"}};
                if(action=="begin-base")record["baseBuilder"]=true;if(sealedSource)record["sealedSource"]=source;
                lock(ImportGate)using(ImportReservation()){
                if(sealedSource)ResolveSealedBase(source,digest);
                // Persist ownership before creating any allocation files. Failed
                // source reads and cancelled imports remain discoverable/removable.
                var memoryMetrics=MuResourceMetrics.Read(UserRoot);MuResourcePolicy.MemoryRequest(memoryMetrics.totalMemory,memoryMetrics.totalMemory,(long)memory*MuResourcePolicy.GiB);
                lock(Gate){if(Records.ContainsKey(id)||Records.Count>=32)throw new InvalidOperationException("VM allocation refused");if(HasStorage(dir))throw new UnauthorizedAccessException("Unregistered allocation storage is preserved; it cannot be replaced by a new VM");MuResourcePolicy.Quota(Records.Values.Sum(value=>Convert.ToInt64(value["diskGiB"])),disk);Records.Add(id,record);Save();}
                PrivateDirectory(dir,false);
                if(!File.Exists(image)){
                        long remaining=64L*1024*1024*1024-Directory.GetFiles(Path.Combine(UserRoot,"images")).Sum(file=>new FileInfo(file).Length);if(remaining<1)throw new IOException("Image cache quota reached");
                        string next=image+"."+Guid.NewGuid().ToString("N")+".next";try{CopyCaller(pipe,source,next,digest,remaining,cancellation,MuResourceMetrics.DiskFootprint((long)disk*MuResourcePolicy.GiB));File.Move(next,image);}finally{if(File.Exists(next))File.Delete(next);}
                }
                else if((File.GetAttributes(image)&FileAttributes.ReparsePoint)!=0||HashFile(image)!=digest)throw new UnauthorizedAccessException("Protected image changed");
                CheckNewDisk(record,cancellation);Invoke("disk",Parameters(record),1200000,cancellation);lock(Gate){record["stage"]="disk-ready";Save();}return "";
                }
            }
        }
        if(action=="register-channel"){ValidateKeys(request,"action","id");return Invoke(action,Parameters(Owned(id)),15000,cancellation);}
        if(action=="create") {
            ValidateKeys(request,"action","id","seed","seedSha256");var record=Owned(id);lock(VmGate(id)){
                if(Convert.ToString(record["stage"])!="disk-ready")throw new InvalidOperationException("Disk is not ready");var parameters=Parameters(record);string seed=Convert.ToString(parameters["seed"]);
                CopyCaller(pipe,Text(request,"seed",4096),seed,Digest(request,"seedSha256"),8*1024*1024,cancellation);
                using(var input=File.OpenRead(seed)){input.Position=32769;var signature=new byte[5];if(input.Read(signature,0,5)!=5||Encoding.ASCII.GetString(signature)!="CD001")throw new ArgumentException("ISO seed required");}
                lock(Gate){record["stage"]="creating";Save();}
                Invoke("register-channel",parameters,15000,cancellation);string result=Invoke("create",parameters,60000,cancellation);var created=Json().Deserialize<Dictionary<string,object>>(result);string platform=Text(created,"platformId",36);Guid parsed;if(!Guid.TryParseExact(platform,"D",out parsed)||parsed==Guid.Empty)throw new IOException("VM identity was not returned");lock(Gate){record["platformId"]=platform;record["stage"]="ready";record["everReady"]=true;Save();}return result;
            }
        }
        ValidateKeys(request,"action","id");var owned=Owned(id);
        if(action=="channel")return Channel(id);
        if(action=="close-channel"){CloseChannel(id);return "";}
        if(action=="start"||action=="stop"||action=="status"||action=="inspect"){
            lock(VmGate(id)){
                if((action=="status"||action=="stop")&&(!owned.ContainsKey("platformId")||Convert.ToString(owned["stage"])!="ready"))return Json().Serialize(RecoverAllocation(owned));
                if(!owned.ContainsKey("platformId")||action=="start"&&Convert.ToString(owned["stage"])!="ready")throw new InvalidOperationException("VM is not ready");
                if(action=="start"&&owned.ContainsKey("baseSealedDigest"))throw new InvalidOperationException("A sealed builder cannot be started again");
                if(action=="start")lock(Gate)StartedHere.Add(id);
                if(action=="stop")CloseChannel(id);try{
                    if(action=="start"){
                        var state=Json().Deserialize<Dictionary<string,object>>(Invoke("status",Parameters(owned),15000,cancellation));if(Convert.ToString(state["state"])=="Running")return Invoke("inspect",Parameters(owned),15000,cancellation);
                        string started=null;StartWithResources(owned,cancellation,()=>{started=Invoke("start",Parameters(owned),30000,cancellation);});return started;
                    }
                    return Invoke(action,Parameters(owned),30000,action=="stop"?CancellationToken.None:cancellation);
                }finally{if(action=="start"&&cancellation.IsCancellationRequested){CloseChannel(id);try{Invoke("stop",Parameters(owned),30000,CancellationToken.None);}catch{}}}
            }
        }
        throw new ArgumentException("Operation is not permitted");
    }
    private static void Serve(NamedPipeServerStream pipe) {
        var cancel=new CancellationTokenSource();var closingRegistration=Closing.Token.Register(()=>cancel.Cancel());var resourceRegistration=default(CancellationTokenRegistration);var powerRegistration=default(CancellationTokenRegistration);bool counted=false,resourceCounted=false;try {
            using(var timeout=new Timer(_=>{try{pipe.Dispose();}catch{}},null,10000,Timeout.Infinite)){
                var bytes=new List<byte>();int value;while((value=pipe.ReadByte())!=10){if(value<0||bytes.Count>=65536)throw new ArgumentException("Request exceeds bounds");bytes.Add((byte)value);}timeout.Change(Timeout.Infinite,Timeout.Infinite);
                uint pid;if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid)||pid!=Owner.Id||OwnerExited)throw new UnauthorizedAccessException("Application process rejected");
                string sid=null;pipe.RunAsClient(()=>sid=WindowsIdentity.GetCurrent(true).User.Value);if(sid!=OwnerSid)throw new UnauthorizedAccessException("Application user rejected");
                var watching=new Thread(()=>{try{pipe.ReadByte();}catch{}cancel.Cancel();});watching.IsBackground=true;watching.Start();
                lock(Gate){if(Stopping)throw new OperationCanceledException("Broker is closing");ActiveRequests++;RequestsIdle.Reset();counted=true;}
                var request=Json().Deserialize<Dictionary<string,object>>(new UTF8Encoding(false,true).GetString(bytes.ToArray()));if(ResourceMutation(Convert.ToString(request["action"]))){resourceRegistration=ResourceCancellation.Token.Register(()=>cancel.Cancel());powerRegistration=PowerCancellation.Token.Register(()=>cancel.Cancel());lock(Gate){ResourceMutations++;resourceCounted=true;}}
                object result=Dispatch(pipe,request,cancel.Token);byte[] response=Encoding.UTF8.GetBytes(Json().Serialize(new {ok=true,result=result})+"\n");pipe.Write(response,0,response.Length);pipe.Flush();if(Convert.ToString(request["action"])=="shutdown"){try{pipe.WaitForPipeDrain();}catch{}ThreadPool.QueueUserWorkItem(_=>Shutdown());}
            }
        }catch(Exception error){try{byte[] response=Encoding.UTF8.GetBytes(Json().Serialize(new {ok=false,code=error is MuStorageException?((MuStorageException)error).Code:error is UnauthorizedAccessException?"DENIED":error is ArgumentException?"INVALID_REQUEST":error is OperationCanceledException?"CANCELLED":"BROKER_FAILED",error=error is ArgumentException||error is UnauthorizedAccessException||error is MuStorageException?error.Message:"Privileged VM operation failed"})+"\n");pipe.Write(response,0,response.Length);pipe.Flush();}catch{}try{File.AppendAllText(Path.Combine(UserRoot,"broker-errors.log"),DateTime.UtcNow.ToString("o")+" "+error.ToString()+Environment.NewLine);}catch{}}
        finally{powerRegistration.Dispose();resourceRegistration.Dispose();closingRegistration.Dispose();cancel.Cancel();pipe.Dispose();lock(Gate){Pipes.Remove(pipe);if(resourceCounted)ResourceMutations--;if(counted){ActiveRequests--;if(ActiveRequests==0)RequestsIdle.Set();}}}
    }
    private static void Shutdown(){bool producer=false;NamedPipeServerStream[] closingPipes=null;lock(Gate){if(!Stopping){Stopping=true;producer=true;closingPipes=Pipes.ToArray();}}if(!producer){ShutdownComplete.WaitOne();return;}
        // A synchronous pipe read/dispose must not hold Gate or delay force-off.
        // Cancel privileged work directly, independently of client pipe EOF.
        Closing.Cancel();foreach(var pipe in closingPipes)ThreadPool.QueueUserWorkItem(_=>{try{pipe.Dispose();}catch{}});
        foreach(var record in ShutdownSnapshot())CloseChannel(Convert.ToString(record["id"]));
        try{RequestsIdle.WaitOne(30000);if(!SetupOnly&&!RecoveryOnly)foreach(var record in ShutdownSnapshot()){string id=Convert.ToString(record["id"]);CloseChannel(id);try{Invoke(record.ContainsKey("platformId")?"stop":"recover-allocation",Parameters(record),30000,CancellationToken.None);}catch{}}}finally{ShutdownComplete.Set();}
    }
    public static int Main(string[] args) {
        if(args.Length>0&&args[0]=="--host-once")return HostJobMain(args);
        if(args.Length==1&&args[0]=="--self-test"){try{ValidateKeys(new Dictionary<string,object>{{"action","start"},{"command","bad"}},"action","id");return 1;}catch(ArgumentException){}Console.WriteLine("Broker request boundary verified");return 0;}
        if((args.Length!=4&&args.Length!=5)||args[0]!="--owner"||args[2]!="--pipe"||(args.Length==5&&args[4]!="--setup-only"&&args[4]!="--detect-host"&&args[4]!="--recover-storage"))return 64;bool detectHost=args.Length==5&&args[4]=="--detect-host";RecoveryOnly=args.Length==5&&args[4]=="--recover-storage";SetupOnly=args.Length==5&&!RecoveryOnly;int ownerPid;if(!int.TryParse(args[1],out ownerPid)||ownerPid<=0||args[3].Length!=64||args[3].Any(c=>!(c>='0'&&c<='9'||c>='a'&&c<='f')))return 64;
        if(!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))return 77;
        try {
            Owner=Process.GetProcessById(ownerPid);OwnerSid=ProcessSid(Owner);var common=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"MuCodeSandbox-HyperVBroker-v1");TrustedExecutable(common);PrivateDirectory(common);var users=Path.Combine(common,"users");PrivateDirectory(users);UserRoot=Path.Combine(users,OwnerSid);PrivateDirectory(UserRoot);Directory.SetCurrentDirectory(UserRoot);PrivateDirectory(Path.Combine(UserRoot,"images"));PrivateDirectory(Path.Combine(UserRoot,"vms"));
            // The previous owner can exit before its agent finishes VM cleanup.
            // Wait for that sealed store to be released, never bypass its lock.
            var waiting=Stopwatch.StartNew();for(;;){if(OwnerExited)throw new OperationCanceledException("Application exited while waiting for storage");try{ProcessSessionLock=new FileStream(Path.Combine(UserRoot,"session.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);break;}catch(IOException){if(waiting.ElapsedMilliseconds>90000)throw;Thread.Sleep(100);}}
            LedgerStore=new MuProtectedLedger(UserRoot,OwnerSid,ValidateLedgerFile);foreach(var pair in (RecoveryOnly?LedgerStore.InspectRecovery():LedgerStore.Load()))Records.Add(pair.Key,pair.Value);if(RecoveryOnly)RecoveryLedgerFingerprint=LedgerStore.RecoveryFingerprint();
            byte[] scriptBytes=Convert.FromBase64String(HyperVScript);string scriptHash;using(var sha=SHA256.Create())scriptHash=BitConverter.ToString(sha.ComputeHash(scriptBytes)).Replace("-","").ToLowerInvariant();ScriptFile=Path.Combine(UserRoot,"hyperv-"+scriptHash+".ps1");if(File.Exists(ScriptFile)){if((File.GetAttributes(ScriptFile)&FileAttributes.ReparsePoint)!=0||HashFile(ScriptFile)!=scriptHash)throw new UnauthorizedAccessException("Protected script changed");}else{using(var scriptStream=new FileStream(ScriptFile,FileMode.CreateNew,FileAccess.Write,FileShare.None)){scriptStream.Write(scriptBytes,0,scriptBytes.Length);scriptStream.Flush(true);}}
            if(detectHost){var status=(Dictionary<string,object>)HostStatus();SetupOnly=!Convert.ToBoolean(status["ready"])||HostJobLive(HostJob());}
            StartPowerProtection();if(!SetupOnly&&!RecoveryOnly)foreach(var entry in RecordSnapshot())try{lock(VmGate(Convert.ToString(entry["id"])))RecoverAllocation(Owned(Convert.ToString(entry["id"])));}catch{throw new IOException("Previous VM shutdown was not confirmed");}
            var watcher=new Thread(()=>{WaitForSingleObject(OwnerHandle,0xffffffff);Shutdown();});watcher.IsBackground=true;watcher.Start();
            if(!RecoveryOnly)StartResourceGuardian();
            var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(OwnerSid),PipeAccessRights.ReadWrite,AccessControlType.Allow));security.AddAccessRule(new PipeAccessRule(SystemSid,PipeAccessRights.FullControl,AccessControlType.Allow));security.AddAccessRule(new PipeAccessRule(AdminSid,PipeAccessRights.FullControl,AccessControlType.Allow));
            while(!Stopping){NamedPipeServerStream pipe=null;try{pipe=new NamedPipeServerStream("MuCodeSandbox-Broker-"+args[3],PipeDirection.InOut,16,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,65536,65536,security);lock(Gate)Pipes.Add(pipe);pipe.WaitForConnection();ThreadPool.QueueUserWorkItem(_=>Serve(pipe));}catch{if(pipe!=null){pipe.Dispose();lock(Gate)Pipes.Remove(pipe);}if(!Stopping)Thread.Sleep(100);}}
            return 0;
        }catch(Exception error){Console.Error.WriteLine("Windows broker could not start: "+error.ToString());return 1;}
        finally{Shutdown();for(int i=Held.Count-1;i>=0;i--)Held[i].Dispose();if(OwnerIdentity!=null)OwnerIdentity.Dispose();GC.KeepAlive(ProcessSessionLock);}
    }
}
