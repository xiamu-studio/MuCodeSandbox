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
import { WindowsHostMonitor } from '../server/platform/windows/monitor.ts';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {runWindowsSsh} from '../server/platform/windows/ssh-process.ts';

const id='12345678-1234-4234-8234-123456789012';
const config=()=>windowsConfigSchema.parse({version:1,id,image:path.resolve('fixture.vhd'),imageSha256:'a'.repeat(64),proxy:{mode:'http',address:'127.0.0.1',port:12345},expectedIp:'203.0.113.10'});
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
test('Host changes, failed snapshots and long suspend gaps close protection',async()=>{
  for(const mode of ['change','error','sleep','backwards']){
    let snapshot='baseline',failed=0,broken=false;
    const monitor=new WindowsHostMonitor(async()=>{if(broken)throw Error('monitor died');return snapshot;},()=>{failed++;});
    try{
      await monitor.start();
      if(mode==='change')snapshot='changed';if(mode==='error')broken=true;
      await monitor.poll(mode==='sleep'?Date.now()+16000:mode==='backwards'?Date.now()-16000:Date.now());
      assert.equal(failed,1);await monitor.poll();assert.equal(failed,1);
    }finally{monitor.stop();}
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
