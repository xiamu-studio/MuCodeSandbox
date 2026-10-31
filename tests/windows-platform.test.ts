import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { windowsConfigSchema, vmIdentity, NET_UID, PROBE_UID } from '../server/platform/windows/config.ts';
import { cloudInit, configureWindowsGuard,bootstrapScript,WINDOWS_LOCAL_GUEST_SERVICES,INSPECT_WINDOWS_GUARD } from '../server/platform/windows/guest.ts';
import { WindowsNetworkSession, type GuardDriver } from '../server/platform/windows/session.ts';
import { HyperVRuntime, powershellArgs, powershellPath, powershellScript } from '../server/platform/windows/runtime.ts';
import { run } from '../server/process.ts';
import { WindowsHostMonitor,windowsHostMonitorIssue,type WindowsHostMonitorFailure } from '../server/platform/windows/monitor.ts';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {runWindowsSsh} from '../server/platform/windows/ssh-process.ts';
import {checkFailure} from '../server/egress.ts';
import {AppError} from '../server/errors.ts';

const id='12345678-1234-4234-8234-123456789012';
const config=()=>windowsConfigSchema.parse({version:1,id,image:path.resolve('fixture.vhd'),imageSha256:'a'.repeat(64),proxy:{mode:'http',address:'127.0.0.1',port:12345},expectedIp:'203.0.113.10'});
test('Guard inspection retains only its trusted failing step while preserving the original error',async()=>{
 const {guardFailureSource}=await import('../server/platform/windows/guard-diagnostics.ts');
 for(const source of ['vm-inspection','guest-inspection','guard-response'] as const){
  const runtime=new HyperVRuntime('fixture'),original=Error('synthetic private detail');
  runtime.inspectVm=async()=>{if(source==='vm-inspection')throw original;return {};};
  runtime.management=async()=>{if(source==='guest-inspection')throw original;return 'invalid response';};
  await assert.rejects(runtime.inspectGuard(config()),error=>{assert.equal(guardFailureSource(error),source);if(source!=='guard-response')assert.equal(error,original);return true;});
 }
 assert.equal(guardFailureSource(Object.assign(Error('forged'),{failureSource:'guest-inspection'})),undefined);
});
test('Windows config refuses direct fallback, unknown fields, hostnames and shell input',()=>{
  for(const value of [{...config(),proxy:{mode:'direct',address:'127.0.0.1',port:80}},
    {...config(),proxy:{mode:'http',address:'example.test',port:80}}, {...config(),sharedHome:true},
    {...config(),timezone:'UTC; command'}, {...config(),id:'../../other-vm'}])assert.throws(()=>windowsConfigSchema.parse(value));
  assert.notDeepEqual(vmIdentity(id),vmIdentity('22345678-1234-4234-8234-123456789012'));
});

