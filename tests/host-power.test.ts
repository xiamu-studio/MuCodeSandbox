import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import type { NetworkProtection } from '../shared/types.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const root = await mkdtemp(path.join(homedir(), '.mu-power-unit-'));
  const runtime = new LimaRuntime(root), events: string[] = [];
  let actualRunning = true;
  runtime.info = async () => ({ available: true, path: '/test/lima', version: 'test', error: null });
  runtime.list = async () => manager.store.list().filter(e => e.kind === 'vm').map(e => ({ name: e.instanceName, status: actualRunning ? 'Running' : 'Stopped' }));
  runtime.stop = async () => { events.push('stop'); actualRunning = false; };
  runtime.start = async () => { events.push('start'); actualRunning = true; };
  runtime.networkProtection = async () => ({ active: true, integrity: 'verified', issues: [] } as unknown as NetworkProtection);
  runtime.renewLease = async (_e, activate = false) => { events.push(activate ? 'activate' : 'renew'); };
  runtime.revokeLease = async () => {};
  const manager = new Manager(root, undefined, runtime);
  // Power tests use a synthetic runtime, not native Mac snapshot durability.
  manager.snapshots.recover = async () => {};
  clearInterval(manager.protectionTimer);
  manager.onQuarantine = () => { events.push('revoke-access'); };
  const e = await manager.create({ name: 'Power test', cpus: 1, memoryGiB: 1, network: { mode: 'http', host: 'proxy.test', strict: true, transparent: true } });
  manager.store.state(e.id, 'running');
  return { manager, runtime, e, events, async cleanup() { await manager.close(); await rm(root, { recursive: true, force: true }); } };
}

test('Suspend closes access immediately and blocks protected starts until resume, without automatically restarting', async () => {
  const f = await fixture(), stopped = deferred();
  f.runtime.stop = async () => { f.events.push('stop'); await stopped.promise; };
  try {
    const pending = f.manager.handleHostPowerEvent('suspend');
    assert.equal(f.manager.store.get(f.e.id).state, 'stopping');
    await assert.rejects(f.manager.assertAccess(f.e.id));
    await assert.rejects(f.manager.lifecycle(f.e.id, 'start'), { code: 'HOST_POWER_TRANSITION' });
    const monitor = f.manager.monitorProtection(); assert.ok(!f.events.includes('renew'));
    stopped.resolve(); await Promise.all([pending, monitor]);
    await assert.rejects(f.manager.lifecycle(f.e.id, 'start'), { code: 'HOST_POWER_TRANSITION' });
    await f.manager.handleHostPowerEvent('resume');
    assert.ok(!f.events.includes('start')); assert.equal(f.manager.store.get(f.e.id).state, 'error');
    assert.equal(f.events.filter(event => event === 'stop').length, 1);
  } finally { stopped.resolve(); await f.cleanup(); }
});

test('Resume without suspend notification stops protected guests but leaves direct and native environments unchanged', async () => {
  const f = await fixture();
  try {
    const direct = await f.manager.create({ name: 'Direct' }), native = await f.manager.create({ name: 'Native', kind: 'browser' });
    f.manager.store.state(direct.id, 'running'); f.manager.store.state(native.id, 'running');
    await f.manager.handleHostPowerEvent('resume');
    assert.equal(f.manager.store.get(f.e.id).state, 'error');
    assert.equal(f.manager.store.get(direct.id).state, 'running'); assert.equal(f.manager.store.get(native.id).state, 'running');
    assert.ok(!f.events.includes('start')); assert.equal(f.events.filter(event => event === 'stop').length, 1);
  } finally { await f.cleanup(); }
});

test('Overlapping suspend and resume keep the start barrier until the original shutdown completes', async () => {
  const f = await fixture(), stopped = deferred();
  const originalStop = f.runtime.stop.bind(f.runtime);
  f.runtime.stop = async e => { await stopped.promise; await originalStop(e); };
  try {
    const suspend = f.manager.handleHostPowerEvent('suspend'), resume = f.manager.handleHostPowerEvent('resume');
    await assert.rejects(f.manager.lifecycle(f.e.id, 'start'), { code: 'HOST_POWER_TRANSITION' });
    stopped.resolve(); await Promise.all([suspend, resume]);
    assert.equal(f.events.filter(event => event === 'stop').length, 1);
    const job = await f.manager.lifecycle(f.e.id, 'start'); await f.manager.tasks.get(job.id)?.promise;
    assert.equal(f.manager.store.jobs().find(item => item.id === job.id)?.status, 'succeeded');
    assert.deepEqual(f.events.filter(event => ['stop', 'start', 'activate'].includes(event)), ['stop', 'start', 'activate']);
  } finally { stopped.resolve(); await f.cleanup(); }
});

