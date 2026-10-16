import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HostNetworkMonitor } from '../server/host-network.ts';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import type { NetworkProtection } from '../shared/types.ts';

const hash = 'a'.repeat(64), other = 'b'.repeat(64);
const message = (kind: string, sequence: number, fingerprint = hash) => JSON.stringify({ kind, sequence, fingerprint }) + '\n';
const output = (value: string) => `process.stdout.write(${JSON.stringify(value)});`;
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < deadline, 'Monitor observation timed out'); await delay(10); }
}
function fixtureMonitor(code: string, timeoutMs = 500) {
  const events: string[] = [];
  const monitor = new HostNetworkMonitor(process.execPath, event => { events.push(event); }, { args: ['-e', code], timeoutMs });
  return { monitor, events };
}

test('Monitor accepts split records, suppresses stable heartbeats, detects missed changes and configuration-server resets', async () => {
  const ready = message('ready', 1);
  const f = fixtureMonitor(output(ready.slice(0, 10)) + `setTimeout(()=>{${output(ready.slice(10) + message('heartbeat', 2) + message('heartbeat', 3, other) + message('change', 4, other))}},10);setInterval(()=>{},100);`);
  try { await f.monitor.start(); await until(() => f.events.length === 3); assert.deepEqual(f.events, ['ready', 'changed', 'changed']); }
  finally { await f.monitor.close(); }
});

test('Monitor rejects malformed output, repeated baselines, sequence gaps and oversized lines', async () => {
  for (const tail of ['not-json\n', message('ready', 2), message('heartbeat', 3), 'x'.repeat(9000)]) {
    const f = fixtureMonitor(output(message('ready', 1)) + `setTimeout(()=>{${output(tail)}},10);setInterval(()=>{},100);`);
    try { await f.monitor.start(); await until(() => f.events.includes('failed')); assert.deepEqual(f.events, ['ready', 'failed']); }
    finally { await f.monitor.close(); }
  }
});

test('Missing helper, startup silence, post-baseline silence and actual child death fail closed', async () => {
  const events: string[] = [], missing = new HostNetworkMonitor('/does-not-exist/mu-monitor', e => { events.push(e); });
  try { await missing.start(); assert.deepEqual(events, ['failed']); } finally { await missing.close(); }
  for (const code of ['setInterval(()=>{},100);', output(message('ready', 1)) + 'setInterval(()=>{},100);', output(message('ready', 1)) + 'setTimeout(()=>process.exit(0),30);']) {
    const f = fixtureMonitor(code, 150);
    try { await f.monitor.start(); await until(() => f.events.includes('failed')); assert.equal(f.events.at(-1), 'failed'); }
    finally { await f.monitor.close(); }
  }
});

