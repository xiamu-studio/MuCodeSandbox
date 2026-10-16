import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { parse } from 'yaml';
import { LimaRuntime } from '../server/runtime.ts';
import { run } from '../server/process.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';
import type { Environment } from '../shared/types.ts';
import { createClaudeLocalFixture } from './claude-local-fixture.ts';
import { growGuestRootScript } from '../server/guest-disk.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const bridgeOwner = process.argv.includes('--bridge-owner');
const product = bridgeOwner || process.argv.includes('--product');
const reportName = bridgeOwner ? 'guest-disk-growth-bridge-owner' : product ? 'guest-disk-growth-product' : 'guest-disk-growth';
const bundle = path.join(root, 'release/host-network-candidate/mac-arm64/MuCodeSandbox.app');
const expectedCdHash = 'cf031a2a4bbc9d55cc8b1d97e77a935b312145d2';
const owned = await mkdtemp(path.join(homedir(), '.mu-disk-growth-'));
const directory = path.join(owned, 'data');
const artifacts = path.join(root, 'test-results', `${reportName}-${Date.now()}`);
await mkdir(artifacts, { mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const runtime = new LimaRuntime(directory);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), bundle,
  artifactsDirectory: artifacts, actualElectronPackageTested: true, actualVmTested: true,
  accountFree: true, paidModelCalls: 0, diskGrowthProductUiTested: product, bridgeOwnerRecoveryTested: bridgeOwner,
  scope: product ? 'Actual new-package UI recovery of old full guest; subsequent normal app boot, fixture preservation and protected networking' : 'Old frozen package dev ENOSPC; stopped official Lima primary-disk growth and subsequent app boot, file preservation, protected networking; prototype, not product UI integration', captures: [] };