test('Windows SSH keeps successful diagnostics out of protocol stdout and preserves split UTF-8',async()=>{
 const script="const data=Buffer.from(JSON.stringify({text:'中文😀'}));process.stdout.write(data.subarray(0,11));process.stderr.write('close - IO is still pending on closed socket. read:1, write:0\\n');setTimeout(()=>process.stdout.write(data.subarray(11)),10);",observed:string[]=[];
 const text=await runWindowsSsh(process.execPath,['-e',script],{onOutput:part=>observed.push(part)});assert.deepEqual(JSON.parse(text),{text:'中文😀'});assert.equal(text.includes('IO is still pending'),false);assert.ok(observed.join('').includes('IO is still pending'));assert.match(await run(process.execPath,['-e',script]),/IO is still pending/);
});
test('Windows SSH passes exact binary stdin while returning only the guest stdout',async()=>{
 const bytes=Buffer.from([0,1,255,0,65,128]);const result=await runWindowsSsh(process.execPath,['-e',"const chunks=[];process.stdin.on('data',part=>chunks.push(part));process.stdin.on('end',()=>{process.stderr.write('synthetic diagnostic');process.stdout.write(Buffer.concat(chunks).toString('base64'));});"],{inputBytes:bytes});assert.deepEqual(Buffer.from(result,'base64'),bytes);
});
test('Windows SSH contains output callback failures and terminates the child',async()=>{
 for(const stream of ['stdout','stderr']){
  await assert.rejects(runWindowsSsh(process.execPath,['-e',`process.${stream}.write('ready');setInterval(()=>{},1000);`],{onOutput:()=>{throw Error('private diagnostic');},timeoutMs:5000}),{code:'PROCESS_OUTPUT_HANDLER_FAILED'});
 }
 assert.equal(await runWindowsSsh(process.execPath,['-e',"process.stdout.write('alive')"]),'alive');
});
test('Windows SSH reports explicit connection failures without treating remote command errors as receiver data',async()=>{
 for(const [exit,status] of [[255,'connection-error'],[7,'invalid-response']] as const){
  await assert.rejects(runWindowsSsh(process.execPath,['-e',`process.stderr.write('Connection reset by peer');process.exitCode=${exit}`]),error=>{assert.equal(checkFailure(error),status);return true;});
 }
});
test('Windows SSH nonzero exits remain errors and prefer diagnostic text over private stdout',async()=>{
 await assert.rejects(runWindowsSsh(process.execPath,['-e',"process.stdout.write('synthetic-private-payload');process.stderr.write('synthetic remote failure');process.exitCode=7;"]),error=>error instanceof Error&&error.message==='synthetic remote failure'&&'code' in error&&error.code==='PROCESS_FAILED');
});
test('Windows SSH cancellation and deadlines terminate their disposable process instead of returning partial output',async()=>{
 const abort=new AbortController();let enter!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),pending=assert.rejects(runWindowsSsh(process.execPath,['-e',"process.stdout.write('ready');setInterval(()=>{},1000);"],{signal:abort.signal,onOutput:()=>enter(),timeoutMs:5000}),{code:'CANCELLED'});await entered;abort.abort();await pending;await assert.rejects(runWindowsSsh(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:100}),{code:'TIMEOUT'});
});
test('Windows SSH refuses oversized protocol output and invalid limits',async()=>{
 await assert.rejects(runWindowsSsh(process.execPath,['-e',"process.stdout.write('x'.repeat(1024));setInterval(()=>{},1000);"],{maxBytes:16}),{code:'PROCESS_OUTPUT_TOO_LARGE'});for(const options of [{timeoutMs:0},{maxBytes:-1},{maxBytes:1.5}])await assert.rejects(runWindowsSsh(process.execPath,[],options),{code:'INVALID_SSH_LIMIT'});
});
test('NoCloud seed contains no default gateway, package downloads, host mounts or dev sudo',()=>{
  const c=config(),key='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestFixture';
  const seed=cloudInit(c,key,'fixture-private-not-a-real-key',key);
  const user=parse(seed['user-data']),network=parse(seed['network-config']);
  assert.equal(user.users.find((u:{name:string})=>u.name==='dev').sudo,null);
  assert.equal(user.users.find((u:{name:string})=>u.name==='mu-net').uid,NET_UID);
  assert.equal(user.users.find((u:{name:string})=>u.name==='mu-probe').uid,PROBE_UID);
  assert.equal(network.ethernets.management.dhcp4,false);
  assert.equal(network.ethernets.management.dhcp6,false);
  assert.equal(network.ethernets.management['accept-ra'],false);
  assert.equal(network.ethernets.management['set-name'],'eth0');
  assert.equal(network.ethernets.management.optional,true);
  assert.equal(network.ethernets.management.routes,undefined);
  assert.equal(user.packages,undefined);assert.equal(user.mounts,undefined);
  assert.equal(user.ssh_pwauth,false);
});
test('Windows guest uses shared default-drop firewall and expiring 45-second permit',()=>{
  const {script}=configureWindowsGuard(config());
  assert.match(script,/policy drop/);assert.match(script,/timeout 45s/);
  assert.match(script,/CLOCK_BOOTTIME/);assert.match(script,/172\.29\./);
  assert.match(script,/ipv4_only/);assert.match(script,/127\.0\.0\.1/);
  assert.doesNotMatch(script,/linux-arm64|--no-sandbox|disable-web-security/);
});

const cloudAgentShell=String.raw`set -eu
w_state=active; a_state=unknown; w_mask=enabled; a_mask=missing; stops=0; masks=0
if [ "$MU_AGENT_MODE" = inactive ]; then w_state=inactive; fi
sudo(){ "$@"; }
systemctl(){
 local action=$1 prop=$2 called_unit state mask
 for called_unit in "$@"; do :; done
 if [ "$called_unit" = walinuxagent.service ]; then state=$w_state;mask=$w_mask;else state=$a_state;mask=$a_mask;fi
 case "$action" in
  is-active) if [ "$MU_AGENT_MODE" = unknown-state ];then printf '%s\n' unexpected;return 3;fi;printf '%s\n' "$state";[ "$state" = active ] ;;
  stop) [ "$MU_AGENT_MODE" != stop-failed ] || return 1;stops=$((stops+1));if [ "$called_unit" = walinuxagent.service ];then w_state=inactive;else a_state=inactive;fi ;;
  mask) [ "$MU_AGENT_MODE" != mask-failed ] || return 1;masks=$((masks+1));if [ "$called_unit" = walinuxagent.service ];then w_mask=masked;else a_mask=masked;a_state=inactive;fi ;;
  is-enabled) if [ "$MU_AGENT_MODE" = unmasked ];then printf '%s\n' enabled;return 0;fi;printf '%s\n' "$mask";return 1 ;;
  show) case "$prop" in
   --property=ActiveState) if [ "$MU_AGENT_MODE" = still-active ];then printf '%s\n' active;else printf '%s\n' "$state";fi ;;
   --property=MainPID) if [ "$MU_AGENT_MODE" = live-pid ];then printf '%s\n' 42;else printf '%s\n' 0;fi ;;
   *) return 99 ;;
  esac ;;
  *) return 99 ;;
 esac
}
`;
const runCloudAgent=(mode:string)=>run(process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'/bin/bash',['-s'],{input:cloudAgentShell+'\n'+WINDOWS_LOCAL_GUEST_SERVICES+'\nprintf "stops=%s masks=%s\\n" "$stops" "$masks"\n',env:{...process.env,MU_AGENT_MODE:mode},timeoutMs:10000});
test('Windows local guest preparation stops a running cloud agent and persistently masks its absent alias without requiring successful is-enabled exit status',async()=>{
 assert.match(await runCloudAgent('active'),/stops=1 masks=2/);assert.match(await runCloudAgent('inactive'),/stops=0 masks=2/);
});
test('Failed stopping, masking, unexpected states and surviving agent processes prevent local guest admission',async()=>{
 for(const mode of ['stop-failed','mask-failed','unmasked','still-active','live-pid','unknown-state'])await assert.rejects(runCloudAgent(mode),{code:'PROCESS_FAILED'});
});
test('Windows seeds, builders and every runtime admission disable cloud agents, while integrity inspection requires persistent masks and no active process',()=>{
 const key='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestFixture',seed=parse(cloudInit(config(),key,'fixture-private',key)['user-data']);assert.ok(seed.runcmd.includes(WINDOWS_LOCAL_GUEST_SERVICES));assert.ok(bootstrapScript(config()).includes(WINDOWS_LOCAL_GUEST_SERVICES));assert.ok(configureWindowsGuard(config()).script.includes(WINDOWS_LOCAL_GUEST_SERVICES));assert.match(INSPECT_WINDOWS_GUARD,/Cloud agent mask changed/);assert.match(INSPECT_WINDOWS_GUARD,/--property=UnitFileState/);assert.match(INSPECT_WINDOWS_GUARD,/--property=MainPID/);assert.doesNotMatch(INSPECT_WINDOWS_GUARD,/cmd\('systemctl','is-enabled',unit\)/);
});

