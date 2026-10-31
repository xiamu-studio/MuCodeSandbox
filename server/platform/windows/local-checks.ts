import {randomUUID,createHash} from 'node:crypto';
import type {WindowsManager} from './manager.ts';
import type {WindowsBrowser} from './browser.ts';
import type {WindowsNetworkSession} from './session.ts';
import type {RunOptions} from '../../process.ts';
import {AppError} from '../../errors.ts';
import {WindowsBrowserCheckFailure} from './local-check-browser.ts';
import {WindowsLocalCheckRecords} from './local-check-records.ts';
import {windowsBrowserCheckResultSchema,type WindowsLocalCheckReport} from '../../../shared/windows-local-check.ts';

export const WINDOWS_LOCAL_CHECK_SCOPE='所选 Linux 沙箱的实时防护、临时浏览器上下文、合成登录和本地模拟消息事件；不覆盖公网流传输时序、实际 DNS 或 WebRTC 泄漏，不调用付费模型。';
export type WindowsLocalCheckBrowser=Pick<WindowsBrowser,'running'|'open'|'localCheck'>;
export class WindowsLocalChecks{
 readonly manager:Pick<WindowsManager,'store'|'sessions'|'assertAccess'|'submit'>;readonly browser:WindowsLocalCheckBrowser;readonly enabled:boolean;
 readonly records:WindowsLocalCheckRecords;readonly reports=new Map<string,WindowsLocalCheckReport>();
 constructor(manager:Pick<WindowsManager,'store'|'sessions'|'assertAccess'|'submit'>,browser:WindowsLocalCheckBrowser,enabled=false){
  this.manager=manager;this.browser=browser;this.enabled=enabled;this.records=new WindowsLocalCheckRecords(manager.store);
  for(const report of this.records.restore())this.reports.set(report.environmentId,report);
 }
 status(){const existing=new Set(this.manager.store.list().map(value=>value.id));for(const id of this.reports.keys())if(!existing.has(id))this.reports.delete(id);this.records.forgetMissing(existing);return {enabled:this.enabled,reports:[...this.reports.values()],issue:this.records.issue??null};}
 async start(id:string){
  if(!this.enabled)throw new AppError('无账号检测尚未完成 Windows 实机验收，暂未开放运行',409,'LOCAL_CHECK_UNAVAILABLE');
  const environment=this.manager.store.get(id),session=this.manager.sessions.get(id);
  if(environment.kind!=='vm'||environment.state!=='running'||!environment.network.strict||!environment.network.transparent||session?.state!=='active')throw new AppError('请先启动已配置强制防护的 Linux 沙箱',409,'LAB_PROTECTED_VM_REQUIRED');
  this.records.writable(id);
  let release!:()=>void,startError:unknown;const admitted=new Promise<void>(resolve=>release=resolve);
  const now=new Date().toISOString(),report:WindowsLocalCheckReport={version:1,id:randomUUID(),jobId:'00000000-0000-4000-8000-000000000000',environmentId:id,environmentName:environment.name,sessionId:session.id,environmentUpdatedAt:environment.updatedAt,startedAt:now,checkedAt:now,state:'running',accountFree:true,paidModelCalls:0,scope:WINDOWS_LOCAL_CHECK_SCOPE,checks:[]};
  const configurationDigest=createHash('sha256').update(JSON.stringify(environment)).digest('hex');
  const job=await this.manager.submit(id,'lab-check',async options=>{await admitted;if(startError)throw startError;return this.run(report,session,configurationDigest,options);});
  try{report.jobId=job.id;this.records.save(report,true);this.reports.set(id,report);}
  catch(error){startError=error;throw error;}
  finally{release();}
  return {job,reportId:report.id};
 }
 private async run(report:WindowsLocalCheckReport,session:WindowsNetworkSession|undefined,configurationDigest:string,options:RunOptions){
  const id=report.environmentId,current=()=>{options.signal?.throwIfAborted();const environment=this.manager.store.get(id);if(!session||this.manager.sessions.get(id)!==session||session.state!=='active'||environment.state!=='running'||createHash('sha256').update(JSON.stringify(environment)).digest('hex')!==configurationDigest)throw new AppError('环境已变化，检测结果不能用于当前会话',409,'CONFIGURATION_CHANGED');};
  let primary:unknown;
  try{
   current();await this.manager.assertAccess(id,true);current();const digest=session!.guardDigest;
   if(!/^[a-f0-9]{64}$/.test(digest))throw new AppError('联网防护摘要无法核对',409,'GUARD_FAILED');
   report.checks.push({name:'实时防护',passed:true,detail:'当前会话、联网许可与规则摘要已核验'});this.records.save(report);
   if(!this.browser.running(id)){await this.browser.open(id,options,'blank');current();}
   const result=windowsBrowserCheckResultSchema.parse(await this.browser.localCheck(id,options));current();
   report.checks.push({name:'Linux 浏览器',passed:/^Linux/.test(result.probe.page.platform)&&/Linux/.test(result.probe.page.userAgent),detail:result.probe.page.platform},...result.checks,{name:'临时资料清理',passed:true,detail:'本次独立上下文已关闭，原浏览器资料保留'});
   await this.manager.assertAccess(id,true);current();
   report.result=result;
   report.checks.push({name:'检测后防护',passed:session!.guardDigest===digest,detail:'检测后复核，原会话与规则摘要保持'});
   if(report.checks.some(check=>!check.passed))throw new AppError('部分本地检测未通过，请查看分项结果',409,'LAB_CHECK_FAILED');
   report.state='passed';
  }catch(error){
   primary=error;report.state='failed';report.error=options.signal?.aborted?'无账号检测已取消':error instanceof AppError?error.message:'无账号检测未完成，请查看操作记录';
   if(error instanceof WindowsBrowserCheckFailure&&!error.cleanupVerified)report.checks.push({name:'临时资料清理',passed:false,detail:'关闭状态未确认，请关闭并重新打开浏览器后重试'});
  }
  report.checkedAt=new Date().toISOString();
  try{this.records.save(report);}catch(error){report.state='failed';report.error='检测结果未能保存，请核对操作记录；原记录保留';if(primary)throw new AggregateError([primary,error],'检测未完成且结果保存失败');throw error;}
  this.manager.store.log(id,report.jobId,'无账号检测：'+(report.state==='passed'?'本地分项通过':'未完成')+'；'+report.checks.filter(value=>value.passed).length+'/'+report.checks.length+' 项，付费请求 0');
  if(primary)throw primary;
 }
}
