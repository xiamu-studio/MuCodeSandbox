import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { pathToFileURL } from 'node:url';
import { Manager as SourceManager } from '../server/manager.ts';
import { buildLimaConfig } from '../server/lima-config.ts';
import { environmentSchema, redact } from '../server/validation.ts';
import { shellQuote } from '../server/network-guard.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256, SING_BOX_VERSION } from '../server/transparent-network.ts';
import { run } from '../server/process.ts';
import type { Environment, Job, NetworkConfig } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const transport = process.argv.includes('--transport');
const reportName = transport ? 'socks-upstream-transport' : 'socks-upstream';
const bundle = path.join(root, 'release/proxy-transport-guard-candidate/mac-arm64/MuCodeSandbox.app');
const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
const Manager: typeof SourceManager = transport ? (await import(pathToFileURL(path.join(compiled, 'manager.js')).href)).Manager : SourceManager;
const retained = process.env.MU_SOCKS_TEST_DATA;
if (retained) assert.ok(path.dirname(path.resolve(retained)) === homedir() && /^\.mu-socks-verification-[A-Za-z0-9]+$/.test(path.basename(retained)), 'Only this verifier\'s retained private directory may be reused');
assert.ok(!transport || !retained, 'Frozen package regression needs fresh test-owned VMs');
const temporary = retained ? path.resolve(retained) : await mkdtemp(path.join(homedir(), '.mu-socks-verification-'));
const artifacts = path.join(root, 'test-results', transport ? `${reportName}-${Date.now()}` : 'socks-upstream'); await mkdir(artifacts, { recursive: true, mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const manager = new Manager(temporary), runtime = manager.runtime;
const report: Record<string, any> = { passed: false, accountFree: true, paidModelCalls: 0, startedAt: new Date().toISOString(), residentialLineTested: false, packagedApplicationTested: false, proxyTransportPackageTested: transport, artifactsDirectory: artifacts, captures: {}, phases: [] };
report.testedFiles = Object.fromEntries(await Promise.all(['server/runtime.ts', 'server/network-guard.ts', 'server/transparent-network.ts', 'server/validation.ts', 'scripts/verify-socks-upstream.ts'].map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
const fixtureAddress = '203.0.113.86', marker = `MU_SOCKS_${randomBytes(12).toString('hex')}`;
const username = 'mu:socks@fixture', password = `p@ss:/#?&=${randomBytes(18).toString('hex')}`;
const requests: string[] = [];
const target = createServer((request, response) => { requests.push(request.url ?? ''); response.setHeader('Connection', 'close'); response.end(marker); });
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const targetPort = (target.address() as { port: number }).port;
const reservation = createTcpServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
const proxyPort = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
const gatewayId = randomUUID(), now = new Date().toISOString();
const gateway: Environment = { ...environmentSchema.parse({ name: 'Disposable SOCKS server', memoryGiB: 1, diskGiB: 10 }), id: gatewayId, instanceName: `mu-${gatewayId.replaceAll('-', '').slice(0, 16)}`, state: 'running', browserRunning: false, lastError: null, createdAt: now, updatedAt: now };
const network = (extra: Partial<NetworkConfig> = {}): NetworkConfig => ({ mode: 'socks5', host: '127.0.0.1', port: proxyPort, username, password, noProxy: '', strict: true, transparent: true, ...extra });
const client = await manager.create({ name: 'SOCKS5 real upstream verification', cpus: 2, memoryGiB: 2, diskGiB: 10, network: network() });
const current = () => manager.store.get(client.id);
const guest = (args: string[], timeoutMs = 15_000) => runtime.guest(current(), args, { timeoutMs });
const admin = (args: string[], input?: string) => runtime.management(current(), args, { input, timeoutMs: 30_000, maxBytes: 16_000_000 });
const gatewayAdmin = (args: string[], input?: string) => runtime.management(gateway, args, { input, timeoutMs: 30_000 });
function phase(message: string) { console.log(new Date().toISOString(), message); report.phases.push({ at: new Date().toISOString(), message }); }
async function finish(job: Job) {
  await manager.tasks.get(job.id)?.promise;
  const done = manager.store.jobs().find(entry => entry.id === job.id)!;
  assert.equal(done.status, 'succeeded', done.message);
}
async function configure(value: NetworkConfig) {
  await finish(await manager.lifecycle(client.id, 'stop'));
  const saved = current();
  await manager.update(client.id, { name: saved.name, cpus: saved.cpus, memoryGiB: saved.memoryGiB, diskGiB: saved.diskGiB, identity: saved.identity, network: value });
  await finish(await manager.lifecycle(client.id, 'start'));
}
async function server(authenticated = true) {
  const configuration = {
    log: { level: 'info', timestamp: true },
    inbounds: [{ type: 'socks', tag: 'socks', listen: '127.0.0.1', listen_port: 1080, users: authenticated ? [{ username, password }] : [] }],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { rules: [{ ip_cidr: [`${fixtureAddress}/32`], action: 'route', outbound: 'direct', override_address: '192.168.5.2', override_port: targetPort }], final: 'direct' },
  };
  await gatewayAdmin(['bash', '-s'], `set -eu
printf '%s' ${shellQuote(JSON.stringify(configuration))} | sudo tee /run/mu-socks-fixture/config.json >/dev/null
sudo chmod 0600 /run/mu-socks-fixture/config.json
sudo /run/mu-socks-fixture/sing-box check -c /run/mu-socks-fixture/config.json
sudo systemctl restart mu-socks-fixture.service
sudo systemctl is-active --quiet mu-socks-fixture.service
`);
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { assert.equal((await hostRequest('server-ready', authenticated ? { username, password } : null)).trim(), marker); break; }
    catch (error) { if (Date.now() >= deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
const request = (label: string) => guest(['curl', '-sS', '--fail', '--max-time', '5', '--proxy', '', '--noproxy', '*', `http://${fixtureAddress}/${label}`]);
async function hostRequest(label: string, credentials: { username: string; password: string } | null) {
  const proxy = new URL(`socks5h://127.0.0.1:${proxyPort}`);
  if (credentials) { proxy.username = credentials.username; proxy.password = credentials.password; }
  return run('/usr/bin/curl', ['-sS', '--fail', '--max-time', '5', '--config', '-'], { input: `proxy = ${JSON.stringify(proxy.href)}\nurl = ${JSON.stringify(`http://${fixtureAddress}/${label}`)}\n`, timeoutMs: 8000 });
}
async function captureStart(label: string) {
  await admin(['sudo', 'systemd-run', `--unit=mu-socks-capture-${label}`, '--property=Type=exec', '--property=TimeoutStopSec=10', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-U', '-s', '0', '-w', `/run/mu-socks-${label}.pcap`, 'ip or ip6']);
  await admin(['sleep', '0.3']);
  await admin(['sudo', 'systemctl', 'is-active', `mu-socks-capture-${label}.service`]);
}
async function captureStop(label: string, requiredText: string[] = []) {
  await admin(['sudo', 'systemctl', 'stop', `mu-socks-capture-${label}.service`]);
  const capture = Buffer.from((await admin(['sudo', 'base64', '-w0', `/run/mu-socks-${label}.pcap`])).trim(), 'base64');
  assert.ok(capture.length > 24);
  const file = path.join(artifacts, `${label}.pcap`); await writeFile(file, capture, { mode: 0o600 });
  const interfaceIndex = Number((await admin(['cat', '/sys/class/net/eth0/ifindex'])).trim());
  const physical = `ifindex ${interfaceIndex} and outbound`;
  const allowed = `${transport ? '' : `(tcp and dst host 192.168.5.2 and dst port ${proxyPort}) or `}(tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67)`;
  const packets = async (filter: string) => (await run('/usr/sbin/tcpdump', ['-nn', '-r', file, `(${physical}) and (${filter})`], { maxBytes: 16_000_000 })).split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line));
  const [all, proxy, ssh, unapproved] = await Promise.all([packets('ip or ip6'), packets(`tcp and dst port ${proxyPort}`), packets('tcp and src port 22 and dst host 192.168.5.2'), packets(`ip6 or (ip and not (${allowed}))`)]);
  assert.ok(all.length > 0 && (transport ? ssh.length : proxy.length) > 0); assert.deepEqual(unapproved, []);
  if (transport) assert.equal(proxy.length, 0);
  const physicalFile = path.join(artifacts, `${label}-physical.pcap`);
  await run('/usr/sbin/tcpdump', ['-r', file, '-w', physicalFile, `ifindex ${interfaceIndex} and (ip or ip6)`], { maxBytes: 100_000 });
  const physicalBytes = await readFile(physicalFile);
  for (const [index, text] of requiredText.entries()) {
    assert.ok((transport ? capture : physicalBytes).includes(Buffer.from(text)), `Required protocol evidence ${index + 1} absent in ${label}`);
    if (transport) assert.equal(physicalBytes.includes(Buffer.from(text)), false, 'SOCKS credentials or payload exposed outside SSH');
  }
  report.captures[label] = { sha256: createHash('sha256').update(capture).digest('hex'), bytes: capture.length, physicalSha256: createHash('sha256').update(physicalBytes).digest('hex'), physicalBytes: physicalBytes.length, physicalCaptureDirections: 'both', interfaceIndex, physicalIpPackets: all.length, approvedProxyPackets: proxy.length, approvedSshPackets: ssh.length, unapprovedPackets: 0 };
}
async function directDenied() {
  const before = (await runtime.networkProtection(current())).blockedPackets;
  const hits = requests.length;
  assert.equal((await admin(['sudo', 'python3', '-c', `import socket
s=socket.socket();s.settimeout(2);s.setsockopt(socket.SOL_SOCKET,25,b'eth0\\0')
try: s.connect(('192.168.5.2',${targetPort}));raise RuntimeError('Unapproved direct connection succeeded')
except TimeoutError: print('MU_DIRECT_BLOCKED')
`])).trim(), 'MU_DIRECT_BLOCKED');
  assert.ok((await runtime.networkProtection(current())).blockedPackets > before);
  assert.equal(requests.length, hits);
}

try {
  if (transport) {
    const disk = await statfs(temporary); assert.ok(disk.bavail * disk.bsize > 100 * 2 ** 30);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    report.packageCdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1];
    assert.equal(report.packageCdHash, '7395e50362e01c36299c4eacabe0cbedb636cf22'); report.bundle = bundle;
    report.modules = Object.fromEntries(await Promise.all((await readdir(compiled)).filter(file => file.endsWith('.js')).map(async file => [file, createHash('sha256').update(await readFile(path.join(compiled, file))).digest('hex')])));
    const cache = process.env.MU_TEST_SING_BOX_CACHE; assert.ok(cache); assert.equal(createHash('sha256').update(await readFile(cache)).digest('hex'), SING_BOX_SHA256);
    await mkdir(path.join(temporary, 'tools/sing-box'), { recursive: true }); await copyFile(cache, path.join(temporary, 'tools/sing-box', SING_BOX_ARCHIVE));
  }
  phase('Starting a new protected SOCKS client and preparing a separate real SOCKS server.');
  await finish(await manager.lifecycle(client.id, 'start'));
  const configuration = parse(buildLimaConfig(gateway));
  configuration.portForwards.unshift({ guestPort: 1080, hostPort: proxyPort, hostIP: '127.0.0.1', guestIP: '127.0.0.1', guestIPMustBeZero: false, proto: 'tcp' });
  const file = path.join(temporary, 'gateway.yaml'); await writeFile(file, stringify(configuration), { mode: 0o600 });
  await runtime.command(['start', '--name', gateway.instanceName, '--timeout', '15m', file], { timeoutMs: 950_000 });
  const archive = path.join(temporary, 'tools/sing-box', SING_BOX_ARCHIVE);
  assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), SING_BOX_SHA256);
  await runtime.command(['copy', archive, `${gateway.instanceName}:/tmp/mu-socks-fixture.tar.gz`], { timeoutMs: 60_000 });
  await gatewayAdmin(['bash', '-s'], `set -eu
sudo install -d -m 0700 /run/mu-socks-fixture
sudo tar -xzf /tmp/mu-socks-fixture.tar.gz -C /run/mu-socks-fixture --strip-components=1
sudo rm -f /tmp/mu-socks-fixture.tar.gz
sudo tee /etc/systemd/system/mu-socks-fixture.service >/dev/null <<'MU_UNIT'
[Unit]
Description=Disposable account-free SOCKS fixture
[Service]
ExecStart=/run/mu-socks-fixture/sing-box run -c /run/mu-socks-fixture/config.json
UMask=0077
MU_UNIT
sudo systemctl daemon-reload
`);
  await server();
  assert.equal((await hostRequest('host-positive', { username, password })).trim(), marker);
  await assert.rejects(hostRequest('host-wrong', { username, password: 'synthetic-wrong-password' }));
  await assert.rejects(hostRequest('host-no-auth', null));
  assert.equal(requests.filter(value => value.startsWith('/host-')).length, 1);
  report.independentCurlAuthenticationControls = true;
  phase('Checking plain applications, system DNS, HTTPS and plaintext SOCKS authentication evidence.');
  await captureStart('valid');
  assert.equal((await request('valid')).trim(), marker);
  assert.equal((await guest(['python3', '-c', `import urllib.request;print(urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://${fixtureAddress}/python',timeout=5).read().decode())`])).trim(), marker);
  const dns = await guest(['getent', 'ahostsv4', 'example.com']); assert.match(dns, /^\d+\.\d+\.\d+\.\d+\s/m);
  assert.match(await guest(['curl', '-sS', '--fail', '--max-time', '12', '--proxy', '', '--noproxy', '*', 'https://example.com/'], 15_000), /Example Domain/);
  await directDenied();
  await captureStop('valid', [username, password, marker]);
  report.plainApplicationsDnsAndHttps = true;
  report.socksCredentialsAndPlainHttpVisible = !transport;
  report.socksPlaintextOnlyInsideGuestCapture = transport;
  for (const variant of [
    { name: 'wrong-password', value: network({ password: 'synthetic-wrong-password' }), evidence: 'synthetic-wrong-password' },
    { name: 'wrong-user', value: network({ username: 'synthetic-wrong-user' }), evidence: 'synthetic-wrong-user' },
    { name: 'missing-auth', value: network({ username: '', password: '' }), evidence: '' },
  ]) {
    phase(`Checking fail-closed ${variant.name}.`);
    await configure(variant.value); await captureStart(variant.name);
    const hits = requests.length; await assert.rejects(request(variant.name)); await directDenied();
    assert.equal(requests.length, hits);
    await captureStop(variant.name, variant.evidence ? [variant.evidence] : []);
  }
  phase('Checking a genuinely unauthenticated SOCKS server.');
  await server(false); await captureStart('no-auth-server');
  assert.equal((await request('no-auth-server')).trim(), marker);
  await captureStop('no-auth-server', [marker]); report.unauthenticatedServerWorks = true;
  await server(); await configure(network());
  assert.equal((await request('authenticated-recovery')).trim(), marker);
  phase('Checking DNS certificate-name failure without physical DNS fallback.');
  await configure(network({ dns: { address: '1.1.1.1', serverName: 'mu-wrong-doh.invalid', port: 443, path: '/dns-query' } }));
  await captureStart('dns-name-failure');
  await admin(['sudo', 'resolvectl', 'flush-caches']);
  await assert.rejects(guest(['getent', 'ahostsv4', 'example.net'], 15_000));
  assert.equal((await request('numeric-with-bad-dns')).trim(), marker);
  await directDenied(); await captureStop('dns-name-failure', ['mu-wrong-doh.invalid']);
  report.dnsCertificateFailureClosed = true;
  await configure(network());
  assert.match(await guest(['getent', 'ahostsv4', 'example.net']), /^\d+\.\d+\.\d+\.\d+\s/m);
  phase('Checking SOCKS server loss, recovery and normal VM restart.');
  await captureStart('proxy-loss'); await gatewayAdmin(['sudo', 'systemctl', 'stop', 'mu-socks-fixture.service']);
  const hits = requests.length; await assert.rejects(request('proxy-loss')); await directDenied();
  assert.equal(requests.length, hits); await captureStop('proxy-loss');
  await server(); assert.equal((await request('server-recovered')).trim(), marker);
  await finish(await manager.lifecycle(client.id, 'restart'));
  assert.equal((await request('vm-restarted')).trim(), marker);
  report.finalProtection = await runtime.networkProtection(current());
  assert.ok(report.finalProtection.active && report.finalProtection.integrity === 'verified');
  report.serverRecoveryAndVmRestart = true;
  report.serverVersion = (await gatewayAdmin(['sudo', '/run/mu-socks-fixture/sing-box', 'version'])).split('\n')[0];
  assert.equal(report.serverVersion, `sing-box version ${SING_BOX_VERSION}`);
  await finish(await manager.lifecycle(client.id, 'stop'));
  if (transport) for (const [file, expected] of Object.entries(report.modules)) assert.equal(createHash('sha256').update(await readFile(path.join(compiled, file))).digest('hex'), expected);
  report.passed = true;
} catch (error) { report.error = redact((error as Error).stack ?? String(error)); report.logs = manager.store.logs(client.id).slice(-15); process.exitCode = 1; }
finally {
  for (const instance of await runtime.list().catch(() => [])) {
    try {
      if (instance.status === 'Running') await runtime.command(['stop', '--force', instance.name], { timeoutMs: 120_000 });
      if (report.passed) await runtime.command(['delete', '--force', instance.name], { timeoutMs: 120_000 });
    } catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
  }
  await manager.close();
  target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve()));
  if (report.passed) { await rm(temporary, { recursive: true, force: true }); report.temporaryVmDataRemoved = true; }
  else report.retainedDataDir = temporary;
  report.destinationPaths = requests; report.finishedAt = new Date().toISOString();
  if (transport) {
    await copyFile(path.join(root, 'scripts/verify-socks-upstream.ts'), path.join(artifacts, 'source-verify-socks-upstream.ts'));
    report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, createHash('sha256').update(await readFile(path.join(artifacts, file))).digest('hex')])));
    await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  await writeFile(path.join(root, `test-results/${reportName}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