function fixture(){
  const calls:string[]=[];let active=false,digest='a'.repeat(64);let receipts=[{receiver:'a',ip:'203.0.113.10'},{receiver:'b',ip:'203.0.113.10'}];
  const d:GuardDriver={inspect:async()=>({digest,leaseActive:active,remainingMs:active?45000:0}),probe:async()=>receipts,
    activate:async()=>{calls.push('activate');active=true;},renew:async()=>{calls.push('renew');},
    revoke:async()=>{calls.push('revoke');active=false;},disconnect:async()=>{calls.push('disconnect');},stop:async()=>{calls.push('stop');}};
  return {d,calls,session:new WindowsNetworkSession(d,'203.0.113.10'),change:()=>{digest='b'.repeat(64);},expire:()=>{active=false;},receipts:(v:typeof receipts)=>{receipts=v;}};
}

test('A confirmed closed-guard retry uses fresh receipts and never runs on active renewal',async()=>{
 const f=fixture();let probes=0,inspections=0;const inspect=f.d.inspect;f.d.inspect=async()=>{inspections++;return inspect();};
 f.d.retryClosedProbe=()=>true;f.d.probe=async()=>{if(++probes===1)throw Error('synthetic reset');assert.equal(f.calls.includes('activate'),false);return [{receiver:'a',ip:'203.0.113.10'},{receiver:'b',ip:'203.0.113.10'}];};
 await f.session.open();assert.equal(probes,2);assert.equal(inspections,4);assert.equal(f.session.state,'active');assert.equal(f.calls.filter(x=>x==='activate').length,1);
 f.d.probe=async()=>{probes++;throw Error('active reset');};await assert.rejects(f.session.tick(),/active reset/);assert.equal(probes,3);assert.equal(f.session.state,'failed');assert.equal(f.calls.includes('renew'),false);
});
test('Closed retry refuses changed protection, conflicting receipts and a second failure',async()=>{
 for(const mode of ['changed','mismatch','second-failure'] as const){const f=fixture();let probes=0;f.d.retryClosedProbe=()=>true;f.d.probe=async()=>{if(++probes===1){if(mode==='changed')f.change();throw Error('reset');}if(mode==='second-failure')throw Error('reset again');return [{receiver:'a',ip:'203.0.113.10'},{receiver:'b',ip:'203.0.113.11'}];};await assert.rejects(f.session.open());assert.equal(f.calls.includes('activate'),false);assert.equal(f.session.state,'failed');assert.equal(probes,mode==='changed'?1:2);}
});

test('Cancelled startup never retries a probe or opens a closed network permit',async()=>{
 for(const point of ['first-failure','retry-inspection','successful-probe','post-inspection'] as const){
  const f=fixture(),abort=new AbortController(),inspect=f.d.inspect,probe=f.d.probe;let inspections=0,probes=0;
  f.d.retryClosedProbe=()=>true;
  f.d.inspect=async()=>{const value=await inspect();inspections++;if((point==='retry-inspection'||point==='post-inspection')&&inspections===2)abort.abort();return value;};
  f.d.probe=async()=>{probes++;if(point==='first-failure'||point==='retry-inspection'){if(point==='first-failure')abort.abort();throw Error('synthetic reset');}if(point==='successful-probe')abort.abort();return probe();};
  await assert.rejects(f.session.open(abort.signal));assert.equal(f.session.state,'failed');assert.equal(probes,1);assert.equal(f.calls.includes('activate'),false);assert.deepEqual(f.calls.slice(-3).sort(),['disconnect','revoke','stop']);
 }
});

