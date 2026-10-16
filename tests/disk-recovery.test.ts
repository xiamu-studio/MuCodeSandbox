import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { buildLimaConfig, limaPortForwards } from '../server/lima-config.ts';
import { GUARD_VERSION } from '../server/network-guard.ts';
import type { Environment, NetworkProtection } from '../shared/types.ts';

// These fixtures test transaction boundaries; the real filesystem-growth test
// runs separately in a disposable VZ guest.
async function fixture() {
  const directory = await mkdtemp(path.join(homedir(), '.mu-disk-unit-'));
  const runtime = new LimaRuntime(directory);
  let status = 'Stopped', instance = '', failure = '', blockGrow = false, stopFailure = false;
  const calls: string[][] = [];
  let began!: () => void;
  const growing = new Promise<void>(resolve => { began = resolve; });
  runtime.info = async () => ({ available: true, path: '/synthetic/lima', version: 'fixture', error: null });
  runtime.list = async () => [{ name: instance, status }];
  runtime.command = async (args, options = {}) => {
    calls.push(args);
    if (args[0] === 'start') {
      status = 'Running';
      await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }));
    }
    if (args[0] === 'stop') { if (stopFailure) throw new Error('Synthetic stop failure'); status = 'Stopped'; }
    return '';
  };
  runtime.networkProtection = async () => ({ firewallActive: true, bootArmed: true, integrity: 'verified', leaseActive: false } as NetworkProtection);
  runtime.revokeLease = async () => {};
  runtime.renewLease = async () => { throw new Error('Maintenance must not activate business networking'); };
  let manager = new Manager(directory, undefined, runtime);
  const project = path.join(directory, 'project'); await mkdir(project);
  const created = await manager.create({ name: 'Disk transaction', diskGiB: 10, memoryGiB: 1,
    ports: [{ id: crypto.randomUUID(), guestPort: 3000, hostPort: 43001 }],
    network: { mode: 'http', host: 'proxy.test', strict: true, transparent: true } });
  let e = manager.store.get(created.id); instance = e.instanceName;
  // A separate directory is used because real validation forbids sharing the
  // application's private data directory.
  e.mounts = [{ id: crypto.randomUUID(), hostPath: '/synthetic/project', guestPath: '/workspace/project', writable: true }];
  e.state = 'stopped'; manager.store.save(e);
  const installed = path.join(runtime.limaHome, instance, 'lima.yaml');
  await mkdir(path.dirname(installed), { recursive: true });
  await writeFile(installed, buildLimaConfig(e));
  await mkdir(path.join(directory, 'configs')); await writeFile(path.join(directory, 'configs', `${instance}.yaml`), buildLimaConfig(e));
  await mkdir(path.join(directory, 'security'));
  await writeFile(path.join(directory, 'security', `${instance}.json`), JSON.stringify({ version: GUARD_VERSION, prepared: true, bootArmed: true,
    expectedHash: 'a'.repeat(64), expectedLeaseHash: 'b'.repeat(64), leaseBootHash: 'c'.repeat(64) }));
  const disk = path.join(runtime.limaHome, instance, 'disk');
  const handle = await open(disk, 'wx'); await handle.truncate(10 * 2 ** 30); await handle.close();
  runtime.management = async (_environment, args, options = {}) => {
    if (args[0] === 'true') return '';
    if (args[1] === 'python3') {
      const temporary = parse(await readFile(installed, 'utf8'));
      assert.deepEqual(temporary.mounts, []); assert.deepEqual(temporary.provision, []); assert.deepEqual(temporary.probes, []);
      assert.deepEqual(temporary.portForwards, limaPortForwards({ ...e, ports: [] }));
      assert.equal(temporary.disk, '12GiB');
      began();
      if (blockGrow) await new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
      if (failure === 'grow') throw new Error('Synthetic growth failure');
      const file = await open(disk, 'r+'); await file.truncate(12 * 2 ** 30); await file.close();
      return JSON.stringify({ diskBytes: 12 * 2 ** 30, device: '/dev/vda1', beforeFilesystemBytes: 9 * 2 ** 30,
        afterFilesystemBytes: 11 * 2 ** 30, availableBytes: 2 * 2 ** 30, scratchInMemory: true });
    }
    if (failure === 'reserve' && args[0] === 'bash') throw new Error('Synthetic reserve failure');
    return '';
  };
  const run = async () => {
    const job = await manager.growDisk(e.id, 12); await manager.tasks.get(job.id)!.promise;
    return manager.store.jobs().find(value => value.id === job.id)!;
  };
  return { directory, runtime, e, installed, disk, calls, growing,
    get manager() { return manager; },
    status: (value: string) => { status = value; }, failure: (value: string) => { failure = value; },
    block: () => { blockGrow = true; }, stopFailure: (value: boolean) => { stopFailure = value; }, run,
    reopen: async () => { await manager.close(); manager = new Manager(directory, undefined, runtime); },
    close: async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('Disk growth strips host exports during maintenance and commits capacity only after verified stop', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run()).status, 'succeeded');
    const e = f.manager.store.get(f.e.id); assert.equal(e.diskGiB, 12); assert.equal(e.state, 'stopped');
    assert.deepEqual(await f.manager.diskRecovery.status(e), { pending: false, targetGiB: null });
    const configuration = parse(await readFile(f.installed, 'utf8'));
    assert.equal(configuration.disk, '12GiB'); assert.deepEqual(configuration.mounts, parse(buildLimaConfig(f.e)).mounts);
    assert.ok(f.calls.some(args => args[0] === 'stop'));
  } finally { await f.close(); }
});

