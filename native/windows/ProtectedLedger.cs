// Compiled with HyperVBroker.cs imports. This store has no IPC operations or
// caller-selected filenames; the broker supplies its pinned, protected root.
public sealed class MuProtectedLedger {
    private const int MaxBytes=262144;
    private readonly string root,sid;
    private readonly Action<string> validateFile;
    private long revision;
    public int UnregisteredStorageCount {get;private set;}
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(IntPtr file,[Out]byte[] info);
    private sealed class Snapshot {
        public byte[] Bytes;
        public long Revision;
        public Dictionary<string,Dictionary<string,object>> Records;
    }
    public MuProtectedLedger(string directory,string ownerSid,Action<string> validator){
        root=Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar);sid=ownerSid;
        if(validator==null)throw new ArgumentNullException("validator");validateFile=validator;
    }
    private static JavaScriptSerializer Serializer(){return new JavaScriptSerializer{MaxJsonLength=MaxBytes,RecursionLimit=16};}
    private static bool Exists(string path){try{File.GetAttributes(path);return true;}catch(FileNotFoundException){return false;}catch(DirectoryNotFoundException){return false;}}
    private void ValidateFile(string path){
        var attributes=File.GetAttributes(path);if((attributes&(FileAttributes.ReparsePoint|FileAttributes.Directory))!=0)throw new UnauthorizedAccessException("Registry must be a regular file without reparse points");
        using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){
            byte[] info=new byte[52];if(!GetFileInformationByHandle(file.SafeFileHandle.DangerousGetHandle(),info))throw new IOException("Registry file identity is unavailable");
            if(BitConverter.ToUInt32(info,40)!=1)throw new UnauthorizedAccessException("Registry hard links are not allowed");
        }
        validateFile(path);
    }
    private static string StringValue(Dictionary<string,object> value,string key){object item;if(!value.TryGetValue(key,out item)||!(item is string)||((string)item).IndexOf('\0')>=0)throw new UnauthorizedAccessException("Registry field changed: "+key);return (string)item;}
    private static long IntegerValue(Dictionary<string,object> value,string key,long min,long max){object item;if(!value.TryGetValue(key,out item)||!(item is int)&&!(item is long))throw new UnauthorizedAccessException("Registry number changed: "+key);long number=Convert.ToInt64(item);if(number<min||number>max)throw new UnauthorizedAccessException("Registry number out of bounds: "+key);return number;}
    private static bool IsDigest(string value){return value.Length==64&&value.All(c=>c>='0'&&c<='9'||c>='a'&&c<='f');}
    private static bool IsId(string value){Guid id;return Guid.TryParseExact(value,"D",out id)&&id!=Guid.Empty&&id.ToString("D")==value;}
    private void ValidateRecord(string id,Dictionary<string,object> record){
        if(!IsId(id)||StringValue(record,"id")!=id||StringValue(record,"ownerSid")!=sid)throw new UnauthorizedAccessException("Registry ownership changed");
        var fields=new[]{"id","ownerSid","image","imageSha256","cpus","memoryGiB","diskGiB","stage","platformId","everReady","baseBuilder","sealedSource","baseSealedDigest"};
        if(record.Keys.Any(key=>!fields.Contains(key)))throw new UnauthorizedAccessException("Unknown registry field");
        string digest=StringValue(record,"imageSha256"),image=StringValue(record,"image");
        if(!IsDigest(digest)||!new[]{".vhd",".vhdx"}.Any(extension=>string.Equals(image,Path.Combine(root,"images",digest+extension),StringComparison.OrdinalIgnoreCase)))throw new UnauthorizedAccessException("Registry image boundary changed");
        IntegerValue(record,"cpus",1,16);IntegerValue(record,"memoryGiB",2,32);IntegerValue(record,"diskGiB",16,256);
        string stage=StringValue(record,"stage");if(!new[]{"allocated","disk-ready","creating","ready","create-failed","vm-missing","preparing","deleting"}.Contains(stage))throw new UnauthorizedAccessException("Unknown registry stage");
        foreach(string key in new[]{"everReady","baseBuilder"})if(record.ContainsKey(key)&&!(record[key] is bool))throw new UnauthorizedAccessException("Invalid registry flag");
        if(record.ContainsKey("platformId")&&!IsId(StringValue(record,"platformId")))throw new UnauthorizedAccessException("Invalid registry VM identity");
        if(stage=="ready"&&!record.ContainsKey("platformId"))throw new UnauthorizedAccessException("Ready registry entry has no VM identity");
        if(record.ContainsKey("sealedSource")&&(StringValue(record,"sealedSource")!="mu-base:"+digest||!image.EndsWith(".vhdx",StringComparison.OrdinalIgnoreCase)))throw new UnauthorizedAccessException("Registry sealed source changed");
        bool builder=record.ContainsKey("baseBuilder")&&(bool)record["baseBuilder"];
        if(builder&&(digest!="c74a7d3b3476ffb2715bfcaf9c216e9dd1d6c7e01bc6d0380b1744518dfae15c"||Convert.ToInt64(record["cpus"])!=2||Convert.ToInt64(record["memoryGiB"])!=4||Convert.ToInt64(record["diskGiB"])!=32||record.ContainsKey("sealedSource")))throw new UnauthorizedAccessException("Registry builder authority changed");
        if(record.ContainsKey("baseSealedDigest")&&(!builder||!IsDigest(StringValue(record,"baseSealedDigest"))))throw new UnauthorizedAccessException("Registry sealed builder changed");
    }
    private Dictionary<string,Dictionary<string,object>> ParseRecords(Dictionary<string,object> values){
        if(values==null||values.Count>32)throw new UnauthorizedAccessException("Registry allocation limit changed");
        var records=new Dictionary<string,Dictionary<string,object>>();
        foreach(var pair in values){var record=pair.Value as Dictionary<string,object>;if(record==null)throw new UnauthorizedAccessException("Invalid registry entry");ValidateRecord(pair.Key,record);records.Add(pair.Key,record);}return records;
    }
    private Snapshot Read(string path){
        ValidateFile(path);byte[] bytes;
        using(var input=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){
            if(input.Length>MaxBytes)throw new IOException("Registry file exceeds its fixed limit");bytes=new byte[(int)input.Length];int offset=0,count;while(offset<bytes.Length&&(count=input.Read(bytes,offset,bytes.Length-offset))>0)offset+=count;if(offset!=bytes.Length)throw new IOException("Registry read was incomplete");
        }
        string text;Dictionary<string,object> value;
        try{text=new UTF8Encoding(false,true).GetString(bytes);if(text.Length>0&&text[0]=='\ufeff')text=text.Substring(1);value=Serializer().DeserializeObject(text) as Dictionary<string,object>;}
        catch(Exception error){if(!(error is ArgumentException)&&!(error is InvalidOperationException))throw;throw new InvalidDataException("Registry JSON is incomplete",error);}
        if(value==null)throw new InvalidDataException("Registry JSON root is invalid");
        long generation=0;Dictionary<string,Dictionary<string,object>> records;
        if(value.ContainsKey("version")){
            if(IntegerValue(value,"version",2,2)!=2||value.Keys.Any(key=>!new[]{"version","ownerSid","revision","records"}.Contains(key))||StringValue(value,"ownerSid")!=sid)throw new UnauthorizedAccessException("Registry format or owner changed");
            generation=IntegerValue(value,"revision",1,long.MaxValue-1);object body;if(!value.TryGetValue("records",out body))throw new UnauthorizedAccessException("Registry body missing");records=ParseRecords(body as Dictionary<string,object>);
        }else records=ParseRecords(value);
        return new Snapshot{Bytes=bytes,Revision=generation,Records=records};
    }
    private void CheckStorage(Dictionary<string,Dictionary<string,object>> records,bool requireRegistration){
        string parent=Path.Combine(root,"vms");if(!Directory.Exists(parent))return;
        UnregisteredStorageCount=0;
        foreach(string entry in Directory.EnumerateFileSystemEntries(parent)){
            var attributes=File.GetAttributes(entry);string id=Path.GetFileName(entry);
            if(!records.ContainsKey(id)){UnregisteredStorageCount++;if(requireRegistration)throw new UnauthorizedAccessException("Unregistered VM storage remains; preserve it for explicit recovery");continue;}
            if((attributes&FileAttributes.ReparsePoint)!=0||(attributes&FileAttributes.Directory)==0||!IsId(id))throw new UnauthorizedAccessException("Registered VM storage identity changed");
        }
    }
    private void Write(string path,byte[] bytes){
        if(Exists(path))ValidateFile(path);
        string next=path+"."+Guid.NewGuid().ToString("N")+".next";
        try{using(var output=new FileStream(next,FileMode.CreateNew,FileAccess.Write,FileShare.None)){output.Write(bytes,0,bytes.Length);output.Flush(true);}if(Exists(path)){ValidateFile(path);File.Replace(next,path,null);}else File.Move(next,path);}
        finally{if(Exists(next))File.Delete(next);}
    }
    public Dictionary<string,Dictionary<string,object>> Load(){
        string primary=Path.Combine(root,"vms.json"),backup=Path.Combine(root,"vms.backup.json");Snapshot a=null,b=null;
        bool primaryExists=Exists(primary),backupExists=Exists(backup);var corrupt=new List<string>();
        if(primaryExists)try{a=Read(primary);}catch(InvalidDataException){corrupt.Add(primary);}
        if(backupExists)try{b=Read(backup);}catch(InvalidDataException){corrupt.Add(backup);}
        if(a==null&&b==null){
            if(primaryExists||backupExists)throw new InvalidDataException("Neither protected registry copy is readable; all resources were preserved");
            var empty=new Dictionary<string,Dictionary<string,object>>();CheckStorage(empty,true);Save(empty);return empty;
        }
        if(a!=null&&b!=null&&a.Revision==b.Revision&&!a.Bytes.SequenceEqual(b.Bytes))throw new InvalidDataException("Protected registry copies disagree at the same revision");
        Snapshot chosen=a==null?b:b==null?a:a.Revision>=b.Revision?a:b;CheckStorage(chosen.Records,chosen.Revision==0&&chosen.Records.Count==0);revision=chosen.Revision;
        foreach(string path in corrupt){string retained=Path.Combine(root,"vms.rejected-"+Guid.NewGuid().ToString("N")+".json");ValidateFile(path);File.Copy(path,retained,false);}
        if(chosen.Revision==0)Save(chosen.Records);
        else{if(a==null||!a.Bytes.SequenceEqual(chosen.Bytes))Write(primary,chosen.Bytes);if(b==null||!b.Bytes.SequenceEqual(chosen.Bytes))Write(backup,chosen.Bytes);}
        return chosen.Records;
    }
    public void Save(Dictionary<string,Dictionary<string,object>> records){
        if(records.Count>32)throw new UnauthorizedAccessException("Registry allocation limit changed");foreach(var pair in records)ValidateRecord(pair.Key,pair.Value);
        revision=checked(revision+1);string text=Serializer().Serialize(new {version=2,ownerSid=sid,revision=revision,records=records});byte[] bytes=Encoding.UTF8.GetBytes(text);if(bytes.Length>MaxBytes)throw new IOException("Registry limit exceeded");
        // Publish the new backup first. No VM operation may proceed until both
        // copies are durable. A newer backup is recoverable after interruption.
        Write(Path.Combine(root,"vms.backup.json"),bytes);Write(Path.Combine(root,"vms.json"),bytes);
    }
}
