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

// Ordinary-token publication of one authenticated producer-owned ciphertext.
// The original file handle is renamed without replacement; no hard-link alias
// is created, and cleanup can remove only the original temporary file object.
public static class MuBackupOutput {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle,[Out]byte[] info);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int kind,IntPtr data,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,byte[] data,uint size);
    [StructLayout(LayoutKind.Sequential)] private struct IoStatusBlock {public IntPtr Status;public UIntPtr Information;}
    [DllImport("ntdll.dll")] private static extern int NtSetInformationFile(SafeFileHandle handle,out IoStatusBlock status,byte[] information,uint length,int kind);
    [DllImport("ntdll.dll")] private static extern uint RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,StringBuilder path,uint capacity,uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle,StringBuilder label,uint labelSize,out uint serial,out uint maximumComponent,out uint flags,StringBuilder fileSystem,uint fileSystemSize);
    [StructLayout(LayoutKind.Sequential)] private struct ProcessBasicInformation {public IntPtr Reserved1,Peb,Reserved2,Reserved3,Pid,ParentPid;}
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr process,int kind,out ProcessBasicInformation information,int size,out int returned);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
    private static Process Owner;
    public static string ApplyOwnedJson(string input,string mode,int ownerPid,string ownerStarted){return ApplyOwnedJson(input,mode,ownerPid,ownerStarted,null);}
    public static string ApplyOwnedJson(string input,string mode,int ownerPid,string ownerStarted,Action<string> progress){
        var helper=Process.GetCurrentProcess();ProcessBasicInformation information;int returned;
        if(ownerPid<1||NtQueryInformationProcess(helper.Handle,0,out information,Marshal.SizeOf(typeof(ProcessBasicInformation)),out returned)!=0||information.ParentPid.ToInt64()!=ownerPid)throw new IOException("Output helper must bind its current controller");
        var parent=Process.GetProcessById(ownerPid);
        try{
            IntPtr handle=parent.Handle;long created,exited,kernel,user;
            if(!Regex.IsMatch(ownerStarted??"",@"^[0-9]{1,24}$")||!GetProcessTimes(handle,out created,out exited,out kernel,out user)||checked(created+504911232000000000L).ToString(CultureInfo.InvariantCulture)!=ownerStarted||parent.HasExited)throw new IOException("Output controller exited or was replaced");
            Owner=parent;var monitor=new Thread(()=>{uint status=WaitForSingleObject(handle,0xffffffff);if(status!=0x102)Environment.Exit(137);});monitor.IsBackground=true;monitor.Start();
            return ApplyJson(input,mode,progress);
        }catch{if(Owner==null)parent.Dispose();throw;}
    }
    private static void Live(){if(Owner!=null&&Owner.HasExited)throw new IOException("Output controller exited");}
    private static void Fields(Dictionary<string,object> value,params string[] names){if(value==null||value.Count!=names.Length||value.Keys.Any(k=>!names.Contains(k)))throw new InvalidDataException("Output receipt fields changed");}
    private static string Text(Dictionary<string,object> value,string key){object raw;if(!value.TryGetValue(key,out raw)||!(raw is string))throw new InvalidDataException("Output receipt string required");return (string)raw;}
    private static string Decimal(Dictionary<string,object> value,string key){string result=Text(value,key);if(!Regex.IsMatch(result,@"^\d{1,24}$"))throw new InvalidDataException("Output numeric identity rejected");return result;}
    private static byte[] Info(SafeFileHandle handle){var bytes=new byte[52];if(!GetFileInformationByHandle(handle,bytes))throw new IOException("Cannot inspect output handle");return bytes;}
    private static string Nanos(byte[] info,int offset){return ((decimal)BitConverter.ToUInt64(info,offset)-116444736000000000m).ToString("0",CultureInfo.InvariantCulture)+"00";}
    private static bool Identity(Dictionary<string,object> expected,byte[] actual,bool directory){
        var attributes=(FileAttributes)BitConverter.ToUInt32(actual,0);
        if((attributes&FileAttributes.ReparsePoint)!=0)throw new IOException("Output reparse entry retained");
        if(((attributes&FileAttributes.Directory)!=0)!=directory)return false;
        if(!directory&&BitConverter.ToUInt32(actual,40)!=1)throw new IOException("Output hard links retained");
        ulong index=((ulong)BitConverter.ToUInt32(actual,44)<<32)|BitConverter.ToUInt32(actual,48);
        return Decimal(expected,"dev")==BitConverter.ToUInt32(actual,28).ToString(CultureInfo.InvariantCulture)&&Decimal(expected,"ino")==index.ToString(CultureInfo.InvariantCulture)&&Decimal(expected,"birthtimeNs")==Nanos(actual,4);
    }
    private static SafeFileHandle Pin(string file,bool directory,bool deleting){
        var handle=CreateFile(file,(directory?0x81U:0x80000080U)|(deleting?0x10000U:0U),directory?3U:deleting?0U:1U,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
        if(handle.IsInvalid){handle.Dispose();throw new IOException("Cannot pin output entry");}return handle;
    }
    private static bool Exists(string file){try{File.GetAttributes(file);return true;}catch(FileNotFoundException){return false;}catch(DirectoryNotFoundException){return false;}}
    private static string FinalName(SafeFileHandle handle){var result=new StringBuilder(2048);uint written=GetFinalPathNameByHandle(handle,result,(uint)result.Capacity,0);if(written==0||written>=result.Capacity)throw new IOException("Output handle path could not be confirmed");string value=result.ToString();return value.StartsWith(@"\\?\")?value.Substring(4):value;}
    private static void Location(SafeFileHandle handle,SafeFileHandle parent,string leaf){if(!string.Equals(FinalName(handle),FinalName(parent).TrimEnd('\\')+"\\"+leaf,StringComparison.OrdinalIgnoreCase))throw new IOException("Output handle escaped its pinned parent");}
    private static void Streams(SafeFileHandle handle,bool directory,bool supported){
        if(!supported)return;const int capacity=65536;IntPtr memory=Marshal.AllocHGlobal(capacity);
        try{
            if(!GetFileInformationByHandleEx(handle,7,memory,capacity)){if(directory&&Marshal.GetLastWin32Error()==38)return;throw new IOException("Cannot verify output data streams");}
            int offset=0,count=0;for(;;){if(offset<0||offset>capacity-24||++count>2)throw new IOException("Unexpected output data streams retained");int next=Marshal.ReadInt32(memory,offset),length=Marshal.ReadInt32(memory,offset+4);if(length<0||length%2!=0||length>capacity-offset-24)throw new IOException("Output stream inventory rejected");string name=Marshal.PtrToStringUni(IntPtr.Add(memory,offset+24),length/2);if(name!="::$DATA"||directory||count!=1)throw new IOException("Unknown output data stream retained");if(next==0)break;if(next<24||next>capacity-offset)throw new IOException("Output stream inventory rejected");offset+=next;}
        }finally{Marshal.FreeHGlobal(memory);}
    }
    private static void LocalPath(string file){
        if(file==null||file.Length>1024||!Regex.IsMatch(file,@"^[A-Za-z]:\\")||file!=Path.GetFullPath(file)||file.Substring(2).Contains(":")||Regex.IsMatch(file,@"[\x00-\x1f<>""|?*]")||file.Substring(3).Split('\\').Any(p=>p==""||p=="."||p==".."||p.EndsWith(".")||p.EndsWith(" ")||Regex.IsMatch(p,@"^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(\.|$)",RegexOptions.IgnoreCase)))throw new InvalidDataException("Output local path rejected");
    }
    private static void VerifiedHandle(SafeFileHandle handle,Dictionary<string,object> entry,bool streams){
        // FileStream owns a duplicate SafeFileHandle wrapper only. The original
        // pinned handle remains open for the rename/disposition operation.
        var before=Info(handle);if(!Identity(entry,before,false))throw new IOException("Output original identity changed");Streams(handle,false,streams);
        using(var copy=new SafeFileHandle(handle.DangerousGetHandle(),false))using(var file=new FileStream(copy,FileAccess.Read)){
            if(file.Length.ToString(CultureInfo.InvariantCulture)!=Text(entry,"bytes")||Nanos(before,20)!=Text(entry,"mtimeNs"))throw new IOException("Output metadata changed");
            using(var hash=SHA256.Create())if(BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant()!=Text(entry,"sha256"))throw new IOException("Output producer bytes changed");
            Streams(handle,false,streams);var after=Info(handle);if(!Identity(entry,after,false)||Nanos(after,20)!=Text(entry,"mtimeNs")||file.Length.ToString(CultureInfo.InvariantCulture)!=Text(entry,"bytes"))throw new IOException("Output file changed while hashing");
        }
    }
    public static string ApplyJson(string input,string mode){return ApplyJson(input,mode,null);}
    public static string ApplyJson(string input,string mode,Action<string> progress){
        if(input==null||Encoding.UTF8.GetByteCount(input)>65536||!new[]{"publish","check-published","cleanup"}.Contains(mode))throw new InvalidDataException("Output operation rejected");
        var json=new JavaScriptSerializer{MaxJsonLength=65536,RecursionLimit=8};var raw=json.DeserializeObject(input) as Dictionary<string,object>;Fields(raw,"temporary","target","ancestors","entry");
        string temporary=Text(raw,"temporary"),target=Text(raw,"target");LocalPath(temporary);LocalPath(target);string parent=Path.GetDirectoryName(target);
        if(!string.Equals(Path.GetDirectoryName(temporary),parent,StringComparison.OrdinalIgnoreCase)||!Regex.IsMatch(Path.GetFileName(temporary),@"^\.mucwin-partial-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")||!target.EndsWith(".mucwin",StringComparison.OrdinalIgnoreCase)||string.Equals(temporary,target,StringComparison.OrdinalIgnoreCase)||new DriveInfo(Path.GetPathRoot(target)).DriveType==DriveType.Network)throw new InvalidDataException("Output same-parent boundary rejected");
        var entry=raw["entry"] as Dictionary<string,object>;Fields(entry,"path","dev","ino","birthtimeNs","bytes","mtimeNs","sha256");if(Text(entry,"path")!=temporary)throw new InvalidDataException("Output original temporary binding changed");foreach(string name in new[]{"dev","ino","birthtimeNs","bytes","mtimeNs"})Decimal(entry,name);if(!Regex.IsMatch(Text(entry,"sha256"),@"^[a-f0-9]{64}$"))throw new InvalidDataException("Output digest rejected");
        var ancestors=raw["ancestors"] as IList;if(ancestors==null||ancestors.Count<1||ancestors.Count>64)throw new InvalidDataException("Output ancestor bound changed");
        var parents=new Dictionary<string,Dictionary<string,object>>(StringComparer.OrdinalIgnoreCase);foreach(var value in ancestors){var item=value as Dictionary<string,object>;Fields(item,"path","dev","ino","birthtimeNs");string file=Text(item,"path");if(parents.ContainsKey(file))throw new InvalidDataException("Output duplicate ancestor");parents.Add(file,item);}
        var sequence=new List<string>();for(string cursor=parent;;){sequence.Add(cursor);string next=Path.GetDirectoryName(cursor);if(string.IsNullOrEmpty(next))break;cursor=next;}sequence.Reverse();if(sequence.Count!=parents.Count)throw new InvalidDataException("Output ancestor receipt incomplete");
        var pins=new List<SafeFileHandle>();SafeFileHandle original=null;
        try{
            foreach(string directory in sequence){Dictionary<string,object> expected;if(!parents.TryGetValue(directory,out expected))throw new InvalidDataException("Output ancestor receipt mismatch");var pin=Pin(directory,true,false);pins.Add(pin);if(!Identity(expected,Info(pin),true))throw new IOException("Output original ancestor changed");}
            uint serial,maximum,flags;if(!GetVolumeInformationByHandleW(pins[0],null,0,out serial,out maximum,out flags,null,0))throw new IOException("Cannot verify pinned output filesystem capabilities");bool streams=(flags&0x00040000U)!=0;var destinationParent=pins[pins.Count-1];string targetLeaf=Path.GetFileName(target),temporaryLeaf=Path.GetFileName(temporary);
            Live();
            if(mode=="check-published"){
                if(!Exists(target))return json.Serialize(new{published=false});original=Pin(target,false,false);try{Location(original,destinationParent,targetLeaf);VerifiedHandle(original,entry,streams);}catch(IOException){return json.Serialize(new{published=false});}return json.Serialize(new{published=true});
            }
            if(!Exists(temporary)){
                if(mode=="cleanup")return json.Serialize(new{removed=true});
                if(!Exists(target))throw new IOException("Output source is absent");original=Pin(target,false,false);Location(original,destinationParent,targetLeaf);VerifiedHandle(original,entry,streams);return json.Serialize(new{published=true});
            }
            original=Pin(temporary,false,true);Location(original,destinationParent,temporaryLeaf);VerifiedHandle(original,entry,streams);if(progress!=null)progress("verified");Live();for(int i=0;i<pins.Count;i++){if(!Identity(parents[sequence[i]],Info(pins[i]),true))throw new IOException("Output ancestor changed before operation");}Location(original,destinationParent,temporaryLeaf);Streams(original,false,streams);if(!Identity(entry,Info(original),false))throw new IOException("Output file identity changed before operation");
            if(mode=="cleanup"){
                if(!SetFileInformationByHandle(original,4,new byte[]{1,0,0,0},4))throw new IOException("Output temporary file remains in use");original.Dispose();original=null;if(progress!=null)progress("removed");return json.Serialize(new{removed=true});
            }
            byte[] name=Encoding.Unicode.GetBytes(targetLeaf);int rootOffset=IntPtr.Size==8?8:4,lengthOffset=rootOffset+IntPtr.Size,nameOffset=lengthOffset+4;var rename=new byte[nameOffset+name.Length+2];Buffer.BlockCopy(IntPtr.Size==8?BitConverter.GetBytes(destinationParent.DangerousGetHandle().ToInt64()):BitConverter.GetBytes(destinationParent.DangerousGetHandle().ToInt32()),0,rename,rootOffset,IntPtr.Size);Buffer.BlockCopy(BitConverter.GetBytes(name.Length),0,rename,lengthOffset,4);Buffer.BlockCopy(name,0,rename,nameOffset,name.Length);
            // FileRenameInformation.ReplaceIfExists=FALSE, RootDirectory=pinned
            // parent. Win32 FileRenameInfo requires a null RootDirectory; the
            // equivalent NT operation accepts this fixed directory handle.
            // A relative basename cannot re-resolve a changed DOS drive alias.
            // Windows
            // changes this one pinned object in one atomic, no-replace rename.
            Live();IoStatusBlock status;int result=NtSetInformationFile(original,out status,rename,(uint)rename.Length,10);if(result!=0){uint error=RtlNtStatusToDosError(result);if(error==80||error==183)return json.Serialize(new{published=false,conflict=true});throw new IOException("Output atomic publication failed ("+error+")");}
            Location(original,destinationParent,targetLeaf);if(!Identity(entry,Info(original),false))throw new IOException("Output publication result could not be confirmed");
            if(progress!=null)progress("published");return json.Serialize(new{published=true});
        }finally{if(original!=null)original.Dispose();for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}
    }
}