test('Interrupted growth preserves a signed journal, blocks normal operations and retries after reopen', async () => {
  const f = await fixture();
  try {
    f.failure('reserve'); assert.equal((await f.run()).status, 'failed');
    assert.equal(f.manager.store.get(f.e.id).diskGiB, 10);
    assert.deepEqual(await f.manager.diskRecovery.status(f.e), { pending: true, targetGiB: 12 });
    await assert.rejects(f.manager.lifecycle(f.e.id, 'start'), /磁盘维护尚未完成/);
    await assert.rejects(f.runtime.start(f.e, {}), /磁盘维护尚未完成/);
    await assert.rejects(f.runtime.updateConfig(f.e), /磁盘维护尚未完成/);
    await assert.rejects(f.manager.snapshots.create(f.e, 'Blocked'), /磁盘维护尚未完成/);
    await f.reopen(); f.status('Running'); await f.manager.reconcile(true);
    assert.equal(f.manager.store.get(f.e.id).state, 'error');
    assert.equal((await f.runtime.list())[0].status, 'Stopped');
    f.failure(''); assert.equal((await f.run()).status, 'succeeded');
    assert.equal(f.manager.store.get(f.e.id).diskGiB, 12);
  } finally { await f.close(); }
});

test('Cancelled disk growth stops maintenance and retains a retryable journal without committing capacity', async () => {
  const f = await fixture();
  try {
    f.block(); const job = await f.manager.growDisk(f.e.id, 12); await f.growing;
    await assert.rejects(f.manager.growDisk(f.e.id, 13), /其他操作/);
    await f.manager.monitorProtection(); assert.equal((await f.runtime.list())[0].status, 'Running');
    f.manager.cancel(job.id); await f.manager.tasks.get(job.id)!.promise;
    assert.equal(f.manager.store.jobs().find(value => value.id === job.id)!.status, 'cancelled');
    assert.equal(f.manager.store.get(f.e.id).diskGiB, 10); assert.equal((await f.runtime.list())[0].status, 'Stopped');
    assert.equal((await f.manager.diskRecovery.status(f.e)).pending, true);
  } finally { await f.close(); }
});

