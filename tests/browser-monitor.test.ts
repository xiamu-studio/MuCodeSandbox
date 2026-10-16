import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { GuestBrowserHost } from '../server/guest-browser.ts';
import { CURRENT_BROWSER_RELEASE } from '../server/browser-releases.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { Manager } from '../server/manager.ts';
import type { BrowserHost } from '../server/browser.ts';
import type { NetworkProtection } from '../shared/types.ts';

const fallback: BrowserHost = { native: false, available: async () => false, running: () => false,
  open: async () => {}, close: async () => {}, clear: async () => {}, dispose: async () => {} };
const healthy = () => ({ unitActive: true, developmentUid: 1000, processes: ['renderer', 'gpu-process'].map((role, index) => ({
  pid: 101 + index, role, uid: 1000, seccomp: 2, noNewPrivileges: 1, effectiveCapabilities: '0000000000000000',
  separatePidNamespace: role === 'renderer', noSandboxFlag: false,
  threads: [{ tid: 101 + index, seccomp: 2, noNewPrivileges: 1, effectiveCapabilities: '0000000000000000' }],
})) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }

test('Running-browser checks share one inspection and skip missing or preparing sessions', async () => {
  const runtime = new LimaRuntime('/unused'), host = new GuestBrowserHost(runtime, fallback), gate = deferred<string>();
  let calls = 0;
  runtime.management = async () => { calls++; return gate.promise; };
  const entry = { environment: { id: 'fixture' }, release:CURRENT_BROWSER_RELEASE, ready: false, browserReady: true };
  host.entries.set('fixture', entry as any);
  try {
    await host.assertProtection('missing'); await host.assertProtection('fixture'); assert.equal(calls, 0);
    entry.ready = true;
    const one = host.assertProtection('fixture'), two = host.assertProtection('fixture');
    assert.equal(calls, 1); gate.resolve(JSON.stringify(healthy())); await Promise.all([one, two]);
    await host.assertProtection('fixture'); assert.equal(calls, 2);
  } finally { gate.resolve(JSON.stringify(healthy())); host.entries.clear(); await host.dispose(); }
});

test('A failed inspection of a closed or replaced session does not affect the replacement', async () => {
  const runtime = new LimaRuntime('/unused'), host = new GuestBrowserHost(runtime, fallback), gate = deferred<string>();
  runtime.management = async () => gate.promise;
  const old = { environment: { id: 'fixture' }, release:CURRENT_BROWSER_RELEASE, ready: true, browserReady: true }, replacement = { environment: { id: 'fixture' }, release:CURRENT_BROWSER_RELEASE, ready: true, browserReady: true };
  host.entries.set('fixture', old as any);
  try {
    const pending = host.assertProtection('fixture'); host.entries.set('fixture', replacement as any);
    gate.resolve('{}'); await pending;
    assert.equal(host.entries.get('fixture'), replacement);
    runtime.management = async () => '{}';
    await assert.rejects(host.assertProtection('fixture'), { code: 'BROWSER_SANDBOX_FAILED' });
  } finally { gate.resolve('{}'); host.entries.clear(); await host.dispose(); }
});

test('An unprotected browser thread quarantines a busy environment and revokes existing viewer tickets', async () => {
  const directory = await mkdtemp(path.join(homedir(), '.mu-browser-monitor-unit-'));
  const runtime = new LimaRuntime(directory), host = new GuestBrowserHost(runtime, fallback), manager = new Manager(directory, host, runtime);
  let broken = false, stopped = 0, renewed = 0, revoked = 0;
  runtime.management = async () => {
    const data = healthy();
    if (broken) data.processes[1].threads.push({ tid: 333, seccomp: 0, noNewPrivileges: 1, effectiveCapabilities: '0000000000000000' });
    return JSON.stringify(data);
  };
  runtime.networkProtection = async () => ({ active: true } as NetworkProtection);
  runtime.renewLease = async () => { renewed++; }; runtime.revokeLease = async () => {};
  runtime.stop = async () => { stopped++; };
  const transport = new EventEmitter() as any;
  transport.exitCode = null; transport.kill = () => { transport.exitCode = 0; transport.emit('exit'); return true; };
  try {
    const environment = await manager.create({ name: 'Runtime browser monitor', network: { mode: 'http', host: 'proxy.test', strict: true, transparent: true } });
    manager.store.state(environment.id, 'running');
    host.entries.set(environment.id, { environment: manager.store.get(environment.id), release:CURRENT_BROWSER_RELEASE, ready: true, browserReady: true, password: 'abcdefgh', transport,
      directory: path.join(directory, 'viewer'), vnc: '', cdp: '', sessions: new Map(), configuration: new Set() });
    const ticket = host.issue(environment.id).ticket;
    manager.active.set(environment.id, 'synthetic-busy-task');
    manager.onQuarantine = async id => { revoked++; await host.close(id, false); };
    await manager.monitorProtection(); assert.equal(stopped, 0); assert.equal(renewed, 1);
    broken = true; await manager.monitorProtection();
    assert.equal(stopped, 1); assert.equal(renewed, 1); assert.equal(revoked, 2);
    assert.equal(manager.store.get(environment.id).state, 'error');
    assert.match(manager.store.get(environment.id).lastError ?? '', /浏览器进程防护检查/);
    assert.equal(host.entries.has(environment.id), false); assert.equal(host.tickets.has(ticket), false);
    await assert.rejects(manager.assertAccess(environment.id, true));
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});
