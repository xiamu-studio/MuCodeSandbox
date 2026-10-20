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
  private readonly snapshot:()=>Promise<string>;
  private readonly onFailure:()=>void;
  constructor(snapshot:()=>Promise<string>,onFailure:()=>void){this.snapshot=snapshot;this.onFailure=onFailure;}
  async start(){
    if(this.baseline||this.closed)throw Error('Host monitor cannot be restarted');
    this.baseline=await this.snapshot();this.last=Date.now();
    this.timer=setInterval(()=>{void this.poll();},3000);
  }
  private fail(){if(!this.failed&&!this.closed){this.failed=true;this.onFailure();}}
  async poll(now=Date.now()){
    if(this.closed||this.failed)return;
    if(now<this.last||now-this.last>15000){this.fail();return;}
    this.last=now;
    if(this.busy){if(now-this.busyAt>8000)this.fail();return;}
    this.busy=true;this.busyAt=now;
    try{if(await this.snapshot()!==this.baseline)this.fail();}catch{this.fail();}finally{this.busy=false;}
  }
  stop(){this.closed=true;if(this.timer)clearInterval(this.timer);}
}
