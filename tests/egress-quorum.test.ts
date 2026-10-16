import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EGRESS_RECEIVERS, EgressMismatchError, measureEgress,egressErrorChecks,parseEgressProbeOutput } from '../server/egress.ts';
import { AppError } from '../server/errors.ts';
import type { LimaRuntime } from '../server/runtime.ts';
import type { Environment } from '../shared/types.ts';
import type { RunOptions } from '../server/process.ts';

const e={network:{egressLock:{expectedIp:'8.8.8.8'}}} as Environment;
const valid=(url:string,ip='8.8.8.8')=>url===EGRESS_RECEIVERS[2].url?ip+'\n':JSON.stringify({ip,country:'Fixture'});
const timeout=()=>new AppError('curl: (28) SSL connection timeout',500,'PROCESS_FAILED');
function runtime(fn:(url:string,options:RunOptions)=>Promise<string>){return {egressProbeProxy:()=> 'socks5h://127.0.0.1:42125',management:async(_e:Environment,args:string[],options:RunOptions)=>fn(args.at(-1)!,options)} as unknown as LimaRuntime;}

test('three fresh matching receivers return their individual receipts',async()=>{
  const result=await measureEgress(runtime(async url=>valid(url)),e);
  assert.equal(result.ip,'8.8.8.8');assert.equal(result.verification?.requiredReceivers,2);
  assert.deepEqual(result.verification?.receipts.map(r=>r.receiver),['ipwho','ipify','icanhazip']);
  assert.deepEqual(result.verification?.timedOutReceivers,[]);
});
test('one bounded timeout is covered only by two fresh matching receivers',async()=>{
  const result=await measureEgress(runtime(async url=>{if(url===EGRESS_RECEIVERS[0].url)throw timeout();return valid(url);}),e);
  assert.deepEqual(result.verification?.receipts.map(r=>r.receiver),['ipify','icanhazip']);
  assert.deepEqual(result.verification?.timedOutReceivers,['ipwho']);
});
test('one successful receiver cannot approve a route when two receivers time out',async()=>{
  await assert.rejects(measureEgress(runtime(async url=>{if(url!==EGRESS_RECEIVERS[0].url)throw timeout();return valid(url);}),e),{code:'EGRESS_UNAVAILABLE'});
});
test('a mismatched receiver rejects immediately and aborts pending measurements',async()=>{
  let cancelled=0;
  const r=runtime(async(url,options)=>{
    if(url===EGRESS_RECEIVERS[0].url)return valid(url,'9.9.9.9');
    return new Promise<string>((_,reject)=>options.signal!.addEventListener('abort',()=>{cancelled++;reject(new AppError('Cancelled',409,'CANCELLED'));},{once:true}));
  });
  await assert.rejects(measureEgress(r,e),error=>error instanceof EgressMismatchError&&error.actualIp==='9.9.9.9');
  assert.equal(cancelled,2);
});
test('two early matching receipts do not approve before a late conflicting receiver finishes',async()=>{
  let finish!: (value:string)=>void,approved=false;
  const r=runtime(async url=>url===EGRESS_RECEIVERS[2].url?new Promise<string>(resolve=>{finish=resolve;}):valid(url));
  const measured=measureEgress(r,e).then(()=>{approved=true;return null;},error=>error);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(approved,false);
  finish('9.9.9.9\n');assert.ok(await measured instanceof EgressMismatchError);assert.equal(approved,false);
});
test('certificate, authentication and DNS errors are not treated as a harmless endpoint timeout',async()=>{
  for(const message of ['curl: (60) SSL certificate problem','curl: (97) proxy authentication failed','Controlled DNS lookup failed']){
    const failure=new Error(message);
    await assert.rejects(measureEgress(runtime(async url=>{if(url===EGRESS_RECEIVERS[0].url)throw failure;return valid(url);}),e),error=>error===failure);
  }
});
test('malformed, unsuccessful and IPv6 receipts reject even when the other two receivers agree',async()=>{
  for(const bad of ['', 'null','{"ip":"::1"}','{"ip":"8.8.8.8","success":false}'])
    await assert.rejects(measureEgress(runtime(async url=>url===EGRESS_RECEIVERS[0].url?bad:valid(url)),e));
  await assert.rejects(measureEgress(runtime(async url=>url===EGRESS_RECEIVERS[2].url?'8.8.8.8\n9.9.9.9':valid(url)),e));
});
test('unlocked measurement still rejects conflicting receivers rather than choosing a majority',async()=>{
  await assert.rejects(measureEgress(runtime(async url=>valid(url,url===EGRESS_RECEIVERS[2].url?'9.9.9.9':'8.8.8.8')),{network:{}} as Environment),EgressMismatchError);
});
test('Failed quorum preserves the actual successful IP and individual timeouts without inventing an abnormal IP',async()=>{
 let failure:unknown;try{await measureEgress(runtime(async url=>{if(url===EGRESS_RECEIVERS[0].url)return valid(url);throw new AppError('curl: (28) operation timed out',500,'PROCESS_FAILED');}),e);}catch(error){failure=error;}
 const checks=egressErrorChecks(failure);assert.equal(checks.length,3);assert.equal(checks[0].status,'success');assert.equal(checks[0].ip,'8.8.8.8');assert.ok(checks.slice(1).every(c=>c.status==='timeout'&&!c.ip));
});
const diagnostic=(patch:Record<string,unknown>={})=>'\nMU_EGRESS_DIAGNOSTICS='+JSON.stringify({curlExitCode:'56',httpStatus:'000',tcp:'0.010',tls:'0.200',firstByte:'0.000',total:'0.910',...patch})+'\n';
test('Bounded numeric probe diagnostics strip the trailer without retaining response contents or extra fields',()=>{
 const output='8.8.8.8\n'+diagnostic({private:'MU_SECRET'}),parsed=parseEgressProbeOutput(output);
 assert.equal(parsed.body.trim(),'8.8.8.8');assert.deepEqual(parsed.diagnostics,{curlExitCode:56,httpStatus:0,tcpConnectMs:10,tlsHandshakeMs:200,firstByteMs:0,totalMs:910});
 assert.deepEqual(parseEgressProbeOutput('{"ip":"8.8.8.8"}'),{body:'{"ip":"8.8.8.8"}'});
 assert.equal(parseEgressProbeOutput(diagnostic().trim()).diagnostics?.curlExitCode,56);
 for(const patch of [{total:'Infinity'},{tcp:'-1'},{tls:'121'},{httpStatus:'999'},{curlExitCode:'256'}])assert.throws(()=>parseEgressProbeOutput(diagnostic(patch)));
});
test('A connection reset keeps its diagnostic stages and original failure even with two matching receipts',async()=>{
 let rejectProbe!:(error:Error)=>void;
 const failure=new AppError('curl: (56) Failure when receiving data from the peer'+diagnostic(),500,'PROCESS_FAILED');
 const measured=measureEgress(runtime(async url=>url===EGRESS_RECEIVERS[1].url?new Promise<string>((_,reject)=>{rejectProbe=reject;}):valid(url)+diagnostic({curlExitCode:'0',httpStatus:'200',firstByte:'0.300'})),e);
 const rejection=assert.rejects(measured,error=>error===failure);
 await new Promise(resolve=>setImmediate(resolve));rejectProbe(failure);await rejection;
 const checks=egressErrorChecks(failure);assert.equal(checks.filter(c=>c.status==='success').length,2);
 assert.equal(checks[1].status,'connection-error');assert.equal(checks[1].diagnostics?.curlExitCode,56);assert.equal(checks[1].diagnostics?.tlsHandshakeMs,200);
 assert.equal(checks[0].diagnostics?.httpStatus,200);assert.ok(!checks[1].ip);
});
test('Malformed error diagnostics never replace a connection reset or allow it as a timeout',async()=>{
 const failure=new AppError('curl: (56) reset'+diagnostic({total:'bad'}),500,'PROCESS_FAILED');
 await assert.rejects(measureEgress(runtime(async url=>{if(url===EGRESS_RECEIVERS[0].url)throw failure;return valid(url);}),e),error=>error===failure);
 const checks=egressErrorChecks(failure);assert.equal(checks[0].status,'connection-error');assert.equal(checks[0].diagnostics,undefined);
});
