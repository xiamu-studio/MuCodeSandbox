import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, 'test-results/wireguard-faults-bridge-owner.json');
const bytes = await readFile(file), source = JSON.parse(bytes.toString());
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const expectedHash = '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3';
const bundle = path.join(root, 'release/bridge-owner-candidate/mac-arm64/MuCodeSandbox.app');
const appRoot = path.join(bundle, 'Contents/Resources/app');
const report: Record<string, any> = { passed: false, verifiedAt: new Date().toISOString(),
  reportSha256: hash(bytes), cdHash: expectedHash, captures: [],
  scope: 'Current frozen-module two-VM WireGuard fault observations, four raw outbound physical captures and initial boot capture; no actual Electron UI/browser/CLI, capture of every restart, physical sleep/network switch, residential line or twenty-four-hour claim' };
try {
  assert.equal(source.passed, true); assert.equal(source.accountFree, true); assert.equal(source.paidModelCalls, 0);
  assert.equal(source.packageCdHash, expectedHash); assert.equal(source.bundle, bundle);
  assert.equal(source.inputsUnchanged, true); assert.equal(source.testResourcesRemoved, true);
  assert.equal(source.actualTwoVmHandshakeAndHttp, true); assert.equal(source.privateKeyRootOnly, true);
  assert.equal(source.systemDnsAndVerifiedHttps, true); assert.equal(source.physicalInterfaceIndex, 2);
  assert.equal(source.initialProtection.active, true); assert.equal(source.initialProtection.policy, 'packet-tunnel');
  assert.match(source.endpoint, /^192\.168\.5\.2:[1-9]\d{0,4}$/);
  const port = Number(source.endpoint.split(':')[1]); assert.ok(port <= 65535);
  assert.equal(source.initialProtection.proxyEndpoints[0], source.endpoint);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  assert.equal((await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1], expectedHash);
  assert.equal(Object.keys(source.modules).length, 45);
  for (const [name, digest] of Object.entries(source.modules)) {
    assert.match(name, /^[a-z][a-z-]*\.js$/);
    assert.equal(hash(await readFile(path.join(appRoot, 'dist-server/server', name))), digest);
  }
  assert.deepEqual(source.sources, source.initialSources);
  const directory = await realpath(source.artifactsDirectory), resultRoot = await realpath(path.join(root, 'test-results'));
  assert.ok(directory.startsWith(`${resultRoot}/wireguard-faults-bridge-owner-`));
  for (const [name, digest] of Object.entries(source.artifacts)) {
    assert.equal(path.basename(name), name);
    const artifact = await realpath(path.join(directory, name)); assert.ok(artifact.startsWith(`${directory}/`));
    assert.equal(hash(await readFile(artifact)), digest, name);
  }
  for (const [name, digest] of Object.entries(source.sources)) {
    assert.ok(['scripts/verify-wireguard-runtime.ts', 'scripts/wireguard-faults.ts', 'scripts/packet-capture.ts', 'scripts/seed-protected-test-base.ts'].includes(name));
    assert.equal(hash(await readFile(path.join(directory, `source-${path.basename(name)}`))), digest);
  }
  const faults = JSON.parse(await readFile(path.join(directory, 'faults.json'), 'utf8'));
  assert.deepEqual(faults, source.faults); assert.equal(faults.passed, true);
  assert.equal(faults.accountFree, true); assert.equal(faults.paidModelCalls, 0);
  assert.deepEqual(faults.scenarios.map((row: any) => row.name), ['networkd-dhcp', 'dns-corruption', 'lease-storage-full', 'peer-outage']);
  const udp = `udp and dst host 192.168.5.2 and dst port ${port}`;
  const ssh = 'tcp and src port 22 and dst host 192.168.5.2';
  const dhcp = 'udp and src port 68 and dst port 67';
  async function capture(name: string, boot: boolean, recorded?: any) {
    const target = path.join(directory, name), data = await readFile(target);
    assert.ok(data.length > 24); const magic = data.subarray(0, 4).toString('hex');
    assert.ok(['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(magic));
    const little = magic === 'd4c3b2a1' || magic === '4d3cb2a1';
    const linkType = (little ? data.readUInt32LE(20) : data.readUInt32BE(20)) & 0xffff;
    assert.equal(linkType, boot ? 276 : 1);
    const physical = boot ? 'ifindex 2 and outbound and' : '';
    const packets = await packetLines(target, `${physical} (ip or ip6)`);
    const approved = await packetLines(target, `${physical} (${udp})`);
    const rejected = await packetLines(target, `${physical} (ip6 or (ip and not ((${udp}) or (${ssh}) or (${dhcp}))))`);
    assert.ok(packets.length > 0); assert.deepEqual(rejected, [], name);
    if (boot) {
      assert.ok((await packetLines(target, `${physical} (${ssh})`)).length > 0);
      assert.ok((await packetLines(target, `${physical} (${dhcp})`)).length > 0);
      assert.equal(data.length, source.firstBootCapture.bytes);
      assert.equal(packets.length, source.firstBootCapture.physicalOutputPackets);
    } else {
      assert.ok(approved.length > 0); assert.equal(data.length, recorded.bytes);
      assert.equal(hash(data), recorded.sha256); assert.equal(approved.length, recorded.approvedUdpPackets);
      assert.equal(recorded.approvedManagementSshExcludedToPreventCaptureFeedback, true);
    }
    report.captures.push({ name, bytes: data.length, sha256: hash(data), linkType,
      physicalPackets: packets.length, approvedUdpPackets: approved.length, unapprovedPackets: rejected.length,
      managementSshExcluded: !boot });
  }
  await capture('first-boot.pcap', true);
  for (const row of faults.scenarios) {
    assert.equal(row.passed, true); assert.ok(!row.error && !row.captureError);
    assert.ok(Date.parse(row.finishedAt) > Date.parse(row.startedAt));
    assert.equal(row.beforeResponse, 'MU_PACKET_RUNTIME_OK');
    assert.equal(row.capturedPositiveResponse, 'MU_PACKET_RUNTIME_OK');
    assert.equal(row.afterResponse, 'MU_PACKET_RUNTIME_OK');
    assert.equal(row.capture.file, `${row.name}.pcap`); await capture(row.capture.file, false, row.capture);
  }
  const [network, dns, storage, peer] = faults.scenarios;
  assert.equal(network.networkdRestartAndDhcpRenew, true); assert.equal(network.protectionUnchanged, true);
  assert.ok(network.beforeAddress.some((row: any) => row.ifname === 'eth0' && row.addr_info.length));
  assert.ok(network.afterAddress.some((row: any) => row.ifname === 'eth0' && row.addr_info.length));
  assert.equal(dns.automaticQuarantine, true); assert.equal(dns.normalRestartRepairsDns, true);
  assert.match(storage.actualRenewalError, /No space left on device/);
  assert.equal(storage.kernelPermissionClosedWithHostTimerPaused, true);
  assert.equal(storage.existingAndNewBusinessBlocked, true); assert.equal(storage.restartAfterStorageFailure, true);
  assert.ok(peer.newBusinessFailureMs > 0 && peer.newBusinessFailureMs < 20_000);
  assert.equal(peer.existingFlowStalled, true); assert.ok(peer.automaticStopMs >= 150_000 && peer.automaticStopMs < 250_000);
  assert.ok(peer.peerDropCounter.nftables.some((row: any) => row.counter?.packets > 0));
  assert.equal(peer.normalRestartAfterPeerRecovery, true);
  const logs = JSON.parse(await readFile(path.join(directory, 'application-logs.json'), 'utf8'));
  assert.ok(logs.some((row: any) => row.message.includes('受控 DNS 配置失效')));
  assert.ok(logs.some((row: any) => row.message.includes('隧道对端握手已失效')));
  report.modulesVerified = 45; report.faultScenariosVerified = faults.scenarios.map((row: any) => row.name);
  report.peerAutomaticStopMs = peer.automaticStopMs; report.temporaryResourcesRemoved = true;
  report.verifierSha256 = hash(await readFile(import.meta.filename)); report.passed = true;
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
await writeFile(path.join(root, 'test-results/wireguard-faults-bridge-owner-evidence.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
