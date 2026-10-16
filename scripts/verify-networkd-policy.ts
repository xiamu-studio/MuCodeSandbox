import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { NETWORKD_POLICY_PATH, NETWORKD_POLICY } from '../server/guest-networkd.ts';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import type { Job } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(homedir(), '.mu-networkd-verification-'));
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const manager = new Manager(temporary, undefined, new LimaRuntime(temporary));
const report: Record<string, any> = { passed: false, accountFree: true, paidModelCalls: 0, startedAt: new Date().toISOString() };
const sockets = new Set<Socket>();
let environmentId = '', targetHits = 0;
const connects: string[] = [];
const authorization = `Basic ${Buffer.from('mu:networkd-verification').toString('base64')}`;
const target = createServer((_request, response) => { targetHits++; response.end('MU_NETWORKD_FIXTURE'); });
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const targetPort = (target.address() as { port: number }).port;
const proxy = createServer((request, response) => {
  if (request.headers['proxy-authorization'] !== authorization) { response.writeHead(407); response.end(); return; }
  const headers = { ...request.headers }; delete headers['proxy-authorization'];
  const remote = httpRequest(new URL(request.url!), { method: request.method, headers }, incoming => { response.writeHead(incoming.statusCode!, incoming.headers); incoming.pipe(response); });
  remote.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(remote);
});
proxy.on('connect', (request, client, head) => {
  if (request.headers['proxy-authorization'] !== authorization) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
  const destination = new URL(`https://${request.url}`);
  const fixture = destination.hostname === '203.0.113.10';
  connects.push(request.url!);
  const remote = connect(fixture ? targetPort : Number(destination.port) || 443, fixture ? '127.0.0.1' : destination.hostname, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client);
  });
  sockets.add(remote); remote.on('close', () => sockets.delete(remote));
  remote.on('error', () => client.destroy()); client.on('error', () => remote.destroy()); client.on('close', () => remote.destroy());
});
for (const server of [target, proxy]) server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = (proxy.address() as { port: number }).port;

async function finish(job: Job) {
  await manager.tasks.get(job.id)?.promise;
  const completed = manager.store.jobs().find(item => item.id === job.id)!;
  assert.equal(completed.status, 'succeeded', completed.message);
}
const guest = (command: string[], timeoutMs = 30_000) => manager.runtime.guest(manager.store.get(environmentId), command, { timeoutMs });
const management = (command: string[], timeoutMs = 30_000) => manager.runtime.management(manager.store.get(environmentId), command, { timeoutMs });
const jsonOutput = (output: string) => JSON.parse(output.split('\n').find(line => line.startsWith('{') || line.startsWith('['))!);
async function inspect(label: string) {
  const protection = await manager.runtime.networkProtection(manager.store.get(environmentId));
  assert.ok(protection.active && protection.transparentActive && protection.routingReady && protection.integrity === 'verified', JSON.stringify(protection));
  const uid = (await guest(['id', '-u'])).trim();
  const route = await guest(['ip', '-4', 'route', 'get', '198.51.100.1', 'uid', uid]);
  assert.match(route, /dev mu_tun/);
  assert.equal(await management(['cat', NETWORKD_POLICY_PATH]), NETWORKD_POLICY);
  const rules: { priority: number; table?: string }[] = jsonOutput(await guest(['ip', '-j', '-4', 'rule', 'show']));
  const tunnelRules = rules.filter(rule => rule.priority >= 9000 && rule.priority < 10000);
  assert.ok(tunnelRules.some(rule => String(rule.table) === '2022'));
  const bootCapture = (await management(['sudo', 'sha256sum', '/var/log/mucodesandbox/boot-network.pcap'])).split(/\s+/)[0];
  const captureService = await guest(['systemctl', 'show', 'mucodesandbox-boot-capture.service', '-p', 'ActiveState', '-p', 'MainPID']);
  assert.match(captureService, /ActiveState=inactive/); assert.match(captureService, /MainPID=0/);
  const before = targetHits;
  assert.equal((await guest(['curl', '-q', '--fail', '--silent', '--max-time', '6', '--proxy', '', '--noproxy', '*', 'http://203.0.113.10/'])).trim(), 'MU_NETWORKD_FIXTURE');
  assert.equal(targetHits, before + 1);
  const result = { protection, route: route.trim(), tunnelRules, bootCapture, captureService: captureService.trim(), actualTargetReceipt: true };
  report[label] = result;
  return result;
}

