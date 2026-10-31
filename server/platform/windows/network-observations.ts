import type {Environment} from '../../../shared/types.ts';
import type {ConnectionQuery,ProbeProvider,ObservationFailure} from '../../../shared/network-observations.ts';
import {ZodError} from 'zod';
import {NetworkObserver,observationKey} from '../../network-observations.ts';
import {parseEgress} from '../../egress.ts';
import {AppError,SshProcessError,errorMessage} from '../../errors.ts';
import type {RunOptions} from '../../process.ts';
import type {WindowsManager} from './manager.ts';
import type {HyperVRuntime} from './runtime.ts';
import type {WindowsNetworkSession} from './session.ts';

type Runtime=Pick<HyperVRuntime,'guest'|'management'>;
type Manager=Pick<WindowsManager,'store'|'sessions'|'guestOperationBusy'|'assertAccess'|'profile'>;
export function observationFailureCategory(error:unknown):ObservationFailure {
 if(error instanceof SshProcessError&&error.exitStatus===255)return 'connection';
 if(error instanceof AppError&&error.code==='TIMEOUT')return 'timeout';
 if(error instanceof AppError&&['CANCELLED','CONFIGURATION_CHANGED'].includes(error.code))return 'interrupted';
 if(error instanceof SyntaxError||error instanceof ZodError)return 'invalid';
 const message=errorMessage(error);
 if(/curl:\s*\(28\)/.test(message))return 'timeout';
 if(/curl:\s*\((35|51|58|60|77|80|82|83|90|91)\)/.test(message))return 'tls';
 if(/curl:\s*\((5|6)\)/.test(message))return 'dns';
 if(/curl:\s*\((7|52|56|97)\)/.test(message))return 'connection';
 if(/407|(?:SOCKS|proxy).*auth|authentication/i.test(message))return 'auth';
 return 'unknown';
}
// The shared collector retains only connection/DNS metadata. Windows supplies
// protected guest SSH and session epochs; no host curl, browser history or
// host adapter address is substituted for an actual guest exit receipt.
export class WindowsNetworkObservations {
 readonly observer:NetworkObserver;
 private manager:Manager;private runtime:Runtime;
 private epochs=new Map<string,{session:WindowsNetworkSession|undefined;value:number;key:string}>();
 private receipts=new Map<string,string>();private issues=new Map<string,string>();
 private controller=new AbortController();private closed=false;private timer:ReturnType<typeof setInterval>|undefined;
 constructor(manager:Manager,runtime:Runtime,automatic=true){
  this.manager=manager;this.runtime=runtime;
  this.observer=new NetworkObserver(manager.store,{management:(environment,command,options)=>this.read(environment,command,options,true)},(environment,provider)=>this.probe(environment,provider),environment=>this.available(environment),id=>this.epoch(id),false,observationFailureCategory);
  if(automatic){this.timer=setInterval(()=>{void this.tick().catch(()=>{});},8000);this.timer.unref();}
 }
 private available(environment:Environment){this.epoch(environment.id);return !this.closed&&!this.manager.guestOperationBusy(environment.id)&&this.manager.sessions.get(environment.id)?.state==='active'&&this.epochs.get(environment.id)?.key===observationKey(environment);}
 private epoch(id:string){
  const session=this.manager.sessions.get(id),old=this.epochs.get(id);if(old&&old.session===session)return old.value;
  const value=(old?.value??0)+1;this.epochs.set(id,{session,value,key:observationKey(this.manager.store.get(id))});this.receipts.delete(id);this.issues.delete(id);this.observer.forget(id);return value;
 }
 private sync(environment:Environment){
  const generation=this.epoch(environment.id),session=this.manager.sessions.get(environment.id),at=session?.verifiedAt;
  if(!session||!at||environment.state!=='running'||!this.available(environment))return;
  const stamp=`${session.id}:${at}:${observationKey(environment)}`;if(this.receipts.get(environment.id)===stamp)return;
  const rows=session.verifiedReceipts;if(rows.length<2||new Set(rows.map(row=>row.receiver)).size!==rows.length||rows.some(row=>row.ip!==environment.network.egressLock?.expectedIp)||!Number.isFinite(Date.parse(at)))return;
  try{
   this.observer.recordVerification(environment,{status:'verified',actualIp:rows[0].ip,checkedAt:at});
   for(const row of rows)if((row.receiver==='ipwho'||row.receiver==='ipify')&&typeof row.latencyMs==='number'&&Number.isFinite(row.latencyMs)&&row.latencyMs>=0)this.observer.record(environment,row.receiver,{ip:row.ip,country:'',city:'',latencyMs:row.latencyMs,source:'guest'},generation,at);
   this.receipts.set(environment.id,stamp);this.issues.delete(environment.id);
  }catch{this.issues.set(environment.id,'出口检测记录暂不可保存；历史可能存在缺口，联网防护独立运行');}
 }
 private async read(environment:Environment,command:string[],options:RunOptions={},management=false){
  const session=this.manager.sessions.get(environment.id),generation=this.epoch(environment.id);
  const current=()=>{if(this.closed||!session||session.state!=='active'||this.manager.sessions.get(environment.id)!==session||this.epoch(environment.id)!==generation||this.manager.guestOperationBusy(environment.id)||this.manager.store.get(environment.id).state!=='running'||observationKey(this.manager.store.get(environment.id))!==observationKey(environment))throw new AppError('环境或线路已变化，请重新读取网络记录',409,'CONFIGURATION_CHANGED');};
  current();await this.manager.assertAccess(environment.id);current();const config=await this.manager.profile(environment);current();
  const signal=options.signal?AbortSignal.any([options.signal,this.controller.signal]):this.controller.signal;signal.throwIfAborted();
  const result=await this.runtime[management?'management':'guest'](config,command,{...options,signal});current();signal.throwIfAborted();await this.manager.assertAccess(environment.id);current();signal.throwIfAborted();return result;
 }
 private async probe(environment:Environment,provider:ProbeProvider){
  const started=performance.now();const output=await this.read(environment,['/usr/bin/curl','-q','--ipv4','--fail','--silent','--show-error','--proto','=https','--max-time','8','--connect-timeout','4','--max-filesize','65536',provider==='ipwho'?'https://ipwho.is/':'https://api.ipify.org/?format=json'],{timeoutMs:12000,maxBytes:65536});
  const result=parseEgress(output);return {ip:result.ip,country:result.country??'',city:result.city??'',latencyMs:Math.round(performance.now()-started),source:'guest' as const};
 }
 async tick(){if(this.closed)return;for(const environment of this.manager.store.list())this.sync(environment);await this.observer.tick();}
 info(id:string,query?:ConnectionQuery){const environment=this.manager.store.get(id);this.sync(environment);const result=this.observer.info(environment,query),issue=this.issues.get(id);return issue?{...result,capture:'error' as const,captureIssue:issue}:result;}
 async sample(id:string){const environment=await this.manager.assertAccess(id);this.sync(environment);await this.observer.sample(environment);return this.info(id);}
 async close(){this.closed=true;if(this.timer)clearInterval(this.timer);this.controller.abort();await this.observer.close();}
}