test('Windows startup cancellation reaches all in-flight exit probes',async()=>{
 const runtime=new HyperVRuntime('fixture'),abort=new AbortController();let probes=0,cancelled=0,activated=0,stopped=0,entered!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve);
 runtime.configure=async()=> '12345678-1234-4234-8234-123456789012';runtime.inspectGuard=async()=>({digest:'a'.repeat(64),leaseActive:false,remainingMs:0});
 runtime.egressProbeProxy=()=> 'socks5h://127.0.0.1:12345';
 runtime.management=async(_c,_command,options={})=>new Promise<string>((_resolve,reject)=>{probes++;if(probes===3)entered();const signal=options.signal!;if(signal.aborted){cancelled++;reject(Error('cancelled'));return;}signal.addEventListener('abort',()=>{cancelled++;reject(Error('cancelled'));},{once:true});});
 runtime.lease=async(_c,_token,action)=>{if(action==='activate')activated++;};runtime.disconnect=async()=>{};runtime.stop=async()=>{stopped++;};
 const session=await runtime.session(config()),opening=session.open(abort.signal);await started;abort.abort();await assert.rejects(opening);
 assert.equal(probes,3);assert.equal(cancelled,3);assert.equal(activated,0);assert.equal(stopped,1);assert.equal(session.state,'failed');
});

for(const mode of ['normal-stop','protection-failure','startup-failure'] as const)test(`Session ${mode} cancels all production-runtime exit probes`,async()=>{
 const runtime=new HyperVRuntime('fixture');let active=false,pending=mode==='startup-failure',probes=0,cancelled=0,renewed=0,stopped=0,faults=0,entered!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve);
 runtime.configure=async()=> '12345678-1234-4234-8234-123456789012';
 runtime.inspectGuard=async()=>({digest:'a'.repeat(64),leaseActive:active,remainingMs:active?45000:0});
 runtime.egressProbeProxy=()=> 'socks5h://127.0.0.1:12345';
 runtime.management=async(_c,command,options={})=>{
  if(!pending)return command.at(-1)?.includes('icanhazip')?'203.0.113.10\n':'{"ip":"203.0.113.10"}';
  return new Promise<string>((_resolve,reject)=>{if(++probes===3)entered();const signal=options.signal!;
   const cancel=()=>{cancelled++;reject(new AppError('Synthetic probe cancelled',409,'CANCELLED'));};
   if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
  });
 };
 runtime.lease=async(_c,_token,action)=>{if(action==='renew')renewed++;active=action!=='revoke';};
 runtime.disconnect=async()=>{};runtime.stop=async()=>{stopped++;};
 const session=await runtime.session(config());session.onFailure=()=>faults++;
 if(mode!=='startup-failure'){await session.open();pending=true;}
 const reading=(mode==='startup-failure'?session.open():session.tick()).then(()=>null,error=>error);await started;
 if(mode==='normal-stop')await session.stopNormally(async()=>{});else await session.fail();
 const error=await reading;assert.equal(probes,3);assert.equal(cancelled,3);assert.equal(renewed,0);assert.equal(stopped,1);assert.equal(session.state,'failed');
 if(mode==='normal-stop'){assert.equal(error,null);assert.equal(faults,0);}else assert.ok(error instanceof Error);
});

test('Inconsistent closed lease observations cannot activate business networking',async()=>{
 const {windowsGuardDiagnostics}=await import('../server/platform/windows/guard-diagnostics.ts');
 for(const inconsistentAt of [1,2]){
  const f=fixture(),inspect=f.d.inspect;let count=0,error:unknown;f.session.onFailure=value=>{error=value;};
  f.d.inspect=async()=>{const result=await inspect();return ++count===inconsistentAt?{...result,remainingMs:1000}:result;};
  await assert.rejects(f.session.open());assert.equal(f.session.state,'failed');assert.equal(f.calls.includes('activate'),false);
  assert.deepEqual(f.calls.slice(-3).sort(),['disconnect','revoke','stop']);assert.equal(windowsGuardDiagnostics(error)?.reason,'lease-range');
 }
});

test('Verified receipt time is captured when the probe completes, not after later guard and renewal delays',async()=>{
 const f=fixture();let probes=0,postProbeInspectionStarted=0;
 f.d.probe=async()=>{probes++;return [{receiver:'a',ip:'203.0.113.10'},{receiver:'b',ip:'203.0.113.10'}];};
 const inspect=f.d.inspect;let inspections=0;f.d.inspect=async()=>{inspections++;if(inspections===2||inspections===5){postProbeInspectionStarted=Date.now();await new Promise(resolve=>setTimeout(resolve,40));}return inspect();};
 await f.session.open();assert.ok(Date.parse(f.session.verifiedAt!)<=postProbeInspectionStarted,'Opening must retain the probe time before the following inspection');
 await f.session.tick();assert.equal(probes,2);assert.ok(Date.parse(f.session.verifiedAt!)<=postProbeInspectionStarted,'Renewal must retain the probe time before the following inspection');await f.session.fail();
});

