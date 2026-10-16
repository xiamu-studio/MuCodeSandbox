import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { NetworkObserver,parseConnection,parseJournal,observationKey,JournalContext,connectionExit } from '../server/network-observations.ts';
import { exitSummary,logSummary,type ExitObservation } from '../shared/network-observations.ts';
import { environmentSchema } from '../server/validation.ts';
import { startTransparentScript,transparentConfig } from '../server/transparent-network.ts';
import { createService } from '../server/service.ts';
import { Manager } from '../server/manager.ts';
import type { Environment } from '../shared/types.ts';

function env():Environment {return {...environmentSchema.parse({name:'Observation test',kind:'vm',network:{mode:'http',host:'127.0.0.1',port:24897,strict:true,transparent:true}}),id:randomUUID(),instanceName:'mu-observation-test',state:'running',lastError:null,browserRunning:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};}
function journal(message:string,cursor='s=abcd;i=1;b=abcd;m=1;t=1;x=abcd') {return JSON.stringify({__CURSOR:cursor,__REALTIME_TIMESTAMP:String(Date.now()*1000),MESSAGE:message});}

test('Connection parser preserves observed destination and distinguishes attempts, rejects secrets and request URLs',()=>{
  assert.deepEqual(parseConnection('INFO [1212 3ms] outbound/http[upstream]: outbound connection to 203.0.113.2:443'),{target:'203.0.113.2',port:443,status:'attempt',protocol:'TCP',route:'proxy'});
  assert.equal(parseConnection('INFO outbound/socks[upstream]: outbound connection to example.org:443')?.target,'example.org');
  assert.deepEqual(parseConnection('INFO [0030] [452175043 0ms] dns: cached A ntp.ubuntu.com. 31 IN A 185.125.190.56'),{target:'ntp.ubuntu.com',port:53,status:'dns-cached',protocol:'DNS',route:'proxy-dns',dnsAddresses:['185.125.190.56'],dnsTtlSeconds:31});
  assert.equal(parseConnection('INFO dns: exchanged A example.org. 30 IN A 203.0.113.1')?.status,'dns-result');
  assert.equal(parseConnection('ERROR connection: dial tcp 203.0.113.2:443: connect: refused')?.status,'failed');
  for(const target of ['user:secret@example.org:443','https://example.org:443/path?token=secret','<script>:443','example.org:99999','127.0.0.1:0'])assert.equal(parseConnection(`INFO outbound/http[upstream]: outbound connection to ${target}`),null);
  assert.equal(parseConnection('password=SECRET Cookie: TOPSECRET Authorization: Bearer HELLO'),null);
  assert.equal(parseConnection('INFO inbound/tun[mu-tun]: inbound connection from 172.19.0.1:34215'),null);
});

test('Destination correlation follows the exact connection across batches, without storing complete URLs',()=>{
  const ctx=new JournalContext(),now=Date.now();
  function row(message:string,ms:number,boot='one',invocation='service-one') {return JSON.stringify({...JSON.parse(journal(message)),__REALTIME_TIMESTAMP:String((now+ms)*1000),_BOOT_ID:boot,_SYSTEMD_INVOCATION_ID:invocation});}
  parseJournal(row('INFO [1234 0ms] inbound/socks[exit-probe]: inbound connection to api.ipify.org:443',0),ctx);
  parseJournal(row('INFO [1234 1ms] dns: lookup succeed for api.ipify.org: 203.0.113.8 203.0.113.9',1),ctx);
  const outgoing='INFO [1234 2ms] outbound/socks[upstream]: outbound connection to 203.0.113.9:443';
  const c=parseJournal(row(outgoing,2),ctx).events[0].value;
  assert.equal(c.target,'203.0.113.9');assert.equal(c.domain,'api.ipify.org');assert.equal(c.domainSource,'connection');
  assert.equal(parseJournal(row(outgoing,3,'two'),ctx).events[0].value.domain,undefined);
  assert.equal(parseJournal(row(outgoing,3,'one','service-two'),ctx).events[0].value.domain,undefined);
  assert.equal(parseJournal(row(outgoing.replace(':443',':8443'),3),ctx).events[0].value.domain,undefined);
  assert.equal(parseJournal(row(outgoing.replace('203.0.113.9','203.0.113.10'),3),ctx).events[0].value.domain,undefined);
  parseJournal(row('INFO [1234 0ms] inbound/tun[mu-tun]: inbound connection to 203.0.113.9:443',4),ctx);
  assert.equal(parseJournal(row(outgoing,5),ctx).events[0].value.domain,undefined);
  parseJournal(row('INFO [2222 0ms] inbound/socks[exit-probe]: inbound connection to https://user:SECRET@example.org/private?token=SECRET',3),ctx);
  assert.ok(!JSON.stringify([...ctx.traces]).includes('SECRET'));
});

