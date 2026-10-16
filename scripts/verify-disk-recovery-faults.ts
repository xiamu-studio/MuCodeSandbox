import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
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
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const bridgeOwner = process.argv.includes('--bridge-owner');
const monitor = bridgeOwner || process.argv.includes('--monitor');
const reportName = bridgeOwner ? 'disk-recovery-faults-bridge-owner' : monitor ? 'disk-recovery-faults-monitor' : 'disk-recovery-faults';
const bundle = path.join(root, `release/${bridgeOwner ? 'bridge-owner-candidate' : monitor ? 'disk-recovery-monitor-candidate' : 'disk-recovery-candidate'}/mac-arm64/MuCodeSandbox.app`);
const owned = await mkdtemp(path.join(homedir(), '.mu-disk-fault-'));
const directory = path.join(owned, 'data'), project = path.join(owned, 'project');
const artifacts = path.join(root, 'test-results', `${reportName}-${Date.now()}`);
await mkdir(artifacts, { mode: 0o700 }); await mkdir(project);
await writeFile(path.join(project, 'canary.txt'), 'MU_HOST_PROJECT_ORIGINAL');
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const runtime = new LimaRuntime(directory), hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let businessRequests=0;
const target = createServer((_req, res) => {businessRequests++;res.end('MU_DISK_FAULT_NETWORK_OK');});
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const fixture = await createClaudeLocalFixture({ browserPort: (target.address() as { port: number }).port });
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), bundle, artifactsDirectory: artifacts,
  diskRecoveryMonitorPackageTested: monitor,
  bridgeOwnerPackageTested: bridgeOwner,
  accountFree: true, paidModelCalls: 0, actualVmTested: true, actualElectronReopenTested: true,
  faultProcess: 'Node worker executing frozen package Manager/Runtime/DiskRecovery; pause-only instrumentation at actual operations',
  physicalPowerLossTested: false, maintenanceFirstPacketTested: false, browserOrCliTested: false, phases: [], captures: [] };
