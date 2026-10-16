import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server/service.ts';
import type { BrowserHost } from '../server/browser.ts';
import type { Environment } from '../shared/types.ts';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import type { RunOptions } from '../server/process.ts';

class TestBrowser implements BrowserHost {
  native = false;
  ids = new Set<string>();
  async available() { return true; }
  running(id: string) { return this.ids.has(id); }
  async open(e: Environment) { this.ids.add(e.id); }
  async close(id: string) { this.ids.delete(id); }
  async clear(id: string) { this.ids.delete(id); }
  async dispose() { this.ids.clear(); }
}

test('API enforces token and origin, persists environments, hides passwords and rejects a second service', async () => {
  const root = await mkdtemp(path.join(homedir(), '.mu-api-test-'));
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const service = await createService({ dataDir: root, port: 0, rootDir: project, browser: new TestBrowser() });
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(`${service.url}/api/snapshot`)).status, 401);
    assert.equal((await fetch(`${service.url}/api/snapshot`, { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
    const created = await fetch(`${service.url}/api/environments`, { method: 'POST', headers, body: JSON.stringify({ name: 'Browser Test', kind: 'browser', network: { mode: 'http', host: 'proxy.example.com', port: 8080, username: 'user', password: 'super-private', noProxy: '' } }) });
    assert.equal(created.status, 201);
    const e = await created.json() as Environment;
    assert.equal(e.network.password, undefined);
    assert.equal(e.network.passwordConfigured, true);
    const start = await fetch(`${service.url}/api/environments/${e.id}/actions/start`, { method: 'POST', headers });
    assert.equal(start.status, 202);
    await Promise.all([...service.manager.tasks.values()].map(t => t.promise));
    const snap = await (await fetch(`${service.url}/api/snapshot`, { headers })).json();
    assert.equal(snap.environments[0].state, 'running');
    assert.equal(snap.environments[0].browserRunning, true);
    assert.ok(!JSON.stringify(snap).includes('super-private'));
    assert.equal((await fetch(`${service.url}/api/environments/${e.id}`, { method: 'PUT', headers, body: JSON.stringify({ name: 'Change', kind: 'browser' }) })).status, 409);
    await assert.rejects(createService({ dataDir: root, port: 0, rootDir: project }), /已在运行/);
    const denied=await fetch(service.url);
    assert.equal(denied.status,403);assert.ok(!(await denied.text()).includes(service.token));
    const launch=await fetch(service.launchUrl(),{redirect:'manual'});
    const cookie=launch.headers.get('set-cookie')!.split(';')[0];
    const html = await (await fetch(service.url,{headers:{Cookie:cookie}})).text();
    assert.ok(html.includes('window.__MU_CONFIG__'));
    assert.ok((await fetch(service.url)).headers.get('content-security-policy')?.includes('frame-ancestors'));
    const starts = await Promise.all([1, 2].map(() => fetch(`${service.url}/api/lab/start`, { method: 'POST', headers }).then(r => r.json())));
    assert.equal(starts[0].url, starts[1].url);
    assert.equal((await fetch(`${service.url}/api/snapshot`, { headers: { ...headers, Origin: starts[0].url } })).status, 403);
    const labHtml = await (await fetch(starts[0].url)).text();
    assert.ok(!labHtml.includes('window.__MU_CONFIG__'));
    assert.ok(!labHtml.includes(service.token));
    await fetch(`${service.url}/api/lab/stop`, { method: 'POST', headers });
    await assert.rejects(fetch(starts[0].url));
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

class TestRuntime extends LimaRuntime {
  instances: { name: string; status: string }[] = [];
  fail = false;
  gate: Promise<void> | null = null;
  async info() { return { available: true, path: '/test/limactl', version: 'test', error: null }; }
  async list() { return this.instances; }
  async start(e: Environment, _options: RunOptions) { if (this.gate) await this.gate; if (this.fail) throw new Error('simulated network failure'); this.instances = [{ name: e.instanceName, status: 'Running' }]; }
  async stop(_e: Environment, _options?: RunOptions) { this.instances = this.instances.map(i => ({ ...i, status: 'Stopped' })); }
  async remove(_e: Environment, _options?: RunOptions) { this.instances = []; }
}

test('Lifecycle records truthful success and failures, serializes operations, preserves project config and can retry', async () => {
  const root = await mkdtemp(path.join(homedir(), '.mu-manager-test-'));
  const runtime = new TestRuntime(root);
  const manager = new Manager(root, new TestBrowser(), runtime);
  try {
    const e = await manager.create({ name: 'VM Test', kind: 'vm' });
    let release!: () => void;
    runtime.gate = new Promise(resolve => { release = resolve; });
    const first = await manager.lifecycle(e.id, 'start');
    await assert.rejects(manager.lifecycle(e.id, 'delete'), /其他操作/);
    release(); await manager.tasks.get(first.id)?.promise;
    assert.equal(manager.store.get(e.id).state, 'running');
    assert.equal(manager.store.jobs()[0].status, 'succeeded');
    const stop = await manager.lifecycle(e.id, 'stop'); await manager.tasks.get(stop.id)?.promise;
    assert.equal(manager.store.get(e.id).state, 'stopped');
    runtime.gate = null; runtime.fail = true;
    const fail = await manager.lifecycle(e.id, 'start'); await manager.tasks.get(fail.id)?.promise;
    assert.equal(manager.store.get(e.id).state, 'error');
    assert.match(manager.store.get(e.id).lastError ?? '', /network failure/);
    runtime.fail = false;
    const retry = await manager.lifecycle(e.id, 'start'); await manager.tasks.get(retry.id)?.promise;
    assert.equal(manager.store.get(e.id).state, 'running');
    const deletion = await manager.lifecycle(e.id, 'delete'); await manager.tasks.get(deletion.id)?.promise;
    assert.equal(manager.store.list().length, 0);
    assert.deepEqual(runtime.instances, []);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('Snapshot recovery reserves the environment before lifecycle admission and blocks concurrent changes', async () => {
  const root = await mkdtemp(path.join(homedir(), '.mu-recovery-lock-'));
  const runtime = new TestRuntime(root), manager = new Manager(root, new TestBrowser(), runtime);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const e = await manager.create({ name: 'Recovery lock' }); manager.store.state(e.id, 'error');
    runtime.instances = [{ name: e.instanceName, status: 'Running' }];
    manager.snapshots.recover = async () => { await gate; };
    const start = manager.lifecycle(e.id, 'start');
    await assert.rejects(manager.lifecycle(e.id, 'delete'), /其他操作/);
    await assert.rejects(manager.update(e.id, { name: 'Concurrent edit' }), /其他操作/);
    assert.throws(() => manager.submit(e.id, 'snapshot-create', async () => {}), /其他操作/);
    await manager.reconcile(true); assert.equal(manager.store.get(e.id).state, 'error');
    release(); const job = await start; await manager.tasks.get(job.id)?.promise;
    assert.equal(manager.store.get(e.id).state, 'running');
    assert.equal(manager.recoveries.size, 0);
  } finally { release(); await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('Closing waits for snapshot recovery and cannot start a VM after recovery finishes', async () => {
  const root = await mkdtemp(path.join(homedir(), '.mu-recovery-close-'));
  const runtime = new TestRuntime(root), manager = new Manager(root, new TestBrowser(), runtime);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let closed = false;
  try {
    const e = await manager.create({ name: 'Recovery close' });
    manager.snapshots.recover = async () => { await gate; manager.store.log(e.id, null, 'Recovery finished'); };
    const start = manager.lifecycle(e.id, 'start'); const rejected = assert.rejects(start, /应用正在退出/);
    const closing = manager.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false); release(); await rejected; await closing;
    assert.deepEqual(runtime.instances, []);
  } finally { release(); if (!closed) await manager.close(); await rm(root, { recursive: true, force: true }); }
});
