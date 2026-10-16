import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const network = process.argv.includes('--network');
const storage = process.argv.includes('--storage');
const reserve = process.argv.includes('--reserve');
const prefix = reserve ? 'storage-capacity-reserve' : storage ? 'storage-capacity-fixed' : network ? 'storage-capacity-network' : 'storage-capacity';
const reportName = network || storage || reserve ? prefix : 'storage-capacity-latest';
const bundle = path.join(root, `release/${reserve ? 'guest-capacity-fix-candidate' : storage ? 'guest-capacity-candidate' : network ? 'host-network-candidate' : 'local-test-candidate'}/mac-arm64/MuCodeSandbox.app`);
const appRoot = path.join(bundle, 'Contents/Resources/app');
const owned = await mkdtemp(path.join(homedir(), '.mu-capacity-'));
const mount = path.join(owned, 'mount'), image = path.join(owned, 'limited.sparseimage');
const artifacts = path.join(root, 'test-results', `${prefix}-${Date.now()}`);
await mkdir(artifacts, { mode: 0o700 }); await mkdir(mount);
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), bundle,
  artifacts, actualVmTested: false, actualElectronUiTested: false, actualFilesystemFullTested: true,
  runtimeStoppedStateFixture: true, volumeLimitMiB: 512, accountFree: true, paidModelCalls: 0,
  scope: 'Frozen package storage modules on a bounded APFS image, synthetic offline disk, real space checks and ENOSPC; not VM startup, UI, power loss or host-disk exhaustion', phases: [] };