test('Guard failure captures the original SSH evidence before teardown and keeps all independent stops',async()=>{
 const {WindowsTransportDiagnostics}=await import('../server/platform/windows/transport-diagnostics.ts'),{windowsGuardDiagnostics}=await import('../server/platform/windows/guard-diagnostics.ts');
 const f=fixture();await f.session.open();const diagnostic=new WindowsTransportDiagnostics();diagnostic.ready();diagnostic.feed('channel 4: open failed: connect failed: Connection refused\n');f.d.transportDiagnostics=()=>diagnostic.snapshot();
 const originalDisconnect=f.d.disconnect;f.d.disconnect=async()=>{diagnostic.freeze();diagnostic.feed('client_loop: send disconnect: Broken pipe\n');await originalDisconnect();};
 const failure=Error('Synthetic critical probe failure');f.d.probe=async()=>{throw failure;};await assert.rejects(f.session.tick(),error=>error===failure);
 const value=windowsGuardDiagnostics(failure)!;assert.equal(value.stage,'probe');assert.equal(value.transport!.state,'ready');assert.equal(value.transport!.failures.FORWARD_CONNECT_REFUSED,1);assert.equal(value.transport!.failures.TRANSPORT_BROKEN_PIPE,undefined);assert.equal(f.session.state,'failed');assert.deepEqual(f.calls.slice(-3).sort(),['disconnect','revoke','stop']);assert.equal(f.calls.includes('renew'),false);
 value.transport!.failures.FORWARD_CONNECT_REFUSED=9;assert.equal(windowsGuardDiagnostics(failure)!.transport!.failures.FORWARD_CONNECT_REFUSED,1);
});
test('An unavailable optional transport diagnostic cannot replace a protection failure or skip teardown',async()=>{
 const f=fixture();await f.session.open();f.d.transportDiagnostics=()=>{throw Error('Synthetic diagnostic unavailable');};const original=Error('Synthetic probe failure');f.d.probe=async()=>{throw original;};await assert.rejects(f.session.tick(),error=>error===original);assert.equal(f.session.state,'failed');assert.deepEqual(f.calls.slice(-3).sort(),['disconnect','revoke','stop']);
});

test('Guard diagnostics distinguish post-probe integrity drift from expiration, keep phase evidence and never renew either failure',async()=>{
 const {windowsGuardDiagnostics}=await import('../server/platform/windows/guard-diagnostics.ts');
 for(const fault of ['integrity','expiry','range'] as const){
  const f=fixture();await f.session.open();let count=0;
  const inspect=f.d.inspect;f.d.inspect=async()=>{const value=await inspect();return ++count===2?{...value,...(fault==='integrity'?{digest:'b'.repeat(64)}:fault==='expiry'?{leaseActive:false,remainingMs:0}:{remainingMs:45001})}:value;};
  let failure:unknown;f.session.onFailure=e=>{failure=e;assert.ok(f.calls.includes('stop'),'teardown must start before recording');};
  await assert.rejects(f.session.tick());const evidence=windowsGuardDiagnostics(failure)!;
  assert.equal(evidence.operation,'tick');assert.equal(evidence.stage,'after-inspection');assert.equal(evidence.reason,fault==='integrity'?'integrity-changed':fault==='expiry'?'lease-inactive':'lease-range');
  assert.equal(evidence.before?.leaseActive,true);assert.equal(evidence.after?.digestMatches,fault!=='integrity');assert.equal(evidence.verifiedReceiptCount,2);
  for(const key of ['beforeInspectMs','probeMs','afterInspectMs'] as const)assert.ok(Number.isFinite(evidence.durations[key]));
  assert.equal(f.calls.includes('renew'),false);assert.equal(f.session.state,'failed');
 }
});

test('Guard diagnostics retain probe errors without inventing a post-inspection or trusting arbitrary error fields',async()=>{
 const {windowsGuardDiagnostics}=await import('../server/platform/windows/guard-diagnostics.ts');const f=fixture();await f.session.open();const original=Error('synthetic probe failure');f.d.probe=async()=>{throw original;};
 await assert.rejects(f.session.tick(),error=>error===original);const evidence=windowsGuardDiagnostics(new AggregateError([original],'cleanup',{cause:original}))!;
 assert.equal(evidence.reason,'probe-failed');assert.equal(evidence.stage,'probe');assert.equal(evidence.after,undefined);assert.equal(evidence.verifiedReceiptCount,0);assert.ok(Number.isFinite(evidence.durations.probeMs));assert.equal(windowsGuardDiagnostics(Object.assign(Error('untrusted'),{guard:evidence})),undefined);
 evidence.reason='lease-inactive';assert.equal(windowsGuardDiagnostics(original)?.reason,'probe-failed');
});
test('Startup and running guard failures retain only trusted fixed error codes',async()=>{
 const {windowsGuardDiagnostics}=await import('../server/platform/windows/guard-diagnostics.ts');
 const {AppError}=await import('../server/errors.ts');
 for(const phase of ['open','tick'] as const){
  const f=fixture();if(phase==='tick')await f.session.open();
  const error=new AppError('private synthetic detail',500,'PROCESS_FAILED');f.d.inspect=async()=>{throw error;};
  await assert.rejects(phase==='open'?f.session.open():f.session.tick());
  const evidence=windowsGuardDiagnostics(error)!;assert.equal(evidence.failureCode,'PROCESS_FAILED');
  assert.equal(evidence.stage,'before-inspection');assert.equal(JSON.stringify(evidence).includes('private synthetic detail'),false);
 }
 const f=fixture(),untrusted=Object.assign(Error('synthetic'),{code:'TIMEOUT'});f.d.inspect=async()=>{throw untrusted;};
 await assert.rejects(f.session.open());assert.equal(windowsGuardDiagnostics(untrusted)?.failureCode,undefined);
});

