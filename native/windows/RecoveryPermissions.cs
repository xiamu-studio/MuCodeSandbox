// This policy concerns existing VM files, whose ACLs VMMS augments. The ledger,
// image cache and parent user store continue to require administrators/SYSTEM.
public static class MuRecoveryPermissions {
    private static readonly SecurityIdentifier SystemSid=new SecurityIdentifier("S-1-5-18"),AdminSid=new SecurityIdentifier("S-1-5-32-544");
    private static readonly SecurityIdentifier WorkerCapability=new SecurityIdentifier("S-1-15-3-1024-2268835264-3721307629-241982045-173645152-1490879176-104643441-2915960892-1612460704");
    public static void Validate(FileSystemSecurity acl,SecurityIdentifier vmSid,bool directory){
        if(vmSid==null||!vmSid.Value.StartsWith("S-1-5-83-1-",StringComparison.Ordinal))throw new UnauthorizedAccessException("An exact VM service identity is required");
        var owner=(SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier));if(!owner.Equals(AdminSid)&&!owner.Equals(SystemSid))throw new UnauthorizedAccessException("Recovery storage owner changed");
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))){
            if(rule.AccessControlType!=AccessControlType.Allow||rule.IdentityReference.Equals(AdminSid)||rule.IdentityReference.Equals(SystemSid)||rule.IdentityReference.Equals(vmSid)||rule.IdentityReference.Equals(WorkerCapability))continue;
            if(directory&&rule.IdentityReference.Value=="S-1-3-0"&&(rule.PropagationFlags&PropagationFlags.InheritOnly)!=0)continue;
            uint rights=unchecked((uint)rule.FileSystemRights),allowed=0x80000000U|0x20000000U|(uint)(FileSystemRights.Read|FileSystemRights.WriteData|FileSystemRights.AppendData|FileSystemRights.Synchronize);
            if(directory&&rule.IdentityReference.Value=="S-1-5-83-0"&&(rights&~allowed)==0)continue;
            throw new UnauthorizedAccessException("Recovery storage permissions changed");
        }
    }
}
