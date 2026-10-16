import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const artifacts = path.join(root, 'test-results/wireguard-workloads');
const runtime = JSON.parse(await readFile(path.join(root, 'test-results/wireguard-workloads.json'), 'utf8'));
assert.equal(runtime.passed, true);
assert.equal(runtime.workloads.passed, true);
assert.equal(runtime.packagedWorkloads.passed, true);
const endpoint = runtime.initialProtection.proxyEndpoints[0];
assert.match(endpoint, /^192\.168\.5\.2:\d+$/);
const port = Number(endpoint.split(':')[1]); assert.ok(port > 0 && port <= 65535);
const index = Number(process.argv.find(arg => arg.startsWith('--interface-index='))?.split('=')[1]);
assert.ok(Number.isInteger(index) && index > 0, 'Supply the actual guest eth0 interface index');
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), physicalInterfaceIndex: index, captures: [] };
const packetLines = (text: string) => text.split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line));
const udp = `udp and dst host 192.168.5.2 and dst port ${port}`;
const ssh = 'tcp and src port 22 and dst host 192.168.5.2';
const dhcp = 'udp and src port 68 and dst port 67';
try {
  for (const name of ['first-boot.pcap', 'workloads.pcap', 'physical.pcap', 'packaged-workloads.pcap']) {
    const file = path.join(artifacts, name), bytes = await readFile(file);
    const magic = bytes.subarray(0, 4).toString('hex');
    assert.ok(['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(magic));
    const little = ['d4c3b2a1', '4d3cb2a1'].includes(magic);
    const linkType = (little ? bytes.readUInt32LE(20) : bytes.readUInt32BE(20)) & 0xffff;
    assert.ok(linkType === 276 || linkType === 1);
    // Linux cooked captures encode interface index and direction; Ethernet is already captured with -Q out.
    const physical = linkType === 276 ? `ifindex ${index} and outbound` : 'len >= 0';
    const select = async (filter: string) => {
      const result = await execFileAsync('/usr/sbin/tcpdump', ['-nn', '-r', file, `(${physical}) and (${filter})`], { timeout: 30_000, maxBuffer: 64_000_000 });
      return packetLines(result.stdout);
    };
    const [packets, transport, management, rejected] = await Promise.all([
      select('ip or ip6'), select(udp), select(ssh),
      select(`ip6 or (ip and not ((${udp}) or (${ssh}) or (${dhcp})))`),
    ]);
    assert.ok(packets.length > 0 && management.length > 0, `Positive management traffic evidence missing: ${name}`);
    if (name !== 'first-boot.pcap') assert.ok(transport.length > 0, `Positive tunnel traffic evidence missing: ${name}`);
    assert.deepEqual(rejected, [], `Unexpected physical protocol or destination: ${name}`);
    if (name === 'first-boot.pcap') assert.ok((await select(dhcp)).length > 0, 'First-boot DHCP must identify the selected physical interface');
    report.captures.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), linkType, physicalIpPackets: packets.length, approvedPeerUdpPackets: transport.length, managementTcpPackets: management.length, unapprovedPackets: rejected.length });
  }
  report.passed = true;
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(artifacts, 'capture-audit.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
