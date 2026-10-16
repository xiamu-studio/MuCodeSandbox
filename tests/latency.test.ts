import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {measureAccessLatency,parseLatencyTiming,parseUnifiedLatency,summarizeLatency,LATENCY_WRITE_OUT} from '../server/latency.ts';
import {LATENCY_TARGETS} from '../shared/latency.ts';
import {Manager} from '../server/manager.ts';
import {LimaRuntime} from '../server/runtime.ts';
import {createService} from '../server/service.ts';
import {AppError} from '../server/errors.ts';
import type {Environment} from '../shared/types.ts';
const timing=(firstByte=.12)=>JSON.stringify({httpCode:'204',firstByte,total:firstByte+.01});
const pair=(warm=1.2,line=.12,connections=0)=>[JSON.stringify({httpCode:'204',firstByte:warm,total:warm+.01,connections:1}),JSON.stringify({httpCode:'204',firstByte:line-.0001,total:line,connections})].join('\n');

test('Latency uses curl seconds, not management wall time; validates timing and HTTP response',()=>{
  assert.deepEqual(parseLatencyTiming(timing(.043)),{ok:true,firstByteMs:43,totalMs:53,httpStatus:204});
  for(const text of ['{}','null','[]',timing(0),timing(9),JSON.stringify({httpCode:'500',firstByte:.1,total:.2}),JSON.stringify({httpCode:'204',firstByte:.2,total:.1}),'x'.repeat(1025)])assert.throws(()=>parseLatencyTiming(text));
});
test('Latency median excludes failures; all failures are null, never fake zero',()=>{
  const result=summarizeLatency('google',[parseUnifiedLatency(pair(1,.1)),{ok:false,issue:'访问超时'},parseUnifiedLatency(pair(2,.3))]);
  assert.equal(result.medianMs,200);assert.equal(result.minMs,100);assert.equal(result.maxMs,300);assert.equal(result.successfulSamples,2);
  assert.equal(result.firstResponseMedianMs,1500);assert.equal(result.metric,'http-url-test-unified');
  assert.equal(summarizeLatency('google',[{ok:false,issue:'失败'}]).medianMs,null);
});
test('Unified line delay uses the warm HEAD response and requires actual connection reuse',()=>{
  const value=parseUnifiedLatency(pair(1.423,.1909));assert.equal(value.lineDelayMs,190);assert.equal(value.firstByteMs,1423);assert.equal(value.reusedConnection,true);
  assert.throws(()=>parseUnifiedLatency(pair(1.4,.19,1)),/未能复用/);
  for(const output of [timing(),pair()+'\n'+pair(),'x'.repeat(2049),pair().replace('"connections":0','"connections":"0"')])assert.throws(()=>parseUnifiedLatency(output));
});
test('Measurements use three bounded ordinary-guest HTTPS requests and no unsafe options',async()=>{
  const commands:string[][]=[],opts:any[]=[];
  const runtime={guest:async(_e:Environment,args:string[],options:any)=>{commands.push(args);opts.push(options);await new Promise(r=>setTimeout(r,20));return pair(1.2,.001);}} as unknown as LimaRuntime;
  const result=await measureAccessLatency(runtime,{} as Environment,'google');assert.equal(result.medianMs,1);assert.equal(commands.length,3);
  for(const args of commands){assert.deepEqual(args.slice(0,2),['/usr/bin/curl','-q']);assert.equal(args.at(-1),LATENCY_TARGETS[0].url);assert.ok(args.includes('--cacert'));assert.ok(args.includes('--ipv4'));assert.ok(!args.includes('--insecure'));assert.ok(!args.includes('--location'));assert.ok(!args.includes('--retry'));assert.equal(args[args.indexOf('--write-out')+1],LATENCY_WRITE_OUT);assert.equal(args[args.indexOf('--output')+1],'/dev/null');}
  assert.ok(opts.every(o=>o.timeoutMs===12000&&o.maxBytes===4096));
  assert.ok(commands.every(args=>args.includes('--head')&&args.includes('--http1.1')&&args.filter(arg=>arg===LATENCY_TARGETS[0].url).length===2));
  await assert.rejects(measureAccessLatency(runtime,{} as Environment,'http://localhost' as any),/不支持/);assert.equal(commands.length,3);
});
test('Timeouts and certificate failures preserve reasons without leaking secrets',async()=>{
  let n=0;const runtime={guest:async()=>{n++;throw Error(n===1?'curl: (28) password=secret':'curl: (60) https://user:secret@example.test');}} as unknown as LimaRuntime;
  const result=await measureAccessLatency(runtime,{} as Environment,'cloudflare');assert.equal(result.medianMs,null);assert.equal(result.samples.length,3);assert.match(JSON.stringify(result),/超时/);assert.match(JSON.stringify(result),/安全连接/);assert.ok(!JSON.stringify(result).includes('secret'));
  const controller=new AbortController();controller.abort();await assert.rejects(measureAccessLatency(runtime,{} as Environment,'google',{signal:controller.signal}),/取消/);assert.equal(n,3);
});
async function fixture(){
  const directory=await mkdtemp(path.join(tmpdir(),'mu-latency-unit-')),runtime=new LimaRuntime(directory);
  runtime.revokeLease=async()=>{};runtime.guest=async()=>pair();
  const manager=new Manager(directory,undefined,runtime);clearInterval(manager.protectionTimer);await manager.networkObserver.close();
  const e=await manager.create({name:'Synthetic latency',network:{mode:'socks5',host:'127.0.0.1',port:24898,strict:true,transparent:true}});manager.store.state(e.id,'running');manager.assertAccess=async()=>undefined;
  return {manager,runtime,e,clean:async()=>{await manager.close();await rm(directory,{recursive:true,force:true});}};
}
test('Latency checks protection before and after requests; refuses stopped/host and final failures',async()=>{
  const f=await fixture();let calls=0,checks=0;f.runtime.guest=async()=>{calls++;return pair();};
  try{
    f.manager.assertAccess=async()=>{throw new AppError('防护未通过',409);};await assert.rejects(f.manager.testAccessLatency(f.e.id),/防护未通过/);assert.equal(calls,0);
    f.manager.assertAccess=async()=>{checks++;if(checks===2)throw new AppError('出口变化',409);return undefined;};await assert.rejects(f.manager.testAccessLatency(f.e.id),/出口变化/);assert.equal(calls,3);assert.equal(f.manager.accessLatency(f.e.id),null);
    f.manager.store.state(f.e.id,'stopped');await assert.rejects(f.manager.testAccessLatency(f.e.id),/先启动/);assert.equal(calls,3);
    const host=await f.manager.create({name:'Host not guest',kind:'browser'});f.manager.store.state(host.id,'running');await assert.rejects(f.manager.testAccessLatency(host.id),/先启动/);assert.equal(calls,3);
  }finally{await f.clean();}
});
test('Concurrent same-site tests coalesce and invalidated results cannot be published',async()=>{
  const f=await fixture();let calls=0,release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  f.runtime.guest=async()=>{calls++;await gate;return pair();};
  try{
    const a=f.manager.testAccessLatency(f.e.id),b=f.manager.testAccessLatency(f.e.id);
    await assert.rejects(f.manager.testAccessLatency(f.e.id,'cloudflare'),/另一个/);release();assert.deepEqual(await a,await b);assert.equal(calls,3);assert.equal(f.manager.accessLatency(f.e.id)?.medianMs,120);
    let unblock!:()=>void;const pending=new Promise<void>(r=>{unblock=r;});f.runtime.guest=async()=>{await pending;return pair();};
    const testing=f.manager.testAccessLatency(f.e.id);await new Promise(r=>setTimeout(r,0));
    (f.manager as any).invalidate(f.e.id);unblock();await assert.rejects(testing,/取消|变化/);assert.equal(f.manager.accessLatency(f.e.id),null);
  }finally{await f.clean();}
});
test('Latency API requires local authorization and accepts only whitelisted site IDs',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mu-latency-api-')),service=await createService({dataDir:directory,rootDir:path.resolve(import.meta.dirname,'..'),port:0});
  clearInterval(service.manager.protectionTimer);await service.manager.networkObserver.close();
  try{
    const e=await service.manager.create({name:'API latency'}),route=`${service.url}/api/environments/${e.id}/network/latency`,headers={'Content-Type':'application/json',Authorization:`Bearer ${service.token}`};
    assert.equal((await fetch(route)).status,401);
    assert.equal((await fetch(route,{headers,method:'POST',body:JSON.stringify({target:'localhost'})})).status,400);
    assert.equal((await fetch(route,{headers,method:'POST',body:JSON.stringify({target:'google',url:'http://127.0.0.1'})})).status,400);
    assert.equal((await fetch(route,{headers,method:'POST',body:'{}'})).status,409);
    assert.equal(await(await fetch(route,{headers})).json(),null);
  }finally{await service.close();await rm(directory,{recursive:true,force:true});}
});
