import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createConnection,type AddressInfo} from 'node:net';
import {randomUUID} from 'node:crypto';
import {WebSocketServer,type WebSocket} from 'ws';
import {WindowsBrowserTrial,assertWindowsBrowserTrialCheck,type WindowsBrowserAcceptance} from '../server/platform/windows/browser-trial.ts';
import type {WindowsBrowserRuntime} from '../server/platform/windows/browser.ts';
import type {WindowsManager} from '../server/platform/windows/manager.ts';
import type {WindowsNetworkSession} from '../server/platform/windows/session.ts';
import type {Environment} from '../shared/types.ts';
import {WINDOWS_CHROME} from '../server/platform/windows/browser-assets.ts';
import {WINDOWS_BROWSER_CANDIDATE} from '../server/platform/windows/browser-releases.ts';
import {windowsBrowserTrialUnit} from '../server/platform/windows/browser-trial-guest.ts';
import {inspectGuestBrowserSandboxUnit} from '../server/guest-browser-sandbox.ts';
import {WINDOWS_CHECK_ORIGIN} from '../server/platform/windows/local-check-fixture.ts';
import {syntheticBrowserCheck} from './fixtures/windows-local-check-data.ts';

const epoch='a'.repeat(32),binding='b'.repeat(64),candidate=WINDOWS_BROWSER_CANDIDATE.version;
async function fixture(mode='normal'){
 const environment={id:randomUUID(),name:'Synthetic private trial',kind:'vm',state:'running',cpus:1,identity:{locale:'en-US',timezone:'UTC'},network:{strict:true,transparent:true}} as Environment;
 const session={id:randomUUID(),state:'active',guardDigest:'c'.repeat(64),expectedIp:'203.0.113.10',verifiedReceipts:[{receiver:'one',ip:'203.0.113.10'},{receiver:'two',ip:'203.0.113.10'}],tick:async()=>{calls.push('tick');}} as unknown as WindowsNetworkSession;
 const sessions=new Map([[environment.id,session]]),calls:string[]=[],protocol:string[]=[],errors:unknown[]=[],contexts=new Set<string>(),controller=new AbortController();
 const receipt={version:1,epoch,priorVersion:WINDOWS_CHROME.version,candidateVersion:candidate,binding,lease:{session:randomUUID(),boot:randomUUID()}},hooks:{at?:(phase:string)=>Promise<void>}={};
 const at=async(phase:string)=>{calls.push(phase);await hooks.at?.(phase);};
 const sandbox={unitActive:true,developmentUid:1000,processes:['renderer','gpu-process'].map((role,index)=>({pid:100+index,role,uid:1000,seccomp:2,noNewPrivileges:1,effectiveCapabilities:'0',separatePidNamespace:true,noSandboxFlag:false,threads:[{tid:100+index,seccomp:2,noNewPrivileges:1,effectiveCapabilities:'0'}]}))};
 const server=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({webSocketDebuggerUrl:'ws://localhost:9222/devtools/browser/trial'}));}),wss=new WebSocketServer({server});let connections=0;
 wss.on('connection',socket=>{
  const index=++connections,pending=new Map<string,(value:any)=>void>();let url='about:blank',completion:unknown=null,count=0;
  const event=(method:string,params:unknown,sessionId?:string)=>socket.send(JSON.stringify({method,params,...sessionId?{sessionId}:{}}));
  const request=async(path:string,method='GET',postData?:unknown,headers:Record<string,string>={})=>{
   const requestId=String(++count),response=new Promise<any>(resolve=>pending.set(requestId,resolve));event('Fetch.requestPaused',{requestId,request:{url:path.startsWith('https:')?path:WINDOWS_CHECK_ORIGIN+path,method,headers,...postData===undefined?{}:{postData:JSON.stringify(postData)}}},'check-session');return response;
  };
  // This peer supplies synthetic measurements, while the production CDP
  // coordinator and local receiver handle every request and cleanup step.
  const local=async()=>{
   await request(url);await request('/features.js');await request('/probe.js');await request('/frame');await request('/frame.js');
   const probe=syntheticBrowserCheck().probe;if(mode==='render-null')for(const feature of [probe.page,probe.worker,probe.frame])feature.canvasHash=null;
   if(mode==='identity')for(const feature of [probe.page,probe.worker,probe.frame])feature.language='de-DE';
   const result=await request('/api/receipts','POST',probe,{'content-type':'application/json'}),saved=JSON.parse(Buffer.from(result.body,'base64').toString());
   const login=await request('/api/login','POST',{account:'synthetic-a'},{'content-type':'application/json'}),cookie=login.responseHeaders.find((value:any)=>value.name==='Set-Cookie').value.split(';')[0];
   const account=JSON.parse(Buffer.from((await request('/api/session','GET',undefined,{cookie})).body,'base64').toString()).account;
   const stream=await request('/v1/messages','POST',{model:'mu-mock',stream:true,max_tokens:128,messages:[{role:'user',content:'Hello local test'}]},{'content-type':'application/json','x-api-key':'mu-windows-local-synthetic-only'});
   assert.match(Buffer.from(stream.body,'base64').toString(),/MU_LOCAL_TASK_OK/);
   completion={receiptId:saved.id,account,events:['message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop']};
  };
  socket.on('message',data=>{void(async()=>{
   const r=JSON.parse(data.toString());protocol.push(r.method);let result:any={};
   if(r.method==='Browser.getVersion')result={product:'Chrome/'+(mode==='wrong-product'?WINDOWS_CHROME.version:candidate)};
   else if(r.method==='Target.getTargets')result={targetInfos:[{targetId:'primary',type:'page',url:mode==='nonblank'?'https://example.invalid/':'about:blank'}]};
   else if(r.method==='Target.attachToTarget'){const privatePage=r.params.targetId==='check-page',sessionId=privatePage?'check-session':'primary-session';result={sessionId};event('Target.attachedToTarget',{sessionId,targetInfo:{targetId:r.params.targetId,type:'page',...privatePage?{browserContextId:'check-context'}:{}}});}
   else if(r.method==='Target.createBrowserContext'){assert.deepEqual(r.params,{disposeOnDetach:true,proxyServer:'http://127.0.0.1:9',proxyBypassList:'<-loopback>'});contexts.add('check-context');result={browserContextId:'check-context'};}
   else if(r.method==='Target.createTarget'){assert.equal(r.params.browserContextId,'check-context');assert.equal(r.params.url,'about:blank');result={targetId:'check-page'};}
   else if(r.method==='Page.navigate'){assert.equal(index%2,0);assert.ok(r.params.url.startsWith(WINDOWS_CHECK_ORIGIN+'/?run='));url=r.params.url;void local().catch(error=>{errors.push(error);socket.terminate();});}
   else if(r.method==='Fetch.fulfillRequest'){assert.equal(r.params.responseCode>=200&&r.params.responseCode<300,true);pending.get(r.params.requestId)?.(r.params);pending.delete(r.params.requestId);}
   else if(r.method==='Runtime.evaluate')result={result:{value:r.params.expression==='location.href'?'about:blank':JSON.stringify({url,result:completion,error:null})}};
   else if(r.method==='Target.disposeBrowserContext'){await at('dispose-context');if(mode!=='context-cleanup')contexts.delete(r.params.browserContextId);}
   else if(r.method==='Target.getBrowserContexts')result={browserContextIds:[...contexts]};
   else if(r.method==='Browser.close'){await at('browser-close');if(mode==='flush-refused'){socket.send(JSON.stringify({id:r.id,error:{message:'Synthetic graceful close rejected'}}));return;}}
   socket.send(JSON.stringify({id:r.id,result}));if(r.method==='Browser.close')setImmediate(()=>socket.close());
  })().catch(error=>{errors.push(error);socket.terminate();});});
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const manager={sessions,store:{get:()=>environment},assertAccess:async()=>{await at('guard');return environment;},profile:async()=>({id:environment.id})} as unknown as WindowsManager;
 const runtime={management:async(_config,command,options)=>{
  if(options?.input===inspectGuestBrowserSandboxUnit(windowsBrowserTrialUnit(epoch))){await at('sandbox');assert.equal(command.at(-1)?.endsWith('/chrome-'+candidate+'/chrome'),true);return JSON.stringify(mode==='sandbox'?{...sandbox,unitActive:false}:sandbox);}
  assert.equal(command.at(-2),'-c');assert.ok(options?.inputBytes);const frame=Buffer.from(options.inputBytes!),size=frame.readUInt32BE();assert.equal(size,frame.length-4);const program=frame.subarray(4).toString();let phase:string;
  if(program.includes('\ntrial_stop_unit('+JSON.stringify(epoch)+')'))phase='stop';
  else if(program.includes('\n# The new service acquires'))phase='start';
  else if(program.includes("subprocess.run(['/bin/bash','-s']"))phase='display';
  else if(program.includes('\n print(json.dumps(adoption_commit_bound('))phase='commit';
  else if(program.includes("if adoption_worker('version',PROFILE_PARENT/'browser',None,data)!={'version':CANDIDATE}:"))phase='accepted';
  else phase='status';
  if(phase==='stop')assert.equal(options?.signal,undefined,'Independent stop cannot inherit cancellation');await at(phase);
  if(mode==='stop-refused'&&phase==='stop')throw Error('Synthetic root stop refused');
  if(phase==='stop')return JSON.stringify({version:1,epoch,browserStopped:true,displayStopped:true});
  if(phase==='commit')return JSON.stringify({version:1,state:'committed',epoch,priorVersion:WINDOWS_CHROME.version,candidateVersion:candidate,selectedVersion:candidate,cleanupWarning:false,...mode==='commit-invalid'?{extra:true}:{}});
  return JSON.stringify(mode==='binding-changed'&&phase==='start'?{...receipt,binding:'d'.repeat(64)}:receipt);
 },serviceStreamFactory:async(_config,kind)=>{assert.equal(kind,'cdp','Private candidate has no VNC/viewer transport');return()=>createConnection((server.address() as AddressInfo).port,'127.0.0.1');}} as WindowsBrowserRuntime;
 const ordinary={close:async()=>at('ordinary-close'),running:()=>mode==='ordinary-refused'},trial=new WindowsBrowserTrial(manager,runtime,ordinary);
 return {environment,session,sessions,calls,protocol,hooks,controller,trial,contexts,async close(){await trial.dispose();for(const socket of wss.clients)socket.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));assert.deepEqual(errors,[]);}};
}

