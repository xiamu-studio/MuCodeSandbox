import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, totalmem } from 'node:os';
import path from 'node:path';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { checkHostPorts } from '../server/resource-budget.ts';

test('Real occupied host ports are rejected before launching a VM', async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await assert.rejects(checkHostPorts([address.port]), /已占用/); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  await checkHostPorts([address.port]);
});

test('Concurrent admission counts starting VMs and cancellation releases the budget', async () => {
  const root = await mkdtemp(path.join(homedir(), '.mu-resources-'));
  const runtime = new LimaRuntime(root);
  runtime.info = async () => ({ available: true, path: '/test', version: 'test', error: null });
  runtime.list = async () => [];
  runtime.start = async (_e, options) => new Promise<void>((_, reject) => options.signal?.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
  const manager = new Manager(root, undefined, runtime);
  try {
    const memory = Math.ceil(totalmem() / 2 ** 30 / 2);
    const a = await manager.create({ name: 'A', memoryGiB: memory });
    const b = await manager.create({ name: 'B', memoryGiB: memory });
    const results = await Promise.allSettled([manager.lifecycle(a.id, 'start'), manager.lifecycle(b.id, 'start')]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const failure = results.find(r => r.status === 'rejected');
    assert.ok(failure?.status === 'rejected'); assert.match(failure.reason.message, /总内存/);
    const job = [...manager.tasks.values()][0]; assert.ok(job);
    manager.cancel(job.job.id); await job.promise;
    const next = await manager.lifecycle(b.id, 'start');
    const task = manager.tasks.get(next.id)!; manager.cancel(next.id); await task.promise;
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});
