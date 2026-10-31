export interface WindowsBrowserProfileStatus {
 version:1;
 state:'absent'|'unrecorded'|'compatible'|'newer'|'untrusted';
 selectedVersion:string;
 recordedVersion:string|null;
 issue:'permissions'|'changed'|'record'|'unreadable'|'adoption-pending'|'repair-pending'|'selection-unavailable'|'selection-changed'|null;
}
