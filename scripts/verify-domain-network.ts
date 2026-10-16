import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as tlsRequest } from 'node:https';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { Manager as SourceManager } from '../server/manager.ts';
import type { Environment, Job } from '../shared/types.ts';
import { run } from '../server/process.ts';
import { shellQuote } from '../server/network-guard.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';
import { createDohLocalFixture } from './doh-local-fixture.ts';

const root = path.resolve(import.meta.dirname, '..');
const bridgeOwner = process.argv.includes('--bridge-owner');
const transport = process.argv.includes('--transport') || bridgeOwner;
const reportName = bridgeOwner ? 'domain-network-bridge-owner' : transport ? 'domain-network-transport' : 'domain-network-latest';
const bundle = path.join(root, `release/${bridgeOwner ? 'bridge-owner-candidate' : transport ? 'proxy-transport-guard-candidate' : 'boot-capture-candidate'}/mac-arm64/MuCodeSandbox.app`);
const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
const { Manager }: { Manager: typeof SourceManager } = await import(pathToFileURL(path.join(compiled, 'manager.js')).href);
const owned = await mkdtemp(path.join(homedir(), '.mu-domain-'));
const artifacts = path.join(root, 'test-results', `${transport ? reportName : 'domain-network'}-${Date.now()}`); await mkdir(artifacts, { mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const manager = new Manager(owned), runtime = manager.runtime;
const fixture = await createDohLocalFixture(path.join(owned, 'tls'));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), accountFree: true, paidModelCalls: 0,
  bundle, proxyTransportPackageTested: transport, artifactsDirectory: artifacts, observations: [], captures: [], temporaryVmCaOnly: true, hostTrustStoreChanged: false,
  scope: 'Latest packaged modules under Node, real guest system DNS through controlled TLS DoH/proxy, fresh domains, service outage, TLS hostname failure and recovery; no browser/UI or public DNS acceptance' };
