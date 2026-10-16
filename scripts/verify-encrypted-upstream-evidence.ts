import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const input = path.join(root, 'test-results/encrypted-upstream-transport.json');
const bytes = await readFile(input), report = JSON.parse(bytes.toString());
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const output = path.join(root, 'test-results/encrypted-upstream-transport-evidence.json');
try {
  for (const flag of ['passed', 'accountFree', 'proxyTransportPackageTested', 'actualLinuxVmVerified',
    'hostTlsAndAuthenticationPositiveControls', 'plainHttpApplicationUsesAuthenticatedTlsProxy',
    'directBypassDenied', 'correctConfigurationRecovers', 'testResourcesRemoved']) assert.equal(report[flag], true, flag);
  assert.equal(report.paidModelCalls, 0); assert.equal(report.cleanupError, undefined); assert.equal(report.retainedDataDir, undefined);
  const directory = report.artifactsDirectory;
  assert.equal(path.dirname(directory), path.join(root, 'test-results'));
  assert.match(path.basename(directory), /^encrypted-upstream-transport-\d+$/);
  assert.deepEqual(report, JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')));
  assert.deepEqual(Object.keys(report.sources), ['scripts/verify-encrypted-upstream.ts']);
  for (const [file, expected] of Object.entries(report.sources)) {
    assert.equal(hash(await readFile(path.join(root, file))), expected);
    assert.equal(hash(await readFile(path.join(directory, `source-${path.basename(file)}`))), expected);
  }
  assert.deepEqual((await readdir(directory)).filter(file => file !== 'report.json').sort(), Object.keys(report.artifacts).sort());
  for (const [file, expected] of Object.entries(report.artifacts)) {
    assert.equal(path.basename(file), file); assert.equal(hash(await readFile(path.join(directory, file))), expected);
  }
  const bundle = path.join(root, 'release/proxy-transport-guard-candidate/mac-arm64/MuCodeSandbox.app');
  assert.equal(report.bundle, bundle); await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]); assert.match(signature, /Signature=adhoc/);
  assert.equal(report.packageCdHash, '7395e50362e01c36299c4eacabe0cbedb636cf22');
  assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], report.packageCdHash);
  const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
  const modules = (await readdir(compiled)).filter(file => file.endsWith('.js')).sort();
  assert.deepEqual(Object.keys(report.modules).sort(), modules);
  for (const file of modules) {
    assert.equal(hash(await readFile(path.join(compiled, file))), report.modules[file]);
    assert.equal(hash(await readFile(path.join(root, 'dist-server/server', file))), report.modules[file]);
  }
  assert.ok(report.initialProtection.active && report.initialProtection.transparentActive && report.initialProtection.integrity === 'verified');
  assert.equal(report.initialProtection.proxyEndpoints.length, 1);
  assert.match(report.initialProtection.proxyEndpoints[0], /^127\.0\.0\.1:\d+$/);
  assert.ok(report.tlsProtocols.includes('TLSv1.3'));
  assert.ok(report.tlsServerNames.includes('mu-proxy.test') && report.tlsServerNames.includes('wrong-proxy.test'));
  assert.ok(report.authenticationRejections >= 2 && report.successfulConnects >= 3);
  assert.deepEqual(report.destinationReceipts.map((row: any) => row.path).sort(), ['/host-positive', '/valid', '/recovered', '/cleartext-positive'].sort());
  assert.ok(report.destinationReceipts.every((row: any) => row.expectedBody));
  for (const label of ['wrong-ca', 'wrong-name', 'wrong-credentials']) assert.equal(report[label].failedClosed, true);
  assert.equal(report.proxyLoss.failedClosed, true);
  const markers = JSON.parse(await readFile(path.join(directory, 'test-markers.json'), 'utf8'));
  const protectedCaptures = ['valid', 'wrong-ca', 'wrong-name', 'wrong-credentials', 'proxy-loss'];
  assert.deepEqual((await readdir(directory)).filter(file => file.endsWith('.pcap')).sort(), [...protectedCaptures, 'cleartext-positive'].map(name => `${name}.pcap`).sort());
  const captures = [];
  for (const name of protectedCaptures) {
    const file = path.join(directory, `${name}.pcap`), data = await readFile(file);
    const observation = name === 'valid' ? report.validCapture : name === 'proxy-loss' ? report.proxyLoss.capture : report[name].capture;
    assert.equal(data.length, observation.bytes); assert.equal(observation.approvedProxyPackets, 0);
    const allowed = '(tcp and port 22 and host 192.168.5.2) or (udp and ((src port 68 and dst port 67) or (src port 67 and dst port 68)))';
    const all = (await packetLines(file, 'ip or ip6')).length;
    const outgoingSsh = (await packetLines(file, 'tcp and src port 22 and dst host 192.168.5.2')).length;
    const incomingSsh = (await packetLines(file, 'tcp and dst port 22 and src host 192.168.5.2')).length;
    const unapproved = (await packetLines(file, `(ip or ip6) and not (${allowed})`)).length;
    assert.ok(all > 0 && outgoingSsh > 0 && incomingSsh > 0); assert.equal(unapproved, 0);
    assert.equal(outgoingSsh, observation.approvedSshPackets);
    for (const value of Object.values(markers)) assert.equal(data.includes(Buffer.from(value as string)), false);
    captures.push({ name, sha256: hash(data), packets: all, outgoingSsh, incomingSsh, unapproved });
  }
  const cleartext = await readFile(path.join(directory, 'cleartext-positive.pcap'));
  assert.ok(cleartext.includes(Buffer.from(markers.requestMarker)) && cleartext.includes(Buffer.from(markers.responseMarker)));
  assert.equal(cleartext.length, report.cleartextCapturePositiveControl.bytes);
  const evidence = { passed: true, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes),
    packageCdHash: report.packageCdHash, compiledModulesVerified: modules.length, captures,
    cleartextPositiveControl: true, actualGuestTlsAndAuthenticationFaultsVerified: true, temporaryResourcesRemoved: true,
    verifierSha256: hash(await readFile(path.join(root, 'scripts/verify-encrypted-upstream-evidence.ts'))),
    scope: 'Frozen packaged modules, real isolated Linux VM and authenticated TLS CONNECT, certificate/name/credential failures, proxy loss/recovery, five encrypted physical captures and a separate unprotected cleartext control; no UI, residential or day-long claim' };
  await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 }); console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  const failed = { passed: false, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), error: (error as Error).stack };
  await writeFile(output, JSON.stringify(failed, null, 2), { mode: 0o600 }); console.error(JSON.stringify(failed, null, 2)); process.exitCode = 1;
}
