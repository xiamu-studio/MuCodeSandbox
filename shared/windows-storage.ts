export interface WindowsStorageStatus {
 imageBytes:number;temporaryBytes:number;catalogueBytes:number;reclaimableBytes:number;retainedBytes:number;
 imageCount:number;reclaimableFiles:number;unrecognizedEntries:number;quotaBytes:number;freeBytes:number;allocatedDiskGiB:number;unregisteredStorage:number;
 plan:string;canPrune:boolean;reason:'host-unavailable'|'unregistered-storage'|'dependencies-unavailable'|'unrecognized-cache-data'|null;
}
