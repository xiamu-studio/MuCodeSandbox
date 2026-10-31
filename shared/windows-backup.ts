export interface WindowsBackupReview {token:string;name:string;id:string;diskGiB:number;diskBytes:number;cpus:number;memoryGiB:number;proxy:string;expectedIp:string;timezone:string;expiresAt:string;resumeName?:string}
export interface WindowsBackupCleanupIssue {id?:string;retryable?:boolean;directory:string;message:string;sensitiveDataMayRemain:true}
export interface WindowsBackupOutputIssue {id:string;path:string;message:string;encrypted:true;retryable:boolean}
export interface WindowsBackupReleaseWarning {environmentId:string;message:string}
export interface WindowsSnapshotBackupSelection {environmentId:string;snapshotId:string;name:string;createdAt:string}
export interface WindowsBackupStatus {jobId?:string;operation?:'export'|'review'|'restore'|'cleanup';phase:'idle'|'running'|'succeeded'|'failed'|'cancelled';bytes:number;total:number;message:string;savedPath?:string;lastSaved?:{path:string;savedAt:string};lastSavedIssue?:string;review?:WindowsBackupReview;source?:WindowsSnapshotBackupSelection;cleanupIssues?:WindowsBackupCleanupIssue[];cleanupIndexIssue?:string;outputIssues?:WindowsBackupOutputIssue[];outputIndexIssue?:string;releaseIssues?:WindowsBackupReleaseWarning[]}
