import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import type { Job } from '../shared/types.ts';
const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(homedir(), '.mu-snapshot-vm-'));
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const data = path.join(temporary, 'data'); const project = path.join(temporary, 'project'); await mkdir(project);
let manager = new Manager(data, undefined, new LimaRuntime(data));
let managerClosed = false;
const report: Record<string, unknown> = { passed: false, accountFree: true, paidModelCalls: 0, startedAt: new Date().toISOString(), actualHostPowerLossTested: false };
report.testedFiles = Object.fromEntries(await Promise.all(['server/snapshots.ts', 'server/manager.ts', 'scripts/snapshot-restore-worker.ts', 'scripts/verify-snapshots.ts'].map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
const e = await manager.create({ name: '快照实机验证', cpus: 2, memoryGiB: 2, diskGiB: 10, mounts: [{ id: crypto.randomUUID(), hostPath: project, guestPath: '/workspace/project', writable: false }] });
async function finish(job: Job) { await manager.tasks.get(job.id)?.promise; const done = manager.store.jobs().find(j => j.id === job.id)!; assert.equal(done.status, 'succeeded', done.message); }
async function interrupt(snapshotId: string, checkpoint: string) {
  await manager.close(); managerClosed = true;
  const child = spawn(process.execPath, [path.join(root, 'scripts/snapshot-restore-worker.ts'), data, e.id, snapshotId, checkpoint], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let output = '', timedOut = false;
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 300_000);
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(timedOut, false, 'Restore checkpoint timed out'); assert.equal(result.code, null, output); assert.equal(result.signal, 'SIGKILL', output);
    return result;
  } finally {
    clearTimeout(timer); manager = new Manager(data, undefined, new LimaRuntime(data)); managerClosed = false;
  }
}
try {
  console.log('Starting disposable VM for offline snapshot recovery.');
  await finish(await manager.lifecycle(e.id, 'start'));
  await manager.runtime.guest(manager.store.get(e.id), ['bash', '-c', 'printf before > "$HOME/snapshot-marker"']);
  await finish(await manager.lifecycle(e.id, 'stop'));
  await manager.snapshots.create(manager.store.get(e.id), 'Before', { onOutput: text => console.log(text.trim()) });
  const [snapshot] = await manager.snapshots.list(e);
  await finish(await manager.lifecycle(e.id, 'start'));
  await manager.runtime.guest(manager.store.get(e.id), ['bash', '-c', 'printf after > "$HOME/snapshot-marker"']);
  await writeFile(path.join(project, 'keep.txt'), 'host-newer');
  await finish(await manager.lifecycle(e.id, 'stop'));
  await manager.snapshots.restore(manager.store.get(e.id), snapshot.id);
  await finish(await manager.lifecycle(e.id, 'start'));
  assert.equal((await manager.runtime.guest(manager.store.get(e.id), ['bash', '-c', 'cat "$HOME/snapshot-marker"'])).trim(), 'before');
  assert.equal((await manager.runtime.guest(manager.store.get(e.id), ['cat', '/workspace/project/keep.txt'])).trim(), 'host-newer');
  report.realDiskRestored = true; report.sharedProjectPreserved = true;
  await manager.runtime.guest(manager.store.get(e.id), ['bash', '-c', 'printf after-crash > "$HOME/snapshot-marker"']);
  await finish(await manager.lifecycle(e.id, 'stop'));
  manager.store.save({ ...manager.store.get(e.id), name: '恢复前配置' });
  console.log(new Date().toISOString(), 'Killing the restore process after actual disk replacement.');
  const restoreExit = await interrupt(snapshot.id, 'Restored: disk');
  const journalPath = path.join(data, 'restore', e.id, 'journal.json');
  const journal = JSON.parse(JSON.parse(await readFile(journalPath, 'utf8')).body);
  assert.equal(journal.version, 2); assert.equal(journal.committed, false);
  assert.ok(journal.files.some((entry: any) => entry.key === 'disk' && entry.existed && /^[a-f0-9]{64}$/.test(entry.hash)));
  console.log(new Date().toISOString(), 'Killing recovery after it restores the real rollback disk.');
  const recoveryExit = await interrupt(snapshot.id, 'Recovered: disk');
  assert.equal(JSON.parse(JSON.parse(await readFile(journalPath, 'utf8')).body).committed, false);
  console.log(new Date().toISOString(), 'Recovering through normal lifecycle and checking the guest marker.');
  await finish(await manager.lifecycle(e.id, 'start'));
  assert.equal((await manager.runtime.guest(manager.store.get(e.id), ['bash', '-c', 'cat "$HOME/snapshot-marker"'])).trim(), 'after-crash');
  assert.equal(manager.store.get(e.id).name, '恢复前配置');
  assert.equal(await readFile(path.join(project, 'keep.txt'), 'utf8'), 'host-newer');
  await assert.rejects(readFile(journalPath), { code: 'ENOENT' });
  report.killedRestoreAndRecovery = { restoreExit, recoveryExit, normalLifecycleRecovered: true, preRestoreGuestMarker: 'after-crash', preRestoreConfigurationKept: true, sharedProjectPreserved: true, journalRemoved: true };
  await finish(await manager.lifecycle(e.id, 'stop'));
  console.log(new Date().toISOString(), 'Interrupting cleanup after completed rollback; partial cleanup must remain recoverable.');
  await interrupt(snapshot.id, 'Restored: disk');
  const cleanupExit = await interrupt(snapshot.id, 'Recovery transaction committed');
  assert.equal(JSON.parse(JSON.parse(await readFile(journalPath, 'utf8')).body).committed, true);
  await rm(path.join(data, 'restore', e.id, 'rollback', 'disk'));
  await finish(await manager.lifecycle(e.id, 'start'));
  assert.equal((await manager.runtime.guest(manager.store.get(e.id), ['bash', '-c', 'cat "$HOME/snapshot-marker"'])).trim(), 'after-crash');
  assert.equal(manager.store.get(e.id).name, '恢复前配置');
  await assert.rejects(readFile(journalPath), { code: 'ENOENT' });
  report.completedRollbackPartialCleanup = { cleanupExit, missingRollbackCopyIgnoredOnlyAfterCommit: true, preRestoreGuestMarker: 'after-crash', normalLifecycleStarted: true, journalRemoved: true };
  await finish(await manager.lifecycle(e.id, 'stop'));
  console.log(new Date().toISOString(), 'Killing after configuration save but before commit; both disk and configuration must roll back.');
  const configurationExit = await interrupt(snapshot.id, 'Restore configuration saved');
  assert.equal(manager.store.get(e.id).name, e.name);
  assert.equal(JSON.parse(JSON.parse(await readFile(journalPath, 'utf8')).body).committed, false);
  await finish(await manager.lifecycle(e.id, 'start'));
  assert.equal((await manager.runtime.guest(manager.store.get(e.id), ['bash', '-c', 'cat "$HOME/snapshot-marker"'])).trim(), 'after-crash');
  assert.equal(manager.store.get(e.id).name, '恢复前配置');
  await assert.rejects(readFile(journalPath), { code: 'ENOENT' });
  report.configurationSaveBeforeCommitRolledBack = { configurationExit, preRestoreDiskAndConfigurationKept: true, normalLifecycleRecovered: true };
  await finish(await manager.lifecycle(e.id, 'stop'));
  console.log(new Date().toISOString(), 'Killing after the committed journal; recovery must retain the restored disk.');
  const committedExit = await interrupt(snapshot.id, 'Restore transaction committed');
  assert.equal(JSON.parse(JSON.parse(await readFile(journalPath, 'utf8')).body).committed, true);
  await finish(await manager.lifecycle(e.id, 'start'));
  assert.equal((await manager.runtime.guest(manager.store.get(e.id), ['bash', '-c', 'cat "$HOME/snapshot-marker"'])).trim(), 'before');
  assert.equal(manager.store.get(e.id).name, e.name);
  assert.equal(await readFile(path.join(project, 'keep.txt'), 'utf8'), 'host-newer');
  await assert.rejects(readFile(journalPath), { code: 'ENOENT' });
  report.committedRestoreKeptAfterKill = { committedExit, restoredGuestMarker: 'before', restoredConfigurationKept: true, journalRemoved: true };
  await finish(await manager.lifecycle(e.id, 'stop'));
  const disk = await open(path.join(data, 'snapshots', e.id, snapshot.id, 'disk'), 'r+');
  try { await disk.write(Buffer.from('CORRUPTED'), 0, 9, 0); } finally { await disk.close(); }
  await assert.rejects(manager.snapshots.restore(manager.store.get(e.id), snapshot.id), /校验失败/);
  await finish(await manager.lifecycle(e.id, 'start'));
  assert.equal((await manager.runtime.guest(manager.store.get(e.id), ['bash', '-c', 'cat "$HOME/snapshot-marker"'])).trim(), 'before');
  report.corruptSnapshotRejectedWithoutDiskDamage = true; report.passed = true;
} catch (error) { report.error = (error as Error).message; report.logs = manager.store.logs(e.id).slice(-15); process.exitCode = 1; }
finally {
  if (report.passed) {
    await finish(await manager.lifecycle(e.id, 'delete')).catch(error => { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; });
  } else await manager.runtime.stop(managerClosed ? e : manager.store.get(e.id)).catch(error => { report.stopError = String(error); });
  if (!managerClosed) await manager.close();
  if (report.passed) { await rm(temporary, { recursive: true, force: true }); report.temporaryVmDataRemoved = true; }
  else report.retainedDataDir = temporary;
  report.finishedAt = new Date().toISOString();
  await mkdir(path.join(root, 'test-results'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, 'test-results/snapshots.json'), JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report, null, 2));
}
