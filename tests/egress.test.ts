import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { EGRESS_URL, EGRESS_RECEIVERS, measureEgress, parseEgress, EgressMismatchError } from '../server/egress.ts';
import { environmentSchema } from '../server/validation.ts';
import { editConfig } from '../src/api.ts';
import { firewallRules } from '../server/network-guard.ts';
import { transparentConfig } from '../server/transparent-network.ts';
import type { Environment, NetworkProtection, NetworkResult } from '../shared/types.ts';

const network = { mode: 'http', host: 'proxy.test', strict: true, transparent: true, egressLock: { expectedIp: '8.8.8.8' } };
const result = (ip = '8.8.8.8'): NetworkResult => ({ ip, country: 'Synthetic', city: 'Fixture', latencyMs: 1, source: 'guest' });

async function fixture() {
  const directory = await mkdtemp(path.join(homedir(), '.mu-egress-unit-'));
  const runtime = new LimaRuntime(directory);
  let running = false, instance = '', stops = 0;
  runtime.info = async () => ({ available: true, path: '/test/lima', version: 'test', error: null });
  runtime.list = async () => instance ? [{ name: instance, status: running ? 'Running' : 'Stopped' } as any] : [];
  runtime.start = async e => { running = true; instance = e.instanceName; };
  runtime.stop = async () => { running = false; stops++; };
  runtime.updateConfig = async () => {};
  runtime.networkProtection = async () => ({ active: true } as NetworkProtection);
  runtime.renewLease = async () => {};
  runtime.revokeLease = async () => {};
  const manager = new Manager(directory,undefined,runtime);
  const e = await manager.create({ name: 'Synthetic exit approval', memoryGiB: 1, network });
  instance = e.instanceName;
  manager.measureExit = async () => result();
  const start = async () => {
    const job = await manager.lifecycle(e.id,'start'); await manager.tasks.get(job.id)?.promise;
    return manager.store.jobs().find(item => item.id === job.id)!;
  };
  const clean = async () => { await manager.close(); await rm(directory,{ recursive: true, force: true }); };
  return { manager, runtime, e, start, clean, stops: () => stops };
}

test('Exit approval requires a strict transparent VM and survives configuration editing', async () => {
  for (const input of [
    { ...network, strict: false }, { ...network, transparent: false },
    { ...network, egressLock: { expectedIp: '8.8.8.8/32' } },
    { ...network, egressLock: { expectedIp: 'not-an-ip' } },
    { ...network, egressLock: { expectedIp: '::1' } },
    { ...network, egressLock: { expectedIp: '8.8.8.8', autoApprove: true } },
  ]) assert.equal(environmentSchema.safeParse({ name: 'Invalid approval', network: input }).success,false);
  assert.equal(environmentSchema.safeParse({ name: 'Invalid host scope', kind: 'browser', network }).success,false);
  const f = await fixture();
  try { assert.deepEqual(editConfig(f.manager.store.get(f.e.id)).network.egressLock,{ expectedIp: '8.8.8.8' }); }
  finally { await f.clean(); }
});

test('Exit measurement is bounded, TLS verified, IPv4 and independent of user curl settings', async () => {
  let command: string[] = [], options: any;
  const runtime = { egressProbeProxy: () => '', management: async (_e: Environment, args: string[], opts: unknown) => { if(args.at(-1)===EGRESS_URL){command=args;options=opts;}return args.at(-1)===EGRESS_RECEIVERS[2].url?'8.8.8.8\n':JSON.stringify(result()); } } as unknown as LimaRuntime;
  const receipt = await measureEgress(runtime,{network:{}} as Environment);
  assert.equal(receipt.ip,'8.8.8.8');
  assert.deepEqual(command.slice(0,11),['/usr/bin/sudo','-H','-u','mu-probe','--','env','-i','PATH=/usr/bin:/bin','/usr/bin/curl','-q','--ipv4']);
  assert.equal(command.at(-1),EGRESS_URL);
  assert.ok(command.includes('--cacert')); assert.ok(!command.includes('--insecure'));
  assert.equal(command[command.indexOf('--proxy')+1],'');
  assert.equal(options.timeoutMs,24_000,'Lima command setup has its own bounded budget');
  assert.equal(command[command.indexOf('--max-time')+1],'12','The HTTPS receiver has its own deadline below the kernel lease');
  assert.equal(command[command.indexOf('--connect-timeout')+1],'4');
  for (const value of ['', 'null', '[]', '{"ip":"::1"}', '{"ip":"abc"}', '{"ip":"8.8.8.8","success":false}', 'x'.repeat(65_537)]) assert.throws(() => parseEgress(value));
});

