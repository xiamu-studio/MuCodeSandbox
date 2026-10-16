import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
import { assertGuestBrowserSandbox } from '../server/guest-browser-sandbox.ts';

const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, 'test-results/browser-install-recovery.json');
const bytes = await readFile(file), report = JSON.parse(bytes.toString());
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
assert.equal(report.passed, true); assert.equal(report.testResourcesRemoved, true);
assert.ok(report.extractionFailureRetainsPrevious && report.checksumFailureRetainsPrevious);
assert.equal(report.accountFree, true); assert.equal(report.paidModelCalls, 0);
assert.equal(report.sourceRuntimeTested, true); assert.equal(report.electronPackageTested, false);
assert.equal(report.actualVersionUpgradeTested, false);
assert.equal(path.dirname(report.artifactsDirectory), path.join(root, 'test-results'));
for (const [name, hash] of Object.entries(report.sources)) assert.equal(digest(await readFile(path.join(root, name))), hash, `Source changed: ${name}`);
for (const [name, hash] of Object.entries(report.artifacts)) {
  assert.equal(path.basename(name), name); assert.equal(digest(await readFile(path.join(report.artifactsDirectory, name))), hash, `Artifact changed: ${name}`);
}
const points = ['prepared', 'backed-up', 'switched', 'configured', 'committed'];
assert.deepEqual(report.stages.map((s: any) => s.stage), ['initial', ...points.flatMap(point => [`killed-${point}`, `recovered-${point}`]), 'final']);
for (const point of points) {
  const killed = report.stages.find((s: any) => s.stage === `killed-${point}`);
  assert.equal(killed.actualInstallerProcessKilled, true); assert.match(killed.processState.state, /^T/);
  assert.match(killed.processState.exe, /python3/); assert.ok(killed.pid > 1);
  assert.equal(killed.journal.committed, point === 'committed'); assert.equal(killed.previousCanaryRetained, point !== 'committed');
  assert.ok(typeof killed.outcome.error === 'string');
}
assert.equal(report.browserEvidence.loginRequests, 1);
const browserStages = report.stages.filter((s: any) => s.receipt);
const baseline = browserStages[0].receipt.after;
for (const stage of browserStages) {
  assert.deepEqual(stage.receipt.after, baseline); if (stage.stage !== 'initial') assert.deepEqual(stage.receipt.before, baseline);
  assert.equal(stage.receipt.identity.language, 'ja-JP'); assert.equal(stage.receipt.identity.timezone, 'Asia/Tokyo'); assert.match(stage.receipt.identity.platform, /^Linux /);
  assert.deepEqual(stage.rendered.green, [39, 163, 111, 255]); assert.deepEqual(stage.rendered.red, [234, 75, 114, 255]);
  assertGuestBrowserSandbox(stage.sandbox);
  assert.ok(stage.protection.active && stage.protection.integrity === 'verified');
  assert.equal(stage.protection.firewallHash, browserStages[1].protection.firewallHash);
  assert.equal(stage.protection.tunnelConfigHash, browserStages[1].protection.tunnelConfigHash);
}
const capture = await readFile(path.join(report.artifactsDirectory, 'tasks.pcap'));
assert.equal(capture.length, report.capture.bytes); assert.equal(digest(capture), report.capture.sha256);
const [gateway, port] = browserStages[1].protection.proxyEndpoints[0].split(':');
const decoded = await run('/usr/sbin/tcpdump', ['-nn', '-r', path.join(report.artifactsDirectory, 'tasks.pcap'), 'ifindex 2 and outbound and (ip or ip6)'], { maxBytes: 128_000_000 });
const packets = decoded.split('\n').filter(line => /^\d\d:\d\d:\d\d\.\d+\s/.test(line));
assert.equal(packets.length, report.capture.physicalPackets);
const approved = packets.filter(line => line.includes(` > ${gateway}.${port}:`)); assert.ok(approved.length > 0); assert.equal(approved.length, report.capture.approvedProxy);
const unapproved = packets.filter(line => /\sIP6\s/.test(line) || !(line.includes(` > ${gateway}.${port}:`) || line.includes(`.22 > ${gateway}.`) || /\.68 > [0-9.]+\.67:/.test(line)));
assert.deepEqual(unapproved, []); assert.equal(report.capture.unapproved, 0);
const result = { passed: true, verifiedAt: new Date().toISOString(), reportSha256: digest(bytes),
  sourceAndArtifactHashesVerified: true, actualKilledCheckpoints: points, recoveryBrowserObservations: browserStages.length,
  rawPhysicalPackets: packets.length, approvedProxy: approved.length, unapproved: 0, testResourcesRemoved: true,
  scope: 'Independent saved-evidence and raw-capture verification; same official version, not cross-version upgrade, package, capacity or power-loss acceptance' };
await writeFile(path.join(root, 'test-results/browser-install-evidence.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
