import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const bridgeOwner = process.argv.includes('--bridge-owner');
const reportName = bridgeOwner ? 'shared-mounts-migration-bridge-owner' : 'shared-mounts-migration-latest';
const input = path.join(root, `test-results/${reportName}.json`);
const bytes = await readFile(input), report = JSON.parse(bytes.toString());
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const output = path.join(root, `test-results/${reportName}-evidence.json`);
const artifact = (file: string) => {
  const absolute = path.resolve(root, file);
  assert.ok(absolute.startsWith(path.join(root, 'test-results/shared-mount/')));
  return absolute;
};
try {
  assert.equal(report.passed, true); assert.equal(report.latestPackageTested, true);
  if (bridgeOwner) assert.equal(report.bridgeOwnerPackageTested, true);
  assert.equal(report.packaged, true); assert.equal(report.electronDesktopUiTested, false);
  assert.equal(report.accountFree, true); assert.equal(report.paidModelCalls, 0);
  assert.equal(report.productionConfigurationChanged, false);
  assert.equal(report.compilerInstalled, false); assert.equal(report.smallIdentityProbeReused, true);
  assert.equal(report.vmRemoved, true); assert.equal(report.temporaryDataRemoved, true);
  assert.equal(report.cleanupError, undefined);
  const bundle = path.join(root, `release/${bridgeOwner ? 'bridge-owner-candidate' : 'boot-capture-candidate'}/mac-arm64/MuCodeSandbox.app`);
  const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
  assert.equal(report.bundle, bundle); assert.equal(report.migrationWorkerCompiledRoot, compiled);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
  assert.match(signature, /Signature=adhoc/);
  assert.equal(report.packageCdHash, bridgeOwner ? '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3' : 'b0cd06dd921a9ba759336fb39c8cb6e40e22fde4');
  assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], report.packageCdHash);
  const sources = ['scripts/verify-shared-mounts.ts', 'scripts/shared-migration-worker.ts', 'server/guest-mounts.ts',
    'server/lima-config.ts', 'server/runtime.ts', 'server/manager.ts', 'server/snapshots.ts', 'native/probes/shared-mount-id.c'];
  assert.deepEqual(report.inputs.map((entry: any) => entry.file).sort(), sources.sort());
  for (const entry of report.inputs) {
    assert.equal(hash(await readFile(path.join(root, entry.file))), entry.sha256);
    assert.equal(hash(await readFile(artifact(entry.snapshot))), entry.sha256);
  }
  const files = (await readdir(compiled)).filter(file => file.endsWith('.js')).sort();
  if (bridgeOwner) assert.equal(files.length, 45);
  assert.deepEqual(report.packagedInputs.map((entry: any) => entry.file).sort(), files);
  for (const entry of report.packagedInputs) {
    assert.equal(hash(await readFile(path.join(compiled, entry.file))), entry.sha256);
    assert.equal(hash(await readFile(path.join(root, 'dist-server/server', entry.file))), entry.sha256);
    assert.equal(hash(await readFile(artifact(entry.snapshot))), entry.sha256);
  }
  const elf = await readFile(artifact(report.executableSnapshot));
  assert.equal(hash(elf), '3bbb4224e1ab805b90938c789c98e02f276160d6fdd1b936be0f0f08fdfa2c7f');
  assert.equal(report.executableSha256, hash(elf)); assert.equal(elf.readUInt16LE(18), 183);
  assert.equal(report.sourceSha256, '4f3735b86348a36827f9a8b391923957bd6bbf93dd68b5a97d79283e67aca8d1');
  const unsafeBytes = await readFile(artifact(report.legacyConfigurationSnapshot));
  assert.equal(hash(unsafeBytes), report.legacyConfigurationSha256);
  const unsafe = parse(unsafeBytes.toString());
  assert.equal(unsafe.mountType, 'virtiofs'); assert.equal(unsafe.mounts.length, 2);
  assert.ok(unsafe.provision.every((entry: any) => entry.mode !== 'boot'));
  const current = parse(await readFile(artifact(report.configurationSnapshot), 'utf8'));
  assert.ok(current.provision.some((entry: any) => entry.mode === 'boot'));
  assert.notEqual(report.devUid, report.controlUid); assert.notEqual(report.devUid, 0);
  assert.equal(report.legacyMetadata, `${report.controlUid}:${report.controlUid} 4755`);
  assert.equal(report.legacyUnsafeIdentity, `${report.devUid} ${report.controlUid} 0`);
  assert.equal(report.legacyMountInfo.length, 2);
  assert.ok(report.legacyMountInfo.some((line: string) => !line.split(' ')[5].split(',').includes('nosuid')));
  assert.equal(report.actualMigrationProcessKilled, true); assert.equal(report.workerExit.signal, 'SIGKILL');
  assert.equal(report.pendingMaintenanceAccessRejected, true); assert.equal(report.interruptedMaintenanceQuarantined, true);
  assert.deepEqual(report.interruptedMaintenanceMountInfo, []);
  for (const migration of [report.migration, report.snapshotMigration]) {
    assert.equal(migration.stage, 'completed'); assert.deepEqual(migration.maintenanceSources, []);
  }
  assert.equal(report.nativeDataPreserved, true); assert.equal(report.snapshotRevokedHostTrust, true);
  assert.equal(report.snapshotAutomaticMigrationPassed, true); assert.equal(typeof report.legacySnapshotId, 'string');
  assert.deepEqual(report.stages.map((stage: any) => stage.stage), ['post-snapshot-restore', 'reboot']);
  for (const stage of report.stages) {
    assert.deepEqual(stage.mountCheck.issues, []); assert.equal(stage.bootObservation.length, 2);
    assert.ok(stage.bootObservation.every((mount: any) => !mount.alreadyMounted || ['nosuid', 'nodev'].every(flag => mount.previousOptions.split(',').includes(flag))));
    assert.equal(stage.mountInfo.length, 2);
    assert.ok(stage.mountInfo.every((line: string) => ['nosuid', 'nodev'].every(flag => line.split(' ')[5].split(',').includes(flag))));
    assert.equal(stage.identity, `${report.devUid} ${report.devUid} 0`); assert.equal(stage.readonlyIdentity, stage.identity);
    assert.equal(stage.secondaryIdentity, `${report.secondaryProbeUid} ${report.secondaryProbeUid} 0`);
    assert.equal(stage.unrestrictedSudoDenied, true);
  }
  const positive = report.stages[0];
  assert.equal(positive.unprotectedDevIdentity, `${report.devUid} ${report.controlUid} 0`);
  assert.equal(positive.restoredPositiveIdentity, `${report.devUid} ${report.devUid} 0`);
  const positiveUid = Number(positive.positiveMetadata.split(':')[0]);
  assert.notEqual(positiveUid, report.secondaryProbeUid);
  assert.equal(positive.unprotectedPositiveIdentity, `${report.secondaryProbeUid} ${positiveUid} 0`);
  assert.equal(report.approvedInstallerWorks, true); assert.equal(report.unsafePersistentPolicyAccessRejected, true);
  assert.equal(report.persistentPolicyRestored, true);
  const evidence = { passed: true, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes),
    packageCdHash: report.packageCdHash, compiledModulesVerified: files.length, sourcesAndSnapshotsVerified: true,
    unsafeBaselineAndEffectiveIdentityControlsVerified: true, migrationInterruptionAndSnapshotRollbackVerified: true,
    temporaryResourcesRemoved: true, accountFree: true, paidModelCalls: 0,
    verifierSha256: hash(await readFile(path.join(root, 'scripts/verify-shared-migration-evidence.ts'))),
    scope: 'Saved real VM migration observations using packaged modules under Node; no Electron UI or physical network acceptance' };
  await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 }); console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  const failed = { passed: false, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), error: (error as Error).stack };
  await writeFile(output, JSON.stringify(failed, null, 2), { mode: 0o600 }); console.error(JSON.stringify(failed, null, 2)); process.exitCode = 1;
}
