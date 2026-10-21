export interface WindowsResources {
 session:string;totalMemoryBytes:number;availableMemoryBytes:number;memoryReserveBytes:number;memoryCriticalBytes:number;
 freeDiskBytes:number;diskFloorBytes:number;lastReservedGrowthBytes:number;virtualDiskLimitGiB:number;registeredDiskGiB:number;
 fenced:boolean;issue:'disk'|'memory'|'metrics-unavailable'|null;cleanupRunning:boolean;stopsConfirmed:boolean;
}
