using System;
using System.IO;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.AccessControl;
using Microsoft.Win32.SafeHandles;

// Standalone diagnostics only; not loaded by the production permission broker.
public sealed class MuPacketLabGuard:IDisposable {
    [StructLayout(LayoutKind.Sequential)] private struct Wnode {public uint Size,Provider;public ulong Context;public long Timestamp;public Guid Guid;public uint Clock,Flags;}
    [StructLayout(LayoutKind.Sequential)] private struct TraceProperties {public Wnode Header;public uint BufferSize,Minimum,Maximum,FileSize,Mode,Flush,Enable;public int Age;public uint Buffers,Free,Lost,Written,LogLost,RealTimeLost;public IntPtr Thread;public uint FileOffset,NameOffset;}
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,EntryPoint="ControlTraceW")] private static extern uint QueryTrace(ulong handle,string name,IntPtr properties,uint query);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file,[Out]byte[] info);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool DuplicateToken(IntPtr token,int level,out IntPtr duplicate);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr value);
    private readonly List<SafeFileHandle> held=new List<SafeFileHandle>();
    private readonly WindowsIdentity identity;
    public readonly Process Owner;
    public readonly string DirectoryPath;
    public string Sid {get{return identity.User.Value;}}
    public static Dictionary<string,object> CaptureIdentity(){
        int size=Marshal.SizeOf(typeof(TraceProperties)),capacity=size+8192;IntPtr memory=Marshal.AllocHGlobal(capacity);
        try{
            Marshal.Copy(new byte[capacity],0,memory,capacity);var initial=new TraceProperties();initial.Header.Size=(uint)capacity;initial.Header.Flags=0x20000;initial.NameOffset=(uint)size;initial.FileOffset=(uint)(size+2048);Marshal.StructureToPtr(initial,memory,false);
            uint status=QueryTrace(0,"PktMon",memory,0);if(status!=0)throw new IOException("Cannot query active packet trace: "+status);
            var value=(TraceProperties)Marshal.PtrToStructure(memory,typeof(TraceProperties));
            return new Dictionary<string,object>{{"key",value.Header.Guid.ToString("D")+":"+value.Header.Context+":"+value.Thread.ToInt64()},{"lostEvents",(ulong)value.Lost+value.LogLost+value.RealTimeLost}};
        }finally{Marshal.FreeHGlobal(memory);}
    }
    public MuPacketLabGuard(int ownerPid,string directory){
        Owner=Process.GetProcessById(ownerPid);IntPtr token,copy;
        if(!OpenProcessToken(Owner.Handle,10,out token))throw new UnauthorizedAccessException("Owner token unavailable");
        try{if(!DuplicateToken(token,2,out copy))throw new UnauthorizedAccessException("Owner token unavailable");try{identity=new WindowsIdentity(copy);}finally{CloseHandle(copy);}}finally{CloseHandle(token);}
        if(new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))throw new UnauthorizedAccessException("Packet lab owner must be ordinary user");
        DirectoryPath=Path.GetFullPath(directory).TrimEnd('\\');if(DirectoryPath.Length<4||DirectoryPath[1]!=':')throw new ArgumentException("Local diagnostic directory required");
        string cursor=Path.GetPathRoot(DirectoryPath);Pin(cursor);
        foreach(string part in DirectoryPath.Substring(cursor.Length).Split(new[]{'\\'},StringSplitOptions.RemoveEmptyEntries)){cursor=Path.Combine(cursor,part);Pin(cursor);}
        var acl=Directory.GetAccessControl(DirectoryPath);if(!acl.GetOwner(typeof(SecurityIdentifier)).Equals(identity.User))throw new UnauthorizedAccessException("Diagnostic directory owner changed");
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&rule.IdentityReference.Value!=Sid&&rule.IdentityReference.Value!="S-1-5-18"&&rule.IdentityReference.Value!="S-1-5-32-544")throw new UnauthorizedAccessException("Diagnostic directory ACL changed");
    }
    private void Pin(string path){
        var file=CreateFile(path,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);if(file.IsInvalid){file.Dispose();throw new IOException("Cannot pin diagnostic directory");}
        var info=new byte[52];if(!GetFileInformationByHandle(file,info)||((FileAttributes)BitConverter.ToUInt32(info,0)&FileAttributes.ReparsePoint)!=0||((FileAttributes)BitConverter.ToUInt32(info,0)&FileAttributes.Directory)==0){file.Dispose();throw new IOException("Diagnostic reparse path rejected");}held.Add(file);
    }
    private string FilePath(string name){if(name.Length<1||name.Length>80||System.Text.RegularExpressions.Regex.IsMatch(name,@"[^a-z0-9.\-]"))throw new ArgumentException("Diagnostic filename rejected");return Path.Combine(DirectoryPath,name);}
    public string Reserve(string name){
        string path=FilePath(name);var file=CreateFile(path,0,3,IntPtr.Zero,1,0x00200080,IntPtr.Zero);if(file.IsInvalid){file.Dispose();throw new IOException("Diagnostic output already exists or cannot be reserved");}held.Add(file);return path;
    }
    public string CreateArtifacts(){
        string path=FilePath("trace-artifacts");if(Directory.Exists(path)||File.Exists(path))throw new IOException("Diagnostic staging already exists");
        var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);var admin=new SecurityIdentifier("S-1-5-32-544");acl.SetOwner(admin);
        foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        Directory.CreateDirectory(path,acl);Pin(path);var actual=Directory.GetAccessControl(path);var owner=(SecurityIdentifier)actual.GetOwner(typeof(SecurityIdentifier));if(!owner.Equals(admin)&&owner.Value!="S-1-5-18")throw new UnauthorizedAccessException("Diagnostic staging owner changed");
        foreach(FileSystemAccessRule rule in actual.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&rule.IdentityReference.Value!="S-1-5-18"&&rule.IdentityReference.Value!="S-1-5-32-544")throw new UnauthorizedAccessException("Diagnostic staging permissions changed");return path;
    }
    public string ReopenArtifacts(){
        string path=FilePath("trace-artifacts");Pin(path);
        var acl=Directory.GetAccessControl(path);var owner=(SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier));
        if(owner.Value!="S-1-5-18"&&owner.Value!="S-1-5-32-544")throw new UnauthorizedAccessException("Diagnostic staging owner changed");
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&rule.IdentityReference.Value!="S-1-5-18"&&rule.IdentityReference.Value!="S-1-5-32-544")throw new UnauthorizedAccessException("Diagnostic staging permissions changed");
        return path;
    }
    public void PublishArtifacts(){
        string path=FilePath("trace-artifacts");
        foreach(string file in Directory.GetFiles(path)){
            if((File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)throw new IOException("Diagnostic output changed");
            var acl=new FileSecurity();acl.SetAccessRuleProtection(true,false);acl.SetOwner(identity.User);
            foreach(string sid in new[]{Sid,"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));File.SetAccessControl(file,acl);
        }
        var directoryAcl=new DirectorySecurity();directoryAcl.SetAccessRuleProtection(true,false);directoryAcl.SetOwner(identity.User);
        foreach(string sid in new[]{Sid,"S-1-5-18","S-1-5-32-544"})directoryAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.SetAccessControl(path,directoryAcl);
    }
    public string ReadCommand(string name){
        using(identity.Impersonate())using(var file=new FileStream(FilePath(name),FileMode.Open,FileAccess.Read,FileShare.Read)){if(file.Length>4096)throw new ArgumentException("Diagnostic request too large");using(var reader=new StreamReader(file,System.Text.Encoding.UTF8,true))return reader.ReadToEnd();}
    }
    // Offline deployment inputs are opened with the ordinary owner's token.
    // Retained handles reject links and prevent replacement while an elevated
    // diagnostic copies them into its newly created, protected virtual disk.
    private SafeFileHandle OpenOwnerFile(string path){
        SafeFileHandle file;
        using(identity.Impersonate())file=CreateFile(path,0x80000000,1,IntPtr.Zero,3,0x08200000,IntPtr.Zero);
        if(file.IsInvalid){file.Dispose();throw new IOException("Cannot open ordinary-user diagnostic input");}
        var info=new byte[52];
        if(!GetFileInformationByHandle(file,info)||((FileAttributes)BitConverter.ToUInt32(info,0)&(FileAttributes.ReparsePoint|FileAttributes.Directory))!=0){file.Dispose();throw new IOException("Diagnostic input must be a regular file");}
        return file;
    }
    public void PinInputFile(string input){
        string full=Path.GetFullPath(input),parent=Path.GetDirectoryName(full);
        if(full.Length<4||full[1]!=':')throw new ArgumentException("Local diagnostic input required");
        using(identity.Impersonate()){
            string cursor=Path.GetPathRoot(parent);Pin(cursor);
            foreach(string part in parent.Substring(cursor.Length).Split(new[]{'\\'},StringSplitOptions.RemoveEmptyEntries)){cursor=Path.Combine(cursor,part);Pin(cursor);}
        }
        held.Add(OpenOwnerFile(full));
    }
    public void CopyGuestSeed(string destination){
        string source=FilePath("guest-seed");
        var pending=new Stack<string>();pending.Push(source);
        int count=0;long bytes=0;
        while(pending.Count!=0){
            string folder=pending.Pop();string[] entries;
            using(identity.Impersonate()){Pin(folder);entries=Directory.GetFileSystemEntries(folder);}
            Directory.CreateDirectory(Path.Combine(destination,folder.Substring(source.Length).TrimStart('\\')));
            foreach(string entry in entries){
                FileAttributes attrs;using(identity.Impersonate())attrs=File.GetAttributes(entry);
                if((attrs&FileAttributes.ReparsePoint)!=0)throw new IOException("Diagnostic seed link rejected");
                string target=Path.Combine(destination,entry.Substring(source.Length+1));
                if((attrs&FileAttributes.Directory)!=0){pending.Push(entry);continue;}
                if(++count>12000)throw new IOException("Diagnostic seed contains too many files");
                using(var handle=OpenOwnerFile(entry))using(var input=new FileStream(handle,FileAccess.Read,65536,false)){
                    bytes+=input.Length;if(bytes>64L*1024*1024*1024)throw new IOException("Diagnostic seed exceeds its size bound");
                    using(var output=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None)){input.CopyTo(output);output.Flush(true);}
                }
            }
        }
    }
    public string ReadGuestCredentials(){
        string seed=FilePath("guest-seed"),parent=Path.Combine(seed,"private");
        using(identity.Impersonate()){Pin(seed);Pin(parent);}
        using(var handle=OpenOwnerFile(Path.Combine(parent,"credentials.json")))
        using(var input=new FileStream(handle,FileAccess.Read,4096,false)){
            if(input.Length>4096)throw new IOException("Diagnostic credential input too large");
            using(var reader=new StreamReader(input,new System.Text.UTF8Encoding(false,true),true))return reader.ReadToEnd();
        }
    }
    public void Dispose(){for(int i=held.Count-1;i>=0;i--)held[i].Dispose();identity.Dispose();Owner.Dispose();}
}
