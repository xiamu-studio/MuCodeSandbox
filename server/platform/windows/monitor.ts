export type WindowsHostMonitorFailure='clock-backwards'|'poll-gap'|'snapshot-timeout'|'snapshot-changed'|'snapshot-adapters'|'snapshot-routes'|'snapshot-dns'|'snapshot-multiple'|'snapshot-error';
const failureText:Record<WindowsHostMonitorFailure,string>={
  'clock-backwards':'系统时间向后变化，监测时序无法确认',
  'poll-gap':'监测间隔过长，可能发生休眠或系统繁忙',
  'snapshot-timeout':'本机网络状态检查超时',
  'snapshot-changed':'本机网络状态快照发生变化',
  'snapshot-adapters':'本机网卡状态发生变化',
  'snapshot-routes':'本机网络路由发生变化',
  'snapshot-dns':'本机 DNS 配置发生变化',
  'snapshot-multiple':'本机多个网络配置项发生变化',
  'snapshot-error':'本机网络状态检查失败',
};
function changedCategory(before:string,after:string):WindowsHostMonitorFailure{
 try{
  const a=JSON.parse(before),b=JSON.parse(after),keys=['total','adapters','routes','dns'] as const;
  if(![a,b].every(value=>value&&typeof value==='object'&&Object.keys(value).length===keys.length&&keys.every(key=>typeof value[key]==='string'&&/^[a-f0-9]{64}$/.test(value[key]))))return 'snapshot-changed';
  const changed=keys.slice(1).filter(key=>a[key]!==b[key]);
  if(changed.length>1)return 'snapshot-multiple';
  return changed.length===1?({'adapters':'snapshot-adapters','routes':'snapshot-routes','dns':'snapshot-dns'} as const)[changed[0] as 'adapters'|'routes'|'dns']:'snapshot-changed';
 }catch{return 'snapshot-changed';}
}
export function windowsHostMonitorIssue(reason:WindowsHostMonitorFailure){return '宿主网络监测状态：'+failureText[reason];}
// A separate host watcher keeps running while an exit probe is outstanding.
// It never logs the network snapshot (which contains local addresses).
export class WindowsHostMonitor {
  private baseline='';
  private last=0;
  private busy=false;
  private busyAt=0;
  private timer:ReturnType<typeof setInterval>|undefined;
  private failed=false;
  private closed=false;
  private starting=false;
  private readonly snapshot:()=>Promise<string>;
  private readonly onFailure:(reason:WindowsHostMonitorFailure)=>void;
  constructor(snapshot:()=>Promise<string>,onFailure:(reason:WindowsHostMonitorFailure)=>void){this.snapshot=snapshot;this.onFailure=onFailure;}
  async start(){
    if(this.starting||this.baseline||this.closed)throw Error('Host monitor cannot be restarted');
    this.starting=true;
    try{
      const baseline=await this.snapshot();
      if(this.closed)throw Error('Host monitor stopped during startup');
      this.baseline=baseline;this.last=Date.now();
      this.timer=setInterval(()=>{void this.poll();},3000);
    }finally{this.starting=false;}
  }
  private fail(reason:WindowsHostMonitorFailure){if(!this.failed&&!this.closed){this.failed=true;this.onFailure(reason);}}
  async poll(now=Date.now()){
    if(this.closed||this.failed)return;
    if(now<this.last){this.fail('clock-backwards');return;}
    if(now-this.last>15000){this.fail('poll-gap');return;}
    this.last=now;
    if(this.busy){if(now-this.busyAt>8000)this.fail('snapshot-timeout');return;}
    this.busy=true;this.busyAt=now;
    try{
      const current=await this.snapshot(),completedAt=Date.now();
      // A delayed interval callback may not have observed the pending query.
      // Enforce the same deadline when it completes, even if unchanged.
      if(completedAt<this.busyAt)this.fail('clock-backwards');
      else if(completedAt-this.busyAt>8000)this.fail('snapshot-timeout');
      else if(current!==this.baseline)this.fail(changedCategory(this.baseline,current));
    }catch{this.fail('snapshot-error');}finally{this.busy=false;}
  }
  stop(){this.closed=true;if(this.timer)clearInterval(this.timer);}
}