let app: ElectronApplication | undefined, page: Page | undefined, worker: ChildProcess | undefined, current: Environment | undefined;
const sourceFiles=['scripts/verify-disk-recovery-faults.ts','scripts/disk-recovery-fault-worker.ts','scripts/claude-local-fixture.ts','scripts/packet-capture.ts'];
let baseline = '';
const admin = (args: string[]) => runtime.management(current!, args, { timeoutMs: 30_000, maxBytes: 32_000_000 });
const guest = (args: string[]) => runtime.guest(current!, args, { timeoutMs: 20_000 });
async function reserve() { const s = await statfs(owned); assert.ok(s.bavail * s.bsize > 80 * 2 ** 30); }
async function api(endpoint: string, method = 'GET', body?: unknown, errorAllowed = false): Promise<any> {
  const response = await page!.evaluate(async ({ endpoint, method, body }) => {
    const r = await fetch(`/api${endpoint}`, { method, headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    return { status: r.status, body: await r.json() };
  }, { endpoint, method, body });
  if (errorAllowed) return response;
  assert.ok(response.status < 400, JSON.stringify(response)); return response.body;
}
async function finish(job: { id: string }, succeeded = true) {
  const deadline = Date.now() + 950_000;
  while (true) {
    await reserve(); const snapshot = await api('/snapshot'), row = snapshot.jobs.find((j: any) => j.id === job.id);
    if (row?.status !== 'running') {
      assert.equal(row?.status, succeeded ? 'succeeded' : 'failed', row?.message);
      current = snapshot.environments.find((e: Environment) => e.id === current!.id); return row;
    }
    assert.ok(Date.now() < deadline); await delay(250);
  }
}
async function action(name: string) { await finish(await api(`/environments/${current!.id}/actions/${name}`, 'POST')); }
async function openApp() {
  app = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
    env: { ...process.env, MU_DATA_DIR: directory, MU_DESKTOP_USER_DATA_DIR: path.join(owned, 'desktop') } });
  page = await app.firstWindow(); await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.webContents.setBackgroundThrottling(false); w.hide(); });
  const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath() }));
  assert.equal(identity.packaged, true); assert.equal(identity.appPath, path.join(bundle, 'Contents/Resources/app'));
  assert.equal((await api('/snapshot')).system.hostNetwork.state, 'ready');
}
async function closeApp() { await app?.close(); app = undefined; page = undefined; }
async function capture(name: string, source: string, boot = false) {
  if (boot) {
    const status = () => admin(['sudo', 'systemctl', 'show', '--property=SubState', '--value', 'mucodesandbox-boot-capture.service']);
    if ((await status()).trim() !== 'exited') await admin(['sudo', 'systemctl', 'kill', '--kill-whom=main', '--signal=SIGINT', 'mucodesandbox-boot-capture.service']);
    const until = Date.now() + 15_000;
    while ((await status()).trim() !== 'exited') { assert.ok(Date.now() < until); await delay(200); }
  }
  const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', source])).trim(), 'base64'); assert.ok(bytes.length >= 24);
  const file = path.join(artifacts, `${name}.pcap`); await writeFile(file, bytes);
  const gateway = (await admin(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+) dev eth0/)![1];
  assert.equal((await admin(['cat', '/sys/class/net/eth0/ifindex'])).trim(), '2');
  const allowed = `${bridgeOwner?'':`(tcp and dst host ${gateway} and dst port ${fixture.proxyPort}) or `}(tcp and src port 22 and dst host ${gateway}) or (udp and src port 68 and dst port 67)`;
  const physicalOut = (await packetLines(file, 'ifindex 2 and outbound and (ip or ip6)')).length;
  const approvedProxy = (await packetLines(file, `ifindex 2 and outbound and tcp and dst host ${gateway} and dst port ${fixture.proxyPort}`)).length;
  const approvedSsh = (await packetLines(file, `ifindex 2 and outbound and tcp and src port 22 and dst host ${gateway}`)).length;
  if(bridgeOwner)assert.equal(approvedProxy,0);
  const unapproved = (await packetLines(file, `ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`)).length; assert.equal(unapproved, 0);
  const bootId = boot ? (await admin(['cat', '/proc/sys/kernel/random/boot_id'])).trim() : undefined;
  if (boot) { assert.ok(physicalOut > 0); assert.equal((await admin(['sudo', 'cat', '/var/log/mucodesandbox/boot-network.boot-id'])).trim(), bootId); }
  report.captures.push({ name, bytes: bytes.length, sha256: hash(bytes), gateway, proxyPort: fixture.proxyPort, physicalOut, approvedProxy, approvedSsh, unapproved, bootId });
}
async function taskCapture(name: string, allowed: boolean) {
  const unit = `mu-disk-fault-${name}`, file = `/run/${unit}.pcap`;
  await admin(['sudo', 'systemd-run', '--quiet', `--unit=${unit}`, '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', file, ...(bridgeOwner?[]:['not (tcp src port 22)'])]);
  await delay(300);
  const request = ['curl', '--fail', '--silent', '--max-time', '3', '--proxy', '', 'http://203.0.113.81/'];
  const before=businessRequests;
  if (allowed) assert.equal((await guest(request)).trim(), 'MU_DISK_FAULT_NETWORK_OK'); else await assert.rejects(guest(request));
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--interface', 'eth0', '--proxy', '', 'http://203.0.113.81/']));
  await admin(['sudo', 'systemctl', 'stop', `${unit}.service`]); await capture(name, file);
  if(bridgeOwner){
    assert.equal(businessRequests-before,allowed?1:0);
    Object.assign(report.captures.at(-1),{businessAllowed:allowed,businessRequestsBefore:before,businessRequestsAfter:businessRequests});
    if(allowed)assert.ok(report.captures.at(-1).approvedSsh>0);
  }else assert.equal(report.captures.at(-1).approvedProxy > 0, allowed);
}
async function startWorker(point: string) {
  worker = spawn(process.execPath, [path.join(root, 'scripts/disk-recovery-fault-worker.ts'), directory, current!.id, bundle, point],
    { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => worker!.once('exit', (code, signal) => resolve({ code, signal })));
  const ready = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fault checkpoint timed out: ${point}`)), 150_000);
    worker!.once('error', error => { clearTimeout(timer); reject(error); });
    worker!.once('exit', () => { clearTimeout(timer); reject(new Error(`Worker exited before ${point}`)); });
    worker!.on('message', (message: any) => { if (message.error) { clearTimeout(timer); reject(new Error(message.error)); }
      if (message.checkpoint === point) { clearTimeout(timer); resolve(message); } });
  });
  assert.equal(ready.pid, worker.pid); assert.equal(ready.compiled, path.join(bundle, 'Contents/Resources/app/dist-server/server'));
  return { exited, ready };
}
try {
  await reserve(); await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  report.cdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1];
  assert.equal(report.cdHash, bridgeOwner ? '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3' : monitor ? 'b3b92b627f33d1b810011558fa4ba0c18cddd934' : 'e1caee59d8049dccf71e42c2e37bf62518d2d05a');
  if(bridgeOwner){
    const modules=['desktop/main.cjs',...(await readdir(path.join(bundle,'Contents/Resources/app/dist-server/server'))).filter(file=>file.endsWith('.js')).map(file=>`dist-server/server/${file}`)];assert.equal(modules.length,46);
    report.modules=Object.fromEntries(await Promise.all(modules.map(async file=>[file,hash(await readFile(path.join(bundle,'Contents/Resources/app',file)))])));
    report.sources=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,hash(await readFile(path.join(root,file)))])));
  }
  const cache = process.env.MU_TEST_SING_BOX_CACHE; assert.ok(cache); assert.equal(hash(await readFile(cache)), SING_BOX_SHA256);
  await mkdir(path.join(directory, 'tools/sing-box'), { recursive: true }); await copyFile(cache, path.join(directory, 'tools/sing-box', SING_BOX_ARCHIVE));
  await openApp();
  current = await api('/environments', 'POST', { name: 'Disposable disk fault verification', diskGiB: 10, memoryGiB: 2, cpus: 2,
    mounts: [{ id: crypto.randomUUID(), hostPath: project, guestPath: '/workspace/project', writable: true }],
    network: { mode: 'http', host: '127.0.0.1', port: fixture.proxyPort, username: 'mu', password: 'tui-fixture', strict: true, transparent: true } });
  console.log('Preparing owned protected shared guest and 10 GiB baseline snapshot');
  await action('start'); await capture('initial-boot', '/var/log/mucodesandbox/boot-network.pcap', true); fixture.restrictToLocalFixture();
  await guest(['python3', '-c', "import os\nf=open('/home/dev/disk-fault-canary','w');f.write('MU_DISK_FAULT_ORIGINAL');f.flush();os.fsync(f.fileno());f.close()"]);
  await taskCapture('initial-task', true); await action('stop');
  await finish(await api(`/environments/${current!.id}/snapshots`, 'POST', { name: 'Small disk baseline' }));
  baseline = (await api(`/environments/${current!.id}/snapshots`))[0].id;
  for (const point of ['before-filesystem', 'after-filesystem', 'after-database']) {
    console.log(`Actual frozen-package maintenance interruption: ${point}`);
    await closeApp(); const { exited, ready } = await startWorker(point);
    const phase: Record<string, any> = { point, worker: ready }; report.phases.push(phase);
    const raw = await readFile(path.join(directory, 'disk-recovery', current!.id, 'journal.json'));
    const sealed = JSON.parse(raw.toString()), key = await readFile(path.join(directory, 'credentials.key'));
    assert.equal(createHmac('sha256', key).update('MuCodeSandbox disk recovery v1\n').update(sealed.body).digest('hex'), sealed.mac);
    const journal = JSON.parse(sealed.body); assert.equal(journal.targetGiB, 12); assert.equal(journal.stage, point === 'after-database' ? 'grown' : 'pending');
    phase.journalStage = journal.stage; phase.signedJournalVerified = true; await writeFile(path.join(artifacts, `${point}-journal.json`), raw);
    const configuration = parse(await readFile(path.join(runtime.limaHome, current!.instanceName, 'lima.yaml'), 'utf8'));
    phase.installedDiskGiB = configuration.disk; assert.equal(configuration.disk, '12GiB');
    if (point !== 'after-database') {
      assert.deepEqual(configuration.mounts, []); assert.deepEqual(configuration.provision, []); assert.deepEqual(configuration.probes, []);
      phase.maintenanceMounts = (await admin(['cat', '/proc/self/mountinfo'])).split('\n').filter(line => line.includes(' - virtiofs ')); assert.deepEqual(phase.maintenanceMounts, []);
      phase.protection = await runtime.networkProtection({ ...current!, mounts: [], state: 'running' }, false);
      assert.equal(phase.protection.integrity, 'verified'); assert.equal(phase.protection.leaseActive, false); assert.equal(phase.protection.firewallActive, true);
      await taskCapture(`${point}-closed`, false);
    } else assert.equal((await runtime.list()).find(row => row.name === current!.instanceName)?.status, 'Stopped');
    assert.equal(await readFile(path.join(project, 'canary.txt'), 'utf8'), 'MU_HOST_PROJECT_ORIGINAL');
    assert.ok(worker!.kill('SIGKILL')); phase.workerExit = await exited; assert.equal(phase.workerExit.signal, 'SIGKILL'); worker = undefined;
    await openApp(); const snapshot = await api('/snapshot'); current = snapshot.environments.find((e: Environment) => e.id === current!.id);
    assert.equal(current!.state, 'error'); assert.equal(current!.diskGiB, point === 'after-database' ? 12 : 10);
    assert.equal((await runtime.list()).find(row => row.name === current!.instanceName)?.status, 'Stopped');
    assert.deepEqual(await api(`/environments/${current!.id}/disk`), { pending: true, targetGiB: 12 });
    phase.reopenedState = current!.state; phase.reopenedDiskGiB = current!.diskGiB;
    const start = await api(`/environments/${current!.id}/actions/start`, 'POST', undefined, true); assert.equal(start.status, 409); assert.match(start.body.error, /磁盘维护尚未完成/);
    const update = await api(`/environments/${current!.id}`, 'PUT', { name: 'Blocked pending edit' }, true); assert.equal(update.status, 409); assert.match(update.body.error, /磁盘维护尚未完成/);
    const terminal = await api(`/environments/${current!.id}/terminal-ticket`, 'POST', { command: 'shell' }, true); assert.equal(terminal.status, 409);
    const denied = await finish(await api(`/environments/${current!.id}/snapshots`, 'POST', { name: 'Blocked pending snapshot' }), false); assert.match(denied.message, /磁盘维护尚未完成/);
    phase.pendingGates = { startRejected: true, updateRejected: true, terminalRejected: true, snapshotRejected: true, stoppedAfterReopen: true };
    await page!.getByRole('button', { name: `${current!.name} Linux 沙箱`, exact: true }).click();
    await page!.getByRole('button', { name: '设置', exact: true }).click();
    const response = page!.waitForResponse(r => new URL(r.url()).pathname === `/api/environments/${current!.id}/disk` && r.request().method() === 'POST');
    await page!.getByRole('button', { name: '重试扩容', exact: true }).click(); const r = await response; assert.equal(r.status(), 202); await finish(await r.json());
    assert.equal(current!.diskGiB, 12); assert.equal(current!.state, 'stopped'); assert.deepEqual(await api(`/environments/${current!.id}/disk`), { pending: false, targetGiB: null });
    phase.actualUiRetrySucceeded = true;
    await action('start'); await capture(`${point}-recovered-boot`, '/var/log/mucodesandbox/boot-network.pcap', true);
    assert.equal((await guest(['cat', '/home/dev/disk-fault-canary'])).trim(), 'MU_DISK_FAULT_ORIGINAL'); await taskCapture(`${point}-recovered-task`, true);
    phase.canaryPreserved = true; await action('stop');
    console.log(`Restoring original smaller snapshot after ${point}`);
    await finish(await api(`/environments/${current!.id}/snapshots/${baseline}/restore`, 'POST'));
    assert.equal(current!.diskGiB, 10); assert.equal((await stat(path.join(runtime.limaHome, current!.instanceName, 'disk'))).size, 10 * 2 ** 30);
    assert.equal(parse(await readFile(path.join(runtime.limaHome, current!.instanceName, 'lima.yaml'), 'utf8')).disk, '10GiB');
    await action('start'); await capture(`${point}-small-boot`, '/var/log/mucodesandbox/boot-network.pcap', true);
    const filesystem = JSON.parse(await guest(['python3', '-c', "import os,json\ns=os.statvfs('/');print(json.dumps({'bytes':s.f_blocks*s.f_frsize,'canary':open('/home/dev/disk-fault-canary').read()}))"]));
    assert.ok(filesystem.bytes < 10 * 2 ** 30); assert.equal(filesystem.canary, 'MU_DISK_FAULT_ORIGINAL'); phase.smallerSnapshot = { diskGiB: current!.diskGiB, filesystem };
    await action('stop');
  }
  report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  if (worker && worker.exitCode === null && worker.signalCode === null) { const ended = new Promise(resolve => worker!.once('exit', resolve)); worker.kill('SIGKILL'); await ended; }
  await closeApp().catch(error => { report.cleanupError = String(error); });
  await fixture.close(); target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve()));
  try {
    for (const row of await runtime.list()) { if (row.status === 'Running') await runtime.command(['stop', '--force', row.name], { timeoutMs: 120_000 }); await runtime.command(['delete', '--force', row.name], { timeoutMs: 120_000 }); }
    assert.deepEqual(await runtime.list(), []); await rm(owned, { recursive: true }); report.testResourcesRemoved = true;
  } catch (error) { report.cleanupError = String(error); report.retainedTestRoot = owned; }
  if (report.cleanupError) { report.passed = false; process.exitCode = 1; }
  const modules = ['desktop/main.cjs', ...(await readdir(path.join(bundle, 'Contents/Resources/app/dist-server/server'))).filter(f => f.endsWith('.js')).map(f => `dist-server/server/${f}`)];
  if(bridgeOwner){
    for(const [file,digest] of Object.entries(report.modules??{}))assert.equal(hash(await readFile(path.join(bundle,'Contents/Resources/app',file))),digest,'Package changed during fault acceptance');
    for(const [file,digest] of Object.entries(report.sources??{}))assert.equal(hash(await readFile(path.join(root,file))),digest,'Source changed during fault acceptance');
  }else report.modules = Object.fromEntries(await Promise.all(modules.map(async file => [file, hash(await readFile(path.join(bundle, 'Contents/Resources/app', file)))])));
  for (const file of sourceFiles) await copyFile(path.join(root, file), path.join(artifacts, `source-${path.basename(file)}`));
  report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, hash(await readFile(path.join(artifacts, file)))])));
  report.finishedAt = new Date().toISOString(); await writeFile(path.join(root, 'test-results', `${reportName}.json`), JSON.stringify(report, null, 2));
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, error: report.error, phases: report.phases, captures: report.captures, testResourcesRemoved: report.testResourcesRemoved, cleanupError: report.cleanupError }, null, 2));
}
