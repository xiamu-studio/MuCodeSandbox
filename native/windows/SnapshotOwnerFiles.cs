using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Ordinary-token fixed-name replay only. The controller must authenticate the
// owner envelopes and native transaction before supplying either allowed hash.
// This helper cannot select a VM, start it, or acknowledge a native transaction.
public static class MuSnapshotOwnerFiles {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle,[Out]byte[] info);
    private static readonly string[] Names={"management","management.pub","host-ed25519","host-ed25519.pub","known_hosts","seed.iso","manifest.json","allocation.json"};
    private static readonly SecurityIdentifier User=WindowsIdentity.GetCurrent().User;
    private static readonly SecurityIdentifier[] Trusted={User,new SecurityIdentifier("S-1-5-18"),new SecurityIdentifier("S-1-5-32-544")};
    private sealed class Entry {public string name,digest;public string[] allowed;public byte[] data;public FileStream current;public string stage;}
    private static void Id(string value){Guid parsed;if(!Guid.TryParseExact(value,"D",out parsed)||parsed==Guid.Empty||parsed.ToString("D")!=value)throw new ArgumentException("Canonical replay identity required");}
    private static void Fields(Dictionary<string,object> value,params string[] names){if(value==null||value.Count!=names.Length||value.Keys.Any(k=>!names.Contains(k)))throw new ArgumentException("Replay fields changed");}
    private static string Text(Dictionary<string,object> value,string key){object raw;if(!value.TryGetValue(key,out raw)||!(raw is string))throw new ArgumentException("Replay string required");return (string)raw;}
    private static bool Digest(string value){return value!=null&&value.Length==64&&value.All(c=>c>='a'&&c<='f'||c>='0'&&c<='9');}
    private static int Bound(string name){return name=="seed.iso"?8*1024*1024:name=="manifest.json"||name=="allocation.json"?8192:65536;}
    private static byte[] Info(SafeFileHandle handle){var info=new byte[52];if(!GetFileInformationByHandle(handle,info))throw new IOException("Cannot inspect replay handle");return info;}
    private static void Acl(string path,bool directory){
        FileSystemSecurity acl=directory?(FileSystemSecurity)Directory.GetAccessControl(path):File.GetAccessControl(path);
        var owner=(SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier));if(!Trusted.Any(s=>s.Equals(owner)))throw new UnauthorizedAccessException("Replay owner changed");
        var rules=acl.GetAccessRules(true,true,typeof(SecurityIdentifier));var granted=new HashSet<string>();
        foreach(FileSystemAccessRule rule in rules){if(rule.AccessControlType!=AccessControlType.Allow||!Trusted.Any(s=>s.Equals(rule.IdentityReference))||rule.FileSystemRights!=FileSystemRights.FullControl)throw new UnauthorizedAccessException("Replay ACL changed");granted.Add(rule.IdentityReference.Value);}
        if(Trusted.Any(s=>!granted.Contains(s.Value)))throw new UnauthorizedAccessException("Replay private ACL incomplete");
    }
    private static DirectorySecurity DirectoryAcl(){var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);foreach(var sid in Trusted)acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));return acl;}
    private static SafeFileHandle Pin(string path){
        var handle=CreateFile(path,0x20081,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
        try{if(handle.IsInvalid)throw new IOException("Cannot pin replay directory");var attributes=(FileAttributes)BitConverter.ToUInt32(Info(handle),0);if((attributes&FileAttributes.ReparsePoint)!=0||(attributes&FileAttributes.Directory)==0)throw new IOException("Replay directory reparse rejected");return handle;}catch{handle.Dispose();throw;}
    }
    private static SafeFileHandle PrivateDirectory(string path){
        if(!Exists(path))Directory.CreateDirectory(path,DirectoryAcl());var handle=Pin(path);try{Acl(path,true);return handle;}catch{handle.Dispose();throw;}
    }
    private static bool Exists(string path){try{File.GetAttributes(path);return true;}catch(FileNotFoundException){return false;}catch(DirectoryNotFoundException){return false;}}
    private static FileStream Read(string path,int maximum){
        var handle=CreateFile(path,0x80020000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
        try{if(handle.IsInvalid)throw new IOException("Cannot pin replay file");var info=Info(handle);var attributes=(FileAttributes)BitConverter.ToUInt32(info,0);if((attributes&(FileAttributes.Directory|FileAttributes.ReparsePoint))!=0||BitConverter.ToUInt32(info,40)!=1)throw new IOException("Replay file type or link count changed");Acl(path,false);var stream=new FileStream(handle,FileAccess.Read);if(stream.Length<1||stream.Length>maximum){stream.Dispose();throw new IOException("Replay file exceeds bound");}return stream;}catch{handle.Dispose();throw;}
    }
    private static string Hash(FileStream stream){stream.Position=0;using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
    private static void Match(string path,Entry entry,bool desired){using(var file=Read(path,Bound(entry.name))){string hash=Hash(file);if(desired?hash!=entry.digest:!entry.allowed.Contains(hash))throw new IOException("Unknown replay file retained");}}
    private static FileStream Operation(string path,bool check){
        var handle=CreateFile(path,0xc0020000,0,IntPtr.Zero,check?3U:4U,0x00200000,IntPtr.Zero);
        try{if(handle.IsInvalid)throw new IOException("Another ordinary replay still holds this environment");var info=Info(handle);if(((FileAttributes)BitConverter.ToUInt32(info,0)&(FileAttributes.ReparsePoint|FileAttributes.Directory))!=0||BitConverter.ToUInt32(info,40)!=1)throw new IOException("Replay operation lock changed");Acl(path,false);return new FileStream(handle,FileAccess.ReadWrite);}catch{handle.Dispose();throw;}
    }
    public static string ApplyJson(string input){return ApplyJson(input,null);}
    public static string ApplyJson(string input,Action<string> progress){
        if(input==null||Encoding.UTF8.GetByteCount(input)>12*1024*1024)throw new ArgumentException("Replay request exceeds bound");
        var json=new JavaScriptSerializer{MaxJsonLength=12*1024*1024,RecursionLimit=8};var raw=json.DeserializeObject(input) as Dictionary<string,object>;Fields(raw,"root","id","transactionId","files","checkOnly");
        string root=Text(raw,"root"),id=Text(raw,"id"),transaction=Text(raw,"transactionId");Id(id);Id(transaction);
        if(!(raw["checkOnly"] is bool))throw new ArgumentException("Replay check mode required");bool check=(bool)raw["checkOnly"];
        if(!System.Text.RegularExpressions.Regex.IsMatch(root,@"^[A-Za-z]:\\")||Path.GetFullPath(root).TrimEnd('\\')!=root||new DriveInfo(Path.GetPathRoot(root)).DriveType==DriveType.Network)throw new ArgumentException("Fixed local replay root required");
        var files=raw["files"] as System.Collections.IList;if(files==null||files.Count!=8)throw new ArgumentException("Complete replay inventory required");
        var entries=new List<Entry>();var pins=new List<SafeFileHandle>();FileStream operation=null;
        try{
            foreach(var item in files){
                var value=item as Dictionary<string,object>;Fields(value,"name","base64","sha256","allowed");string name=Text(value,"name"),digest=Text(value,"sha256"),base64=Text(value,"base64");
                if(!Names.Contains(name)||entries.Any(e=>e.name==name)||!Digest(digest)||base64.Length>(Bound(name)+2)/3*4)throw new ArgumentException("Replay fixed file inventory changed");
                var allowed=value["allowed"] as System.Collections.IList;if(allowed==null||allowed.Count<1||allowed.Count>2||allowed.Cast<object>().Any(v=>!(v is string)||!Digest((string)v)))throw new ArgumentException("Replay allowed hashes changed");
                var entry=new Entry{name=name,digest=digest,allowed=allowed.Cast<string>().ToArray()};entries.Add(entry);entry.data=Convert.FromBase64String(base64);
                using(var hash=SHA256.Create())if(entry.data.Length<1||entry.data.Length>Bound(name)||Convert.ToBase64String(entry.data)!=base64||BitConverter.ToString(hash.ComputeHash(entry.data)).Replace("-","").ToLowerInvariant()!=digest||!entry.allowed.Contains(digest)||entry.allowed.Distinct().Count()!=entry.allowed.Length)throw new ArgumentException("Replay desired bytes changed");
            }
            string cursor=Path.GetPathRoot(root);pins.Add(Pin(cursor));foreach(string part in root.Substring(cursor.Length).Split(new[]{'\\'},StringSplitOptions.RemoveEmptyEntries)){cursor=Path.Combine(cursor,part);pins.Add(Pin(cursor));}Acl(root,true);
            string directory=Path.Combine(root,"mu-win-"+id.Replace("-",""));if(check&&!Exists(directory))throw new IOException("Replay directory missing");
            string history=Path.Combine(root,"snapshot-owner-history");foreach(string folder in new[]{history,Path.Combine(history,id)}){if(check&&!Exists(folder))throw new IOException("Replay operation history missing");pins.Add(PrivateDirectory(folder));}history=Path.Combine(history,id);
            // Also excludes an orphan helper after its Node parent exits. A new
            // controller cannot interleave files with that still-live helper.
            operation=Operation(Path.Combine(history,"operation.lock"),check);pins.Add(PrivateDirectory(directory));
            foreach(var entry in entries){string target=Path.Combine(directory,entry.name);if(Exists(target)){entry.current=Read(target,Bound(entry.name));string actual=Hash(entry.current);if(check?actual!=entry.digest:!entry.allowed.Contains(actual))throw new IOException("Unknown replay file retained");}else if(check)throw new IOException("Replay file missing");}
            int backups=0;
            if(!check){
                history=Path.Combine(history,transaction);pins.Add(PrivateDirectory(history));
                foreach(var entry in entries){if(entry.current!=null&&Hash(entry.current)==entry.digest)continue;entry.stage=Path.Combine(history,entry.name+"."+Guid.NewGuid().ToString("N")+".next");using(var output=new FileStream(entry.stage,FileMode.CreateNew,FileAccess.Write,FileShare.None)){output.Write(entry.data,0,entry.data.Length);output.Flush(true);}Match(entry.stage,entry,true);}
                foreach(var entry in entries){
                    if(entry.stage==null)continue;string target=Path.Combine(directory,entry.name);bool replaced=entry.current!=null;if(entry.current!=null)entry.current.Dispose();entry.current=null;if(progress!=null)progress("before-replace-"+entry.name);
                    if(replaced){Match(target,entry,false);string backup=Path.Combine(history,entry.name+"."+Guid.NewGuid().ToString("N")+".previous");File.Replace(entry.stage,target,backup);backups++;Match(backup,entry,false);}else File.Move(entry.stage,target);
                    Match(target,entry,true);if(progress!=null)progress("replayed-"+entry.name);
                }
            }
            foreach(var entry in entries)Match(Path.Combine(directory,entry.name),entry,true);
            return json.Serialize(new {verified=true,retainedBackups=backups,files=entries.Select(e=>new {name=e.name,sha256=e.digest,bytes=e.data.Length}).ToArray()});
        }finally{foreach(var entry in entries){if(entry.current!=null)entry.current.Dispose();if(entry.data!=null)Array.Clear(entry.data,0,entry.data.Length);}if(operation!=null)operation.Dispose();for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}
    }
}