test('A pending access check cannot renew the old lease after a host power event', async () => {
  const f = await fixture(), checking = deferred(), finishCheck = deferred();
  f.runtime.networkProtection = async () => { checking.resolve(); await finishCheck.promise; return { active: true, issues: [] } as unknown as NetworkProtection; };
  try {
    const access = f.manager.assertAccess(f.e.id);
    const denied = assert.rejects(access, { code: 'CONFIGURATION_CHANGED' });
    await checking.promise; await f.manager.handleHostPowerEvent('resume'); finishCheck.resolve(); await denied;
    assert.ok(!f.events.includes('renew')); assert.equal(f.manager.store.get(f.e.id).state, 'error');
  } finally { finishCheck.resolve(); await f.cleanup(); }
});

test('Shutdown failure remains visible and never automatically activates or restarts a guest', async () => {
  const f = await fixture();
  f.runtime.stop = async () => { throw new Error('Power stop failed'); };
  try {
    await f.manager.handleHostPowerEvent('resume');
    assert.equal(f.manager.store.get(f.e.id).state, 'error');
    assert.match(f.manager.store.get(f.e.id).lastError ?? '', /Power stop failed/);
    assert.ok(!f.events.includes('activate') && !f.events.includes('start'));
    await assert.rejects(f.manager.assertAccess(f.e.id));
  } finally { await f.cleanup(); }
});

for (const trigger of ['suspend', 'changed', 'failed'] as const) {
  for (const stopFails of [false, true]) {
    test(`${trigger}: incident and logs do not claim shutdown before its ${stopFails ? 'failure' : 'confirmation'}`, async () => {
      const f = await fixture(), stopped = deferred();
      f.runtime.stop = async () => { await stopped.promise; if (stopFails) throw new Error('Synthetic unconfirmed stop'); };
      try {
        f.manager.enableHostNetworkMonitor();
        await f.manager.handleHostNetworkEvent('ready');
        const pending = trigger === 'suspend' ? f.manager.handleHostPowerEvent(trigger) : f.manager.handleHostNetworkEvent(trigger);
        const before = f.manager.protectionEvents(f.e.id)[0];
        assert.equal(before.kind, 'host');
        assert.equal(before.stopResult, 'requested');
        assert.doesNotMatch(before.issue, /已关闭|已停止/);
        const logs = f.manager.store.logs(f.e.id);
        assert.ok(logs.some(log => log.message.includes(before.issue)));
        assert.ok(logs.every(log => !/已关闭|已停止/.test(log.message)));
        assert.equal(f.manager.store.get(f.e.id).state, 'stopping');
        await assert.rejects(f.manager.assertAccess(f.e.id));
        stopped.resolve(); await pending;
        const after = f.manager.protectionEvents(f.e.id)[0];
        assert.equal(after.id, before.id);
        assert.equal(after.stopResult, stopFails ? 'failed' : 'confirmed');
        assert.doesNotMatch(after.issue, /已关闭|已停止/);
        if (stopFails) assert.match(after.stopIssue ?? '', /Synthetic unconfirmed stop/);
        assert.ok(!f.events.includes('start') && !f.events.includes('activate'));
      } finally { stopped.resolve(); await f.cleanup(); }
    });
  }
}

for (const write of ['state', 'log', 'newJob', 'finishJob'] as const) {
  test(`Protection still revokes and stops when ${write} storage fails`, async t => {
    const f = await fixture();
    try {
      f.manager.enableHostNetworkMonitor(); await f.manager.handleHostNetworkEvent('ready');
      t.mock.method(f.manager.store, write, () => { throw new Error('Synthetic disk write failure'); });
      await f.manager.handleHostNetworkEvent('changed');
      assert.ok(f.events.includes('revoke-access'));
      assert.equal(f.events.filter(value => value === 'stop').length, 1);
      assert.equal(f.manager.protectionEvents(f.e.id)[0].stopResult, 'confirmed');
      assert.equal(f.manager.quarantines.size, 0);
      t.mock.restoreAll();
      await assert.rejects(f.manager.assertAccess(f.e.id), {code: 'QUARANTINED'});
      assert.ok(!f.events.includes('renew') && !f.events.includes('activate'));
    } finally { t.mock.restoreAll(); await f.cleanup(); }
  });
}