let application: ElectronApplication | undefined, page: Page | undefined, current: Environment | undefined;
const sourceFiles=['scripts/verify-guest-disk-growth.ts','scripts/claude-local-fixture.ts','server/guest-disk.ts',...(bridgeOwner?['scripts/packet-capture.ts']:[])];
let requests = 0;
const target = createServer((_request, response) => { requests++; response.end('MU_GROWTH_NETWORK_OK'); });
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const fixture = await createClaudeLocalFixture({ browserPort: (target.address() as { port: number }).port });
const admin = (args: string[]) => runtime.management(current!, args, { timeoutMs: 30_000, maxBytes: 32_000_000 });
const guest = (args: string[], timeoutMs = 30_000) => runtime.guest(current!, args, { timeoutMs });
async function api(endpoint: string, method = 'GET', body?: unknown) {
  return page!.evaluate(async ({ endpoint, method, body }) => {
    const response = await fetch(`/api${endpoint}`, { method, headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value;
  }, { endpoint, method, body });
}
async function action(name: string) {
  const job = await api(`/environments/${current!.id}/actions/${name}`, 'POST');
  await finish(job);
}
async function finish(job: { id: string }) {
  const deadline = Date.now() + 950_000;
  while (true) {
    const space = await statfs(owned); assert.ok(space.bavail * space.bsize > 80 * 2 ** 30);
    const state = await api('/snapshot'), value = state.jobs.find((j: any) => j.id === job.id);
    if (value?.status !== 'running') { assert.equal(value?.status, 'succeeded', value?.message); current = state.environments.find((e: Environment) => e.id === current!.id); return; }
    assert.ok(Date.now() < deadline); await delay(500);
  }
}
async function bootCapture(name: string) {
  const state = (await admin(['sudo', 'systemctl', 'show', '--property=SubState', '--value', 'mucodesandbox-boot-capture.service'])).trim();
  if (state !== 'exited') await admin(['sudo', 'systemctl', 'kill', '--kill-whom=main', '--signal=SIGINT', 'mucodesandbox-boot-capture.service']);
  const deadline = Date.now() + 15_000;
  while ((await admin(['sudo', 'systemctl', 'show', '--property=SubState', '--value', 'mucodesandbox-boot-capture.service'])).trim() !== 'exited') { assert.ok(Date.now() < deadline); await delay(200); }
  await admin(['sudo', 'systemctl', 'is-active', '--quiet', 'mucodesandbox-boot-capture.service']);
  const bootId = (await admin(['cat', '/proc/sys/kernel/random/boot_id'])).trim();
  assert.equal((await admin(['sudo', 'cat', '/var/log/mucodesandbox/boot-network.boot-id'])).trim(), bootId);
  await capture(name, '/var/log/mucodesandbox/boot-network.pcap', bootId);
}
async function capture(name: string, file: string, bootId?: string) {
  const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', file])).trim(), 'base64'); assert.ok(name === 'maintenance-task' ? bytes.length >= 24 : bytes.length > 24);
  const local = path.join(artifacts, `${name}.pcap`); await writeFile(local, bytes);
  const gateway = (await admin(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+) dev eth0/)![1];
  assert.equal((await admin(['cat', '/sys/class/net/eth0/ifindex'])).trim(), '2');
  const count = async (filter: string) => (await packetLines(local,filter)).length;
  const sshTransportExpected=bridgeOwner && !!report.productPackage;
  const allowed = `${sshTransportExpected?'':`(tcp and dst host ${gateway} and dst port ${fixture.proxyPort}) or `}(tcp and src port 22 and dst host ${gateway}) or (udp and src port 68 and dst port 67)`;
  const physicalOut = await count('ifindex 2 and outbound and (ip or ip6)'); if (name !== 'maintenance-task') assert.ok(physicalOut > 0);
  const unapproved = await count(`ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`); assert.equal(unapproved, 0);
  const approvedProxy = await count(`ifindex 2 and outbound and tcp and dst host ${gateway} and dst port ${fixture.proxyPort}`);
  const approvedSsh = await count(`ifindex 2 and outbound and tcp and src port 22 and dst host ${gateway}`);
  if (sshTransportExpected) assert.equal(approvedProxy,0);
  if (!bootId && name !== 'maintenance-task') assert.ok((sshTransportExpected?approvedSsh:approvedProxy) > 0);
  report.captures.push({ name, bootId, gateway, proxyPort: fixture.proxyPort, bytes: bytes.length, sha256: hash(bytes), physicalOut, approvedProxy, approvedSsh, sshTransportExpected, unapproved });
}
const fill = `import errno,json,os
assert os.getuid()==502
assert os.statvfs('/').f_blocks*os.statvfs('/').f_frsize<12*2**30
with open('/home/dev/mu-growth-canary','w') as canary:
 canary.write('MU_GROWTH_ORIGINAL');canary.flush();os.fsync(canary.fileno())
assert open('/home/dev/mu-growth-canary').read()=='MU_GROWTH_ORIGINAL'
fd=os.open('/home/dev/mu-growth-filler',os.O_CREAT|os.O_EXCL|os.O_RDWR,0o600)
n=0
for block in [256*2**20,2**20,4096]:
 while True:
  try:
   os.posix_fallocate(fd,n,block);n+=block
   assert n<12*2**30
  except OSError as e:
   assert e.errno==errno.ENOSPC;break
os.fsync(fd);os.close(fd)
try:
 f=os.open('/home/dev/mu-growth-write',os.O_CREAT|os.O_WRONLY,0o600)
 os.write(f,b'x'*4096)
 raise AssertionError('Full filesystem unexpectedly accepted write')
except OSError as e:
 assert e.errno==errno.ENOSPC
 s=os.statvfs('/')
 print(json.dumps({'uid':os.getuid(),'errno':e.errno,'canary':open('/home/dev/mu-growth-canary').read(),'fillerBytes':n,'totalBytes':s.f_blocks*s.f_frsize,'availableBytes':s.f_bavail*s.f_frsize,'rootFreeBytes':s.f_bfree*s.f_frsize}))
`;
try {
  const space = await statfs(owned); assert.ok(space.bavail * space.bsize > 100 * 2 ** 30);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  report.cdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1]; assert.equal(report.cdHash, expectedCdHash);
  if(bridgeOwner)report.sources=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,hash(await readFile(path.join(root,file)))])));
  const cache = process.env.MU_TEST_SING_BOX_CACHE; assert.ok(cache); assert.equal(hash(await readFile(cache)), SING_BOX_SHA256);
  await mkdir(path.join(directory, 'tools/sing-box'), { recursive: true }); await copyFile(cache, path.join(directory, 'tools/sing-box', SING_BOX_ARCHIVE));
  application = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
    env: { ...process.env, MU_DATA_DIR: directory, MU_DESKTOP_USER_DATA_DIR: path.join(owned, 'desktop') } });
  page = await application.firstWindow(); await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  assert.equal((await api('/snapshot')).system.dataDir, directory);
  current = await api('/environments', 'POST', { name: 'Disposable old full guest', cpus: 2, memoryGiB: 2, diskGiB: 10,
    network: { mode: 'http', host: '127.0.0.1', port: fixture.proxyPort, username: 'mu', password: 'tui-fixture', strict: true, transparent: true, noProxy: '' } });
  console.log('Starting disposable old-package guest'); await action('start'); await bootCapture('first-boot'); fixture.restrictToLocalFixture();
  report.reserveBefore = await admin(['sudo', 'tune2fs', '-l', '/dev/vda1']);
  report.reservedBytesBefore = Number(report.reserveBefore.match(/^Reserved block count:\s+(\d+)/m)[1]) * Number(report.reserveBefore.match(/^Block size:\s+(\d+)/m)[1]);
  assert.ok(report.reservedBytesBefore <= 16 * 2 ** 20);
  report.full = JSON.parse(await guest(['python3', '-c', fill], 120_000)); assert.equal(report.full.availableBytes, 0); assert.equal(report.full.canary, 'MU_GROWTH_ORIGINAL');
  await writeFile(path.join(artifacts, 'full.json'), JSON.stringify(report.full, null, 2));
  console.log('Actual old-package dev ENOSPC; stopping before disk growth');
  try { await action('stop'); report.normalStopSucceeded = true; }
  catch (error) {
    report.normalStopSucceeded = false; report.normalStopError = String(error);
    assert.match(report.normalStopError, /No space left on device/);
    await runtime.command(['stop', '--force', current!.instanceName], { timeoutMs: 120_000 });
    report.forcedStoppedRecovery = true;
  }
  assert.equal((await runtime.list()).find(row => row.name === current!.instanceName)?.status, 'Stopped');
  const disk = path.join(runtime.limaHome, current!.instanceName, 'disk'), configuration = path.join(runtime.limaHome, current!.instanceName, 'lima.yaml');
  report.rawBytesBefore = (await stat(disk)).size; assert.equal(report.rawBytesBefore, 10 * 2 ** 30);
  report.configBefore = await readFile(configuration, 'utf8');
  if (product) {
    const latest = path.join(root, `release/${bridgeOwner?'bridge-owner-candidate':'disk-recovery-candidate'}/mac-arm64/MuCodeSandbox.app`);
    const expected = bridgeOwner?'9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3':process.env.MU_TEST_PACKAGE_CD_HASH; assert.match(expected ?? '', /^[a-f0-9]{40}$/);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', latest]);
    const cdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', latest])).match(/^CDHash=(.+)$/m)?.[1]; assert.equal(cdHash, expected);
    await application.close();
    application = await electron.launch({ executablePath: path.join(latest, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
      env: { ...process.env, MU_DATA_DIR: directory, MU_DESKTOP_USER_DATA_DIR: path.join(owned, 'desktop-product') } });
    page = await application.firstWindow(); await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    const identity = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath() }));
    assert.equal(identity.packaged, true); assert.equal(identity.appPath, path.join(latest, 'Contents/Resources/app'));
    const appRoot = path.join(latest, 'Contents/Resources/app');
    const modules = ['desktop/main.cjs', ...(await readdir(path.join(appRoot, 'dist-server/server'))).filter(file => file.endsWith('.js')).map(file => `dist-server/server/${file}`)];
    if(bridgeOwner)assert.equal(modules.length,46);
    report.productPackage = { bundle: latest, cdHash, identity, modules: Object.fromEntries(await Promise.all(modules.map(async file => [file, hash(await readFile(path.join(appRoot, file)))]))) };
    await page.getByRole('button', { name: 'Disposable old full guest Linux 沙箱', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('label.field').filter({ hasText: '扩容至 / GiB' }).locator('input').fill('12');
    const submitted = page.waitForResponse(response => new URL(response.url()).pathname === `/api/environments/${current!.id}/disk` && response.request().method() === 'POST');
    await page.getByRole('button', { name: '扩容磁盘', exact: true }).click();
    const response = await submitted; assert.equal(response.status(), 202); const job = await response.json(); assert.equal(job.action, 'disk-grow');
    console.log('Actual new-package UI submitted recovery of old full guest'); await finish(job);
    assert.equal(current!.diskGiB, 12); assert.equal(current!.state, 'stopped');
    report.diskStatusAfter = await api(`/environments/${current!.id}/disk`); assert.deepEqual(report.diskStatusAfter, { pending: false, targetGiB: null });
    assert.equal((await api('/snapshot')).system.hostNetwork.state, 'ready');
    report.productUi = { submitted: true, jobId: job.id, status: 'succeeded', finalDiskGiB: current!.diskGiB, finalState: current!.state };
    report.configAfter = await readFile(configuration, 'utf8'); assert.equal(parse(report.configAfter).disk, '12GiB');
    report.maintenanceBootEarlyCaptureTested = false;
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await page.bringToFront();
    for (const [name, width, height] of [['desktop', 1360, 960], ['mobile', 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: path.join(artifacts, `recovery-${name}.png`), fullPage: true });
      const overflow: boolean = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth); assert.equal(overflow, false);
    }
    await page.setViewportSize({ width: 1360, height: 960 });
  } else {
  report.editOutput = await runtime.command(['edit', current!.instanceName, '--disk', '12'], { timeoutMs: 30_000 });
  report.configAfter = await readFile(configuration, 'utf8'); assert.equal(parse(report.configAfter).disk, '12GiB');
  assert.equal((await runtime.list()).find(row => row.name === current!.instanceName)?.status, 'Stopped');
  }
  if (!product) {
  console.log('Official Lima disk setting grown; bounded maintenance boot before app start');
  report.maintenanceBootEarlyCaptureTested = false;
  const controller = new AbortController();
  const maintenance = runtime.command(['start', '--timeout', '2m', current!.instanceName], { timeoutMs: 130_000, signal: controller.signal })
    .then(output => { report.maintenanceStartOutput = output; }, error => { report.maintenanceStartError = String(error); });
  try {
    const deadline = Date.now() + 90_000;
    while (true) {
      try { await runtime.management(current!, ['true'], { timeoutMs: 5_000 }); break; }
      catch (error) { assert.ok(Date.now() < deadline, String(error)); await delay(500); }
    }
    report.maintenanceProtection = await runtime.networkProtection({ ...current!, state: 'running' }, false);
    assert.equal(report.maintenanceProtection.firewallActive, true); assert.equal(report.maintenanceProtection.bootArmed, true);
    assert.equal(report.maintenanceProtection.integrity, 'verified'); assert.equal(report.maintenanceProtection.leaseActive, false);
    await admin(['sudo', 'systemd-run', '--quiet', '--unit=mu-growth-maintenance', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', '/run/mu-growth-maintenance.pcap', 'not (tcp src port 22)']);
    await delay(500);
    await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--proxy', '', 'http://203.0.113.81/']));
    report.filesystemGrowth = JSON.parse(await admin(['sudo', 'python3', '-c', growGuestRootScript(12)]));
    assert.equal(report.filesystemGrowth.scratchInMemory, true); assert.ok(report.filesystemGrowth.availableBytes > 2 ** 30);
    await admin(['sudo', 'systemctl', 'stop', 'mu-growth-maintenance.service']); await capture('maintenance-task', '/run/mu-growth-maintenance.pcap');
    await admin(['sudo', 'sync']);
  } finally {
    controller.abort(); await maintenance;
    await runtime.command(['stop', '--force', current!.instanceName], { timeoutMs: 120_000 });
  }
  assert.equal((await runtime.list()).find(row => row.name === current!.instanceName)?.status, 'Stopped');
  }
  console.log('Filesystem expanded without deleting filler; checking normal app restart');
  await action('start'); await bootCapture('grown-boot');
  report.rawBytesAfter = (await stat(disk)).size; assert.equal(report.rawBytesAfter, 12 * 2 ** 30);
  report.recovered = JSON.parse(await guest(['python3', '-c', `import json,os
assert os.getuid()==502
f=open('/home/dev/mu-growth-write','w');f.write('MU_GROWTH_RECOVERED');f.flush();os.fsync(f.fileno());f.close()
s=os.statvfs('/')
print(json.dumps({'uid':os.getuid(),'totalBytes':s.f_blocks*s.f_frsize,'availableBytes':s.f_bavail*s.f_frsize,'canary':open('/home/dev/mu-growth-canary').read(),'fillerBytes':os.stat('/home/dev/mu-growth-filler').st_size,'written':open('/home/dev/mu-growth-write').read()}))`]));
  assert.equal(report.recovered.canary, 'MU_GROWTH_ORIGINAL'); assert.equal(report.recovered.fillerBytes, report.full.fillerBytes);
  assert.equal(report.recovered.written, 'MU_GROWTH_RECOVERED'); assert.ok(report.recovered.availableBytes > 2 ** 30);
  assert.ok(report.recovered.totalBytes > report.full.totalBytes + 2 ** 30);
  await writeFile(path.join(artifacts, 'recovered.json'), JSON.stringify(report.recovered, null, 2));
  await admin(['sudo', 'systemd-run', '--quiet', '--unit=mu-growth-capture', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', '/run/mu-growth.pcap', ...(bridgeOwner?[]:['not (tcp src port 22)'])]);
  await delay(500); const before = requests;
  assert.equal((await guest(['curl', '--fail', '--silent', '--max-time', '5', '--proxy', '', 'http://203.0.113.81/'])).trim(), 'MU_GROWTH_NETWORK_OK'); assert.ok(requests > before);
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--interface', 'eth0', '--proxy', '', 'http://203.0.113.81/']));
  report.protection = await api(`/environments/${current!.id}/network/protection`); assert.equal(report.protection.active, true);
  await admin(['sudo', 'systemctl', 'stop', 'mu-growth-capture.service']); await capture('grown-task', '/run/mu-growth.pcap');
  assert.equal(new Set(report.captures.filter((c: any) => c.bootId).map((c: any) => c.bootId)).size, 2);
  report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  await application?.close().catch(error => { report.cleanupError = String(error); });
  await fixture.close(); target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve()));
  try {
    for (const row of await runtime.list()) { if (row.status === 'Running') await runtime.command(['stop', row.name], { timeoutMs: 120_000 }); await runtime.command(['delete', row.name], { timeoutMs: 120_000 }); }
    assert.deepEqual(await runtime.list(), []); await rm(owned, { recursive: true }); report.testResourcesRemoved = true;
  } catch (error) { report.cleanupError = String(error); report.retainedTestRoot = owned; }
  if (report.cleanupError) { report.passed = false; process.exitCode = 1; }
  report.targetRequests = requests;
  if(bridgeOwner){
    for(const [file,digest] of Object.entries(report.sources??{}))assert.equal(hash(await readFile(path.join(root,file))),digest,'Source changed during recovery acceptance');
    const appRoot=path.join(report.productPackage?.bundle??path.join(root,'release/bridge-owner-candidate/mac-arm64/MuCodeSandbox.app'),'Contents/Resources/app');
    for(const [file,digest] of Object.entries(report.productPackage?.modules??{}))assert.equal(hash(await readFile(path.join(appRoot,file))),digest,'Package changed during recovery acceptance');
  }
  for (const file of sourceFiles) await copyFile(path.join(root, file), path.join(artifacts, `source-${path.basename(file)}`));
  report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, hash(await readFile(path.join(artifacts, file)))])));
  report.finishedAt = new Date().toISOString(); await writeFile(path.join(root, `test-results/${reportName}.json`), JSON.stringify(report, null, 2));
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, error: report.error, cleanupError: report.cleanupError, testResourcesRemoved: report.testResourcesRemoved, full: report.full, recovered: report.recovered, captures: report.captures }, null, 2));
}
