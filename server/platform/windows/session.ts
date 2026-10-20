import { randomUUID } from 'node:crypto';
import { isIPv4 } from 'node:net';

export interface GuardInspection { digest:string; leaseActive:boolean; remainingMs:number }
export interface GuardDriver {
  inspect():Promise<GuardInspection>;
  probe():Promise<{receiver:string;ip:string}[]>;
  activate():Promise<void>;
  renew():Promise<void>;
  revoke():Promise<void>;
  disconnect():Promise<void>;
  stop():Promise<void>;
}

// A failed session is terminal. Neither a late probe result nor another timer
// can reactivate it. Recovery always requires a new session and fresh receipts.
export class WindowsNetworkSession {
  readonly id=randomUUID();
  state:'closed'|'verifying'|'active'|'failed'='closed';
  private digest='';
  private generation=0;
  private ticking=false;
  private failure:Promise<void>|undefined;
  cleanupWarnings:unknown[]=[];
  get guardDigest(){return this.digest;}
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
  async open() {
    if(this.state!=='closed')throw Error('Session cannot be reopened');
    this.state='verifying';const epoch=++this.generation;
    try {
      const before=await this.driver.inspect();
      if(before.leaseActive || !/^[a-f0-9]{64}$/.test(before.digest))throw Error('Guard must start closed');
      this.digest=before.digest;
      this.receipts(await this.driver.probe());
      const after=await this.driver.inspect();
      if(epoch!==this.generation || this.state!=='verifying' || after.digest!==this.digest || after.leaseActive)throw Error('Guard changed during verification');
      await this.driver.activate();
      const active=await this.driver.inspect();
      if(epoch!==this.generation || this.state!=='verifying' || active.digest!==this.digest || !active.leaseActive || active.remainingMs<=0 || active.remainingMs>45000)throw Error('Network activation was not confirmed');
      this.state='active';
    } catch(error) {await this.fail();throw error;}
  }
  async tick() {
    if(this.state!=='active'||this.ticking)return;
    this.ticking=true;const epoch=this.generation;
    try {
      const before=await this.driver.inspect();
      if(before.digest!==this.digest || !before.leaseActive || before.remainingMs<=0 || before.remainingMs>45000)throw Error('Guard or lease changed');
      this.receipts(await this.driver.probe());
      const after=await this.driver.inspect();
      if(epoch!==this.generation || this.state!=='active' || after.digest!==this.digest || !after.leaseActive || after.remainingMs<=0)throw Error('Guard expired during measurement');
      await this.driver.renew();
    } catch(error) {await this.fail();throw error;} finally {this.ticking=false;}
  }
  fail() {
    if(this.failure)return this.failure;
    this.state='failed';this.generation++;
    // Tear down the only host egress path immediately, independently of SSH
    // revocation or Hyper-V shutdown succeeding. Every cleanup is attempted.
    this.failure=(async()=>{
      const results=await Promise.allSettled([this.driver.disconnect(),this.driver.revoke(),this.driver.stop()]);
      const errors=results.filter(r=>r.status==='rejected');
      this.cleanupWarnings=errors.map(r=>(r as PromiseRejectedResult).reason);
      // stop() must independently prove hypervisor state Off. Once confirmed,
      // a racing guest SSH revocation failure is a cleanup warning, not an
      // unproven network shutdown. An unconfirmed hypervisor stop still fails.
      if(results[2].status==='fulfilled')return;
      if(errors.length)throw new AggregateError(errors.map(r=>(r as PromiseRejectedResult).reason),'Protection failed; one or more cleanup operations could not be confirmed');
    })();
    return this.failure;
  }
}