try {
  const created = await manager.create({ name: 'Networkd routing preservation', cpus: 2, memoryGiB: 2, diskGiB: 10,
    identity: { timezone: 'UTC', locale: 'en-US' },
    network: { mode: 'http', host: '127.0.0.1', port: proxyPort, username: 'mu', password: 'networkd-verification', noProxy: '', strict: true, transparent: true } });
  environmentId = created.id;
  console.log('Creating a fresh strict transparent VM with the persistent networkd policy.');
  await finish(await manager.lifecycle(environmentId, 'start'));
  const initial = await inspect('beforeNetworkdRestart');
  const capture = await management(['sudo', 'tcpdump', '-nn', '-r', '/var/log/mucodesandbox/boot-network.pcap']);
  const physical = capture.split('\n').filter(line => /\s(?!lo\b)\S+\s+Out\s+IP6?\s/.test(line));
  const gateway = (await guest(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+)/)![1];
  assert.ok(physical.length > 0);
  assert.ok(physical.every(line => !/ IP6 /.test(line) && (/\.22 > /.test(line) || line.includes(` > ${gateway}.${proxyPort}:`) || /\.68 > [0-9.]+\.67:/.test(line))), capture);
  report.firstBootCaptureOnlyApprovedEgress = true;
  await guest(['bash', '-c', 'printf keep-networkd-data > /home/dev/networkd-data-marker']);
  console.log('Restarting the actual system network daemon and checking that tunnel rules survive.');
  await management(['sudo', 'systemctl', 'restart', 'systemd-networkd.service']);
  await management(['sleep', '2']);
  const restarted = await inspect('afterNetworkdRestart');
  assert.deepEqual(restarted.tunnelRules, initial.tunnelRules);
  assert.equal(restarted.bootCapture, initial.bootCapture); report.networkdRestartPreservesRulesRoutesAndFirstBootCapture = true;
  report.systemdVersionBeforePackages = (await management(['systemd', '--version'])).trim();
  console.log('Running signed package maintenance for systemd and resolved through the protected tunnel.');
  await management(['sudo', 'apt-get', 'update', '-qq'], 180_000);
  const beforePackages = connects.length;
  const packageLog = await management(['sudo', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '-qq', '--reinstall', 'systemd', 'systemd-resolved'], 300_000);
  report.packageMaintenanceLog = packageLog.trim().slice(-12000);
  assert.ok(connects.length > beforePackages, 'Package download must have a real proxy connection');
  const maintained = await inspect('afterSignedPackageMaintenance');
  assert.deepEqual(maintained.tunnelRules, initial.tunnelRules);
  assert.equal(maintained.bootCapture, initial.bootCapture);
  report.systemdVersionAfterPackages = (await management(['systemd', '--version'])).trim();
  report.signedPackageMaintenancePreservesProtectedRouting = true;
  console.log('Checking network policy tampering and protected migration without deleting user data.');
  await management(['sudo', 'chmod', '0666', NETWORKD_POLICY_PATH]);
  const tampered = await manager.runtime.networkProtection(manager.store.get(environmentId));
  assert.ok(tampered.firewallActive); assert.equal(tampered.integrity, 'changed'); assert.equal(tampered.active, false);
  await manager.monitorProtection();
  assert.equal(manager.store.get(environmentId).state, 'error');
  assert.equal((await manager.runtime.list()).find(item => item.name === created.instanceName)?.status, 'Stopped');
  report.unsafeNetworkdPolicyDetectedAndQuarantined = true;
  await finish(await manager.lifecycle(environmentId, 'start'));
  const migrated = await inspect('afterProtectedMigration');
  assert.equal(migrated.bootCapture, initial.bootCapture);
  assert.equal((await guest(['cat', '/home/dev/networkd-data-marker'])).trim(), 'keep-networkd-data');
  report.protectedMigrationPreservesUserDataAndCapture = true;
  report.actualLinuxVmVerified = true; report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  if (environmentId) report.logs = manager.store.logs(environmentId).slice(-25);
  process.exitCode = 1;
} finally {
  const keep = !report.passed && Boolean(process.env.MU_KEEP_FAILED_NETWORKD);
  for (const instance of await manager.runtime.list().catch(() => [])) {
    await manager.runtime.command(['stop', '--force', instance.name], { timeoutMs: 120_000 }).catch(error => { report.cleanupError = String(error); });
    if (!keep) await manager.runtime.command(['delete', '--force', instance.name], { timeoutMs: 120_000 }).catch(error => { report.cleanupError = String(error); });
  }
  await manager.close();
  for (const socket of sockets) socket.destroy();
  if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
  await new Promise<void>(resolve => target.close(() => resolve()));
  if (keep || report.cleanupError) report.retainedDataDir = temporary;
  else await rm(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/networkd-policy.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
