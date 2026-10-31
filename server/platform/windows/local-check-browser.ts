import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {AppError} from '../../errors.ts';
import type {DevToolsEvent} from '../../guest-browser.ts';
import {WindowsLocalCheckFixture} from './local-check-fixture.ts';
import {windowsBrowserCheckResultSchema,type WindowsBrowserCheckResult,type WindowsCheckProbe} from '../../../shared/windows-local-check.ts';

export interface WindowsCheckCdp{
 send(method:string,params?:Record<string,unknown>,sessionId?:string):Promise<any>;
 event?: (event:DevToolsEvent)=>void;
 close():void;
}
export interface WindowsBrowserCheckOptions{
 signal?:AbortSignal;assertCurrent():void;
 // An independent connection can reconcile disposal after the private client
 // disconnects. It must only observe this exact context, never dispose others.
 verifyDisposed(contextId:string):Promise<boolean>;
 contextCreated?(contextId:string):void;
 timeoutMs?:number;
}
export class WindowsBrowserCheckFailure extends AppError{
 readonly cleanupVerified:boolean;
 constructor(message:string,code:string,cleanupVerified:boolean,cause?:unknown){super(message,409,code);this.cleanupVerified=cleanupVerified;this.cause=cause;}
}
const completionSchema=z.object({receiptId:z.uuid(),account:z.literal('synthetic-a'),events:z.tuple([z.literal('message_start'),z.literal('content_block_start'),z.literal('content_block_delta'),z.literal('content_block_stop'),z.literal('message_delta'),z.literal('message_stop')])}).strict();
const observationSchema=z.object({url:z.string().max(1024),result:z.unknown().nullable(),error:z.string().max(1000).nullable()}).strict();
const featureKeys=['timezone','locale','language','languages','platform','userAgent','hardwareConcurrency','deviceMemoryGiB','clientHints','canvasHash','gpu'] as const;
export function windowsBrowserCheckItems(probe:WindowsCheckProbe,identity:{locale:string;timezone:string}){
 const page=probe.page,expectedZone=new Intl.DateTimeFormat('en',{timeZone:identity.timezone}).resolvedOptions().timeZone,expectedLocale=new Intl.Locale(identity.locale),actualLocale=new Intl.Locale(page.locale);
 const mismatches=featureKeys.filter(key=>JSON.stringify(page[key])!==JSON.stringify(probe.worker[key])||JSON.stringify(page[key])!==JSON.stringify(probe.frame[key]));
 return [{name:'语言与时区',passed:page.timezone===expectedZone&&page.language===identity.locale&&actualLocale.language===expectedLocale.language&&(!actualLocale.region||actualLocale.region===expectedLocale.region),detail:page.language+' · '+page.timezone+' · '+page.platform},
  {name:'页面 / Worker / iframe',passed:mismatches.length===0,detail:mismatches.length?'存在差异：'+mismatches.join('、'):'实际上下文特征一致'},
  {name:'合成登录',passed:true,detail:'独立临时上下文中的本地虚构账户'},
  {name:'本地模拟消息流',passed:true,detail:'模拟消息事件完整，付费模型请求为 0'}];
}