let attached = false, source: any, destination: any;
const filler = path.join(mount, 'owned-space-filler');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function hashFile(file: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function free() { const s = await statfs(mount); return s.bavail * s.bsize; }
async function fillTo(remaining: number) {
  const file = await open(filler, 'w', 0o600), bytes = Buffer.alloc(2 ** 20, 0x6d);
  let written = 0;
  try {
    while (await free() > remaining + bytes.length) { await file.writeFile(bytes); written += bytes.length; assert.ok(written < 512 * 2 ** 20); }
    await file.sync();
  } finally { await file.close(); }
  return { written, available: await free() };
}
function fillCompletely() {
  const fd = openSync(filler, 'w', 0o600), bytes = Buffer.alloc(2 ** 20, 0x6d);
  let written = 0, code: string | undefined;
  try {
    for (const chunk of [bytes, bytes.subarray(0, 4096)]) {
      try { while (true) { written += writeSync(fd, chunk); assert.ok(written <= 512 * 2 ** 20); } }
      catch (error) { code = (error as NodeJS.ErrnoException).code; assert.equal(code, 'ENOSPC'); }
    }
  }
  finally { closeSync(fd); }
  return { written, code, smallestFailedWriteBytes: 4096 };
}
async function rejected(operation: () => Promise<any>) {
  try { await operation(); } catch (error) {
    return { code: (error as any).code, message: (error as Error).message };
  }
  throw new Error('Capacity fault incorrectly reported success');
}
async function missing(file: string) { await assert.rejects(stat(file), { code: 'ENOENT' }); }
async function phase(name: string, observation: Record<string, any>) {
  report.phases.push({ name, at: new Date().toISOString(), ...observation }); console.log(name);
  await writeFile(path.join(root, `test-results/${reportName}.json`), JSON.stringify(report, null, 2));
}
try {
  const host = await statfs(owned); assert.ok(host.bavail * host.bsize > 100 * 2 ** 30);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
  report.cdHash = signature.match(/^CDHash=(.+)$/m)?.[1]; assert.equal(report.cdHash, reserve ? '45e0b4a3475ace48909deee9155ada564fed65a3' : storage ? '62a352b635eb86c335fce0f5eb8e830f1c8d9d0e' : network ? 'cf031a2a4bbc9d55cc8b1d97e77a935b312145d2' : '26511866b6077c14947fc169a03e5496ba887a83');
  report.modules = {};
  for (const name of ['manager', 'store', 'runtime', 'snapshots', 'backups']) {
    const file = `dist-server/server/${name}.js`; report.modules[file] = digest(await readFile(path.join(appRoot, file)));
  }
  await run('/usr/bin/hdiutil', ['create', '-size', '512m', '-fs', 'APFS', '-volname', 'MuCapacityOwned', '-type', 'SPARSE', image], { timeoutMs: 60_000 });
  const attachedPlist = await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, '-plist', image], { timeoutMs: 60_000 });
  attached = true;
  const attachment = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: attachedPlist }));
  assert.ok(attachment['system-entities'].some((entity: any) => entity['mount-point'] === mount));
  assert.notEqual((await stat(mount)).dev, (await stat(owned)).dev, 'All filler writes must land on the disposable image');
  const capacity = await statfs(mount); assert.ok(capacity.blocks * capacity.bsize <= 512 * 2 ** 20);
  report.volume = { attachment, mountedDevice: (await stat(mount)).dev, hostDevice: (await stat(owned)).dev,
    totalBytes: capacity.blocks * capacity.bsize, initialAvailable: await free() };
  await writeFile(path.join(artifacts, 'attachment.plist'), attachedPlist);
  const { Manager } = await import(pathToFileURL(path.join(appRoot, 'dist-server/server/manager.js')).href);
  source = new Manager(path.join(mount, 'source')); destination = new Manager(path.join(mount, 'destination'));
  // These tests exercise storage transactions, with no real guest or VM launcher.
  source.runtime.list = async () => source.store.list().map((e: any) => ({ name: e.instanceName, status: 'Stopped' }));
  const created = await source.create({ name: 'Capacity original', diskGiB: 10, memoryGiB: 2, cpus: 1 });
  source.store.state(created.id, 'stopped'); const e = source.store.get(created.id);
  const instance = path.join(source.runtime.limaHome, e.instanceName); await mkdir(instance, { recursive: true });
  const disk = path.join(instance, 'disk'), handle = await open(disk, 'wx', 0o600);
  try { for (let n = 0; n < 32; n++) await handle.writeFile(randomBytes(2 ** 20)); await handle.sync(); }
  finally { await handle.close(); }
  await writeFile(path.join(instance, 'lima.yaml'), 'MU_CAPACITY_SYNTHETIC_CONFIG');
  await source.snapshots.create(e, 'Capacity positive control'); const [snapshot] = await source.snapshots.list(e);
  const originalHash = await hashFile(disk), backup = path.join(owned, 'healthy.mu-backup'), password = 'synthetic-capacity-password';
  await source.backups.export(e, snapshot.id, backup, password);
  const imported = await destination.backups.import(backup, password, 'Capacity import positive control');
  assert.equal(await hashFile(path.join(destination.store.dataDir, 'imports', imported.id, 'disk')), originalHash);
  report.originalDiskHash = originalHash; report.backupHash = await hashFile(backup);
  await phase('Healthy snapshot, encrypted export and import', { positiveControl: true, diskBytes: (await stat(disk)).size, available: await free() });

  const low = await fillTo(32 * 2 ** 20), deniedBackup = path.join(mount, 'denied.mu-backup');
  const exportFailure = await rejected(() => source.backups.export(e, snapshot.id, deniedBackup, password));
  const importFailure = await rejected(() => destination.backups.import(backup, password, 'Should not publish'));
  assert.equal(exportFailure.code, 'BACKUP_SPACE'); assert.equal(importFailure.code, 'BACKUP_SPACE');
  await missing(deniedBackup); assert.equal(destination.store.list().length, 1);
  assert.ok((await readdir(path.join(destination.store.dataDir, 'imports'))).every(name => !name.startsWith('.tmp-')));
  assert.equal(await hashFile(disk), originalHash);
  await phase('Insufficient space rejects export and import before publication', { low, exportFailure, importFailure, originalDiskPreserved: true, noPhantomEnvironment: true });
  await rm(filler);

  let actualFull: Record<string, any> | undefined;
  const midExport = path.join(mount, 'mid-export.mu-backup');
  const midExportFailure = await rejected(() => source.backups.export(e, snapshot.id, midExport, password, {
    onOutput: (text: string) => { if (text.startsWith('Encrypting snapshot disk')) actualFull = fillCompletely(); },
  }));
  assert.equal(actualFull?.code, 'ENOSPC'); await missing(midExport);
  assert.ok((await readdir(mount)).every(name => !name.startsWith('mid-export.mu-backup.partial-')));
  assert.equal(await hashFile(disk), originalHash);
  await phase('Disk fills after export begins; incomplete backup removed', { actualFull, failure: midExportFailure, noPartialBackup: true, originalDiskPreserved: true });
  await rm(filler);

  const currentDisk = await open(disk, 'r+'); try { await currentDisk.write(Buffer.from('MU_CAPACITY_CURRENT')); await currentDisk.sync(); } finally { await currentDisk.close(); }
  source.store.save({ ...e, name: 'Capacity current' }); const current = source.store.get(e.id), currentHash = await hashFile(disk);
  assert.notEqual(currentHash, originalHash);
  const fullBeforeSnapshot = fillCompletely();
  const snapshotFailure = await rejected(() => source.snapshots.create(current, 'Should not publish full snapshot'));
  const restoreFailure = await rejected(() => source.snapshots.restore(current, snapshot.id));
  assert.equal(await hashFile(disk), currentHash); assert.equal(source.store.get(e.id).name, 'Capacity current');
  assert.equal((await source.snapshots.list(current)).length, 1);
  await phase('Full volume rejects snapshot and restore with current disk intact', { fullBeforeSnapshot, snapshotFailure, restoreFailure, currentDiskHash: currentHash, currentDiskPreserved: true, noPublishedSnapshot: true });
  await rm(filler); await source.snapshots.recover(current);

  let restoreFill: Record<string, any> | undefined;
  const midRestoreFailure = await rejected(() => source.snapshots.restore(current, snapshot.id, {
    onOutput: (text: string) => { if (text.startsWith('Restored: disk')) restoreFill = fillCompletely(); },
  }));
  assert.equal(restoreFill?.code, 'ENOSPC');
  const journal = path.join(source.store.dataDir, 'restore', e.id, 'journal.json');
  const pending = await stat(journal).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (!pending) assert.equal(await hashFile(disk), currentHash, 'Completed immediate rollback must restore the current disk');
  let startupRejection: Record<string, any> | undefined;
  if (pending) {
    const bytes = await readFile(journal), metadata = JSON.parse(JSON.parse(bytes.toString()).body);
    const rollback = metadata.files.find((entry: any) => entry.key === 'disk');
    assert.equal(rollback.hash, currentHash);
    assert.equal(await hashFile(path.join(path.dirname(journal), 'rollback/disk')), currentHash);
    await writeFile(path.join(artifacts, 'pending-journal.json'), bytes);
    report.pendingJournalSha256 = digest(bytes); report.rollbackDiskHash = currentHash;
    const jobsBefore = source.store.jobs().length;
    startupRejection = await rejected(() => source.lifecycle(e.id, 'start'));
    assert.notEqual(startupRejection.code, 'RUNTIME_MISSING');
    assert.equal(source.store.jobs().length, jobsBefore, 'Recovery failure must prevent a startup job from being submitted');
    assert.equal(digest(await readFile(journal)), digest(bytes));
  }
  await phase('Disk fills after disk replacement; rollback or retained recovery journal', { restoreFill, failure: midRestoreFailure, pendingRecoveryJournal: pending,
    immediateRollbackCompleted: !pending, startupRejection, startupJobNotSubmitted: pending || undefined });
  await rm(filler); await source.snapshots.recover(source.store.get(e.id));
  assert.equal(await hashFile(disk), currentHash); assert.equal(source.store.get(e.id).name, 'Capacity current');
  await missing(journal);
  await source.snapshots.restore(source.store.get(e.id), snapshot.id);
  assert.equal(await hashFile(disk), originalHash); assert.equal(source.store.get(e.id).name, 'Capacity original');
  const retriedBackup = path.join(mount, 'retried.mu-backup'); await source.backups.export(source.store.get(e.id), snapshot.id, retriedBackup, password);
  await phase('Freed space permits recovery and a new healthy restore and export', { rollbackAfterFreePreservedCurrent: true, subsequentRestoreAndExportPassed: true, originalDiskHash: originalHash, available: await free() });
  report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  try { await source?.close(); await destination?.close(); if (attached) await run('/usr/bin/hdiutil', ['detach', mount], { timeoutMs: 60_000 }); attached = false;
    await rm(owned, { recursive: true, force: true }); report.imageAndDataRemoved = true; }
  catch (error) { report.cleanupError = String(error); report.retainedOwnedDirectory = owned; report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  report.harnessSha256 = digest(await readFile(import.meta.filename));
  await writeFile(path.join(artifacts, 'harness.ts'), await readFile(import.meta.filename));
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(root, `test-results/${reportName}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
