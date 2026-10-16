import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const name = 'sustained-network-monitor-diagnostics';
const bytes = await readFile(path.join(root, 'test-results', `${name}.json`));
const report = JSON.parse(bytes.toString());
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
assert.equal(report.passed, false);
assert.match(report.error, /Unexpected socket errors during before-fault/);
assert.equal(report.stableErrorDiagnosticsTested, true);
assert.equal(report.accountFree, true); assert.equal(report.paidModelCalls, 0);
assert.equal(report.testResourcesRemoved, true);
for (const key of ['cleanupError', 'captureError', 'diagnosticReadError']) assert.equal(report[key], undefined);
const artifacts = report.artifactsDirectory;
assert.equal(path.dirname(artifacts), path.join(root, 'test-results'));
assert.match(path.basename(artifacts), /^sustained-network-monitor-diagnostics-\d+$/);
assert.deepEqual(report, JSON.parse(await readFile(path.join(artifacts, 'report.json'), 'utf8')));
assert.deepEqual((await readdir(artifacts)).filter(file => file !== 'report.json').sort(), Object.keys(report.artifacts).sort());
for (const [file, expected] of Object.entries(report.artifacts)) {
  assert.equal(path.basename(file), file); assert.equal(hash(await readFile(path.join(artifacts, file))), expected);
}
for (const [file, expected] of Object.entries(report.sources)) {
  assert.equal(hash(await readFile(path.join(root, file))), expected);
  assert.equal(hash(await readFile(path.join(artifacts, `source-${path.basename(file)}`))), expected);
}
const bundle = path.join(root, 'release/disk-recovery-monitor-candidate/mac-arm64/MuCodeSandbox.app');
assert.equal(report.bundle, bundle); await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
assert.equal(report.packageCdHash, 'b3b92b627f33d1b810011558fa4ba0c18cddd934');
assert.equal((await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1], report.packageCdHash);
const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
assert.deepEqual(Object.keys(report.modules).sort(), (await readdir(compiled)).filter(file => file.endsWith('.js')).sort());
for (const [file, expected] of Object.entries(report.modules)) {
  assert.equal(hash(await readFile(path.join(compiled, file))), expected);
  assert.equal(hash(await readFile(path.join(root, 'dist-server/server', file))), expected);
}
const rows = (await readFile(path.join(artifacts, 'guest-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const errors = rows.filter(row => row.kind === 'error' || row.kind === 'stream-error');
assert.ok(errors.length > 0 && errors.every(row => row.error?.type === 'TimeoutError' && row.error.errno === null && row.error.message === 'timed out'));
const stage = report.failedStableStage;
assert.equal(stage.name, 'before-fault'); assert.ok(stage.elapsedMs >= 300_000);
assert.equal(errors.length, (stage.after.error ?? 0) - (stage.before.error ?? 0));
assert.equal((stage.after['stream-error'] ?? 0) - (stage.before['stream-error'] ?? 0), 0);
assert.ok(rows.filter(row => row.kind === 'ok').length >= 300);
for (const observation of report.observations) {
  assert.equal(observation.protection.active, true); assert.equal(observation.protection.integrity, 'verified');
  assert.equal(observation.protection.leaseActive, true);
}
const allowed = `(tcp and dst host ${report.gateway} and dst port ${report.proxyPort}) or (tcp and src port 22 and dst host ${report.gateway}) or (udp and src port 68 and dst port 67)`;
assert.deepEqual(report.captures.map((capture: any) => capture.name), ['first-boot', 'tasks-1']);
const captures = [];
for (const capture of report.captures) {
  const file = path.join(artifacts, `${capture.name}.pcap`), data = await readFile(file);
  assert.equal(hash(data), capture.sha256); assert.equal(data.length, capture.bytes);
  const physicalPackets = (await packetLines(file, 'ifindex 2 and outbound and (ip or ip6)')).length;
  assert.ok(physicalPackets > 0);
  assert.deepEqual(await packetLines(file, `ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`), []);
  captures.push({ name: capture.name, physicalPackets, unapproved: 0 });
}
const evidence = { observationVerified: true, stabilityPassed: false, verifiedAt: new Date().toISOString(),
  reportSha256: hash(bytes), packageCdHash: report.packageCdHash, errors, captures,
  testResourcesRemoved: true, verifierSha256: hash(await readFile(import.meta.filename)),
  packetReaderSha256: hash(await readFile(path.join(root, 'scripts/packet-capture.ts'))),
  scope: 'Verifies the preserved real socket-timeout failure and two captures; does not turn the failed stability test into a passing result or attribute a root cause' };
await writeFile(path.join(root, 'test-results', `${name}-failure-evidence.json`), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
