// Compiled as the same compilation unit as HyperVBroker.cs, using its imports.
public static partial class MuHyperVBroker {
    private const string CanonicalBuilderDigest="c74a7d3b3476ffb2715bfcaf9c216e9dd1d6c7e01bc6d0380b1744518dfae15c";
    private static object BaseReceipt(string digest){return new {ready=true,image="mu-base:"+digest,imageSha256=digest};}
    private static string ResolveSealedBase(string reference,string digest){
        if(reference!="mu-base:"+digest||digest.Length!=64||digest.Any(c=>!(c>='0'&&c<='9'||c>='a'&&c<='f')))throw new ArgumentException("Invalid sealed base reference");
        string metadata=Path.Combine(UserRoot,"bases",digest+".json"),image=Path.Combine(UserRoot,"images",digest+".vhdx");
        if(!File.Exists(metadata)||new FileInfo(metadata).Length>4096||(File.GetAttributes(metadata)&FileAttributes.ReparsePoint)!=0)throw new UnauthorizedAccessException("Sealed base catalog missing or changed");
        var saved=Json().Deserialize<Dictionary<string,object>>(File.ReadAllText(metadata));
        if(Convert.ToString(saved["ownerSid"])!=OwnerSid||Convert.ToString(saved["imageSha256"])!=digest||Convert.ToString(saved["sourceSha256"])!=CanonicalBuilderDigest||Convert.ToString(saved["recipe"])!="windows-amd64-desktop-v1")throw new UnauthorizedAccessException("Sealed base ownership or recipe changed");
        if(!File.Exists(image)||(File.GetAttributes(image)&FileAttributes.ReparsePoint)!=0||HashFile(image)!=digest)throw new UnauthorizedAccessException("Sealed base image missing or changed");
        return image;
    }
    private static object SealBase(string id,CancellationToken cancellation){
        lock(VmGate(id)){
            var record=Owned(id);
            if(!record.ContainsKey("baseBuilder")||!Convert.ToBoolean(record["baseBuilder"])||Convert.ToString(record["imageSha256"])!=CanonicalBuilderDigest||!EverReady(record))throw new UnauthorizedAccessException("Only a new official base builder can be sealed");
            if(record.ContainsKey("baseSealedDigest")){string existing=Convert.ToString(record["baseSealedDigest"]);ResolveSealedBase("mu-base:"+existing,existing);return BaseReceipt(existing);}
            CloseChannel(id);var parameters=Parameters(record);Invoke("seal-base",parameters,30000,cancellation);
            lock(ImportGate){
                string images=Path.Combine(UserRoot,"images"),bases=Path.Combine(UserRoot,"bases");PrivateDirectory(bases,false);
                string importLock=Path.Combine(Directory.GetParent(Directory.GetParent(UserRoot).FullName).FullName,"import.lock");
                using(var reservation=new FileStream(importLock,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)){
                    long remaining=64L*1024*1024*1024-Directory.GetFiles(images).Sum(file=>new FileInfo(file).Length);
                    string source=Convert.ToString(parameters["disk"]),next=Path.Combine(images,"base-"+id+"."+Guid.NewGuid().ToString("N")+".next");
                    if((File.GetAttributes(source)&FileAttributes.ReparsePoint)!=0)throw new UnauthorizedAccessException("Builder disk changed");
                    string digest;
                    try{
                        using(var input=new FileStream(source,FileMode.Open,FileAccess.Read,FileShare.Read,1048576))using(var output=new FileStream(next,FileMode.CreateNew,FileAccess.Write,FileShare.None,1048576))using(var sha=SHA256.Create()){
                            CheckDiskRequest(input.Length,cancellation);
                            if(input.Length<1||input.Length>remaining||new DriveInfo(Path.GetPathRoot(next)).AvailableFreeSpace<input.Length+2L*1024*1024*1024)throw new IOException("Insufficient protected base storage");
                            byte[] buffer=new byte[1048576];int count;while((count=input.Read(buffer,0,buffer.Length))>0){cancellation.ThrowIfCancellationRequested();sha.TransformBlock(buffer,0,count,null,0);output.Write(buffer,0,count);}sha.TransformFinalBlock(new byte[0],0,0);output.Flush(true);digest=BitConverter.ToString(sha.Hash).Replace("-","").ToLowerInvariant();
                        }
                        string target=Path.Combine(images,digest+".vhdx");if(File.Exists(target)){if((File.GetAttributes(target)&FileAttributes.ReparsePoint)!=0||HashFile(target)!=digest)throw new UnauthorizedAccessException("Cached base changed");}else File.Move(next,target);
                        string metadata=Path.Combine(bases,digest+".json");if(!File.Exists(metadata)){string pending=metadata+"."+Guid.NewGuid().ToString("N")+".next";try{using(var file=new FileStream(pending,FileMode.CreateNew,FileAccess.Write,FileShare.None)){byte[] bytes=Encoding.UTF8.GetBytes(Json().Serialize(new {ownerSid=OwnerSid,imageSha256=digest,sourceSha256=CanonicalBuilderDigest,builderId=id,recipe="windows-amd64-desktop-v1"}));file.Write(bytes,0,bytes.Length);file.Flush(true);}File.Move(pending,metadata);}finally{if(File.Exists(pending))File.Delete(pending);}}
                        ResolveSealedBase("mu-base:"+digest,digest);lock(Gate){record["baseSealedDigest"]=digest;Save();}return BaseReceipt(digest);
                    }finally{if(File.Exists(next))File.Delete(next);}
                }
            }
        }
    }
}