let current: Environment | undefined, captureActive = false;
const guest = (args: string[]) => runtime.guest(manager.store.get(current!.id), args, { timeoutMs: 20_000 });
const admin = (args: string[], input?: string) => runtime.management(manager.store.get(current!.id), args, { input, timeoutMs: 30_000 });
async function finish(job: Job) { await manager.tasks.get(job.id)?.promise; const done = manager.store.jobs().find(row => row.id === job.id)!; assert.equal(done.status, 'succeeded', done.message); }
async function checkpoint(message: string) {
  console.log(new Date().toISOString(), message); report.progress = { message, at: new Date().toISOString() };
  await writeFile(path.join(root, `test-results/${reportName}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
}
async function capture(name: string, source: string, boot = false) {
  const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', source])).trim(), 'base64');
  const bootId = boot ? (await admin(['cat', '/proc/sys/kernel/random/boot_id'])).trim() : undefined;
  if (boot) assert.equal((await admin(['sudo', 'cat', '/var/log/mucodesandbox/boot-network.boot-id'])).trim(), bootId);
  await writeFile(path.join(artifacts, `${name}.pcap`), bytes, { mode: 0o600 });
  report.captures.push({ name, bytes: bytes.length, sha256: hash(bytes), bootId });
}
async function startCapture() { await admin(['sudo', 'systemd-run', '--quiet', '--unit=mu-domain-capture', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', '/run/mu-domain.pcap', transport ? 'ip or ip6' : 'not (tcp src port 22)']); captureActive = true; await delay(500); }
async function stopCapture(name: string) { if (!captureActive) return; await admin(['sudo', 'systemctl', 'stop', 'mu-domain-capture.service']); captureActive = false; await capture(name, '/run/mu-domain.pcap'); }
const domain = (label: string) => `${label}.mu-domain.test`;
const resolve = (label: string) => guest(['timeout', '4', 'getent', 'ahostsv4', domain(label)]);
const request = (label: string) => guest(['curl', '--fail', '--silent', '--max-time', '5', '--proxy', '', `http://${domain(label)}/`]);
async function success(label: string) {
  assert.match(await resolve(label), /203\.0\.113\.81\s+STREAM/);
  assert.equal((await request(label)).trim(), 'MU_DOMAIN_OK');
  const protection = await runtime.networkProtection(manager.store.get(current!.id)); assert.equal(protection.active, true); assert.equal(protection.integrity, 'verified');
  assert.ok(fixture.queries.some(row => row.name === domain(label) && row.answer === '203.0.113.81'));
  assert.ok(fixture.requests.some(row => row.host === domain(label)));
  report.observations.push({ label, at: new Date().toISOString(), resolution: '203.0.113.81', response: 'MU_DOMAIN_OK', protectionActive: protection.active });
}
async function configureName(serverName: string) {
  await finish(await manager.lifecycle(current!.id, 'stop'));
  const saved = manager.store.get(current!.id);
  await manager.update(saved.id, { name: saved.name, cpus: saved.cpus, memoryGiB: saved.memoryGiB, diskGiB: saved.diskGiB,
    network: { ...saved.network, dns: { ...saved.network.dns!, serverName } } });
  await finish(await manager.lifecycle(saved.id, 'start'));
}
try {
  const disk = await statfs(owned); assert.ok(disk.bavail * disk.bsize > 100 * 2 ** 30);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  report.packageCdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1]; assert.equal(report.packageCdHash, bridgeOwner ? '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3' : transport ? '7395e50362e01c36299c4eacabe0cbedb636cf22' : 'b0cd06dd921a9ba759336fb39c8cb6e40e22fde4');
  report.modules = Object.fromEntries(await Promise.all((await readdir(compiled)).filter(file => file.endsWith('.js')).map(async file => [file, hash(await readFile(path.join(compiled, file)))])));
  if (bridgeOwner) {
    assert.equal(Object.keys(report.modules).length, 45);
    report.initialSources = Object.fromEntries(await Promise.all(['scripts/verify-domain-network.ts', 'scripts/doh-local-fixture.ts'].map(async file => {
      const bytes = await readFile(path.join(root, file)); await writeFile(path.join(artifacts, `source-${path.basename(file)}`), bytes, { mode: 0o600 }); return [file, hash(bytes)];
    })));
  }
  const cache = process.env.MU_TEST_SING_BOX_CACHE; assert.ok(cache); assert.equal(hash(await readFile(cache)), SING_BOX_SHA256);
  await mkdir(path.join(owned, 'tools/sing-box'), { recursive: true }); await copyFile(cache, path.join(owned, 'tools/sing-box', SING_BOX_ARCHIVE));
  await assert.rejects(new Promise<void>((resolve, reject) => {
    const request = tlsRequest({ hostname: '127.0.0.1', port: fixture.dnsPort, servername: 'wrong-doh.test', ca: fixture.ca }, response => { response.resume(); resolve(); }); request.once('error', reject); request.end();
  }), /Hostname\/IP does not match certificate/); report.hostWrongTlsNameRejected = true;
  current = await manager.create({ name: 'Disposable domain DNS acceptance', cpus: 2, memoryGiB: 2, diskGiB: 10,
    network: { mode: 'http', host: '127.0.0.1', port: fixture.proxyPort, username: 'mu', password: 'doh-fixture', strict: true, transparent: true, noProxy: '',
      dns: { address: '203.0.113.82', serverName: fixture.serverName, port: 443, path: '/dns-query' } } });
  await checkpoint('Starting fresh VM with controlled encrypted DNS'); await finish(await manager.lifecycle(current.id, 'start'));
  report.gateway = (await admin(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+) dev eth0/)![1]; report.proxyPort = fixture.proxyPort;
  assert.equal((await admin(['cat', '/sys/class/net/eth0/ifindex'])).trim(), '2'); await capture('first-boot', '/var/log/mucodesandbox/boot-network.pcap', true);
  fixture.restrictToLocal(); await startCapture();
  report.failedNamePhases = [{ labels: ['untrusted-ca'], startedAt: new Date().toISOString() }];
  await assert.rejects(resolve('untrusted-ca')); report.untrustedCaResolutionRejected = true;
  assert.ok(!fixture.queries.some(row => row.name === domain('untrusted-ca')));
  report.failedNamePhases[0].restoreStartedAt = new Date().toISOString();
  await admin(['bash', '-s'], `set -eu\nprintf '%s' ${shellQuote(fixture.ca)} | sudo tee /usr/local/share/ca-certificates/mu-disposable-doh.crt >/dev/null\nsudo update-ca-certificates >/dev/null\nsudo systemctl restart mucodesandbox-tunnel.service\n`);
  await success('trusted');
  await assert.rejects(resolve('missing-domain')); assert.ok(fixture.queries.some(row => row.name === domain('missing-domain') && row.rcode === 3)); report.nxdomainRejected = true;
  await checkpoint('Repeating unique domain lookups and HTTP requests for three minutes');
  const stableAt = Date.now();
  for (let index = 0; index < 18; index++) {
    await success(`sample-${index}`); await delay(10_000);
    const free = await statfs(owned); assert.ok(free.bavail * free.bsize > 80 * 2 ** 30);
    if (index % 3 === 2) await checkpoint(`Unique-domain samples completed: ${index + 1}/18`);
  }
  report.stableDomainMs = Date.now() - stableAt; assert.ok(report.stableDomainMs >= 180_000);
  await checkpoint('Stopping controlled DNS service and checking uncached names fail');
  await fixture.setDnsAvailable(false);
  report.failedNamePhases.push({ labels: ['dns-outage', 'dns-outage-http'], startedAt: new Date().toISOString() });
  await assert.rejects(resolve('dns-outage')); await assert.rejects(request('dns-outage-http'));
  assert.ok(!fixture.queries.some(row => row.name === domain('dns-outage') || row.name === domain('dns-outage-http')));
  assert.ok(!fixture.requests.some(row => row.host === domain('dns-outage-http'))); report.dnsOutageUncachedResolutionAndRequestBlocked = true;
  const before = (await runtime.networkProtection(manager.store.get(current.id))).blockedPackets;
  await admin(['sudo', 'python3', '-c', "import socket\ns=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,b'eth0')\ntry: s.sendto(bytes(24),('8.8.8.8',53))\nexcept PermissionError: pass\ns.close()"]);
  assert.ok((await runtime.networkProtection(manager.store.get(current.id))).blockedPackets > before); report.physicalDnsFallbackBlocked = true;
  report.failedNamePhases[1].restoreStartedAt = new Date().toISOString();
  await fixture.setDnsAvailable(true); await success('dns-recovery'); report.dnsRecoveryWithoutVmRestart = true;
  await admin(['bash', '-s'], 'set -eu\nsudo systemctl restart systemd-networkd\nsudo networkctl renew eth0\n');
  await success('networkd-recovery'); report.networkdRestartAndRenewRecovered = true; await stopCapture('domain-tasks');
  await checkpoint('Checking actual guest TLS hostname mismatch and normal configuration recovery');
  await configureName('wrong-doh.test'); await capture('wrong-name-boot', '/var/log/mucodesandbox/boot-network.pcap', true); await startCapture();
  report.failedNamePhases.push({ labels: ['wrong-name'], startedAt: new Date().toISOString() });
  await assert.rejects(resolve('wrong-name')); assert.ok(!fixture.queries.some(row => row.name === domain('wrong-name'))); report.guestWrongTlsNameRejected = true; await stopCapture('wrong-name-tasks');
  report.failedNamePhases[2].restoreStartedAt = new Date().toISOString();
  await configureName(fixture.serverName); await capture('recovery-boot', '/var/log/mucodesandbox/boot-network.pcap', true); await startCapture();
  await success('name-recovery'); report.normalRestartAfterTlsFailureRecovered = true; await stopCapture('recovery-tasks');
  await writeFile(path.join(artifacts, 'dns-receipts.json'), JSON.stringify({ queries: fixture.queries, requests: fixture.requests, decisions: fixture.decisions }, null, 2), { mode: 0o600 });
  await writeFile(path.join(artifacts, 'test-ca.crt'), fixture.ca, { mode: 0o600 }); await writeFile(path.join(artifacts, 'test-server.crt'), fixture.cert, { mode: 0o600 });
  assert.ok(fixture.decisions.filter(row => row.localOnly).every(row => row.allowed && ['203.0.113.81:80', '203.0.113.82:443'].includes(row.destination)));
  for (const [file, expected] of Object.entries(report.modules)) assert.equal(hash(await readFile(path.join(compiled, file))), expected);
  report.passed = true;
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
finally {
  if (captureActive) await stopCapture('failure-tasks').catch(error => { report.captureError = String(error); });
  await Promise.all([...manager.quarantines.values()]);
  if (current) { try { await finish(await manager.lifecycle(current.id, 'stop')); await finish(await manager.lifecycle(current.id, 'delete')); } catch (error) { report.cleanupError = String(error); } }
  await manager.close();
  for (const row of await runtime.list()) { try { if (row.status === 'Running') await runtime.command(['stop', row.name], { timeoutMs: 120_000 }); await runtime.command(['delete', row.name], { timeoutMs: 120_000 }); } catch (error) { report.cleanupError = String(error); } }
  await fixture.close();
  if (!report.cleanupError) { assert.deepEqual(await runtime.list(), []); await rm(owned, { recursive: true }); report.testResourcesRemoved = true; } else report.retainedDataDirectory = owned;
  if (report.captureError || report.cleanupError) { report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  report.sources = Object.fromEntries(await Promise.all(['scripts/verify-domain-network.ts', 'scripts/doh-local-fixture.ts'].map(async file => [file, hash(await readFile(path.join(root, file)))])));
  if (bridgeOwner) {
    try { assert.deepEqual(report.sources, report.initialSources);
      for (const [file, digest] of Object.entries(report.modules ?? {})) assert.equal(hash(await readFile(path.join(compiled, file))), digest);
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]); report.inputsUnchanged = true;
    } catch (error) { report.inputsError = String(error); report.passed = false; process.exitCode = 1; }
  }
  report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, hash(await readFile(path.join(artifacts, file)))])));
  const bytes = JSON.stringify(report, null, 2); await writeFile(path.join(root, `test-results/${reportName}.json`), bytes, { mode: 0o600 }); await writeFile(path.join(artifacts, 'report.json'), bytes, { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, error: report.error, cleanupError: report.cleanupError, finishedAt: report.finishedAt, artifacts }, null, 2));
}
