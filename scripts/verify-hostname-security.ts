import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { validateGuestHostname } from '../server/guest-hostname.ts';
import { PREPARE_DEVELOPER_SCRIPT } from '../server/guest-privileges.ts';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import type { Job } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(homedir(), '.mu-hostname-verification-'));
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const manager = new Manager(temporary, undefined, new LimaRuntime(temporary));
const report: Record<string, any> = {
  passed: false, startedAt: new Date().toISOString(), accountFree: true, paidModelCalls: 0,
  scope: 'ordinary persisted guest name, unique protected-base clone identity, reboot, legacy migration, first-boot egress capture',
  doesNotExplainBrowserColdNavigation: true,
};
const sockets = new Set<Socket>();
const password = `hostname-test-${randomBytes(12).toString('hex')}`;
const authorization = `Basic ${Buffer.from(`mu:${password}`).toString('base64')}`;
let proxyHits = 0;
let directHits = 0;
let environmentId = '';
const target = createServer((_request, response) => { directHits++; response.end('MU_HOSTNAME_DIRECT'); });
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const targetPort = (target.address() as { port: number }).port;
const proxy = createServer((request, response) => {
  if (request.headers['proxy-authorization'] !== authorization) {
    response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Mu hostname fixture"' }); response.end(); return;
  }
  const url = new URL(request.url!);
  if (url.hostname !== 'hostname-fixture.invalid') { response.writeHead(403); response.end(); return; }
  proxyHits++; response.end('MU_HOSTNAME_PROXY');
});
for (const server of [target, proxy]) server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = (proxy.address() as { port: number }).port;

async function finish(job: Job) {
  await manager.tasks.get(job.id)?.promise;
  const completed = manager.store.jobs().find(item => item.id === job.id)!;
  if (completed.status !== 'succeeded') report.logs = manager.store.logs(environmentId).slice(-25);
  assert.equal(completed.status, 'succeeded', completed.message);
}
const guest = (command: string[], timeoutMs = 30_000) => manager.runtime.guest(manager.store.get(environmentId), command, { timeoutMs });
const management = (command: string[], input?: string) => manager.runtime.management(manager.store.get(environmentId), command, { timeoutMs: 30_000, input });
const stateScript = `import json, pathlib, socket, stat, subprocess, yaml
hosts = pathlib.Path('/etc/hosts').read_text()
records = [line.split('#', 1)[0].split() for line in hosts.splitlines() if line.split('#', 1)[0].strip()]
policy = pathlib.Path('/etc/cloud/cloud.cfg.d/99-mucodesandbox-hosts.cfg')
cloud = yaml.safe_load(pathlib.Path('/etc/cloud/cloud.cfg').read_text())
version = subprocess.run(['cloud-init', '--version'], capture_output=True, text=True, check=True)
saved = pathlib.Path('/etc/mucodesandbox/guest-hostname.json')
unit = pathlib.Path('/etc/systemd/system/mucodesandbox-hostname.service')
print(json.dumps({
 'hostname': socket.gethostname(),
 'hostnameFile': pathlib.Path('/etc/hostname').read_text().strip(),
 'instanceId': pathlib.Path('/var/lib/cloud/data/instance-id').read_text().strip(),
 'machineIdSha256': __import__('hashlib').sha256(pathlib.Path('/etc/machine-id').read_text().strip().encode('ascii')).hexdigest(),
 'saved': json.loads(saved.read_text()) if saved.exists() else None,
 'savedUid': saved.stat().st_uid if saved.exists() else None,
 'savedMode': stat.S_IMODE(saved.stat().st_mode) if saved.exists() else None,
 'unit': unit.read_text() if unit.exists() else None,
 'unitUid': unit.stat().st_uid if unit.exists() else None,
 'unitMode': stat.S_IMODE(unit.stat().st_mode) if unit.exists() else None,
 'unitEnabled': subprocess.run(['systemctl', 'is-enabled', 'mucodesandbox-hostname.service'], capture_output=True, text=True).stdout.strip(),
 'unitActive': subprocess.run(['systemctl', 'is-active', 'mucodesandbox-hostname.service'], capture_output=True, text=True).stdout.strip(),
 'hosts': hosts, 'records': records,
 'nonHostnameRecords': [record for record in records if socket.gethostname() not in record[1:]],
 'policy': yaml.safe_load(policy.read_text()) if policy.exists() else None,
 'policyUid': policy.stat().st_uid if policy.exists() else None,
 'policyMode': stat.S_IMODE(policy.stat().st_mode) if policy.exists() else None,
 'cloudInitVersion': (version.stdout + version.stderr).strip(),
 'initModules': cloud['cloud_init_modules'],
 'resolver': pathlib.Path('/etc/resolv.conf').read_text(),
 'limaResolver': pathlib.Path('/etc/systemd/resolved.conf.d/99-lima.conf').read_text()
   if pathlib.Path('/etc/systemd/resolved.conf.d/99-lima.conf').exists() else None
}))
`;
async function state() {
  const output = await management(['sudo', 'python3', '-c', stateScript]);
  return JSON.parse(output.split('\n').find(line => line.startsWith('{'))!);
}
async function assertHostname(label: string, expectedOtherRecords?: string[][], expectedResolver?: string, expectedSaved?: any, bootApplied = false) {
  const observed = await state();
  assert.ok(observed.saved, 'The ordinary hostname must have trusted persisted state');
  const expected = validateGuestHostname(observed.saved.hostname);
  assert.match(expected, /^desktop-[0-9a-f]{8}$/);
  assert.doesNotMatch(expected, /^(lima|mu)-/);
  assert.equal(observed.saved.version, 1);
  assert.equal(observed.saved.instanceIdSha256, createHash('sha256').update(observed.instanceId).digest('hex'));
  assert.equal(observed.saved.machineIdSha256, observed.machineIdSha256);
  assert.equal(observed.savedUid, 0); assert.equal(observed.savedMode, 0o600);
  assert.equal(observed.unitUid, 0); assert.equal(observed.unitMode, 0o644);
  assert.equal(observed.unitEnabled, 'enabled');
  assert.ok(observed.unit.includes('After=local-fs.target cloud-init.service'));
  assert.ok(observed.unit.includes('Before=cloud-config.service cloud-final.service'));
  if (expectedSaved) {
    // Lima can issue a fresh instance-id on start. Preserve the real-machine
    // identity, ordinary name and source while recording the current iid.
    const { instanceIdSha256: _previousIid, ...previousStable } = expectedSaved;
    const { instanceIdSha256: _currentIid, ...currentStable } = observed.saved;
    assert.deepEqual(currentStable, previousStable);
  }
  if (bootApplied) assert.equal(observed.unitActive, 'active');
  assert.equal(observed.hostname, expected);
  assert.equal(observed.hostnameFile, expected);
  const addresses = (await guest(['getent', 'ahostsv4', expected])).trim().split('\n').map(line => line.trim().split(/\s+/)[0]);
  assert.ok(addresses.length > 0);
  assert.ok(addresses.every(address => address === '127.0.1.1'), JSON.stringify(addresses));
  const gateway = (await guest(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+)/)?.[1];
  assert.ok(gateway);
  const hostAddresses = (await guest(['getent', 'ahostsv4', 'host.lima.internal'])).trim().split('\n').map(line => line.trim().split(/\s+/)[0]);
  assert.ok(hostAddresses.length > 0 && hostAddresses.every(address => address === gateway));
  assert.deepEqual(observed.policy, { preserve_hostname: true, manage_etc_hosts: false });
  assert.equal(observed.policyUid, 0); assert.equal(observed.policyMode, 0o644);
  const order: string[] = observed.initModules;
  assert.ok(['set_hostname', 'update_hostname', 'update_etc_hosts'].every(module => order.includes(module)));
  assert.ok(order.indexOf('set_hostname') < order.indexOf('update_hostname'));
  assert.ok(order.indexOf('update_hostname') < order.indexOf('update_etc_hosts'));
  const sudo = await management(['sudo', '-n', 'true']);
  assert.doesNotMatch(sudo, /unable to resolve host/i);
  if (expectedOtherRecords) assert.deepEqual(observed.nonHostnameRecords, expectedOtherRecords);
  if (expectedResolver !== undefined) assert.equal(observed.resolver, expectedResolver);
  const protection = await manager.runtime.networkProtection(manager.store.get(environmentId));
  assert.ok(protection.active && protection.bootArmed && protection.integrity === 'verified');
  report[label] = { ...observed, addresses, hostAddresses, sudoHasNoHostnameWarning: true, protectionActive: true };
  return { observed, gateway };
}

