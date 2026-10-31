// Imported with OfflineSnapshots.cs into the broker and ordinary-file fixtures.
// The caller supplies protected-path authority and owns the snapshot operation
// lock. Receipt frames contain identities only, never guest keys/configuration.
public sealed class MuSnapshotStaging:MuOfflineSnapshotStore.IStagingFactory {
    [StructLayout(LayoutKind.Sequential)] private struct IoStatus {public IntPtr Status;public UIntPtr Information;}
    [StructLayout(LayoutKind.Sequential)] private struct UnicodeName {public ushort Length,MaximumLength;public IntPtr Buffer;}
    [StructLayout(LayoutKind.Sequential)] private struct ObjectAttributes {public int Length;public IntPtr RootDirectory,ObjectName;public uint Attributes;public IntPtr SecurityDescriptor,SecurityQualityOfService;}
    [DllImport("ntdll.dll")] private static extern int NtCreateFile(out Microsoft.Win32.SafeHandles.SafeFileHandle file,uint access,ref ObjectAttributes attributes,out IoStatus status,IntPtr allocation,uint flags,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);
    [DllImport("ntdll.dll")] private static extern int NtSetInformationFile(Microsoft.Win32.SafeHandles.SafeFileHandle file,out IoStatus status,byte[] data,uint length,int kind);
    [DllImport("ntdll.dll")] private static extern uint RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle file,[Out]byte[] info);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandleEx(Microsoft.Win32.SafeHandles.SafeFileHandle file,int kind,IntPtr data,uint length);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool SetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle file,int kind,byte[] data,uint length);
    public sealed class Identity {public string fileId,birthFileTime;}
    public sealed class OwnedFile {public string name,role;public Identity identity;}
    public sealed class SealedFile {public string name,modified;public long bytes;public Identity identity;}
    private sealed class Frame {
        public int version;public string type,id,environmentId,operation,authority;
        public Identity root,directory;public OwnedFile file;public SealedFile[] inventory;
    }
    private sealed class Journal {
        public Frame begin;public readonly List<OwnedFile> files=new List<OwnedFile>();
        public SealedFile[] plan;public bool published,done,partial;public long validLength;public string fingerprint;
    }
    public sealed class Review {
        public string id,operation,phase,token;public long bytes;public int files;public bool partialReceipt;
    }
    private readonly string allocation,root,environmentId,authority;
    private readonly Action<string,bool> validate;
    private readonly Func<bool,byte[]> creationSecurity;
    private readonly Action<string> progress;
    private const int ReceiptBound=65536,FrameBound=8192;
    public MuSnapshotStaging(string allocationDirectory,string id,string authorityDigest,Action<string,bool> protectedAuthority,Action<string> observe=null,Func<bool,byte[]> security=null){
        Id(id);Digest(authorityDigest);allocation=Path.GetFullPath(allocationDirectory).TrimEnd(Path.DirectorySeparatorChar);
        if(Path.GetFileName(allocation)!=id||!System.Text.RegularExpressions.Regex.IsMatch(allocation,@"^[A-Za-z]:\\")||new DriveInfo(Path.GetPathRoot(allocation)).DriveType==DriveType.Network)throw new ArgumentException("Fixed local staging allocation required");
        if(protectedAuthority==null)throw new ArgumentNullException("protectedAuthority");environmentId=id;authority=authorityDigest;root=Path.Combine(allocation,"snapshots");validate=protectedAuthority;progress=observe??(_=>{});creationSecurity=security;
    }
    private static void Id(string value){Guid parsed;if(!Guid.TryParseExact(value,"D",out parsed)||parsed==Guid.Empty||parsed.ToString("D")!=value)throw new ArgumentException("Canonical staging identity required");}
    private static void Digest(string value){if(value==null||!System.Text.RegularExpressions.Regex.IsMatch(value,@"^[a-f0-9]{64}$"))throw new ArgumentException("Staging authority digest required");}
    private static void Kind(string value){if(value!="create"&&value!="restore")throw new ArgumentException("Fixed staging operation required");}
    private static bool Exists(string path){try{System.IO.File.GetAttributes(path);return true;}catch(FileNotFoundException){return false;}catch(DirectoryNotFoundException){return false;}}
    private static JavaScriptSerializer Json(){return new JavaScriptSerializer{MaxJsonLength=ReceiptBound,RecursionLimit=12};}
    private static byte[] Info(Microsoft.Win32.SafeHandles.SafeFileHandle file){var info=new byte[52];if(!GetFileInformationByHandle(file,info))throw new IOException("Cannot inspect staging identity");return info;}
    private static Identity IdentityOf(Microsoft.Win32.SafeHandles.SafeFileHandle file,bool directory){
        var info=Info(file);uint flags=BitConverter.ToUInt32(info,0);
        if((flags&0x400)!=0||((flags&0x10)!=0)!=directory||!directory&&BitConverter.ToUInt32(info,40)!=1)throw new IOException("Staging link or type changed");
        return new Identity{fileId=BitConverter.ToUInt32(info,28).ToString("x8")+BitConverter.ToUInt32(info,44).ToString("x8")+BitConverter.ToUInt32(info,48).ToString("x8"),birthFileTime=BitConverter.ToUInt64(info,4).ToString(System.Globalization.CultureInfo.InvariantCulture)};
    }
    private static void IdentityValid(Identity identity){ulong time;if(identity==null||!System.Text.RegularExpressions.Regex.IsMatch(identity.fileId??"",@"^[a-f0-9]{24}$")||!ulong.TryParse(identity.birthFileTime,out time)||time==0)throw new InvalidDataException("Staging original identity missing");}
    private static bool Same(Identity a,Identity b){IdentityValid(a);IdentityValid(b);return a.fileId==b.fileId&&a.birthFileTime==b.birthFileTime;}
    private static void Streams(Microsoft.Win32.SafeHandles.SafeFileHandle file,bool directory){
        const int size=65536;IntPtr memory=Marshal.AllocHGlobal(size);try{
            if(!GetFileInformationByHandleEx(file,7,memory,size)){if(directory&&Marshal.GetLastWin32Error()==38)return;throw new IOException("Staging streams cannot be verified");}
            if(directory||Marshal.ReadInt32(memory)!=0||Marshal.ReadInt32(memory,4)!=14||Marshal.PtrToStringUni(IntPtr.Add(memory,24),7)!="::$DATA")throw new IOException("Unknown staging stream retained");
        }finally{Marshal.FreeHGlobal(memory);}
    }
    private static Microsoft.Win32.SafeHandles.SafeFileHandle Open(string path,bool directory,bool deleting,bool writing=false){
        uint access=directory?0x001200a1U:0x80120080U;if(deleting)access|=0x10000U;if(writing)access|=0x40000000U;
        var file=CreateFile(path,access,directory?3U:1U,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
        try{if(file.IsInvalid)throw new IOException("Cannot pin staging object ("+Marshal.GetLastWin32Error()+")");IdentityOf(file,directory);Streams(file,directory);return file;}catch{file.Dispose();throw;}
    }
    private Microsoft.Win32.SafeHandles.SafeFileHandle NewRelative(Microsoft.Win32.SafeHandles.SafeFileHandle parent,string name,bool directory){
        if(string.IsNullOrEmpty(name)||name.Length>255||name!=Path.GetFileName(name)||name.IndexOfAny(new[]{'\\','/',':','\0'})>=0)throw new ArgumentException("Fixed staging basename required");
        IntPtr chars=Marshal.StringToHGlobalUni(name),text=IntPtr.Zero,descriptor=IntPtr.Zero;Microsoft.Win32.SafeHandles.SafeFileHandle file=null;
        try{
            var unicode=new UnicodeName{Length=checked((ushort)(name.Length*2)),MaximumLength=checked((ushort)(name.Length*2+2)),Buffer=chars};text=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeName)));Marshal.StructureToPtr(unicode,text,false);
            if(creationSecurity!=null){var bytes=creationSecurity(directory);if(bytes==null||bytes.Length<20||bytes.Length>65536)throw new UnauthorizedAccessException("Staging creation security unavailable");descriptor=Marshal.AllocHGlobal(bytes.Length);Marshal.Copy(bytes,0,descriptor,bytes.Length);}
            var attributes=new ObjectAttributes{Length=Marshal.SizeOf(typeof(ObjectAttributes)),RootDirectory=parent.DangerousGetHandle(),ObjectName=text,Attributes=0x40,SecurityDescriptor=descriptor};IoStatus status;
            int code=NtCreateFile(out file,directory?0x001300a1U:0xc0130080U,ref attributes,out status,IntPtr.Zero,0x80,directory?3U:0U,2,0x00201020U|(directory?1U:0x40U),IntPtr.Zero,0);
            if(code!=0)throw new IOException("Exclusive staging creation failed ("+RtlNtStatusToDosError(code)+")");IdentityOf(file,directory);Streams(file,directory);return file;
        }catch{if(file!=null)file.Dispose();throw;}finally{if(descriptor!=IntPtr.Zero)Marshal.FreeHGlobal(descriptor);if(text!=IntPtr.Zero)Marshal.FreeHGlobal(text);Marshal.FreeHGlobal(chars);}
    }
    private static void Disposition(Microsoft.Win32.SafeHandles.SafeFileHandle file,bool remove){
        if(remove){if(!SetFileInformationByHandle(file,4,new byte[]{1,0,0,0},4))throw new IOException("Staging disposition refused ("+Marshal.GetLastWin32Error()+")");}
        else{
            // FILE_DISPOSITION_ON_CLOSE without DELETE clears the creation-time
            // on-close state. Legacy FileDispositionInformation FALSE cannot.
            IoStatus status;int code=NtSetInformationFile(file,out status,BitConverter.GetBytes(8U),4,64);if(code!=0)throw new IOException("Staging on-close retention refused ("+RtlNtStatusToDosError(code)+")");
        }
    }
    private static void Rename(Microsoft.Win32.SafeHandles.SafeFileHandle file,Microsoft.Win32.SafeHandles.SafeFileHandle parent,string name){
        byte[] text=Encoding.Unicode.GetBytes(name);int rootOffset=IntPtr.Size==8?8:4,lengthOffset=rootOffset+IntPtr.Size,nameOffset=lengthOffset+4;var data=new byte[nameOffset+text.Length+2];
        Buffer.BlockCopy(IntPtr.Size==8?BitConverter.GetBytes(parent.DangerousGetHandle().ToInt64()):BitConverter.GetBytes(parent.DangerousGetHandle().ToInt32()),0,data,rootOffset,IntPtr.Size);Buffer.BlockCopy(BitConverter.GetBytes(text.Length),0,data,lengthOffset,4);Buffer.BlockCopy(text,0,data,nameOffset,text.Length);IoStatus status;
        int code=NtSetInformationFile(file,out status,data,(uint)data.Length,10);if(code!=0)throw new IOException("Staging publication refused ("+RtlNtStatusToDosError(code)+")");
    }
    private sealed class Pins:IDisposable {
        public readonly List<Microsoft.Win32.SafeHandles.SafeFileHandle> all=new List<Microsoft.Win32.SafeHandles.SafeFileHandle>();
        public Microsoft.Win32.SafeHandles.SafeFileHandle root;
        public void Dispose(){for(int i=all.Count-1;i>=0;i--)all[i].Dispose();}
    }
    private Pins PinRoot(){
        var pins=new Pins();try{var paths=new List<string>();for(string current=root;!string.IsNullOrEmpty(current);current=Path.GetDirectoryName(current))paths.Add(current);paths.Reverse();foreach(string current in paths){var file=Open(current,true,false);pins.all.Add(file);if(current==root){pins.root=file;validate(current,true);}}return pins;}catch{pins.Dispose();throw;}
    }
    private string ReceiptName(string id){Id(id);return "staging-owned-"+id+".frames";}
    private static string DirectoryName(string id,string operation){Id(id);Kind(operation);return operation+"-next-"+id;}
    private static void Append(FileStream file,Frame frame){
        byte[] data=Encoding.UTF8.GetBytes(Json().Serialize(frame));if(data.Length>FrameBound||file.Length+data.Length+36>ReceiptBound)throw new IOException("Staging receipt exceeds bound");
        byte[] hash;using(var digest=SHA256.Create())hash=digest.ComputeHash(data);file.Position=file.Length;byte[] length=BitConverter.GetBytes(data.Length);file.Write(length,0,4);file.Write(data,0,data.Length);file.Write(hash,0,hash.Length);file.Flush(true);
    }
    public MuOfflineSnapshotStore.IStagingWriter Begin(string path,string operation,string id){
        if(Path.GetFullPath(path)!=Path.Combine(root,DirectoryName(id,operation)))throw new ArgumentException("Staging producer path changed");
        var pins=PinRoot();Microsoft.Win32.SafeHandles.SafeFileHandle folder=null,receipt=null;FileStream stream=null;
        try{
            folder=NewRelative(pins.root,DirectoryName(id,operation),true);validate(path,true);
            receipt=NewRelative(pins.root,ReceiptName(id),false);stream=new FileStream(receipt,FileAccess.ReadWrite);receipt=null;validate(Path.Combine(root,ReceiptName(id)),false);
            var begin=new Frame{version=1,type="begin",id=id,environmentId=environmentId,operation=operation,authority=authority,root=IdentityOf(pins.root,true),directory=IdentityOf(folder,true)};
            Append(stream,begin);Disposition(stream.SafeFileHandle,false);progress("staging-begin-durable");Disposition(folder,false);
            return new Writer(this,pins,folder,stream,path,begin);
        }catch{if(stream!=null)stream.Dispose();if(receipt!=null)receipt.Dispose();if(folder!=null)folder.Dispose();pins.Dispose();throw;}
    }
    private sealed class Writer:MuOfflineSnapshotStore.IStagingWriter {
        private readonly MuSnapshotStaging owner;private readonly Pins pins;private readonly Microsoft.Win32.SafeHandles.SafeFileHandle directory;private readonly FileStream receipt;private readonly string path;private readonly Frame begin;
        private readonly List<OwnedFile> files=new List<OwnedFile>();private bool disposed,published;
        public Writer(MuSnapshotStaging owner,Pins pins,Microsoft.Win32.SafeHandles.SafeFileHandle directory,FileStream receipt,string path,Frame begin){this.owner=owner;this.pins=pins;this.directory=directory;this.receipt=receipt;this.path=path;this.begin=begin;}
        public FileStream OpenNew(string file){
            if(disposed||published||Path.GetDirectoryName(file)!=path)throw new IOException("Staging writer no longer owns this target");
            string name=Path.GetFileName(file),role=Role(begin.operation,name);if(files.Any(entry=>entry.role==role))throw new IOException("Staging role already allocated");
            owner.validate(path,true);if(!Same(begin.directory,IdentityOf(directory,true))||!Same(begin.root,IdentityOf(pins.root,true)))throw new IOException("Staging namespace changed");
            Microsoft.Win32.SafeHandles.SafeFileHandle handle=null;try{
                handle=owner.NewRelative(directory,name,false);owner.validate(file,false);var entry=new OwnedFile{name=name,role=role,identity=IdentityOf(handle,false)};
                Append(receipt,new Frame{version=1,type="file",file=entry});owner.progress("staging-file-durable-"+role);Disposition(handle,false);files.Add(entry);var stream=new FileStream(handle,FileAccess.Write,1048576);handle=null;return stream;
            }finally{if(handle!=null)handle.Dispose();}
        }
        public void Publish(string destination){
            string expected=Path.Combine(owner.root,begin.operation=="create"?begin.id:"restore-active");if(disposed||published||Path.GetFullPath(destination)!=expected||files.Count!=3)throw new IOException("Staging publication target changed");
            owner.VerifyFiles(path,files,null,CancellationToken.None,null);owner.validate(path,true);Rename(directory,pins.root,Path.GetFileName(expected));published=true;owner.progress("staging-directory-published");Append(receipt,new Frame{version=1,type="published"});Rename(receipt.SafeFileHandle,pins.root,"staging-published-"+begin.id+".frames");
        }
        public void Dispose(){if(disposed)return;disposed=true;try{receipt.Dispose();}finally{try{directory.Dispose();}finally{pins.Dispose();}}}
    }
    private static string Role(string operation,string name){
        Kind(operation);if(name==(operation=="create"?"disk.vhdx":"disk.next"))return "disk";if(name==(operation=="create"?"seed.iso":"seed.next"))return "seed";
        string metadata=operation=="create"?"manifest.json":"journal.json";
        if(System.Text.RegularExpressions.Regex.IsMatch(name,"^"+System.Text.RegularExpressions.Regex.Escape(metadata)+@"\.[a-f0-9]{32}\.next$"))return "metadata";
        throw new InvalidDataException("Unregistered staging output name");
    }
    // Review and deletion below pin every original object before the first
    // disposition. They never infer ownership from the directory prefix.
    private sealed class HeldFile:IDisposable {
        public string name;public Microsoft.Win32.SafeHandles.SafeFileHandle handle;public SealedFile value;
        public void Dispose(){handle.Dispose();}
    }
    private static string Alternate(OwnedFile file,string operation){return file.role=="metadata"?(operation=="create"?"manifest.json":"journal.json"):file.name;}
    private static long Bound(string role){return role=="disk"?260L*1024*1024*1024:role=="seed"?8L*1024*1024:2L*1024*1024;}
    private static SealedFile Facts(string name,Microsoft.Win32.SafeHandles.SafeFileHandle handle){
        var info=Info(handle);long length=checked(((long)BitConverter.ToUInt32(info,32)<<32)|BitConverter.ToUInt32(info,36));
        return new SealedFile{name=name,identity=IdentityOf(handle,false),bytes=length,modified=BitConverter.ToUInt64(info,20).ToString(System.Globalization.CultureInfo.InvariantCulture)};
    }
    private static bool SameFacts(SealedFile a,SealedFile b){return a!=null&&b!=null&&a.name==b.name&&a.bytes==b.bytes&&a.modified==b.modified&&Same(a.identity,b.identity);}
    private SealedFile[] VerifyFiles(string directory,IEnumerable<OwnedFile> source,SealedFile[] plan,CancellationToken cancel,List<HeldFile> keep){
        var owned=source.ToArray();string operation=Path.GetFileName(directory).StartsWith("create-next-",StringComparison.Ordinal)?"create":"restore";
        if(owned.Length>3||owned.Select(entry=>entry.role).Distinct().Count()!=owned.Length)throw new InvalidDataException("Staging producer roles changed");
        var allowed=new Dictionary<string,OwnedFile>(StringComparer.Ordinal);
        foreach(var file in owned){if(Role(operation,file.name)!=file.role)throw new InvalidDataException("Staging original role changed");IdentityValid(file.identity);allowed.Add(file.name,file);string alternative=Alternate(file,operation);if(alternative!=file.name)allowed.Add(alternative,file);}
        var names=Directory.EnumerateFileSystemEntries(directory).Take(4).Select(Path.GetFileName).ToArray();
        if(names.Length>3||names.Any(name=>!allowed.ContainsKey(name))||names.Select(name=>allowed[name].role).Distinct().Count()!=names.Length)throw new IOException("Unregistered staging contents retained");
        var result=new List<SealedFile>();try{foreach(string name in names.OrderBy(value=>value,StringComparer.Ordinal)){
            cancel.ThrowIfCancellationRequested();string path=Path.Combine(directory,name);var handle=Open(path,false,true);var held=new HeldFile{name=name,handle=handle};
            try{validate(path,false);var file=Facts(name,handle);if(!Same(file.identity,allowed[name].identity)||file.bytes<0||file.bytes>Bound(allowed[name].role))throw new IOException("Original staging file changed");
                if(plan!=null){var previous=plan.SingleOrDefault(entry=>entry.name==name);if(!SameFacts(file,previous))throw new IOException("Reviewed staging file changed");}
                result.Add(file);held.value=file;if(keep!=null){keep.Add(held);held=null;}
            }finally{if(held!=null)held.Dispose();}
        }return result.ToArray();}catch{throw;}
    }
    private static void Fields(Dictionary<string,object> value,params string[] names){if(value==null||value.Count!=names.Length||value.Keys.Any(key=>!names.Contains(key)))throw new InvalidDataException("Staging receipt fields changed");}
    private static void OriginalFields(object value){var raw=value as Dictionary<string,object>;Fields(raw,"fileId","birthFileTime");if(!(raw["fileId"] is string)||!(raw["birthFileTime"] is string))throw new InvalidDataException("Staging identity types changed");}
    private Frame ParseFrame(byte[] data){
        var raw=Json().DeserializeObject(new UTF8Encoding(false,true).GetString(data)) as Dictionary<string,object>;Fields(raw,"version","type","id","environmentId","operation","authority","root","directory","file","inventory");
        if(!(raw["version"] is int)||(int)raw["version"]!=1||!(raw["type"] is string))throw new InvalidDataException("Staging frame types changed");
        foreach(string key in new[]{"id","environmentId","operation","authority"})if(raw[key]!=null&&!(raw[key] is string))throw new InvalidDataException("Staging receipt text type changed");
        foreach(string key in new[]{"root","directory"})if(raw[key]!=null)OriginalFields(raw[key]);
        if(raw["file"]!=null){var file=raw["file"] as Dictionary<string,object>;Fields(file,"name","role","identity");if(!(file["name"] is string)||!(file["role"] is string))throw new InvalidDataException("Staging file types changed");OriginalFields(file["identity"]);}
        if(raw["inventory"]!=null){var inventory=raw["inventory"] as System.Collections.IList;if(inventory==null||inventory.Count>3)throw new InvalidDataException("Staging deletion inventory bound changed");foreach(var item in inventory){var file=item as Dictionary<string,object>;Fields(file,"name","modified","bytes","identity");if(!(file["name"] is string)||!(file["modified"] is string)||!(file["bytes"] is int)&&!(file["bytes"] is long))throw new InvalidDataException("Staging deletion entry types changed");OriginalFields(file["identity"]);}}
        return Json().ConvertToType<Frame>(raw);
    }
    private Journal ReadJournal(FileStream receipt,string id,string operation,Identity rootIdentity){
        if(receipt.Length<36||receipt.Length>ReceiptBound)throw new InvalidDataException("Staging receipt bound changed");
        receipt.Position=0;byte[] bytes=new byte[(int)receipt.Length];int offset=0,n;while(offset<bytes.Length&&(n=receipt.Read(bytes,offset,bytes.Length-offset))>0)offset+=n;if(offset!=bytes.Length)throw new IOException("Staging receipt shortened");
        var journal=new Journal();using(var hash=SHA256.Create())journal.fingerprint=BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
        int cursor=0,frames=0;while(cursor<bytes.Length){
            if(bytes.Length-cursor<4){journal.partial=true;break;}int length=BitConverter.ToInt32(bytes,cursor);if(length<2||length>FrameBound)throw new InvalidDataException("Staging frame length changed");
            if(bytes.Length-cursor<length+36){journal.partial=true;break;}var data=new byte[length];Buffer.BlockCopy(bytes,cursor+4,data,0,length);byte[] digest;using(var hash=SHA256.Create())digest=hash.ComputeHash(data);if(!digest.SequenceEqual(bytes.Skip(cursor+4+length).Take(32)))throw new InvalidDataException("Staging receipt digest changed");
            if(++frames>6)throw new InvalidDataException("Staging frame count changed");var frame=ParseFrame(data);
            if(journal.begin==null){
                if(frame.type!="begin"||frame.file!=null||frame.inventory!=null||frame.id!=id||frame.environmentId!=environmentId||frame.operation!=operation||frame.authority!=authority||!Same(frame.root,rootIdentity))throw new InvalidDataException("Staging original authority changed");IdentityValid(frame.directory);journal.begin=frame;
            }else{
                if(frame.id!=null||frame.environmentId!=null||frame.operation!=null||frame.authority!=null||frame.root!=null||frame.directory!=null||journal.done||journal.published)throw new InvalidDataException("Staging frame transition changed");
                if(frame.type=="file"){
                    if(frame.file==null||frame.inventory!=null||journal.plan!=null||journal.files.Count>=3||Role(operation,frame.file.name)!=frame.file.role||journal.files.Any(file=>file.role==frame.file.role))throw new InvalidDataException("Staging file registration changed");IdentityValid(frame.file.identity);if(journal.files.Any(file=>Same(file.identity,frame.file.identity)))throw new InvalidDataException("Duplicate staging original object");journal.files.Add(frame.file);
                }else if(frame.type=="published"){
                    if(frame.file!=null||frame.inventory!=null||journal.plan!=null||journal.files.Count!=3)throw new InvalidDataException("Staging publication transition changed");journal.published=true;
                }else if(frame.type=="delete"){
                    if(frame.file!=null||frame.inventory==null||journal.plan!=null||frame.inventory.Select(file=>file.name).Distinct().Count()!=frame.inventory.Length)throw new InvalidDataException("Staging deletion transition changed");
                    foreach(var file in frame.inventory){var original=journal.files.SingleOrDefault(value=>file.name==value.name||file.name==Alternate(value,operation));ulong modified;if(original==null||!Same(original.identity,file.identity)||file.bytes<0||file.bytes>Bound(original.role)||!ulong.TryParse(file.modified,out modified))throw new InvalidDataException("Staging deletion original changed");}journal.plan=frame.inventory;
                }else if(frame.type=="done"){
                    if(frame.file!=null||frame.inventory!=null||journal.plan==null)throw new InvalidDataException("Staging completion transition changed");journal.done=true;
                }else throw new InvalidDataException("Unknown staging receipt frame");
            }
            cursor+=length+36;journal.validLength=cursor;
        }
        if(journal.begin==null)throw new InvalidDataException("Staging original creation receipt missing");return journal;
    }
    private string CleanupName(string id,string operation){return "staging-cleanup-"+operation+"-"+id+".frames";}
    private sealed class Scope:IDisposable {
        public Pins pins;public Microsoft.Win32.SafeHandles.SafeFileHandle directory;public FileStream receipt;public string path,receiptName;public Journal journal;public SealedFile[] inventory;
        public readonly List<HeldFile> files=new List<HeldFile>();
        public void Dispose(){for(int i=files.Count-1;i>=0;i--)files[i].Dispose();try{if(directory!=null)directory.Dispose();}finally{try{if(receipt!=null)receipt.Dispose();}finally{if(pins!=null)pins.Dispose();}}}
    }
    private Scope Inspect(string id,string operation,bool writing,CancellationToken cancel){
        Id(id);Kind(operation);cancel.ThrowIfCancellationRequested();if(Exists(Path.Combine(root,"restore-active")))throw new InvalidOperationException("Resolve the pending snapshot restore before staging cleanup");
        var scope=new Scope{path=Path.Combine(root,DirectoryName(id,operation))};try{
            scope.pins=PinRoot();var names=new[]{ReceiptName(id),CleanupName(id,operation),"staging-done-"+id+".frames"}.Where(name=>Exists(Path.Combine(root,name))).ToArray();
            if(names.Length!=1)throw new InvalidDataException("Unique original staging receipt required; legacy files retained");scope.receiptName=names[0];string receiptPath=Path.Combine(root,names[0]);
            var receipt=Open(receiptPath,false,writing,writing);scope.receipt=new FileStream(receipt,writing?FileAccess.ReadWrite:FileAccess.Read);validate(receiptPath,false);scope.journal=ReadJournal(scope.receipt,id,operation,IdentityOf(scope.pins.root,true));
            var journal=scope.journal;if(journal.published)throw new InvalidOperationException("Published snapshot data cannot be staging-cleaned");
            if(scope.receiptName.StartsWith("staging-cleanup-",StringComparison.Ordinal)&&journal.plan==null||scope.receiptName.StartsWith("staging-done-",StringComparison.Ordinal)&&!journal.done)throw new InvalidDataException("Staging cleanup receipt phase changed");
            if(Exists(scope.path)){
                if(journal.done)throw new InvalidDataException("Completed staging path reappeared; preserved");scope.directory=Open(scope.path,true,true);validate(scope.path,true);if(!Same(journal.begin.directory,IdentityOf(scope.directory,true)))throw new IOException("Original staging directory replaced");
                scope.inventory=VerifyFiles(scope.path,journal.files,journal.plan,cancel,scope.files);
            }else{
                if(Exists(Path.Combine(root,id))||Exists(Path.Combine(root,"restore-history",id))||journal.plan==null&&journal.files.Count!=0)throw new IOException("Original staging directory is absent or published; preserved without guessing");
                scope.inventory=new SealedFile[0];
            }
            return scope;
        }catch{scope.Dispose();throw;}
    }
    private Review Value(Scope scope){
        var journal=scope.journal;string text=Json().Serialize(new{authority=authority,root=journal.begin.root,directory=journal.begin.directory,receipt=journal.fingerprint,present=scope.directory!=null,inventory=scope.inventory});string token;using(var sha=SHA256.Create())token=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-","").ToLowerInvariant();
        return new Review{id=journal.begin.id,operation=journal.begin.operation,phase=journal.done?"done":journal.plan!=null?"deleting":"copy",token=token,bytes=scope.inventory.Sum(file=>file.bytes),files=scope.inventory.Length,partialReceipt=journal.partial};
    }
    public Review Inspect(string id,string operation,CancellationToken cancel,Action guard=null){using(var scope=Inspect(id,operation,false,cancel)){if(guard!=null)guard();cancel.ThrowIfCancellationRequested();return Value(scope);}}
    public sealed class CleanupReceipt {public bool deleted,alreadyDeleted;public string id,operation;public long bytes;}
    public CleanupReceipt Cleanup(string id,string operation,string token,bool resumeOnly,Action guard,CancellationToken cancel){
        Digest(token);if(guard==null)throw new ArgumentNullException("guard");using(var scope=Inspect(id,operation,true,cancel)){
            var journal=scope.journal;var review=Value(scope);if(review.token!=token)throw new IOException("Staging review changed; inspect again before cleanup");
            if(resumeOnly&&journal.plan==null)throw new IOException("No existing staging deletion to resume");
            if(journal.done){
                guard();cancel.ThrowIfCancellationRequested();if(journal.partial){scope.receipt.SetLength(journal.validLength);scope.receipt.Flush(true);}
                if(scope.receiptName!="staging-done-"+id+".frames")Rename(scope.receipt.SafeFileHandle,scope.pins.root,"staging-done-"+id+".frames");
                return new CleanupReceipt{deleted=true,alreadyDeleted=true,id=id,operation=operation,bytes=0};
            }
            guard();cancel.ThrowIfCancellationRequested();if(journal.partial){scope.receipt.SetLength(journal.validLength);scope.receipt.Flush(true);}
            if(journal.plan==null){Append(scope.receipt,new Frame{version=1,type="delete",inventory=scope.inventory});journal.plan=scope.inventory;progress("staging-delete-planned");}
            string cleanupName=CleanupName(id,operation);if(scope.receiptName!=cleanupName){Rename(scope.receipt.SafeFileHandle,scope.pins.root,cleanupName);scope.receiptName=cleanupName;progress("staging-delete-registered");}
            foreach(var file in scope.files){
                guard();cancel.ThrowIfCancellationRequested();VerifyRemaining(scope);Streams(file.handle,false);if(!SameFacts(Facts(file.name,file.handle),file.value))throw new IOException("Pinned staging file changed before deletion");
                Disposition(file.handle,true);file.Dispose();progress("staging-deleted-"+file.name);
            }
            guard();cancel.ThrowIfCancellationRequested();if(scope.directory!=null){Streams(scope.directory,true);if(Directory.EnumerateFileSystemEntries(scope.path).Take(1).Any())throw new IOException("Unregistered staging contents retained after cleanup");Disposition(scope.directory,true);scope.directory.Dispose();scope.directory=null;progress("staging-directory-removed");}
            guard();cancel.ThrowIfCancellationRequested();Append(scope.receipt,new Frame{version=1,type="done"});progress("staging-delete-done-durable");Rename(scope.receipt.SafeFileHandle,scope.pins.root,"staging-done-"+id+".frames");progress("staging-cleanup-complete");
            return new CleanupReceipt{deleted=true,alreadyDeleted=false,id=id,operation=operation,bytes=review.bytes};
        }
    }
    private void VerifyRemaining(Scope scope){
        if(scope.directory==null)throw new IOException("Original staging directory missing during cleanup");validate(scope.path,true);Streams(scope.directory,true);if(!Same(scope.journal.begin.directory,IdentityOf(scope.directory,true)))throw new IOException("Pinned staging directory changed");
        var remaining=scope.files.Where(file=>!file.handle.IsClosed).Select(file=>file.name).OrderBy(name=>name,StringComparer.Ordinal).ToArray();var actual=Directory.EnumerateFileSystemEntries(scope.path).Take(4).Select(Path.GetFileName).OrderBy(name=>name,StringComparer.Ordinal).ToArray();if(!actual.SequenceEqual(remaining))throw new IOException("Unregistered staging content retained before deletion");
    }
    public string[] Pending(){
        using(var pins=PinRoot()){
            var names=Directory.EnumerateFileSystemEntries(root,"staging-cleanup-*").Take(33).Select(Path.GetFileName).ToArray();if(names.Length>32)throw new InvalidDataException("Staging cleanup receipt inventory exceeds bound");var result=new List<string>();
            foreach(string name in names){var match=System.Text.RegularExpressions.Regex.Match(name,@"^staging-cleanup-(create|restore)-([a-f0-9-]{36})\.frames$");if(!match.Success)throw new InvalidDataException("Unrecognized staging cleanup receipt retained");string operation=match.Groups[1].Value,id=match.Groups[2].Value;Id(id);string file=Path.Combine(root,name);using(var handle=Open(file,false,false))using(var stream=new FileStream(handle,FileAccess.Read)){validate(file,false);var journal=ReadJournal(stream,id,operation,IdentityOf(pins.root,true));if(journal.plan==null||journal.published)throw new InvalidDataException("Staging cleanup phase differs from its receipt name");result.Add(DirectoryName(id,operation));}}
            return result.ToArray();
        }
    }
}
