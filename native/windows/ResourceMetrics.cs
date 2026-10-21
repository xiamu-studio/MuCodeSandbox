// Compiled with the broker imports, and embedded in the fixed audit script.
public sealed class MuResourceMetrics {
    [StructLayout(LayoutKind.Sequential)] private struct Memory {
        public uint Length,Load;
        public ulong TotalPhysical,AvailablePhysical,TotalPage,AvailablePage,TotalVirtual,AvailableVirtual,Extended;
    }
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GlobalMemoryStatusEx(ref Memory value);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool GetDiskFreeSpaceEx(string path,out ulong available,out ulong total,out ulong free);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern uint GetCompressedFileSize(string path,out uint high);
    [DllImport("kernel32.dll")] private static extern void SetLastError(uint error);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool GetVolumePathName(string path,StringBuilder volume,uint length);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool GetVolumeNameForVolumeMountPoint(string path,StringBuilder name,uint length);
    public long totalMemory,availableMemory,freeDisk;
    public static long DiskFootprint(long virtualBytes){if(virtualBytes<=0)throw new ArgumentException("Virtual disk size required");return checked(virtualBytes+Math.Max(64L*1024*1024,virtualBytes/100));}
    public static MuResourceMetrics Read(string directory){
        var memory=new Memory{Length=(uint)Marshal.SizeOf(typeof(Memory))};ulong available,total,free;
        if(!GlobalMemoryStatusEx(ref memory)||!GetDiskFreeSpaceEx(directory,out available,out total,out free))throw new IOException("Host resource metrics unavailable");
        return new MuResourceMetrics{totalMemory=checked((long)memory.TotalPhysical),availableMemory=checked((long)memory.AvailablePhysical),freeDisk=checked((long)available)};
    }
    public static long AllocatedBytes(string file){
        SetLastError(0);uint high;uint low=GetCompressedFileSize(file,out high);if(low==uint.MaxValue&&Marshal.GetLastWin32Error()!=0)throw new IOException("Disk allocation metric unavailable");return checked((long)(((ulong)high<<32)|low));
    }
    public static string Volume(string path){
        var mount=new StringBuilder(32768);var name=new StringBuilder(128);
        if(!GetVolumePathName(path,mount,(uint)mount.Capacity)||!GetVolumeNameForVolumeMountPoint(mount.ToString(),name,(uint)name.Capacity))throw new IOException("Disk volume identity unavailable");return name.ToString();
    }
}
