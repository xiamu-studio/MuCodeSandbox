import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {createAcceptanceLab,type AcceptanceLabOptions} from '../../acceptance-lab.ts';
import {AppError} from '../../errors.ts';
import {windowsHostLabStatusSchema,windowsHostLabWindowSchema,type WindowsHostLabStatus} from '../../../shared/windows-host-lab.ts';

type Lab=Awaited<ReturnType<typeof createAcceptanceLab>>;
const unavailable=()=>new AppError('本机对照尚未完成 Windows 桌面验收，暂未开放',409,'HOST_LAB_UNAVAILABLE');
// This comparison is deliberately a host-side local receiver. It never creates
// an environment, reads a personal profile, supplies guest access or calls a provider.
export class WindowsHostLab{
 readonly enabled:boolean;readonly windowKey=randomBytes(32).toString('hex');
 private current:{runId:string;lab:Lab;info:ReturnType<Lab['info']>}|undefined;private starting:Promise<WindowsHostLabStatus>|undefined;private stopping:Promise<WindowsHostLabStatus>|undefined;private closed=false;private issue:string|undefined;
 private readonly create:(options:AcceptanceLabOptions)=>Promise<Lab>;
 constructor(enabled=false,create:(options:AcceptanceLabOptions)=>Promise<Lab>=createAcceptanceLab){this.enabled=enabled;this.create=create;}
 status():WindowsHostLabStatus{
  if(this.current&&!this.stopping&&!this.issue)this.current.info=this.current.lab.info();const info=this.current?.info;return windowsHostLabStatusSchema.parse({enabled:this.enabled,phase:this.stopping?'stopping':this.starting?'starting':this.issue?'error':info?'running':'stopped',running:!!info,...(info?{runId:this.current!.runId,url:info.url,dnsPort:info.dnsPort,stunPort:info.stunPort,receiptCount:info.receiptCount,eventCount:info.eventCount,modelCalls:info.modelCalls}:{receiptCount:0,eventCount:0,modelCalls:0}),scope:'windows-host-control-loopback',...(this.issue?{issue:this.issue}:{})});
 }
 start(){
  if(!this.enabled||this.closed)throw unavailable();if(this.stopping)throw new AppError('本机接收端正在关闭，请等待原操作结束',409,'HOST_LAB_BUSY');if(this.starting)return this.starting;if(this.current)return Promise.resolve(this.status());
  this.issue=undefined;this.starting=(async()=>{try{const runId=randomUUID(),lab=await this.create({accessToken:randomBytes(32).toString('hex'),runId});this.current={runId,lab,info:lab.info()};return this.status();}catch{this.issue='本机接收端未能启动，请核对本地端口后重试';throw new AppError(this.issue,409,'HOST_LAB_START_FAILED');}})().finally(()=>{this.starting=undefined;});return this.starting.then(()=>this.status());
 }
 stop(expectedRunId?:string){
  if(expectedRunId&&(this.starting||this.current&&this.current.runId!==expectedRunId))throw new AppError('本机检测会话已变化，请刷新后重试',409,'HOST_LAB_CHANGED');
  if(this.stopping)return this.stopping;
  this.stopping=(async()=>{try{await this.starting?.catch(()=>{});const current=this.current;if(current){await current.lab.close();if(this.current===current)this.current=undefined;}this.issue=undefined;return this.status();}catch{this.issue='本机接收端关闭尚未确认，请保留状态并重试';throw new AppError(this.issue,409,'HOST_LAB_STOP_UNCONFIRMED');}})().finally(()=>{this.stopping=undefined;});return this.stopping.then(()=>this.status());
 }
 describe(appOrigin:string,expectedRunId:string){
  if(this.current?.runId!==expectedRunId)throw new AppError('本机检测会话已变化，请刷新后重试',409,'HOST_LAB_CHANGED');
  if(!this.enabled||this.closed||this.starting||this.stopping||this.issue||!this.current)throw unavailable();const origin=new URL(appOrigin);if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password||origin.origin!==appOrigin)throw unavailable();
  const payload={version:1 as const,runId:this.current.runId,appOrigin,url:this.current.lab.info().url,expiresAt:Date.now()+10000};return windowsHostLabWindowSchema.parse({...payload,signature:createHmac('sha256',Buffer.from(this.windowKey,'hex')).update(JSON.stringify(payload)).digest('hex')});
 }
 records(){return {runId:this.current?.runId??null,receipts:this.current?.lab.receipts??[],events:this.current?.lab.events??[]};}
 async close(){this.closed=true;await this.stop();}
}
