import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const network = process.argv.includes('--network');
const storage = process.argv.includes('--storage');
const reserve = process.argv.includes('--reserve');
const prefix = reserve ? 'storage-capacity-reserve' : storage ? 'storage-capacity-fixed' : network ? 'storage-capacity-network' : 'storage-capacity';
const bytes = await readFile(path.join(root, `test-results/${network || storage || reserve ? prefix : 'storage-capacity-latest'}.json`));
const source = JSON.parse(bytes.toString());
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
try {
  assert.equal(source.passed, true); assert.equal(source.imageAndDataRemoved, true);
  assert.equal(source.actualVmTested, false); assert.equal(source.actualElectronUiTested, false);
  assert.equal(source.runtimeStoppedStateFixture, true); assert.equal(source.accountFree, true); assert.equal(source.paidModelCalls, 0);
  assert.deepEqual(source, JSON.parse(await readFile(path.join(source.artifacts, 'report.json'), 'utf8')));
  assert.equal(digest(await readFile(path.join(source.artifacts, 'harness.ts'))), source.harnessSha256);
  assert.equal(digest(await readFile(path.join(root, 'scripts/verify-storage-capacity.ts'))), source.harnessSha256);
  assert.equal(source.volumeLimitMiB, 512); assert.ok(source.volume.totalBytes <= 512 * 2 ** 20);
  assert.notEqual(source.volume.mountedDevice, source.volume.hostDevice);
  const attachment = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(source.artifacts, 'attachment.plist')]));
  assert.deepEqual(attachment, source.volume.attachment);
  const volume = attachment['system-entities'].find((entry: any) => entry['mount-point']);
  assert.equal(volume['volume-kind'], 'apfs'); assert.match(volume['mount-point'], /^\/Users\/staff\/\.mu-capacity-[A-Za-z0-9]+\/mount$/);
  await assert.rejects(stat(path.dirname(volume['mount-point'])), { code: 'ENOENT' });
  assert.equal(source.cdHash, reserve ? '45e0b4a3475ace48909deee9155ada564fed65a3' : storage ? '62a352b635eb86c335fce0f5eb8e830f1c8d9d0e' : network ? 'cf031a2a4bbc9d55cc8b1d97e77a935b312145d2' : '26511866b6077c14947fc169a03e5496ba887a83');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source.bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', source.bundle]);
  assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], source.cdHash);
  for (const [file, hash] of Object.entries(source.modules)) assert.equal(digest(await readFile(path.join(source.bundle, 'Contents/Resources/app', file))), hash);
  assert.equal(source.phases.length, 6);
  const [healthy, low, exportFull, beforeRestore, pending, recovered] = source.phases;
  assert.equal(healthy.positiveControl, true); assert.equal(healthy.diskBytes, 32 * 2 ** 20);
  assert.ok(low.low.available < 128 * 2 ** 20);
  assert.equal(low.exportFailure.code, 'BACKUP_SPACE'); assert.equal(low.importFailure.code, 'BACKUP_SPACE');
  assert.equal(low.originalDiskPreserved, true); assert.equal(low.noPhantomEnvironment, true);
  for (const full of [exportFull.actualFull, beforeRestore.fullBeforeSnapshot, pending.restoreFill]) {
    assert.equal(full.code, 'ENOSPC'); assert.equal(full.smallestFailedWriteBytes, 4096); assert.ok(full.written > 0 && full.written < 512 * 2 ** 20);
  }
  assert.equal(exportFull.failure.code, 'ENOSPC'); assert.equal(exportFull.noPartialBackup, true); assert.equal(exportFull.originalDiskPreserved, true);
  for (const failure of [beforeRestore.snapshotFailure, beforeRestore.restoreFailure]) {
    assert.ok(['ENOSPC', 'PROCESS_FAILED'].includes(failure.code)); assert.match(failure.message, /[Nn]o space left on device/);
  }
  assert.equal(beforeRestore.currentDiskPreserved, true); assert.equal(beforeRestore.noPublishedSnapshot, true);
  if (pending.pendingRecoveryJournal) {
    assert.equal(pending.immediateRollbackCompleted, false); assert.equal(pending.startupJobNotSubmitted, true);
    assert.match(pending.startupRejection.message, /[Nn]o space left on device/);
    const journalBytes = await readFile(path.join(source.artifacts, 'pending-journal.json'));
    assert.equal(digest(journalBytes), source.pendingJournalSha256);
    const journal = JSON.parse(JSON.parse(journalBytes.toString()).body);
    assert.equal(journal.version, 2); assert.equal(journal.committed, false);
    assert.equal(journal.files.find((entry: any) => entry.key === 'disk').hash, beforeRestore.currentDiskHash);
    assert.equal(source.rollbackDiskHash, beforeRestore.currentDiskHash); assert.notEqual(source.rollbackDiskHash, source.originalDiskHash);
  } else {
    assert.equal(pending.pendingRecoveryJournal, false); assert.equal(pending.immediateRollbackCompleted, true);
    assert.equal(pending.startupJobNotSubmitted, undefined); assert.equal(source.pendingJournalSha256, undefined);
    await assert.rejects(stat(path.join(source.artifacts, 'pending-journal.json')), { code: 'ENOENT' });
  }
  assert.equal(recovered.rollbackAfterFreePreservedCurrent, true); assert.equal(recovered.subsequentRestoreAndExportPassed, true);
  assert.equal(recovered.originalDiskHash, source.originalDiskHash);
  const result = { passed: true, verifiedAt: new Date().toISOString(), reportSha256: digest(bytes), cdHash: source.cdHash,
    boundedApfsAttachmentAndCleanupVerified: true, frozenModuleAndHarnessHashesVerified: true,
    pendingJournalAndRecordedRollbackDiskHashVerified: pending.pendingRecoveryJournal,
    immediateRollbackObserved: pending.immediateRollbackCompleted,
    pendingRecoveryStartupGateTested: Boolean(pending.startupJobNotSubmitted),
    scope: 'Independent consistency review of actual capacity-test observations and retained artifacts; deleted live volume is not re-executed; no VM/UI/power-loss proof' };
  await writeFile(path.join(root, `test-results/${prefix}-evidence.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const failure = { passed: false, verifiedAt: new Date().toISOString(), reportSha256: digest(bytes), error: (error as Error).stack };
  await writeFile(path.join(root, `test-results/${prefix}-evidence.json`), JSON.stringify(failure, null, 2));
  console.error(JSON.stringify(failure, null, 2)); process.exitCode = 1;
}
