using System;
using System.IO;
using System.Linq;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Diagnostics;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Ordinary-token cleanup of an authenticated, producer-sealed staging receipt.
// Hold ancestors/directories against rename and files against writes throughout
// verification; delete the verified objects by handle, never by a reopened path.
public static class MuBackupCleanup {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle,[Out]byte[] info);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,byte[] data,uint size);
    [StructLayout(LayoutKind.Sequential)] private struct ProcessBasicInformation {public IntPtr Reserved1,Peb,Reserved2,Reserved3,Pid,ParentPid;}
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr process,int kind,out ProcessBasicInformation information,int size,out int returned);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int kind,IntPtr data,uint size);
    private static Process Owner;
    public static string ApplyOwnedJson(string input,int ownerPid,string ownerStarted){return ApplyOwnedJson(input,ownerPid,ownerStarted,null);}
    public static string ApplyOwnedJson(string input,int ownerPid,string ownerStarted,Action<string> progress){
        var helper=Process.GetCurrentProcess();ProcessBasicInformation information;int returned;
        if(ownerPid<1||NtQueryInformationProcess(helper.Handle,0,out information,Marshal.SizeOf(typeof(ProcessBasicInformation)),out returned)!=0||information.ParentPid.ToInt64()!=ownerPid)throw new IOException("Cleanup must bind its current controller");
        var parent=Process.GetProcessById(ownerPid);
        try{
            IntPtr handle=parent.Handle;long created,exited,kernel,user;
            // The controller captures its creation ticks before spawning us.
            // Match the fixed process object even if the wall clock moved or
            // the original PID was reused after this helper was created.
            if(!Regex.IsMatch(ownerStarted??"",@"^[0-9]{1,24}$")||!GetProcessTimes(handle,out created,out exited,out kernel,out user)||checked(created+504911232000000000L).ToString(CultureInfo.InvariantCulture)!=ownerStarted||parent.HasExited)throw new IOException("Cleanup controller exited or was replaced");
            Owner=parent;
            var monitor=new Thread(()=>{uint status=WaitForSingleObject(handle,0xffffffff);if(status!=0x102)Environment.Exit(137);});monitor.IsBackground=true;monitor.Start();
            // Keep this handle alive until the short-lived helper exits. Closing
            // it on a normal return would race the waiter and its JSON reply.
            return ApplyJson(input,progress);
        }catch{if(Owner==null)parent.Dispose();throw;}
    }
    private sealed class Item:IDisposable {
        public string Relative;public bool Directory;public SafeFileHandle Handle;public FileStream Stream;
        public void Dispose(){if(Stream!=null)Stream.Dispose();else if(Handle!=null)Handle.Dispose();}
    }
    private static void Fields(Dictionary<string,object> value,params string[] names){if(value==null||value.Count!=names.Length||value.Keys.Any(k=>!names.Contains(k)))throw new InvalidDataException("Cleanup receipt fields changed");}
    private static string Text(Dictionary<string,object> value,string key){object raw;if(!value.TryGetValue(key,out raw)||!(raw is string))throw new InvalidDataException("Cleanup receipt string required");return (string)raw;}
    private static string Decimal(Dictionary<string,object> value,string key){string result=Text(value,key);if(!Regex.IsMatch(result,@"^\d{1,24}$"))throw new InvalidDataException("Cleanup numeric identity changed");return result;}
    private static byte[] Info(SafeFileHandle handle){var bytes=new byte[52];if(!GetFileInformationByHandle(handle,bytes))throw new IOException("Cannot inspect cleanup handle");return bytes;}
    private static void Streams(SafeFileHandle handle,bool directory){
        const int capacity=65536;IntPtr memory=Marshal.AllocHGlobal(capacity);
        try{
            if(!GetFileInformationByHandleEx(handle,7,memory,capacity)){if(directory&&Marshal.GetLastWin32Error()==38)return;throw new IOException("Cannot verify cleanup data streams");}
            int offset=0,count=0;
            for(;;){if(offset<0||offset>capacity-24||++count>2)throw new IOException("Unexpected cleanup data streams retained");int next=Marshal.ReadInt32(memory,offset),length=Marshal.ReadInt32(memory,offset+4);if(length<0||length%2!=0||length>capacity-offset-24)throw new IOException("Cleanup stream inventory rejected");string name=Marshal.PtrToStringUni(IntPtr.Add(memory,offset+24),length/2);if(name!="::$DATA"||directory||count!=1)throw new IOException("Unknown cleanup data stream retained");if(next==0)break;if(next<24||next>capacity-offset)throw new IOException("Cleanup stream inventory rejected");offset+=next;}
        }finally{Marshal.FreeHGlobal(memory);}
    }
    private static string Nanos(byte[] info,int offset){return ((decimal)BitConverter.ToUInt64(info,offset)-116444736000000000m).ToString("0",CultureInfo.InvariantCulture)+"00";}
    private static void Identity(Dictionary<string,object> expected,byte[] actual,bool directory){
        var attributes=(FileAttributes)BitConverter.ToUInt32(actual,0);
        if((attributes&FileAttributes.ReparsePoint)!=0||((attributes&FileAttributes.Directory)!=0)!=directory||!directory&&BitConverter.ToUInt32(actual,40)!=1)throw new IOException("Cleanup link or entry type changed");
        ulong index=((ulong)BitConverter.ToUInt32(actual,44)<<32)|BitConverter.ToUInt32(actual,48);
        if(Decimal(expected,"dev")!=BitConverter.ToUInt32(actual,28).ToString(CultureInfo.InvariantCulture)||Decimal(expected,"ino")!=index.ToString(CultureInfo.InvariantCulture)||Decimal(expected,"birthtimeNs")!=Nanos(actual,4))throw new IOException("Cleanup original file identity changed");
    }
    private static SafeFileHandle Pin(string file,bool directory,bool deleting){
        var handle=CreateFile(file,(directory?0x81U:0x80000080U)|(deleting?0x10000U:0U),directory?3U:1U,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
        if(handle.IsInvalid){handle.Dispose();throw new IOException("Cannot pin cleanup entry");}return handle;
    }
    private static bool Exists(string file){try{File.GetAttributes(file);return true;}catch(FileNotFoundException){return false;}catch(DirectoryNotFoundException){return false;}}
    private static void Relative(string value){
        if(value=="")return;
        if(value.Length>256||value.Contains("\\")||value.StartsWith("/")||value.Split('/').Any(p=>p==""||p=="."||p==".."||p.EndsWith(".")||p.EndsWith(" "))||Regex.IsMatch(value,@"[\x00-\x1f<>:""|?*]"))throw new InvalidDataException("Cleanup relative path rejected");
        var parts=value.Split('/');var leaves=new[]{"backup-restore.json","management","management.pub","host-ed25519","host-ed25519.pub","known_hosts","seed.iso","allocation.json"};
        if(parts.Length==1&&(new[]{"disk.vhdx","management-check","host-check"}.Contains(value)||Regex.IsMatch(value,@"^mu-win-[a-f0-9]{32}$")))return;
        if(parts.Length==2&&Regex.IsMatch(parts[0],@"^mu-win-[a-f0-9]{32}$")&&leaves.Contains(parts[1]))return;
        throw new InvalidDataException("Cleanup producer path rejected");
    }
    private static void Delete(Item item){if(Owner!=null&&Owner.HasExited)throw new IOException("Cleanup controller exited");Streams(item.Handle,item.Directory);if(!SetFileInformationByHandle(item.Handle,4,new byte[]{1,0,0,0},4))throw new IOException("Cleanup entry remains in use or directory is not empty");item.Dispose();}
    public static string ApplyJson(string input){return ApplyJson(input,null);}
    public static string ApplyJson(string input,Action<string> progress){
        if(input==null||Encoding.UTF8.GetByteCount(input)>65536)throw new InvalidDataException("Cleanup receipt exceeds bound");
        var json=new JavaScriptSerializer{MaxJsonLength=65536,RecursionLimit=8};var raw=json.DeserializeObject(input) as Dictionary<string,object>;Fields(raw,"root","directory","ancestors","entries");
        string root=Text(raw,"root"),directory=Text(raw,"directory");
        if(!Regex.IsMatch(root,@"^[A-Za-z]:\\")||Path.GetFullPath(root).TrimEnd('\\')!=root||new DriveInfo(Path.GetPathRoot(root)).DriveType==DriveType.Network||Path.GetDirectoryName(directory)!=root||Path.GetFullPath(directory)!=directory||!Regex.IsMatch(Path.GetFileName(directory),@"^backup-work-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"))throw new InvalidDataException("Cleanup fixed local boundary rejected");
        var ancestors=raw["ancestors"] as IList;var entries=raw["entries"] as IList;if(ancestors==null||ancestors.Count<1||ancestors.Count>64||entries==null||entries.Count<1||entries.Count>32)throw new InvalidDataException("Cleanup receipt bound changed");
        var expected=new Dictionary<string,Dictionary<string,object>>(StringComparer.OrdinalIgnoreCase);var pins=new List<SafeFileHandle>();var held=new List<Item>();
        try{
            var parents=new Dictionary<string,Dictionary<string,object>>(StringComparer.OrdinalIgnoreCase);
            foreach(var item in ancestors){var entry=item as Dictionary<string,object>;Fields(entry,"path","dev","ino","birthtimeNs");if(parents.ContainsKey(Text(entry,"path")))throw new InvalidDataException("Cleanup duplicate ancestor");parents.Add(Text(entry,"path"),entry);}
            var sequence=new List<string>();string cursor=root;for(;;){sequence.Add(cursor);string parent=Path.GetDirectoryName(cursor);if(string.IsNullOrEmpty(parent))break;cursor=parent;}sequence.Reverse();
            if(sequence.Count!=parents.Count)throw new InvalidDataException("Cleanup ancestor receipt incomplete");
            foreach(string parent in sequence){Dictionary<string,object> entry;if(!parents.TryGetValue(parent,out entry))throw new InvalidDataException("Cleanup ancestor receipt mismatch");var pin=Pin(parent,true,false);pins.Add(pin);Identity(entry,Info(pin),true);}
            foreach(var item in entries){var entry=item as Dictionary<string,object>;string relative=Text(entry,"path"),kind=Text(entry,"kind");Relative(relative);if(kind=="directory")Fields(entry,"path","kind","dev","ino","birthtimeNs");else if(kind=="file"){Fields(entry,"path","kind","dev","ino","birthtimeNs","bytes","mtimeNs","sha256");Decimal(entry,"bytes");Decimal(entry,"mtimeNs");if(!Regex.IsMatch(Text(entry,"sha256"),@"^[a-f0-9]{64}$"))throw new InvalidDataException("Cleanup file digest rejected");}else throw new InvalidDataException("Cleanup entry kind rejected");if(expected.ContainsKey(relative))throw new InvalidDataException("Cleanup duplicate path");expected.Add(relative,entry);}
            if(!expected.ContainsKey("")||Text(expected[""],"kind")!="directory")throw new InvalidDataException("Cleanup root receipt required");
            foreach(var pair in expected)if((Text(pair.Value,"kind")=="directory")!=(pair.Key==""||Regex.IsMatch(pair.Key,@"^mu-win-[a-f0-9]{32}$")))throw new InvalidDataException("Cleanup producer entry type rejected");
            foreach(string relative in expected.Keys.Where(v=>v!="")){string parent=relative.Contains('/')?relative.Substring(0,relative.LastIndexOf('/')):"";if(!expected.ContainsKey(parent)||Text(expected[parent],"kind")!="directory")throw new InvalidDataException("Cleanup parent receipt incomplete");}
            if(!Exists(directory))return json.Serialize(new{removed=true});
            Action<string,string> visit=null;visit=(file,relative)=>{
                Dictionary<string,object> entry;if(!expected.TryGetValue(relative,out entry))throw new IOException("Unknown cleanup content retained");bool isDirectory=Text(entry,"kind")=="directory";
                var handle=Pin(file,isDirectory,true);var node=new Item{Relative=relative,Directory=isDirectory,Handle=handle};held.Add(node);var info=Info(handle);Identity(entry,info,isDirectory);Streams(handle,isDirectory);
                if(isDirectory){foreach(string child in Directory.EnumerateFileSystemEntries(file))visit(child,relative==""?Path.GetFileName(child):relative+"/"+Path.GetFileName(child));}
                else{
                    node.Stream=new FileStream(handle,FileAccess.Read);if(node.Stream.Length.ToString(CultureInfo.InvariantCulture)!=Text(entry,"bytes")||Nanos(info,20)!=Text(entry,"mtimeNs"))throw new IOException("Cleanup file metadata changed");
                    using(var hash=SHA256.Create())if(BitConverter.ToString(hash.ComputeHash(node.Stream)).Replace("-","").ToLowerInvariant()!=Text(entry,"sha256"))throw new IOException("Cleanup producer bytes changed");Identity(entry,Info(handle),false);
                }
            };
            visit(directory,"");if(progress!=null)progress("verified");
            foreach(var node in held.Where(n=>!n.Directory)){Delete(node);if(progress!=null)progress("deleted-"+node.Relative);}
            foreach(var node in held.Where(n=>n.Directory).OrderByDescending(n=>n.Relative.Length)){Delete(node);if(progress!=null)progress("deleted-"+node.Relative);}
            return json.Serialize(new{removed=true});
        }finally{for(int i=held.Count-1;i>=0;i--)held[i].Dispose();for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}
    }
}
