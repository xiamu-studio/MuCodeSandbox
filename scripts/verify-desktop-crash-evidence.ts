import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const bridgeOwner = process.argv.includes('--bridge-owner');
const reportName = bridgeOwner ? 'desktop-crash-bridge-owner' : 'desktop-crash';
const bytes = await readFile(path.join(root, `test-results/${reportName}.json`));
const report = JSON.parse(bytes.toString());
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const output = path.join(root, `test-results/${reportName}-evidence.json`);
try {
  assert.ok(report.passed && report.accountFree && report.actualVmTested && report.actualElectronMainSigkill);
  assert.equal(report.paidModelCalls, 0); assert.equal(report.error, undefined); assert.equal(report.cleanupError, undefined);
  assert.equal(report.captureError, undefined); assert.equal(report.closeError, undefined); assert.equal(report.testResourcesRemoved, true);
  assert.equal(report.retainedTestDirectory, undefined); assert.equal(report.leaseSeconds, 45);
  const directory = report.artifactsDirectory;
  assert.equal(path.dirname(directory), path.join(root, 'test-results')); assert.match(path.basename(directory), new RegExp(`^${reportName}-\\d+$`));
  assert.deepEqual(report, JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')));
  assert.deepEqual(Object.keys(report.sources).sort(), ['scripts/verify-desktop-crash.ts', 'scripts/claude-local-fixture.ts', 'scripts/packet-capture.ts'].sort());
  for (const [file, expected] of Object.entries(report.sources)) {
    assert.equal(hash(await readFile(path.join(root, file))), expected);
    assert.equal(hash(await readFile(path.join(directory, `source-${path.basename(file)}`))), expected);
  }
  assert.deepEqual((await readdir(directory)).filter(file => file !== 'report.json').sort(), Object.keys(report.artifacts).sort());
  for (const [file, expected] of Object.entries(report.artifacts)) {
    assert.equal(path.basename(file), file); assert.equal(hash(await readFile(path.join(directory, file))), expected);
  }
  const bundle = path.join(root, `release/${bridgeOwner ? 'bridge-owner-candidate' : 'proxy-probe-candidate'}/mac-arm64/MuCodeSandbox.app`);
  assert.equal(report.bundle, bundle); assert.equal(report.cdHash, bridgeOwner ? '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3' : '93781410161fcf4560c244ce5469b980ffc38976');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
  assert.match(signature, /Signature=adhoc/); assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], report.cdHash);
  const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
  const modules = (await readdir(compiled)).filter(file => file.endsWith('.js')).sort();
  assert.deepEqual(Object.keys(report.modules).sort(), modules);
  for (const file of modules) {
    assert.equal(hash(await readFile(path.join(compiled, file))), report.modules[file]);
    assert.equal(hash(await readFile(path.join(root, 'dist-server/server', file))), report.modules[file]);
  }
  assert.equal(report.launches.length, 2);
  for (const identity of report.launches) { assert.ok(identity.packaged); assert.equal(identity.appPath, path.join(bundle, 'Contents/Resources/app')); }
  assert.equal(report.killedPid, report.launches[0].pid); assert.notEqual(report.launches[0].pid, report.launches[1].pid);
  assert.deepEqual(report.exit, { code: null, signal: 'SIGKILL' });
  assert.ok(report.positive.kernel.active && report.positive.kernel.remainingMs > 30_000);
  assert.ok(report.positive.guest.ok >= 4 && report.positive.guest.stream >= 12 && report.positive.host.hits > 0 && report.positive.host.ticks > 0);
  assert.ok(report.positive.bridgeRead && report.positive.actualTerminalRoundTrip);
  assert.ok(report.ownedChildren.filter((row: any) => path.basename(row.command) === 'ssh').length >= 2);
  assert.ok(report.ownedChildren.some((row: any) => path.basename(row.command) === 'mu-host-bridge'));
  assert.deepEqual(report.survivingOwnedChildren, []);
  for (const flag of ['terminalClosed', 'listenerAbsent', 'newRequestDenied', 'fileGrantDenied', 'ongoingAttemptsFail']) assert.equal(report.afterKill[flag], true);
  assert.ok(report.afterKill.streamClosed >= 1 && report.afterKill.stableMs >= 5000);
  assert.ok(report.transportClosedMs >= 0 && report.transportClosedMs < 30_000);
  assert.equal(report.expired.kernel.active, false); assert.equal(report.expired.vmState, 'Running');
  assert.ok(report.expired.afterMs >= report.transportClosedMs && report.expired.afterMs < 65_000);
  const workload = (await readFile(path.join(directory, 'guest-workload.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const cutoff = report.killedAt + report.transportClosedMs + 1000;
  assert.ok(workload.filter(row => row.kind === 'ok').length >= 4 && workload.filter(row => row.kind === 'stream').length >= 12);
  assert.ok(workload.some(row => row.kind === 'error' && row.at * 1000 > cutoff));
  assert.equal(workload.filter(row => ['ok', 'stream'].includes(row.kind) && row.at * 1000 > cutoff).length, 0);
  const hostEvents = JSON.parse(await readFile(path.join(directory, 'host-events.json'), 'utf8'));
  assert.ok(hostEvents.some((row: any) => row.kind === 'stream-closed' && row.at >= report.killedAt));
  const recoveryStart = Math.max(...workload.map(row => row.at * 1000));
  assert.equal(hostEvents.filter((row: any) => ['request', 'tick'].includes(row.kind) && row.at > cutoff && row.at <= recoveryStart).length, 0);
  assert.deepEqual(report.reopen, { stoppedBeforeManualRestart: true, state: 'error', grantsEmpty: true, oldTicketRejected: true, terminalIssueRejected: true });
  assert.deepEqual(report.manualRecovery, { newBusinessSucceeded: true, oldGrantRejected: true, guestFilePreserved: true });
  assert.deepEqual(report.captures.map((row: any) => row.name), ['first-boot', 'active-crash', 'recovery-boot']);
  assert.notEqual(report.captures[0].bootId, report.captures[2].bootId);
  const captures = [];
  for (const row of report.captures) {
    const file = path.join(directory, `${row.name}.pcap`), data = await readFile(file);
    assert.equal(hash(data), row.sha256); assert.equal(data.length, row.bytes);
    const physical = (await packetLines(file, 'ifindex 2 and outbound and (ip or ip6)')).length;
    const ssh = (await packetLines(file, 'ifindex 2 and outbound and tcp and src port 22 and dst host 192.168.5.2')).length;
    const unapproved = (await packetLines(file, 'ifindex 2 and outbound and (ip6 or (ip and not ((tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67))))')).length;
    assert.ok(physical > 0 && ssh > 0); assert.equal(physical, row.physical); assert.equal(ssh, row.ssh); assert.equal(unapproved, 0);
    if (row.name === 'active-crash') {
      assert.ok(data.includes(Buffer.from('MU_CRASH_TICK')));
      const physicalText = await run('/usr/sbin/tcpdump', ['-nn', '-A', '-r', file, 'ifindex 2 and (ip or ip6)'], { maxBytes: 32_000_000 });
      assert.equal(physicalText.includes('MU_CRASH_TICK'), false);
    }
    captures.push({ name: row.name, physical, ssh, unapproved, sha256: row.sha256 });
  }
  const evidence = { passed: true, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), cdHash: report.cdHash,
    modulesVerified: modules.length, actualElectronMainSigkill: true, transportClosedMs: report.transportClosedMs,
    kernelExpiredMs: report.expired.afterMs, terminalAndFileAccessDenied: true, ownedChildrenRemoved: true,
    manualRecoveryPassed: true, captures, temporaryResourcesRemoved: true,
    verifierSha256: hash(await readFile(import.meta.filename)),
    scope: 'Frozen actual Electron SIGKILL with real guest TCP/stream, terminal and file grant; lease expiration without reopening, post-expiry ticket rejection, manual recovery. No instantaneous kill, browser/Claude, Mac sleep, Wi-Fi, residential or twenty-four-hour claim.' };
  await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 }); console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  const failure = { passed: false, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), error: (error as Error).stack };
  await writeFile(output, JSON.stringify(failure, null, 2), { mode: 0o600 }); console.error(JSON.stringify(failure, null, 2)); process.exitCode = 1;
}
