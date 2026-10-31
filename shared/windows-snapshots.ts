import type {WindowsBackupCleanupIssue} from './windows-backup.ts';
export interface WindowsSnapshotStaging {
 entries:{name:string;operation:'create'|'restore'}[];
 truncated:boolean;
}
export interface WindowsSnapshotStagingReview {
 id:string;operation:'create'|'restore';phase:'copy'|'deleting'|'done';
 token:string;bytes:number;files:number;partialReceipt:boolean;
}
export interface WindowsSnapshotStagingReviewState {
 phase:'idle'|'running'|'ready'|'failed';jobId?:string;review?:WindowsSnapshotStagingReview;
}
export interface WindowsSnapshotProductStatus {
 initialized:boolean;
 enabled:boolean;
 available:boolean;
 recoveryAvailable:boolean;
 liveDeletionAvailable?:boolean;
 exportAvailable?:boolean;
 stagingCleanupAvailable?:boolean;
 activeIds:string[];
 pendingIds:string[];
 issues:{id:string|null;message:string}[];
 cleanupIssues?:WindowsBackupCleanupIssue[];
 cleanupIndexIssue?:string;
}

// Public catalog only. Owner-encrypted configuration stays behind the broker.
export interface WindowsSnapshotSummary {
 id:string;
 environmentId:string;
 name:string;
 createdAt:string;
 bytes:number;
 cpus:number;
 memoryGiB:number;
 diskGiB:number;
 imageSha256:string;
 seedSha256:string;
}
export interface WindowsSnapshotDeletion {
 id:string;
 environmentId:string;
 name:string;
 createdAt:string;
 phase:'intent'|'retired';
 bytes:number;
}