test('Startup rejects a changed or unmeasurable exit and stops instead of opening access', async () => {
  const f = await fixture();
  try {
    f.manager.measureExit = async () => result('9.9.9.9');
    assert.equal((await f.start()).status,'failed');
    assert.equal(f.manager.store.get(f.e.id).state,'error'); assert.equal(f.stops(),1);
    assert.equal(f.manager.egressStatus(f.e.id).status,'changed');
    assert.equal(f.manager.store.get(f.e.id).network.egressLock!.expectedIp,'8.8.8.8');
    f.manager.measureExit = async () => { throw new Error('Measurement service offline'); };
    assert.equal((await f.start()).status,'failed'); assert.equal(f.stops(),2);
    assert.equal(f.manager.egressStatus(f.e.id).status,'unavailable');
    f.manager.measureExit = async () => result();
    assert.equal((await f.start()).status,'succeeded');
    assert.equal(f.manager.egressStatus(f.e.id).status,'verified');
  } finally { await f.clean(); }
});

test('Exit probe delegates DNS to the controlled SOCKS listener without curl DoH direct dialing', async () => {
  let command: string[] = [];
  const runtime = { egressProbeProxy: () => 'socks5h://127.0.0.1:42125',
    management: async (_e: Environment, args: string[]) => { if(args.at(-1)===EGRESS_URL)command = args; return args.at(-1)===EGRESS_RECEIVERS[2].url?'8.8.8.8\n':JSON.stringify(result()); } } as unknown as LimaRuntime;
  assert.equal((await measureEgress(runtime, { network: {} } as Environment)).ip, '8.8.8.8');
  assert.equal(command[command.indexOf('--proxy') + 1], 'socks5h://127.0.0.1:42125');
  assert.equal(command[command.indexOf('--noproxy') + 1], '');
  assert.ok(!command.includes('--doh-url') && !command.includes('--resolve') && command.includes('--cacert') && !command.includes('--insecure'));
  assert.equal(command.at(-1), EGRESS_URL);
});

test('Exit probe listener has its own identity restriction and shares only the configured upstream', () => {
  const e = { ...environmentSchema.parse({ name: 'Probe boundary', network: { ...network, port: 42123 } }) } as Environment;
  const rules = firewallRules(['127.0.0.1'], 42123, [], '192.168.5.2', 999, 998, undefined, 42123, { port: 42125, uid: 996 });
  for (const [port, uid] of [[42123, 999], [42125, 996]]) {
    const deny = `oifname "lo" ip daddr 127.0.0.1 tcp dport ${port} meta skuid != ${uid} counter name blocked drop`;
    assert.ok(rules.includes(deny) && rules.indexOf(deny) < rules.indexOf('oifname "lo" accept'));
  }
  for (const probe of [{ port: 42123, uid: 996 }, { port: 42125, uid: 999 }, { port: 0, uid: 996 }, { port: 42125, uid: 0 }])
    assert.throws(() => firewallRules(['127.0.0.1'], 42123, [], '192.168.5.2', 999, 998, undefined, 42123, probe));
  const config = transparentConfig(e, '127.0.0.1', 999, [], 42125);
  assert.deepEqual(config.inbounds[1], { type: 'socks', tag: 'exit-probe', listen: '127.0.0.1', listen_port: 42125 });
  assert.equal(config.outbounds.length, 1); assert.equal(config.outbounds[0].tag, config.route.final);
  assert.equal(config.outbounds[0].server_port, 42123);
  assert.deepEqual(config.route.rules[0], { inbound: ['exit-probe'], network: 'udp', action: 'reject' });
  assert.deepEqual(config.route.rules[1], { inbound: ['exit-probe'], action: 'resolve', server: 'remote-dns', strategy: 'ipv4_only' });
  assert.equal(config.dns.servers[0].detour,'upstream');
  assert.throws(() => transparentConfig({ ...e, network: { ...e.network, egressLock: undefined } }, '127.0.0.1', 999, [], 42125));
});

