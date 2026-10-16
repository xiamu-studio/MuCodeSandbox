import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { run } from '../server/process.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const bridgeOwner = process.argv.includes('--bridge-owner');
const monitor = bridgeOwner || process.argv.includes('--monitor');
const reportName = bridgeOwner ? 'disk-recovery-faults-bridge-owner' : monitor ? 'disk-recovery-faults-monitor' : 'disk-recovery-faults';
const input = path.join(root, 'test-results', `${reportName}.json`);
const output = path.join(root, 'test-results', `${reportName}-evidence.json`);
const bytes = await readFile(input), report = JSON.parse(bytes.toString());
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
try {
  for (const key of ['passed', 'accountFree', 'actualVmTested', 'actualElectronReopenTested', 'testResourcesRemoved']) assert.equal(report[key], true, key);
  for (const key of ['physicalPowerLossTested', 'maintenanceFirstPacketTested', 'browserOrCliTested']) assert.equal(report[key], false, key);
  assert.equal(report.paidModelCalls, 0); assert.equal(report.cleanupError, undefined); assert.equal(report.error, undefined);
  if (monitor) assert.equal(report.diskRecoveryMonitorPackageTested, true);
  if(bridgeOwner)assert.equal(report.bridgeOwnerPackageTested,true);
  assert.match(report.faultProcess, /^Node worker executing frozen package Manager\/Runtime\/DiskRecovery;/);
  const artifacts = report.artifactsDirectory;
  assert.equal(path.dirname(artifacts), path.join(root, 'test-results')); assert.match(path.basename(artifacts), bridgeOwner ? /^disk-recovery-faults-bridge-owner-\d+$/ : monitor ? /^disk-recovery-faults-monitor-\d+$/ : /^disk-recovery-faults-\d+$/);
  assert.deepEqual(report, JSON.parse(await readFile(path.join(artifacts, 'report.json'), 'utf8')));
  assert.deepEqual((await readdir(artifacts)).filter(file => file !== 'report.json').sort(), Object.keys(report.artifacts).sort());
  for (const [file, digest] of Object.entries(report.artifacts)) {
    assert.equal(path.basename(file), file); assert.equal(hash(await readFile(path.join(artifacts, file))), digest, file);
  }
  for (const file of ['verify-disk-recovery-faults.ts', 'disk-recovery-fault-worker.ts', 'claude-local-fixture.ts', 'packet-capture.ts']) {
    assert.equal(hash(await readFile(path.join(root, 'scripts', file))), hash(await readFile(path.join(artifacts, `source-${file}`))), file);
  }
  if(bridgeOwner){
    assert.deepEqual(Object.keys(report.sources).sort(),['scripts/verify-disk-recovery-faults.ts','scripts/disk-recovery-fault-worker.ts','scripts/claude-local-fixture.ts','scripts/packet-capture.ts'].sort());
    for(const [file,digest] of Object.entries(report.sources))assert.equal(hash(await readFile(path.join(root,file))),digest);
  }
  const bundle = path.join(root, `release/${bridgeOwner ? 'bridge-owner-candidate' : monitor ? 'disk-recovery-monitor-candidate' : 'disk-recovery-candidate'}/mac-arm64/MuCodeSandbox.app`); assert.equal(report.bundle, bundle);
  const appRoot = path.join(bundle, 'Contents/Resources/app');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]); assert.match(signature, /Signature=adhoc/);
  assert.equal(report.cdHash, bridgeOwner ? '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3' : monitor ? 'b3b92b627f33d1b810011558fa4ba0c18cddd934' : 'e1caee59d8049dccf71e42c2e37bf62518d2d05a'); assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], report.cdHash);
  const modules = ['desktop/main.cjs', ...(await readdir(path.join(appRoot, 'dist-server/server'))).filter(file => file.endsWith('.js')).map(file => `dist-server/server/${file}`)];
  if(bridgeOwner)assert.equal(modules.length,46);
  assert.deepEqual(Object.keys(report.modules).sort(), modules.sort());
  for (const file of modules) {
    assert.equal(hash(await readFile(path.join(appRoot, file))), report.modules[file], file);
    assert.equal(hash(await readFile(path.join(root, file))), report.modules[file], file);
  }
  const points = ['before-filesystem', 'after-filesystem', 'after-database'];
  assert.deepEqual(report.phases.map((phase: any) => phase.point), points);
  const identities = new Set<string>(), processes = new Set<number>();
  for (const phase of report.phases) {
    assert.equal(phase.worker.checkpoint, phase.point); assert.equal(phase.worker.compiled, path.join(appRoot, 'dist-server/server'));
    assert.ok(Number.isInteger(phase.worker.pid) && phase.worker.pid > 0); processes.add(phase.worker.pid);
    assert.deepEqual(phase.workerExit, { code: null, signal: 'SIGKILL' });
    assert.equal(phase.installedDiskGiB, '12GiB'); assert.equal(phase.signedJournalVerified, true);
    const sealed = JSON.parse(await readFile(path.join(artifacts, `${phase.point}-journal.json`), 'utf8'));
    assert.deepEqual(Object.keys(sealed).sort(), ['body', 'mac']); assert.match(sealed.mac, /^[a-f0-9]{64}$/);
    const journal = JSON.parse(sealed.body);
    assert.equal(journal.version, 1); assert.match(journal.environmentId, /^[a-f0-9-]{36}$/); assert.match(journal.instanceName, /^mu-[a-f0-9]+$/);
    identities.add(`${journal.environmentId}/${journal.instanceName}`);
    assert.equal(journal.originalDiskGiB, 10); assert.equal(journal.targetGiB, 12);
    assert.equal(journal.stage, phase.point === 'after-database' ? 'grown' : 'pending'); assert.equal(journal.stage, phase.journalStage);
    assert.equal(parse(journal.installed).disk, '10GiB'); assert.equal(parse(journal.installed).vmType, 'vz');
    assert.equal(phase.reopenedState, 'error'); assert.equal(phase.reopenedDiskGiB, phase.point === 'after-database' ? 12 : 10);
    assert.deepEqual(phase.pendingGates, { startRejected: true, updateRejected: true, terminalRejected: true, snapshotRejected: true, stoppedAfterReopen: true });
    assert.equal(phase.actualUiRetrySucceeded, true); assert.equal(phase.canaryPreserved, true);
    assert.equal(phase.smallerSnapshot.diskGiB, 10); assert.ok(phase.smallerSnapshot.filesystem.bytes > 8 * 2 ** 30 && phase.smallerSnapshot.filesystem.bytes < 10 * 2 ** 30);
    assert.equal(phase.smallerSnapshot.filesystem.canary, 'MU_DISK_FAULT_ORIGINAL');
    if (phase.point !== 'after-database') {
      assert.deepEqual(phase.maintenanceMounts, []);
      assert.equal(phase.protection.integrity, 'verified'); assert.equal(phase.protection.firewallActive, true); assert.equal(phase.protection.leaseActive, false);
    }
  }
  assert.equal(identities.size, 1); assert.equal(processes.size, 3);
  const names = ['initial-boot', 'initial-task', ...points.flatMap(point => [
    ...(point === 'after-database' ? [] : [`${point}-closed`]), `${point}-recovered-boot`, `${point}-recovered-task`, `${point}-small-boot`,
  ])];
  assert.deepEqual(report.captures.map((capture: any) => capture.name), names);
  const boots = new Set<string>(), captures = [];
  for (const capture of report.captures) {
    const file = path.join(artifacts, `${capture.name}.pcap`), data = await readFile(file);
    assert.ok(data.length >= 24); assert.equal(data.length, capture.bytes); assert.equal(hash(data), capture.sha256);
    assert.match(capture.gateway, /^\d+\.\d+\.\d+\.\d+$/); assert.ok(Number.isInteger(capture.proxyPort) && capture.proxyPort > 0 && capture.proxyPort <= 65535);
    const allowed = `${bridgeOwner?'':`(tcp and dst host ${capture.gateway} and dst port ${capture.proxyPort}) or `}(tcp and src port 22 and dst host ${capture.gateway}) or (udp and src port 68 and dst port 67)`;
    const physicalOut = (await packetLines(file, 'ifindex 2 and outbound and (ip or ip6)')).length;
    const approvedProxy = (await packetLines(file, `ifindex 2 and outbound and tcp and dst host ${capture.gateway} and dst port ${capture.proxyPort}`)).length;
    const approvedSsh = (await packetLines(file, `ifindex 2 and outbound and tcp and src port 22 and dst host ${capture.gateway}`)).length;
    if(bridgeOwner){assert.equal(approvedProxy,0);assert.equal(approvedSsh,capture.approvedSsh);}
    const unapproved = (await packetLines(file, `ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`)).length;
    assert.equal(physicalOut, capture.physicalOut); assert.equal(approvedProxy, capture.approvedProxy); assert.equal(unapproved, capture.unapproved); assert.equal(unapproved, 0);
    if (capture.name.endsWith('-boot')) {
      assert.ok(physicalOut > 0); assert.match(capture.bootId, /^[a-f0-9-]{36}$/); boots.add(capture.bootId);
    } else {
      assert.equal(capture.bootId, undefined);
      if(bridgeOwner){
        const allowed=!capture.name.endsWith('-closed');assert.equal(capture.businessAllowed,allowed);
        assert.ok(Number.isInteger(capture.businessRequestsBefore)&&capture.businessRequestsBefore>=0);
        assert.equal(capture.businessRequestsAfter-capture.businessRequestsBefore,allowed?1:0);
        if(allowed)assert.ok(approvedSsh>0);
      }else if (capture.name.endsWith('-closed')) assert.equal(approvedProxy, 0); else assert.ok(approvedProxy > 0);
    }
    captures.push({ name: capture.name, physicalOut, approvedProxy, approvedSsh, unapproved });
  }
  assert.equal(boots.size, 7);
  const result = { passed: true, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), cdHash: report.cdHash,
    verifierSha256: hash(await readFile(import.meta.filename)), packetReaderSha256: hash(await readFile(path.join(root, 'scripts/packet-capture.ts'))),
    faultPoints: points, captures, distinctNormalBoots: boots.size, testResourcesRemoved: true,
    scope: 'Read-only verification of frozen-package Node maintenance-worker SIGKILL at three actual operations, Electron pending gates/UI retries, canary preservation and smaller snapshot restoration with thirteen raw captures; journal HMAC was checked during execution, key not archived; not Electron main-process kill, maintenance first packet, physical power loss, browser/CLI, long-term, public line or second-Mac acceptance' };
  await writeFile(output, JSON.stringify(result, null, 2), { mode: 0o600 }); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const result = { passed: false, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), error: error instanceof Error ? error.stack : String(error) };
  await writeFile(output, JSON.stringify(result, null, 2), { mode: 0o600 }); console.error(JSON.stringify(result, null, 2)); process.exitCode = 1;
}
