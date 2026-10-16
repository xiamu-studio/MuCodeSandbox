import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const transport = process.argv.includes('--transport');
const reportName = transport ? 'socks-upstream-transport' : 'socks-upstream';
const runtimeBytes = await readFile(path.join(root, `test-results/${reportName}.json`));
const runtime = JSON.parse(runtimeBytes.toString());
const directory = transport ? runtime.artifactsDirectory : path.join(root, 'test-results/socks-upstream');
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), captures: [] };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const labels = ['valid', 'wrong-password', 'wrong-user', 'missing-auth', 'no-auth-server', 'dns-name-failure', 'proxy-loss'];

try {
  assert.equal(runtime.passed, true, 'Complete the runtime verification first');
  assert.equal(runtime.accountFree, true);
  assert.equal(runtime.paidModelCalls, 0);
  if (transport) {
    assert.equal(runtime.proxyTransportPackageTested, true); assert.equal(runtime.temporaryVmDataRemoved, true);
    assert.equal(runtime.cleanupError, undefined); assert.equal(runtime.packagedApplicationTested, false);
    assert.equal(path.dirname(directory), path.join(root, 'test-results')); assert.match(path.basename(directory), /^socks-upstream-transport-\d+$/);
    assert.deepEqual(runtime, JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')));
    const bundle = path.join(root, 'release/proxy-transport-guard-candidate/mac-arm64/MuCodeSandbox.app');
    assert.equal(runtime.bundle, bundle); await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
    assert.equal(runtime.packageCdHash, '7395e50362e01c36299c4eacabe0cbedb636cf22');
    assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], runtime.packageCdHash);
    const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
    const modules = (await readdir(compiled)).filter(file => file.endsWith('.js')).sort();
    assert.deepEqual(Object.keys(runtime.modules).sort(), modules);
    for (const file of modules) {
      assert.equal(hash(await readFile(path.join(compiled, file))), runtime.modules[file]);
      assert.equal(hash(await readFile(path.join(root, 'dist-server/server', file))), runtime.modules[file]);
    }
    for (const [file, expected] of Object.entries(runtime.artifacts)) {
      assert.equal(path.basename(file), file); assert.equal(hash(await readFile(path.join(directory, file))), expected);
    }
    for (const flag of ['independentCurlAuthenticationControls', 'plainApplicationsDnsAndHttps', 'unauthenticatedServerWorks', 'dnsCertificateFailureClosed', 'serverRecoveryAndVmRestart', 'socksPlaintextOnlyInsideGuestCapture']) assert.equal(runtime[flag], true, flag);
    assert.equal(runtime.socksCredentialsAndPlainHttpVisible, false);
    for (const label of ['valid', 'python', 'no-auth-server', 'authenticated-recovery', 'numeric-with-bad-dns', 'server-recovered', 'vm-restarted']) assert.ok(runtime.destinationPaths.includes(`/${label}`), label);
    for (const label of ['host-wrong', 'host-no-auth', 'wrong-password', 'wrong-user', 'missing-auth', 'proxy-loss']) assert.ok(!runtime.destinationPaths.includes(`/${label}`), label);
    report.packageCdHash = runtime.packageCdHash; report.compiledModulesVerified = modules.length;
    report.reportSha256 = hash(runtimeBytes); report.proxyTransportPackageTested = true;
    report.verifierSha256 = hash(await readFile(import.meta.filename));
    report.scope = 'Frozen packaged modules, real SOCKS client/server VMs, authentication faults, system DNS/HTTPS, outage/restart and seven dual-interface captures; plaintext exists inside the guest but is absent from its physical SSH path. No Electron UI, browser/CLI, residential, day-long or Mac sleep claim.';
  }
  for (const [file, expected] of Object.entries(runtime.testedFiles)) {
    assert.equal(hash(await readFile(path.join(root, file))), expected, `Tested source changed: ${file}`);
  }
  const endpoints = runtime.finalProtection.proxyEndpoints;
  assert.equal(endpoints.length, 1);
  assert.match(endpoints[0], transport ? /^127\.0\.0\.1:\d+$/ : /^192\.168\.5\.2:\d+$/);
  const port = Number(endpoints[0].split(':')[1]);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  assert.deepEqual(Object.keys(runtime.captures).sort(), [...labels].sort());

  for (const label of labels) {
    const evidence = runtime.captures[label];
    const file = path.join(directory, `${label}.pcap`);
    const physicalFile = path.join(directory, `${label}-physical.pcap`);
    await chmod(file, 0o600); await chmod(physicalFile, 0o600);
    const bytes = await readFile(file), physicalBytes = await readFile(physicalFile);
    assert.equal(hash(bytes), evidence.sha256);
    assert.equal(bytes.length, evidence.bytes);
    assert.equal(hash(physicalBytes), evidence.physicalSha256);
    assert.equal(physicalBytes.length, evidence.physicalBytes);
    const index = evidence.interfaceIndex;
    assert.ok(Number.isInteger(index) && index > 0);
    for (const capture of [bytes, physicalBytes]) {
      const magic = capture.subarray(0, 4).toString('hex');
      assert.ok(['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(magic));
      const little = ['d4c3b2a1', '4d3cb2a1'].includes(magic);
      assert.equal((little ? capture.readUInt32LE(20) : capture.readUInt32BE(20)) & 0xffff, 276, 'Interface and direction checks require Linux cooked v2');
    }
    const count = async (source: string, filter: string) => {
      const output = await run('/usr/sbin/tcpdump', ['-nn', '-r', source, filter], { timeoutMs: 30_000, maxBytes: 16_000_000 });
      return output.split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line)).length;
    };
    const physical = `ifindex ${index}`;
    const proxy = `tcp and dst host 192.168.5.2 and dst port ${port}`;
    const management = 'tcp and src port 22 and dst host 192.168.5.2';
    const dhcp = 'udp and src port 68 and dst port 67';
    const outgoing = `(${physical}) and outbound`;
    const [all, approved, rejected, wrongInterface, inbound] = await Promise.all([
      count(file, `(${outgoing}) and (ip or ip6)`),
      count(file, `(${outgoing}) and (${transport ? management : proxy})`),
      count(file, `(${outgoing}) and (ip6 or (ip and not (${transport ? '' : `(${proxy}) or `}(${management}) or (${dhcp}))))`),
      count(physicalFile, `not (${physical})`),
      count(physicalFile, transport ? 'inbound and tcp and src host 192.168.5.2 and dst port 22' : `inbound and tcp and src host 192.168.5.2 and src port ${port}`),
    ]);
    assert.ok(all > 0 && approved > 0, `Missing outgoing positive control: ${label}`);
    assert.equal(rejected, 0, `Unapproved outgoing traffic: ${label}`);
    assert.equal(wrongInterface, 0, `Physical capture contains another interface: ${label}`);
    assert.equal(all, evidence.physicalIpPackets);
    assert.equal(approved, transport ? evidence.approvedSshPackets : evidence.approvedProxyPackets);
    if (transport) assert.equal(evidence.approvedProxyPackets, 0);
    assert.equal(evidence.physicalCaptureDirections, 'both');
    if (['valid', 'no-auth-server'].includes(label)) assert.ok(inbound > 0, `Missing inbound SOCKS positive control: ${label}`);
    if (label === 'valid') {
      for (const text of ['mu:socks@fixture', 'p@ss:/#?&=', 'MU_SOCKS_']) {
        assert.ok((transport ? bytes : physicalBytes).includes(Buffer.from(text)));
        if (transport) assert.equal(physicalBytes.includes(Buffer.from(text)), false);
      }
    }
    report.captures.push({ label, sha256: hash(bytes), physicalSha256: hash(physicalBytes), interfaceIndex: index, outgoingIpPackets: all, outgoingProxyPackets: transport ? 0 : approved, outgoingSshPackets: transport ? approved : undefined, incomingTransportPackets: inbound, unapprovedOutgoingPackets: rejected });
  }
  report.passed = true;
} catch (error) {
  report.error = (error as Error).stack; process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'capture-audit.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
