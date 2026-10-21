export type WindowsSetupPhase='checking'|'download-base'|'extracting'|'download-tunnel'|'download-browser'|'download-display'|'creating'|'booting'|'installing-system'|'installing-desktop'|'verifying'|'sealing'|'cleaning'|'publishing'|'ready';
export interface WindowsSetupState {
 status:'needed'|'running'|'ready'|'failed'|'cancelled'|'interrupted';phase:WindowsSetupPhase;
 completedBytes:number;totalBytes:number;message:string|null;canPrepare:boolean;
}
