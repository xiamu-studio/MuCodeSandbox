import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const probe = process.argv.includes('--probe');
const transport = process.argv.includes('--transport') || probe;
const portReuse = process.argv.includes('--port-reuse');
assert.ok(!portReuse || transport);
const diagnostics = process.argv.includes('--diagnostics');
const monitor = process.argv.includes('--monitor') || diagnostics || transport;
const reportName = probe ? (portReuse ? 'network-port-reuse-probe-candidate' : 'sustained-network-probe-candidate') : transport ? (portReuse ? 'network-port-reuse-transport-candidate' : 'sustained-network-transport-candidate') : diagnostics ? 'sustained-network-monitor-diagnostics' : monitor ? 'sustained-network-monitor' : 'sustained-network-latest';
const input = path.join(root, 'test-results', `${reportName}.json`);
const bytes = await readFile(input), report = JSON.parse(bytes.toString());
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const output = path.join(root, 'test-results', `${reportName}-evidence.json`);
try {
  assert.equal(report.passed, true); assert.equal(report.accountFree, true); assert.equal(report.paidModelCalls, 0);
  if (monitor) assert.equal(report.diskRecoveryMonitorPackageTested, true);
  if (diagnostics) assert.equal(report.stableErrorDiagnosticsTested, true);
  if (transport) {
    assert.equal(report.proxyTransportCandidateTested, true);
    assert.ok(report.privateGuardBeforeForward.length >= 2);
    assert.ok(report.privateGuardBeforeForward.every((row: any) => row.actualKernelRuleVerified && row.listenerAbsent && row.uid > 0 && row.port > 0));
    if (!portReuse) assert.equal(report.stableErrorDiagnosticsTested, true);
  }
  assert.equal(report.electronUiTested, false); assert.equal(report.browserTested, false);
  assert.equal(report.actualMacSleepTested, false); assert.equal(report.actualWifiSwitchTested, false);
  assert.equal(report.testResourcesRemoved, true); assert.equal(report.cleanupError, undefined); assert.equal(report.captureError, undefined);
  assert.equal(path.dirname(report.artifactsDirectory), path.join(root, 'test-results'));
  assert.match(path.basename(report.artifactsDirectory), transport ? new RegExp(`^${reportName}-\\d+$`) : diagnostics ? /^sustained-network-monitor-diagnostics-\d+$/ : monitor ? /^sustained-network-monitor-\d+$/ : /^sustained-network-\d+$/);
  assert.deepEqual(report, JSON.parse(await readFile(path.join(report.artifactsDirectory, 'report.json'), 'utf8')));
  assert.deepEqual(Object.keys(report.sources).sort(), ['scripts/verify-sustained-network.ts', 'scripts/claude-local-fixture.ts', ...(transport ? ['server/proxy-transport.ts', 'server/network-guard.ts', 'scripts/proxy-transport-owner.ts'] : [])].sort());
  for (const [file, expected] of Object.entries(report.sources)) assert.equal(hash(await readFile(path.join(root, file))), expected);
  if (monitor) {
    assert.deepEqual((await readdir(report.artifactsDirectory)).filter(file => file !== 'report.json').sort(), Object.keys(report.artifacts).sort());
    for (const [file, expected] of Object.entries(report.sources)) assert.equal(hash(await readFile(path.join(report.artifactsDirectory, `source-${path.basename(file)}`))), expected);
  }
  for (const [file, expected] of Object.entries(report.artifacts)) {
    assert.equal(path.basename(file), file); assert.equal(hash(await readFile(path.join(report.artifactsDirectory, file))), expected);
  }
  const bundle = path.join(root, `release/${probe ? 'proxy-probe-candidate' : transport ? 'proxy-transport-guard-candidate' : monitor ? 'disk-recovery-monitor-candidate' : 'boot-capture-candidate'}/mac-arm64/MuCodeSandbox.app`);
  const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
  assert.equal(report.bundle, bundle); await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]); assert.match(signature, /Signature=adhoc/);
  assert.equal(report.packageCdHash, probe ? '93781410161fcf4560c244ce5469b980ffc38976' : transport ? '7395e50362e01c36299c4eacabe0cbedb636cf22' : monitor ? 'b3b92b627f33d1b810011558fa4ba0c18cddd934' : 'b0cd06dd921a9ba759336fb39c8cb6e40e22fde4');
  assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], report.packageCdHash);
  const modules = (await readdir(compiled)).filter(file => file.endsWith('.js')).sort();
  assert.deepEqual(Object.keys(report.modules).sort(), modules);
  for (const file of modules) {
    assert.equal(hash(await readFile(path.join(compiled, file))), report.modules[file]);
    assert.equal(hash(await readFile(path.join(root, 'dist-server/server', file))), report.modules[file]);
  }
  let stableMs = 0;
  const stableStageErrors: { name: string; shortRequests: number; streams: number }[] = [];
  let raw: any[] = [], denied: any[] = [];
  if (portReuse) {
    assert.equal(report.portReuseFixVerified, true); assert.equal(report.portReuseTimeoutReproduced, false);
    assert.equal(report.stabilityPassed, false);
    assert.deepEqual(report.portReuse.map((layer: any) => layer.mode), ['tun', 'ssh-loopback']);
    for (const layer of report.portReuse) {
      assert.equal(layer.rows.length, 6);
      for (let index = 0; index < 6; index++) {
        const row = layer.rows[index];
        assert.equal(row.ok, true); assert.equal(row.phase, 'read'); assert.equal(row.error, undefined);
        assert.equal(row.label, index % 2 ? 'reuse-after-2s' : 'initial');
        assert.equal(row.sourcePort, [46101, 46103, 46105][Math.floor(index / 2)]);
      }
    }
    assert.equal(report.productConfigurationTested.tunStack, 'system');
    assert.equal(report.productConfigurationTested.targetIP, '127.0.0.1');
    assert.equal(report.productConfigurationTested.targetPort, report.proxyPort);
    assert.equal(report.privateGuardBeforeForward[0].port, report.productConfigurationTested.relayPort);
    for (const key of ['developerRelayBypassRejected', 'physicalProxyExceptionRemoved', 'transportClosureRemovedGuestListener',
      'transportFailureAutomaticallyQuarantined', 'transportQuarantineRestartRecovered']) assert.equal(report[key], true);
    const owner = report.actualTransportOwnerSigkill;
    assert.ok(Number.isInteger(owner.ownerPid) && owner.ownerPid > 0 && Number.isInteger(owner.sshPid) && owner.sshPid > 0 && owner.ownerPid !== owner.sshPid);
    assert.equal(owner.listenerRemoved, true); assert.equal(owner.activeStreamClosed, true); assert.equal(owner.hostTicksStopped, true);
    const events = JSON.parse(await readFile(path.join(report.artifactsDirectory, 'host-connections.json'), 'utf8'));
    assert.ok(events.filter((row: any) => row.event === 'target-request' && row.path === '/tick').length >= 14);
    assert.equal(events.filter((row: any) => row.event === 'target-request' && row.path === '/stream').length, 1);
    assert.deepEqual(report.captures.map((row: any) => row.name), ['first-boot', 'transport-recovery-boot', 'tasks-1', 'tasks-2']);
  } else {
  assert.equal(report.stableDurationRequiredMs, 600_000); assert.equal(report.stable.length, 2);
  assert.deepEqual(report.stable.map((stage: any) => stage.name), ['before-fault', 'after-recovery']);
  for (const stage of report.stable) {
    assert.ok(stage.elapsedMs >= 300_000); stableMs += stage.elapsedMs;
    assert.ok(stage.after.ok - stage.before.ok >= 200); assert.ok(stage.after.stream - stage.before.stream >= 800);
    assert.ok(stage.hostAfter.hits - stage.hostBefore.hits >= 200); assert.ok(stage.hostAfter.ticks - stage.hostBefore.ticks >= 800);
    stableStageErrors.push({ name: stage.name, shortRequests: (stage.after.error ?? 0) - (stage.before.error ?? 0),
      streams: (stage.after['stream-error'] ?? 0) - (stage.before['stream-error'] ?? 0) });
    const observations = report.observations.filter((row: any) => row.phase === stage.name);
    assert.ok(observations.length >= 10);
    let previous = 0;
    for (const row of observations) {
      assert.ok(row.elapsedMs > previous && row.elapsedMs - previous < 60_000); previous = row.elapsedMs;
      assert.equal(row.protection.active, true); assert.equal(row.protection.integrity, 'verified'); assert.equal(row.protection.leaseActive, true);
      assert.equal(row.counts.invalid ?? 0, 0);
    }
    assert.ok(observations.at(-1).elapsedMs >= 300_000);
  }
  assert.ok(stableMs >= 600_000);
  if (diagnostics || transport) assert.ok(stableStageErrors.every(stage => stage.shortRequests === 0 && stage.streams === 0), 'Unexpected socket errors in a stable stage');
  const outage = report.proxyOutage;
  assert.equal(outage.newAndExistingConnectionsBlocked, true); assert.equal(outage.directBypassRejected, true);
  assert.equal(outage.recoveredWithoutVmRestart, true);
  assert.equal(outage.blockedCounts.ok, outage.stoppedCounts.ok); assert.equal(outage.blockedCounts.stream, outage.stoppedCounts.stream);
  assert.ok(outage.blockedCounts.error > outage.stoppedCounts.error);
  assert.equal(report.networkdRestartAndRenewRecovered, true);
  assert.equal(report.tunnelFailureAutomaticallyQuarantined, true); assert.equal(report.restartAfterQuarantineRecovered, true);
  raw = (await readFile(path.join(report.artifactsDirectory, 'guest-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(raw.filter(row => row.kind === 'ok').length >= 400); assert.ok(raw.filter(row => row.kind === 'stream').length >= 1600);
  assert.ok(raw.some(row => row.kind === 'error'));
  let previousTime = 0;
  for (const row of raw) { assert.ok(Number.isFinite(row.at) && row.at >= previousTime); previousTime = row.at; assert.notEqual(row.kind, 'invalid'); }
  if (diagnostics) {
    assert.equal(report.diagnosticReadError, undefined);
    for (const row of raw.filter(row => ['error', 'stream-error'].includes(row.kind))) {
      assert.ok(typeof row.error?.type === 'string' && row.error.type.length > 0);
      assert.ok(typeof row.error.message === 'string' && row.error.message.length > 0);
      assert.ok(row.error.errno === null || Number.isInteger(row.error.errno));
    }
  }
  assert.ok(raw.at(-1).at - raw[0].at >= 600);
  assert.ok(report.hostReceipts.hits >= 400 && report.hostReceipts.ticks >= 1600 && report.hostReceipts.streams >= 2);
  const decisions = report.proxyDecisions.filter((row: any) => row.localOnly);
  const permitted = decisions.filter((row: any) => row.allowed); denied = decisions.filter((row: any) => !row.allowed);
  assert.ok(permitted.length >= 400); assert.ok(permitted.every((row: any) => row.destination === '203.0.113.81:80'));
  assert.ok(denied.every((row: any) => row.destination === '1.1.1.1:443'));
  assert.equal(report.controlledDnsRequestsDeniedByFixture, denied.length); assert.equal(report.successfulDomainResolutionTested, false);
  assert.deepEqual(report.captures.map((row: any) => row.name), ['first-boot', 'tasks-1', 'recovery-boot', 'tasks-2']);
  }
  const bootIds = report.captures.filter((row: any) => row.bootId).map((row: any) => row.bootId);
  assert.equal(new Set(bootIds).size, 2); bootIds.forEach((id: string) => assert.match(id, /^[a-f0-9-]{36}$/));
  assert.match(report.gateway, /^\d+\.\d+\.\d+\.\d+$/); assert.ok(Number.isInteger(report.proxyPort));
  const allowed = `${transport ? '' : `(tcp and dst host ${report.gateway} and dst port ${report.proxyPort}) or `}(tcp and src port 22 and dst host ${report.gateway}) or (udp and src port 68 and dst port 67)`;
  const captures = [];
  for (const capture of report.captures) {
    const file = path.join(report.artifactsDirectory, `${capture.name}.pcap`), data = await readFile(file);
    assert.equal(data.length, capture.bytes); assert.equal(hash(data), capture.sha256);
    const count = async (filter: string) => (await packetLines(file, filter)).length;
    const physicalPackets = await count('ifindex 2 and outbound and (ip or ip6)'); assert.ok(physicalPackets > 0);
    const unapproved = await count(`ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`); assert.equal(unapproved, 0);
    const approvedProxy = await count(`ifindex 2 and outbound and tcp and dst host ${report.gateway} and dst port ${report.proxyPort}`);
    const approvedSsh = await count(`ifindex 2 and outbound and tcp and src port 22 and dst host ${report.gateway}`);
    if (capture.name.startsWith('tasks-')) assert.ok((transport ? approvedSsh : approvedProxy) > 0);
    if (transport) assert.equal(approvedProxy, 0);
    captures.push({ name: capture.name, physicalPackets, approvedProxy, ...(transport ? { approvedSsh } : {}), unapproved });
  }
  const evidence = { passed: true, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes),
    packageCdHash: report.packageCdHash, compiledModulesVerified: modules.length, stableMs,
    stableStageErrors, zeroStableStageErrors: !portReuse && stableStageErrors.every(stage => stage.shortRequests === 0 && stage.streams === 0),
    ...(portReuse ? { portReuseFixVerified: true, stabilityPassed: false, transportOwnerSigkillVerified: true, privateListenerGuardBeforeForwardVerified: true } : {}),
    rawRequestRecords: raw.length, captures, temporaryResourcesRemoved: true, controlledDnsRequestsDeniedByFixture: denied.length,
    verifierSha256: hash(await readFile(path.join(root, 'scripts/verify-sustained-network-evidence.ts'))),
    packetReaderSha256: hash(await readFile(path.join(root, 'scripts/packet-capture.ts'))),
    scope: portReuse ? 'Frozen-package fixed-port regression, private listener boundaries, actual transport owner SIGKILL and automatic quarantine/restart with four raw captures; not long-term stability or actual Electron owner SIGKILL' : 'Two five-minute controlled numeric-address TCP/stream stages and selected faults using packaged modules; stableStageErrors explicitly reports transient failures; DNS denied by local fixture, not successful domain resolution, day-long, browser, Mac sleep/Wi-Fi, residential or all-fault acceptance' };
  await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 }); console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  const failed = { passed: false, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), error: (error as Error).stack };
  await writeFile(output, JSON.stringify(failed, null, 2), { mode: 0o600 }); console.error(JSON.stringify(failed, null, 2)); process.exitCode = 1;
}