test('Guard component hashes are optional for old inspectors, strict for new inspectors, and only expose changed categories',async()=>{
 const {windowsGuardInspection,windowsGuardDiagnostics}=await import('../server/platform/windows/guard-diagnostics.ts');
 const base={digest:'a'.repeat(64),leaseActive:true,remainingMs:40000},components={tables:'a'.repeat(64),files:'a'.repeat(64),networkRules:'a'.repeat(64),networkRoutes:'a'.repeat(64),networkDns:'a'.repeat(64),networkDomains:'a'.repeat(64)};
 assert.deepEqual(windowsGuardInspection.parse(base),base);assert.deepEqual(windowsGuardInspection.parse({...base,components}).components,components);
 for(const value of [{...base,components:{...components,files:'/private/path'}},{...base,components:{...components,password:'private'}},{...base,components:{tables:'a'.repeat(64)}},{...base,remainingMs:45001},{...base,remainingMs:NaN},{...base,rawRoutes:'private'}])assert.throws(()=>windowsGuardInspection.parse(value));
 const f=fixture(),inspect=f.d.inspect;f.d.inspect=async()=>({...await inspect(),components});await f.session.open();f.d.inspect=async()=>({...await inspect(),digest:'b'.repeat(64),components:{...components,networkRoutes:'b'.repeat(64)}});let error:unknown;f.session.onFailure=e=>{error=e;};await assert.rejects(f.session.tick());
 assert.deepEqual(windowsGuardDiagnostics(error)?.before?.changedComponents,['networkRoutes']);assert.equal(JSON.stringify(windowsGuardDiagnostics(error)).includes('a'.repeat(64)),false);
});

