export interface WindowsHostStatus {
 edition:string;build:string;architecture:'x64'|'arm64'|'other';supported:boolean;
 firmwareVirtualization:boolean|null;slat:boolean|null;hypervisorPresent:boolean;
 hyperV:'enabled'|'disabled'|'pending'|'unavailable'|'error';managementModule:boolean;vmmsRunning:boolean;
 sshCapability:'installed'|'missing'|'pending'|'error';sshClientPresent:boolean;restartRequired:boolean;ready:boolean;
 runtimeActive:boolean;canPrepare:boolean;
 operation:null|{id:string;status:'starting'|'running'|'completed'|'failed'|'interrupted';phase:string;changed:string[];restartNeeded:boolean;errorCode:number|null};
}