test('Native monitor subscribes to actual Mac state and continues emitting validated heartbeats', { skip: process.platform !== 'darwin' }, async () => {
  const events: string[] = [];
  const monitor = new HostNetworkMonitor(path.resolve(import.meta.dirname, '../native/bin/mu-network-monitor'), e => { events.push(e); });
  try {
    await monitor.start(); assert.deepEqual(events, ['ready']);
    const records: any[] = [];
    monitor.child!.stdout!.on('data', (chunk: Buffer) => { for (const line of chunk.toString().trim().split('\n')) records.push(JSON.parse(line)); });
    await delay(4200); assert.ok(!events.includes('failed')); assert.ok(monitor.child?.pid);
    assert.ok(records.length >= 2 && records.at(-1).sequence >= 3, 'Actual native heartbeats must continue');
    monitor.child!.kill('SIGKILL'); await until(() => events.includes('failed'));
  } finally { await monitor.close(); }
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixtureManager() {
  const root = await mkdtemp(path.join(homedir(), '.mu-network-unit-'));
  const runtime = new LimaRuntime(root), events: string[] = [];
  let running = true;
  runtime.info = async () => ({ available: true, path: '/test/lima', version: 'test', error: null });
  runtime.list = async () => manager.store.list().filter(e => e.kind === 'vm').map(e => ({ name: e.instanceName, status: running ? 'Running' : 'Stopped' }));
  runtime.stop = async () => { events.push('stop'); running = false; };
  runtime.start = async () => { events.push('start'); running = true; };
  runtime.networkProtection = async () => ({ active: true, issues: [] } as unknown as NetworkProtection);
  runtime.renewLease = async (_e, activate = false) => { events.push(activate ? 'activate' : 'renew'); };
  runtime.revokeLease = async () => {};
  const manager = new Manager(root, undefined, runtime);
  clearInterval(manager.protectionTimer);
  manager.enableHostNetworkMonitor();
  manager.onQuarantine = () => { events.push('revoke'); };
  const e = await manager.create({ name: 'Network change test', cpus: 1, memoryGiB: 1, network: { mode: 'http', host: 'proxy.test', strict: true, transparent: true } });
  manager.store.state(e.id, 'running');
  return { manager, runtime, e, events, async cleanup() { await manager.close(); await rm(root, { recursive: true, force: true }); } };
}

test('Changes synchronously revoke access and prevent starts during shutdown; recovery requires manual start', async () => {
  const f = await fixtureManager(), stop = deferred();
  try {
    await f.manager.handleHostNetworkEvent('ready');
    const original = f.runtime.stop.bind(f.runtime); f.runtime.stop = async e => { await stop.promise; await original(e); };
    const changing = f.manager.handleHostNetworkEvent('changed');
    assert.equal(f.manager.store.get(f.e.id).state, 'stopping');
    await assert.rejects(f.manager.assertAccess(f.e.id));
    await assert.rejects(f.manager.lifecycle(f.e.id, 'start'), { code: 'HOST_NETWORK_UNAVAILABLE' });
    stop.resolve(); await changing; assert.ok(!f.events.includes('start') && !f.events.includes('renew'));
    const job = await f.manager.lifecycle(f.e.id, 'start'); await f.manager.tasks.get(job.id)?.promise;
    assert.deepEqual(f.events.filter(e => ['stop', 'start', 'activate'].includes(e)), ['stop', 'start', 'activate']);
  } finally { stop.resolve(); await f.cleanup(); }
});

test('Unavailable monitor denies access and cannot be repaired by a late baseline', async () => {
  const f = await fixtureManager();
  try {
    await assert.rejects(f.manager.assertAccess(f.e.id), { code: 'HOST_NETWORK_UNAVAILABLE' });
    await f.manager.handleHostNetworkEvent('ready'); await f.manager.handleHostNetworkEvent('failed');
    await f.manager.handleHostNetworkEvent('ready');
    assert.equal(f.manager.hostNetwork?.state, 'failed');
    await assert.rejects(f.manager.lifecycle(f.e.id, 'start'), { code: 'HOST_NETWORK_UNAVAILABLE' });
    assert.ok(!f.events.includes('start') && !f.events.includes('activate'));
  } finally { await f.cleanup(); }
});

test('A change that finishes while an earlier startup check is pending still cancels that startup', async () => {
  const f = await fixtureManager(), entered = deferred(), release = deferred();
  try {
    await f.manager.handleHostNetworkEvent('ready');
    const stopped = await f.manager.lifecycle(f.e.id, 'stop'); await f.manager.tasks.get(stopped.id)?.promise;
    f.runtime.info = async () => { entered.resolve(); await release.promise; return { available: true, path: '/test/lima', version: 'test', error: null }; };
    const start = f.manager.lifecycle(f.e.id, 'start'), denied = assert.rejects(start, { code: 'HOST_NETWORK_UNAVAILABLE' });
    await entered.promise; await f.manager.handleHostNetworkEvent('changed'); release.resolve(); await denied;
    assert.ok(!f.events.includes('start') && !f.events.includes('activate'));
  } finally { release.resolve(); await f.cleanup(); }
});

test('A pending access check cannot renew after a change, and a newly discovered VM stops when monitoring failed', async () => {
  const f = await fixtureManager(), entered = deferred(), release = deferred();
  try {
    await f.manager.handleHostNetworkEvent('ready');
    f.runtime.networkProtection = async () => { entered.resolve(); await release.promise; return { active: true, issues: [] } as unknown as NetworkProtection; };
    const access = f.manager.assertAccess(f.e.id), denied = assert.rejects(access, { code: 'CONFIGURATION_CHANGED' });
    await entered.promise; await f.manager.handleHostNetworkEvent('changed'); release.resolve(); await denied;
    assert.ok(!f.events.includes('renew'));
    f.manager.store.state(f.e.id, 'not_created'); await f.manager.handleHostNetworkEvent('failed');
    f.runtime.list = async () => [{ name: f.e.instanceName, status: 'Running' }];
    await f.manager.reconcile(true); assert.equal(f.manager.store.get(f.e.id).state, 'error');
    assert.equal(f.events.filter(e => e === 'stop').length, 2);
  } finally { release.resolve(); await f.cleanup(); }
});
