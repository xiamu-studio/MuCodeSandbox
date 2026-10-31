import {randomBytes,createHash} from 'node:crypto';
import type {Duplex} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import type {Environment} from '../../../shared/types.ts';
import {windowsBrowserCheckResultSchema,type WindowsBrowserCheckResult} from '../../../shared/windows-local-check.ts';
import {AppError} from '../../errors.ts';
import type {RunOptions} from '../../process.ts';
import {DevTools,DetachedTargetError} from '../../guest-browser.ts';
import {inspectGuestBrowserSandboxUnit,assertGuestBrowserSandbox} from '../../guest-browser-sandbox.ts';
import type {WindowsManager} from './manager.ts';
import type {WindowsBrowser,WindowsBrowserRuntime} from './browser.ts';
import type {WindowsNetworkSession} from './session.ts';
import type {WindowsConfig} from './config.ts';
import {WINDOWS_BROWSER_CANDIDATE,windowsBrowserReleaseRoot} from './browser-releases.ts';
import {WINDOWS_BROWSER_REPAIR_BOOTSTRAP} from './browser-repair.ts';
import {windowsBrowserAdoptionInput} from './browser-adoption.ts';
import {assertWindowsBrowserProduct} from './browser-selection.ts';
import {runWindowsBrowserCheck} from './local-check-browser.ts';
import {windowsBrowserTrialEpoch,windowsBrowserTrialUnit,windowsBrowserTrialInput,windowsBrowserTrialStatusProgram,windowsBrowserTrialDisplayProgram,windowsBrowserTrialStartProgram,windowsBrowserTrialStopProgram,parseWindowsBrowserTrialReceipt,windowsBrowserTrialStopSchema,type WindowsBrowserTrialReceipt} from './browser-trial-guest.ts';

declare const acceptanceBrand:unique symbol;
export type WindowsBrowserAcceptance={readonly [acceptanceBrand]:true};
interface Acceptance{session:WindowsNetworkSession;environmentId:string;configurationDigest:string;config:WindowsConfig;receipt:WindowsBrowserTrialReceipt;guardDigest:string;at:number;result:WindowsBrowserCheckResult}
interface Trial{environmentId:string;epoch:string;session:WindowsNetworkSession|undefined;controller:AbortController;signal:AbortSignal;environment?:Environment;config?:WindowsConfig;configurationDigest?:string;guardDigest?:string;receipt?:WindowsBrowserTrialReceipt;displayAttempted:boolean;checksPassed:boolean;gracefulClosed:boolean;cleanupVerified:boolean;cleanupError?:unknown;closed:boolean;streams:Set<Duplex>;tools?:DevTools;pages:Map<string,string>;contexts:Set<string>;configuration:Set<Promise<void>>;failure?:unknown;promise?:Promise<WindowsBrowserAcceptance>}
const configuration=(environment:Environment)=>createHash('sha256').update(JSON.stringify(environment)).digest('hex');
function matching(a:WindowsBrowserTrialReceipt,b:WindowsBrowserTrialReceipt){return a.epoch===b.epoch&&a.binding===b.binding&&a.lease.session===b.lease.session&&a.lease.boot===b.lease.boot;}
export function assertWindowsBrowserTrialCheck(value:unknown,identity:Environment['identity']){
 const result=windowsBrowserCheckResultSchema.parse(value),page=result.probe.page,frame=result.probe.frame;
 if(result.checks.length<4||result.checks.some(item=>!item.passed)||!/^Linux/.test(page.platform)||!/Linux/.test(page.userAgent)||!page.canvasHash||!page.gpu?.renderer.trim()||!page.screen||!frame.screen||JSON.stringify(page.screen)!==JSON.stringify(frame.screen)||page.language!==identity.locale||page.timezone!==new Intl.DateTimeFormat('en',{timeZone:identity.timezone}).resolvedOptions().timeZone)throw new AppError('候选浏览器身份或基础渲染未通过验收',409,'BROWSER_TRIAL_CHECK_FAILED');
 return result;
}

