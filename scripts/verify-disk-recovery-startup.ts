import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
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
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const bridgeOwner = process.argv.includes('--bridge-owner');
const monitor = process.argv.includes('--monitor') || bridgeOwner;
const reportName = bridgeOwner ? 'disk-recovery-startup-bridge-owner' : monitor ? 'disk-recovery-monitor' : 'disk-recovery-startup';
const bundle = path.join(root, `release/${bridgeOwner ? 'bridge-owner-candidate' : monitor ? 'disk-recovery-monitor-candidate' : 'disk-recovery-candidate'}/mac-arm64/MuCodeSandbox.app`);
const owned = await mkdtemp(path.join(homedir(), '.mu-disk-startup-')), directory = path.join(owned, 'data');
const artifacts = path.join(root, 'test-results', `${reportName}-${Date.now()}`); await mkdir(artifacts, { mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const runtime = new LimaRuntime(directory), hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let businessRequests = 0;
const target = createServer((_req, res) => { businessRequests++; res.end('MU_DISK_STARTUP_OK'); });
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const fixture = await createClaudeLocalFixture({ browserPort: (target.address() as { port: number }).port });
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), bundle, artifactsDirectory: artifacts,
  accountFree: true, paidModelCalls: 0, actualVmTested: true, actualElectronMainKillTested: false,
  maintenanceEarlyCaptureTested: false, physicalPowerLossTested: false, browserOrCliTested: false, captures: [], requests: [] };
