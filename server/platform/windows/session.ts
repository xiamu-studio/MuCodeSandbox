import { randomUUID } from 'node:crypto';
import { isIPv4 } from 'node:net';
import {attachWindowsGuardDiagnostics,changedGuardComponents,guardFailureCode,guardFailureSource,type GuardInspection} from './guard-diagnostics.ts';
import type {GuardDiagnostics,GuardReason,GuardStage,GuardTransportDiagnostics} from '../../../shared/windows-guard-diagnostics.ts';

export type {GuardInspection} from './guard-diagnostics.ts';
export interface GuardDriver {
  inspect(signal?:AbortSignal):Promise<GuardInspection>;
  probe(signal?:AbortSignal):Promise<{receiver:string;ip:string;latencyMs?:number}[]>;
  retryClosedProbe?(error:unknown):boolean;
  activate(signal?:AbortSignal):Promise<void>;
  renew(signal?:AbortSignal):Promise<void>;
  revoke():Promise<void>;
  disconnect():Promise<void>;
  stop():Promise<void>;
  transportDiagnostics?():GuardTransportDiagnostics|undefined;
}
function cleanup(work:()=>Promise<void>){try{return Promise.resolve(work());}catch(error){return Promise.reject(error);}}

// A failed session is terminal. Neither a late probe result nor another timer
// can reactivate it. Recovery always requires a new session and fresh receipts.
export class WindowsNetworkSession {
  readonly id=randomUUID();
  state:'closed'|'verifying'|'active'|'failed'='closed';
  private digest='';
  private components:GuardInspection['components'];
  private generation=0;
  private ticking=false;
  private readonly operationController=new AbortController();
  private failure:Promise<void>|undefined;
  private normalStop:Promise<void>|undefined;
  private normalStopAbort:AbortController|undefined;
  private receiptsAtOpen:{receiver:string;ip:string;latencyMs?:number}[]=[];
  private receiptsAt:string|undefined;
  onFailure:((error:unknown)=>void)|undefined;
  private failureReported=false;
  get verifiedReceipts(){return this.state==='active'?structuredClone(this.receiptsAtOpen):[];}
  get verifiedAt(){return this.state==='active'?this.receiptsAt:undefined;}
  cleanupWarnings:unknown[]=[];
  normalStopOutcome:'closed'|'fallback'|undefined;
  get guardDigest(){return this.digest;}
  get guardComponents(){return this.components?structuredClone(this.components):undefined;}
  readonly driver:GuardDriver;
  readonly expectedIp:string;
  constructor(driver:GuardDriver,expectedIp:string) {
    this.driver=driver;this.expectedIp=expectedIp;
    if(!isIPv4(expectedIp)) throw Error('Invalid approved exit');
  }
  private receipts(values:{receiver:string;ip:string}[]) {
    if(values.length<2 || new Set(values.map(v=>v.receiver)).size!==values.length ||
      values.some(v=>!v.receiver || !isIPv4(v.ip) || v.ip!==this.expectedIp)) throw Error('Two distinct matching exit receipts are required');
  }
  private observe(value:GuardInspection){const changed=changedGuardComponents(this.components,value.components);return {leaseActive:value.leaseActive,remainingMs:value.remainingMs,digestMatches:value.digest===this.digest,...(changed?{changedComponents:changed}:{})};}
  private reason(value:GuardInspection,epoch:number,expectedState:'verifying'|'active',closed=false):GuardReason|undefined{
    if(epoch!==this.generation||this.state!==expectedState)return 'session-retired';
    if(!/^[a-f0-9]{64}$/.test(value.digest))return 'invalid-digest';
    if(value.digest!==this.digest)return 'integrity-changed';
    if(closed){if(value.leaseActive)return 'lease-already-active';if(value.remainingMs!==0)return 'lease-range';return;}
    if(!value.leaseActive)return 'lease-inactive';
    if(value.remainingMs<=0||value.remainingMs>45000||!Number.isFinite(value.remainingMs))return 'lease-range';
  }
  private async measured<T>(evidence:GuardDiagnostics,stage:GuardStage,key:keyof GuardDiagnostics['durations'],work:()=>Promise<T>):Promise<T>{
    evidence.stage=stage;const start=performance.now();try{return await work();}finally{evidence.durations[key]=Math.min(86400000,Math.max(0,Math.round(performance.now()-start)));}
  }
  private diagnosticFailure(error:unknown,evidence:GuardDiagnostics,reason?:GuardReason){
    const source=guardFailureSource(error);if(source)evidence.failureSource=source;
    const code=guardFailureCode(error);if(code)evidence.failureCode=code;
    try{const transport=this.driver.transportDiagnostics?.();if(transport)evidence.transport=transport;}catch{/* Diagnostics cannot obstruct the original protection failure. */}
    evidence.reason=reason??({'before-inspection':'inspection-failed',probe:'probe-failed','after-inspection':'inspection-failed',activation:'activation-failed','active-inspection':'inspection-failed',renewal:'renewal-failed','access-inspection':'inspection-failed','session-state':'session-retired'} as const)[evidence.stage];
    return attachWindowsGuardDiagnostics(error,evidence);
  }
  async open(signal?:AbortSignal) {
    if(this.state!=='closed')throw Error('Session cannot be reopened');
    signal=signal?AbortSignal.any([signal,this.operationController.signal]):this.operationController.signal;
    this.state='verifying';const epoch=++this.generation;
    const evidence:GuardDiagnostics={operation:'open',stage:'before-inspection',reason:'inspection-failed',durations:{},verifiedReceiptCount:0};let reason:GuardReason|undefined;
    try {
      signal?.throwIfAborted();
      const before=await this.measured(evidence,'before-inspection','beforeInspectMs',()=>this.driver.inspect(signal));
      signal?.throwIfAborted();
      this.digest=before.digest;this.components=before.components?structuredClone(before.components):undefined;evidence.before=this.observe(before);
      reason=this.reason(before,epoch,'verifying',true);if(reason)throw Error('Guard must start closed');
      const receipts=await this.measured(evidence,'probe','probeMs',async()=>{
        try{return await this.driver.probe(signal);}
        catch(error){
          signal?.throwIfAborted();
          if(epoch!==this.generation||this.state!=='verifying'||!this.driver.retryClosedProbe?.(error))throw error;
          const again=await this.driver.inspect(signal);evidence.after=this.observe(again);reason=this.reason(again,epoch,'verifying',true);if(reason)throw Error('Guard changed before retry');
          signal?.throwIfAborted();
          return this.driver.probe(signal);
        }
      });signal?.throwIfAborted();const checkedAt=new Date().toISOString();reason='receipts-invalid';this.receipts(receipts);reason=undefined;evidence.verifiedReceiptCount=receipts.length;
      const after=await this.measured(evidence,'after-inspection','afterInspectMs',()=>this.driver.inspect(signal));evidence.after=this.observe(after);
      reason=this.reason(after,epoch,'verifying',true);if(reason)throw Error('Guard changed during verification');
      signal?.throwIfAborted();
      await this.measured(evidence,'activation','activateMs',()=>this.driver.activate(signal));
      const active=await this.measured(evidence,'active-inspection','activeInspectMs',()=>this.driver.inspect(signal));evidence.active=this.observe(active);
      reason=this.reason(active,epoch,'verifying');if(reason)throw Error('Network activation was not confirmed');
      signal?.throwIfAborted();
      this.receiptsAtOpen=structuredClone(receipts);this.receiptsAt=checkedAt;this.state='active';
    } catch(error) {return this.failed(this.diagnosticFailure(error,evidence,reason));}
  }
  async tick() {
    if(this.state!=='active'||this.ticking)return;
    this.ticking=true;const epoch=this.generation;
    const evidence:GuardDiagnostics={operation:'tick',stage:'before-inspection',reason:'inspection-failed',durations:{},verifiedReceiptCount:0};let reason:GuardReason|undefined;
    try {
      const before=await this.measured(evidence,'before-inspection','beforeInspectMs',()=>this.driver.inspect(this.operationController.signal));evidence.before=this.observe(before);
      reason=this.reason(before,epoch,'active');if(reason)throw Error('Guard or lease changed');
      this.operationController.signal.throwIfAborted();
      const receipts=await this.measured(evidence,'probe','probeMs',()=>this.driver.probe(this.operationController.signal));this.operationController.signal.throwIfAborted();const checkedAt=new Date().toISOString();reason='receipts-invalid';this.receipts(receipts);reason=undefined;evidence.verifiedReceiptCount=receipts.length;
      const after=await this.measured(evidence,'after-inspection','afterInspectMs',()=>this.driver.inspect(this.operationController.signal));evidence.after=this.observe(after);
      reason=this.reason(after,epoch,'active');if(reason)throw Error('Guard expired during measurement');
      await this.measured(evidence,'renewal','renewMs',()=>this.driver.renew(this.operationController.signal));
      if(epoch===this.generation&&this.state==='active'){this.receiptsAtOpen=structuredClone(receipts);this.receiptsAt=checkedAt;}
    } catch(error) {
      // A probe retired by a user stop cannot renew or reopen the session.
      // Its late result is irrelevant to the already initiated egress teardown.
      // Explicit protection fail() still interrupts normal shutdown immediately.
      if(epoch!==this.generation&&this.normalStop)return;
      await this.failed(this.diagnosticFailure(error,evidence,reason));
    } finally {this.ticking=false;}
  }
  private async failed(error:unknown):Promise<never>{
    // Start every independent teardown before recording. The journal may fail
    // or block, but it cannot become a prerequisite for revoking network access.
    const stopping=this.fail();
    if(!this.failureReported){this.failureReported=true;try{this.onFailure?.(error);}catch{/* Diagnostics must not obstruct the already initiated stop. */}}
    try{await stopping;}catch(stopError){throw new AggregateError([error,stopError],'出口核验失败且停机未能确认',{cause:error});}throw error;
  }
  async transportFailed(){
    const evidence:GuardDiagnostics={operation:'monitor',stage:'session-state',reason:'session-retired',durations:{},verifiedReceiptCount:0};
    const error=this.diagnosticFailure(Error('出口转发会话意外中断'),evidence,'session-retired');
    try{await this.failed(error);}catch{/* Stop and record are handled by the owning manager. */}
  }
  stopNormally(prepare:(signal:AbortSignal)=>Promise<void>,timeoutMs=5000):Promise<void> {
    if(this.failure)return this.failure;
    if(this.normalStop)return this.normalStop;
    if(this.state!=='active')return this.fail();
    if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw Error('Invalid normal stop deadline');
    this.state='failed';this.generation++;
    this.normalStopOutcome='fallback';
    const controller=new AbortController();this.normalStopAbort=controller;
    this.operationController.abort();
    const aborted=new Promise<{done:false}>(resolve=>controller.signal.addEventListener('abort',()=>resolve({done:false}),{once:true}));
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    const within=<T>(work:()=>Promise<T>)=>Promise.race([Promise.resolve().then(work).then(value=>({done:true as const,value})),aborted]);
    this.normalStop=(async()=>{
      try{
        const gate=await within(()=>Promise.allSettled([cleanup(()=>this.driver.disconnect()),cleanup(()=>this.driver.revoke())]));
        if(gate.done)this.cleanupWarnings.push(...gate.value.filter(value=>value.status==='rejected').map(value=>value.reason));
        if(gate.done&&gate.value.every(value=>value.status==='fulfilled')&&!controller.signal.aborted&&!this.failure){
          const prepared=await within(()=>{controller.signal.throwIfAborted();return prepare(controller.signal);});
          if(prepared.done&&!controller.signal.aborted&&!this.failure)this.normalStopOutcome='closed';
        }
      }catch(error){this.cleanupWarnings.push(error);}
      finally{clearTimeout(timer);try{await this.fail();}finally{if(this.normalStopAbort===controller)this.normalStopAbort=undefined;}}
    })();
    return this.normalStop;
  }
  fail() {
    if(this.failure)return this.failure;
    this.normalStopAbort?.abort();
    this.state='failed';this.generation++;
    this.operationController.abort();
    // Tear down the only host egress path immediately, independently of SSH
    // revocation or Hyper-V shutdown succeeding. Every cleanup is attempted.
    this.failure=(async()=>{
      const results=await Promise.allSettled([cleanup(()=>this.driver.disconnect()),cleanup(()=>this.driver.revoke()),cleanup(()=>this.driver.stop())]);
      const errors=results.filter(r=>r.status==='rejected');
      this.cleanupWarnings.push(...errors.map(r=>(r as PromiseRejectedResult).reason));
      // stop() must independently prove hypervisor state Off. Once confirmed,
      // a racing guest SSH revocation failure is a cleanup warning, not an
      // unproven network shutdown. An unconfirmed hypervisor stop still fails.
      if(results[2].status==='fulfilled')return;
      if(errors.length)throw new AggregateError(errors.map(r=>(r as PromiseRejectedResult).reason),'Protection failed; one or more cleanup operations could not be confirmed');
    })();
    return this.failure;
  }
}
