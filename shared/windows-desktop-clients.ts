import type {DesktopAppId} from './guest-desktop.ts';
export interface WindowsDesktopClientState {
 id:DesktopAppId;state:'idle'|'starting'|'running'|'stopping'|'failed'|'unavailable';viewId:string|null;rendererProtected:true|null;
}
export interface WindowsDesktopClientsState {version:1;enabled:boolean;apps:WindowsDesktopClientState[];accountTested:false}
