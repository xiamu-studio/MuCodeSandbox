import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createService } from '../server/service.ts';
import type { Job } from '../shared/types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.MU_DATA_DIR ?? path.join(homedir(), '.mucodesandbox'));
const keep = process.argv.includes('--keep');
const fixture = path.join(root, '.mu-data', `smoke-${randomUUID()}`);
const readOnly = path.join(fixture, 'readonly'); const writable = path.join(fixture, 'writable');
await mkdir(readOnly, { recursive: true }); await mkdir(writable, { recursive: true });
await writeFile(path.join(readOnly, 'marker.txt'), 'MuCodeSandbox readonly\n');
await writeFile(path.join(writable, 'marker.txt'), 'MuCodeSandbox writable\n');
const service = await createService({ rootDir: root, dataDir, port: 0 });
const manager = service.manager;
const e = await manager.create({ name: 'MuCodeSandbox 开发环境', description: 'Ubuntu 24.04 · 实机验证', kind: 'vm', cpus: 2, memoryGiB: 2, diskGiB: 20, mounts: [{ id: randomUUID(), hostPath: readOnly, guestPath: '/workspace/readonly', writable: false }, { id: randomUUID(), hostPath: writable, guestPath: '/workspace/writable', writable: true }] });
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), passed: false, instanceName: e.instanceName };
let success = false;
async function finish(job: Job) {
  await manager.tasks.get(job.id)?.promise;
  const result = manager.store.jobs().find(j => j.id === job.id)!;
  if (result.status !== 'succeeded') throw new Error(result.message);
}
try {
  console.log(`Real VM verification at ${service.url}`);
  await finish(await manager.lifecycle(e.id, 'start'));
  const running = manager.store.get(e.id);
  assert.equal(running.state, 'running');
  assert.equal((await manager.runtime.guest(running, ['uname', '-s'])).trim(), 'Linux');
  await manager.runtime.guest(running, ['bash', '-c', 'set -eu; cat /workspace/readonly/marker.txt; if touch /workspace/readonly/must-not-write 2>/dev/null; then exit 7; fi; printf "written from VM\\n" > /workspace/writable/from-vm.txt; test ! -d /Users; printf "BOUNDARY_OK\\n"']);
  assert.equal(await readFile(path.join(writable, 'from-vm.txt'), 'utf8'), 'written from VM\n');
  report.metrics = await manager.runtime.metrics(running);
  report.readonlyEnforced = true; report.writableShareWorks = true; report.hostHomeNotMounted = true;
  await finish(await manager.lifecycle(e.id, 'stop'));
  assert.equal(manager.store.get(e.id).state, 'stopped');
  await finish(await manager.lifecycle(e.id, 'start'));
  assert.equal((await manager.runtime.guest(manager.store.get(e.id), ['cat', '/workspace/writable/from-vm.txt'])).trim(), 'written from VM');
  await finish(await manager.lifecycle(e.id, 'stop'));
  report.stopRestartPersistence = true;
  if (keep) {
    const workspace = path.join(root, 'examples/workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'hello.js'), 'console.log("Hello from MuCodeSandbox");\n');
    const current = manager.store.get(e.id);
    await manager.update(e.id, { name: current.name, description: 'Ubuntu 24.04 · 项目目录只读', kind: current.kind, color: current.color, cpus: current.cpus, memoryGiB: current.memoryGiB, diskGiB: current.diskGiB, mounts: [{ id: randomUUID(), hostPath: workspace, guestPath: '/workspace/project', writable: false }], ports: [], network: { mode: 'direct', host: '', port: 7890, username: '', noProxy: 'localhost,127.0.0.1' }, browserUrl: current.browserUrl });
    report.retainedEnvironmentId = e.id;
  }
  success = true; report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  const logs = manager.store.logs(e.id); report.logs = logs;
  if (!keep || !success) {
    try { await finish(await manager.lifecycle(e.id, 'delete')); } catch (error) { report.cleanupError = String(error); }
  }
  await service.close(); await rm(fixture, { recursive: true, force: true });
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/vm-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, logs: undefined }, null, 2));
}
