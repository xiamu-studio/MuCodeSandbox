import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { Manager } from '../server/manager.ts';
import type { Job } from '../shared/types.ts';
import { run } from '../server/process.ts';
import { createService } from '../server/service.ts';
import { backupBrowserFixture, backupBrowserReceipt, validateBackupBrowser } from './backup-browser-fixture.ts';
import { verifyPackagedBackupBrowser } from './verify-packaged-backup-browser.ts';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(homedir(), '.mu-backup-vm-'));
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const browserTest = process.argv.includes('--browser');
const packagedTest = process.argv.includes('--packaged');
const browserArtifact = packagedTest ? 'backup-packaged' : 'backup-browser';
assert.ok(process.argv.slice(2).every(argument => ['--browser', '--packaged'].includes(argument)), 'Unsupported backup verifier argument');
assert.ok(!packagedTest || browserTest, 'Packaged backup verification requires actual browser storage');
const sourceService = browserTest ? await createService({ rootDir: root, dataDir: path.join(temporary, 'source'), port: 0 }) : undefined;
const destinationService = browserTest ? await createService({ rootDir: root, dataDir: path.join(temporary, 'destination'), port: 0 }) : undefined;
const source = sourceService?.manager ?? new Manager(path.join(temporary, 'source')), destination = destinationService?.manager ?? new Manager(path.join(temporary, 'destination'));
const report: Record<string, any> = { passed: false, accountFree: true, paidModelCalls: 0, actualSecondMacTested: false, actualBrowserStorageTested: browserTest, realServiceAccountTested: false, startedAt: new Date().toISOString() };
const results = path.join(root, 'test-results'); await mkdir(results, { recursive: true });
report.testedFiles = Object.fromEntries(await Promise.all(['server/backups.ts', 'server/import-seed.ts', 'server/runtime.ts', 'server/snapshots.ts', 'server/manager.ts', 'scripts/verify-backups.ts', ...(browserTest ? ['server/guest-browser.ts', 'server/guest-browser-runtime.ts', 'scripts/backup-browser-fixture.ts'] : []), ...(packagedTest ? ['scripts/verify-packaged-backup-browser.ts'] : [])].map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
const sockets = new Set<Socket>();
const fixture = '203.0.113.74';
const browserFixture = backupBrowserFixture(`http://${fixture}`);
const target = createServer(browserTest ? browserFixture.handler : (_req, res) => res.end('MU_BACKUP_NETWORK_OK'));
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const targetPort = (target.address() as { port: number }).port;
const auth = `Basic ${Buffer.from('mu:backup-fixture-secret').toString('base64')}`;
let proxyHits = 0;
const proxy = createServer((req, res) => {
  if (req.headers['proxy-authorization'] !== auth) { res.writeHead(407); res.end(); return; }
  const url = new URL(req.url!); if (url.hostname === fixture) { url.hostname = '127.0.0.1'; url.port = String(targetPort); }
  const headers = { ...req.headers }; delete headers['proxy-authorization'];
  const outgoing = httpRequest(url, { method: req.method, headers }, response => { res.writeHead(response.statusCode!, response.headers); response.pipe(res); });
  outgoing.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(outgoing);
});
proxy.on('connect', (req, client, head) => {
  if (req.headers['proxy-authorization'] !== auth) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
  const url = new URL(`https://${req.url}`), local = url.hostname === fixture;
  const remote = connect(local ? targetPort : Number(url.port) || 443, local ? '127.0.0.1' : url.hostname, () => {
    proxyHits++; client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client);
  });
  sockets.add(remote); remote.on('close', () => sockets.delete(remote));
  remote.on('error', () => client.destroy()); client.on('error', () => remote.destroy()); client.on('close', () => remote.destroy());
});
proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = (proxy.address() as { port: number }).port;
async function finish(manager: Manager, job: Job) {
  await manager.tasks.get(job.id)?.promise;
  const done = manager.store.jobs().find(item => item.id === job.id)!;
  if (done.status !== 'succeeded') report.failedLogs = manager.store.logs(job.environmentId).slice(-20);
  assert.equal(done.status, 'succeeded', done.message);
}
const project = path.join(temporary, 'project'); await mkdir(project); await writeFile(path.join(project, 'keep.txt'), 'host-current');
try {
  const e = await source.create({ name: '备份实机源环境', cpus: 2, memoryGiB: 2, diskGiB: 10, browserUrl: browserTest ? `http://${fixture}/write` : undefined, mounts: [{ id: crypto.randomUUID(), hostPath: project, guestPath: '/workspace/project', writable: false }], identity: { locale: 'ja-JP', timezone: 'Asia/Tokyo' }, network: { mode: 'http', host: '127.0.0.1', port: proxyPort, username: 'mu', password: 'backup-fixture-secret', strict: true, transparent: true, noProxy: '' } });
  console.log(new Date().toISOString(), 'Starting the source strict VM.');
  await finish(source, await source.lifecycle(e.id, 'start'));
  await source.runtime.guest(source.store.get(e.id), ['bash', '-c', 'printf MU_PORTABLE_GUEST > "$HOME/portable-marker"; install -d -m 0700 "$HOME/.local/share/mucodesandbox/browser/Default"; printf MU_SYNTHETIC_PROFILE > "$HOME/.local/share/mucodesandbox/browser/Default/portable-fixture"']);
  await source.runtime.management(source.store.get(e.id), ['bash', '-s'], { input: 'set -eu\nsudo install -d -m 0700 /root/.ssh\nsudo cp /home/mu/.ssh/authorized_keys /root/.ssh/authorized_keys\nsudo chmod 0600 /root/.ssh/authorized_keys\n' });
  assert.match(await source.runtime.management(source.store.get(e.id), ['sudo', 'cat', '/root/.ssh/authorized_keys']), /ssh-ed25519/);
  assert.equal((await source.runtime.guest(source.store.get(e.id), ['curl', '-sS', '--fail', '--max-time', '15', `http://${fixture}/`])).trim(), 'MU_BACKUP_NETWORK_OK');
  if (sourceService) {
    console.log(new Date().toISOString(), 'Writing real browser login and storage through the local fixture.');
    await finish(source, await source.openBrowser(e.id));
    const { receipt, entry, session } = await backupBrowserReceipt(sourceService, e.id);
    validateBackupBrowser(receipt);
    assert.deepEqual(receipt.before, { cookie: '', documentCookie: '', localStorage: null, indexedDB: null });
    assert.equal(browserFixture.evidence.loginRequests, 1);
    report.browserSource = receipt;
    const screenshot = await entry.tools!.send('Page.captureScreenshot', { format: 'png' }, session);
    await writeFile(path.join(results, `${browserArtifact}-source.png`), Buffer.from(screenshot.data, 'base64'));
    await source.closeBrowser(e.id);
    const preferences = JSON.parse(await source.runtime.guest(source.store.get(e.id), ['cat', '/home/dev/.local/share/mucodesandbox/browser/Default/Preferences']));
    assert.equal(preferences.profile.exit_type, 'Normal');
    source.store.save({ ...source.store.get(e.id), browserUrl: `http://${fixture}/read` });
  }
  await source.runtime.management(source.store.get(e.id), ['bash', '-s'], { input: `set -eu
sudo touch /etc/mucodesandbox/capture-first-boot
sudo rm -f /var/log/mucodesandbox/boot-network.pcap
printf '[Unit]\\nRequires=mucodesandbox-boot-capture.service\\nAfter=mucodesandbox-boot-capture.service\\n' | sudo tee /etc/systemd/system/systemd-networkd.service.d/mucodesandbox-capture.conf >/dev/null
sudo systemctl daemon-reload
` });
  await finish(source, await source.lifecycle(e.id, 'stop'));
  await source.snapshots.create(source.store.get(e.id), 'Portable source');
  const [snapshot] = await source.snapshots.list(e);
  const file = path.join(temporary, 'portable.mu-backup'), password = 'mu-synthetic-portable-backup-password';
  console.log(new Date().toISOString(), 'Exporting the real stopped VM disk.');
  await source.backups.export(source.store.get(e.id), snapshot.id, file, password, { onOutput: text => console.log(text.trim()) });
  report.archiveBytes = (await stat(file)).size;
  console.log(new Date().toISOString(), 'Importing into an independent data directory and encryption key.');
  const imported = await destination.backups.import(file, password, '导入实机环境', { onOutput: text => console.log(text.trim()) });
  assert.notEqual(imported.id, e.id); assert.notEqual(imported.instanceName, e.instanceName);
  assert.notDeepEqual(destination.store.key, source.store.key);
  assert.deepEqual(imported.mounts, []); assert.deepEqual(imported.ports, []);
  assert.equal(imported.network.password, source.store.get(e.id).network.password);
  assert.deepEqual(imported.identity, e.identity);
  report.independentStoreImport = true; report.hostGrantsCleared = true;
  const seed = await stat(path.join(destination.store.dataDir, 'imports', imported.id, 'disk'));
  report.diskLogicalBytes = seed.size; report.materializedDiskAllocatedBytes = seed.blocks * 512;
  assert.ok(seed.blocks * 512 < seed.size);
  console.log(new Date().toISOString(), 'Starting the imported VM through normal lifecycle.');
  await finish(destination, await destination.lifecycle(imported.id, 'start'));
  const current = destination.store.get(imported.id);
  const protection = await destination.runtime.networkProtection(current);
  assert.equal(protection.active, true); assert.equal(protection.integrity, 'verified');
  assert.equal((await destination.runtime.guest(current, ['cat', '/home/dev/portable-marker'])).trim(), 'MU_PORTABLE_GUEST');
  assert.equal((await destination.runtime.guest(current, ['cat', '/home/dev/.local/share/mucodesandbox/browser/Default/portable-fixture'])).trim(), 'MU_SYNTHETIC_PROFILE');
  assert.equal((await destination.runtime.guest(current, ['curl', '-sS', '--fail', '--max-time', '15', `http://${fixture}/`])).trim(), 'MU_BACKUP_NETWORK_OK');
  if (destinationService) {
    console.log(new Date().toISOString(), 'Reading imported browser cookie, localStorage and IndexedDB without logging in again.');
    await finish(destination, await destination.openBrowser(current.id));
    const { receipt, entry, session } = await backupBrowserReceipt(destinationService, current.id);
    validateBackupBrowser(receipt); assert.deepEqual(receipt.before, receipt.after);
    assert.equal(browserFixture.evidence.loginRequests, 1);
    report.browserImported = receipt;
    const screenshot = await entry.tools!.send('Page.captureScreenshot', { format: 'png' }, session);
    await writeFile(path.join(results, `${browserArtifact}-imported.png`), Buffer.from(screenshot.data, 'base64'));
    await destination.closeBrowser(current.id);
  }
  await assert.rejects(destination.runtime.guest(current, ['sudo', '-n', 'true']));
  await assert.rejects(destination.runtime.guest(current, ['cat', '/workspace/project/keep.txt']));
  const blockedBefore = protection.blockedPackets;
  assert.equal((await destination.runtime.management(current, ['sudo', 'python3', '-c', `import socket
s=socket.socket();s.settimeout(2);s.setsockopt(socket.SOL_SOCKET,25,b'eth0\\0')
try: s.connect(('1.1.1.1',443));raise RuntimeError('Unapproved direct connection succeeded')
except TimeoutError: print('MU_DIRECT_BLOCKED')
`], { timeoutMs: 5000 })).trim(), 'MU_DIRECT_BLOCKED');
  assert.ok((await destination.runtime.networkProtection(current)).blockedPackets > blockedBefore);
  const sourcePublic = (await readFile(path.join(source.runtime.limaHome, '_config/user.pub'), 'utf8')).trim();
  const destinationPublic = (await readFile(path.join(destination.runtime.limaHome, '_config/user.pub'), 'utf8')).trim();
  assert.notEqual(destinationPublic, sourcePublic);
  const authorized = await destination.runtime.management(current, ['sudo', 'cat', '/home/mu/.ssh/authorized_keys']);
  report.oldManagementPublicKeyStillAuthorized = authorized.includes(sourcePublic.split(' ')[1]);
  assert.equal(report.oldManagementPublicKeyStillAuthorized, false, 'Original management key must not retain access to the imported VM');
  assert.equal((await destination.runtime.management(current, ['sudo', 'cat', '/root/.ssh/authorized_keys'])).trim(), '');
  report.oldRootManagementKeysCleared = true;
  const sshConfig = path.join(destination.runtime.limaHome, current.instanceName, 'ssh.config');
  const effective = await run('/usr/bin/ssh', ['-G', '-F', sshConfig, `lima-${current.instanceName}`]);
  const port = Number(effective.match(/^port (\d+)$/m)?.[1]); assert.ok(port > 0 && port <= 65535);
  await assert.rejects(run('/usr/bin/ssh', ['-F', '/dev/null', '-i', path.join(source.runtime.limaHome, '_config/user'), '-p', String(port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=3', 'mu@127.0.0.1', 'true'], { timeoutMs: 5000 }), /Permission denied/);
  report.oldManagementKeyActualLoginRejected = true;
  const sourceHardware = await readFile(path.join(source.runtime.limaHome, e.instanceName, 'vz-identifier'));
  const destinationHardware = await readFile(path.join(destination.runtime.limaHome, current.instanceName, 'vz-identifier'));
  assert.notDeepEqual(sourceHardware, destinationHardware);
  report.freshManagementKeyAndVzIdentity = true;
  report.guestDataAndSyntheticProfilePreserved = true;
  report.actualBrowserLoginTested = browserTest;
  report.importProtection = protection;
  const interfaceIndex = Number((await destination.runtime.management(current, ['cat', '/sys/class/net/eth0/ifindex'])).trim());
  const capture = Buffer.from((await destination.runtime.management(current, ['sudo', 'python3', '-c', "import base64;print(base64.b64encode(open('/var/log/mucodesandbox/boot-network.pcap','rb').read()).decode())"], { maxBytes: 4_000_000 })).trim(), 'base64');
  const pcap = path.join(results, browserTest ? `${browserArtifact}-first-boot.pcap` : 'backup-import-first-boot.pcap'); await writeFile(pcap, capture, { mode: 0o600 });
  const physical = `ifindex ${interfaceIndex} and outbound`;
  const permitted = `(tcp and dst host 192.168.5.2 and dst port ${proxyPort}) or (tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67)`;
  const packets = async (filter: string) => (await run('/usr/sbin/tcpdump', ['-nn', '-r', pcap, `(${physical}) and (${filter})`], { maxBytes: 4_000_000 })).split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line));
  const [all, management, dhcp, unapproved] = await Promise.all([packets('ip or ip6'), packets('tcp and src port 22'), packets('udp and src port 68 and dst port 67'), packets(`ip6 or (ip and not (${permitted}))`)]);
  assert.ok(all.length > 0 && management.length > 0 && dhcp.length > 0); assert.deepEqual(unapproved, []);
  report.firstBootCapture = { bytes: capture.length, sha256: createHash('sha256').update(capture).digest('hex'), interfaceIndex, physicalIpPackets: all.length, managementPackets: management.length, dhcpPackets: dhcp.length, unapprovedPackets: 0 };
  await finish(destination, await destination.lifecycle(current.id, 'restart'));
  if (destinationService) {
    await finish(destination, await destination.openBrowser(current.id));
    const { receipt, entry, session } = await backupBrowserReceipt(destinationService, current.id);
    validateBackupBrowser(receipt); assert.deepEqual(receipt.before, receipt.after);
    assert.equal(browserFixture.evidence.loginRequests, 1);
    assert.equal(browserFixture.evidence.protectedRequests.length, 3);
    report.browserAfterRestart = receipt;
    report.browserLoginRequests = browserFixture.evidence.loginRequests;
    const screenshot = await entry.tools!.send('Page.captureScreenshot', { format: 'png' }, session);
    await writeFile(path.join(results, `${browserArtifact}-restarted.png`), Buffer.from(screenshot.data, 'base64'));
    await destination.closeBrowser(current.id);
  }
  assert.equal((await destination.runtime.guest(destination.store.get(current.id), ['cat', '/home/dev/portable-marker'])).trim(), 'MU_PORTABLE_GUEST');
  assert.ok(!(await destination.runtime.management(destination.store.get(current.id), ['sudo', 'cat', '/home/mu/.ssh/authorized_keys'])).includes(sourcePublic.split(' ')[1]));
  assert.equal((await destination.runtime.management(destination.store.get(current.id), ['sudo', 'cat', '/root/.ssh/authorized_keys'])).trim(), '');
  assert.equal(await readFile(path.join(project, 'keep.txt'), 'utf8'), 'host-current');
  report.restartAndHostProjectPreserved = true; report.proxyPositiveControlHits = proxyHits;
  if (packagedTest) {
    console.log(new Date().toISOString(), 'Verifying real encrypted backup and browser recovery through the packaged desktop UI.');
    await finish(destination, await destination.lifecycle(current.id, 'stop'));
    await destinationService!.close();
    report.packaged = await verifyPackagedBackupBrowser({ root, dataDir: destination.store.dataDir, environment: current, runtime: destination.runtime, fixture: browserFixture });
  }
  assert.ok(proxyHits > 0); report.passed = true;
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
finally {
  for (const manager of [source, destination]) {
    for (const instance of await manager.runtime.list().catch(() => [])) {
      try {
        if (instance.status === 'Running') await manager.runtime.command(['stop', '--force', instance.name], { timeoutMs: 120_000 });
        if (report.passed) await manager.runtime.command(['delete', '--force', instance.name], { timeoutMs: 120_000 });
      } catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
    }
    const service = manager === source ? sourceService : destinationService;
    if (service) await service.close(); else await manager.close();
  }
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => proxy.close(() => resolve())); await new Promise<void>(resolve => target.close(() => resolve()));
  if (report.passed) { await rm(temporary, { recursive: true, force: true }); report.temporaryVmDataRemoved = true; }
  else report.retainedDataDir = temporary;
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(results, packagedTest ? 'portable-backup-packaged.json' : browserTest ? 'portable-backup-browser.json' : 'portable-backups.json'), JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report, null, 2));
}
