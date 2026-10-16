import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';

test('Offline snapshots restore disk and encrypted config, preserve shared files and reject corrupt content', async () => {
  const root = await mkdtemp(path.join(homedir(), '.mu-snapshot-'));
  const runtime = new LimaRuntime(root); runtime.list = async () => manager.store.list().map(e => ({ name: e.instanceName, status: 'Stopped' }));
  const manager = new Manager(root, undefined, runtime);
  try {
    const project = path.join(root, 'project'); await mkdir(project); await writeFile(path.join(project, 'keep.txt'), 'host-newer');
    const created = await manager.create({ name: 'Snapshot', network: { mode: 'http', host: 'proxy.test', password: 'private-test-only' } });
    manager.store.state(created.id, 'stopped'); const e = manager.store.get(created.id);
    const instance = path.join(runtime.limaHome, e.instanceName); await mkdir(instance, { recursive: true });
    await writeFile(path.join(instance, 'disk'), 'disk-before'); await writeFile(path.join(instance, 'lima.yaml'), 'config-before');
    const security = path.join(root, 'security'); await mkdir(security, { recursive: true });
    const trustFiles = ['shares', 'shares-migration'].map(suffix => path.join(security, `${e.instanceName}-${suffix}.json`));
    for (const file of trustFiles) await writeFile(file, 'disk-before-approval');
    await manager.snapshots.create(e, 'Before');
    for (const file of trustFiles) assert.equal(await readFile(file, 'utf8'), 'disk-before-approval', 'Creating a snapshot does not revoke current-disk trust');
    const [snapshot] = await manager.snapshots.list(e);
    const snapshotPath = path.join(root, 'snapshots', e.id, snapshot.id);
    assert.ok(!(await readFile(path.join(snapshotPath, 'manifest.json'), 'utf8')).includes('private-test-only'));
    await writeFile(path.join(instance, 'disk'), 'disk-after'); manager.store.save({ ...e, name: 'After' });
    await manager.snapshots.restore(manager.store.get(e.id), snapshot.id);
    for (const file of trustFiles) await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(instance, 'disk'), 'utf8'), 'disk-before');
    assert.equal(manager.store.get(e.id).name, 'Snapshot');
    assert.equal(manager.store.get(e.id).network.password, 'private-test-only');
    assert.equal(await readFile(path.join(project, 'keep.txt'), 'utf8'), 'host-newer');
    await writeFile(path.join(instance, 'disk'), 'transaction-before');
    manager.store.save({ ...e, name: 'Transaction before' });
    const controller = new AbortController();
    for (const file of trustFiles) await writeFile(file, 'transaction-before-approval');
    await assert.rejects(manager.snapshots.restore(manager.store.get(e.id), snapshot.id, { signal: controller.signal, onOutput: text => { if (text.startsWith('Restored: disk')) { for (const file of trustFiles) assert.equal(existsSync(file), false, 'Trust must be revoked before the first disk mutation'); controller.abort(); } } }));
    for (const file of trustFiles) await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(instance, 'disk'), 'utf8'), 'transaction-before');
    assert.equal(manager.store.get(e.id).name, 'Transaction before');
    await writeFile(path.join(snapshotPath, 'disk'), 'corrupt'); await writeFile(path.join(instance, 'disk'), 'disk-current');
    for (const file of trustFiles) await writeFile(file, 'disk-current-approval');
    await assert.rejects(manager.snapshots.restore(e, snapshot.id), /校验失败/);
    for (const file of trustFiles) assert.equal(await readFile(file, 'utf8'), 'disk-current-approval', 'Rejected content never replaces the disk');
    assert.equal(await readFile(path.join(instance, 'disk'), 'utf8'), 'disk-current');
    await manager.snapshots.remove(e, snapshot.id); assert.deepEqual(await manager.snapshots.list(e), []);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

async function interruptedRestore(dataDir: string, environmentId: string, snapshotId: string, checkpoint: string) {
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../scripts/snapshot-restore-worker.ts'), dataDir, environmentId, snapshotId, checkpoint, 'fixture'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10_000);
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(timedOut, false, 'Interruption checkpoint was not reached in time');
    assert.equal(result.code, null, output); assert.equal(result.signal, 'SIGKILL', output);
  } finally { clearTimeout(timer); }
}

