import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { LimaRuntime } from '../server/runtime.ts';
import { run } from '../server/process.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';
import type { Environment } from '../shared/types.ts';
import { createClaudeLocalFixture } from './claude-local-fixture.ts';

const root = path.resolve(import.meta.dirname, '..');
const storage = process.argv.includes('--storage');
const bundle = path.join(root, `release/${storage ? 'guest-capacity-fix-candidate' : 'host-network-candidate'}/mac-arm64/MuCodeSandbox.app`);
const expectedCdHash = storage ? process.env.MU_TEST_PACKAGE_CD_HASH : 'cf031a2a4bbc9d55cc8b1d97e77a935b312145d2';
assert.match(expectedCdHash ?? '', /^[a-f0-9]{40}$/);
const owned = await mkdtemp(path.join(homedir(), '.mu-guest-capacity-'));
const directory = path.join(owned, 'data');
const artifacts = path.join(root, 'test-results', `guest-capacity-${Date.now()}`);
const reportFile = path.join(root, 'test-results/guest-capacity.json');
await mkdir(artifacts, { mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const runtime = new LimaRuntime(directory);
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), bundle,
  artifactsDirectory: artifacts, actualVmTested: true, actualElectronPackageTested: true,
  accountFree: true, paidModelCalls: 0, hostDiskFullTested: false, guestRootReserveExhausted: false,
  scope: 'Actual bounded VM dev-user filesystem ENOSPC, native terminal, protected network, restart, UI full-disk snapshot/restore and released-space recovery; no host-full, root-reserve exhaustion, browser/CLI or physical power loss',
  stages: [], captures: [] };
