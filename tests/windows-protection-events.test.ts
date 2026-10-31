import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {Store} from '../server/store.ts';import {WindowsManager,type WindowsBackend} from '../server/platform/windows/manager.ts';import {WindowsNetworkSession} from '../server/platform/windows/session.ts';import {windowsPaths} from '../server/platform/windows/config.ts';import {windowsProtectionIssue} from '../server/platform/windows/protection-events.ts';import {measureEgress} from '../server/egress.ts';import {AppError} from '../server/errors.ts';
const input=()=>({name:'Windows protection fixture',cpus:1,memoryGiB:2,diskGiB:16,network:{mode:'http',host:'127.0.0.1',port:12345,password:'MU_PRIVATE_PASSWORD',strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.10'}}});

test('Structured guard failures persist their evidence and kind, while the old ambiguous English summary remains unknown',async()=>{
 for(const fault of ['integrity','lease'] as const){const f=await fixture();try{
  await f.manager.wait((await f.manager.action(f.e.id,'start')).id);if(fault==='integrity')f.status.digest='b'.repeat(64);else f.status.active=false;
  await f.manager.monitor();const event=f.manager.protectionRecords.list(f.e.id)[0];assert.equal(event.kind,fault);assert.equal(event.stopResult,'confirmed');assert.equal(event.guard?.stage,'before-inspection');assert.equal(event.guard?.reason,fault==='integrity'?'integrity-changed':'lease-inactive');assert.deepEqual(event.checks,[]);assert.equal(f.status.state,'Off');
  const reopened=new Store(path.join(f.root,'app'),Buffer.alloc(32,5));try{assert.deepEqual(reopened.protectionEvents(f.e.id)[0],event);}finally{reopened.close();}
  const old=f.manager.protectionRecords.record(f.store.get(f.e.id),Error('Guard expired during measurement'));const legacy=f.manager.protectionRecords.list(f.e.id).find(e=>e.id===old)!;assert.equal(legacy.kind,'unknown');assert.equal(legacy.guard,undefined);
 }finally{await f.close();}}
});
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'mu-win-protection-')),store=new Store(path.join(root,'app'),Buffer.alloc(32,5)),status={state:'Off',active:false,digest:'a'.repeat(64)},receipts=[{receiver:'ipwho',ip:'203.0.113.10',latencyMs:10},{receiver:'ipify',ip:'203.0.113.10',latencyMs:12}];let fail=false,stopFails=false,stops=0,stopWait:undefined|{gate:Promise<void>;enter:()=>void};
 const runtime:WindowsBackend={info:async()=>({available:true,issues:[]}),state:async()=>({state:status.state}),create:async c=>{const file=windowsPaths(root,c.id).manifest;await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'{}');},start:async()=>{status.state='Running';},stop:async()=>{status.state='Off';status.active=false;},connect:async()=>{},inspectGuard:async()=>({digest:status.digest,leaseActive:status.active,remainingMs:status.active?45000:0}),session:async c=>new WindowsNetworkSession({inspect:async()=>({digest:status.digest,leaseActive:status.active,remainingMs:status.active?45000:0}),probe:async()=>{
  if(!fail)return structuredClone(receipts);
  const result=await measureEgress({egressProbeProxy:()=> 'socks5h://127.0.0.1:12345',management:async(_e,args)=>{const target=args.at(-1)!;if(target.includes('api.ipify.org'))throw new AppError('curl: (56) Failure when receiving data from the peer\nMU_EGRESS_DIAGNOSTICS={"curlExitCode":"56","httpStatus":"000","tcp":"0.01","tls":"0.05","firstByte":"0","total":"0.2"}\n',500,'PROCESS_FAILED');return target.includes('icanhazip')?'203.0.113.10':JSON.stringify({ip:'203.0.113.10'});}},store.get(c.id));return result.verification!.receipts;
 },activate:async()=>{status.active=true;},renew:async()=>{},revoke:async()=>{status.active=false;},disconnect:async()=>{},stop:async()=>{stops++;const paused=stopWait;if(paused){paused.enter();await paused.gate;}if(stopFails)throw Error('Synthetic native Off could not be confirmed');status.state='Off';status.active=false;}},c.expectedIp)};
 const manager=new WindowsManager(store,runtime,{runtimeRoot:root,base:{image:path.join(root,'base.vhdx'),imageSha256:'a'.repeat(64)}}),e=await manager.create(input());
 return {root,store,manager,e,status,get stops(){return stops;},fail:()=>{fail=true;},healthy:()=>{fail=false;},stopFails:()=>{stopFails=true;},pauseStop:()=>{let enter!:()=>void,release!:()=>void;const began=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);stopWait={gate,enter};return{began,release:()=>{stopWait=undefined;release();}};},close:async()=>{stopFails=false;await manager.close();await rm(root,{recursive:true,force:true});}};
}
test('A Windows curl 56 still fails closed with two other receipts and persists the failed receiver and connection stages',async()=>{
 const f=await fixture();try{await f.manager.wait((await f.manager.action(f.e.id,'start')).id);f.fail();await f.manager.monitor();const events=f.manager.protectionRecords.list(f.e.id);assert.equal(events.length,1);const event=events[0];assert.equal(event.source,'current');assert.equal(event.kind,'connection');assert.equal(event.stopResult,'confirmed');assert.equal(f.status.state,'Off');assert.equal(f.store.get(f.e.id).state,'error');assert.equal(f.stops,1);assert.equal(event.checks.find(c=>c.receiver==='ipify')!.status,'connection-error');assert.deepEqual(event.checks.find(c=>c.receiver==='ipify')!.diagnostics,{curlExitCode:56,httpStatus:0,tcpConnectMs:10,tlsHandshakeMs:50,firstByteMs:0,totalMs:200});assert.equal(event.issue.includes('MU_EGRESS_DIAGNOSTICS'),false);assert.equal(JSON.stringify(event).includes('MU_PRIVATE_PASSWORD'),false);assert.equal(event.resolvedAt,null);assert.deepEqual(f.store.protectionEvents(f.e.id),events);
 }finally{await f.close();}
});
test('Failed native stopping preserves the original receiver evidence and never reports confirmed Off',async()=>{
 const f=await fixture();try{await f.manager.wait((await f.manager.action(f.e.id,'start')).id);f.fail();f.stopFails();await f.manager.monitor();const event=f.manager.protectionRecords.list(f.e.id)[0];assert.equal(event.stopResult,'failed');assert.ok(event.stopIssue);assert.equal(event.checks.find(c=>c.receiver==='ipify')!.diagnostics!.curlExitCode,56);assert.equal(f.status.state,'Running');assert.match(f.store.get(f.e.id).lastError!,/停机未确认/);
 }finally{await f.close();}
});
test('Journal insertion and stop-update failures retain an explicit memory warning without preventing fail-closed stopping',async()=>{
 const f=await fixture();try{await f.manager.wait((await f.manager.action(f.e.id,'start')).id);f.store.addProtectionEvent=()=>{throw Error('Synthetic full journal');};f.store.updateProtectionStop=()=>{throw Error('Synthetic full journal');};f.fail();await f.manager.monitor();const event=f.manager.protectionRecords.list(f.e.id)[0];assert.equal(event.persisted,false);assert.equal(event.stopResult,'confirmed');assert.equal(event.checks.find(c=>c.receiver==='ipify')!.status,'connection-error');assert.equal(f.status.state,'Off');assert.equal(f.store.protectionEvents(f.e.id).length,0);
 }finally{await f.close();}
});
test('A throwing viewer revocation callback cannot prevent the independent native stop or its event',async()=>{
 const f=await fixture();try{await f.manager.wait((await f.manager.action(f.e.id,'start')).id);f.manager.onAccessRevoked=()=>{throw Error('Synthetic viewer cleanup');};f.status.digest='b'.repeat(64);await assert.rejects(f.manager.assertAccess(f.e.id));assert.equal(f.status.state,'Off');assert.equal(f.manager.protectionRecords.list(f.e.id)[0].stopResult,'confirmed');
 }finally{f.manager.onAccessRevoked=undefined;await f.close();}
});
test('Only a fresh successful approved startup resolves a Windows failure and retains its original receiver snapshot across reopening',async()=>{
 const f=await fixture();try{await f.manager.wait((await f.manager.action(f.e.id,'start')).id);f.fail();await f.manager.monitor();const before=f.manager.protectionRecords.list(f.e.id)[0];f.healthy();await f.manager.wait((await f.manager.action(f.e.id,'start')).id);const after=f.manager.protectionRecords.list(f.e.id)[0];assert.ok(after.resolvedAt);assert.equal(after.resolution?.ip,'203.0.113.10');assert.equal(after.resolution?.receipts.length,2);assert.deepEqual(after.checks,before.checks);assert.equal(after.stopResult,'confirmed');const reopened=new Store(path.join(f.root,'app'),Buffer.alloc(32,5));try{assert.deepEqual(reopened.protectionEvents(f.e.id)[0],after);}finally{reopened.close();}
 }finally{await f.close();}
});
test('Old Windows summaries stay explicitly legacy with no invented receiver or stopping evidence',async()=>{
 const f=await fixture();try{f.store.state(f.e.id,'error','curl: (56) peer failure；环境已确认关闭');const e=f.store.get(f.e.id),a=f.manager.protectionRecords.list(e.id),b=f.manager.protectionRecords.list(e.id);assert.equal(a.length,1);assert.equal(b[0].id,a[0].id);assert.equal(a[0].source,'legacy');assert.equal(a[0].at,e.updatedAt);assert.equal(a[0].stopResult,'not-confirmed');assert.deepEqual(a[0].checks,[]);assert.deepEqual(a[0].observedIps,[]);
 }finally{await f.close();}
});
test('Windows diagnostic summaries omit URL credentials, callback paths, bearer tokens and raw diagnostic trailers',()=>{
 const clean=windowsProtectionIssue('https://user:MU_PASSWORD@proxy.test/a?code=MU_CODE custom-app://auth?token=MU_CALLBACK Bearer MU_BEARER\nMU_EGRESS_DIAGNOSTICS={"value":"MU_TRAILER"}\n');for(const secret of ['MU_PASSWORD','MU_CODE','MU_CALLBACK','MU_BEARER','MU_TRAILER'])assert.equal(clean.includes(secret),false);assert.ok(clean.includes('proxy.test'));assert.ok(clean.includes('链接内容已隐藏'));
});
test('An intentional successful Windows application exit does not create a new protection failure',async()=>{
 const f=await fixture();try{await f.manager.wait((await f.manager.action(f.e.id,'start')).id);await f.manager.close();const reopened=new Store(path.join(f.root,'app'),Buffer.alloc(32,5));try{assert.equal(reopened.protectionEvents(f.e.id).length,0);const {WindowsProtectionEvents}=await import('../server/platform/windows/protection-events.ts');assert.equal(new WindowsProtectionEvents(reopened).list(f.e.id).length,0);}finally{reopened.close();}
 }finally{await f.close();}
});
test('A failed Windows startup records the original receiver result and independently confirmed stopping',async()=>{
 const f=await fixture();try{f.fail();const job=await f.manager.action(f.e.id,'start');await f.manager.wait(job.id);assert.equal(f.store.jobs().find(v=>v.id===job.id)!.status,'failed');assert.equal(f.status.state,'Off');const event=f.manager.protectionRecords.list(f.e.id)[0];assert.equal(event.source,'current');assert.equal(event.kind,'connection');assert.equal(event.stopResult,'confirmed');assert.equal(event.checks.find(c=>c.receiver==='ipify')!.diagnostics!.curlExitCode,56);
 }finally{await f.close();}
});
test('Windows protection event HTTP requires the local authenticated UI and never returns saved proxy credentials',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture();const {createWindowsService}=await import('../server/platform/windows/service.ts');await mkdir(path.join(f.root,'dist'));await writeFile(path.join(f.root,'dist/index.html'),'<!-- MU_BOOTSTRAP -->');
 const service=await createWindowsService({rootDir:f.root,dataDir:path.join(f.root,'service-app'),runtimeRoot:path.join(f.root,'service-runtime'),runtime:{...f.manager.runtime,fingerprint:async()=>'fixture'},base:f.manager.options.base});
 try{
  service.manager.store.save({...f.store.get(f.e.id),state:'error',lastError:'curl: (56) synthetic reset'});const url=service.url+'/api/environments/'+f.e.id+'/protection-events';assert.equal((await fetch(url)).status,401);
  const launch=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0],html=await(await fetch(service.url,{headers:{Cookie:cookie}})).text(),token=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]).token,headers={Cookie:cookie,Authorization:'Bearer '+token};
  assert.equal((await fetch(url,{headers:{...headers,Origin:'https://outside.invalid'}})).status,403);const ok=await fetch(url,{headers});assert.equal(ok.status,200);const body=await ok.text();assert.equal(body.includes('MU_PRIVATE_PASSWORD'),false);const events=JSON.parse(body);assert.equal(events.length,1);assert.equal(events[0].source,'legacy');assert.equal(events[0].stopResult,'not-confirmed');assert.deepEqual(events[0].checks,[]);assert.equal((await fetch(service.url+'/api/environments/not-a-uuid/protection-events',{headers})).status,400);assert.equal(f.status.state,'Off');
 }finally{await service.close();await f.close();}
});
test('Receiver evidence is durable while a native stop remains pending and is not falsely marked confirmed',async()=>{
 const f=await fixture();let pending:Promise<void>|undefined,paused:ReturnType<typeof f.pauseStop>|undefined;
 try{await f.manager.wait((await f.manager.action(f.e.id,'start')).id);paused=f.pauseStop();f.fail();pending=f.manager.monitor();await paused.began;const events=f.store.protectionEvents(f.e.id);assert.equal(events.length,1);assert.equal(events[0].stopResult,'requested');assert.equal(events[0].checks.find(c=>c.receiver==='ipify')!.diagnostics!.curlExitCode,56);assert.equal(f.status.state,'Running');paused.release();await pending;assert.equal(f.store.protectionEvents(f.e.id).length,1);assert.equal(f.store.protectionEvents(f.e.id)[0].stopResult,'confirmed');
 }finally{paused?.release();await pending;await f.close();}
});
test('Recovery confirms interrupted current stop records only after independent Off proof and preserves legacy stopping uncertainty',async()=>{
 const f=await fixture();try{await f.manager.wait((await f.manager.action(f.e.id,'start')).id);await f.manager.wait((await f.manager.action(f.e.id,'stop')).id);const current=f.manager.protectionRecords.record(f.store.get(f.e.id),Error('curl: (56) interrupted stop')),legacy=f.manager.protectionRecords.record(f.store.get(f.e.id),'old','curl: (56) old summary','legacy');assert.equal(f.store.protectionEvents(f.e.id).find(e=>e.id===current)!.stopResult,'requested');await f.manager.recover();const events=f.manager.protectionRecords.list(f.e.id);assert.equal(events.find(e=>e.id===current)!.stopResult,'confirmed');assert.match(events.find(e=>e.id===current)!.stopIssue!,/重新打开.*确认时间/);assert.equal(events.find(e=>e.id===legacy)!.stopResult,'not-confirmed');
 }finally{await f.close();}
});
test('A later environment-state write failure does not rewrite an independently confirmed stop as failed',async()=>{
 const f=await fixture(),saveState=f.store.state.bind(f.store);try{await f.manager.wait((await f.manager.action(f.e.id,'start')).id);f.store.state=()=>{throw Error('Synthetic state write failure');};f.fail();await assert.rejects(f.manager.monitor(),/state write failure/);assert.equal(f.status.state,'Off');assert.equal(f.manager.protectionRecords.list(f.e.id)[0].stopResult,'confirmed');
 }finally{f.store.state=saveState;await f.close();}
});
