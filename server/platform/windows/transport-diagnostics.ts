import type {GuardTransportDiagnostics,TransportFailureCode} from '../../../shared/windows-guard-diagnostics.ts';
import {guestProxyFailureCodes,type GuestProxyFailureCode} from '../../../shared/windows-guard-diagnostics.ts';

// Classify only stderr from the owned fixed SSH forwarding child. No raw
// lines, addresses, channel numbers or other untrusted text enter evidence.
export class WindowsTransportDiagnostics {
 private value:GuardTransportDiagnostics={state:'starting',failures:{},ignoredLines:0,oversizedLines:0};
 private pending='';private discarding=false;private frozen=false;
 private guestPending='';private guestDiscarding=false;
 ready(){if(!this.frozen)this.value.state='ready';}
 ended(spawnFailed=false,exitCode?:number|null){if(!this.frozen){this.value.state=spawnFailed?'spawn-failed':'exited';this.value.exitAt=new Date().toISOString();if(Number.isInteger(exitCode)&&exitCode!>=0&&exitCode!<=255)this.value.exitCode=exitCode!;}}
 controlPipeError(){if(!this.frozen)this.record('CONTROL_PIPE_ERROR');}
 processError(){if(!this.frozen){this.record('PROCESS_ERROR');if(this.value.state==='starting')this.ended(true);}}
 freeze(){this.frozen=true;this.pending='';this.guestPending='';}
 snapshot():GuardTransportDiagnostics{return structuredClone(this.value);}
 feedGuest(chunk:Buffer|string){
  if(this.frozen)return;
  const text=typeof chunk==='string'?chunk.slice(0,8192):chunk.subarray(0,8192).toString('utf8');
  for(const character of text){
   if(character==='\n'){
    if(!this.guestDiscarding){
     const match=/^MU_GUEST_PROXY:(FOLLOWING|UNAVAILABLE|RESET|BROKEN_PIPE|REFUSED|TIMEOUT|TLS|DNS)$/.exec(this.guestPending.replace(/\r$/,''));
     if(match){const code=match[1];
      if(code==='FOLLOWING'||code==='UNAVAILABLE'){const guest=this.value.guestProxy??{state:'following' as const,failures:{}};guest.state=code==='FOLLOWING'?'following':'unavailable';this.value.guestProxy=guest;}
      else if((guestProxyFailureCodes as readonly string[]).includes(code)){const guest=this.value.guestProxy??{state:'following' as const,failures:{}};guest.failures[code as GuestProxyFailureCode]=Math.min(65535,(guest.failures[code as GuestProxyFailureCode]??0)+1);guest.lastFailureAt=new Date().toISOString();this.value.guestProxy=guest;}
     }
    }
    this.guestPending='';this.guestDiscarding=false;continue;
   }
   if(this.guestDiscarding)continue;
   if(this.guestPending.length>=80){this.guestPending='';this.guestDiscarding=true;continue;}
   this.guestPending+=character;
  }
  if(chunk.length>8192){this.guestPending='';this.guestDiscarding=true;}
 }
 feed(chunk:Buffer|string){
  if(this.frozen)return;
  // Work and memory per callback are bounded, even for a very large chunk.
  const text=typeof chunk==='string'?chunk.slice(0,8192):chunk.subarray(0,8192).toString('utf8');
  for(const character of text){
   if(character==='\n'){if(!this.discarding)this.line(this.pending.replace(/\r$/,''));this.pending='';this.discarding=false;continue;}
   if(this.discarding)continue;
   if(this.pending.length>=1024){this.pending='';this.discarding=true;this.value.oversizedLines=Math.min(65535,this.value.oversizedLines+1);continue;}
   this.pending+=character;
  }
  if(chunk.length>8192){this.pending='';this.discarding=true;this.value.oversizedLines=Math.min(65535,this.value.oversizedLines+1);}
 }
 private line(text:string){
  let code:TransportFailureCode|undefined;
  if(/^channel \d+: open failed: connect failed: Connection refused$/.test(text))code='FORWARD_CONNECT_REFUSED';
  else if(/^channel \d+: open failed: connect failed: Connection timed out$/.test(text))code='FORWARD_CONNECT_TIMEOUT';
  else if(/^channel \d+: open failed: administratively prohibited: /.test(text))code='FORWARD_ADMIN_DENIED';
  else if(/^channel \d+: open failed: connect failed: /.test(text)||/^connect_to .+ port \d+: failed\.$/.test(text))code='FORWARD_CONNECT_FAILED';
  else if(/^client_loop: send disconnect: (?:Connection reset|Connection reset by peer)$/.test(text))code='TRANSPORT_RESET';
  else if(/^client_loop: send disconnect: Broken pipe$/.test(text))code='TRANSPORT_BROKEN_PIPE';
  else if(/^Timeout, server .+ not responding\.$/.test(text))code='TRANSPORT_TIMEOUT';
  if(code)this.record(code);
  else if(text)this.value.ignoredLines=Math.min(65535,this.value.ignoredLines+1);
 }
 private record(code:TransportFailureCode){this.value.failures[code]=Math.min(65535,(this.value.failures[code]??0)+1);this.value.lastFailure=code;this.value.lastFailureAt=new Date().toISOString();}
}