// The caller supplies a NEW CDP client owned exclusively by this operation.
// The user's existing page, cookies and browser context are never selected.
export async function runWindowsBrowserCheck(tools:WindowsCheckCdp,identity:{locale:string;timezone:string},options:WindowsBrowserCheckOptions):Promise<WindowsBrowserCheckResult>{
 const fixture=new WindowsLocalCheckFixture(),controller=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
 const timeout=setTimeout(()=>controller.abort(),options.timeoutMs??30000);timeout.unref();
 let contextId:string|undefined,creationAttempted=false,targetId:string|undefined,rootSession:string|undefined,failure:unknown,probe:WindowsCheckProbe|undefined,receiptId:string|undefined,cleanupVerified=false,cleanupRecovered=false,closed=false;
 const pending=new Set<Promise<void>>(),configured=new Map<string,Promise<void>>();let responseBytes=0;
 const close=()=>{if(!closed){closed=true;tools.close();}};
 const abort=()=>close();signal.addEventListener('abort',abort,{once:true});
 const current=()=>{signal.throwIfAborted();options.assertCurrent();if(failure)throw failure;if(closed)throw Error('Private check connection is closed');};
 const bounded=async<T>(work:Promise<T>,milliseconds:number):Promise<T>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Local cleanup timeout')),milliseconds);timer.unref();})]);}finally{clearTimeout(timer);}};
 const command=async(method:string,params:Record<string,unknown>={},session?:string)=>{current();const result=await tools.send(method,params,session);current();return result;};
 const fail=(error:unknown)=>{failure??=error;controller.abort();};
 const track=(work:Promise<void>)=>{const task=work.catch(fail).finally(()=>pending.delete(task));pending.add(task);};
 const configure=(session:string,kind='page')=>{
  const existing=configured.get(session);if(existing)return existing;
  const task=(async()=>{
   if(kind==='worker'){await command('Network.enable',{},session);await command('Network.setBlockedURLs',{urls:['*']},session);}
   else if(kind==='page'||kind==='iframe')await command('Fetch.enable',{patterns:[{urlPattern:'*'}]},session);
   else throw Error('Unexpected local check target type');
   await command('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true},session);await command('Runtime.runIfWaitingForDebugger',{},session);
  })();
  configured.set(session,task);return task;
 };
 const paused=async(event:DevToolsEvent)=>{
  const session=event.sessionId,requestId=event.params?.requestId;
  if(typeof session!=='string'||!configured.has(session)||typeof requestId!=='string')throw Error('Unowned local check request');
  try{
   current();const request=event.params.request;
   const parsed=z.object({url:z.string().max(4096),method:z.string().max(12),headers:z.record(z.string().max(200),z.string().max(4096)),postData:z.string().max(98304).optional()}).passthrough().parse(request);
   const response=fixture.handle(parsed);responseBytes+=Buffer.byteLength(response.body);if(responseBytes>1048576)throw Error('Local response budget exceeded');
   await command('Fetch.fulfillRequest',{requestId,responseCode:response.status,responseHeaders:response.headers,body:Buffer.from(response.body).toString('base64')},session);
  }catch(error){try{await tools.send('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'},session);}catch{/* Closing this private client also cancels its requests. */}throw error;}
 };
 tools.event=event=>{
  if(event.method==='Fetch.requestPaused')track(paused(event));
  else if(event.method==='Target.attachedToTarget'){
   const info=event.params?.targetInfo,session=event.params?.sessionId;
   if(typeof session==='string'&&(info?.browserContextId===contextId||event.sessionId&&configured.has(event.sessionId)))track(configure(session,info?.type));
  }
 };
 try{
  current();creationAttempted=true;
  const created=await tools.send('Target.createBrowserContext',{disposeOnDetach:true,proxyServer:'http://127.0.0.1:9',proxyBypassList:'<-loopback>'});
  if(typeof created?.browserContextId!=='string'||created.browserContextId.length>200)throw Error('Browser context receipt missing');
  const context:string=created.browserContextId;contextId=context;options.contextCreated?.(context);current();
  const target=await command('Target.createTarget',{url:'about:blank',browserContextId:contextId,background:true});
  if(typeof target?.targetId!=='string'||target.targetId.length>200)throw Error('Local check target missing');targetId=target.targetId;
  const attached=await command('Target.attachToTarget',{targetId,flatten:true});
  if(typeof attached?.sessionId!=='string')throw Error('Local check session missing');const attachedSession:string=attached.sessionId;rootSession=attachedSession;
  await configure(attachedSession);await command('Page.enable',{},rootSession);await command('Page.navigate',{url:fixture.url},rootSession);
  let complete=false;
  while(!complete){
   current();const response=await command('Runtime.evaluate',{expression:'JSON.stringify({url:location.href,result:globalThis.__MU_WINDOWS_CHECK__??null,error:globalThis.__MU_WINDOWS_CHECK_ERROR__??null})',returnByValue:true},rootSession);
   if(response.exceptionDetails)throw Error('Local browser evaluation failed');
   const observed=observationSchema.parse(JSON.parse(response.result?.value??'null'));
   if(observed.url===fixture.url){
    if(observed.error)throw Error('Local browser fixture failed');
    if(observed.result!==null){const result=completionSchema.parse(observed.result);if(!fixture.receipt||result.receiptId!==fixture.receipt.id||!fixture.loggedIn||fixture.syntheticModelCalls!==1)throw Error('Local receiver receipt missing');probe=fixture.receipt.probe;receiptId=result.receiptId;complete=true;}
   }else if(observed.url!=='about:blank')throw Error('Local check target navigated away');
   if(!complete)await delay(100,undefined,{signal});
  }
  current();await Promise.all([...pending]);current();
 }catch(error){failure??=error;}
 finally{
  clearTimeout(timeout);signal.removeEventListener('abort',abort);
  if(contextId){
   try{if(!closed){await bounded(tools.send('Target.disposeBrowserContext',{browserContextId:contextId}),2000);const contexts=await bounded(tools.send('Target.getBrowserContexts'),2000);cleanupVerified=Array.isArray(contexts?.browserContextIds)&&!contexts.browserContextIds.includes(contextId);}}catch{/* Reconcile by exact id after dispose-on-detach. */}
   close();tools.event=undefined;
   if(!cleanupVerified){
    try{cleanupVerified=await bounded(options.verifyDisposed(contextId),4000);cleanupRecovered=cleanupVerified;}catch{/* The original browser may have been revoked. */}
   }
  }else{close();tools.event=undefined;cleanupVerified=!creationAttempted;}
  // Private disconnection rejects outstanding CDP calls before any success.
  await bounded(Promise.allSettled([...pending]),1000).catch(()=>{});
 }
 if(!cleanupVerified)throw new WindowsBrowserCheckFailure('临时检测上下文的关闭尚未确认，请关闭并重新打开浏览器后再试','BROWSER_CHECK_CLEANUP_UNCONFIRMED',false,failure);
 if(failure||!probe||!receiptId)throw new WindowsBrowserCheckFailure(options.signal?.aborted?'无账号检测已取消':'本地无账号检测未完成，请查看操作记录','BROWSER_CHECK_FAILED',true,failure);
 options.signal?.throwIfAborted();options.assertCurrent();
 return windowsBrowserCheckResultSchema.parse({probe,checks:windowsBrowserCheckItems(probe,identity),requests:fixture.requests,syntheticModelCalls:1,paidModelCalls:0,cleanupVerified:true,cleanupRecovered,isolatedContext:true,receiptId});
}
