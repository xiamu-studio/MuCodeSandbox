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
public static class MuHyperVBroker {
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
    private static readonly List<NamedPipeServerStream> Pipes = new List<NamedPipeServerStream>();
    private static readonly List<IDisposable> Held = new List<IDisposable>();
    private static readonly ManualResetEvent RequestsIdle=new ManualResetEvent(true),ShutdownComplete=new ManualResetEvent(false);
    private static int ActiveRequests;
    private static Process Owner;
    private static WindowsIdentity OwnerIdentity;
    private static string OwnerSid, UserRoot, Ledger, ScriptFile;
    private static volatile bool Stopping;
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
    [DllImport("advapi32.dll", SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] private static extern bool DuplicateToken(IntPtr token,int level,out IntPtr duplicate);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern uint GetFileType(IntPtr file);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode,SetLastError=true)] private static extern uint GetFinalPathNameByHandle(IntPtr file,StringBuilder path,uint length,uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);

    private static JavaScriptSerializer Json() { return new JavaScriptSerializer{ MaxJsonLength=65536, RecursionLimit=16 }; }
    private static string ProcessSid(Process process) {
        IntPtr token; if(!OpenProcessToken(process.Handle,10,out token))throw new UnauthorizedAccessException("Owner identity unavailable");
        try {IntPtr duplicate;if(!DuplicateToken(token,2,out duplicate))throw new UnauthorizedAccessException("Owner token unavailable");try{OwnerIdentity=new WindowsIdentity(duplicate);}finally{CloseHandle(duplicate);}if(new WindowsPrincipal(OwnerIdentity).IsInRole(WindowsBuiltInRole.Administrator))throw new UnauthorizedAccessException("Application must run without administrator privileges");return OwnerIdentity.User.Value;} finally { CloseHandle(token); }
    }
    private static DirectorySecurity PrivateAcl() {
        var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);acl.SetOwner(AdminSid);
        foreach(var sid in new[]{SystemSid,AdminSid})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        return acl;
    }
    private static void PrivateDirectory(string path) {
        if(!Directory.Exists(path))Directory.CreateDirectory(path,PrivateAcl());
        if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)throw new UnauthorizedAccessException("Reparse directory rejected");
        var acl=Directory.GetAccessControl(path);var owner=(SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier));
        if(!owner.Equals(AdminSid)&&!owner.Equals(SystemSid))throw new UnauthorizedAccessException("Storage owner rejected");
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&!rule.IdentityReference.Equals(AdminSid)&&!rule.IdentityReference.Equals(SystemSid))throw new UnauthorizedAccessException("Storage ACL rejected");
        var handle=CreateFile(path,0x80000000,3,IntPtr.Zero,3,0x02000000|0x00200000,IntPtr.Zero);
        if(handle==new IntPtr(-1))throw new IOException("Cannot lock protected directory");lock(Gate)Held.Add(new HandleOwner(handle));
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
    private static void Save() {lock(Gate){var next=Ledger+"."+Guid.NewGuid().ToString("N")+".next";using(var stream=new FileStream(next,FileMode.CreateNew,FileAccess.Write,FileShare.None)){byte[] data=Encoding.UTF8.GetBytes(Json().Serialize(Records));stream.Write(data,0,data.Length);stream.Flush(true);}if(File.Exists(Ledger))File.Replace(next,Ledger,null);else File.Move(next,Ledger);}}
    private static Dictionary<string,object> Owned(string id){lock(Gate){Dictionary<string,object> record;if(!Records.TryGetValue(id,out record)||Convert.ToString(record["ownerSid"])!=OwnerSid)throw new UnauthorizedAccessException("VM is not registered to this user");return record;}}
    private static Dictionary<string,object>[] RecordSnapshot(){lock(Gate)return Records.Values.Select(record=>new Dictionary<string,object>(record)).ToArray();}
    private static object VmGate(string id){lock(Gate){object value;if(!VmGates.TryGetValue(id,out value)){value=new object();VmGates[id]=value;}return value;}}
    private static Dictionary<string,object> Parameters(Dictionary<string,object> record) {
        string id=Convert.ToString(record["id"]),name="mu-win-"+id.Replace("-","");byte[] hash;using(var sha=SHA256.Create())hash=sha.ComputeHash(Encoding.UTF8.GetBytes(id));
        int slot=((hash[0]<<8)|hash[1])%16384,third=slot>>6,fourth=(slot&63)*4;string dir=Path.Combine(UserRoot,"vms",id);
        var result=new Dictionary<string,object>{{"name",name},{"directory",dir},{"disk",Path.Combine(dir,"disk.vhdx")},{"seed",Path.Combine(dir,"seed.iso")},{"image",record["image"]},{"cpus",record["cpus"]},{"memoryGiB",record["memoryGiB"]},{"diskGiB",record["diskGiB"]},{"brokerResourceLimit",true},{"host","172.29."+third+"."+(fourth+1)},{"guest","172.29."+third+"."+(fourth+2)},{"mac","00155D"+BitConverter.ToString(hash,2,3).Replace("-","")}};
        if(record.ContainsKey("platformId"))result["expectedPlatformId"]=record["platformId"];
        if(Convert.ToString(record["imageSha256"])=="c74a7d3b3476ffb2715bfcaf9c216e9dd1d6c7e01bc6d0380b1744518dfae15c")result["imagePatch"]=new Dictionary<string,object>{{"offset",2495315968L},{"before",Convert.ToBase64String(Encoding.ASCII.GetBytes("# to update this file, run dpkg-reconfigure cloud-init\ndatasource_list: [ Azure ]\n"))},{"after",Convert.ToBase64String(Encoding.ASCII.GetBytes("# to update this file, run dpkg-reconfigure cloud-init\ndatasource_list: [NoCloud]\n"))}};
        return result;
    }
    private static string Invoke(string action,Dictionary<string,object> parameters,int timeout,CancellationToken cancellation) {
        if(action!="stop"){cancellation.ThrowIfCancellationRequested();if(Stopping)throw new OperationCanceledException("Broker is closing");}
        string system=Environment.GetFolderPath(Environment.SpecialFolder.Windows),script="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);try { & '"+ScriptFile.Replace("'","''")+"' -Action '"+action+"' } catch { [Console]::Error.WriteLine($_.Exception.ToString());[Console]::Error.WriteLine($_.ScriptStackTrace);exit 1 }";
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
        FileStream input=null;using(OwnerIdentity.Impersonate()){input=new FileStream(source,FileMode.Open,FileAccess.Read,FileShare.Read,1048576,FileOptions.SequentialScan);}
        try{if(GetFileType(input.SafeFileHandle.DangerousGetHandle())!=1||input.Length<1||input.Length>max)throw new ArgumentException("Input file exceeds bounds");var path=new StringBuilder(32768);if(GetFinalPathNameByHandle(input.SafeFileHandle.DangerousGetHandle(),path,(uint)path.Capacity,0)==0||path.ToString().StartsWith("\\\\?\\UNC\\",StringComparison.OrdinalIgnoreCase))throw new ArgumentException("Network input rejected");return input;}catch{input.Dispose();throw;}
    }
    private static void CopyCaller(NamedPipeServerStream pipe,string source,string destination,string digest,long max,CancellationToken cancellation) {
        using(var input=CallerFile(pipe,source,max))using(var output=new FileStream(destination,FileMode.CreateNew,FileAccess.Write,FileShare.None,1048576))using(var sha=SHA256.Create()){
            if(new DriveInfo(Path.GetPathRoot(destination)).AvailableFreeSpace<input.Length+2L*1024*1024*1024)throw new IOException("Insufficient protected storage space");
            var buffer=new byte[1048576];int count;while((count=input.Read(buffer,0,buffer.Length))>0){cancellation.ThrowIfCancellationRequested();sha.TransformBlock(buffer,0,count,null,0);output.Write(buffer,0,count);}sha.TransformFinalBlock(new byte[0],0,0);output.Flush(true);if(BitConverter.ToString(sha.Hash).Replace("-","").ToLowerInvariant()!=digest)throw new ArgumentException("Input checksum mismatch");
        }
    }
    private static void CloseChannel(string id){lock(Gate){Process child;ChannelPorts.Remove(id);if(!Channels.TryGetValue(id,out child))return;Channels.Remove(id);try{if(!child.HasExited)child.Kill();}catch{}child.Dispose();}}
    private static object Channel(string id) {
        lock(VmGate(id)){
        var record=Owned(id);if(!record.ContainsKey("platformId"))throw new InvalidOperationException("VM is not ready");lock(Gate){Process existing;if(Channels.TryGetValue(id,out existing)&&!existing.HasExited)return new {port=ChannelPorts[id]};}CloseChannel(id);
        string executable=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,ChannelFile);var info=new ProcessStartInfo(executable,"--listen "+Convert.ToString(record["platformId"])+" "+Owner.Id){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=AppDomain.CurrentDomain.BaseDirectory};
        var process=Process.Start(info);process.ErrorDataReceived+=(s,e)=>{};process.BeginErrorReadLine();var reading=process.StandardOutput.ReadLineAsync();if(!reading.Wait(10000)){process.Kill();throw new IOException("Guest channel did not start");}var value=Json().Deserialize<Dictionary<string,object>>(reading.Result);int port=Number(value,"port",1,65535);lock(Gate){Channels[id]=process;ChannelPorts[id]=port;}return value;
        }
    }
    private static object Dispatch(NamedPipeServerStream pipe,Dictionary<string,object> request,CancellationToken cancellation) {
        string action=Text(request,"action",32);
        if(action=="hello"){ValidateKeys(request,"action");return new {version=1,ownerPid=Owner.Id,ownerSid=OwnerSid,elevated=true,protectedStorage=true,sourceDigest=SourceDigest};}
        if(action=="doctor"||action=="fingerprint"){ValidateKeys(request,"action");return Invoke(action,null,10000,cancellation);}
        if(action=="shutdown"){ValidateKeys(request,"action");return "";}
        string id=Id(request);
        if(action=="disk") {
            ValidateKeys(request,"action","id","image","imageSha256","cpus","memoryGiB","diskGiB");string source=Text(request,"image",4096),digest=Digest(request,"imageSha256"),extension=Path.GetExtension(source).ToLowerInvariant();if(extension!=".vhd"&&extension!=".vhdx")throw new ArgumentException("Disk image required");
            int cpu=Number(request,"cpus",1,Math.Min(16,Environment.ProcessorCount)),memory=Number(request,"memoryGiB",2,32),disk=Number(request,"diskGiB",16,256);
            lock(VmGate(id)) {
                lock(Gate){if(Records.ContainsKey(id)||Records.Count>=32)throw new InvalidOperationException("VM allocation refused");}
                string dir=Path.Combine(UserRoot,"vms",id);PrivateDirectory(dir);string image=Path.Combine(UserRoot,"images",digest+extension);
                lock(ImportGate){if(!File.Exists(image)){
                    string importLock=Path.Combine(Directory.GetParent(Directory.GetParent(UserRoot).FullName).FullName,"import.lock");
                    using(var reservation=new FileStream(importLock,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)){
                        long remaining=64L*1024*1024*1024-Directory.GetFiles(Path.Combine(UserRoot,"images")).Sum(file=>new FileInfo(file).Length);if(remaining<1)throw new IOException("Image cache quota reached");
                        string next=image+"."+Guid.NewGuid().ToString("N")+".next";try{CopyCaller(pipe,source,next,digest,remaining,cancellation);File.Move(next,image);}finally{if(File.Exists(next))File.Delete(next);}
                    }
                }
                else if((File.GetAttributes(image)&FileAttributes.ReparsePoint)!=0||HashFile(image)!=digest)throw new UnauthorizedAccessException("Protected image changed");}
                var record=new Dictionary<string,object>{{"id",id},{"ownerSid",OwnerSid},{"image",image},{"imageSha256",digest},{"cpus",cpu},{"memoryGiB",memory},{"diskGiB",disk},{"stage","allocated"}};lock(Gate){if(Records.Count>=32)throw new InvalidOperationException("VM allocation refused");Records.Add(id,record);Save();}
                Invoke("disk",Parameters(record),1200000,cancellation);lock(Gate){record["stage"]="disk-ready";Save();}return "";
            }
        }
        if(action=="register-channel"){ValidateKeys(request,"action","id");return Invoke(action,Parameters(Owned(id)),15000,cancellation);}
        if(action=="create") {
            ValidateKeys(request,"action","id","seed","seedSha256");var record=Owned(id);lock(VmGate(id)){
                if(Convert.ToString(record["stage"])!="disk-ready")throw new InvalidOperationException("Disk is not ready");var parameters=Parameters(record);string seed=Convert.ToString(parameters["seed"]);
                CopyCaller(pipe,Text(request,"seed",4096),seed,Digest(request,"seedSha256"),8*1024*1024,cancellation);
                using(var input=File.OpenRead(seed)){input.Position=32769;var signature=new byte[5];if(input.Read(signature,0,5)!=5||Encoding.ASCII.GetString(signature)!="CD001")throw new ArgumentException("ISO seed required");}
                Invoke("register-channel",parameters,15000,cancellation);string result=Invoke("create",parameters,60000,cancellation);var created=Json().Deserialize<Dictionary<string,object>>(result);string platform=Text(created,"platformId",36);Guid parsed;if(!Guid.TryParseExact(platform,"D",out parsed)||parsed==Guid.Empty)throw new IOException("VM identity was not returned");lock(Gate){record["platformId"]=platform;record["stage"]="ready";Save();}return result;
            }
        }
        ValidateKeys(request,"action","id");var owned=Owned(id);
        if(action=="channel")return Channel(id);
        if(action=="close-channel"){CloseChannel(id);return "";}
        if(action=="start"||action=="stop"||action=="status"||action=="inspect"){
            if(!owned.ContainsKey("platformId"))throw new InvalidOperationException("VM is not registered");lock(VmGate(id)){
                if(action=="stop")CloseChannel(id);try{return Invoke(action,Parameters(owned),30000,action=="stop"?CancellationToken.None:cancellation);}finally{if(action=="start"&&cancellation.IsCancellationRequested){CloseChannel(id);try{Invoke("stop",Parameters(owned),30000,CancellationToken.None);}catch{}}}
            }
        }
        throw new ArgumentException("Operation is not permitted");
    }
    private static void Serve(NamedPipeServerStream pipe) {
        var cancel=new CancellationTokenSource();bool counted=false;try {
            using(var timeout=new Timer(_=>{try{pipe.Dispose();}catch{}},null,10000,Timeout.Infinite)){
                var bytes=new List<byte>();int value;while((value=pipe.ReadByte())!=10){if(value<0||bytes.Count>=65536)throw new ArgumentException("Request exceeds bounds");bytes.Add((byte)value);}timeout.Change(Timeout.Infinite,Timeout.Infinite);
                uint pid;if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid)||pid!=Owner.Id||Owner.HasExited)throw new UnauthorizedAccessException("Application process rejected");
                string sid=null;pipe.RunAsClient(()=>sid=WindowsIdentity.GetCurrent(true).User.Value);if(sid!=OwnerSid)throw new UnauthorizedAccessException("Application user rejected");
                var watching=new Thread(()=>{try{pipe.ReadByte();}catch{}cancel.Cancel();});watching.IsBackground=true;watching.Start();
                lock(Gate){if(Stopping)throw new OperationCanceledException("Broker is closing");ActiveRequests++;RequestsIdle.Reset();counted=true;}
                var request=Json().Deserialize<Dictionary<string,object>>(new UTF8Encoding(false,true).GetString(bytes.ToArray()));object result=Dispatch(pipe,request,cancel.Token);byte[] response=Encoding.UTF8.GetBytes(Json().Serialize(new {ok=true,result=result})+"\n");pipe.Write(response,0,response.Length);pipe.Flush();if(Convert.ToString(request["action"])=="shutdown"){try{pipe.WaitForPipeDrain();}catch{}ThreadPool.QueueUserWorkItem(_=>Shutdown());}
            }
        }catch(Exception error){try{byte[] response=Encoding.UTF8.GetBytes(Json().Serialize(new {ok=false,code=error is UnauthorizedAccessException?"DENIED":error is ArgumentException?"INVALID_REQUEST":error is OperationCanceledException?"CANCELLED":"BROKER_FAILED",error=error is ArgumentException||error is UnauthorizedAccessException?error.Message:"Privileged VM operation failed"})+"\n");pipe.Write(response,0,response.Length);pipe.Flush();}catch{}try{File.AppendAllText(Path.Combine(UserRoot,"broker-errors.log"),DateTime.UtcNow.ToString("o")+" "+error.ToString()+Environment.NewLine);}catch{}}
        finally{cancel.Cancel();pipe.Dispose();lock(Gate){Pipes.Remove(pipe);if(counted){ActiveRequests--;if(ActiveRequests==0)RequestsIdle.Set();}}}
    }
    private static void Shutdown(){bool producer=false;lock(Gate){if(!Stopping){Stopping=true;producer=true;foreach(var pipe in Pipes.ToArray())try{pipe.Dispose();}catch{}}}if(!producer){ShutdownComplete.WaitOne();return;}
        try{RequestsIdle.WaitOne(30000);foreach(var record in RecordSnapshot()){string id=Convert.ToString(record["id"]);CloseChannel(id);if(record.ContainsKey("platformId"))try{Invoke("stop",Parameters(record),30000,CancellationToken.None);}catch{}}}finally{ShutdownComplete.Set();}
    }
    public static int Main(string[] args) {
        if(args.Length==1&&args[0]=="--self-test"){try{ValidateKeys(new Dictionary<string,object>{{"action","start"},{"command","bad"}},"action","id");return 1;}catch(ArgumentException){}Console.WriteLine("Broker request boundary verified");return 0;}
        if(args.Length!=4||args[0]!="--owner"||args[2]!="--pipe")return 64;int ownerPid;if(!int.TryParse(args[1],out ownerPid)||ownerPid<=0||args[3].Length!=64||args[3].Any(c=>!(c>='0'&&c<='9'||c>='a'&&c<='f')))return 64;
        if(!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))return 77;
        try {
            Owner=Process.GetProcessById(ownerPid);OwnerSid=ProcessSid(Owner);var common=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"MuCodeSandbox-HyperVBroker-v1");TrustedExecutable(common);PrivateDirectory(common);var users=Path.Combine(common,"users");PrivateDirectory(users);UserRoot=Path.Combine(users,OwnerSid);PrivateDirectory(UserRoot);PrivateDirectory(Path.Combine(UserRoot,"images"));PrivateDirectory(Path.Combine(UserRoot,"vms"));
            // The previous owner can exit before its agent finishes VM cleanup.
            // Wait for that sealed store to be released, never bypass its lock.
            var waiting=Stopwatch.StartNew();for(;;){if(Owner.HasExited)throw new OperationCanceledException("Application exited while waiting for storage");try{Held.Add(new FileStream(Path.Combine(UserRoot,"session.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None));break;}catch(IOException){if(waiting.ElapsedMilliseconds>90000)throw;Thread.Sleep(100);}}
            Ledger=Path.Combine(UserRoot,"vms.json");if(File.Exists(Ledger)){var saved=Json().Deserialize<Dictionary<string,Dictionary<string,object>>>(File.ReadAllText(Ledger));foreach(var pair in saved)Records.Add(pair.Key,pair.Value);}
            byte[] scriptBytes=Convert.FromBase64String(HyperVScript);string scriptHash;using(var sha=SHA256.Create())scriptHash=BitConverter.ToString(sha.ComputeHash(scriptBytes)).Replace("-","").ToLowerInvariant();ScriptFile=Path.Combine(UserRoot,"hyperv-"+scriptHash+".ps1");if(File.Exists(ScriptFile)){if((File.GetAttributes(ScriptFile)&FileAttributes.ReparsePoint)!=0||HashFile(ScriptFile)!=scriptHash)throw new UnauthorizedAccessException("Protected script changed");}else{using(var scriptStream=new FileStream(ScriptFile,FileMode.CreateNew,FileAccess.Write,FileShare.None)){scriptStream.Write(scriptBytes,0,scriptBytes.Length);scriptStream.Flush(true);}}
            foreach(var record in RecordSnapshot())if(record.ContainsKey("platformId"))try{Invoke("stop",Parameters(record),30000,CancellationToken.None);}catch{throw new IOException("Previous VM shutdown was not confirmed");}
            var watcher=new Thread(()=>{try{Owner.WaitForExit();}catch{}Shutdown();});watcher.IsBackground=true;watcher.Start();
            var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(OwnerSid),PipeAccessRights.ReadWrite,AccessControlType.Allow));security.AddAccessRule(new PipeAccessRule(SystemSid,PipeAccessRights.FullControl,AccessControlType.Allow));security.AddAccessRule(new PipeAccessRule(AdminSid,PipeAccessRights.FullControl,AccessControlType.Allow));
            while(!Stopping){NamedPipeServerStream pipe=null;try{pipe=new NamedPipeServerStream("MuCodeSandbox-Broker-"+args[3],PipeDirection.InOut,16,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,65536,65536,security);lock(Gate)Pipes.Add(pipe);pipe.WaitForConnection();ThreadPool.QueueUserWorkItem(_=>Serve(pipe));}catch{if(pipe!=null){pipe.Dispose();lock(Gate)Pipes.Remove(pipe);}if(!Stopping)Thread.Sleep(100);}}
            return 0;
        }catch(Exception error){Console.Error.WriteLine("Windows broker could not start: "+error.GetType().Name);return 1;}
        finally{Shutdown();for(int i=Held.Count-1;i>=0;i--)Held[i].Dispose();if(OwnerIdentity!=null)OwnerIdentity.Dispose();}
    }
}
