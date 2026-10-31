import {randomUUID} from 'node:crypto';
import {isIPv4} from 'node:net';
import {egressErrorChecks} from '../../egress.ts';
import {errorMessage} from '../../errors.ts';
import {redact} from '../../validation.ts';
import type {Store} from '../../store.ts';
import type {Environment,EgressCheck} from '../../../shared/types.ts';
import {protectionKind,type ProtectionEvent,type ProtectionResolution} from '../../../shared/protection-events.ts';
import type {WindowsNetworkSession} from './session.ts';
import {windowsGuardDiagnostics} from './guard-diagnostics.ts';

export function windowsProtectionIssue(input:string){
 return redact(input).replace(/(?:^|\n)MU_EGRESS_DIAGNOSTICS=[^\n]*(?:\n|$)/g,'\n').trim().replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi,raw=>{
  try{const url=new URL(raw);return ['http:','https:','socks5:','socks5h:'].includes(url.protocol)?`${url.protocol}//${url.host}/[链接内容已隐藏]`:`${url.protocol}[链接内容已隐藏]`;}catch{return '[链接内容已隐藏]';}
 }).replace(/\bBearer\s+[^\s,;]+/gi,'Bearer ***').slice(0,2400);
}
const receivers=new Set(['ipwho','ipify','icanhazip']);
const states=new Set(['pending','success','timeout','command-timeout','tls-error','auth-error','dns-error','connection-error','invalid-response','cancelled']);
function safeChecks(error:unknown):EgressCheck[]{
 const pending=[error];let found:EgressCheck[]=[];for(let n=0;n<8&&pending.length;n++){const candidate=pending.shift();found=egressErrorChecks(candidate);if(found.length)break;if(candidate instanceof AggregateError)pending.push(...candidate.errors.slice(0,3));else if(candidate instanceof Error&&candidate.cause)pending.push(candidate.cause);}
 return found.filter(c=>receivers.has(c.receiver)&&states.has(c.status)).slice(0,3).map(c=>{
  const sshExitStatus=c.sshExitStatus;const result:EgressCheck={receiver:c.receiver,status:c.status};if(c.ip&&isIPv4(c.ip))result.ip=c.ip;if(typeof c.latencyMs==='number'&&Number.isFinite(c.latencyMs)&&c.latencyMs>=0&&c.latencyMs<=120000)result.latencyMs=c.latencyMs;if(sshExitStatus===null)result.sshExitStatus=null;else if(typeof sshExitStatus==='number'&&Number.isInteger(sshExitStatus)&&sshExitStatus>=0&&sshExitStatus<=255)result.sshExitStatus=sshExitStatus;
  const d=c.diagnostics;if(d&&[d.curlExitCode,d.httpStatus,d.tcpConnectMs,d.tlsHandshakeMs,d.firstByteMs,d.totalMs].every(Number.isFinite)&&Number.isInteger(d.curlExitCode)&&d.curlExitCode>=0&&d.curlExitCode<=255&&Number.isInteger(d.httpStatus)&&(d.httpStatus===0||d.httpStatus>=100&&d.httpStatus<=599)&&[d.tcpConnectMs,d.tlsHandshakeMs,d.firstByteMs,d.totalMs].every(n=>n>=0&&n<=120000))result.diagnostics={curlExitCode:d.curlExitCode,httpStatus:d.httpStatus,tcpConnectMs:d.tcpConnectMs,tlsHandshakeMs:d.tlsHandshakeMs,firstByteMs:d.firstByteMs,totalMs:d.totalMs};return result;
 });
}
export class WindowsProtectionEvents {
 private readonly memory=new Map<string,ProtectionEvent>();
 constructor(privateStore:Store){this.store=privateStore;}
 private readonly store:Store;
 private remember(event:ProtectionEvent){this.memory.set(event.id,event);while(this.memory.size>100)this.memory.delete(this.memory.keys().next().value!);}
 private warning(id:string){try{this.store.log(id,null,'防护记录未能完整写入磁盘；已保留内存记录，请下载诊断并检查磁盘空间。故障关闭仍会执行。','error');}catch{/* Recording is never a prerequisite for stopping. */}}
 record(e:Environment,error:unknown,issue=errorMessage(error),source:ProtectionEvent['source']='current'){
  const checks=source==='current'?safeChecks(error):[],clean=windowsProtectionIssue(issue),event:ProtectionEvent={id:randomUUID(),environmentId:e.id,at:source==='legacy'?e.updatedAt:new Date().toISOString(),kind:protectionKind(clean,checks),issue:clean,source,route:{mode:e.network.mode,host:e.network.host,port:e.network.port},expectedIp:e.network.egressLock?.expectedIp,observedIps:[...new Set(checks.flatMap(c=>c.ip?[c.ip]:[]))],checks,stopResult:source==='legacy'?'not-confirmed':'requested',resolvedAt:null,persisted:true};
  if(source==='current'){
   const guard=windowsGuardDiagnostics(error);if(guard){event.guard=guard;
    if(event.kind==='unknown'){
     if(['integrity-changed','invalid-digest'].includes(guard.reason))event.kind='integrity';
     else if(['lease-already-active','lease-inactive','lease-range','session-retired'].includes(guard.reason))event.kind='lease';
    }
   }
  }
  this.remember(event);try{this.store.addProtectionEvent(event);}catch{event.persisted=false;this.warning(e.id);}return event.id;
 }
 legacy(e:Environment){
  if(e.state!=='error'||!e.lastError||e.lastError==='应用已退出；环境已确认关闭'||!/curl:|防护|出口|回执|断网许可|联网许可|网络.*(?:变化|失效)|环境已确认关闭/.test(e.lastError))return;
  if(this.memory.size&&[...this.memory.values()].some(v=>v.environmentId===e.id))return;
  try{if(this.store.protectionEvents(e.id).length)return;}catch{/* Preserve a readable fallback when the journal cannot be read. */}
  this.record(e,e.lastError,e.lastError,'legacy');
 }
 list(id:string){
  const e=this.store.get(id);this.legacy(e);let saved:ProtectionEvent[]=[];try{saved=this.store.protectionEvents(id);}catch{this.warning(id);}
  const result=new Map(saved.map(v=>[v.id,v]));for(const event of this.memory.values())if(event.environmentId===id)result.set(event.id,structuredClone(event));return [...result.values()].sort((a,b)=>b.at.localeCompare(a.at)).slice(0,100);
 }
 stop(id:string,status:ProtectionEvent['stopResult'],issue?:string){
  const event=this.memory.get(id);if(event){event.stopResult=status;if(issue)event.stopIssue=windowsProtectionIssue(issue);}
  try{this.store.updateProtectionStop(id,status,issue?windowsProtectionIssue(issue):undefined);}catch{if(event){event.persisted=false;this.warning(event.environmentId);}}
 }
 confirmRecoveredStop(id:string){
  // Called only after the normal recovery path independently establishes Off.
  // Legacy summaries and previously failed stops retain their historical scope.
  try{for(const event of this.list(id))if(event.source==='current'&&event.stopResult==='requested'){
   this.remember(event);this.stop(event.id,'confirmed','应用重新打开后已核验虚拟机停止；确认时间 '+new Date().toISOString());
  }}catch{this.warning(id);}
 }
 resolve(e:Environment,session:WindowsNetworkSession){
  const receipts=session.verifiedReceipts.filter((v):v is typeof v&{receiver:EgressCheck['receiver'];latencyMs:number}=>receivers.has(v.receiver)&&typeof v.latencyMs==='number'&&Number.isFinite(v.latencyMs)&&v.latencyMs>=0).map(v=>({receiver:v.receiver,ip:v.ip,latencyMs:v.latencyMs}));
  const expected=e.network.egressLock?.expectedIp;if(!expected||new Set(receipts.map(v=>v.receiver)).size<2||receipts.some(v=>v.ip!==expected))return;
  const proof:ProtectionResolution={at:new Date().toISOString(),ip:expected,receipts};
  try{this.store.resolveProtectionEvents(e.id,proof);}catch{this.warning(e.id);for(const event of this.memory.values())if(event.environmentId===e.id)event.persisted=false;}
  for(const event of this.memory.values())if(event.environmentId===e.id&&!event.resolvedAt){event.resolvedAt=proof.at;event.resolution=proof;}
 }
}
