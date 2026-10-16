import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import type { Job } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(homedir(), '.mu-transparent-verification-'));
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const manager = new Manager(temporary, undefined, new LimaRuntime(temporary));
const report: Record<string, unknown> = { passed: false, startedAt: new Date().toISOString() };
const sockets = new Set<Socket>();
const connects: string[] = [];
let targetHits = 0;
const target = createServer((req, res) => {
  targetHits++;
  if (req.url?.startsWith('/repo.git/info/refs')) { res.setHeader('Content-Type', 'text/plain'); res.end('1111111111111111111111111111111111111111\trefs/heads/main\n'); }
  else if (req.url === '/repo.git/HEAD') res.end('ref: refs/heads/main\n');
  else res.end('MU_TRANSPARENT_FIXTURE_OK');
});
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const targetPort = (target.address() as { port: number }).port;
const proxy = createServer((req, res) => {
  if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('mu:verification').toString('base64')}`) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Mu verification"' }); res.end(); return; }
  const headers = { ...req.headers }; delete headers['proxy-authorization'];
  const remote = httpRequest(new URL(req.url!), { method: req.method, headers }, response => { res.writeHead(response.statusCode!, response.headers); response.pipe(res); });
  remote.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(remote);
});
proxy.on('connect', (req, client, head) => {
  if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('mu:verification').toString('base64')}`) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
  connects.push(req.url!);
  const destination = new URL(`https://${req.url}`);
  const fixture = destination.hostname === '203.0.113.10';
  const remote = connect(fixture ? targetPort : Number(destination.port) || 443, fixture ? '127.0.0.1' : destination.hostname, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) remote.write(head);
    client.pipe(remote); remote.pipe(client);
  });
  sockets.add(remote); remote.on('close', () => sockets.delete(remote));
  remote.on('error', () => client.destroy()); client.on('error', () => remote.destroy()); client.on('close', () => remote.destroy());
});
proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = (proxy.address() as { port: number }).port;
const e = await manager.create({ name: '透明网络实机验证', cpus: 2, memoryGiB: 2, diskGiB: 10, identity: { timezone: 'Asia/Tokyo', locale: 'ja-JP' }, network: { mode: 'http', host: '127.0.0.1', port: proxyPort, username: 'mu', password: 'verification', noProxy: '', strict: true, transparent: true } });
async function finish(job: Job) {
  await manager.tasks.get(job.id)?.promise;
  const done = manager.store.jobs().find(j => j.id === job.id)!;
  if (done.status !== 'succeeded') { report.failedAction = job.action; report.logs = manager.store.logs(e.id).slice(-15); }
  assert.equal(done.status, 'succeeded', done.message);
}
const guest = (command: string[], timeoutMs = 30_000) => manager.runtime.guest(manager.store.get(e.id), command, { timeoutMs });
const status = () => manager.runtime.networkProtection(manager.store.get(e.id));
const fixtureRequest = () => guest(['curl', '--fail', '--silent', '--max-time', '5', '--proxy', '', '--noproxy', '*', 'http://203.0.113.10/']);
async function closeProxy() {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => proxy.close(() => resolve()));
}
try {
  console.log('Starting a disposable VM with a transparent authenticated proxy.');
  await finish(await manager.lifecycle(e.id, 'start'));
  report.initialProtection = await status(); assert.ok((report.initialProtection as {active:boolean;transparentActive:boolean}).active && (report.initialProtection as {transparentActive:boolean}).transparentActive,JSON.stringify(report.initialProtection));
  assert.equal((await guest(['bash', '-lc', 'printf "%s|%s|%s" "$HTTP_PROXY" "$HTTPS_PROXY" "$ALL_PROXY"'])).trim(), '||');
  assert.equal((await fixtureRequest()).trim(), 'MU_TRANSPARENT_FIXTURE_OK');
  report.curlWithoutProxySettings = true;
  assert.match(await guest(['python3', '-c', "import socket\ns=socket.create_connection(('203.0.113.10',80),5);s.sendall(b'GET /python HTTP/1.0\\r\\nHost: fixture\\r\\n\\r\\n');s.settimeout(5);r=b''\nwhile True:\n b=s.recv(4096)\n if not b: break\n r+=b\nprint(r.decode())"]), /MU_TRANSPARENT_FIXTURE_OK/);
  report.rawPythonTcpUsesProxy = true;
  console.log('Checking system DNS and TLS through the upstream proxy.');
  assert.match(await guest(['getent', 'ahostsv4', 'example.com']), /STREAM/);
  assert.ok(connects.includes('1.1.1.1:443')); report.systemDnsUsesProxyDoh = true;
  assert.match(await guest(['curl', '--fail', '--silent', '--max-time', '15', '--proxy', '', 'https://example.com/']), /Example Domain/);
  report.httpsUsesProxy = true;
  console.log('Installing test tools through the tunnel and inspecting physical-interface traffic.');
  await guest(['mu-install', 'git', 'nodejs'], 180_000);
  await manager.runtime.management(manager.store.get(e.id), ['sudo', 'apt-get', 'install', '-y', '-qq', 'tcpdump'], { timeoutMs: 180_000 });
  report.packageManagerUsesTransparentNetwork = true;
  const gateway = (await guest(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+)/)![1];
  await manager.runtime.management(manager.store.get(e.id), ['bash', '-c', "sudo tcpdump -ni eth0 -Q out -U -w /tmp/mu-network.pcap 'ip or ip6' >/tmp/mu-capture.log 2>&1 < /dev/null & echo $! > /tmp/mu-capture.pid; sleep 1"]);
  const gitBefore = connects.length;
  assert.match(await guest(['git', '-c', 'http.proxy=', 'ls-remote', 'http://203.0.113.10/repo.git']), /1111111111111111111111111111111111111111\s+refs\/heads\/main/);
  assert.ok(connects.length > gitBefore); report.gitWithoutProxySettings = true;
  assert.match(await guest(['node', '-e', "require('http').get('http://203.0.113.10/node',r=>{let s='';r.on('data',b=>s+=b);r.on('end',()=>console.log(s))}).on('error',()=>process.exit(1))"]), /MU_TRANSPARENT_FIXTURE_OK/);
  report.nodeWithoutProxySettings = true;
  const hits = targetHits;
  const before = (await status()).blockedPackets;
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--proxy', '', `http://${gateway}:${targetPort}/direct`]));
  assert.equal(targetHits, hits); assert.ok((await status()).blockedPackets > before); report.directHostConnectionBlocked = true;
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--proxy', `http://mu:verification@${gateway}:${proxyPort}`, 'http://203.0.113.10/']));
  report.proxyEndpointRestrictedToServiceUid = true;
  const udpBefore = (await status()).blockedPackets;
  await guest(['python3', '-c', "import socket\ns=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(1)\ntry:\n s.sendto(b'blocked',('8.8.8.8',443));s.recv(1024);raise RuntimeError('Unexpected UDP response')\nexcept (socket.timeout,PermissionError): pass"]);
  assert.ok((await status()).blockedPackets > udpBefore); report.nonDnsUdpBlocked = true;
  const dnsBefore = (await status()).blockedPackets;
  await manager.runtime.management(manager.store.get(e.id), ['sudo', 'python3', '-c', "import socket\ns=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,b'eth0');s.settimeout(1)\ntry:\n s.sendto(b'\\x00'*20,('8.8.8.8',53));s.recv(1024);raise RuntimeError('Unexpected physical DNS response')\nexcept (socket.timeout,PermissionError): pass"]);
  assert.ok((await status()).blockedPackets > dnsBefore); report.physicalDnsBypassBlocked = true;
  const ipv6Before = (await status()).blockedPackets;
  await manager.runtime.management(manager.store.get(e.id), ['bash', '-s'], { input: `set -eu\nsudo ip link add mu6test type dummy\ntrap 'sudo ip -6 rule del priority 8000; sudo ip link del mu6test' EXIT\nsudo ip link set mu6test up\nsudo ip -6 addr add fd77::1/64 dev mu6test\nsudo ip -6 rule add priority 8000 to fd77::/64 lookup main\npython3 - <<'PY'\nimport socket\ns=socket.socket(socket.AF_INET6,socket.SOCK_DGRAM)\ntry: s.sendto(b'blocked',('fd77::2',53))\nexcept PermissionError: pass\nPY\n`, timeoutMs: 30_000 });
  assert.ok((await status()).blockedPackets > ipv6Before); report.ipv6BlockedWithRoute = true;
  await manager.runtime.management(manager.store.get(e.id), ['bash', '-c', 'sudo kill -INT "$(cat /tmp/mu-capture.pid)"; sleep 1']);
  const unapproved = await manager.runtime.management(manager.store.get(e.id), ['sudo', 'tcpdump', '-nn', '-r', '/tmp/mu-network.pcap', `not (tcp dst port ${proxyPort} and dst host ${gateway}) and not tcp src port 22 and not (udp src port 68 and udp dst port 67)`]);
  assert.ok(!unapproved.split('\n').some(line => /^\d\d:\d\d:\d\d/.test(line)), unapproved);
  const approved = await manager.runtime.management(manager.store.get(e.id), ['sudo', 'tcpdump', '-nn', '-r', '/tmp/mu-network.pcap', `tcp dst port ${proxyPort} and dst host ${gateway}`]);
  assert.ok(approved.split('\n').some(line => /^\d\d:\d\d:\d\d/.test(line)));
  report.physicalCaptureOnlyProxyAndManagement = true;
  console.log('Checking proxy loss, tunnel shutdown and recovery.');
  await closeProxy();
  await assert.rejects(fixtureRequest());
  const downHits = targetHits;
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--proxy', '', `http://${gateway}:${targetPort}/after-proxy-loss`]));
  assert.equal(targetHits, downHits); report.proxyLossHasNoDirectFallback = true;
  await manager.runtime.management(manager.store.get(e.id), ['sudo', 'systemctl', 'stop', 'mucodesandbox-tunnel.service']);
  const stopped = await status();
  assert.ok(stopped.firewallActive && !stopped.transparentActive && !stopped.active); report.stoppedTunnelDetected = true;
  await assert.rejects(fixtureRequest());
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--proxy', '', `http://${gateway}:${targetPort}/after-tunnel-loss`]));
  assert.equal(targetHits, downHits); report.tunnelLossHasNoDirectFallback = true;
  await manager.monitorProtection();
  await Promise.all([...manager.quarantines.values()]);
  assert.equal(manager.store.get(e.id).state,'error');
  assert.equal((await manager.runtime.list()).find(instance=>instance.name===e.instanceName)?.status,'Stopped');
  report.tunnelFailureQuarantinesBeforeRecovery=true;
  await new Promise<void>(resolve => proxy.listen(proxyPort, '127.0.0.1', resolve));
  await finish(await manager.lifecycle(e.id, 'restart'));
  assert.equal((await fixtureRequest()).trim(), 'MU_TRANSPARENT_FIXTURE_OK');
  assert.match(await guest(['getent', 'ahostsv4', 'example.com']), /STREAM/);
  assert.ok((await status()).active); report.restartRestoresTransparentNetwork = true;
  report.finalProtection = await status();
  await finish(await manager.lifecycle(e.id, 'stop'));
  const marker = JSON.parse(await readFile(path.join(temporary, 'security', `${e.instanceName}.json`), 'utf8'));
  assert.equal(marker.conservative, true); report.stopPersistsClosedEgress = true;
  const saved = manager.store.get(e.id);
  await manager.update(e.id, { name: saved.name, cpus: saved.cpus, memoryGiB: saved.memoryGiB, diskGiB: saved.diskGiB, identity: saved.identity, network: { mode: 'direct', host: '', port: proxyPort, username: '', password: '', noProxy: 'localhost,127.0.0.1', strict: false, transparent: false } });
  await finish(await manager.lifecycle(e.id, 'start'));
  assert.ok(!(await status()).firewallActive && !(await status()).transparentActive);
  assert.equal((await guest(['curl', '--fail', '--silent', '--max-time', '5', '--proxy', '', `http://${gateway}:${targetPort}/explicit-direct-mode`])).trim(), 'MU_TRANSPARENT_FIXTURE_OK');
  assert.match(await guest(['getent', 'ahostsv4', 'example.com']), /STREAM/);
  report.explicitDirectModeRestoresNetworkAndDns = true;
  await finish(await manager.lifecycle(e.id, 'stop'));
  report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  await Promise.all([...manager.quarantines.values()]);
  if (!report.passed && process.env.MU_KEEP_FAILED_TRANSPARENT) report.cleanupError = 'Retained for diagnosis';
  else await manager.lifecycle(e.id, 'delete').then(finish).catch(error => { report.cleanupError = String(error); });
  await manager.close();
  for (const socket of sockets) socket.destroy();
  if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
  await new Promise<void>(resolve => target.close(() => resolve()));
  if (!report.cleanupError) await rm(temporary, { recursive: true, force: true });
  else report.retainedDataDir = temporary;
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/transparent-network.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
