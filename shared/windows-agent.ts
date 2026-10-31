export const WINDOWS_AGENT_VERSION='2.1.310';
export interface WindowsAgentStatus {
 version:1;supported:boolean;enabled:boolean;
 state:'stopped'|'unavailable'|'verified'|'missing'|'pending'|'untrusted'|'busy';
 installedVersion:string|null;availableVersion:string;
 architecture:'x86_64';runtime:'native';message:string;
}
