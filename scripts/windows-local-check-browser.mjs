// Real headless host Chrome, synthetic profile and intercepted fixtures only.
// No installed application, guest, personal profile or external destination.
import {chromium} from 'playwright';import {WebSocket} from 'ws';import {connect as connectSocket} from 'node:net';import {readFile,mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
const repo=path.resolve(import.meta.dirname,'..'),output=process.env.MU_LOCAL_CHECK_OUTPUT?path.resolve(process.env.MU_LOCAL_CHECK_OUTPUT):path.join(repo,'.mu-data/windows-run/local-check-browser');await mkdir(output,{recursive:true});
const moduleRoot=process.env.MU_LOCAL_CHECK_MODULE_ROOT?path.resolve(process.env.MU_LOCAL_CHECK_MODULE_ROOT):path.join(repo,'server');
const {DevTools}=await import(pathToFileURL(path.join(moduleRoot,'guest-browser.'+(process.env.MU_LOCAL_CHECK_MODULE_ROOT?'js':'ts'))).href),{runWindowsBrowserCheck}=await import(pathToFileURL(path.join(moduleRoot,'platform/windows/local-check-browser.'+(process.env.MU_LOCAL_CHECK_MODULE_ROOT?'js':'ts'))).href);
const {WindowsBrowser}=await import(pathToFileURL(path.join(moduleRoot,'platform/windows/browser.'+(process.env.MU_LOCAL_CHECK_MODULE_ROOT?'js':'ts'))).href);
const server=await chromium.launchServer({channel:'chrome',headless:true,args:['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND','--lang=en-US']});const clients=new Set();let complete=false,browserHost,trap;const checks=[],pass=name=>checks.push({name,passed:true});
try{
 const profile=server.process().spawnargs.find(value=>value.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);assert.ok(profile);const lines=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);assert.match(lines[0],/^\d+$/);assert.match(lines[1],/^\/devtools\/browser\/[a-zA-Z0-9-]+$/);const endpoint='ws://127.0.0.1:'+lines[0]+lines[1];
 const connect=async()=>{const socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});const client=new DevTools(socket);clients.add(client);return client;};
 const primary=await connect(),retainedContext=(await primary.send('Target.createBrowserContext')).browserContextId,target=(await primary.send('Target.createTarget',{url:'data:text/html,<title>Keep original page</title>'})).targetId,session=(await primary.send('Target.attachToTarget',{targetId:target,flatten:true})).sessionId;
 await primary.send('Storage.setCookies',{cookies:[{name:'original-profile',value:'retained-synthetic-value',url:'https://mucodesandbox-check.invalid',secure:true}]});
 const expected=JSON.parse((await primary.send('Runtime.evaluate',{expression:'JSON.stringify({locale:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})',returnByValue:true},session)).result.value);
 const before=(await primary.send('Target.getTargetInfo',{targetId:target})).targetInfo.url,known=new Set((await primary.send('Target.getBrowserContexts')).browserContextIds);
 const environment={id:'synthetic-browser',name:'Synthetic browser lab',state:'running',identity:expected},lease={id:'synthetic-session',state:'active'},sessions=new Map([[environment.id,lease]]),policyErrors=[];
 const manager={sessions,store:{get:()=>environment,log:()=>{}},assertAccess:async()=>environment,failProtection:async(_id,error)=>{policyErrors.push(error);}};
 let factories=0;browserHost=new WindowsBrowser(manager,{management:async()=>{throw Error('No actual guest management operation is permitted');},serviceStreamFactory:async()=>{factories++;return()=>connectSocket({host:'127.0.0.1',port:Number(lines[0])});}});
 const entry={environment,config:{},sessionId:lease.id,password:'synthetic',ready:true,closed:false,streams:new Set(),tools:primary,pages:new Map([[target,session]]),configuration:new Set()};browserHost.entries.set(environment.id,entry);await browserHost.configure(entry);const pagesBefore=[...entry.pages.keys()];
 const result=await browserHost.localCheck(environment.id);
 assert.deepEqual([...entry.pages.keys()],pagesBefore);assert.deepEqual(policyErrors,[]);pass('The real WindowsBrowser method and ordinary target policy keep the temporary lab out of the viewer/page map');
 assert.ok(result.checks.every(value=>value.passed),JSON.stringify(result.checks));assert.equal(result.isolatedContext,true);assert.equal(result.cleanupVerified,true);assert.equal(result.syntheticModelCalls,1);assert.equal(result.paidModelCalls,0);pass('The actual engine completes page/Worker/iframe, synthetic cookie login and mock message events in a disposable context');
 assert.equal((await primary.send('Target.getTargetInfo',{targetId:target})).targetInfo.url,before);assert.deepEqual((await primary.send('Target.getBrowserContexts')).browserContextIds.sort(),[...known].sort());const cookies=(await primary.send('Storage.getCookies')).cookies;assert.deepEqual(cookies.map(value=>[value.name,value.value]),[['original-profile','retained-synthetic-value']]);pass('The original target, its cookie and all preexisting context identities are unchanged');
 const preserved=async()=>{assert.equal((await primary.send('Target.getTargetInfo',{targetId:target})).targetInfo.url,before);assert.deepEqual((await primary.send('Target.getBrowserContexts')).browserContextIds.sort(),[...known].sort());assert.deepEqual((await primary.send('Storage.getCookies')).cookies.map(value=>[value.name,value.value]),[['original-profile','retained-synthetic-value']]);assert.deepEqual(policyErrors,[]);};
 const cancel=new AbortController();entry.checkContexts=new(class extends Set{add(value){super.add(value);queueMicrotask(()=>cancel.abort());return this;}})();
 await assert.rejects(browserHost.localCheck(environment.id,{signal:cancel.signal}),error=>error.code==='BROWSER_CHECK_FAILED'&&error.cleanupVerified===true);assert.notEqual(entry.checkBlocked,true);assert.equal(entry.checkRunning,false);await preserved();pass('Cancellation after real context creation disposes only that context and leaves the original page/cookie usable');entry.checkContexts=new Set();
 entry.checkContexts=new(class extends Set{add(value){super.add(value);sessions.set(environment.id,{id:'replacement',state:'active'});return this;}})();
 await assert.rejects(browserHost.localCheck(environment.id),error=>error.cleanupVerified===true);sessions.set(environment.id,lease);await preserved();pass('A retired owner cannot publish success, and its already-owned temporary context is still cleaned');entry.checkContexts=new Set();
 let trapRequests=0;trap=createServer((_req,res)=>{trapRequests++;res.end('must not be contacted');});await new Promise(resolve=>trap.listen(0,'127.0.0.1',resolve));const trapOrigin='http://127.0.0.1:'+trap.address().port;
 const fault=async kind=>{
  const client=await connect(),requests=new Map();let listener;
  const cdp={get event(){return listener;},set event(value){listener=value;client.event=value?event=>{if(event.method==='Fetch.requestPaused')requests.set(event.params.requestId,event.params.request.url);value(event);}:undefined;},
   send:async(method,params={},sid)=>{
    if(method==='Fetch.fulfillRequest'){
     const url=requests.get(params.requestId)??'';
     if(kind==='bad-login'&&url.endsWith('/api/session'))params={...params,body:Buffer.from('{"account":"wrong-synthetic-account"}').toString('base64')};
     if(kind==='unexpected-request'&&url.includes('/?run='))params={...params,responseHeaders:params.responseHeaders.filter(header=>header.name!=='Content-Security-Policy'),body:Buffer.from(Buffer.from(params.body,'base64').toString()+'<img src="'+trapOrigin+'/must-not-send">').toString('base64')};
    }
    if(kind==='lost-disposal'&&method==='Target.disposeBrowserContext'){await client.send(method,params,sid);throw Error('Synthetic disposal reply lost');}
    return client.send(method,params,sid);
   },close:()=>client.socket.terminate()};
  try{return await runWindowsBrowserCheck(cdp,expected,{assertCurrent:()=>{},contextCreated:id=>entry.checkContexts.add(id),verifyDisposed:async id=>{for(let index=0;index<20;index++){if(!(await primary.send('Target.getBrowserContexts')).browserContextIds.includes(id))return true;await new Promise(resolve=>setTimeout(resolve,25));}return false;}});}finally{entry.checkContexts.clear();}
 };
 await assert.rejects(fault('bad-login'),error=>error.code==='BROWSER_CHECK_FAILED'&&error.cleanupVerified);await preserved();pass('An incorrect receiver result cannot report success, even when the browser and mock stream completed');
 await assert.rejects(fault('unexpected-request'),error=>error.code==='BROWSER_CHECK_FAILED'&&error.cleanupVerified);assert.equal(trapRequests,0);await preserved();pass('The request allowlist blocks an actual browser request to a controlled local trap, even after removing the fixture CSP');
 const reconciled=await fault('lost-disposal');assert.equal(reconciled.cleanupVerified,true);assert.equal(reconciled.cleanupRecovered,true);await preserved();pass('A lost disposal reply reconciles by the exact context id without deleting or adopting another context');
 const originalOpen=DevTools.openStream,originalSend=primary.send.bind(primary);let temporary;
 try{
  entry.checkContexts=new(class extends Set{add(value){temporary=value;return super.add(value);}})();
  primary.send=async(method,params={},sid)=>method==='Target.getBrowserContexts'?{browserContextIds:[temporary]}:originalSend(method,params,sid);
  DevTools.openStream=async()=>{const client=await connect(),send=client.send.bind(client);client.send=async(method,params={},sid)=>{if(method==='Target.disposeBrowserContext')throw Error('Synthetic disposal transport failure');return send(method,params,sid);};return client;};
  await assert.rejects(browserHost.localCheck(environment.id),{code:'BROWSER_CHECK_CLEANUP_UNCONFIRMED'});assert.equal(entry.checkBlocked,true);const beforeBlocked=factories;await assert.rejects(browserHost.localCheck(environment.id),{code:'BROWSER_CHECK_CLEANUP_UNCONFIRMED'});assert.equal(factories,beforeBlocked);pass('Unconfirmed cleanup fences the real browser entry before another transport or check can begin');
 }finally{DevTools.openStream=originalOpen;primary.send=originalSend;}
 await preserved();
 const hashes={};for(const file of ['server/guest-browser.ts','server/platform/windows/browser.ts','server/platform/windows/local-check-browser.ts','server/platform/windows/local-check-fixture.ts','shared/windows-local-check.ts','scripts/windows-local-check-browser.mjs'])hashes[file]=createHash('sha256').update(await readFile(path.join(repo,file))).digest('hex');
 complete=true;await writeFile(path.join(output,'results.json'),JSON.stringify({at:new Date().toISOString(),complete,checks,hashes,actualHostChrome:true,actualCdp:true,actualWindowsBrowserMethod:true,sshTransportAdapter:true,guardAdapter:true,controlledFaultInjection:true,actualTemporaryBrowserContext:true,originalProfilePreserved:true,defaultPersistentProfilePreserved:true,unexpectedTrapRequests:trapRequests,realLinux:false,realVm:false,installedApp:false,result},null,2));console.log(JSON.stringify({complete,checks:checks.length,output,actualHostChrome:true,realLinux:false}));
}finally{browserHost?.dispose();for(const client of clients)client.socket.terminate();if(trap)await new Promise(resolve=>trap.close(resolve));await server.close();}
