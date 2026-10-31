export interface WindowsStorageStatus {
 imageBytes:number;imageAllocatedBytes:number;temporaryBytes:number;catalogueBytes:number;reclaimableBytes:number;retainedBytes:number;
 imageCount:number;reclaimableFiles:number;unrecognizedEntries:number;quotaBytes:number;freeBytes:number;allocatedDiskGiB:number;unregisteredStorage:number;
 plan:string;canPrune:boolean;reason:'host-unavailable'|'unregistered-storage'|'dependencies-unavailable'|'unrecognized-cache-data'|null;
}

export type WindowsCacheScheduleResult='pending'|'nothing'|'cleaned'|'blocked'|'failed';
export interface WindowsCacheScheduleStatus {enabled:boolean;nextAt:number|null;lastAt:number|null;result:WindowsCacheScheduleResult|null;files:number;bytes:number;running:boolean}