test('DNS reference respects TTL and refuses to identify a website from a shared server IP',()=>{
  const ctx=new JournalContext(),now=Date.now();
  const row=(message:string,ms:number)=>JSON.stringify({...JSON.parse(journal(message)),__REALTIME_TIMESTAMP:String((now+ms)*1000),_BOOT_ID:'dns-boot'});
  parseJournal(row('INFO [1 0ms] dns: exchanged A one.example. 1 IN A 203.0.113.3',0),ctx);
  const outgoing='INFO [2 0ms] outbound/socks[upstream]: outbound connection to 203.0.113.3:443';
  let c=parseJournal(row(outgoing,50),ctx).events[0].value;assert.equal(c.domain,'one.example');assert.equal(c.domainSource,'dns');
  parseJournal(row('INFO [3 0ms] dns: exchanged A two.example. 20 IN A 203.0.113.3',60),ctx);
  c=parseJournal(row(outgoing,70),ctx).events[0].value;assert.equal(c.domain,undefined);assert.deepEqual(c.domainCandidates,['one.example','two.example']);
  c=parseJournal(row(outgoing,1010),ctx).events[0].value;assert.equal(c.domain,'two.example');
  c=parseJournal(row(outgoing,20_061),ctx).events[0].value;assert.equal(c.domain,undefined);
  parseJournal(row('INFO [4 0ms] dns: exchanged A future.example. 20 IN A 203.0.113.4',40_000),ctx);
  assert.equal(parseJournal(row(outgoing.replace('203.0.113.3','203.0.113.4'),30_000),ctx).events[0].value.domain,undefined);
});

test('Connection exit context never substitutes current, future, failed or expired approvals for past connections',()=>{
  const now=Date.now(),at=(delta:number)=>new Date(now+delta).toISOString();
  const approvals=[{id:1,at:at(0),status:'verified' as const,ip:'203.0.113.10'}];
  assert.deepEqual(connectionExit(at(8000),true,approvals,[]),{exitIp:'203.0.113.10',exitCheckedAt:at(0),exitSource:'verification'});
  assert.deepEqual(connectionExit(at(-1),true,approvals,[]),{});
  assert.deepEqual(connectionExit(at(45_001),true,approvals,[]),{});
  assert.deepEqual(connectionExit(at(8000),true,[...approvals,{id:2,at:at(6000),status:'unavailable'}],[]),{});
  assert.deepEqual(connectionExit(at(8000),true,[...approvals,{id:2,at:at(6000),status:'changed',ip:'203.0.113.11'}],[]),{});
  assert.equal(connectionExit(at(8000),true,[...approvals,{id:2,at:at(10_000),status:'verified',ip:'203.0.113.11'}],[]).exitIp,'203.0.113.10');
  const samples=[{id:1,at:at(0),provider:'ipify' as const,status:'success' as const,ip:'203.0.113.10'}];
  assert.equal(connectionExit(at(8000),false,[],samples).exitSource,'observation');
  assert.deepEqual(connectionExit(at(90_001),false,[],samples),{});
  assert.deepEqual(connectionExit(at(8000),false,[],[...samples,{id:2,at:at(6000),provider:'ipify',status:'failed'}]),{});
});