test('Late inspection, failed activation and failed renewal retain their own stages without reopening the permit',async()=>{
 const {windowsGuardDiagnostics}=await import('../server/platform/windows/guard-diagnostics.ts');
 for(const fault of ['late','activation','renewal'] as const){
  const f=fixture();let error:unknown;f.session.onFailure=e=>{error=e;};
  if(fault==='activation'){f.d.activate=async()=>{throw Error('activation unavailable');};await assert.rejects(f.session.open());}
  else {await f.session.open();if(fault==='late'){const inspect=f.d.inspect;f.d.inspect=async()=>{const value=await inspect();await f.session.fail();return value;};}else f.d.renew=async()=>{throw Error('renewal unavailable');};await assert.rejects(f.session.tick());}
  const value=windowsGuardDiagnostics(error)!;assert.equal(value.reason,fault==='late'?'session-retired':fault==='activation'?'activation-failed':'renewal-failed');assert.equal(value.stage,fault==='late'?'before-inspection':fault==='activation'?'activation':'renewal');assert.equal(f.session.state,'failed');assert.equal(f.calls.filter(c=>c==='activate').length,fault==='activation'?0:1);
 }
});
test('Business permit opens only after two distinct matching receivers and closes terminally',async()=>{
  const f=fixture();await f.session.open();assert.equal(f.session.state,'active');await f.session.tick();
  assert.deepEqual(f.calls,['activate','renew']);await f.session.fail();assert.equal(f.session.state,'failed');
  await f.session.tick();await assert.rejects(f.session.open());assert.equal(f.calls.filter(c=>c==='activate').length,1);
});
test('Mismatched, missing or duplicate receipts never open the permit',async()=>{
  for(const receipts of [[{receiver:'a',ip:'203.0.113.10'}],[{receiver:'a',ip:'203.0.113.10'},{receiver:'a',ip:'203.0.113.10'}],[{receiver:'a',ip:'203.0.113.10'},{receiver:'b',ip:'203.0.113.11'}]]){
    const f=fixture();f.receipts(receipts);await assert.rejects(f.session.open());
    assert.equal(f.session.state,'failed');assert.ok(!f.calls.includes('activate'));assert.ok(f.calls.includes('disconnect'));assert.ok(f.calls.includes('stop'));
  }
});
test('Tampered rules, expired leases and probe errors close egress without renewal',async()=>{
  for(const fault of ['rules','expiry','probe']){
    const f=fixture();await f.session.open();
    if(fault==='rules')f.change();else if(fault==='expiry')f.expire();else f.d.probe=async()=>{throw Error('timeout');};
    await assert.rejects(f.session.tick());assert.equal(f.session.state,'failed');assert.ok(!f.calls.includes('renew'));
    assert.ok(f.calls.includes('disconnect'));assert.ok(f.calls.includes('revoke'));assert.ok(f.calls.includes('stop'));
  }
});
test('A late startup probe after shutdown cannot activate a permit',async()=>{
  const f=fixture();let resolve!:(v:{receiver:string;ip:string}[])=>void;
  f.d.probe=()=>new Promise(r=>{resolve=r;});const opening=f.session.open();
  while(!resolve)await new Promise(r=>setImmediate(r));
  await f.session.fail();resolve([{receiver:'a',ip:'203.0.113.10'},{receiver:'b',ip:'203.0.113.10'}]);
  await assert.rejects(opening);assert.ok(!f.calls.includes('activate'));
});
test('Every shutdown path is attempted even if SSH revocation fails',async()=>{
  const f=fixture();f.d.revoke=async()=>{throw Error('SSH gone');};
  await f.session.fail();assert.equal(f.session.cleanupWarnings.length,1);assert.ok(f.calls.includes('disconnect'));assert.ok(f.calls.includes('stop'));
});
test('An unconfirmed hypervisor shutdown remains an error',async()=>{
  const f=fixture();f.d.stop=async()=>{throw Error('Hyper-V unavailable');};await assert.rejects(f.session.fail());assert.equal(f.session.state,'failed');
});
test('A stopped host monitor cannot create a timer from a late initial snapshot',async t=>{
 t.mock.timers.enable({apis:['setInterval']});const timer=t.mock.method(globalThis,'setInterval');
 let release!:(value:string)=>void;const snapshot=new Promise<string>(resolve=>release=resolve);
 const monitor=new WindowsHostMonitor(()=>snapshot,()=>assert.fail('Stopped monitor reported a failure'));
 const pending=monitor.start();monitor.stop();release('baseline');
 await assert.rejects(pending,/stopped during startup/);assert.equal(timer.mock.calls.length,0);
 await assert.rejects(monitor.start(),/cannot be restarted/);
});
test('Concurrent host monitor startup creates exactly one watcher',async t=>{
 t.mock.timers.enable({apis:['setInterval']});const timer=t.mock.method(globalThis,'setInterval');
 let release!:(value:string)=>void;const snapshot=new Promise<string>(resolve=>release=resolve);
 const monitor=new WindowsHostMonitor(()=>snapshot,()=>{});
 try{
  const first=monitor.start(),second=monitor.start(),results=Promise.allSettled([first,second]);release('baseline');
  const settled=await results;assert.equal(settled[0].status,'fulfilled');assert.equal(settled[1].status,'rejected');
  assert.equal(timer.mock.calls.length,1);
 }finally{monitor.stop();}
});
test('Host changes, failed snapshots and long suspend gaps close protection',async()=>{
  for(const mode of ['change','error','sleep','backwards']){
    let snapshot='baseline',failed=0,broken=false,reason:WindowsHostMonitorFailure|undefined;
    const monitor=new WindowsHostMonitor(async()=>{if(broken)throw Error('secret monitor data');return snapshot;},value=>{failed++;reason=value;});
    try{
      await monitor.start();
      if(mode==='change')snapshot='changed';if(mode==='error')broken=true;
      await monitor.poll(mode==='sleep'?Date.now()+16000:mode==='backwards'?Date.now()-16000:Date.now());
      assert.equal(failed,1);assert.equal(reason,({change:'snapshot-changed',error:'snapshot-error',sleep:'poll-gap',backwards:'clock-backwards'} as const)[mode as 'change'|'error'|'sleep'|'backwards']);assert.ok(!windowsHostMonitorIssue(reason!).includes('secret'));await monitor.poll();assert.equal(failed,1);
    }finally{monitor.stop();}
  }
});
test('A slow completed host snapshot fails even when no interval ran while it was pending',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100000});
 let calls=0,release!:(value:string)=>void;const pending=new Promise<string>(resolve=>release=resolve),reasons:WindowsHostMonitorFailure[]=[];
 const monitor=new WindowsHostMonitor(async()=>++calls===1?'baseline':pending,reason=>reasons.push(reason));
 try{
  await monitor.start();const reading=monitor.poll();t.mock.timers.tick(8001);release('baseline');await reading;
  assert.deepEqual(reasons,['snapshot-timeout']);await monitor.poll();assert.deepEqual(reasons,['snapshot-timeout']);
 }finally{release('baseline');monitor.stop();}
});
test('A host snapshot completed within its deadline remains usable',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100000});let calls=0;const reasons:WindowsHostMonitorFailure[]=[];
 const monitor=new WindowsHostMonitor(async()=>{if(++calls>1)t.mock.timers.tick(8000);return 'baseline';},reason=>reasons.push(reason));
 try{await monitor.start();await monitor.poll();assert.deepEqual(reasons,[]);}finally{monitor.stop();}
});
test('A stopped monitor ignores a slow late completion',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100000});let calls=0,release!:(value:string)=>void;
 const pending=new Promise<string>(resolve=>release=resolve),reasons:WindowsHostMonitorFailure[]=[];
 const monitor=new WindowsHostMonitor(async()=>++calls===1?'baseline':pending,reason=>reasons.push(reason));
 try{await monitor.start();const reading=monitor.poll();monitor.stop();t.mock.timers.tick(8001);release('changed');await reading;assert.deepEqual(reasons,[]);}finally{release('baseline');monitor.stop();}
});
test('A stalled host snapshot reports its own timeout once without recording snapshot contents',async()=>{
 let calls=0,release!:()=>void;const pending=new Promise<string>(resolve=>release=()=>resolve('synthetic-private-snapshot'));const reasons:WindowsHostMonitorFailure[]=[];
 const monitor=new WindowsHostMonitor(async()=>++calls===1?'baseline':pending,reason=>reasons.push(reason));
 try{await monitor.start();const first=monitor.poll();await monitor.poll(Date.now()+9000);assert.deepEqual(reasons,['snapshot-timeout']);release();await first;assert.deepEqual(reasons,['snapshot-timeout']);assert.ok(!windowsHostMonitorIssue(reasons[0]).includes('synthetic-private-snapshot'));}finally{release();monitor.stop();}
});
test('Host monitor identifies changed network categories without exposing snapshot data',async()=>{
 const base={adapters:[{name:'private-adapter'}],routes:[{nextHop:'192.0.2.1'}],dns:[{address:'192.0.2.2'}]};
 for(const [changed,expected] of [
  [{...base,adapters:[{name:'other'}]},'snapshot-adapters'],
  [{...base,routes:[{nextHop:'192.0.2.3'}]},'snapshot-routes'],
  [{...base,dns:[{address:'192.0.2.4'}]},'snapshot-dns'],
  [{...base,dns:[],routes:[]},'snapshot-multiple']
 ] as const){
  let source=JSON.stringify(base),reason:WindowsHostMonitorFailure|undefined;
  const runtime=new HyperVRuntime(tmpdir(),async()=>source);const monitor=new WindowsHostMonitor(()=>runtime.fingerprint(),value=>{reason=value;});
  try{const fingerprint=await runtime.fingerprint();assert.ok(!fingerprint.includes('192.0.2.')&&!fingerprint.includes('private-adapter'));await monitor.start();source=JSON.stringify(changed);await monitor.poll();assert.equal(reason,expected);assert.ok(!windowsHostMonitorIssue(reason!).includes('192.0.2.'));}finally{monitor.stop();}
 }
});
test('Windows doctor actually queries this machine without creating resources',{skip:process.platform!=='win32'},async()=>{
  const f=new HyperVRuntime(path.join(tmpdir(),'mu-windows-doctor'));
  const result=await f.info();assert.equal(typeof result.available,'boolean');assert.ok(Array.isArray(result.issues));
});
test('PowerShell JSON transport preserves Chinese paths and suppresses progress XML',{skip:process.platform!=='win32'},async()=>{
  const input=JSON.stringify({path:'C:\\Users\\测试用户\\虚拟机',value:'输入与输出'});
  const output=await run(powershellPath(),powershellArgs("Write-Progress -Activity 'module initialization' -Status 'loading'; [Console]::Out.Write([Console]::In.ReadToEnd())"),{input});
  assert.equal(output,input);
});
test('Native Hyper-V helper builds, validates endpoint layout and rejects wildcard IDs',{skip:process.platform!=='win32'},async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mu-channel-'));
  try{
    const runtime=new HyperVRuntime(directory),helper=await runtime.channelHelper();
    assert.match(await run(helper,['--self-test']),/layout verified/);
    await assert.rejects(run(helper,['00000000-0000-0000-0000-000000000000']));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('Native helper compilation works with process Restricted policy without changing machine policy',{skip:process.platform!=='win32'},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'mu-restricted-channel-'));
 const restricted:typeof run=(file,args,options)=>run(file,file===powershellPath()?['-ExecutionPolicy','Restricted',...args]:args,options);
 try{const helper=await new HyperVRuntime(directory,restricted).channelHelper();assert.match(await run(helper,['--self-test']),/layout verified/);}
 finally{const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.match(path.basename(target),/^mu-restricted-channel-/);await rm(target,{recursive:true,force:true});}
});
test('The loopback transport exits when its owning controller is killed',{skip:process.platform!=='win32',timeout:15000},async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mu-channel-owner-'));let owner:ReturnType<typeof spawn>|undefined,helperPid=0;
  try{
    const helper=await new HyperVRuntime(directory).channelHelper();
    const code=`const {spawn}=require('node:child_process');const c=spawn(${JSON.stringify(helper)},['--listen','12345678-1234-4234-8234-123456789012',String(process.pid)],{stdio:['pipe','pipe','pipe']});c.stdin.write('.');c.stdout.once('data',b=>process.stdout.write(JSON.stringify({pid:c.pid,port:JSON.parse(b.toString()).port})+'\\n'));setInterval(()=>{},1000);`;
    owner=spawn(process.execPath,['-e',code],{stdio:['pipe','pipe','pipe']});
    const ready=await new Promise<{pid:number;port:number}>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Controller fixture did not start')),5000);owner!.stdout!.once('data',b=>{clearTimeout(timer);try{resolve(JSON.parse(b.toString()));}catch(e){reject(e);}});owner!.once('error',reject);});
    helperPid=ready.pid;assert.ok(ready.port>0);owner.kill('SIGKILL');
    const deadline=Date.now()+5000;for(;;){try{process.kill(helperPid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')break;throw e;}assert.ok(Date.now()<deadline,'Native transport survived controller exit');await delay(100);}
  }finally{owner?.kill();if(helperPid)try{process.kill(helperPid);}catch{}await rm(directory,{recursive:true,force:true});}
});
test('Windows IMAPI creates a readable NoCloud ISO with exact filenames',{skip:process.platform!=='win32'},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'mu-iso-'));
  try {
    const source=path.join(root,'seed');await mkdir(source);
    for(const name of ['user-data','meta-data','network-config'])await writeFile(path.join(source,name),'fixture\n');
    const target=path.join(root,'seed.iso');
    const script=powershellScript(path.resolve('scripts/windows/seed-iso.ps1'));
    await run(powershellPath(),['-ExecutionPolicy','Restricted',...powershellArgs(`${script} -Source '${source.replaceAll("'","''")}' -Destination '${target.replaceAll("'","''")}'`)]);
    const bytes=await readFile(target);assert.equal(bytes.subarray(16*2048+1,16*2048+6).toString(),'CD001');
    const names=await run('tar.exe',['-tf',target]);for(const name of ['user-data','meta-data','network-config'])assert.ok(names.includes(name));
  } finally {await rm(root,{recursive:true,force:true});}
});