test('A failed stop and failed state writes remain denied until an explicit verified restart', async t => {
  const f = await fixture();
  try {
    t.mock.method(f.manager.store, 'state', () => { throw new Error('Synthetic disk full'); });
    t.mock.method(f.runtime, 'stop', async () => { f.events.push('stop-failed'); throw new Error('Synthetic stop failure'); });
    await f.manager.handleHostPowerEvent('resume');
    assert.equal(f.manager.protectionEvents(f.e.id)[0].stopResult, 'failed');
    assert.equal(f.manager.store.get(f.e.id).state, 'running');
    t.mock.restoreAll();
    await assert.rejects(f.manager.assertAccess(f.e.id), {code: 'QUARANTINED'});
    assert.ok(!f.events.includes('renew'));
    // No native Mac snapshot operations are exercised by this host lifecycle test.
    t.mock.method(f.manager.snapshots, 'recover', async () => {});
    const protection = t.mock.method(f.runtime, 'networkProtection', async () => ({active: false, integrity: 'failed', issues: ['Synthetic bad protection']} as unknown as NetworkProtection));
    const rejected = await f.manager.lifecycle(f.e.id, 'restart');
    await f.manager.tasks.get(rejected.id)?.promise;
    assert.equal(f.manager.store.jobs().find(row => row.id === rejected.id)?.status, 'failed');
    await assert.rejects(f.manager.assertAccess(f.e.id), {code: 'QUARANTINED'});
    assert.ok(!f.events.includes('activate'));
    protection.mock.restore();
    const job = await f.manager.lifecycle(f.e.id, 'restart');
    await f.manager.tasks.get(job.id)?.promise;
    assert.equal(f.manager.store.jobs().find(row => row.id === job.id)?.status, 'succeeded');
    await f.manager.assertAccess(f.e.id);
    assert.ok(f.events.includes('activate') && f.events.includes('renew'));
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

test('Combined failed writes and connection revocation cannot suppress the runtime stop', async t => {
  const f = await fixture();
  try {
    for (const write of ['state', 'log', 'newJob', 'addProtectionEvent'] as const)
      t.mock.method(f.manager.store, write, () => { throw new Error('Synthetic full disk'); });
    f.manager.onQuarantine = () => { f.events.push('revoke-failed'); throw new Error('Synthetic viewer revoke failure'); };
    await f.manager.handleHostPowerEvent('resume');
    assert.equal(f.events.filter(value => value === 'stop').length, 1);
    assert.equal(f.events.filter(value => value === 'revoke-failed').length, 2);
    const incident = f.manager.protectionEvents(f.e.id)[0];
    assert.equal(incident.persisted, false);
    assert.equal(incident.stopResult, 'confirmed');
    t.mock.restoreAll();
    await assert.rejects(f.manager.assertAccess(f.e.id), {code: 'QUARANTINED'});
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

test('A suspend arriving during asynchronous startup checks prevents VM launch', async () => {
  const f = await fixture(), checking = deferred(), finishCheck = deferred();
  try {
    const stopped = await f.manager.lifecycle(f.e.id, 'stop'); await f.manager.tasks.get(stopped.id)?.promise;
    f.runtime.info = async () => { checking.resolve(); await finishCheck.promise; return { available: true, path: '/test/lima', version: 'test', error: null }; };
    const started = f.manager.lifecycle(f.e.id, 'start');
    const denied = assert.rejects(started, { code: 'HOST_POWER_TRANSITION' });
    await checking.promise; await f.manager.handleHostPowerEvent('suspend'); finishCheck.resolve(); await denied;
    assert.ok(!f.events.includes('start') && !f.events.includes('activate'));
    assert.ok(f.manager.store.jobs().every(job => job.action !== 'start'));
  } finally { finishCheck.resolve(); await f.cleanup(); }
});
