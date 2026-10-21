// A separate recovery session can only inspect stopped resources and publish an
// explicitly reviewed registration. It never starts/stops or rewrites a disk.
public static partial class MuHyperVBroker {
    private static bool RecoveryOnly;
    private static string RecoveryLedgerFingerprint;
    private static bool RecoveryPublicationAttempted;
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(IntPtr file,[Out]byte[] info);
    private static void RecoveryAcl(string path,SecurityIdentifier vmSid,bool directory){
        var attributes=File.GetAttributes(path);if((attributes&FileAttributes.ReparsePoint)!=0||((attributes&FileAttributes.Directory)!=0)!=directory)throw new UnauthorizedAccessException("Recovery storage type changed");
        FileSystemSecurity acl=directory?(FileSystemSecurity)Directory.GetAccessControl(path):File.GetAccessControl(path);MuRecoveryPermissions.Validate(acl,vmSid,directory);
    }
    private static FileStream RecoveryFile(string file,SecurityIdentifier vmSid=null){
        if(vmSid==null)ValidateLedgerFile(file);else RecoveryAcl(file,vmSid,false);var input=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read,1048576,FileOptions.SequentialScan);
        try{byte[] info=new byte[52];if(!GetFileInformationByHandle(input.SafeFileHandle.DangerousGetHandle(),info)||BitConverter.ToUInt32(info,40)!=1)throw new UnauthorizedAccessException("Recovery file identity or hard links rejected");return input;}catch{input.Dispose();throw;}
    }
    private static string RecoveryHash(Stream input,CancellationToken cancellation){
        using(var sha=SHA256.Create()){var buffer=new byte[1048576];int count;while((count=input.Read(buffer,0,buffer.Length))>0){cancellation.ThrowIfCancellationRequested();sha.TransformBlock(buffer,0,count,null,0);}sha.TransformFinalBlock(new byte[0],0,0);return BitConverter.ToString(sha.Hash).Replace("-","").ToLowerInvariant();}
    }
    private static object RecoveryAction(string action,Dictionary<string,object> request,CancellationToken cancellation){
        if(action=="recovery-info"){ValidateKeys(request,"action");lock(Gate)return new {mode="recovery",registeredIds=Records.Keys.OrderBy(value=>value,StringComparer.Ordinal).ToArray(),publicationAttempted=RecoveryPublicationAttempted};}
        if(action!="recovery-review"&&action!="recovery-adopt")throw new UnauthorizedAccessException("This recovery session only reviews and registers stopped protected resources");
        if(action=="recovery-review")ValidateKeys(request,"action","id","imageSha256");else ValidateKeys(request,"action","id","imageSha256","plan","confirmName");
        string id=Id(request),digest=Digest(request,"imageSha256"),name="mu-win-"+id.Replace("-","");
        if(digest==CanonicalBuilderDigest)throw new UnauthorizedAccessException("Base builders cannot be adopted as work environments");
        lock(VmGate(id))lock(ImportGate)using(ImportReservation()){
            if(RecoveryPublicationAttempted||LedgerStore.RecoveryFingerprint()!=RecoveryLedgerFingerprint)throw new MuStorageException("RECOVERY_REVIEW_CHANGED","Protected registrations changed; reopen recovery");
            lock(Gate)if(Records.ContainsKey(id)||Records.Count>=32)throw new UnauthorizedAccessException("Only unregistered storage may be recovered");
            string dir=Path.Combine(UserRoot,"vms",id);if(!Directory.Exists(dir))throw new UnauthorizedAccessException("Protected allocation storage is missing");CheckRemovalTree(dir);
            string[] images=new[]{Path.Combine(UserRoot,"images",digest+".vhdx"),Path.Combine(UserRoot,"images",digest+".vhd")}.Where(File.Exists).ToArray();
            if(images.Length!=1)throw new UnauthorizedAccessException("Select one existing verified source image digest");
            var record=new Dictionary<string,object>{{"id",id},{"ownerSid",OwnerSid},{"image",images[0]},{"imageSha256",digest},{"cpus",1},{"memoryGiB",2},{"diskGiB",16},{"stage","ready"},{"everReady",true}};
            var parameters=Parameters(record);parameters["allowPartialAllocation"]=false;
            var before=Json().Deserialize<Dictionary<string,object>>(Invoke("review-allocation",parameters,30000,cancellation));string expected=Id(new Dictionary<string,object>{{"id",Text(before,"platformId",36)}});parameters["expectedPlatformId"]=expected;
            var vmSid=(SecurityIdentifier)new NTAccount("NT VIRTUAL MACHINE",expected).Translate(typeof(SecurityIdentifier));RecoveryAcl(dir,vmSid,true);
            var directoryHandle=CreateFile(dir,0x80000000,3,IntPtr.Zero,3,0x02000000|0x00200000,IntPtr.Zero);if(directoryHandle==new IntPtr(-1))throw new IOException("Cannot pin recovery allocation");
            using(var pinned=new HandleOwner(directoryHandle))using(var disk=RecoveryFile(Convert.ToString(parameters["disk"]),vmSid))using(var seed=RecoveryFile(Convert.ToString(parameters["seed"]),vmSid))using(var image=RecoveryFile(images[0])){
                string diskHash=RecoveryHash(disk,cancellation);if(RecoveryHash(image,cancellation)!=digest)throw new UnauthorizedAccessException("Recovery source image changed");string seedHash=RecoveryHash(seed,cancellation);
                var after=Json().Deserialize<Dictionary<string,object>>(Invoke("review-allocation",parameters,30000,cancellation));
                if(before.Count!=4||after.Count!=4||before.Any(pair=>!after.ContainsKey(pair.Key)||Convert.ToString(pair.Value,System.Globalization.CultureInfo.InvariantCulture)!=Convert.ToString(after[pair.Key],System.Globalization.CultureInfo.InvariantCulture)))throw new IOException("VM changed during recovery review");
                int cpus=Number(after,"cpus",1,16),memory=Number(after,"memoryGiB",2,32),capacity=Number(after,"diskGiB",16,256);string platform=Id(new Dictionary<string,object>{{"id",Text(after,"platformId",36)}});
                record["cpus"]=cpus;record["memoryGiB"]=memory;record["diskGiB"]=capacity;record["platformId"]=platform;
                long registered;lock(Gate)registered=Records.Values.Sum(value=>Convert.ToInt64(value["diskGiB"]));MuResourcePolicy.Quota(registered,capacity);string fingerprint=LedgerStore.RecoveryFingerprint();
                var reviewed=new {version=1,id=id,name=name,platformId=platform,cpus=cpus,memoryGiB=memory,diskGiB=capacity,imageSha256=digest,diskSha256=diskHash,seedSha256=seedHash,registryFingerprint=fingerprint,registeredDiskGiB=registered};
                string plan;using(var sha=SHA256.Create())plan=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Json().Serialize(reviewed)))).Replace("-","").ToLowerInvariant();
                if(action=="recovery-review")return new {review=reviewed,plan=plan,registered=false,state="Off",diskPreserved=true};
                if(Digest(request,"plan")!=plan||Text(request,"confirmName",64)!=name)throw new MuStorageException("RECOVERY_REVIEW_CHANGED","Recovery review changed or confirmation does not match; review again");
                cancellation.ThrowIfCancellationRequested();CheckPower();lock(Gate){RecoveryPublicationAttempted=true;Records.Add(id,record);try{LedgerStore.SaveRecovery(Records,fingerprint);}catch{Records.Remove(id);throw;}}
                return new {registered=true,id=id,platformId=platform,state="Off",diskPreserved=true,reopenRequired=true};
            }
        }
    }
}
