using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

// Fixed-path store. The broker must prepare the protected directory, hold its
// lifecycle gates, and supply journal-backed verification callbacks. This type
// neither verifies a VM nor grants recovery admission on its own.
public sealed class MuRestoreOriginSnapshot {
    public string Text {get;private set;}
    public string Token {get;private set;}
    public bool Accepted {get;private set;}
    public MuRestoreOriginSnapshot(string text,string token,bool accepted=false){Text=text;Token=token;Accepted=accepted;}
}
public sealed partial class MuRestoreOriginStore:IDisposable {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file,[Out]byte[] info);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle file,int kind,IntPtr data,uint size);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern uint GetSecurityInfo(SafeFileHandle handle,int type,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    private readonly string root,directory,sid;
    private readonly List<SafeFileHandle> pins=new List<SafeFileHandle>();
    private readonly Action<SafeFileHandle,bool> authority;
    private SafeFileHandle rootHandle,directoryHandle,sessionLock;
    private bool disposed;
    private readonly bool requireExisting;
    private Dictionary<string,object> preparation;
    private readonly Action<Dictionary<string,object>> bindPreparation;
    private readonly Action completePreparation;
    private readonly object operationGate=new object();
    public MuRestoreOriginStore(string userRoot,string ownerSid):this(userRoot,ownerSid,ValidateAuthority){}
    public MuRestoreOriginStore(string userRoot,string ownerSid,bool existing):this(userRoot,ownerSid,ValidateAuthority,null,existing){}
    // Storage transport tests can isolate the ACL authority boundary in the
    // same assembly. Production construction always uses ValidateAuthority.
    internal MuRestoreOriginStore(string userRoot,string ownerSid,Dictionary<string,object> plan,Action<Dictionary<string,object>> bind,Action complete):this(userRoot,ownerSid,ValidateAuthority,null,false,plan,bind,complete){}
    internal MuRestoreOriginStore(string userRoot,string ownerSid,Action<SafeFileHandle,bool> validate,Action<string> observe=null,bool existing=false,Dictionary<string,object> plan=null,Action<Dictionary<string,object>> bind=null,Action complete=null){
        if(validate==null)throw new ArgumentNullException("validate");authority=validate;checkpoint=observe;requireExisting=existing;
        if(plan!=null){MuOriginPreparation.Validate(plan);if(existing||bind==null||complete==null)throw new ArgumentException("Trusted initialization callbacks required");preparation=FrameJson().Deserialize<Dictionary<string,object>>(FrameJson().Serialize(plan));}
        else if(bind!=null||complete!=null)throw new ArgumentException("Preparation journal required");bindPreparation=bind;completePreparation=complete;
        root=Path.GetFullPath(userRoot).TrimEnd('\\');sid=new SecurityIdentifier(ownerSid).Value;
        if(root.Length<4||root!=userRoot||!char.IsLetter(root[0])||root[1]!=':'||root[2]!='\\'||root.Substring(2).Contains(':')||root.Split('\\').Skip(1).Any(part=>part==""||part.EndsWith(".")||part.EndsWith(" "))||new DriveInfo(Path.GetPathRoot(root)).DriveType==DriveType.Network||sid!=ownerSid)throw new UnauthorizedAccessException("Fixed local origin root required");
        directory=Path.Combine(root,"restore-origins");
        try{
            var sequence=new List<string>();for(string current=root;!string.IsNullOrEmpty(current);current=Path.GetDirectoryName(current))sequence.Add(current);sequence.Reverse();
            foreach(string parent in sequence){var handle=Open(parent,true,false,3);pins.Add(handle);if(parent==root)rootHandle=handle;}
            authority(rootHandle,true);directoryHandle=Open(directory,true,false,3);pins.Add(directoryHandle);authority(directoryHandle,true);Streams(directoryHandle,true);
            sessionLock=Open(Path.Combine(directory,".lock"),false,true,requireExisting||preparation!=null&&preparation["storeFile"]!=null?3U:4U,0);pins.Add(sessionLock);authority(sessionLock,false);Streams(sessionLock,false);Inventory();InitializeFrames();
        }catch{Dispose();throw;}
    }
    private static void ValidateAuthority(SafeFileHandle handle,bool directory){
        IntPtr owner,group,dacl,sacl,descriptor;uint error=GetSecurityInfo(handle,1,5,out owner,out group,out dacl,out sacl,out descriptor);
        if(error!=0)throw new UnauthorizedAccessException("Origin ACL unavailable");
        try{uint size=GetSecurityDescriptorLength(descriptor);if(size<20||size>65536)throw new UnauthorizedAccessException("Origin ACL bound rejected");var bytes=new byte[size];Marshal.Copy(descriptor,bytes,0,(int)size);FileSystemSecurity acl=directory?(FileSystemSecurity)new DirectorySecurity():new FileSecurity();acl.SetSecurityDescriptorBinaryForm(bytes);MuRestoreOriginProof.ValidateAcl(acl);}finally{LocalFree(descriptor);}
    }
    private static SafeFileHandle Open(string path,bool directory,bool writing,uint creation,uint? share=null){
        uint access=directory?0x20081U:0x80020080U;if(writing)access|=0x40010000U;
        var file=CreateFile(path,access,share??(directory?3U:1U),IntPtr.Zero,creation,0x02200000U|(writing?0x80000000U:0U),IntPtr.Zero);
        try{if(file.IsInvalid)throw new IOException("Cannot pin origin storage");var info=Info(file);uint attributes=BitConverter.ToUInt32(info,0);if((attributes&0x400)!=0||((attributes&0x10)!=0)!=directory||!directory&&BitConverter.ToUInt32(info,40)!=1)throw new UnauthorizedAccessException("Origin storage link/type rejected");return file;}catch{file.Dispose();throw;}
    }
    private static byte[] Info(SafeFileHandle file){var info=new byte[52];if(!GetFileInformationByHandle(file,info))throw new IOException("Origin handle identity unavailable");return info;}
    public static Dictionary<string,object> CaptureIdentity(SafeFileHandle file){
        var info=Info(file);if((BitConverter.ToUInt32(info,0)&0x400)!=0||(BitConverter.ToUInt32(info,0)&0x10)==0&&BitConverter.ToUInt32(info,40)!=1)throw new UnauthorizedAccessException("Origin identity link rejected");
        return new Dictionary<string,object>{{"fileId",BitConverter.ToUInt32(info,28).ToString("x8")+BitConverter.ToUInt32(info,44).ToString("x8")+BitConverter.ToUInt32(info,48).ToString("x8")},{"birthFileTime",BitConverter.ToUInt64(info,4).ToString(CultureInfo.InvariantCulture)}};
    }
    public Dictionary<string,object> RootIdentity {get{Alive();return CaptureIdentity(rootHandle);}}
    private static void Streams(SafeFileHandle file,bool directory){
        const int bound=65536;IntPtr memory=Marshal.AllocHGlobal(bound);
        try{if(!GetFileInformationByHandleEx(file,7,memory,bound)){if(directory&&Marshal.GetLastWin32Error()==38)return;throw new IOException("Origin stream inventory unavailable");}
            int length=Marshal.ReadInt32(memory,4);if(directory||Marshal.ReadInt32(memory)!=0||length!=14||Marshal.PtrToStringUni(IntPtr.Add(memory,24),length/2)!="::$DATA")throw new UnauthorizedAccessException("Origin alternate data stream rejected");
        }finally{Marshal.FreeHGlobal(memory);}
    }
    private static void Id(string id){Guid parsed;if(!Guid.TryParseExact(id,"D",out parsed)||parsed==Guid.Empty||parsed.ToString("D")!=id)throw new UnauthorizedAccessException("Canonical origin id required");}
    private void Alive(){if(disposed)throw new ObjectDisposedException("MuRestoreOriginStore");}
    private void Inventory(){
        Alive();authority(rootHandle,true);authority(directoryHandle,true);authority(sessionLock,false);Streams(rootHandle,true);Streams(directoryHandle,true);Streams(sessionLock,false);
        if(BitConverter.ToUInt32(Info(sessionLock),40)!=1)throw new UnauthorizedAccessException("Origin lock hard link rejected");
        var entries=Directory.EnumerateFileSystemEntries(directory).Take(2).ToArray();if(entries.Length!=1||Path.GetFileName(entries[0])!=".lock")throw new IOException("Unknown or legacy origin storage preserved; explicit migration required");
    }
    private void Binding(Dictionary<string,object> proof,string id,string platform){
        MuRestoreOriginProof.Validate(proof,sid,id,platform);var identity=proof["rootFile"] as Dictionary<string,object>;var current=RootIdentity;
        if((string)identity["fileId"]!=(string)current["fileId"]||(string)identity["birthFileTime"]!=(string)current["birthFileTime"])throw new UnauthorizedAccessException("Origin belongs to a different protected root");
    }
    public MuRestoreOriginSnapshot ReadSnapshot(string id,string platform){lock(operationGate){Alive();return FrameSnapshot(id,platform);}}
    public MuRestoreOriginSnapshot ReadAcceptedSnapshot(string id,string platform){lock(operationGate){Alive();var snapshot=FrameSnapshot(id,platform);if(!snapshot.Accepted)throw new UnauthorizedAccessException("Restore origin import acceptance is incomplete; preserved");return snapshot;}}
    public bool Contains(string id){lock(operationGate){Alive();Id(id);return Load().Rows.ContainsKey(id);}}
    public Dictionary<string,object> Read(string id,string platform){return MuRestoreOriginProof.Parse(ReadSnapshot(id,platform).Text,sid,id,platform);}
    public void PublishInitial(Dictionary<string,object> value,string id,string platform){lock(operationGate){Alive();PublishFrame(value,id,platform);}}
    public void AcceptInitial(MuRestoreOriginSnapshot expected,string id,string platform,Action<Dictionary<string,object>> verifyFinalImport){lock(operationGate){Alive();AcceptFrame(expected,id,platform,verifyFinalImport);}}
    public void Update(MuRestoreOriginSnapshot expected,Dictionary<string,object> value,string operation,string id,string platform,Action<Dictionary<string,object>> verifyJournalAndState){lock(operationGate){Alive();UpdateFrame(expected,value,operation,id,platform,verifyJournalAndState);}}
    public bool RetireAfterAbsence(MuRestoreOriginSnapshot expected,string id,string platform,Action<Dictionary<string,object>> verifyJournalAndAbsence){lock(operationGate){Alive();return RetireFrame(expected,id,platform,verifyJournalAndAbsence);}}
    public void Dispose(){lock(operationGate){if(disposed)return;disposed=true;for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();pins.Clear();}}
}