const sourceFiles = ['verify-disk-recovery-startup.ts', 'disk-recovery-fault-worker.ts', 'claude-local-fixture.ts', 'packet-capture.ts', ...(monitor ? ['disk-recovery-late-start-worker.ts'] : [])];
let app: ElectronApplication | undefined, page: Page | undefined, current: Environment | undefined, worker: ChildProcess | undefined;
const admin = (args: string[]) => runtime.management(current!, args, { timeoutMs: 30_000, maxBytes: 32_000_000 });
const guest = (args: string[]) => runtime.guest(current!, args, { timeoutMs: 20_000 });
async function reserve() { const s = await statfs(owned); assert.ok(s.bavail * s.bsize > 80 * 2 ** 30); }
async function api(endpoint: string, method = 'GET', body?: unknown, allowError = false): Promise<any> {
  const response = await page!.evaluate(async ({ endpoint, method, body }) => {
    const r = await fetch(`/api${endpoint}`, { method, headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    return { status: r.status, body: await r.json() };
  }, { endpoint, method, body });
  if (allowError) return response; assert.ok(response.status < 400, JSON.stringify(response)); return response.body;
}
async function finish(job: { id: string }) {
  const deadline = Date.now() + 950_000;
  while (true) {
    await reserve(); const snapshot = await api('/snapshot'), row = snapshot.jobs.find((j: any) => j.id === job.id);
    if (row?.status !== 'running') { assert.equal(row?.status, 'succeeded', row?.message); current = snapshot.environments.find((e: Environment) => e.id === current!.id); return; }
    assert.ok(Date.now() < deadline); await delay(250);
  }
}
async function action(name: string) { await finish(await api(`/environments/${current!.id}/actions/${name}`, 'POST')); }
async function open() {
  app = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
    env: { ...process.env, MU_DATA_DIR: directory, MU_DESKTOP_USER_DATA_DIR: path.join(owned, 'desktop') } });
  page = await app.firstWindow(); await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.webContents.setBackgroundThrottling(false); w.hide(); });
  const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath() }));
  assert.equal(identity.packaged, true); assert.equal(identity.appPath, path.join(bundle, 'Contents/Resources/app'));
  assert.equal((await api('/snapshot')).system.hostNetwork.state, 'ready');
}
async function close() { await app?.close(); app = undefined; page = undefined; }
async function capture(name: string, source: string, boot: boolean) {
  if (boot) {
    const status = () => admin(['sudo', 'systemctl', 'show', '--property=SubState', '--value', 'mucodesandbox-boot-capture.service']);
    if ((await status()).trim() !== 'exited') await admin(['sudo', 'systemctl', 'kill', '--kill-whom=main', '--signal=SIGINT', 'mucodesandbox-boot-capture.service']);
    const deadline = Date.now() + 15_000;
    while ((await status()).trim() !== 'exited') { assert.ok(Date.now() < deadline); await delay(200); }
  }
  const data = Buffer.from((await admin(['sudo', 'base64', '-w0', source])).trim(), 'base64'); assert.ok(data.length >= 24);
  const file = path.join(artifacts, `${name}.pcap`); await writeFile(file, data);
  const gateway = (await admin(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+) dev eth0/)![1];
  assert.equal((await admin(['cat', '/sys/class/net/eth0/ifindex'])).trim(), '2');
  const allowed = `${bridgeOwner ? '' : `(tcp and dst host ${gateway} and dst port ${fixture.proxyPort}) or `}(tcp and src port 22 and dst host ${gateway}) or (udp and src port 68 and dst port 67)`;
  const physicalOut = (await packetLines(file, 'ifindex 2 and outbound and (ip or ip6)')).length;
  const approvedProxy = (await packetLines(file, `ifindex 2 and outbound and tcp and dst host ${gateway} and dst port ${fixture.proxyPort}`)).length;
  const approvedSsh = (await packetLines(file, `ifindex 2 and outbound and tcp and src port 22 and dst host ${gateway}`)).length;
  if (bridgeOwner) assert.equal(approvedProxy, 0);
  const unapproved = (await packetLines(file, `ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`)).length; assert.equal(unapproved, 0);
  const c: Record<string, any> = { name, bytes: data.length, sha256: hash(data), gateway, proxyPort: fixture.proxyPort, physicalOut, approvedProxy, approvedSsh, unapproved };
  if (boot) {
    assert.ok(physicalOut > 0); c.bootId = (await admin(['cat', '/proc/sys/kernel/random/boot_id'])).trim();
    c.capturedBootId = (await admin(['sudo', 'cat', '/var/log/mucodesandbox/boot-network.boot-id'])).trim(); assert.equal(c.bootId, c.capturedBootId);
  }
  report.captures.push(c);
}
async function requests(name: string, allowed: boolean) {
  const unit = `mu-disk-startup-${name}`, file = `/run/${unit}.pcap`;
  await admin(['sudo', 'systemd-run', '--quiet', `--unit=${unit}`, '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', file, bridgeOwner ? 'ip or ip6' : 'not (tcp src port 22)']);
  await delay(300);
  const args = ['curl', '--fail', '--silent', '--max-time', '3', '--proxy', '', 'http://203.0.113.81/'];
  const before = businessRequests;
  if (allowed) assert.equal((await guest(args)).trim(), 'MU_DISK_STARTUP_OK'); else await assert.rejects(guest(args));
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--interface', 'eth0', '--proxy', '', 'http://203.0.113.81/']));
  await admin(['sudo', 'systemctl', 'stop', `${unit}.service`]); await capture(name, file, false);
  assert.equal(businessRequests, before + (allowed ? 1 : 0));
  report.requests.push({ name, allowed, before, after: businessRequests, at: new Date().toISOString(), directBypassRejected: true });
  if (bridgeOwner) assert.ok(report.captures.at(-1).approvedSsh > 0);
  else assert.equal(report.captures.at(-1).approvedProxy > 0, allowed);
}
try {
  await reserve(); await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  report.cdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1];
  assert.equal(report.cdHash, bridgeOwner ? '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3' : monitor ? 'b3b92b627f33d1b810011558fa4ba0c18cddd934' : 'e1caee59d8049dccf71e42c2e37bf62518d2d05a');
  if (bridgeOwner) {
    const files = ['desktop/main.cjs', ...(await readdir(path.join(bundle, 'Contents/Resources/app/dist-server/server'))).filter(file => file.endsWith('.js')).map(file => `dist-server/server/${file}`)];
    report.initialModules = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(path.join(bundle, 'Contents/Resources/app', file)))])));
    report.initialSources = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(path.join(root, 'scripts', file)))])));
  }
  const cache = process.env.MU_TEST_SING_BOX_CACHE; assert.ok(cache); assert.equal(hash(await readFile(cache)), SING_BOX_SHA256);
  await mkdir(path.join(directory, 'tools/sing-box'), { recursive: true }); await copyFile(cache, path.join(directory, 'tools/sing-box', SING_BOX_ARCHIVE));
  await open(); current = await api('/environments', 'POST', { name: 'Disposable maintenance startup verification', diskGiB: 10, memoryGiB: 2, cpus: 2,
    network: { mode: 'http', host: '127.0.0.1', port: fixture.proxyPort, username: 'mu', password: 'tui-fixture', strict: true, transparent: true } });
  console.log('Preparing actual VM and positive network control');
  await action('start'); await capture('initial-boot', '/var/log/mucodesandbox/boot-network.pcap', true); fixture.restrictToLocalFixture();
  await guest(['python3', '-c', "import os\nf=open('/home/dev/disk-startup-canary','w');f.write('MU_DISK_STARTUP_ORIGINAL');f.flush();os.fsync(f.fileno());f.close()"]);
  await requests('initial-task', true); await action('stop');
  await page!.getByRole('button', { name: `${current!.name} Linux 沙箱`, exact: true }).click(); await page!.getByRole('button', { name: '设置', exact: true }).click();
  const input = page!.getByLabel('扩容至 / GiB'); await input.waitFor();
  await page!.getByRole('button', { name: '扩容磁盘', exact: true }).waitFor();
  await input.fill('12');
  const proc = app!.process(), exited = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })));
  const journalFile = path.join(directory, 'disk-recovery', current!.id, 'journal.json');
  let watcher: ReturnType<typeof watch> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const killed = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Electron disk journal was not observed')), 30_000);
    watcher = watch(directory, { recursive: true }, (_event, name) => {
      if (!String(name).endsWith('journal.json')) return;
      watcher?.close(); void readFile(journalFile).then(async bytes => {
        assert.equal(JSON.parse(JSON.parse(bytes.toString()).body).stage, 'pending');
        report.electronPid = proc.pid; report.journalObservedAt = new Date().toISOString();
        assert.ok(proc.kill('SIGKILL')); await writeFile(path.join(artifacts, 'electron-kill-journal.json'), bytes);
        clearTimeout(timer); resolve();
      }, reject).catch(reject);
    });
  });
  console.log('Killing actual Electron main process after durable pending journal publication');
  const trigger = page!.getByRole('button', { name: '扩容磁盘', exact: true }).click().catch(() => {});
  try { await killed; report.electronExit = await exited; } finally { clearTimeout(timer); watcher?.close(); }
  await trigger; assert.deepEqual(report.electronExit, { code: null, signal: 'SIGKILL' }); report.actualElectronMainKillTested = true;
  await close().catch(() => { app = undefined; page = undefined; });
  await open(); current = (await api('/snapshot')).environments.find((e: Environment) => e.id === current!.id);
  assert.equal(current!.state, 'error'); assert.deepEqual(await api(`/environments/${current!.id}/disk`), { pending: true, targetGiB: 12 });
  const stoppedDeadline = Date.now() + 30_000; report.reopenObservations = [];
  while (true) {
    const status = (await runtime.list()).find(row => row.name === current!.instanceName)?.status;
    const gate = await api(`/environments/${current!.id}/actions/start`, 'POST', undefined, true); assert.equal(gate.status, 409);
    const terminal = await api(`/environments/${current!.id}/terminal-ticket`, 'POST', { command: 'shell' }, true); assert.equal(terminal.status, 409);
    report.reopenObservations.push({ at: new Date().toISOString(), status, startStatus: gate.status, terminalStatus: terminal.status });
    if (status === 'Stopped') break;
    assert.ok(Date.now() < stoppedDeadline, 'Interrupted maintenance did not stop after reopening');
    await delay(500); await api('/snapshot');
  }
  report.pendingStartRejected = true; report.pendingTerminalRejected = true;
  await close();
  if (monitor) {
    console.log('Checking automatic shutdown of a real late startup without Electron or UI polling');
    worker = spawn(process.execPath, [path.join(root, 'scripts/disk-recovery-late-start-worker.ts'), directory, current!.id, bundle], { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const ended = new Promise(resolve => worker!.once('exit', (code, signal) => resolve({ code, signal })));
    report.lateStart = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Automatic late-start monitor timed out')), 45_000);
      worker!.once('error', error => { clearTimeout(timer); reject(error); });
      worker!.once('exit', () => { clearTimeout(timer); reject(new Error('Late-start worker exited before reporting')); });
      worker!.on('message', (message: any) => { clearTimeout(timer); if (message.error) reject(new Error(message.error)); else resolve(message); });
    });
    assert.equal(report.lateStart.pid, worker.pid); assert.equal(report.lateStart.passed, true);
    report.lateStart.exit = await ended; assert.deepEqual(report.lateStart.exit, { code: 0, signal: null }); worker = undefined;
  }
  worker = spawn(process.execPath, [path.join(root, 'scripts/disk-recovery-fault-worker.ts'), directory, current!.id, bundle, 'before-filesystem'], { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const workerExit = new Promise(resolve => worker!.once('exit', (code, signal) => resolve({ code, signal })));
  const checkpoint = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Maintenance checkpoint timed out')), 150_000);
    worker!.once('exit', () => { clearTimeout(timer); reject(new Error('Worker exited before maintenance checkpoint')); });
    worker!.once('error', error => { clearTimeout(timer); reject(error); });
    worker!.on('message', (m: any) => { if (m.error || m.checkpoint) { clearTimeout(timer); if (m.error) reject(new Error(m.error)); else resolve(m); } });
  });
  assert.equal(checkpoint.pid, worker.pid); assert.equal(checkpoint.compiled, path.join(bundle, 'Contents/Resources/app/dist-server/server')); report.maintenanceWorker = checkpoint;
  report.maintenanceConfiguration = parse(await readFile(path.join(runtime.limaHome, current!.instanceName, 'lima.yaml'), 'utf8'));
  assert.deepEqual(report.maintenanceConfiguration.mounts, []); assert.deepEqual(report.maintenanceConfiguration.provision, []); assert.deepEqual(report.maintenanceConfiguration.probes, []);
  report.maintenanceProtection = await runtime.networkProtection({ ...current!, mounts: [], state: 'running' }, false);
  assert.equal(report.maintenanceProtection.integrity, 'verified'); assert.equal(report.maintenanceProtection.leaseActive, false); assert.equal(report.maintenanceProtection.firewallActive, true);
  const units = ['mucodesandbox-boot-capture.service', 'mucodesandbox-egress.service', 'mucodesandbox-lease.service', 'systemd-networkd.service'];
  report.ordering = {};
  for (const unit of units) {
    const text = await admin(['sudo', 'systemctl', 'show', unit, '--property=ActiveState,SubState,ActiveEnterTimestampMonotonic,ExecMainStartTimestampMonotonic,After,Requires,Before']);
    await writeFile(path.join(artifacts, `${unit}.txt`), text); report.ordering[unit] = Object.fromEntries(text.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  }
  const networkStart = Number(report.ordering['systemd-networkd.service'].ExecMainStartTimestampMonotonic);
  for (const unit of units.slice(0, 3)) assert.ok(Number(report.ordering[unit].ActiveEnterTimestampMonotonic) > 0 && Number(report.ordering[unit].ActiveEnterTimestampMonotonic) < networkStart, unit);
  console.log('Capturing maintenance boot before network activation, with the task lease closed');
  await capture('maintenance-boot', '/var/log/mucodesandbox/boot-network.pcap', true); assert.equal(report.captures.at(-1).approvedProxy, 0);
  await requests('maintenance-closed', false); report.maintenanceEarlyCaptureTested = true;
  assert.ok(worker!.kill('SIGKILL')); report.maintenanceWorkerExit = await workerExit; worker = undefined;
  await open(); await page!.getByRole('button', { name: `${current!.name} Linux 沙箱`, exact: true }).click(); await page!.getByRole('button', { name: '设置', exact: true }).click();
  const response = page!.waitForResponse(r => new URL(r.url()).pathname === `/api/environments/${current!.id}/disk` && r.request().method() === 'POST');
  await page!.getByRole('button', { name: '重试扩容', exact: true }).click(); const r = await response; assert.equal(r.status(), 202); await finish(await r.json());
  assert.equal(current!.diskGiB, 12); assert.deepEqual(await api(`/environments/${current!.id}/disk`), { pending: false, targetGiB: null }); report.actualUiRetrySucceeded = true;
  await action('start'); await capture('recovered-boot', '/var/log/mucodesandbox/boot-network.pcap', true);
  assert.equal((await guest(['cat', '/home/dev/disk-startup-canary'])).trim(), 'MU_DISK_STARTUP_ORIGINAL'); report.canaryPreserved = true;
  await requests('recovered-task', true); await action('stop'); report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  if (worker && worker.exitCode === null && worker.signalCode === null) { const ended = new Promise(resolve => worker!.once('exit', resolve)); worker.kill('SIGKILL'); await ended; }
  await close().catch(error => { report.cleanupError = String(error); }); await fixture.close(); target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve()));
  try {
    for (const row of await runtime.list()) { if (row.status === 'Running') await runtime.command(['stop', '--force', row.name], { timeoutMs: 120_000 }); await runtime.command(['delete', '--force', row.name], { timeoutMs: 120_000 }); }
    assert.deepEqual(await runtime.list(), []); await rm(owned, { recursive: true }); report.testResourcesRemoved = true;
  } catch (error) { report.cleanupError = String(error); report.retainedTestRoot = owned; }
  if (report.cleanupError) { report.passed = false; process.exitCode = 1; }
  const modules = ['desktop/main.cjs', ...(await readdir(path.join(bundle, 'Contents/Resources/app/dist-server/server'))).filter(f => f.endsWith('.js')).map(f => `dist-server/server/${f}`)];
  report.modules = Object.fromEntries(await Promise.all(modules.map(async file => [file, hash(await readFile(path.join(bundle, 'Contents/Resources/app', file)))])));
  if (bridgeOwner) {
    try { assert.deepEqual(report.modules, report.initialModules);
      for (const [file, digest] of Object.entries(report.initialSources ?? {})) assert.equal(hash(await readFile(path.join(root, 'scripts', file))), digest);
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]); report.inputsUnchanged = true;
    } catch (error) { report.inputsError = String(error); report.passed = false; process.exitCode = 1; }
  }
  report.businessRequests = businessRequests;
  for (const file of sourceFiles) await copyFile(path.join(root, 'scripts', file), path.join(artifacts, `source-${file}`));
  report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, hash(await readFile(path.join(artifacts, file)))])));
  report.finishedAt = new Date().toISOString(); await writeFile(path.join(root, `test-results/${reportName}.json`), JSON.stringify(report, null, 2));
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