let application: ElectronApplication | undefined, page: Page | undefined, current: Environment | undefined;
let requests = 0;
const target = createServer((_req, res) => { requests++; res.end('MU_CAPACITY_NETWORK_OK'); });
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const fixture = await createClaudeLocalFixture({ browserPort: (target.address() as { port: number }).port });
const guest = (args: string[], timeoutMs = 30_000) => runtime.guest(current!, args, { timeoutMs });
const admin = (args: string[]) => runtime.management(current!, args, { timeoutMs: 30_000, maxBytes: 32_000_000 });
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Guest capacity observation timed out'); await delay(200); }
}
async function api(endpoint: string, method = 'GET', body?: unknown) {
  return page!.evaluate(async ({ endpoint, method, body }) => {
    const response = await fetch(`/api${endpoint}`, { method, headers: {
      Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value;
  }, { endpoint, method, body });
}
async function finish(job: { id: string }) {
  await until(async () => {
    const space = await statfs(owned); assert.ok(space.bavail * space.bsize > 80 * 2 ** 30);
    const value = (await api('/snapshot')).jobs.find((j: any) => j.id === job.id);
    if (value?.status === 'running') return false;
    assert.equal(value?.status, 'succeeded', value?.message); return true;
  }, 950_000);
}
async function action(kind: string) {
  await finish(await api(`/environments/${current!.id}/actions/${kind}`, 'POST'));
  current = (await api('/snapshot')).environments.find((e: Environment) => e.id === current!.id);
}
async function checkpoint(stage: string, evidence?: any) {
  const snapshot = await api('/snapshot'); assert.equal(snapshot.system.hostNetwork.state, 'ready');
  assert.ok(snapshot.jobs.every((j: any) => j.action !== 'quarantine'));
  report.stages.push({ stage, at: new Date().toISOString(), hostNetwork: snapshot.system.hostNetwork, evidence });
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(stage);
}
async function capture(name: string, file: string, boot = false) {
  if (boot) {
    const state = (await admin(['sudo', 'systemctl', 'show', '--property=SubState', '--value', 'mucodesandbox-boot-capture.service'])).trim();
    if (state !== 'exited') await admin(['sudo', 'systemctl', 'kill', '--kill-whom=main', '--signal=SIGINT', 'mucodesandbox-boot-capture.service']);
    await until(async () => (await admin(['sudo', 'systemctl', 'show', '--property=SubState', '--value', 'mucodesandbox-boot-capture.service'])).trim() === 'exited');
    await admin(['sudo', 'systemctl', 'is-active', '--quiet', 'mucodesandbox-boot-capture.service']);
  }
  const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', file])).trim(), 'base64');
  assert.ok(bytes.length > 24); await writeFile(path.join(artifacts, `${name}.pcap`), bytes);
  const gateway = (await admin(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+) dev eth0/)![1];
  assert.equal((await admin(['cat', '/sys/class/net/eth0/ifindex'])).trim(), '2');
  const text = await run('/usr/sbin/tcpdump', ['-nn', '-r', path.join(artifacts, `${name}.pcap`), 'ifindex 2 and outbound and (ip or ip6)'], { maxBytes: 32_000_000 });
  await writeFile(path.join(artifacts, `${name}.txt`), text);
  const rows = text.split('\n').filter(line => /^\d\d:\d\d:\d\d\.\d+\s/.test(line)); assert.ok(rows.length > 0);
  const approved = rows.filter(line => line.includes(` > ${gateway}.${fixture.proxyPort}:`));
  assert.deepEqual(rows.filter(line => /\sIP6\s/.test(line) || !(line.includes(` > ${gateway}.${fixture.proxyPort}:`) || line.includes(`.22 > ${gateway}.`) || /\.68 > [0-9.]+\.67:/.test(line))), []);
  const result: Record<string, any> = { name, bytes: bytes.length, sha256: hash(bytes), gateway,
    proxyPort: fixture.proxyPort, physicalOut: rows.length, approvedProxy: approved.length, unapproved: 0 };
  if (boot) {
    result.bootId = (await admin(['cat', '/proc/sys/kernel/random/boot_id'])).trim();
    result.capturedBootId = (await admin(['sudo', 'cat', '/var/log/mucodesandbox/boot-network.boot-id'])).trim();
    assert.equal(result.bootId, result.capturedBootId);
  } else assert.ok(approved.length > 0);
  report.captures.push(result);
}
async function startCapture(name: string) {
  await admin(['sudo', 'systemd-run', '--quiet', `--unit=mu-capacity-${name}`, '/usr/bin/tcpdump',
    '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', `/run/mu-capacity-${name}.pcap`, 'not (tcp src port 22)']);
  await delay(500);
}
async function endCapture(name: string) {
  await admin(['sudo', 'systemctl', 'stop', `mu-capacity-${name}.service`]);
  await capture(name, `/run/mu-capacity-${name}.pcap`);
}
async function protectedRequest() {
  const before = requests;
  assert.equal((await guest(['curl', '--fail', '--silent', '--max-time', '5', '--proxy', '', 'http://203.0.113.81/'])).trim(), 'MU_CAPACITY_NETWORK_OK');
  assert.ok(requests > before);
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--interface', 'eth0', '--proxy', '', 'http://203.0.113.81/']));
  assert.equal((await api(`/environments/${current!.id}/network/protection`)).active, true);
}
const fillScript = `import errno,json,os
p='/home/dev/.mu-capacity-owned'
assert os.getuid()==502
os.mkdir(p,0o700)
s=os.statvfs(p)
assert s.f_blocks*s.f_frsize<=12*2**30
assert os.stat(p).st_dev==os.stat('/').st_dev
fd=os.open(p+'/filler',os.O_CREAT|os.O_EXCL|os.O_RDWR,0o600)
allocated=0
try:
 for block in [256*2**20,2**20,4096]:
  while True:
   try:
    os.posix_fallocate(fd,allocated,block)
    allocated+=block
    assert allocated<=12*2**30
   except OSError as e:
    assert e.errno==errno.ENOSPC
    break
 os.fsync(fd)
finally: os.close(fd)
s=os.statvfs(p)
try:
 with open(p+'/write-probe','wb',buffering=0) as f: f.write(b'x'*4096)
 raise AssertionError('Write succeeded after allocation filled dev storage')
except OSError as e:
 assert e.errno==errno.ENOSPC
 print(json.dumps({'uid':os.getuid(),'euid':os.geteuid(),'errno':e.errno,'failedWriteBytes':4096,'allocatedBytes':allocated,'totalBytes':s.f_blocks*s.f_frsize,'availableBytes':s.f_bavail*s.f_frsize,'rootFreeBytes':s.f_bfree*s.f_frsize,'sameRootFilesystem':True}))
`;
const probeScript = `import errno,json,os
p='/home/dev/.mu-capacity-owned'
s=os.statvfs(p)
initial_available=s.f_bavail*s.f_frsize
original_bytes=os.stat(p+'/filler').st_size
assert initial_available<=64*2**20, 'Restart freed more than the bounded refill permits'
fd=os.open(p+'/filler',os.O_RDWR)
refilled=0
try:
 while True:
  try:
   os.posix_fallocate(fd,original_bytes+refilled,4096)
   refilled+=4096
   assert refilled<=64*2**20
  except OSError as e:
   assert e.errno==errno.ENOSPC
   break
 os.fsync(fd)
finally: os.close(fd)
s=os.statvfs(p)
try:
 with open(p+'/restart-probe','wb',buffering=0) as f: f.write(b'x'*4096)
 raise AssertionError('Full disk unexpectedly writable')
except OSError as e:
 assert e.errno==errno.ENOSPC
 print(json.dumps({'uid':os.getuid(),'euid':os.geteuid(),'errno':e.errno,'failedWriteBytes':4096,'bootReleasedBytes':initial_available,'originalFillerBytes':original_bytes,'refilledBytes':refilled,'availableBytes':s.f_bavail*s.f_frsize,'rootFreeBytes':s.f_bfree*s.f_frsize,'canary':open('/home/dev/mu-capacity-canary').read()}))
`;
async function fullProbe(name: string) {
  const text = await guest(['python3', '-c', probeScript]); await writeFile(path.join(artifacts, `${name}.json`), text);
  const result = JSON.parse(text); assert.equal(result.uid, 502); assert.equal(result.euid, 502);
  assert.equal(result.originalFillerBytes, report.full.allocatedBytes);
  assert.equal(result.errno, 28); assert.equal(result.canary, 'MU_CAPACITY_ORIGINAL'); return result;
}
async function terminalFailure() {
  await page!.getByRole('button', { name: '终端', exact: true }).click();
  await page!.locator('.terminal-actions').filter({ hasText: '已连接' }).waitFor();
  const input = page!.locator('.xterm-helper-textarea'); await input.waitFor(); await input.focus();
  const command = "python3 -c 'import os; f=os.open(\"/home/dev/.mu-capacity-owned/terminal-probe\",os.O_CREAT|os.O_WRONLY,0o600); os.write(f,b\"x\"*4096)' ; printf 'MU_CAPACITY_%s_%s\\n' SHELL_ALIVE \"$?\"";
  await input.evaluate((node, value) => {
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', value);
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, command);
  await page!.keyboard.press('Enter');
  await until(async () => { const text = await page!.locator('.xterm-rows').innerText(); return text.includes('No space left on device') && /MU_CAPACITY_SHELL_ALIVE_1/.test(text); });
  const text = await page!.locator('.xterm-rows').innerText();
  await writeFile(path.join(artifacts, 'terminal-full.txt'), text);
  await application!.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1360, 960); window.setOpacity(0); window.showInactive(); });
  const png = await application!.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    return { base64: image.toPNG().toString('base64'), dimensions: image.getSize(), windowSize: window.getSize() };
  });
  report.terminalScreenshot = { dimensions: png.dimensions, windowSize: png.windowSize };
  await writeFile(path.join(artifacts, 'terminal-full.png'), Buffer.from(png.base64, 'base64'));
  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  report.actualNativeTerminalFailure = true;
}
async function snapshotUi(name: string) {
  await page!.getByRole('button', { name: '快照', exact: true }).click();
  await page!.locator('label.field').filter({ hasText: '快照名称' }).locator('input').fill(name);
  const response = page!.waitForResponse(r => new URL(r.url()).pathname === `/api/environments/${current!.id}/snapshots` && r.request().method() === 'POST');
  await page!.getByRole('button', { name: '创建快照', exact: true }).click();
  const result = await response; assert.equal(result.status(), 202); await finish(await result.json());
  const value = (await api(`/environments/${current!.id}/snapshots`)).find((s: any) => s.name === name); assert.ok(value); return value;
}
async function freeGuestSpace() {
  await guest(['rm', '-r', '--', '/home/dev/.mu-capacity-owned']);
  const text = await guest(['python3', '-c', "import json,os; p='/home/dev/mu-capacity-recovered'; f=open(p,'w'); f.write('MU_CAPACITY_RECOVERED'); f.flush(); os.fsync(f.fileno()); f.close(); s=os.statvfs('/home/dev'); print(json.dumps({'availableBytes':s.f_bavail*s.f_frsize,'written':open(p).read(),'canary':open('/home/dev/mu-capacity-canary').read()}))"]);
  const value = JSON.parse(text); assert.ok(value.availableBytes > 2 ** 30); assert.equal(value.written, 'MU_CAPACITY_RECOVERED');
  assert.equal(value.canary, 'MU_CAPACITY_ORIGINAL'); return value;
}
try {
  const space = await statfs(owned); assert.ok(space.bavail * space.bsize > 100 * 2 ** 30);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  report.cdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1];
  assert.equal(report.cdHash, expectedCdHash);
  const cache = process.env.MU_TEST_SING_BOX_CACHE; assert.ok(cache); assert.equal(hash(await readFile(cache)), SING_BOX_SHA256);
  await mkdir(path.join(directory, 'tools/sing-box'), { recursive: true }); await copyFile(cache, path.join(directory, 'tools/sing-box', SING_BOX_ARCHIVE));
  application = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
    env: { ...process.env, MU_DATA_DIR: directory, MU_DESKTOP_USER_DATA_DIR: path.join(owned, 'desktop') } });
  page = await application.firstWindow(); await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  report.application = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), sandboxedRenderers: app.getAppMetrics().filter(m => m.type === 'Tab').map(m => m.sandboxed) }));
  assert.equal(report.application.packaged, true); assert.equal(report.application.appPath, path.join(bundle, 'Contents/Resources/app'));
  assert.ok(report.application.sandboxedRenderers.length && report.application.sandboxedRenderers.every(Boolean));
  assert.equal((await api('/snapshot')).system.dataDir, directory);
  current = await api('/environments', 'POST', { name: 'Disposable guest capacity', cpus: 2, memoryGiB: 2, diskGiB: 10,
    network: { mode: 'http', host: '127.0.0.1', port: fixture.proxyPort, username: 'mu', password: 'tui-fixture', strict: true, transparent: true, noProxy: '' } });
  await checkpoint('Starting fresh 10 GiB protected guest'); await action('start');
  if (storage) {
    const text = await admin(['sudo', 'tune2fs', '-l', '/dev/vda1']);
    await writeFile(path.join(artifacts, 'root-reserve.txt'), text);
    const blockSize = Number(text.match(/^Block size:\s+(\d+)/m)![1]);
    report.rootStorageReserveBytes = Number(text.match(/^Reserved block count:\s+(\d+)/m)![1]) * blockSize;
    assert.ok(report.rootStorageReserveBytes >= 512 * 2 ** 20);
  }
  await capture('first-boot', '/var/log/mucodesandbox/boot-network.pcap', true);
  fixture.restrictToLocalFixture();
  await page.getByRole('button', { name: `${current!.name} Linux 沙箱`, exact: true }).click();
  await startCapture('fill'); await protectedRequest();
  await guest(['bash', '-c', 'printf MU_CAPACITY_ORIGINAL > /home/dev/mu-capacity-canary; sync']);
  const full = await guest(['python3', '-c', fillScript], 120_000);
  await writeFile(path.join(artifacts, 'guest-fill.json'), full); report.full = JSON.parse(full);
  assert.equal(report.full.errno, 28); assert.equal(report.full.euid, 502); assert.ok(report.full.allocatedBytes > 2 ** 30);
  await terminalFailure(); await protectedRequest(); await delay(20_000); await protectedRequest(); await endCapture('fill');
  await checkpoint('Actual dev ENOSPC, shell survives and protected network remains active', report.full);
  await action('stop'); report.snapshot = await snapshotUi('Guest full baseline');
  await action('start'); await capture('restart-boot', '/var/log/mucodesandbox/boot-network.pcap', true);
  await startCapture('restart-full'); report.restartFull = await fullProbe('restart-full-state'); await protectedRequest(); await endCapture('restart-full');
  await checkpoint('Restart retains full storage and original data', report.restartFull);
  report.firstRecovery = await freeGuestSpace();
  await guest(['bash', '-c', 'printf MU_CAPACITY_CHANGED > /home/dev/mu-capacity-canary; sync']); await action('stop');
  await page.getByRole('button', { name: '快照', exact: true }).click();
  await page.getByRole('button', { name: '恢复 Guest full baseline', exact: true }).click();
  const restored = page.waitForResponse(r => new URL(r.url()).pathname === `/api/environments/${current!.id}/snapshots/${report.snapshot.id}/restore` && r.request().method() === 'POST');
  await page.getByRole('dialog').getByRole('button', { name: '恢复', exact: true }).click();
  const response = await restored; assert.equal(response.status(), 202); await finish(await response.json()); report.actualUiRestore = true;
  await action('start'); await capture('restored-boot', '/var/log/mucodesandbox/boot-network.pcap', true);
  await startCapture('restored-full'); report.restoredFull = await fullProbe('restored-full-state'); await protectedRequest();
  report.finalRecovery = await freeGuestSpace(); await protectedRequest(); await endCapture('restored-full');
  await checkpoint('UI restore retains full-disk snapshot; releasing space restores writes and network', report.finalRecovery);
  assert.equal(new Set(report.captures.filter((c: any) => c.bootId).map((c: any) => c.bootId)).size, 3);
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
  report.proxyDecisions = fixture.decisions; report.targetRequests = requests;
  const appRoot = path.join(bundle, 'Contents/Resources/app');
  const modules = ['desktop/main.cjs', ...(await readdir(path.join(appRoot, 'dist-server/server'))).filter(f => f.endsWith('.js')).map(f => `dist-server/server/${f}`)];
  report.modules = Object.fromEntries(await Promise.all(modules.map(async file => [file, hash(await readFile(path.join(appRoot, file)))])));
  for (const file of ['scripts/verify-guest-capacity.ts', 'scripts/claude-local-fixture.ts']) await copyFile(path.join(root, file), path.join(artifacts, `source-${path.basename(file)}`));
  report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, hash(await readFile(path.join(artifacts, file)))])));
  report.finishedAt = new Date().toISOString(); await writeFile(reportFile, JSON.stringify(report, null, 2));
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, error: report.error, cleanupError: report.cleanupError, testResourcesRemoved: report.testResourcesRemoved, captures: report.captures }, null, 2));
}