test('Disk maintenance monitor stops a late startup without UI polling', async () => {
  const f = await fixture();
  try {
    f.failure('grow'); assert.equal((await f.run()).status, 'failed');
    await f.reopen(); await f.manager.reconcile(true);
    assert.equal((await f.runtime.list())[0].status, 'Stopped');
    const stops = f.calls.filter(args => args[0] === 'stop').length;
    f.status('Running');
    await f.manager.monitorProtection();
    assert.equal((await f.runtime.list())[0].status, 'Stopped');
    assert.equal(f.manager.store.get(f.e.id).state, 'error');
    assert.equal(f.calls.filter(args => args[0] === 'stop').length, stops + 1);
    assert.equal((await f.manager.diskRecovery.status(f.e)).pending, true);
  } finally { await f.close(); }
});

test('Unverified shutdown keeps host shares absent and does not clear the recovery journal', async () => {
  const f = await fixture();
  try {
    f.stopFailure(true); assert.equal((await f.run()).status, 'failed');
    assert.deepEqual(parse(await readFile(f.installed, 'utf8')).mounts, []);
    assert.equal(f.manager.store.get(f.e.id).diskGiB, 10);
    assert.equal((await f.manager.diskRecovery.status(f.e)).pending, true);
    f.stopFailure(false); await f.manager.reconcile(true);
    assert.equal((await f.run()).status, 'succeeded');
  } finally { f.stopFailure(false); await f.close(); }
});

test('A journal alteration, wrong target and disk shrink cannot become a successful recovery', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.manager.growDisk(f.e.id, 9));
    await assert.rejects(f.manager.growDisk(f.e.id, 257));
    f.failure('grow'); assert.equal((await f.run()).status, 'failed');
    await assert.rejects(f.manager.diskRecovery.grow(f.e, 13), /上次请求/);
    const file = path.join(f.directory, 'disk-recovery', f.e.id, 'journal.json');
    const value = JSON.parse(await readFile(file, 'utf8')); value.body = value.body.replace('"targetGiB":12', '"targetGiB":13');
    await writeFile(file, JSON.stringify(value));
    await assert.rejects(f.manager.diskRecovery.status(f.e), /校验失败/);
    await assert.rejects(f.manager.lifecycle(f.e.id, 'start'), /磁盘维护尚未完成/);
  } finally { await f.close(); }
});

test('A crash after the capacity database write remains retryable at the same requested size', async () => {
  const f = await fixture();
  try {
    await f.manager.diskRecovery.grow(f.e, 12);
    const save = f.manager.store.save.bind(f.manager.store);
    f.manager.store.save = value => { save(value); throw new Error('Synthetic crash after database commit'); };
    await assert.rejects(f.manager.diskRecovery.commit(f.e, 12), /after database commit/);
    assert.equal(f.manager.store.get(f.e.id).diskGiB, 12);
    assert.equal((await f.manager.diskRecovery.status(f.manager.store.get(f.e.id))).pending, true);
    f.manager.store.save = save;
    await f.reopen(); await f.manager.reconcile(true);
    assert.equal((await f.run()).status, 'succeeded');
    assert.deepEqual(await f.manager.diskRecovery.status(f.manager.store.get(f.e.id)), { pending: false, targetGiB: null });
  } finally { await f.close(); }
});

test('Host network changes cancel maintenance, stop the guest and preserve the retry journal', async () => {
  const f = await fixture();
  try {
    f.manager.enableHostNetworkMonitor(); await f.manager.handleHostNetworkEvent('ready');
    f.block(); const job = await f.manager.growDisk(f.e.id, 12), pending = f.manager.tasks.get(job.id)!.promise;
    await f.growing; await f.manager.handleHostNetworkEvent('changed'); await pending;
    assert.equal(f.manager.store.jobs().find(value => value.id === job.id)!.status, 'cancelled');
    assert.equal((await f.runtime.list())[0].status, 'Stopped'); assert.equal(f.manager.store.get(f.e.id).diskGiB, 10);
    assert.equal((await f.manager.diskRecovery.status(f.e)).pending, true);
  } finally { await f.close(); }
});
