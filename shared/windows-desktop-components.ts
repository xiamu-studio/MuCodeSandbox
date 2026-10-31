import type {DesktopAppId} from './guest-desktop.ts';
export const WINDOWS_DESKTOP_COMPONENT_RELEASES=[
 {id:'grok-bot' as const,name:'Grok Bot',version:'0.68.1',downloadBytes:104614112},
 {id:'claude-desktop' as const,name:'Claude Desktop',version:'2.31226.1',downloadBytes:181377680},
] as const;
export interface WindowsDesktopComponentStatus {
 id:DesktopAppId;state:'stopped'|'unavailable'|'verified'|'missing'|'pending'|'untrusted'|'busy';
 installedVersion:string|null;availableVersion:string;architecture:'amd64';message:string;
}
export interface WindowsDesktopComponentsStatus {version:1;enabled:boolean;apps:WindowsDesktopComponentStatus[]}
