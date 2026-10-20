import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { windowsConfigSchema, vmIdentity, NET_UID, PROBE_UID } from '../server/platform/windows/config.ts';
import { cloudInit, configureWindowsGuard } from '../server/platform/windows/guest.ts';
import { WindowsNetworkSession, type GuardDriver } from '../server/platform/windows/session.ts';
import { HyperVRuntime, powershellArgs, powershellPath } from '../server/platform/windows/runtime.ts';
import { run } from '../server/process.ts';
import { WindowsHostMonitor } from '../server/platform/windows/monitor.ts';

const id='12345678-1234-4234-8234-123456789012';
const config=()=>windowsConfigSchema.parse({version:1,id,image:path.resolve('fixture.vhd'),imageSha256:'a'.repeat(64),proxy:{mode:'http',address:'127.0.0.1',port:12345},expectedIp:'203.0.113.10'});
test('Windows config refuses direct fallback, unknown fields, hostnames and shell input',()=>{
  for(const value of [{...config(),proxy:{mode:'direct',address:'127.0.0.1',port:80}},
    {...config(),proxy:{mode:'http',address:'example.test',port:80}}, {...config(),sharedHome:true},
    {...config(),timezone:'UTC; command'}, {...config(),id:'../../other-vm'}])assert.throws(()=>windowsConfigSchema.parse(value));
  assert.notDeepEqual(vmIdentity(id),vmIdentity('22345678-1234-4234-8234-123456789012'));
});
test('NoCloud seed contains no default gateway, package downloads, host mounts or dev sudo',()=>{
  const c=config(),key='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestFixture';
  const seed=cloudInit(c,key,'fixture-private-not-a-real-key',key);
  const user=parse(seed['user-data']),network=parse(seed['network-config']);
  assert.equal(user.users.find((u:{name:string})=>u.name==='dev').sudo,false);
  assert.equal(user.users.find((u:{name:string})=>u.name==='mu-net').uid,NET_UID);
  assert.equal(user.users.find((u:{name:string})=>u.name==='mu-probe').uid,PROBE_UID);
  assert.equal(network.ethernets.management.dhcp4,false);
  assert.equal(network.ethernets.management.dhcp6,false);
  assert.equal(network.ethernets.management['accept-ra'],false);
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
  await assert.rejects(f.session.fail());assert.ok(f.calls.includes('disconnect'));assert.ok(f.calls.includes('stop'));
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
test('Windows IMAPI creates a readable NoCloud ISO with exact filenames',{skip:process.platform!=='win32'},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'mu-iso-'));
  try {
    const source=path.join(root,'seed');await mkdir(source);
    for(const name of ['user-data','meta-data','network-config'])await writeFile(path.join(source,name),'fixture\n');
    const target=path.join(root,'seed.iso');
    const script=path.resolve('scripts/windows/seed-iso.ps1').replaceAll("'","''");
    await run(powershellPath(),powershellArgs(`& '${script}' -Source '${source.replaceAll("'","''")}' -Destination '${target.replaceAll("'","''")}'`));
    const bytes=await readFile(target);assert.equal(bytes.subarray(16*2048+1,16*2048+6).toString(),'CD001');
    const names=await run('tar.exe',['-tf',target]);for(const name of ['user-data','meta-data','network-config'])assert.ok(names.includes(name));
  } finally {await rm(root,{recursive:true,force:true});}
});
