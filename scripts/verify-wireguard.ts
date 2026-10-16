import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { shellQuote } from '../server/network-guard.ts';
import { wireguardSchema, wireguardSetconf, wireguardNamespaceFirewall } from '../server/wireguard.ts';
import type { Job } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(homedir(), '.mu-wireguard-verification-'));
const artifacts = path.join(root, 'test-results/wireguard');
await mkdir(artifacts, { recursive: true, mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const manager = new Manager(temporary, undefined, new LimaRuntime(temporary));
const sockets = new Set<Socket>();
const credential = `Basic ${Buffer.from('mu:wireguard-fixture').toString('base64')}`;
const proxy = createServer((req, res) => {
  if (req.headers['proxy-authorization'] !== credential) { res.writeHead(407).end(); return; }
  const headers = { ...req.headers }; delete headers['proxy-authorization'];
  const remote = request(new URL(req.url!), { method: req.method, headers }, response => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
  remote.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(remote);
});
proxy.on('connect', (req, client, head) => {
  if (req.headers['proxy-authorization'] !== credential) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
  const destination = new URL(`https://${req.url}`);
  const remote = connect(Number(destination.port) || 443, destination.hostname, () => {
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
const environment = await manager.create({ name: '整包隧道内核验证', cpus: 2, memoryGiB: 2, diskGiB: 10, network: { mode: 'http', host: '127.0.0.1', port: proxyPort, username: 'mu', password: 'wireguard-fixture', noProxy: '', strict: true, transparent: true } });
const report: Record<string, unknown> = { passed: false, accountFree: true, paidModelCalls: 0, startedAt: new Date().toISOString(), productionModeImplemented: false, realPublicLineVerified: false };

async function finish(job: Job) {
  await manager.tasks.get(job.id)?.promise;
  const done = manager.store.jobs().find(item => item.id === job.id)!;
  assert.equal(done.status, 'succeeded', done.message);
}
function keys() {
  const pair = generateKeyPairSync('x25519');
  return { privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64'), publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
}

try {
  console.log('Starting a disposable protected VM; only bootstrap dependencies use the authenticated proxy.');
  await finish(await manager.lifecycle(environment.id, 'start'));
  const current = () => manager.store.get(environment.id);
  const protection = await manager.runtime.networkProtection(current());
  assert.equal(protection.active, true);
  report.bootstrapProtection = protection;
  await manager.runtime.management(current(), ['sudo', 'apt-get', 'install', '-y', '-qq', '--no-install-recommends', 'wireguard-tools'], { timeoutMs: 180_000 });
  const client = keys(), gateway = keys(), wrong = keys();
  const clientConfig = wireguardSchema.parse({ address: '10.77.0.2/32', privateKey: client.privateKey, peerPublicKey: gateway.publicKey, endpoint: { address: '192.0.2.1', port: 51820 } });
  const gatewayConfig = wireguardSchema.parse({ address: '10.77.0.1/32', privateKey: gateway.privateKey, peerPublicKey: client.publicKey, endpoint: { address: '192.0.2.2', port: 51821 }, listenPort: 51820 });
  const fixture = { client: wireguardSetconf(clientConfig), gateway: wireguardSetconf(gatewayConfig), wrongPeer: wireguardSetconf({ ...clientConfig, peerPublicKey: wrong.publicKey }), clientPublicKey: client.publicKey, firewall: wireguardNamespaceFirewall(clientConfig) };
  const source = await readFile(path.join(root, 'scripts/wireguard-fixture.py'), 'utf8');
  console.log('Comparing actual kernel TCP SYN packets across WireGuard and routed NAT; injecting peer and route faults.');
  let fixtureError: unknown;
  try {
    await manager.runtime.management(current(), ['bash', '-s'], {
      timeoutMs: 90_000,
      input: `set -euo pipefail\nsudo install -d -o root -g root -m 0700 /run/mu-wireguard-fixture\numask 077\nprintf '%s' ${shellQuote(JSON.stringify(fixture))} | sudo tee /run/mu-wireguard-fixture/config.json >/dev/null\nsudo chmod 0600 /run/mu-wireguard-fixture/config.json\nprintf '%s' ${shellQuote(source)} | sudo tee /run/mu-wireguard-fixture/fixture.py >/dev/null\nsudo chmod 0600 /run/mu-wireguard-fixture/fixture.py\nsudo python3 /run/mu-wireguard-fixture/fixture.py\n`,
    });
  } catch (error) { fixtureError = error; }
  const result = JSON.parse(await manager.runtime.management(current(), ['sudo', 'cat', '/run/mu-wireguard-fixture/report.json']));
  report.kernelFixture = result;
  report.captures = [];
  for (const name of ['client.pcap', 'receiver.pcap', 'transport.pcap']) {
    try {
      const bytes = Buffer.from((await manager.runtime.management(current(), ['sudo', 'base64', '-w0', `/run/mu-wireguard-fixture/${name}`])).trim(), 'base64');
      assert.ok(bytes.length > 24, 'Capture contains no packet records');
      await writeFile(path.join(artifacts, name), bytes, { mode: 0o600 });
      (report.captures as unknown[]).push({ name, bytes: bytes.length });
    } catch (error) {
      (report.captures as unknown[]).push({ name, error: (error as Error).message });
    }
  }
  if (fixtureError) throw fixtureError;
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal((report.captures as { error?: string }[]).some(item => item.error), false);
  report.finalProtection = await manager.runtime.networkProtection(current());
  assert.equal((report.finalProtection as { active: boolean }).active, true);
  assert.equal((await manager.runtime.management(current(), ['sudo', 'ip', 'netns', 'list'])).trim(), '');
  report.namespacesRemoved = true;
  report.passed = true;
} catch (error) {
  report.error = (error as Error).message;
  report.logs = manager.store.logs(environment.id).slice(-10);
  process.exitCode = 1;
} finally {
  await Promise.all([...manager.quarantines.values()]);
  await manager.lifecycle(environment.id, 'delete').then(finish).catch(error => { report.cleanupError = (error as Error).message; report.passed = false; process.exitCode = 1; });
  await manager.close();
  for (const socket of sockets) socket.destroy();
  proxy.closeAllConnections();
  if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
  if (!report.cleanupError) await rm(temporary, { recursive: true, force: true });
  else report.retainedDataDir = temporary;
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'test-results/wireguard-kernel.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
