import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Manager as SourceManager } from '../server/manager.ts';
import { LimaRuntime as SourceRuntime } from '../server/runtime.ts';
import { buildLimaConfig } from '../server/lima-config.ts';
import { inspectSharedMountsScript, parseSharedMountInspection } from '../server/guest-mounts.ts';
import { PREPARE_DEVELOPER_SCRIPT } from '../server/guest-privileges.ts';
import { identityScript } from '../server/network-guard.ts';
import { parse, stringify } from 'yaml';
import type { Job } from '../shared/types.ts';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const bridgeOwner = process.argv.includes('--bridge-owner');
const latest = bridgeOwner || process.argv.includes('--latest');
assert.ok(!(bridgeOwner && process.argv.includes('--latest')), 'Choose one frozen package');
const packaged = latest || process.argv.includes('--packaged');
const bundle = latest ? path.join(root, `release/${bridgeOwner ? 'bridge-owner-candidate' : 'boot-capture-candidate'}/mac-arm64/MuCodeSandbox.app`) : path.resolve(process.env.MU_PACKAGED_APP ?? path.join(root, 'release/shared-mount-candidate/mac-arm64/MuCodeSandbox.app'));
const migrationReportName = bridgeOwner ? 'shared-mounts-migration-bridge-owner' : 'shared-mounts-migration-latest';
const compiledRoot = path.join(bundle, 'Contents/Resources/app/dist-server/server');
const Manager: typeof SourceManager = packaged ? (await import(pathToFileURL(path.join(compiledRoot, 'manager.js')).href)).Manager : SourceManager;
const LimaRuntime: typeof SourceRuntime = packaged ? (await import(pathToFileURL(path.join(compiledRoot, 'runtime.js')).href)).LimaRuntime : SourceRuntime;
const legacy = process.argv.includes('--legacy');
const migrationFault = process.argv.includes('--migration-fault');
const snapshotRollback = process.argv.includes('--snapshot-rollback');
assert.ok(!migrationFault || legacy);
assert.ok(!snapshotRollback || legacy);
assert.ok(!packaged || !migrationFault || latest, 'Packaged migration faults require the fixed latest package');
assert.ok(!latest || (legacy && migrationFault && snapshotRollback), 'Latest acceptance covers legacy interruption and snapshot rollback together');
const data = await mkdtemp(path.join(homedir(), latest ? '.mu-smig-' : '.mu-shared-mount-test-'));
const share = await mkdtemp(path.join(homedir(), '.mu-shared-mount-fixture-')); await chmod(share, 0o755);
const results = path.join(root, 'test-results/shared-mount'); await mkdir(results, { recursive: true, mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const manager = new Manager(data, undefined, new LimaRuntime(data));
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), accountFree: true,
  paidModelCalls: 0, scope: legacy ? 'Actual unsafe legacy shared-mount baseline, no-export maintenance migration, interrupted-process recovery and protected reboot; no network or browser acceptance' : 'Fresh VM shared-directory identity, readonly and reboot protections; no network or browser acceptance',
  productionConfigurationChanged: false, legacyMigration: legacy, migrationFault, snapshotRollback, packaged, latestPackageTested: latest, bridgeOwnerPackageTested: bridgeOwner, electronDesktopUiTested: false, stages: [] };
if (snapshotRollback) report.scope = 'Actual unsafe legacy disk restored from offline snapshot, stale host approval invalidation, automatic no-export migration and protected reboot; no network or browser acceptance';
const e = await manager.create({ name: 'Shared mount isolation test', cpus: 2, memoryGiB: 2, diskGiB: 10,
  mounts: [{ id: randomUUID(), hostPath: share, guestPath: '/workspace/project space', writable: true },
    { id: randomUUID(), hostPath: share, guestPath: '/workspace/readonly', writable: false }],
  identity: { timezone: 'UTC', locale: 'en-US' } });
