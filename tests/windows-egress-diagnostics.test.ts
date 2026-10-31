import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {measureEgress,egressErrorChecks,EGRESS_RECEIVERS} from '../server/egress.ts';
import {runWindowsSsh} from '../server/platform/windows/ssh-process.ts';
import {WindowsProtectionEvents} from '../server/platform/windows/protection-events.ts';
import {Store} from '../server/store.ts';
import {environmentSchema} from '../server/validation.ts';
import type {Environment} from '../shared/types.ts';
import {AppError,SshProcessError} from '../server/errors.ts';
import {retryClosedEgressReset} from '../server/platform/windows/runtime.ts';
import {WindowsTransportDiagnostics} from '../server/platform/windows/transport-diagnostics.ts';
import {WindowsNetworkSession} from '../server/platform/windows/session.ts';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

const expectedIp='203.0.113.10';
test('An evidenced pre-handshake reset fails a running session immediately even while cleanup is pending',async()=>{
 const env={...environmentSchema.parse({name:'Synthetic reset',network:{mode:'http',host:'127.0.0.1',port:12345,strict:true,transparent:true,egressLock:{expectedIp}}}),id:randomUUID()} as Environment;
 const failure=new SshProcessError('curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL',35);
 const trailer='\nMU_EGRESS_DIAGNOSTICS='+JSON.stringify({curlExitCode:'35',httpStatus:'000',tcp:'0.001',tls:'0',firstByte:'0',total:'0.203'})+'\n';
 await assert.rejects(measureEgress({egressProbeProxy:()=> 'socks5h://127.0.0.1:12345',management:async(_e,args,options)=>{if(args.at(-1)===EGRESS_RECEIVERS[0].url){options?.onOutput?.(trailer);throw failure;}return args.at(-1)===EGRESS_RECEIVERS[2].url?expectedIp:JSON.stringify({ip:expectedIp});}},env),error=>error===failure);
 assert.equal(retryClosedEgressReset(failure,expectedIp),true,'the same error remains eligible only while startup is closed');
 let active=false,failNext=false,probes=0,renewals=0,retryChecks=0;const teardown:string[]=[];
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const session=new WindowsNetworkSession({
  inspect:async()=>({digest:'a'.repeat(64),leaseActive:active,remainingMs:active?30000:0}),
  retryClosedProbe:error=>{retryChecks++;return retryClosedEgressReset(error,expectedIp);},
  probe:async()=>{probes++;if(failNext)throw failure;return [{receiver:'ipwho',ip:expectedIp},{receiver:'ipify',ip:expectedIp}];},
  activate:async()=>{active=true;},renew:async()=>{renewals++;},
  revoke:async()=>{teardown.push('revoke');active=false;await gate;},disconnect:async()=>{teardown.push('disconnect');await gate;},stop:async()=>{teardown.push('stop');await gate;},
 },expectedIp);
 await session.open();failNext=true;const rejected=assert.rejects(session.tick(),error=>error===failure);
 try{await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(session.state,'failed');assert.deepEqual(teardown.sort(),['disconnect','revoke','stop']);assert.equal(probes,2);assert.equal(retryChecks,0);assert.equal(renewals,0);assert.deepEqual(session.verifiedReceipts,[]);}finally{release();await rejected;}
});
test('Owned SSH diagnostics retain bounded codes across split lines without storing addresses or private text',()=>{
 const d=new WindowsTransportDiagnostics();d.ready();
 d.feed('channel 7: open failed: connect failed: Connec');d.feed('tion refused\r\n');
 d.feed('connect_to PRIVATE_HOST port 7897: failed.\n');d.feed('channel 9: open failed: administratively prohibited: PRIVATE_REASON\n');
 d.feed('client_loop: send disconnect: Broken pipe\n');d.feed('Timeout, server PRIVATE_SERVER not responding.\n');d.feed('private-user:password https://private.example/secret\n');
 const value=d.snapshot();assert.equal(value.state,'ready');assert.equal(value.failures.FORWARD_CONNECT_REFUSED,1);assert.equal(value.failures.FORWARD_CONNECT_FAILED,1);assert.equal(value.failures.FORWARD_ADMIN_DENIED,1);assert.equal(value.failures.TRANSPORT_BROKEN_PIPE,1);assert.equal(value.lastFailure,'TRANSPORT_TIMEOUT');assert.equal(value.ignoredLines,1);assert.equal(/PRIVATE|private|7897|channel/.test(JSON.stringify(value)),false);
 value.failures.FORWARD_CONNECT_REFUSED=99;assert.equal(d.snapshot().failures.FORWARD_CONNECT_REFUSED,1);
});
test('SSH diagnostics bound huge lines and freeze before intentional teardown without adopting later errors',()=>{
 const d=new WindowsTransportDiagnostics();d.ready();d.feed('x'.repeat(100000));d.feed('\nchannel 8: open failed: connect failed: Connection timed out\n');
 const value=d.snapshot();assert.ok(value.oversizedLines>0);assert.equal(value.failures.FORWARD_CONNECT_TIMEOUT,1);d.freeze();d.feed('client_loop: send disconnect: Connection reset by peer\n');d.ended();d.ready();assert.deepEqual(d.snapshot(),value);
 const other=new WindowsTransportDiagnostics();other.ended(true);assert.equal(other.snapshot().state,'spawn-failed');other.ended();assert.equal(other.snapshot().state,'exited');
});
test('Unexpected transport exit records only a bounded exit code and time',()=>{
 const d=new WindowsTransportDiagnostics();d.ready();d.ended(false,255);const value=d.snapshot();assert.equal(value.state,'exited');assert.equal(value.exitCode,255);assert.ok(Number.isFinite(Date.parse(value.exitAt!)));
 const invalid=new WindowsTransportDiagnostics();invalid.ended(false,9999);assert.equal(invalid.snapshot().exitCode,undefined);
 const intentional=new WindowsTransportDiagnostics();intentional.ready();intentional.freeze();intentional.ended(false,255);assert.equal(intentional.snapshot().exitAt,undefined);
});
test('A real separate stderr stream feeds SSH error codes while stdout stays outside the diagnostic',async()=>{
 const d=new WindowsTransportDiagnostics();d.ready();const child=spawn(process.execPath,['-e',"process.stderr.write('channel 2: open failed: connect failed: Connec');setTimeout(()=>{process.stderr.write('tion refused\\n');process.stdout.write('PRIVATE_STDOUT');},10)"],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 child.stderr!.on('data',chunk=>d.feed(chunk));const [code]=await once(child,'close');assert.equal(code,0);d.ended();const value=d.snapshot();assert.equal(value.state,'exited');assert.equal(value.failures.FORWARD_CONNECT_REFUSED,1);assert.equal(JSON.stringify(value).includes('PRIVATE_STDOUT'),false);
});
const environment=():Environment=>({...environmentSchema.parse({name:'Exit diagnostic process fixture',network:{mode:'http',host:'127.0.0.1',port:7897,strict:true,transparent:true,egressLock:{expectedIp}}}),id:randomUUID(),instanceName:'mu-diagnostic-process',state:'error',browserRunning:false,lastError:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
const marker=(code=97,extra:Record<string,string>={})=>'\nMU_EGRESS_DIAGNOSTICS='+JSON.stringify({curlExitCode:String(code),httpStatus:'000',tcp:'0.001',tls:'0',firstByte:'0',total:'0.302',...extra})+'\n';
async function failureThroughProcess(options:{code?:number;trailer?:string;pendingOthers?:boolean}={}){
 const e=environment(),code=options.code??97,issue=`curl: (${code}) ${code===60?'SSL certificate problem':"Can't complete SOCKS5 connection to ipv4.icanhazip.com. (1)"}`;
 const trailer=options.trailer??marker(code),pieces=[trailer.slice(0,17),trailer.slice(17)],cancelled:string[]=[];
 let callbackBytes=0;
 const failure=await measureEgress({egressProbeProxy:()=> 'socks5h://127.0.0.1:42125',management:async(_e,args,runOptions={})=>{
  const target=args.at(-1)!;
  if(target!==EGRESS_RECEIVERS[2].url){
   if(!options.pendingOthers)return target.includes('ipify')?JSON.stringify({ip:expectedIp}):JSON.stringify({ip:expectedIp,country:'Fixture'});
   return new Promise<string>((_,reject)=>{const cancel=()=>{cancelled.push(target);reject(new AppError('Synthetic probe cancelled',409,'CANCELLED'));};if(runOptions.signal?.aborted)cancel();else runOptions.signal?.addEventListener('abort',cancel,{once:true});});
  }
  // A real separate process has the same stderr/stdout contract as Windows
  // OpenSSH. It makes no network request and reads no guest or account data.
  const script=`process.stderr.write(${JSON.stringify(issue+'\n')});process.stdout.write('SYNTHETIC_PRIVATE_RESPONSE_DO_NOT_PERSIST\\n');process.stdout.write(${JSON.stringify(pieces[0])});setTimeout(()=>{process.stdout.write(${JSON.stringify(pieces[1])});process.exitCode=${code};},15);`;
  return runWindowsSsh(process.execPath,['-e',script],runOptions);
 }},e,{onOutput:text=>{callbackBytes+=Buffer.byteLength(text);}}).then(()=>{throw Error('Probe unexpectedly approved');},error=>error);
 assert.ok(failure instanceof AppError);assert.equal(failure.code,'PROCESS_FAILED');assert.equal(failure.message,issue);
 assert.ok(callbackBytes>trailer.length,'Existing observer still receives both streams');
 return {e,failure,checks:egressErrorChecks(failure),cancelled};
}

test('A real Windows SSH runner failure retains split stdout curl stages while its error remains stderr only',async()=>{
 const {checks,cancelled}=await failureThroughProcess({pendingOthers:true});
 const failed=checks.find(c=>c.receiver==='icanhazip')!;
 assert.equal(failed.status,'connection-error');
 assert.deepEqual(failed.diagnostics,{curlExitCode:97,httpStatus:0,tcpConnectMs:1,tlsHandshakeMs:0,firstByteMs:0,totalMs:302});
 assert.ok(checks.filter(c=>c.receiver!=='icanhazip').every(c=>c.status==='pending'));
 assert.equal(cancelled.length,2);
});

test('The Windows fault journal persists only numeric process stages and does not approve two receipts over curl 97',async()=>{
 const {e,failure,checks}=await failureThroughProcess(),root=await mkdtemp(path.join(tmpdir(),'mu-egress-diagnostic-'));
 const store=new Store(root,Buffer.alloc(32,5));
 try{
  store.save(e);assert.equal(checks.filter(c=>c.status==='success').length,2);
  const records=new WindowsProtectionEvents(store),id=records.record(e,failure),saved=store.protectionEvents(e.id)[0];
  assert.equal(saved.id,id);assert.equal(saved.kind,'connection');assert.equal(saved.stopResult,'requested');assert.equal(saved.resolvedAt,null);
  assert.equal(saved.checks.find(c=>c.receiver==='icanhazip')!.diagnostics!.curlExitCode,97);
  assert.equal(saved.issue,failure.message);assert.equal(JSON.stringify(saved).includes('SYNTHETIC_PRIVATE_RESPONSE'),false);assert.equal(JSON.stringify(saved).includes('MU_EGRESS_DIAGNOSTICS'),false);
 }finally{store.db.close();await rm(root,{recursive:true,force:true});}
});

test('A real stderr TLS error remains critical while stdout connection stages are captured',async()=>{
 const {checks}=await failureThroughProcess({code:60});
 assert.equal(checks.find(c=>c.receiver==='icanhazip')!.status,'tls-error');
 assert.equal(checks.find(c=>c.receiver==='icanhazip')!.diagnostics!.curlExitCode,60);
});

test('Malformed or oversized stdout diagnostics cannot replace the original process failure',async()=>{
 for(const trailer of [marker(97,{total:'bad'}),marker(97,{private:'x'.repeat(1200)})]){
  const {failure,checks}=await failureThroughProcess({trailer});
  assert.match(failure.message,/curl: \(97\)/);
  assert.equal(checks.find(c=>c.receiver==='icanhazip')!.status,'connection-error');
  assert.equal(checks.find(c=>c.receiver==='icanhazip')!.diagnostics,undefined);
 }
});