test('Journal extraction validates cursors and signals bounded batches rather than claiming completeness',()=>{
  const parsed=parseJournal(journal('INFO outbound/http[upstream]: outbound connection to 203.0.113.2:443'));
  assert.equal(parsed.events.length,1);assert.equal(parsed.truncated,false);
  const binary=JSON.parse(journal(''));binary.MESSAGE=[...Buffer.from('\x1b[36mINFO\x1b[0m[0034] [3762621842 0ms] outbound/http[upstream]: outbound connection to 104.26.13.205:443')];
  assert.equal(parseJournal(JSON.stringify(binary)).events[0].value.target,'104.26.13.205');
  binary.MESSAGE=[-1,999];assert.equal(parseJournal(JSON.stringify(binary)).events.length,0);
  assert.throws(()=>parseJournal('{"__CURSOR":"$(curl bad)","MESSAGE":"x"}'));
  assert.throws(()=>parseJournal('not json'));
  const many=Array.from({length:501},(_,i)=>journal('irrelevant',`s=abc;i=${i};b=abc`)).join('\n');assert.equal(parseJournal(many).truncated,true);
});

test('Exit summary reports receipt disagreement, provider drift, failure and stale data truthfully',()=>{
  const now=Date.now(),at=new Date(now).toISOString();
  const a:ExitObservation={id:1,at,provider:'ipwho',status:'success',ip:'203.0.113.1'};
  assert.equal(exitSummary([a],now).state,'waiting');
  assert.equal(exitSummary([a,{...a,id:2,provider:'ipify'}],now).state,'unchanged');
  const different=exitSummary([a,{...a,id:2,provider:'ipify',ip:'203.0.113.2'}],now);assert.equal(different.state,'changed');assert.equal(different.changes,0);assert.equal(different.distinctIps,2);
  assert.equal(exitSummary([a,{...a,id:2,ip:'203.0.113.2'}],now).changes,1);
  assert.equal(exitSummary([a,{id:2,at,provider:'ipify',status:'failed'}],now).state,'failed');
  assert.equal(exitSummary([a],now+91_000).state,'stale');
  assert.equal(logSummary('{"processes":[{"seccomp":2,"threads":[]}]}'),'浏览器隔离检查详情');
  assert.equal(logSummary('stored passwd in file: /run/browser/vnc'),'浏览器画面连接凭据已准备');
  assert.equal(logSummary('Linux browser ready: loopback VNC and CDP; no host website process.'),'沙箱浏览器已就绪，可以连接画面');
  assert.equal(logSummary('/usr/bin/Xvfb\n/usr/bin/x11vnc'),'浏览器图形显示组件已就绪');
});

