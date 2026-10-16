import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const bridgeOwner = process.argv.includes('--bridge-owner');
const monitor = process.argv.includes('--monitor') || bridgeOwner, name = bridgeOwner ? 'disk-recovery-startup-bridge-owner' : monitor ? 'disk-recovery-monitor' : 'disk-recovery-startup';
const input = path.join(root, `test-results/${name}.json`), output = path.join(root, `test-results/${name}-evidence.json`);
const bytes = await readFile(input), report = JSON.parse(bytes.toString());
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
try {
  for (const key of ['passed', 'accountFree', 'actualVmTested', 'actualElectronMainKillTested', 'maintenanceEarlyCaptureTested', 'pendingStartRejected', 'pendingTerminalRejected', 'actualUiRetrySucceeded', 'canaryPreserved', 'testResourcesRemoved']) assert.equal(report[key], true, key);
  assert.equal(report.paidModelCalls, 0); assert.equal(report.physicalPowerLossTested, false); assert.equal(report.browserOrCliTested, false);
  assert.equal(report.error, undefined); assert.equal(report.cleanupError, undefined);
  const artifacts = report.artifactsDirectory;
  assert.equal(path.dirname(artifacts), path.join(root, 'test-results')); assert.match(path.basename(artifacts), new RegExp(`^${name}-\\d+$`));
  assert.deepEqual(report, JSON.parse(await readFile(path.join(artifacts, 'report.json'), 'utf8')));
  assert.deepEqual((await readdir(artifacts)).filter(file => file !== 'report.json').sort(), Object.keys(report.artifacts).sort());
  for (const [file, expected] of Object.entries(report.artifacts)) { assert.equal(path.basename(file), file); assert.equal(hash(await readFile(path.join(artifacts, file))), expected, file); }
  for (const file of ['verify-disk-recovery-startup.ts', 'disk-recovery-fault-worker.ts', 'claude-local-fixture.ts', 'packet-capture.ts', ...(monitor ? ['disk-recovery-late-start-worker.ts'] : [])]) {
    assert.equal(hash(await readFile(path.join(root, 'scripts', file))), hash(await readFile(path.join(artifacts, `source-${file}`))), file);
  }
  const bundle = path.join(root, `release/${bridgeOwner ? 'bridge-owner-candidate' : monitor ? 'disk-recovery-monitor-candidate' : 'disk-recovery-candidate'}/mac-arm64/MuCodeSandbox.app`); assert.equal(report.bundle, bundle);
  const appRoot = path.join(bundle, 'Contents/Resources/app');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]); assert.match(signature, /Signature=adhoc/);
  assert.equal(report.cdHash, bridgeOwner ? '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3' : monitor ? 'b3b92b627f33d1b810011558fa4ba0c18cddd934' : 'e1caee59d8049dccf71e42c2e37bf62518d2d05a'); assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], report.cdHash);
  const files = ['desktop/main.cjs', ...(await readdir(path.join(appRoot, 'dist-server/server'))).filter(file => file.endsWith('.js')).map(file => `dist-server/server/${file}`)];
  assert.deepEqual(Object.keys(report.modules).sort(), files.sort());
  for (const file of files) { assert.equal(hash(await readFile(path.join(appRoot, file))), report.modules[file], file); assert.equal(hash(await readFile(path.join(root, file))), report.modules[file], file); }
  if (bridgeOwner) {
    assert.equal(report.inputsUnchanged, true); assert.deepEqual(report.initialModules, report.modules); assert.equal(files.length, 46);
    for (const [file, digest] of Object.entries(report.initialSources)) assert.equal(hash(await readFile(path.join(artifacts, `source-${file}`))), digest);
    assert.deepEqual(report.requests.map((row: any) => [row.name, row.allowed, row.before, row.after]), [
      ['initial-task', true, 0, 1], ['maintenance-closed', false, 1, 1], ['recovered-task', true, 1, 2] ]);
    assert.equal(report.businessRequests, 2); assert.ok(report.requests.every((row: any) => row.directBypassRejected));
  }
  assert.ok(Number.isInteger(report.electronPid) && report.electronPid > 0); assert.deepEqual(report.electronExit, { code: null, signal: 'SIGKILL' });
  assert.ok(Date.parse(report.journalObservedAt) >= Date.parse(report.startedAt) && Date.parse(report.journalObservedAt) < Date.parse(report.finishedAt));
  assert.ok(report.reopenObservations.length > 0); assert.equal(report.reopenObservations.at(-1).status, 'Stopped');
  assert.ok(Date.parse(report.reopenObservations.at(-1).at) - Date.parse(report.reopenObservations[0].at) <= 30_000);
  for (const observation of report.reopenObservations) { assert.equal(observation.startStatus, 409); assert.equal(observation.terminalStatus, 409); }
  if (monitor) {
    const late = report.lateStart; assert.equal(late.passed, true); assert.equal(late.runningObserved, true); assert.equal(late.stoppedWithoutUiPolling, true);
    assert.ok(Number.isInteger(late.monitorTicks) && late.monitorTicks > 0); assert.equal(late.leaseRenewals, 0);
    assert.equal(late.compiled, path.join(appRoot, 'dist-server/server')); assert.deepEqual(late.exit, { code: 0, signal: null });
    assert.ok(late.observations.some((row: any) => row.status === 'Running')); assert.equal(late.observations.at(-1).status, 'Stopped');
    assert.ok(late.observations.at(-1).elapsedMs > 0 && late.observations.at(-1).elapsedMs < 30_000);
    assert.match(late.startReplay, /^Actual Lima start after initial reconcile/);
  }
  const sealed = JSON.parse(await readFile(path.join(artifacts, 'electron-kill-journal.json'), 'utf8')); assert.match(sealed.mac, /^[a-f0-9]{64}$/);
  const journal = JSON.parse(sealed.body); assert.equal(journal.version, 1); assert.equal(journal.stage, 'pending'); assert.equal(journal.originalDiskGiB, 10); assert.equal(journal.targetGiB, 12);
  assert.equal(report.maintenanceWorker.checkpoint, 'before-filesystem'); assert.equal(report.maintenanceWorker.compiled, path.join(appRoot, 'dist-server/server'));
  assert.ok(report.maintenanceWorker.pid > 0 && report.maintenanceWorker.pid !== report.electronPid); assert.deepEqual(report.maintenanceWorkerExit, { code: null, signal: 'SIGKILL' });
  assert.equal(report.maintenanceConfiguration.disk, '12GiB'); assert.equal(report.maintenanceConfiguration.vmType, 'vz');
  for (const field of ['mounts', 'provision', 'probes']) assert.deepEqual(report.maintenanceConfiguration[field], []);
  assert.equal(report.maintenanceProtection.integrity, 'verified'); assert.equal(report.maintenanceProtection.leaseActive, false); assert.equal(report.maintenanceProtection.firewallActive, true);
  const units = ['mucodesandbox-boot-capture.service', 'mucodesandbox-egress.service', 'mucodesandbox-lease.service', 'systemd-networkd.service'];
  assert.deepEqual(Object.keys(report.ordering).sort(), units.sort());
  for (const unit of units) {
    const text = await readFile(path.join(artifacts, `${unit}.txt`), 'utf8');
    const actual = Object.fromEntries(text.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    assert.deepEqual(actual, report.ordering[unit]); assert.equal(actual.ActiveState, 'active');
  }
  const network = report.ordering['systemd-networkd.service'], start = Number(network.ExecMainStartTimestampMonotonic); assert.ok(Number.isFinite(start) && start > 0);
  for (const unit of ['mucodesandbox-boot-capture.service', 'mucodesandbox-egress.service', 'mucodesandbox-lease.service']) {
    const active = Number(report.ordering[unit].ActiveEnterTimestampMonotonic); assert.ok(Number.isFinite(active) && active > 0 && active < start, unit);
  }
  for (const unit of ['mucodesandbox-boot-capture.service', 'mucodesandbox-egress.service']) {
    assert.ok(network.After.split(' ').includes(unit)); assert.ok(network.Requires.split(' ').includes(unit));
  }
  assert.deepEqual(report.captures.map((c: any) => c.name), ['initial-boot', 'initial-task', 'maintenance-boot', 'maintenance-closed', 'recovered-boot', 'recovered-task']);
  const boots = new Set<string>(), captures = [];
  for (const c of report.captures) {
    const file = path.join(artifacts, `${c.name}.pcap`), data = await readFile(file);
    assert.ok(data.length >= 24); assert.equal(data.length, c.bytes); assert.equal(hash(data), c.sha256);
    assert.match(c.gateway, /^\d+\.\d+\.\d+\.\d+$/); assert.ok(Number.isInteger(c.proxyPort) && c.proxyPort > 0 && c.proxyPort <= 65535);
    const allowed = `${bridgeOwner ? '' : `(tcp and dst host ${c.gateway} and dst port ${c.proxyPort}) or `}(tcp and src port 22 and dst host ${c.gateway}) or (udp and src port 68 and dst port 67)`;
    const physicalOut = (await packetLines(file, 'ifindex 2 and outbound and (ip or ip6)')).length;
    const approvedProxy = (await packetLines(file, `ifindex 2 and outbound and tcp and dst host ${c.gateway} and dst port ${c.proxyPort}`)).length;
    const approvedSsh = (await packetLines(file, `ifindex 2 and outbound and tcp and src port 22 and dst host ${c.gateway}`)).length;
    const unapproved = (await packetLines(file, `ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`)).length;
    assert.equal(physicalOut, c.physicalOut); assert.equal(approvedProxy, c.approvedProxy); assert.equal(unapproved, c.unapproved); assert.equal(unapproved, 0);
    if (c.name.endsWith('-boot')) { assert.ok(physicalOut > 0); assert.match(c.bootId, /^[a-f0-9-]{36}$/); assert.equal(c.bootId, c.capturedBootId); boots.add(c.bootId); }
    if (c.name.startsWith('maintenance-')) assert.equal(approvedProxy, 0);
    if (bridgeOwner) { assert.equal(approvedProxy, 0); assert.equal(approvedSsh, c.approvedSsh); assert.ok(approvedSsh > 0); }
    else if (c.name.endsWith('-task')) assert.ok(approvedProxy > 0);
    captures.push({ name: c.name, physicalOut, approvedProxy, approvedSsh, unapproved });
  }
  assert.equal(boots.size, 3);
  const evidence = { passed: true, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), cdHash: report.cdHash,
    verifierSha256: hash(await readFile(import.meta.filename)), packetReaderSha256: hash(await readFile(path.join(root, 'scripts/packet-capture.ts'))),
    actualElectronMainKillTested: true, automaticLateStartStopTested: monitor,
    ...(monitor ? { lateStartStoppedAfterMs: report.lateStart.observations.at(-1).elapsedMs, lateStartMonitorTicks: report.lateStart.monitorTicks } : {}),
    captureAndGuardsActiveBeforeNetworkd: true, distinctBoots: boots.size, captures, testResourcesRemoved: true,
    scope: `${monitor ? 'Also validates actual late Lima startup stopped by the frozen Manager timer without Electron/API/UI polling; no separate capture of that interval. ' : ''}Read-only audit of actual Electron SIGKILL immediately after pending journal publication, real maintenance boot captured before systemd-networkd using a paused frozen-package worker, closed task network, actual UI retry and preserved canary; six raw captures; not physical power loss, hypervisor-wide packet capture, browser/CLI, long-term, real residential line or second-Mac acceptance` };
  await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 }); console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  const failed = { passed: false, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), error: error instanceof Error ? error.stack : String(error) };
  await writeFile(output, JSON.stringify(failed, null, 2), { mode: 0o600 }); console.error(JSON.stringify(failed, null, 2)); process.exitCode = 1;
}
