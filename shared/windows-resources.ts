// Keep in sync with MuResourcePolicy.GrowthReserveLimit; this is an estimate, not an allocation.
export const WINDOWS_DISK_GROWTH_CUSHION_BYTES=16*1024**3;
export interface WindowsResources {
 session:string;totalMemoryBytes:number;availableMemoryBytes:number;memoryReserveBytes:number;memoryCriticalBytes:number;
 freeDiskBytes:number;diskFloorBytes:number;lastReservedGrowthBytes:number;virtualDiskLimitGiB:number;registeredDiskGiB:number;
 fenced:boolean;issue:'disk'|'memory'|'metrics-unavailable'|null;cleanupRunning:boolean;stopsConfirmed:boolean;
}