test('Store isolates environments and keys, deduplicates source events, prunes old records and deletes with environment',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mu-observations-'));const store=new Store(dir);
  try{
    const a=env(),b=env();store.save(a);store.save(b);
    store.addNetworkRecord(a.id,'connection','key','same',{target:'example.org',at:new Date().toISOString()});
    store.addNetworkRecord(a.id,'connection','key','same',{target:'duplicate'});
    assert.equal(store.networkRecords(a.id,'connection','key').length,1);assert.equal(store.networkRecords(b.id,'connection','key').length,0);assert.equal(store.networkRecords(a.id,'connection','other').length,0);
    store.db.prepare('UPDATE network_records SET created_at=?').run('2000-01-01T00:00:00.000Z');
    store.addNetworkRecord(a.id,'connection','key','new',{target:'new'});assert.equal(store.networkRecords(a.id,'connection','key').length,1);
    store.remove(a.id);assert.equal(store.networkRecords(a.id,'connection','key').length,0);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('Observer deduplicates collection, records provider failure and discards results crossing restart generation',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mu-observer-'));const store=new Store(dir),e=env();store.save(e);
  const runtime=new LimaRuntime(dir);runtime.management=async(_e,args)=>args.includes('show')?'mucodesandbox-network\n':journal('INFO outbound/http[upstream]: outbound connection to example.org:443');
  let generation=0,probeCount=0,release:(()=>void)|undefined;
  const observer=new NetworkObserver(store,runtime,async(_e,provider)=>{probeCount++;if(provider==='ipify')throw new Error('password=SHOULD_NOT_PERSIST');return {ip:'203.0.113.1',country:'Test',city:'',latencyMs:1,source:'guest'};},()=>true,()=>generation);
  try{
    await observer.tick();await observer.tick();const info=observer.info(e);
    assert.equal(info.capture,'ready');assert.equal(info.connections.length,1);assert.equal(info.summary.state,'failed');assert.equal(probeCount,2);assert.ok(!JSON.stringify(info).includes('SHOULD_NOT_PERSIST'));
    (observer as any).probe=async()=>{await new Promise<void>(r=>{release=r;});return {ip:'203.0.113.2',country:'',city:'',latencyMs:1,source:'guest'};};
    // Both providers share one gate, and a concurrent UI request must not create another probe pair.
    let unblock!:()=>void;const gate=new Promise<void>(r=>unblock=r);(observer as any).probe=async()=>{await gate;return {ip:'203.0.113.2',country:'',city:'',latencyMs:1,source:'guest'};};
    const pending=observer.sample(e);assert.equal(observer.sample(e),pending);generation++;unblock();await pending;
    assert.equal(observer.info(e).summary.successes,0);assert.equal(observer.info(e).samples.length,2);
    assert.equal(store.networkRecords(e.id,'connection',observationKey(e)).length,1);
  }finally{await observer.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('Collected connection receipts are persisted and isolated from later approvals and restart generations',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mu-connection-exit-')),store=new Store(dir),e=env();
  e.network.egressLock={expectedIp:'203.0.113.10'};store.save(e);const runtime=new LimaRuntime(dir);
  let generation=0,cursor=1;
  runtime.management=async(_e,args)=>args.includes('show')?'mucodesandbox-network\n':journal('INFO outbound/socks[upstream]: outbound connection to example.org:443',`s=abc;i=${cursor}`);
  const observer=new NetworkObserver(store,runtime,async()=>({ip:'203.0.113.10',country:'',city:'',latencyMs:1,source:'guest'}),()=>true,()=>generation);
  try {
    observer.recordVerification(e,{status:'verified',actualIp:'203.0.113.10',checkedAt:new Date(Date.now()-1000).toISOString()});
    await observer.tick();assert.equal(observer.info(e).connections[0].exitIp,'203.0.113.10');
    observer.recordVerification(e,{status:'changed',actualIp:'203.0.113.11',checkedAt:new Date().toISOString()});
    assert.equal(observer.info(e).connections[0].exitIp,'203.0.113.10');
    generation++;cursor++;await observer.tick();assert.equal(observer.info(e).connections[1].exitIp,undefined);
    const oldAdd=store.addNetworkRecord;store.addNetworkRecord=()=>{throw new Error('storage failure');};
    assert.doesNotThrow(()=>observer.recordVerification(e,{status:'verified',actualIp:'203.0.113.10',checkedAt:new Date().toISOString()}));
    store.addNetworkRecord=oldAdd;
  }finally{await observer.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('Observation API retains authentication and cannot accept arbitrary destinations or sample stopped environments',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mu-observation-api-'));
  const browser={native:false,available:async()=>true,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{}};
  const service=await createService({dataDir:dir,rootDir:path.resolve(import.meta.dirname,'..'),port:0,browser});
  const headers={Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'};
  try{
    const e=env();e.state='stopped';service.manager.store.save(e);
    const url=`${service.url}/api/environments/${e.id}/network/observations`;
    assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(url,{headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
    const response=await fetch(url,{headers});assert.equal(response.status,200);assert.equal((await response.json()).enabled,false);
    assert.equal((await fetch(url,{method:'POST',headers,body:'{"url":"http://169.254.169.254/"}'})).status,400);
    assert.equal((await fetch(url,{method:'POST',headers,body:'{}'})).status,409);
  }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('Logging changes no controller or route and uses a bounded private memory journal',()=>{
  const config=transparentConfig(env(),'127.0.0.1',999,[]);const script=startTransparentScript(config);
  assert.equal(config.route.final,'upstream');assert.equal(config.outbounds.length,1);assert.equal((config as any).experimental,undefined);
  assert.match(script,/LogNamespace=mucodesandbox-network/);assert.match(script,/RuntimeMaxUse=8M/);assert.match(script,/Storage=volatile/);
});

test('Shutdown revokes network permission before waiting for a slow observer',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mu-observation-close-'));const runtime=new LimaRuntime(dir);
  let revoked=false,release!:()=>void;runtime.revokeLease=async()=>{revoked=true;};
  const browser={native:false,available:async()=>true,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{}};
  const manager=new Manager(dir,browser,runtime);manager.store.save(env());
  await manager.networkObserver.close();
  manager.networkObserver.close=()=>new Promise<void>(r=>release=r);
  const pending=manager.close();
  try{await Promise.resolve();assert.equal(revoked,true);}
  finally{release();await pending;await rm(dir,{recursive:true,force:true});}
});
