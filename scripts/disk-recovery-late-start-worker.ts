import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { Manager as SourceManager } from '../server/manager.ts';
import type { LimaRuntime as SourceRuntime } from '../server/runtime.ts';

const [directory, id, bundle] = process.argv.slice(2);
if (!directory || !id || !bundle || !process.send) throw new Error('An owned fixture, frozen package and IPC are required');
process.channel?.ref();
const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
const { Manager }: { Manager: typeof SourceManager } = await import(pathToFileURL(path.join(compiled, 'manager.js')).href);
const { LimaRuntime }: { LimaRuntime: typeof SourceRuntime } = await import(pathToFileURL(path.join(compiled, 'runtime.js')).href);
const runtime = new LimaRuntime(directory), manager = new Manager(directory, undefined, runtime);
const controller = new AbortController();
let start: Promise<string> | undefined, monitorTicks = 0, leaseRenewals = 0;
const monitor = manager.monitorProtection.bind(manager), renew = runtime.renewLease.bind(runtime);
manager.monitorProtection = async () => { monitorTicks++; await monitor(); };
runtime.renewLease = async (environment, options) => { leaseRenewals++; await renew(environment, options); };
try {
  const e = manager.store.get(id); assert.equal((await manager.diskRecovery.status(e)).pending, true);
  await manager.reconcile(true); assert.equal((await runtime.list()).find(row => row.name === e.instanceName)?.status, 'Stopped');
  // Replay a surviving startup after initial reconciliation, outside Manager jobs.
  // No snapshot/reconcile/API call below drives shutdown; only its real timer does.
  const began = Date.now(), observations = [];
  start = runtime.command(['start', '--timeout', '2m', e.instanceName], { signal: controller.signal, timeoutMs: 130_000 }).catch(() => 'interrupted');
  let runningObserved = false;
  while (true) {
    const status = (await runtime.list()).find(row => row.name === e.instanceName)?.status;
    observations.push({ elapsedMs: Date.now() - began, status });
    if (status === 'Running') runningObserved = true;
    if (runningObserved && status === 'Stopped') break;
    assert.ok(Date.now() - began < 30_000, 'Automatic monitor did not stop a late maintenance startup'); await delay(250);
  }
  assert.ok(monitorTicks > 0); assert.equal(leaseRenewals, 0); assert.equal(manager.store.get(id).state, 'error');
  assert.equal((await manager.diskRecovery.status(manager.store.get(id))).pending, true);
  controller.abort(); await start;
  process.send!({ passed: true, pid: process.pid, compiled, runningObserved, monitorTicks, leaseRenewals, observations,
    stoppedWithoutUiPolling: true, startReplay: 'Actual Lima start after initial reconcile, outside active Manager jobs' });
} catch (error) { process.send!({ error: error instanceof Error ? error.stack : String(error) }); process.exitCode = 1; }
finally { controller.abort(); await start; await manager.close(); process.disconnect?.(); }