test('A killed restore and a killed recovery return to the complete previous state; a committed restore remains installed', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(homedir(), '.mu-snapshot-crash-'));
  let manager: Manager;
  const reopen = () => {
    const runtime = new LimaRuntime(root); runtime.list = async () => manager.store.list().map(e => ({ name: e.instanceName, status: 'Stopped' }));
    return new Manager(root, undefined, runtime);
  };
  manager = reopen();
  try {
    const created = await manager.create({ name: 'Original' }); manager.store.state(created.id, 'stopped');
    const e = manager.store.get(created.id), instance = path.join(manager.runtime.limaHome, e.instanceName);
    await mkdir(instance, { recursive: true });
    await writeFile(path.join(instance, 'disk'), 'disk-original'); await writeFile(path.join(instance, 'lima.yaml'), 'config-original');
    await manager.snapshots.create(e, 'Original'); const [snapshot] = await manager.snapshots.list(e);
    await writeFile(path.join(instance, 'disk'), 'disk-current'); await writeFile(path.join(instance, 'lima.yaml'), 'config-current');
    manager.store.save({ ...e, name: 'Current' }); await manager.close();
    await interruptedRestore(root, e.id, snapshot.id, 'Restored: disk');
    assert.equal(await readFile(path.join(instance, 'disk'), 'utf8'), 'disk-original');
    assert.equal(await readFile(path.join(instance, 'lima.yaml'), 'utf8'), 'config-current');
    const security = path.join(root, 'security'); await mkdir(security, { recursive: true });
    const trustFiles = ['shares', 'shares-migration'].map(suffix => path.join(security, `${e.instanceName}-${suffix}.json`));
    for (const file of trustFiles) await writeFile(file, 'stale-trust-from-old-recovery');
    await interruptedRestore(root, e.id, snapshot.id, 'Recovered: disk');
    for (const file of trustFiles) await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(instance, 'disk'), 'utf8'), 'disk-current');
    await interruptedRestore(root, e.id, snapshot.id, 'Recovery transaction committed');
    await rm(path.join(root, 'restore', e.id, 'rollback', 'disk'));
    manager = reopen(); await manager.snapshots.recover(manager.store.get(e.id)); await manager.snapshots.recover(manager.store.get(e.id));
    assert.equal(manager.store.get(e.id).name, 'Current');
    assert.equal(await readFile(path.join(instance, 'lima.yaml'), 'utf8'), 'config-current');
    await assert.rejects(readFile(path.join(root, 'restore', e.id, 'journal.json')), { code: 'ENOENT' });
    await manager.close();
    await interruptedRestore(root, e.id, snapshot.id, 'Restore transaction committed');
    for (const file of trustFiles) await writeFile(file, 'stale-trust-from-old-committed-restore');
    manager = reopen(); await manager.snapshots.recover(manager.store.get(e.id));
    for (const file of trustFiles) await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(instance, 'disk'), 'utf8'), 'disk-original');
    assert.equal(await readFile(path.join(instance, 'lima.yaml'), 'utf8'), 'config-original');
    assert.equal(manager.store.get(e.id).name, 'Original');
    await assert.rejects(readFile(path.join(root, 'restore', e.id, 'journal.json')), { code: 'ENOENT' });
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('An interrupted version 1 restore remains recoverable after the journal upgrade', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(homedir(), '.mu-snapshot-legacy-'));
  const runtime = new LimaRuntime(root); let manager = new Manager(root, undefined, runtime);
  runtime.list = async () => manager.store.list().map(e => ({ name: e.instanceName, status: 'Stopped' }));
  try {
    const created = await manager.create({ name: 'Original' }); manager.store.state(created.id, 'stopped'); const e = manager.store.get(created.id);
    const instance = path.join(runtime.limaHome, e.instanceName); await mkdir(instance, { recursive: true });
    await writeFile(path.join(instance, 'disk'), 'disk-original'); await manager.snapshots.create(e, 'Original');
    const [snapshot] = await manager.snapshots.list(e); await writeFile(path.join(instance, 'disk'), 'disk-current');
    await manager.close(); await interruptedRestore(root, e.id, snapshot.id, 'Restored: disk'); manager = new Manager(root, undefined, runtime);
    const journalPath = path.join(root, 'restore', e.id, 'journal.json');
    const metadata = (manager.snapshots as any).unseal(await readFile(journalPath, 'utf8'));
    const legacy = { ...metadata, version: 1, files: metadata.files.map(({ key, existed }: { key: string; existed: boolean }) => ({ key, existed })) };
    await writeFile(journalPath, (manager.snapshots as any).seal(legacy));
    await manager.snapshots.recover(e);
    assert.equal(await readFile(path.join(instance, 'disk'), 'utf8'), 'disk-current');
    assert.ok(manager.store.logs(e.id).some(log => log.message.includes('旧记录不包含回滚副本校验值')));
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('Corrupt rollback is rejected before changing any installed target and keeps the recovery journal', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(homedir(), '.mu-snapshot-corrupt-'));
  const runtime = new LimaRuntime(root); let manager = new Manager(root, undefined, runtime);
  runtime.list = async () => manager.store.list().map(e => ({ name: e.instanceName, status: 'Stopped' }));
  try {
    const created = await manager.create({ name: 'Original' }); manager.store.state(created.id, 'stopped'); const e = manager.store.get(created.id);
    const instance = path.join(runtime.limaHome, e.instanceName); await mkdir(instance, { recursive: true });
    await writeFile(path.join(instance, 'disk'), 'disk-original'); await writeFile(path.join(instance, 'lima.yaml'), 'config-original');
    await manager.snapshots.create(e, 'Original'); const [snapshot] = await manager.snapshots.list(e);
    await writeFile(path.join(instance, 'disk'), 'disk-current'); await writeFile(path.join(instance, 'lima.yaml'), 'config-current');
    await manager.close(); await interruptedRestore(root, e.id, snapshot.id, 'Restored: disk');
    manager = new Manager(root, undefined, runtime);
    const directory = path.join(root, 'restore', e.id), rollback = path.join(directory, 'rollback', 'installedConfig');
    await writeFile(rollback, 'corrupt');
    await assert.rejects(manager.snapshots.recover(e), /回滚副本校验失败/);
    await assert.rejects(manager.lifecycle(e.id, 'start'), /回滚副本校验失败/);
    assert.equal(await readFile(path.join(instance, 'disk'), 'utf8'), 'disk-original', 'Preflight must reject before rolling back the disk');
    assert.equal(await readFile(path.join(instance, 'lima.yaml'), 'utf8'), 'config-current');
    assert.ok((await readFile(path.join(directory, 'journal.json'), 'utf8')).includes('mac'));
    await writeFile(rollback, 'config-current'); await manager.snapshots.recover(e);
    assert.equal(await readFile(path.join(instance, 'disk'), 'utf8'), 'disk-current');
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('Creating or restoring after recovery uses the recovered configuration rather than stale caller data', { timeout: 30_000 }, async () => {
  for (const action of ['create', 'restore'] as const) {
    const root = await mkdtemp(path.join(homedir(), '.mu-snapshot-stale-'));
    const runtime = new LimaRuntime(root); let manager = new Manager(root, undefined, runtime);
    runtime.list = async () => manager.store.list().map(e => ({ name: e.instanceName, status: 'Stopped' }));
    try {
      const created = await manager.create({ name: 'Original' }); manager.store.state(created.id, 'stopped'); const e = manager.store.get(created.id);
      const disk = path.join(runtime.limaHome, e.instanceName, 'disk'); await mkdir(path.dirname(disk), { recursive: true });
      await writeFile(disk, 'disk-original'); await manager.snapshots.create(e, 'Original'); const [snapshot] = await manager.snapshots.list(e);
      await writeFile(disk, 'disk-current'); manager.store.save({ ...e, name: 'Current' }); await manager.close();
      await interruptedRestore(root, e.id, snapshot.id, 'Restore configuration saved');
      manager = new Manager(root, undefined, runtime); const stale = manager.store.get(e.id); assert.equal(stale.name, 'Original');
      if (action === 'create') {
        await manager.snapshots.create(stale, 'After recovery'); const next = (await manager.snapshots.list(e)).find(value => value.name === 'After recovery')!;
        await writeFile(disk, 'changed-again'); manager.store.save({ ...e, name: 'Changed again' });
        await manager.snapshots.restore(manager.store.get(e.id), next.id);
      } else {
        const controller = new AbortController();
        await assert.rejects(manager.snapshots.restore(stale, snapshot.id, { signal: controller.signal, onOutput: text => { if (text.startsWith('Restored: disk')) controller.abort(); } }));
      }
      assert.equal(manager.store.get(e.id).name, 'Current', action);
      assert.equal(await readFile(disk, 'utf8'), 'disk-current', action);
    } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
  }
});