report.instanceName = e.instanceName;
async function finish(job: Job) {
  if (latest) { const free = await statfs(data); assert.ok(free.bavail * free.bsize > 80 * 2 ** 30, 'Insufficient disk reserve'); }
  await manager.tasks.get(job.id)?.promise;
  const done = manager.store.jobs().find(row => row.id === job.id)!;
  if (done.status !== 'succeeded') report.logs = manager.store.logs(e.id).slice(-30);
  assert.equal(done.status, 'succeeded', done.message);
}
const guest = (command: string[]) => manager.runtime.guest(manager.store.get(e.id), command, { timeoutMs: 30_000 });
const control = (command: string[], input?: string) => manager.runtime.management(manager.store.get(e.id), command, { input, timeoutMs: 120_000 });
const digest = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
try {
  if (latest) {
    const free = await statfs(data); assert.ok(free.bavail * free.bsize > 100 * 2 ** 30);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    report.packageCdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1];
    assert.equal(report.packageCdHash, bridgeOwner ? '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3' : 'b0cd06dd921a9ba759336fb39c8cb6e40e22fde4');
  }
  const snapshot = `${report.startedAt.replace(/[:.]/g, '-')}-config.yaml`;
  await writeFile(path.join(results, snapshot), buildLimaConfig(e), { mode: 0o600 });
  report.configurationSnapshot = path.relative(root, path.join(results, snapshot));
  await copyFile(path.join(root, 'native/probes/shared-mount-id.c'), path.join(share, 'probe.c'));
  report.sourceSha256 = digest(await readFile(path.join(share, 'probe.c')));
  console.log('Starting fresh VM with read/write and readonly protected shares');
  const inputs = path.join(results, `${report.startedAt.replace(/[:.]/g, '-')}-inputs`); await mkdir(inputs, { mode: 0o700 });
  report.inputs = [];
  for (const file of ['scripts/verify-shared-mounts.ts', 'scripts/shared-migration-worker.ts', 'server/guest-mounts.ts', 'server/lima-config.ts', 'server/runtime.ts', 'server/manager.ts', 'server/snapshots.ts', 'native/probes/shared-mount-id.c']) {
    const bytes = await readFile(path.join(root, file)); const target = path.join(inputs, file.replaceAll('/', '_'));
    await writeFile(target, bytes, { mode: 0o600, flag: 'wx' }); report.inputs.push({ file, sha256: digest(bytes), snapshot: path.relative(root, target) });
  }
  if (packaged) {
    report.bundle = bundle; report.packagedInputs = [];
    for (const file of latest ? (await readdir(compiledRoot)).filter(file => file.endsWith('.js')).sort() : ['manager.js', 'runtime.js', 'lima-config.js', 'guest-mounts.js', 'snapshots.js', 'store.js', 'validation.js']) {
      const bytes = await readFile(path.join(compiledRoot, file)); const target = path.join(inputs, `packaged-${file}`);
      await writeFile(target, bytes, { mode: 0o600, flag: 'wx' }); report.packagedInputs.push({ file, sha256: digest(bytes), snapshot: path.relative(root, target) });
    }
    const compiled = await import(pathToFileURL(path.join(compiledRoot, 'lima-config.js')).href);
    assert.equal(compiled.buildLimaConfig(e), buildLimaConfig(e), 'Legacy fixture must match the actual compiled recipe');
  }
  if (legacy) {
    const configuration = parse(buildLimaConfig(e)); configuration.provision = configuration.provision.filter((p: any) => p.mode !== 'boot');
    const file = path.join(data, 'legacy.yaml'); await writeFile(file, stringify(configuration), { mode: 0o600 });
    const capturedConfiguration = path.join(inputs, 'unsafe-legacy.yaml'); await copyFile(file, capturedConfiguration);
    report.legacyConfigurationSnapshot = path.relative(root, capturedConfiguration); report.legacyConfigurationSha256 = digest(await readFile(file));
    await manager.runtime.command(['start', '--name', e.instanceName, '--timeout', '15m', file], { timeoutMs: 950_000 });
    manager.store.save({ ...manager.store.get(e.id), state: 'running' });
    await control(['bash', '-s'], PREPARE_DEVELOPER_SCRIPT);
    await control(['bash', '-s'], identityScript(e));
  } else await finish(await manager.lifecycle(e.id, 'start'));
  report.devUid = Number((await guest(['id', '-u'])).trim());
  report.controlUid = Number((await control(['id', '-u'])).trim());
  report.secondaryProbeUid = Number((await control(['id', '-u', 'nobody'])).trim());
  assert.notEqual(report.devUid, report.controlUid); assert.notEqual(report.devUid, 0);
  let binary: Buffer;
  if (latest) {
    console.log('Reusing the verified small identity probe without installing a compiler');
    binary = await readFile(path.join(root, 'test-results/shared-mount/2026-10-10T05-59-01-667Z-inputs/identity-probe.elf'));
    assert.equal(digest(binary), '3bbb4224e1ab805b90938c789c98e02f276160d6fdd1b936be0f0f08fdfa2c7f');
    assert.equal(report.sourceSha256, '4f3735b86348a36827f9a8b391923957bd6bbf93dd68b5a97d79283e67aca8d1');
    await writeFile(path.join(share, 'probe'), binary, { mode: 0o755 });
    report.compilerInstalled = false; report.smallIdentityProbeReused = true;
  } else {
    console.log('Installing the account-free identity test compiler');
    await control(['bash', '-s'], 'set -eu\nsudo apt-get update -qq\nsudo apt-get install -y --no-install-recommends gcc libc6-dev\n');
    await guest(['gcc', '-Wall', '-Wextra', '-Werror', '/workspace/project space/probe.c', '-o', '/workspace/project space/probe']);
    binary = await readFile(path.join(share, 'probe'));
  }
  await manager.runtime.guest(manager.store.get(e.id), ['mu-install', 'git'], { timeoutMs: 120_000 });
  report.approvedInstallerWorks = true;
  assert.equal(binary.subarray(0, 4).toString('hex'), '7f454c46'); assert.equal(binary.readUInt16LE(18), 183);
  report.executableSha256 = digest(binary);
  await writeFile(path.join(inputs, 'identity-probe.elf'), binary, { mode: 0o600, flag: 'wx' });
  report.executableSnapshot = path.relative(root, path.join(inputs, 'identity-probe.elf'));
  if (legacy) {
    const supplied = path.join(share, 'legacy-positive');
    await writeFile(supplied, binary, { mode: 0o700, flag: 'wx' }); await chmod(supplied, 0o4755);
    report.legacyMetadata = (await control(['stat', '-c', '%u:%g %a', '/workspace/project space/legacy-positive'])).trim();
    assert.equal(report.legacyMetadata, `${report.controlUid}:${report.controlUid} 4755`);
    report.legacyUnsafeIdentity = (await guest(['/workspace/project space/legacy-positive'])).trim();
    assert.equal(report.legacyUnsafeIdentity, `${report.devUid} ${report.controlUid} 0`);
    report.legacyMountInfo = (await control(['cat', '/proc/self/mountinfo'])).split('\n').filter(line => line.includes(' - virtiofs '));
    await guest(['python3', '-c', "open('/home/dev/migration-canary','w').write('native-data-preserved')"]);
    await finish(await manager.lifecycle(e.id, 'stop'));
    let unsafeSnapshot: string | undefined;
    if (snapshotRollback) {
      // The config has the new boot provision, while the saved disk still has
      // the legacy unprotected mount policy. Stale host approval must not skip maintenance.
      await writeFile(path.join(manager.runtime.limaHome, e.instanceName, 'lima.yaml'), buildLimaConfig(e), { mode: 0o600 });
      await manager.snapshots.create(manager.store.get(e.id), 'Legacy unsafe disk with current boot config');
      unsafeSnapshot = (await manager.snapshots.list(e))[0].id;
      report.legacySnapshotId = unsafeSnapshot;
    }
    if (migrationFault) {
      console.log('Starting owned migration process for actual SIGKILL test');
      const worker = spawn(process.execPath, [path.join(root, 'scripts/shared-migration-worker.ts'), data, e.id, ...(latest ? [bundle] : [])], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let workerLogs = '';
      worker.stdout!.on('data', chunk => { workerLogs = (workerLogs + chunk).slice(-4000); });
      worker.stderr!.on('data', chunk => { workerLogs = (workerLogs + chunk).slice(-4000); });
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => worker.once('close', (code, signal) => resolve({ code, signal })));
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Migration worker readiness timed out')), 120_000);
          worker.once('error', error => { clearTimeout(timer); reject(error); });
          worker.once('exit', () => { clearTimeout(timer); reject(new Error('Migration worker exited before fault checkpoint: ' + workerLogs)); });
          worker.on('message', (value: any) => {
            if (value.error) { clearTimeout(timer); reject(new Error(value.error)); }
            if (value.stage === 'maintenance-running' && value.instanceName === e.instanceName) {
              clearTimeout(timer);
              if (latest && value.compiledRoot !== compiledRoot) { reject(new Error('Migration worker did not use the latest package')); return; }
              report.migrationWorkerCompiledRoot = value.compiledRoot; resolve();
            }
          });
        });
        const listed = JSON.parse((await manager.runtime.command(['list', '--json'])).trim());
        assert.equal(listed.status, 'Running'); assert.equal(listed.config.mounts?.length ?? 0, 0);
        report.interruptedMaintenanceMountInfo = (await control(['cat', '/proc/self/mountinfo'])).split('\n').filter(line => line.includes(' - virtiofs '));
        assert.deepEqual(report.interruptedMaintenanceMountInfo, []);
        assert.equal(JSON.parse(await readFile(path.join(data, 'security', `${e.instanceName}-shares-migration.json`), 'utf8')).stage, 'pending');
        assert.ok(worker.kill('SIGKILL')); report.workerExit = await exited;
        assert.equal(report.workerExit.signal, 'SIGKILL'); report.actualMigrationProcessKilled = true;
        manager.store.state(e.id, 'running');
        await assert.rejects(manager.assertAccess(e.id), { code: 'SHARED_MOUNT_MIGRATION_PENDING' });
        await Promise.all([...manager.quarantines.values()]);
        report.pendingMaintenanceAccessRejected = true;
        assert.equal((await manager.runtime.list()).find(row => row.name === e.instanceName)?.status, 'Stopped');
        report.interruptedMaintenanceQuarantined = true;
      } finally { if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await exited; } }
    }
    await finish(await manager.lifecycle(e.id, 'start'));
    report.migration = JSON.parse(await readFile(path.join(data, 'security', `${e.instanceName}-shares-migration.json`), 'utf8'));
    delete report.migration.original;
    assert.equal(report.migration.stage, 'completed'); assert.deepEqual(report.migration.maintenanceSources, []);
    assert.equal((await guest(['cat', '/home/dev/migration-canary'])).trim(), 'native-data-preserved');
    report.nativeDataPreserved = true;
    if (unsafeSnapshot) {
      await finish(await manager.lifecycle(e.id, 'stop'));
      const approval = path.join(data, 'security', `${e.instanceName}-shares.json`);
      const migration = path.join(data, 'security', `${e.instanceName}-shares-migration.json`);
      assert.ok(JSON.parse(await readFile(approval, 'utf8')).recipe);
      await manager.snapshots.restore(manager.store.get(e.id), unsafeSnapshot);
      for (const file of [approval, migration]) await assert.rejects(readFile(file), { code: 'ENOENT' });
      report.snapshotRevokedHostTrust = true;
      await finish(await manager.lifecycle(e.id, 'start'));
      report.snapshotMigration = JSON.parse(await readFile(migration, 'utf8')); delete report.snapshotMigration.original;
      assert.equal(report.snapshotMigration.stage, 'completed');
      assert.deepEqual(report.snapshotMigration.maintenanceSources, []);
      assert.equal((await guest(['cat', '/home/dev/migration-canary'])).trim(), 'native-data-preserved');
      report.snapshotAutomaticMigrationPassed = true;
    }
  }
  for (const stage of [snapshotRollback ? 'post-snapshot-restore' : legacy ? 'post-migration' : 'first-boot', 'reboot']) {
    console.log('Measuring ' + stage);
    if (stage === 'reboot') { await finish(await manager.lifecycle(e.id, 'stop')); await finish(await manager.lifecycle(e.id, 'start')); }
    const measured: Record<string, any> = { stage }; report.stages.push(measured);
    measured.bootObservation = JSON.parse(await control(['cat', '/run/mucodesandbox-shares/boot.json']));
    assert.equal(measured.bootObservation.length, 2);
    if (stage === 'first-boot') assert.ok(measured.bootObservation.every((m: any) => !m.alreadyMounted), 'Must actually precede the first mount');
    else assert.ok(measured.bootObservation.every((m: any) => !m.alreadyMounted || ['nosuid','nodev'].every(flag => m.previousOptions.split(',').includes(flag))), 'Existing reboot mount must already be protected');
    measured.mountCheck = parseSharedMountInspection(await control(['bash', '-s'], inspectSharedMountsScript(e)));
    assert.deepEqual(measured.mountCheck.issues, []);
    measured.mountInfo = (await control(['cat', '/proc/self/mountinfo'])).split('\n').filter(row => row.includes(' - virtiofs '));
    assert.equal((await guest(['/workspace/project space/probe'])).trim(), `${report.devUid} ${report.devUid} 0`);
    const filename = `host-provided-${stage}`;
    await writeFile(path.join(share, filename), binary, { mode: 0o700, flag: 'wx' }); await chmod(path.join(share, filename), 0o4755);
    assert.equal((await stat(path.join(share, filename))).mode & 0o7777, 0o4755);
    const supplied = `/workspace/project space/${filename}`;
    measured.initialHostFileMetadata = (await control(['stat', '-c', '%u:%g %a', supplied])).trim();
    measured.metadata = (await control(['stat', '-c', '%u:%g %a', supplied])).trim();
    const [owner, mode] = measured.metadata.split(' ');
    measured.fileOwnerUid = Number(owner.split(':')[0]);
    assert.equal(measured.fileOwnerUid, report.controlUid, 'Test file must expose the control identity that development tasks cannot assume');
    assert.notEqual(measured.fileOwnerUid, report.secondaryProbeUid); assert.equal(Number.parseInt(mode, 8) & 0o4000, 0o4000);
    measured.identity = (await guest([`/workspace/project space/${filename}`])).trim();
    assert.equal(measured.identity, `${report.devUid} ${report.devUid} 0`);
    measured.readonlyIdentity = (await guest([`/workspace/readonly/${filename}`])).trim();
    assert.equal(measured.readonlyIdentity, `${report.devUid} ${report.devUid} 0`);
    measured.secondaryIdentity = (await control(['sudo', '-u', 'nobody', supplied])).trim();
    assert.equal(measured.secondaryIdentity, `${report.secondaryProbeUid} ${report.secondaryProbeUid} 0`);
    await guest(['python3', '-c', `open('/workspace/project space/write-${stage}', 'w').write('shared-write-ok')`]);
    assert.equal(await readFile(path.join(share, `write-${stage}`), 'utf8'), 'shared-write-ok');
    await assert.rejects(guest(['python3', '-c', `open('/workspace/readonly/denied-${stage}', 'w').write('must-fail')`]), /Read-only file system/);
    await assert.rejects(guest(['sudo', '-n', 'true'])); measured.unrestrictedSudoDenied = true;
    if (stage !== 'reboot') {
      try {
        await control(['sudo', 'mount', '-o', 'remount,rw,suid,nodev', '/workspace/project space']);
        measured.unprotectedMountInfo = (await control(['cat', '/proc/self/mountinfo'])).split('\n').filter(row => row.includes(' /workspace/project\\040space '));
        assert.equal(measured.unprotectedMountInfo.length, 1);
        assert.ok(!measured.unprotectedMountInfo[0].split(' ')[5].split(',').includes('nosuid'));
        const positive = path.join(share, 'host-provided-positive');
        await writeFile(positive, binary, { mode: 0o700, flag: 'wx' }); await chmod(positive, 0o4755);
        const positiveGuest = '/workspace/project space/host-provided-positive';
        measured.positiveMetadata = (await control(['stat', '-c', '%u:%g %a', positiveGuest])).trim();
        const [positiveOwner, positiveMode] = measured.positiveMetadata.split(' ');
        assert.equal(Number.parseInt(positiveMode, 8) & 0o4000, 0o4000);
        const positiveUid = Number(positiveOwner.split(':')[0]); assert.notEqual(positiveUid, report.secondaryProbeUid);
        measured.unprotectedPositiveIdentity = (await control(['sudo', '-u', 'nobody', positiveGuest])).trim();
        assert.equal(measured.unprotectedPositiveIdentity, `${report.secondaryProbeUid} ${positiveUid} 0`);
        measured.unprotectedDevIdentity = (await guest([positiveGuest])).trim();
        assert.equal(measured.unprotectedDevIdentity, `${report.devUid} ${report.controlUid} 0`);
      } finally { await control(['sudo', 'mount', '-o', 'remount,rw,nosuid,nodev', '/workspace/project space']); }
      assert.deepEqual(parseSharedMountInspection(await control(['bash', '-s'], inspectSharedMountsScript(e))).issues, []);
      assert.equal((await guest([supplied])).trim(), `${report.devUid} ${report.devUid} 0`);
      assert.equal((await control(['sudo', '-u', 'nobody', supplied])).trim(), `${report.secondaryProbeUid} ${report.secondaryProbeUid} 0`);
      measured.restoredPositiveIdentity = (await guest(['/workspace/project space/host-provided-positive'])).trim();
      assert.equal(measured.restoredPositiveIdentity, `${report.devUid} ${report.devUid} 0`);
    }
    await chmod(path.join(share, filename), 0o755);
  }
  console.log('Checking persistent policy failure and restoration');
  const unit = (await control(['systemd-escape', '--path', '--suffix=mount', '/workspace/readonly'])).trim();
  const policy = `/etc/systemd/system/${unit}.d/mucodesandbox.conf`;
  try {
    await control(['sudo', 'chmod', '0666', policy]);
    report.unsafePersistentPolicy = parseSharedMountInspection(await control(['bash', '-s'], inspectSharedMountsScript(e)));
    assert.ok(report.unsafePersistentPolicy.issues.some((issue: string) => issue.includes('unsafe persistent mount policy')));
    await assert.rejects(manager.runtime.start(manager.store.get(e.id), {}), { code: 'SHARED_MOUNT_UNSAFE' });
    report.unsafePersistentPolicyAccessRejected = true;
  } finally { await control(['sudo', 'chmod', '0644', policy]); }
  assert.deepEqual(parseSharedMountInspection(await control(['bash', '-s'], inspectSharedMountsScript(e))).issues, []);
  report.persistentPolicyRestored = true;
  for (const entry of report.inputs) assert.equal(digest(await readFile(path.join(root, entry.file))), entry.sha256, 'Source changed during acceptance');
  for (const entry of report.packagedInputs ?? []) assert.equal(digest(await readFile(path.join(compiledRoot, entry.file))), entry.sha256, 'Package changed during acceptance');
  report.passed = true;
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
finally {
  try { await finish(await manager.lifecycle(e.id, 'stop')); await finish(await manager.lifecycle(e.id, 'delete')); report.vmRemoved = true; }
  catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
  await manager.close();
  if (report.vmRemoved) { await rm(data, { recursive: true }); await rm(share, { recursive: true }); report.temporaryDataRemoved = true; }
  report.finishedAt = new Date().toISOString(); const bytes = JSON.stringify(report, null, 2);
  await writeFile(path.join(root, latest ? `test-results/${migrationReportName}.json` : `test-results/shared-mounts${legacy ? '-legacy' : ''}${migrationFault ? '-fault' : ''}${snapshotRollback ? '-snapshot' : ''}${packaged ? '-packaged' : ''}.json`), bytes, { mode: 0o600 });
  await writeFile(path.join(results, `${report.startedAt.replace(/[:.]/g, '-')}-protected.json`), bytes, { mode: 0o600, flag: 'wx' });
  console.log(bytes);
}
