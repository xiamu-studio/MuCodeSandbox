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
import { GUEST_CHROMIUM_VERSION, GUEST_CHROMIUM_SHA256 } from '../server/guest-browser-runtime.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';
import type { Environment } from '../shared/types.ts';
import { createClaudeLocalFixture } from './claude-local-fixture.ts';

const root = path.resolve(import.meta.dirname, '..');
const network = process.argv.includes('--network');
const bundle = path.join(root, `release/${network ? 'host-network-candidate' : 'host-power-fix-candidate'}/mac-arm64/MuCodeSandbox.app`);
const owned = await mkdtemp(path.join(homedir(), '.mu-power-vm-'));
const directory = path.join(owned, 'data');
const prefix = network ? 'host-network-vm' : 'host-power-vm';
const artifacts = path.join(root, 'test-results', `${prefix}-${Date.now()}`);
const reportFile = path.join(root, 'test-results', `${prefix}.json`);
await mkdir(artifacts, { mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const runtime = new LimaRuntime(directory);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), bundle,
  artifactsDirectory: artifacts, actualElectronPackageTested: true, actualVmTested: true,
  actualMacSleepTested: false, actualWifiSwitchTested: false, injectedPowerEvents: !network,
  actualNetworkHelperFailuresTested: network,
  accountFree: true, paidModelCalls: 0, observations: [], captures: [], phases: [],
  scope: network ? 'Actual packaged Electron, native helper SIGKILL and SIGSTOP heartbeat loss, fresh VM browser/terminal/grant/stream revocation, app reopen and manual restart; no physical Mac network changes' : 'Actual packaged Electron listeners, fresh VM, browser/terminal/grant/stream revocation and manual restart after injected suspend/resume; no physical Mac sleep or first-packet timing claim' };