test('Drift aborts a busy install, revokes again after it settles and stops the VM', async () => {
  const f = await fixture();
  try {
    await f.start(); let revoked = 0, lateGrant = false;
    f.manager.onQuarantine = () => { revoked++; lateGrant = false; };
    let started!: () => void;
    const began = new Promise<void>(resolve => { started=resolve; });
    const job = f.manager.submit(f.e.id,'install-agent',async options => {
      started(); await new Promise<void>(resolve => options.signal!.addEventListener('abort',()=>resolve(),{once:true}));
      lateGrant = true;
    });
    await began;
    f.manager.measureExit = async () => result('9.9.9.9');
    await f.manager.monitorProtection();
    assert.equal(f.stops(),1); assert.equal(f.manager.store.get(f.e.id).state,'error');
    assert.equal(f.manager.store.jobs().find(item=>item.id===job.id)?.status,'cancelled');
    assert.equal(revoked,2); assert.equal(lateGrant,false);
    await assert.rejects(f.manager.assertAccess(f.e.id));
    assert.equal(f.manager.store.get(f.e.id).network.egressLock!.expectedIp,'8.8.8.8');
  } finally { await f.clean(); }
});

test('A stale exit response cannot approve or quarantine a restarted environment', async () => {
  const f = await fixture();
  try {
    await f.start();
    let resolve!: (value: NetworkResult) => void;
    f.manager.measureExit = () => new Promise(done => { resolve=done; });
    const old = f.manager.assertAccess(f.e.id).then(()=>null,error=>error);
    await new Promise(done=>setImmediate(done));
    const stop = await f.manager.lifecycle(f.e.id,'stop'); await f.manager.tasks.get(stop.id)?.promise;
    f.manager.measureExit = async () => result();
    assert.equal((await f.start()).status,'succeeded');
    resolve(result('9.9.9.9'));
    assert.equal((await old).code,'CONFIGURATION_CHANGED');
    assert.equal(f.manager.store.get(f.e.id).state,'running');
    assert.equal(f.manager.egressStatus(f.e.id).actualIp,'8.8.8.8'); assert.equal(f.stops(),1);
  } finally { await f.clean(); }
});

test('A failed access check quarantines without deadlocking its own browser job', async () => {
  const f = await fixture();
  try {
    await f.start(); f.manager.measureExit=async()=>result('9.9.9.9');
    const job = f.manager.submit(f.e.id,'open-browser',()=>f.manager.assertAccess(f.e.id,true).then(()=>{}));
    await f.manager.tasks.get(job.id)?.promise;
    await Promise.all([...f.manager.quarantines.values()]);
    assert.equal(f.stops(),1); assert.equal(f.manager.store.get(f.e.id).state,'error');
  } finally { await f.clean(); }
});

test('A disagreement detected by multiple receivers remains a changed exit, never an approval',async()=>{
  const f=await fixture();
  try{
    f.manager.measureExit=async()=>{throw new EgressMismatchError('9.9.9.9');};
    assert.equal((await f.start()).status,'failed');
    assert.equal(f.manager.egressStatus(f.e.id).status,'changed');
    assert.equal(f.manager.egressStatus(f.e.id).actualIp,'9.9.9.9');
    assert.equal(f.manager.store.get(f.e.id).state,'error');assert.equal(f.stops(),1);
  }finally{await f.clean();}
});

test('A timed-out IPwho receiver is never recorded as a successful IPwho observation using another receiver result',async()=>{
  const f=await fixture();
  try{
    await f.start();const recorded:{receiver:string;latency:number}[]=[];
    f.manager.measureExit=async()=>({...result(),verification:{requiredReceivers:2,receipts:[{receiver:'ipify',ip:'8.8.8.8',latencyMs:3},{receiver:'icanhazip',ip:'8.8.8.8',latencyMs:4}],timedOutReceivers:['ipwho']}});
    f.manager.networkObserver.record=(_e,receiver,value)=>{recorded.push({receiver,latency:value!.latencyMs});};
    await f.manager.testNetwork(f.e.id);
    assert.deepEqual(recorded,[{receiver:'ipify',latency:3}]);
  }finally{await f.clean();}
});

test('Reconciliation cannot advertise an environment as running during quarantine', async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    await f.start();
    f.runtime.stop=async()=>new Promise<void>(resolve=>{release=resolve;});
    f.manager.measureExit=async()=>result('9.9.9.9');
    await assert.rejects(f.manager.assertAccess(f.e.id));
    await new Promise(done=>setImmediate(done));
    await f.manager.reconcile(true);
    assert.equal(f.manager.store.get(f.e.id).state,'stopping');
    assert.throws(()=>f.manager.ensureIdle(f.e.id),/隔离停机/);
    release();await Promise.all([...f.manager.quarantines.values()]);
    assert.equal(f.manager.store.get(f.e.id).state,'error');
  } finally { release?.();await f.clean(); }
});