// A separate private owner: there is no viewer, audio, navigation or ticket API
// for this entry. Ordinary browser entries remain closed throughout the trial.
export class WindowsBrowserTrial{
 readonly manager:Pick<WindowsManager,'sessions'|'store'|'assertAccess'|'profile'>;
 readonly runtime:WindowsBrowserRuntime;readonly ordinary:Pick<WindowsBrowser,'close'|'running'>;
 private entries=new Map<string,Trial>();private acceptances=new WeakMap<WindowsBrowserAcceptance,Acceptance>();private accepted=new Map<string,WindowsBrowserAcceptance>();private committing=new Map<string,Promise<unknown>>();private closing=false;
 constructor(manager:Pick<WindowsManager,'sessions'|'store'|'assertAccess'|'profile'>,runtime:WindowsBrowserRuntime,ordinary:Pick<WindowsBrowser,'close'|'running'>){this.manager=manager;this.runtime=runtime;this.ordinary=ordinary;}
 private current(entry:Trial,checkSignal=true){if(checkSignal)entry.signal.throwIfAborted();if(this.closing||entry.closed||this.entries.get(entry.environmentId)!==entry||!entry.session||this.manager.sessions.get(entry.environmentId)!==entry.session||entry.session.state!=='active'||this.manager.store.get(entry.environmentId).state!=='running'||entry.configurationDigest&&configuration(this.manager.store.get(entry.environmentId))!==entry.configurationDigest)throw new AppError('候选浏览器防护会话已变化',409,'BROWSER_TRIAL_RETIRED');if(entry.failure)throw entry.failure;}
 private bind(entry:Trial,factory:()=>Duplex){return()=>{this.current(entry);const stream=factory();entry.streams.add(stream);stream.on('error',()=>{});stream.once('close',()=>entry.streams.delete(stream));return stream;};}
 private disconnect(entry:Trial){try{entry.tools?.socket.terminate();}catch{/* Revoke every remaining private stream. */}for(const stream of entry.streams)try{stream.destroy();}catch{/* Continue. */}entry.streams.clear();}
 private discardAcceptance(id:string){const token=this.accepted.get(id);if(token)this.acceptances.delete(token);this.accepted.delete(id);}
 private async command(entry:Trial,program:string,timeoutMs=120000){this.current(entry);const result=await this.runtime.management(entry.config!,['sudo','-n','/usr/bin/python3','-I','-c',WINDOWS_BROWSER_REPAIR_BOOTSTRAP],{signal:entry.signal,inputBytes:windowsBrowserTrialInput(program),timeoutMs,maxBytes:8192});this.current(entry);return result;}
 private async protected(entry:Trial){this.current(entry);await this.manager.assertAccess(entry.environmentId,true);this.current(entry);if(!/^[a-f0-9]{64}$/.test(entry.session!.guardDigest)||entry.guardDigest!==undefined&&entry.guardDigest!==entry.session!.guardDigest)throw new AppError('候选浏览器防护摘要已变化',409,'GUARD_FAILED');entry.guardDigest??=entry.session!.guardDigest;
  const receipts=entry.session!.verifiedReceipts;if(receipts.length<2||new Set(receipts.map(row=>row.receiver)).size!==receipts.length||receipts.some(row=>!row.receiver||row.ip!==entry.session!.expectedIp))throw new AppError('候选浏览器出口回执无法核对',409,'BROWSER_TRIAL_NETWORK');
 }
 accept(id:string,epoch:string,options:RunOptions={}):Promise<WindowsBrowserAcceptance>{
  epoch=windowsBrowserTrialEpoch(epoch);if(this.closing)throw new AppError('候选浏览器正在退出',409,'CLOSING');if(this.entries.has(id)||this.committing.has(id))throw new AppError('候选浏览器验收或提交正在进行',409,'BROWSER_TRIAL_BUSY');options.signal?.throwIfAborted();this.discardAcceptance(id);
  const controller=new AbortController(),entry:Trial={environmentId:id,epoch,session:this.manager.sessions.get(id),controller,signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal,displayAttempted:false,checksPassed:false,gracefulClosed:false,cleanupVerified:false,closed:false,streams:new Set(),pages:new Map(),contexts:new Set(),configuration:new Set()};this.entries.set(id,entry);
  const task=this.run(entry).finally(()=>{if(this.entries.get(id)===entry)this.entries.delete(id);});entry.promise=task;return task;
 }
 private async run(entry:Trial):Promise<WindowsBrowserAcceptance>{
  const abort=()=>this.disconnect(entry);entry.signal.addEventListener('abort',abort,{once:true});let result:WindowsBrowserCheckResult|undefined,primary:unknown;
  try{
   this.current(entry);const environment=await this.manager.assertAccess(entry.environmentId,true);this.current(entry);if(environment.kind!=='vm'||!environment.network.strict||!environment.network.transparent)throw new AppError('候选验收需要当前受保护的 Linux 虚拟机',409,'BROWSER_TRIAL_PROTECTED_VM');entry.environment=structuredClone(environment);entry.configurationDigest=configuration(environment);await this.protected(entry);
   entry.config=await this.manager.profile(environment);this.current(entry);if(entry.config.id!==entry.environmentId)throw new AppError('候选虚拟机身份无法对应',409,'BROWSER_TRIAL_RETIRED');entry.receipt=parseWindowsBrowserTrialReceipt(await this.command(entry,windowsBrowserTrialStatusProgram(entry.epoch)),entry.epoch);
   await this.ordinary.close(entry.environmentId);this.current(entry);if(this.ordinary.running(entry.environmentId))throw new AppError('原浏览器关闭尚未确认',409,'BROWSER_STOP_UNCONFIRMED');await this.protected(entry);
   entry.displayAttempted=true;const displayed=parseWindowsBrowserTrialReceipt(await this.command(entry,windowsBrowserTrialDisplayProgram(entry.environment,entry.epoch,entry.receipt.binding,randomBytes(6).toString('base64url')),120000),entry.epoch);if(!matching(displayed,entry.receipt))throw new AppError('候选显示回执已变化',409,'BROWSER_TRIAL_CHANGED');
   const started=parseWindowsBrowserTrialReceipt(await this.command(entry,windowsBrowserTrialStartProgram(entry.environment,entry.epoch)),entry.epoch);if(!matching(started,entry.receipt))throw new AppError('候选启动回执已变化',409,'BROWSER_TRIAL_CHANGED');
   const connect=this.bind(entry,await this.runtime.serviceStreamFactory(entry.config,'cdp'));this.current(entry);const deadline=performance.now()+90000;
   for(;;){this.current(entry);try{entry.tools=await DevTools.openStream(connect);break;}catch(error){this.current(entry);if(performance.now()>=deadline)throw error;await delay(150,undefined,{signal:entry.signal});}}
   assertWindowsBrowserProduct((await entry.tools.send('Browser.getVersion'))?.product,WINDOWS_BROWSER_CANDIDATE.version);this.current(entry);await this.configure(entry);await this.blank(entry);await this.sandbox(entry);await this.protected(entry);
   result=await this.localCheck(entry);this.current(entry);result=assertWindowsBrowserTrialCheck(result,entry.environment.identity);await this.blank(entry);assertWindowsBrowserProduct((await entry.tools.send('Browser.getVersion'))?.product,WINDOWS_BROWSER_CANDIDATE.version);this.current(entry);await this.sandbox(entry);await entry.session!.tick();this.current(entry);await this.protected(entry);entry.checksPassed=true;
  }catch(error){primary=entry.failure??error;}
  finally{
   entry.signal.removeEventListener('abort',abort);
   try{await this.cleanup(entry);}catch(error){entry.cleanupError=error;}
  }
  if(entry.cleanupError){const failure=new AppError('候选浏览器停止尚未确认，资料检查点保留，请先恢复后重试',409,'BROWSER_TRIAL_STOP_UNCONFIRMED');failure.cause=primary?new AggregateError([primary,entry.cleanupError]):entry.cleanupError;throw failure;}
  if(primary)throw primary;if(!entry.gracefulClosed)throw new AppError('候选浏览器未确认正常退出及资料写回，检查点保留',409,'BROWSER_TRIAL_FLUSH_UNCONFIRMED');this.current(entry);if(!entry.cleanupVerified||!result||!entry.receipt)throw new AppError('候选浏览器验收未完成',409,'BROWSER_TRIAL_INCOMPLETE');
  await this.protected(entry);const accepted=parseWindowsBrowserTrialReceipt(await this.command(entry,windowsBrowserTrialStatusProgram(entry.epoch,true)),entry.epoch);if(!matching(accepted,entry.receipt))throw new AppError('候选验收检查点已变化',409,'BROWSER_TRIAL_CHANGED');await this.protected(entry);
  const token=Object.freeze({}) as WindowsBrowserAcceptance;this.acceptances.set(token,{session:entry.session!,environmentId:entry.environmentId,configurationDigest:entry.configurationDigest!,config:entry.config!,receipt:accepted,guardDigest:entry.guardDigest!,at:performance.now(),result:structuredClone(result)});this.accepted.set(entry.environmentId,token);return token;
 }
 private async configure(entry:Trial){
  const tools=entry.tools!,auto={autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'browser',exclude:true},{type:'tab',exclude:true},{type:'browser_ui',exclude:true},{}]};
  const forget=(id:string)=>{for(const[target,session]of entry.pages)if(session===id)entry.pages.delete(target);};tools.detached=params=>forget(params.sessionId);
  tools.attached=params=>{const task=(async()=>{this.current(entry);if(entry.contexts.has(params.targetInfo.browserContextId)){await tools.send('Target.detachFromTarget',{sessionId:params.sessionId});return;}if(params.targetInfo.type==='page')entry.pages.set(params.targetInfo.targetId,params.sessionId);await tools.send('Target.setAutoAttach',auto,params.sessionId);await tools.send('Runtime.runIfWaitingForDebugger',{},params.sessionId);})().catch(error=>{if(error instanceof DetachedTargetError||!tools.activeSessions.has(params.sessionId)){forget(params.sessionId);return;}if(this.entries.get(entry.environmentId)===entry){entry.failure=error;entry.controller.abort();}});entry.configuration.add(task);void task.finally(()=>entry.configuration.delete(task));};
  await tools.send('Target.setAutoAttach',auto);while(entry.configuration.size)await Promise.all([...entry.configuration]);this.current(entry);const targets=(await tools.send('Target.getTargets')).targetInfos?.filter((t:{type:string})=>t.type==='page');this.current(entry);if(!Array.isArray(targets)||targets.length!==1||targets[0].url!=='about:blank')throw new AppError('候选浏览器没有独立空白页',409,'BROWSER_TRIAL_NOT_BLANK');const target=targets[0];if(!entry.pages.has(target.targetId))await tools.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});while(entry.configuration.size)await Promise.all([...entry.configuration]);this.current(entry);this.page(entry);
 }
 private page(entry:Trial){const value=[...entry.pages.entries()].find(([,id])=>entry.tools?.activeSessions.has(id));if(!value)throw new AppError('候选浏览器空白页尚未就绪',409,'BROWSER_TRIAL_PAGE');return value[1];}
 private async blank(entry:Trial){this.current(entry);const response=await entry.tools!.send('Runtime.evaluate',{expression:'location.href',returnByValue:true},this.page(entry));this.current(entry);if(response.exceptionDetails||response.result?.value!=='about:blank')throw new AppError('候选浏览器初始页已变化',409,'BROWSER_TRIAL_NOT_BLANK');}
 private async sandbox(entry:Trial){this.current(entry);const value=await this.runtime.management(entry.config!,['sudo','-n','/usr/bin/python3','-I','-',windowsBrowserReleaseRoot(WINDOWS_BROWSER_CANDIDATE.version)+'/chrome'],{signal:entry.signal,input:inspectGuestBrowserSandboxUnit(windowsBrowserTrialUnit(entry.epoch)),timeoutMs:10000,maxBytes:1048576});this.current(entry);assertGuestBrowserSandbox(JSON.parse(value));}
 private async localCheck(entry:Trial){
  const connect=this.bind(entry,await this.runtime.serviceStreamFactory(entry.config!,'cdp'));this.current(entry);const tools=await DevTools.openStream(connect);this.current(entry);
  try{return await runWindowsBrowserCheck({send:tools.send.bind(tools),get event(){return tools.event;},set event(value){tools.event=value;},close:()=>tools.socket.terminate()},entry.environment!.identity,{signal:entry.signal,assertCurrent:()=>this.current(entry),contextCreated:id=>{this.current(entry);entry.contexts.add(id);},verifyDisposed:async id=>{for(let attempt=0;attempt<20;attempt++){this.current(entry);const result=await entry.tools!.send('Target.getBrowserContexts');this.current(entry);if(Array.isArray(result.browserContextIds)&&!result.browserContextIds.includes(id))return true;await delay(50,undefined,{signal:entry.signal});}return false;}});}finally{tools.socket.terminate();}
 }
 private async cleanup(entry:Trial){
  const same=()=>this.entries.get(entry.environmentId)===entry&&!!entry.session&&this.manager.sessions.get(entry.environmentId)===entry.session&&entry.session.state==='active';
  try{
   if(entry.tools?.socket.readyState===WebSocket.OPEN&&same()){
    const socket=entry.tools.socket;let timer:ReturnType<typeof setTimeout>|undefined,closed!:()=>void;const stopped=new Promise<void>(resolve=>{closed=resolve;socket.once('close',closed);timer=setTimeout(resolve,5000);});try{void entry.tools.send('Browser.close').catch(()=>closed());await stopped;entry.gracefulClosed=socket.readyState===WebSocket.CLOSED;}finally{clearTimeout(timer);socket.removeListener('close',closed);}
   }
  }finally{this.disconnect(entry);}
  if(!entry.displayAttempted){entry.cleanupVerified=true;return;}
  if(!same()||!entry.receipt||!entry.config)throw new AppError('原候选会话已撤销，不能向替代会话发送停止',409,'BROWSER_TRIAL_RETIRED');
  const reply=await this.runtime.management(entry.config,['sudo','-n','/usr/bin/python3','-I','-c',WINDOWS_BROWSER_REPAIR_BOOTSTRAP],{inputBytes:windowsBrowserTrialInput(windowsBrowserTrialStopProgram(entry.epoch,entry.receipt.binding)),timeoutMs:90000,maxBytes:4096});
  if(!same())throw new AppError('候选停止回执来自已撤销会话',409,'BROWSER_TRIAL_RETIRED');const parsed=windowsBrowserTrialStopSchema.safeParse(JSON.parse(reply));if(!parsed.success||parsed.data.epoch!==entry.epoch)throw new AppError('候选停止回执无法核对',502,'BROWSER_TRIAL_STOP_RECEIPT');entry.cleanupVerified=true;
 }
 async commit(token:WindowsBrowserAcceptance,options:RunOptions={}){
  const proof=token&&typeof token==='object'?this.acceptances.get(token):undefined;if(!proof||this.accepted.get(proof.environmentId)!==token)throw new AppError('候选浏览器验收凭据无效或已使用',409,'BROWSER_TRIAL_ACCEPTANCE');this.discardAcceptance(proof.environmentId);
  if(this.committing.has(proof.environmentId))throw new AppError('候选浏览器正在提交',409,'BROWSER_TRIAL_BUSY');this.committing.set(proof.environmentId,Promise.resolve());const operation=(async()=>{
  const current=(before=true)=>{if(before)options.signal?.throwIfAborted();if(this.closing||this.entries.has(proof.environmentId)||this.manager.sessions.get(proof.environmentId)!==proof.session||proof.session.state!=='active'||configuration(this.manager.store.get(proof.environmentId))!==proof.configurationDigest||proof.session.guardDigest!==proof.guardDigest||before&&performance.now()-proof.at>30000)throw new AppError('候选浏览器验收凭据已过期或会话已变化',409,'BROWSER_TRIAL_ACCEPTANCE');};current();await this.manager.assertAccess(proof.environmentId,true);current();
  const reply=await this.runtime.management(proof.config,['sudo','-n','/usr/bin/python3','-I','-c',WINDOWS_BROWSER_REPAIR_BOOTSTRAP],{...options,inputBytes:windowsBrowserAdoptionInput('commit',proof.receipt.epoch,proof.receipt.binding),timeoutMs:300000,maxBytes:8192});current(false);
  const value=JSON.parse(reply),keys=Object.keys(value).sort().join(',');if(keys!=='candidateVersion,cleanupWarning,epoch,priorVersion,selectedVersion,state,version'||value.version!==1||value.state!=='committed'||value.epoch!==proof.receipt.epoch||value.priorVersion!==proof.receipt.priorVersion||value.candidateVersion!==proof.receipt.candidateVersion||value.selectedVersion!==proof.receipt.candidateVersion||typeof value.cleanupWarning!=='boolean')throw new AppError('候选浏览器提交回执无法核对，请先恢复事务状态',502,'BROWSER_TRIAL_COMMIT_RECEIPT');return {state:'committed' as const,epoch:proof.receipt.epoch,version:value.selectedVersion as string,cleanupWarning:value.cleanupWarning as boolean,checks:proof.result.checks};
  })();this.committing.set(proof.environmentId,operation);try{return await operation;}finally{if(this.committing.get(proof.environmentId)===operation)this.committing.delete(proof.environmentId);}
 }
 revoke(id:string){this.discardAcceptance(id);const entry=this.entries.get(id);if(entry){entry.controller.abort();this.disconnect(entry);}}
 async close(id:string){const entry=this.entries.get(id);this.revoke(id);if(!entry)return;await entry.promise?.catch(()=>{});if(entry.cleanupError)throw entry.cleanupError;}
 async dispose(){this.closing=true;const entries=[...this.entries.values()];for(const entry of entries)this.revoke(entry.environmentId);this.accepted.clear();this.acceptances=new WeakMap();await Promise.allSettled([...entries.map(entry=>entry.promise),...this.committing.values()]);}
}