let application: ElectronApplication | undefined, page: Page | undefined, current: Environment | undefined;
let hits = 0, ticks = 0, streams = 0, activeStreams = 0;
const target = createServer((req, res) => {
  hits++;
  if (req.url === '/stream') {
    streams++; activeStreams++; res.writeHead(200, { 'Content-Type': 'text/plain' });
    const timer = setInterval(() => { ticks++; res.write('MU_POWER_TICK\n'); }, 200);
    res.once('close', () => { clearInterval(timer); activeStreams--; }); return;
  }
  if (req.url === '/tick') { res.end('MU_POWER_OK'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><html><title>Mu power fixture</title><body><h1>Mu power fixture</h1><canvas id="c" width="400" height="240"></canvas><script>const c=document.getElementById("c").getContext("2d");c.fillStyle="#2274a5";c.fillRect(0,0,400,240);c.fillStyle="#d94f46";c.fillRect(60,40,160,100);c.fillStyle="white";c.font="24px sans-serif";c.fillText("Mu Sandbox",30,200);</script></body></html>');
});
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const fixture = await createClaudeLocalFixture({ browserPort: (target.address() as { port: number }).port });
const guest = (args: string[]) => runtime.guest(current!, args, { timeoutMs: 20_000 });
const admin = (args: string[], input?: string) => runtime.management(current!, args, { input, timeoutMs: 30_000, maxBytes: 32_000_000 });
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Host power observation timed out'); await delay(200); }
}
async function api(endpoint: string, method = 'GET', body?: unknown, allowError = false) {
  const response = await page!.evaluate(async ({ endpoint, method, body }) => {
    const response = await fetch(`/api${endpoint}`, { method,
      headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, body: await response.json() };
  }, { endpoint, method, body });
  if (allowError) return response;
  assert.ok(response.status < 400, JSON.stringify(response)); return response.body;
}
async function finish(job: { id: string }, timeoutMs = 950_000) {
  await until(async () => {
    const space = await statfs(owned); assert.ok(space.bavail * space.bsize > 80 * 2 ** 30, 'Insufficient reserve');
    const done = (await api('/snapshot')).jobs.find((entry: any) => entry.id === job.id);
    if (done?.status === 'running') return false;
    assert.equal(done?.status, 'succeeded', done?.message); return true;
  }, timeoutMs);
}
async function action(kind: string) {
  await finish(await api(`/environments/${current!.id}/actions/${kind}`, 'POST'));
  current = (await api('/snapshot')).environments.find((entry: Environment) => entry.id === current!.id);
}
async function checkpoint(message: string) {
  report.observations.push({ at: new Date().toISOString(), message });
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(message);
}
async function capture(name: string, file: string, boot = false) {
  const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', file])).trim(), 'base64');
  assert.ok(bytes.length > 24);
  await writeFile(path.join(artifacts, `${name}.pcap`), bytes, { mode: 0o600 });
  const gateway = (await admin(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+) dev eth0/)![1];
  assert.equal((await admin(['cat', '/sys/class/net/eth0/ifindex'])).trim(), '2');
  const text = await run('/usr/sbin/tcpdump', ['-nn', '-r', path.join(artifacts, `${name}.pcap`), 'ifindex 2 and outbound and (ip or ip6)'], { maxBytes: 32_000_000 });
  await writeFile(path.join(artifacts, `${name}-network.txt`), text, { mode: 0o600 });
  const rows = text.split('\n').filter(line => /^\d\d:\d\d:\d\d\.\d+\s/.test(line));
  assert.ok(rows.length > 0);
  const approved = rows.filter(line => line.includes(` > ${gateway}.${fixture.proxyPort}:`));
  const unapproved = rows.filter(line => /\sIP6\s/.test(line) || !(line.includes(` > ${gateway}.${fixture.proxyPort}:`) || line.includes(`.22 > ${gateway}.`) || /\.68 > [0-9.]+\.67:/.test(line)));
  assert.deepEqual(unapproved, []);
  const item: Record<string, any> = { name, bytes: bytes.length, sha256: digest(bytes), gateway, proxyPort: fixture.proxyPort,
    physicalOut: rows.length, approvedProxy: approved.length, unapproved: 0 };
  if (boot) {
    item.bootId = (await admin(['cat', '/proc/sys/kernel/random/boot_id'])).trim();
    item.capturedBootId = (await admin(['sudo', 'cat', '/var/log/mucodesandbox/boot-network.boot-id'])).trim();
    assert.equal(item.bootId, item.capturedBootId);
  } else assert.ok(approved.length > 0);
  report.captures.push(item); return item;
}
async function terminal() {
  const ticket = await api(`/environments/${current!.id}/terminal-ticket`, 'POST', { command: 'shell' });
  await page!.evaluate(({ ticket }) => {
    const w = window as any; w.__powerTerminal = { connected: false, closed: false, data: '' };
    const socket = new WebSocket(`${location.origin.replace('http:', 'ws:')}/terminal?ticket=${encodeURIComponent(ticket)}`);
    w.__powerSocket = socket;
    socket.onmessage = event => { const data = JSON.parse(event.data);
      if (data.type === 'connected') w.__powerTerminal.connected = true;
      if (data.type === 'data') w.__powerTerminal.data += data.data; };
    socket.onclose = () => { w.__powerTerminal.closed = true; };
  }, ticket);
  await until(() => page!.evaluate(() => Boolean((window as any).__powerTerminal.connected)));
  await page!.evaluate(() => (window as any).__powerSocket.send(JSON.stringify({ type: 'input', data: "printf 'MU_POWER_%s\\n' PTY_READY\r" })));
  await until(() => page!.evaluate(() => (window as any).__powerTerminal.data.includes('MU_POWER_PTY_READY')));
}
async function phase(event: 'suspend' | 'resume' | 'monitor-kill' | 'monitor-stall', index: number) {
  await checkpoint(`Phase ${index}: active browser, native terminal, grant and TCP stream before ${event}`);
  const capturePath = `/var/log/mucodesandbox/power-phase-${index}.pcap`;
  await admin(['sudo', 'systemd-run', '--quiet', `--unit=mu-power-capture-${index}`, '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', capturePath, 'not (tcp src port 22)']);
  await delay(400);
  assert.equal((await guest(['curl', '--fail', '--silent', '--max-time', '5', '--proxy', '', 'http://203.0.113.81/tick'])).trim(), 'MU_POWER_OK');
  const project = path.join(owned, 'project'); await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'fixture.txt'), 'MU_POWER_GRANTED');
  await finish(await api(`/environments/${current!.id}/bridge`, 'POST', { root: project, writable: false, minutes: 10 }));
  const grants = await api(`/environments/${current!.id}/bridge`); assert.equal(grants.length, 1); assert.equal(grants[0].guestReady, true);
  assert.equal((await guest(['mu-host', grants[0].id, 'read', 'fixture.txt'])).trim(), 'MU_POWER_GRANTED');
  const configOwner = JSON.parse(await guest(['python3', '-c', "import json,os,stat\np='/home/dev/.config'\ns=os.stat(p)\nprint(json.dumps({'uid':s.st_uid,'currentUid':os.getuid(),'mode':stat.S_IMODE(s.st_mode),'writable':os.access(p,os.W_OK)}))"]));
  assert.equal(configOwner.uid, configOwner.currentUid); assert.equal(configOwner.mode, 0o700); assert.equal(configOwner.writable, true);
  await terminal();
  await finish(await api(`/environments/${current!.id}/browser/open`, 'POST'));
  await until(() => application!.windows().some(window => new URL(window.url() || 'about:blank').searchParams.get('guestBrowser') === current!.id));
  const viewer = application!.windows().find(window => new URL(window.url() || 'about:blank').searchParams.get('guestBrowser') === current!.id)!;
  await viewer.getByRole('status').filter({ hasText: '已连接' }).waitFor({ timeout: 30_000 });
  let pixels: any;
  await until(async () => {
    const canvas = viewer.locator('.guest-browser-canvas canvas'); if (!await canvas.count()) return false;
    pixels = await canvas.evaluate((node: HTMLCanvasElement) => {
      const bytes = node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data, colors = new Set<string>();
      for (let i = 0; i < bytes.length; i += 400) colors.add(`${bytes[i]},${bytes[i + 1]},${bytes[i + 2]}`);
      return { width: node.width, height: node.height, colors: colors.size };
    }); return pixels.width === 1280 && pixels.height === 800 && pixels.colors > 20;
  });
  await writeFile(path.join(artifacts, `browser-phase-${index}.png`), Buffer.from((await viewer.locator('.guest-browser-canvas canvas').evaluate((node: HTMLCanvasElement) => node.toDataURL('image/png'))).split(',')[1]!, 'base64'), { mode: 0o600 });
  if (index === 1) fixture.restrictToLocalFixture();
  const beforeTicks = ticks;
  await admin(['sudo', 'systemd-run', '--quiet', `--unit=mu-power-stream-${index}`, '--property=User=dev', '/usr/bin/curl', '--fail', '--silent', '--proxy', '', 'http://203.0.113.81/stream']);
  await until(() => activeStreams === 1 && ticks > beforeTicks + 5);
  const protection = await api(`/environments/${current!.id}/network/protection`); assert.equal(protection.active, true);
  const beforeRuntime = await runtime.list();
  const eventAt = new Date().toISOString(), started = Date.now();
  let monitorFailure: any;
  if (network) {
    assert.equal((await api('/snapshot')).system.hostNetwork.state, 'ready');
    const parent = application!.process().pid!;
    const children = await run('/bin/ps', ['-ax', '-o', 'pid=,ppid=,comm=']);
    const ownedHelpers = children.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(match => match && Number(match[2]) === parent && match[3] === path.join(bundle, 'Contents/Resources/app/native/bin/mu-network-monitor'));
    assert.equal(ownedHelpers.length, 1, 'Only the native child of this test application may be signalled');
    const pid = Number(ownedHelpers[0]![1]), signal = event === 'monitor-kill' ? 'SIGKILL' : 'SIGSTOP';
    process.kill(pid, signal);
    await until(async () => (await api('/snapshot')).system.hostNetwork.state === 'failed', 25_000);
    monitorFailure = { pid, parent, signal, detectedMs: Date.now() - started, state: (await api('/snapshot')).system.hostNetwork };
  } else await application!.evaluate(({ powerMonitor }, event) => { powerMonitor.emit(event); }, event as 'suspend' | 'resume');
  const immediately = await api(`/environments/${current!.id}/terminal-ticket`, 'POST', { command: 'shell' }, true);
  assert.equal(immediately.status, 409);
  await until(() => page!.evaluate(() => Boolean((window as any).__powerTerminal.closed)));
  await until(() => viewer.isClosed());
  await until(() => activeStreams === 0);
  await until(async () => (await runtime.list()).find(row => row.name === current!.instanceName)?.status === 'Stopped', 120_000);
  await until(async () => {
    const snapshot = await api('/snapshot');
    return snapshot.environments.find((entry: Environment) => entry.id === current!.id)?.state === 'error' &&
      snapshot.jobs.some((job: any) => job.action === 'quarantine' && job.status === 'succeeded');
  });
  assert.deepEqual(await api(`/environments/${current!.id}/bridge`), []);
  const stoppedMs = Date.now() - started, frozen = { hits, ticks, streams };
  await delay(2500); assert.deepEqual({ hits, ticks, streams }, frozen);
  const paused = await api('/snapshot'); const jobCount = paused.jobs.length;
  const stoppedRuntime = await runtime.list();
  const savedTerminalEvidence = network ? await page!.evaluate(() => (window as any).__powerTerminal) : null;
  if (network) {
    const blocked = await api(`/environments/${current!.id}/actions/start`, 'POST', {}, true);
    assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'HOST_NETWORK_UNAVAILABLE');
    await page!.getByText('电脑网络监测失效，保护环境已关闭；请重新打开应用', { exact: true }).waitFor();
    await application!.close(); application = undefined;
    application = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
      env: { ...process.env, MU_DATA_DIR: directory, MU_DESKTOP_USER_DATA_DIR: path.join(owned, 'desktop'), MU_LIMA_PATH: process.env.MU_LIMA_PATH! } });
    page = await application.firstWindow(); await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].hide(); });
    assert.equal((await api('/snapshot')).system.hostNetwork.state, 'ready');
    try { process.kill(monitorFailure.pid, 0); assert.fail('Old native helper must be gone'); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); }
    monitorFailure.oldHelperRemoved = true;
  }
  if (event === 'suspend') {
    const blocked = await api(`/environments/${current!.id}/actions/start`, 'POST', {}, true);
    assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'HOST_POWER_TRANSITION');
    await application!.evaluate(({ powerMonitor }) => { powerMonitor.emit('resume'); });
  }
  await delay(1000);
  const resumed = await api('/snapshot'); assert.equal(resumed.jobs.length, jobCount);
  assert.equal(resumed.environments.find((entry: Environment) => entry.id === current!.id).state, 'error');
  assert.equal((await runtime.list()).find(row => row.name === current!.instanceName)?.status, 'Stopped');
  await checkpoint(`Phase ${index}: VM stopped, old connections and grant revoked; manually restarting`);
  await action('start');
  const boot = await capture(`restart-${index}`, '/var/log/mucodesandbox/boot-network.pcap', true);
  await capture(`phase-${index}`, capturePath);
  await assert.rejects(guest(['mu-host', grants[0].id, 'read', 'fixture.txt']));
  assert.deepEqual(await api(`/environments/${current!.id}/bridge`), []);
  assert.equal((await guest(['curl', '--fail', '--silent', '--max-time', '5', '--proxy', '', 'http://203.0.113.81/tick'])).trim(), 'MU_POWER_OK');
  assert.equal((await api(`/environments/${current!.id}/network/protection`)).active, true);
  const terminalEvidence = savedTerminalEvidence ?? await page!.evaluate(() => (window as any).__powerTerminal);
  await writeFile(path.join(artifacts, `terminal-phase-${index}.txt`), terminalEvidence.data, { mode: 0o600 });
  await writeFile(path.join(artifacts, `phase-${index}-state.json`), JSON.stringify({ environmentId: current!.id,
    instanceName: current!.instanceName, event, eventAt, monitorFailure, beforeRuntime, protectionBefore: protection,
    grantBefore: grants[0], configOwner, immediateAccess: immediately, stoppedRuntime, stoppedSnapshot: paused,
    resumedSnapshot: resumed, afterRuntime: await runtime.list(), terminalEvidence,
    protectionAfter: await api(`/environments/${current!.id}/network/protection`),
    grantsAfter: await api(`/environments/${current!.id}/bridge`) }, null, 2), { mode: 0o600 });
  report.phases.push({ event, eventAt, monitorFailure, stoppedMs, accessRejected: immediately.body.code, terminalClosed: true,
    browserClosed: true, pixels, configOwner, streamClosed: true, stoppedTraffic: frozen, noAutomaticRestart: true,
    grantsRevoked: true, oldGrantRejectedAfterRestart: true, manualRestartProtected: true, bootId: boot.bootId });
}
async function linkedConfigRejection() {
  const project = path.join(owned, 'project');
  await admin(['bash', '-c', 'sudo install -d -m 0700 /var/lib/mu-power-config-outside; printf UNCHANGED | sudo tee /var/lib/mu-power-config-outside/sentinel >/dev/null']);
  await guest(['bash', '-c', 'mv /home/dev/.config /home/dev/.config-power-saved; ln -s /var/lib/mu-power-config-outside /home/dev/.config']);
  try {
    const job = await api(`/environments/${current!.id}/bridge`, 'POST', { root: project, writable: false, minutes: 10 });
    let failed: any;
    await until(async () => {
      failed = (await api('/snapshot')).jobs.find((entry: any) => entry.id === job.id);
      return failed && failed.status !== 'running';
    });
    assert.equal(failed.status, 'failed'); assert.match(failed.message, /Not a directory|symbolic links/i);
    assert.deepEqual(await api(`/environments/${current!.id}/bridge`), []);
    assert.equal((await admin(['sudo', 'cat', '/var/lib/mu-power-config-outside/sentinel'])).trim(), 'UNCHANGED');
    const outside = (await admin(['sudo', 'find', '/var/lib/mu-power-config-outside', '-mindepth', '1', '-maxdepth', '1', '-printf', '%f\n'])).trim();
    assert.equal(outside, 'sentinel');
    report.linkedConfigRejected = { job: failed, sentinelUnchanged: true, noCapabilityPublished: true, noOutsideFilesCreated: true };
    await writeFile(path.join(artifacts, 'linked-config-rejection.json'), JSON.stringify(report.linkedConfigRejected, null, 2), { mode: 0o600 });
  } finally {
    await guest(['bash', '-c', 'test -L /home/dev/.config; rm /home/dev/.config; mv /home/dev/.config-power-saved /home/dev/.config']);
  }
}
try {
  const space = await statfs(owned); assert.ok(space.bavail * space.bsize > 100 * 2 ** 30);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  report.cdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1];
  assert.equal(report.cdHash, network ? 'cf031a2a4bbc9d55cc8b1d97e77a935b312145d2' : '4227377499a5aaeba73db3f31b821e44a5234aff');
  if (network) assert.match(report.cdHash!, /^[a-f0-9]{40}$/);
  const cache = process.env.MU_TEST_SING_BOX_CACHE; assert.ok(cache); assert.equal(digest(await readFile(cache)), SING_BOX_SHA256);
  await mkdir(path.join(directory, 'tools/sing-box'), { recursive: true });
  await copyFile(cache, path.join(directory, 'tools/sing-box', SING_BOX_ARCHIVE));
  const browserCache = `/tmp/mu-chromium-${GUEST_CHROMIUM_VERSION}-arm64.zip`;
  assert.equal(digest(await readFile(browserCache)), GUEST_CHROMIUM_SHA256);
  await mkdir(path.join(directory, 'tools/guest-browser'), { recursive: true });
  await copyFile(browserCache, path.join(directory, 'tools/guest-browser', `chrome-${GUEST_CHROMIUM_VERSION}-linux-arm64.zip`));
  application = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
    env: { ...process.env, MU_DATA_DIR: directory, MU_DESKTOP_USER_DATA_DIR: path.join(owned, 'desktop'), MU_LIMA_PATH: process.env.MU_LIMA_PATH } });
  page = await application.firstWindow(); await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].hide(); });
  report.application = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(),
    sandboxedRenderers: app.getAppMetrics().filter(metric => metric.type === 'Tab').map(metric => metric.sandboxed) }));
  assert.equal(report.application.packaged, true); assert.equal(report.application.appPath, path.join(bundle, 'Contents/Resources/app'));
  assert.ok(report.application.sandboxedRenderers.length && report.application.sandboxedRenderers.every(Boolean));
  assert.equal((await api('/snapshot')).system.dataDir, directory);
  current = await api('/environments', 'POST', { name: 'Disposable power acceptance', cpus: 2, memoryGiB: 2, diskGiB: 10,
    browserUrl: 'http://203.0.113.81/', network: { mode: 'http', host: '127.0.0.1', port: fixture.proxyPort,
      username: 'mu', password: 'tui-fixture', strict: true, transparent: true, noProxy: '' } });
  await checkpoint('Starting fresh bounded protected VM through actual Electron package'); await action('start');
  await capture('first-boot', '/var/log/mucodesandbox/boot-network.pcap', true);
  await phase(network ? 'monitor-kill' : 'suspend', 1); await linkedConfigRejection(); await phase(network ? 'monitor-stall' : 'resume', 2);
  assert.equal(new Set(report.captures.filter((row: any) => row.bootId).map((row: any) => row.bootId)).size, 3);
  report.passed = true; await checkpoint('Both actual-VM event/failure phases passed; cleaning temporary resources');
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
  if (current) {
    try {
      const diagnostic = await admin(['sudo', 'bash', '-c', 'systemctl status mucodesandbox-browser.service --no-pager || true; journalctl -u mucodesandbox-browser.service -n 150 --no-pager; free -m; journalctl -k -n 80 --no-pager']);
      await writeFile(path.join(artifacts, 'failure-guest.txt'), diagnostic, { mode: 0o600 });
    } catch (diagnosticError) { report.diagnosticError = String(diagnosticError); }
  }
}
finally {
  await application?.close().catch(error => { report.cleanupError = String(error); });
  await fixture.close(); target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve()));
  try {
    for (const row of await runtime.list()) {
      if (row.status === 'Running') await runtime.command(['stop', row.name], { timeoutMs: 120_000 });
      await runtime.command(['delete', row.name], { timeoutMs: 120_000 });
    }
    assert.deepEqual(await runtime.list(), []); await rm(owned, { recursive: true }); report.testResourcesRemoved = true;
  } catch (error) { report.cleanupError = String(error); report.retainedTestRoot = owned; }
  if (report.cleanupError) { report.passed = false; process.exitCode = 1; }
  report.proxyDecisions = fixture.decisions; report.hostReceipts = { hits, ticks, streams, activeStreams };
  const files = ['desktop/main.cjs', ...(network ? ['native/bin/mu-network-monitor'] : []), ...(await readdir(path.join(bundle, 'Contents/Resources/app/dist-server/server'))).filter(file => file.endsWith('.js')).map(file => `dist-server/server/${file}`)];
  report.modules = Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(path.join(bundle, 'Contents/Resources/app', file)))])));
  for (const file of ['scripts/verify-host-power-vm.ts', 'scripts/claude-local-fixture.ts']) await copyFile(path.join(root, file), path.join(artifacts, `source-${path.basename(file)}`));
  report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, digest(await readFile(path.join(artifacts, file)))])));
  report.finishedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, phases: report.phases, captures: report.captures,
    error: report.error, cleanupError: report.cleanupError, testResourcesRemoved: report.testResourcesRemoved }, null, 2));
}