try {
  const created = await manager.create({
    name: 'Ordinary hostname and first-boot verification', cpus: 4, memoryGiB: 4, diskGiB: 10,
    identity: { timezone: 'UTC', locale: 'en-US' },
    network: { mode: 'http', host: '127.0.0.1', port: proxyPort, username: 'mu', password, noProxy: '', strict: true, transparent: false },
  });
  environmentId = created.id;
  console.log('Creating a fresh protected base and the first strict user clone.');
  await finish(await manager.lifecycle(environmentId, 'start'));
  const { observed: initial, gateway } = await assertHostname('freshClone');
  const cloneLogs = manager.store.logs(environmentId).map(log => log.message).join('\n');
  const cloneStart = cloneLogs.lastIndexOf('Protected base verified. User environments boot with an armed default-deny guard.');
  assert.ok(cloneStart >= 0, 'The fresh base must be built and sealed during this verification');
  const baseNames = cloneLogs.slice(0, cloneStart).split('\n').flatMap(line => {
    try { const record = JSON.parse(line); return record.version === 1 && typeof record.instanceIdSha256 === 'string' && typeof record.hostname === 'string' ? [record] : []; } catch { return []; }
  });
  assert.ok(baseNames.length > 0, 'Fresh base hostname/identity output is required as the clone positive control');
  assert.ok(baseNames.every(record => record.machineIdSha256 !== initial.saved.machineIdSha256 && record.hostname !== initial.hostname));
  report.uniqueCloneIdentity = { baseStates: baseNames, cloneState: initial.saved, machineIdAndNameDiffer: true };
  const cloneStage = cloneLogs.slice(cloneStart);
  assert.doesNotMatch(cloneStage, /unable to resolve host/i);
  report.firstUserCloneStartupHasNoHostnameWarning = true;
  const captureFile = '/var/log/mucodesandbox/boot-network.pcap';
  const encoded = (await management(['sudo', 'python3', '-c', 'import base64,pathlib;print(base64.b64encode(pathlib.Path("/var/log/mucodesandbox/boot-network.pcap").read_bytes()).decode())'])).trim();
  const bytes = Buffer.from(encoded, 'base64');
  assert.ok(bytes.length > 24, 'First-boot capture has no positive control');
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/hostname-persistence-first-boot.pcap'), bytes, { mode: 0o600 });
  const capture = await management(['sudo', 'tcpdump', '-nn', '-r', captureFile]);
  const physical = capture.split('\n').filter(line => /\s(?!lo\b)\S+\s+Out\s+IP6?\s/.test(line));
  assert.ok(physical.length > 0, 'First-boot capture must contain physical output');
  assert.ok(physical.every(line => !/ IP6 /.test(line)), capture);
  assert.ok(physical.every(line =>
    new RegExp(`\\.22 > ${gateway!.replaceAll('.', '\\.')}\\.`).test(line)
    || new RegExp(` > ${gateway!.replaceAll('.', '\\.')}\\.${proxyPort}:`).test(line)
    || /\.68 > [0-9.]+\.67:/.test(line)), capture);
  report.firstBootCapture = { bytes: bytes.length, physicalOutputPackets: physical.length, onlyApprovedProxySshDhcp: true, noPhysicalIpv6: true };
  assert.equal((await guest(['curl', '--fail', '--silent', '--max-time', '5', 'http://hostname-fixture.invalid/'])).trim(), 'MU_HOSTNAME_PROXY');
  assert.ok(proxyHits > 0); report.authenticatedProxyWorks = true;
  const directBefore = directHits;
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--proxy', '', '--noproxy', '*', `http://${gateway}:${targetPort}/`]), undefined);
  assert.equal(directHits, directBefore); report.directEgressRemainsBlocked = true;
  await assert.rejects(guest(['sudo', '-n', 'true'])); report.developerCannotElevate = true;

  console.log('Rebooting to verify that the local hostname policy persists.');
  await finish(await manager.lifecycle(environmentId, 'restart'));
  await assertHostname('afterRestart', initial.nonHostnameRecords, initial.resolver, initial.saved, true);

  console.log('Simulating the legacy Lima name and missing hostname policy only inside this disposable VM.');
  await management(['sudo', 'python3', '-c', `import pathlib,socket,subprocess
previous=socket.gethostname()
legacy='lima-mu-legacy-fixture'
pathlib.Path('/etc/mucodesandbox/guest-hostname.json').unlink()
pathlib.Path('/etc/hostname').write_text(legacy+'\\n')
subprocess.run(['/bin/hostname',legacy],check=True)
policy=pathlib.Path('/etc/cloud/cloud.cfg.d/99-mucodesandbox-hosts.cfg');policy.unlink()
hostname=previous;hosts=pathlib.Path('/etc/hosts');lines=[]
for line in hosts.read_text().splitlines():
 fields=line.split('#',1)[0].split()
 if fields and fields[0]=='127.0.1.1' and hostname in fields[1:]:
  aliases=[name for name in fields[1:] if name!=hostname]
  if aliases:lines.append(fields[0]+'\\t'+' '.join(aliases))
 else:lines.append(line)
hosts.write_text('\\n'.join(lines)+'\\n')
`]);
  const broken = await state();
  assert.equal(broken.policy, null);
  assert.equal(broken.saved, null);
  assert.equal(broken.hostname, 'lima-mu-legacy-fixture');
  assert.ok(!broken.records.some((record: string[]) => record[0] === '127.0.1.1' && record.slice(1).includes(initial.hostname)));
  assert.deepEqual(broken.nonHostnameRecords, initial.nonHostnameRecords);
  await management(['bash', '-s'], PREPARE_DEVELOPER_SCRIPT);
  const { observed: migrated } = await assertHostname('afterLegacyMigration', initial.nonHostnameRecords, initial.resolver);
  assert.notEqual(migrated.hostname, initial.hostname);
  assert.equal(migrated.saved.source, 'generated');
  report.legacyMigrationRepairsOnlyLocalHostnameRecords = true;
  await finish(await manager.lifecycle(environmentId, 'restart'));
  await assertHostname('afterMigrationRestart', initial.nonHostnameRecords, initial.resolver, migrated.saved, true);
  assert.equal((await guest(['curl', '--fail', '--silent', '--max-time', '5', 'http://hostname-fixture.invalid/'])).trim(), 'MU_HOSTNAME_PROXY');
  report.actualLinuxVmVerified = true;
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  if (environmentId) report.logs = manager.store.logs(environmentId).slice(-25);
  process.exitCode = 1;
} finally {
  const keep = !report.passed && Boolean(process.env.MU_KEEP_FAILED_HOSTNAME);
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
  await writeFile(path.join(root, 'test-results/hostname-persistence.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
