import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const bridgeOwner = process.argv.includes('--bridge-owner');
const transport = process.argv.includes('--transport') || bridgeOwner;
const reportName = bridgeOwner ? 'domain-network-bridge-owner' : transport ? 'domain-network-transport' : 'domain-network-latest';
const bytes = await readFile(path.join(root, `test-results/${reportName}.json`)), report = JSON.parse(bytes.toString());
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const output = path.join(root, `test-results/${reportName}-evidence.json`);
try {
  assert.equal(report.passed, true); assert.equal(report.accountFree, true); assert.equal(report.paidModelCalls, 0);
  if (transport) assert.equal(report.proxyTransportPackageTested, true);
  assert.equal(report.testResourcesRemoved, true); assert.equal(report.cleanupError, undefined); assert.equal(report.captureError, undefined);
  assert.equal(report.temporaryVmCaOnly, true); assert.equal(report.hostTrustStoreChanged, false);
  assert.equal(path.dirname(report.artifactsDirectory), path.join(root, 'test-results')); assert.match(path.basename(report.artifactsDirectory), bridgeOwner ? /^domain-network-bridge-owner-\d+$/ : transport ? /^domain-network-transport-\d+$/ : /^domain-network-\d+$/);
  assert.deepEqual(report, JSON.parse(await readFile(path.join(report.artifactsDirectory, 'report.json'), 'utf8')));
  assert.deepEqual(Object.keys(report.sources).sort(), ['scripts/verify-domain-network.ts', 'scripts/doh-local-fixture.ts'].sort());
  for (const [file, expected] of Object.entries(report.sources)) assert.equal(hash(await readFile(path.join(root, file))), expected);
  if (bridgeOwner) {
    assert.equal(report.inputsUnchanged, true); assert.deepEqual(report.initialSources, report.sources);
    for (const [file, digest] of Object.entries(report.sources)) assert.equal(hash(await readFile(path.join(report.artifactsDirectory, `source-${path.basename(file)}`))), digest);
  }
  for (const [file, expected] of Object.entries(report.artifacts)) {
    assert.equal(path.basename(file), file); assert.equal(hash(await readFile(path.join(report.artifactsDirectory, file))), expected);
  }
  const bundle = path.join(root, `release/${bridgeOwner ? 'bridge-owner-candidate' : transport ? 'proxy-transport-guard-candidate' : 'boot-capture-candidate'}/mac-arm64/MuCodeSandbox.app`), compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
  assert.equal(report.bundle, bundle); await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]); assert.match(signature, /Signature=adhoc/);
  assert.equal(report.packageCdHash, bridgeOwner ? '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3' : transport ? '7395e50362e01c36299c4eacabe0cbedb636cf22' : 'b0cd06dd921a9ba759336fb39c8cb6e40e22fde4'); assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], report.packageCdHash);
  const modules = (await readdir(compiled)).filter(file => file.endsWith('.js')).sort(); assert.deepEqual(Object.keys(report.modules).sort(), modules);
  for (const file of modules) {
    assert.equal(hash(await readFile(path.join(compiled, file))), report.modules[file]);
    assert.equal(hash(await readFile(path.join(root, 'dist-server/server', file))), report.modules[file]);
  }
  const ca = new X509Certificate(await readFile(path.join(report.artifactsDirectory, 'test-ca.crt')));
  const leaf = new X509Certificate(await readFile(path.join(report.artifactsDirectory, 'test-server.crt')));
  assert.equal(ca.ca, true); assert.equal(leaf.ca, false); assert.equal(leaf.verify(ca.publicKey), true);
  assert.equal(leaf.checkHost('mu-controlled-doh.test'), 'mu-controlled-doh.test'); assert.equal(leaf.checkHost('wrong-doh.test'), undefined);
  for (const flag of ['hostWrongTlsNameRejected', 'untrustedCaResolutionRejected', 'nxdomainRejected', 'dnsOutageUncachedResolutionAndRequestBlocked',
    'physicalDnsFallbackBlocked', 'dnsRecoveryWithoutVmRestart', 'networkdRestartAndRenewRecovered', 'guestWrongTlsNameRejected', 'normalRestartAfterTlsFailureRecovered']) assert.equal(report[flag], true, flag);
  const receipts = JSON.parse(await readFile(path.join(report.artifactsDirectory, 'dns-receipts.json'), 'utf8'));
  const labels = ['trusted', ...Array.from({ length: 18 }, (_, index) => `sample-${index}`), 'dns-recovery', 'networkd-recovery', 'name-recovery'];
  assert.deepEqual(report.observations.map((row: any) => row.label), labels); assert.ok(report.stableDomainMs >= 180_000);
  let previous = 0;
  for (const row of report.observations) {
    assert.equal(row.resolution, '203.0.113.81'); assert.equal(row.response, 'MU_DOMAIN_OK'); assert.equal(row.protectionActive, true);
    const time = Date.parse(row.at); assert.ok(time > previous); previous = time;
    assert.ok(receipts.queries.some((query: any) => query.name === `${row.label}.mu-domain.test` && query.type === 1 && query.answer === '203.0.113.81' && query.rcode === 0));
    assert.ok(receipts.requests.some((request: any) => request.host === `${row.label}.mu-domain.test`));
  }
  const samples = report.observations.filter((row: any) => row.label.startsWith('sample-'));
  assert.ok(Date.parse(samples.at(-1).at) - Date.parse(samples[0].at) >= 170_000);
  assert.ok(receipts.queries.some((query: any) => query.name === 'missing-domain.mu-domain.test' && query.rcode === 3));
  assert.deepEqual(report.failedNamePhases.map((phase: any) => phase.labels), [['untrusted-ca'], ['dns-outage', 'dns-outage-http'], ['wrong-name']]);
  for (const phase of report.failedNamePhases) {
    const start = Date.parse(phase.startedAt), end = Date.parse(phase.restoreStartedAt);
    assert.ok(end - start >= 3000);
    for (const label of phase.labels) {
      // Pending resolver retries after recovery are valid; only the fault window must stay closed.
      assert.ok(!receipts.queries.some((query: any) => query.name === `${label}.mu-domain.test` && Date.parse(query.at) >= start && Date.parse(query.at) < end));
      assert.ok(!receipts.requests.some((request: any) => request.host === `${label}.mu-domain.test`));
    }
  }
  const local = receipts.decisions.filter((row: any) => row.localOnly); assert.ok(local.length > 20);
  assert.ok(local.every((row: any) => row.allowed && ['203.0.113.81:80', '203.0.113.82:443'].includes(row.destination)));
  assert.ok(local.some((row: any) => row.destination === '203.0.113.82:443'));
  assert.deepEqual(report.captures.map((row: any) => row.name), ['first-boot', 'domain-tasks', 'wrong-name-boot', 'wrong-name-tasks', 'recovery-boot', 'recovery-tasks']);
  const bootIds = report.captures.filter((row: any) => row.bootId).map((row: any) => row.bootId); assert.equal(new Set(bootIds).size, 3);
  bootIds.forEach((id: string) => assert.match(id, /^[a-f0-9-]{36}$/));
  assert.match(report.gateway, /^\d+\.\d+\.\d+\.\d+$/); assert.ok(Number.isInteger(report.proxyPort));
  const allowed = `${transport ? '' : `(tcp and dst host ${report.gateway} and dst port ${report.proxyPort}) or `}(tcp and src port 22 and dst host ${report.gateway}) or (udp and src port 68 and dst port 67)`;
  const captures = [];
  for (const capture of report.captures) {
    const file = path.join(report.artifactsDirectory, `${capture.name}.pcap`), data = await readFile(file);
    assert.equal(data.length, capture.bytes); assert.equal(hash(data), capture.sha256);
    const count = async (filter: string) => (await run('/usr/sbin/tcpdump', ['-nn', '-r', file, filter], { maxBytes: 64_000_000 })).split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line)).length;
    const physicalPackets = await count('ifindex 2 and outbound and (ip or ip6)'); assert.ok(physicalPackets > 0);
    const unapproved = await count(`ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`); assert.equal(unapproved, 0);
    const approvedProxy = await count(`ifindex 2 and outbound and tcp and dst host ${report.gateway} and dst port ${report.proxyPort}`);
    const approvedSsh = await count(`ifindex 2 and outbound and tcp and src port 22 and dst host ${report.gateway}`);
    if (transport) assert.equal(approvedProxy, 0);
    if (capture.name.endsWith('tasks')) assert.ok((transport ? approvedSsh : approvedProxy) > 0);
    captures.push({ name: capture.name, physicalPackets, approvedProxy, approvedSsh, unapproved });
  }
  const evidence = { passed: true, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), packageCdHash: report.packageCdHash,
    compiledModulesVerified: modules.length, stableDomainMs: report.stableDomainMs, successfulFreshDomains: labels.length,
    queryReceipts: receipts.queries.length, requestReceipts: receipts.requests.length, captures, temporaryResourcesRemoved: true, threeFaultWindowsVerified: true,
    verifierSha256: hash(await readFile(path.join(root, 'scripts/verify-domain-network-evidence.ts'))),
    scope: 'Real guest controlled DoH/system resolver and domain requests, selected faults and certificate checks; not browser/UI, public resolver, residential, day-long or all-fault acceptance' };
  await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 }); console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  const failed = { passed: false, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), error: (error as Error).stack };
  await writeFile(output, JSON.stringify(failed, null, 2), { mode: 0o600 }); console.error(JSON.stringify(failed, null, 2)); process.exitCode = 1;
}
