export interface WindowsRecoveryCandidate {
 id:string;name:string;cpus:number;memoryGiB:number;diskGiB:number;
 platformId:string|null;imageSha256:string|null;ready:boolean;issue:string|null;
}
export interface WindowsRecoveryReview {
 review:{version:1;id:string;name:string;platformId:string;cpus:number;memoryGiB:number;diskGiB:number;imageSha256:string;diskSha256:string;seedSha256:string;registryFingerprint:string;registeredDiskGiB:number};
 plan:string;registered:false;state:'Off';diskPreserved:true;
}
export interface WindowsRecoverySnapshot {
 phase:'idle'|'reviewing'|'reviewed'|'applying'|'completed'|'cancelled'|'failed';
 candidates:WindowsRecoveryCandidate[];issue:string|null;selectedId:string|null;
 review:WindowsRecoveryReview|null;message:string;canCancel:boolean;
}