test('Actual private trial coordinator accepts only after local receipt, independent stop, profile check and guard, then consumes its opaque token once',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.trial.commit({} as WindowsBrowserAcceptance),{code:'BROWSER_TRIAL_ACCEPTANCE'});assert.equal(f.calls.length,0);
  const token=await f.trial.accept(f.environment.id,epoch);assert.deepEqual(Object.keys(token),[]);assert.equal(Object.isFrozen(token),true);assert.equal(f.calls.includes('commit'),false);assert.deepEqual([...f.contexts],[]);
  assert.ok(f.calls.indexOf('ordinary-close')<f.calls.indexOf('display'));assert.ok(f.calls.indexOf('stop')<f.calls.indexOf('accepted'));assert.equal(f.calls.filter(v=>v==='sandbox').length,2);assert.ok(f.protocol.includes('Fetch.fulfillRequest'));
  const committed=await f.trial.commit(token);assert.equal(committed.state,'committed');assert.equal(committed.version,candidate);assert.equal(committed.checks.length,4);await assert.rejects(f.trial.commit(token),{code:'BROWSER_TRIAL_ACCEPTANCE'});assert.equal(f.calls.filter(v=>v==='commit').length,1);
 }finally{await f.close();}
});
for(const [mode,code]of [['wrong-product','BROWSER_VERSION_MISMATCH'],['nonblank','BROWSER_TRIAL_NOT_BLANK'],['render-null','BROWSER_TRIAL_CHECK_FAILED'],['identity','BROWSER_TRIAL_CHECK_FAILED'],['sandbox','BROWSER_SANDBOX_FAILED'],['context-cleanup','BROWSER_CHECK_CLEANUP_UNCONFIRMED'],['flush-refused','BROWSER_TRIAL_FLUSH_UNCONFIRMED'],['stop-refused','BROWSER_TRIAL_STOP_UNCONFIRMED'],['binding-changed','BROWSER_TRIAL_CHANGED'],['ordinary-refused','BROWSER_STOP_UNCONFIRMED']] as const)test('Private trial refuses '+mode+' and cannot publish acceptance or commit',async()=>{
 const f=await fixture(mode);try{await assert.rejects(f.trial.accept(f.environment.id,epoch),{code});assert.equal(f.calls.includes('commit'),false);assert.equal(f.calls.includes('accepted'),false);assert.equal(f.calls.filter(v=>v==='stop').length,mode==='ordinary-refused'?0:1);}finally{await f.close();}
});
for(const phase of ['status','display','start','dispose-context','browser-close','accepted'])test('Cancellation at '+phase+' never becomes acceptance and uses an independent stop when needed',async()=>{
 const f=await fixture();try{f.hooks.at=async current=>{if(current===phase)f.controller.abort();};await assert.rejects(f.trial.accept(f.environment.id,epoch,{signal:f.controller.signal}));assert.equal(f.calls.includes('commit'),false);assert.equal(f.calls.filter(v=>v==='stop').length,phase==='status'?0:1);}finally{await f.close();}
});
for(const change of ['session','configuration','guard'])test('Accepted private token cannot cross '+change+' changes',async()=>{
 const f=await fixture();try{const token=await f.trial.accept(f.environment.id,epoch);if(change==='session')f.sessions.set(f.environment.id,{...f.session,id:randomUUID()} as WindowsNetworkSession);else if(change==='configuration')f.environment.name='changed';else Object.defineProperty(f.session,'guardDigest',{value:'e'.repeat(64)});await assert.rejects(f.trial.commit(token),{code:'BROWSER_TRIAL_ACCEPTANCE'});assert.equal(f.calls.includes('commit'),false);}finally{await f.close();}
});
test('A durable commit reply is still recognized if cancellation arrives after root dispatch',async()=>{
 const f=await fixture();try{const token=await f.trial.accept(f.environment.id,epoch);f.hooks.at=async phase=>{if(phase==='commit')f.controller.abort();};const result=await f.trial.commit(token,{signal:f.controller.signal});assert.equal(result.state,'committed');assert.equal(f.controller.signal.aborted,true);}finally{await f.close();}
});
test('An expired token and a cancelled pre-dispatch token cannot send a commit',async()=>{
 for(const mode of ['expired','cancelled']){const f=await fixture();const originalNow=performance.now.bind(performance);try{const token=await f.trial.accept(f.environment.id,epoch);if(mode==='expired')performance.now=()=>originalNow()+31000;else f.controller.abort();await assert.rejects(f.trial.commit(token,{signal:f.controller.signal}));assert.equal(f.calls.includes('commit'),false);await assert.rejects(f.trial.commit(token),{code:'BROWSER_TRIAL_ACCEPTANCE'});}finally{performance.now=originalNow;await f.close();}}
});
test('An unrecognized root commit reply consumes the token and requires journal recovery rather than retrying acceptance',async()=>{
 const f=await fixture('commit-invalid');try{const token=await f.trial.accept(f.environment.id,epoch);await assert.rejects(f.trial.commit(token),{code:'BROWSER_TRIAL_COMMIT_RECEIPT'});await assert.rejects(f.trial.commit(token),{code:'BROWSER_TRIAL_ACCEPTANCE'});assert.equal(f.calls.filter(v=>v==='commit').length,1);}finally{await f.close();}
});
test('A new trial immediately retires its predecessor token even if the new trial fails',async()=>{
 const f=await fixture();try{const old=await f.trial.accept(f.environment.id,epoch);f.hooks.at=async phase=>{if(phase==='status')throw Error('Synthetic later trial refused');};await assert.rejects(f.trial.accept(f.environment.id,epoch),/Synthetic later trial refused/);await assert.rejects(f.trial.commit(old),{code:'BROWSER_TRIAL_ACCEPTANCE'});assert.equal(f.calls.includes('commit'),false);}finally{await f.close();}
});
test('Only the latest completed private trial can supply a commit token',async()=>{
 const f=await fixture();try{const old=await f.trial.accept(f.environment.id,epoch),latest=await f.trial.accept(f.environment.id,epoch);await assert.rejects(f.trial.commit(old),{code:'BROWSER_TRIAL_ACCEPTANCE'});assert.equal((await f.trial.commit(latest)).state,'committed');}finally{await f.close();}
});
test('Closing a completed private trial retires its unused token',async()=>{
 const f=await fixture();try{const token=await f.trial.accept(f.environment.id,epoch);await f.trial.close(f.environment.id);await assert.rejects(f.trial.commit(token),{code:'BROWSER_TRIAL_ACCEPTANCE'});assert.equal(f.calls.includes('commit'),false);}finally{await f.close();}
});
test('An in-flight root commit owns the environment until its reply settles',async()=>{
 const f=await fixture();let release!:()=>void;try{const token=await f.trial.accept(f.environment.id,epoch);let entered!:()=>void;const pending=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);f.hooks.at=async phase=>{if(phase==='commit'){entered();await pending;}};const committing=f.trial.commit(token);await started;assert.throws(()=>f.trial.accept(f.environment.id,epoch),{code:'BROWSER_TRIAL_BUSY'});release();assert.equal((await committing).state,'committed');}finally{release?.();await f.close();}
});
test('Commit ownership is installed before a synchronous authorization callback can reenter trial admission',async()=>{
 const f=await fixture();try{const token=await f.trial.accept(f.environment.id,epoch);let guarded=0;f.hooks.at=async phase=>{if(phase==='guard'){assert.throws(()=>f.trial.accept(f.environment.id,epoch),{code:'BROWSER_TRIAL_BUSY'});guarded++;}};assert.equal((await f.trial.commit(token)).state,'committed');assert.equal(guarded,1);}finally{await f.close();}
});
test('Disposal waits for the original root commit reply before completing shutdown',async()=>{
 const f=await fixture();let release!:()=>void;try{const token=await f.trial.accept(f.environment.id,epoch);let entered!:()=>void;const pending=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);f.hooks.at=async phase=>{if(phase==='commit'){entered();await pending;}};const committing=f.trial.commit(token);await started;let disposed=false;const disposal=f.trial.dispose().then(()=>{disposed=true;});await Promise.resolve();assert.equal(disposed,false);release();await assert.rejects(committing,{code:'BROWSER_TRIAL_ACCEPTANCE'});await disposal;assert.equal(disposed,true);}finally{release?.();await f.close();}
});
test('Null render results and failed or incomplete local checks cannot stand in for candidate acceptance',()=>{
 const good=syntheticBrowserCheck();assert.doesNotThrow(()=>assertWindowsBrowserTrialCheck(good,{locale:'en-US',timezone:'UTC'} as Environment['identity']));
 for(const change of ['canvas','gpu','screen','failed','incomplete']){const value=structuredClone(good);if(change==='canvas')value.probe.page.canvasHash=null;else if(change==='gpu')value.probe.page.gpu=null;else if(change==='screen')value.probe.frame.screen=null;else if(change==='failed')value.checks[0].passed=false;else value.checks=[];assert.throws(()=>assertWindowsBrowserTrialCheck(value,{locale:'en-US',timezone:'UTC'} as Environment['identity']),{code:'BROWSER_TRIAL_CHECK_FAILED'});}
});
