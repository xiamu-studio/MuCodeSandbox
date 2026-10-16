import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { LimaRuntime } from '../server/runtime.ts';
import type { Environment } from '../shared/types.ts';
import { run } from '../server/process.ts';
import { createClaudeLocalFixture } from './claude-local-fixture.ts';
import { seedProtectedTestBase } from './seed-protected-test-base.ts';
import { packetLines } from './packet-capture.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';

const root = path.resolve(import.meta.dirname, '..');
const bundle = path.join(root, 'release/bridge-owner-candidate/mac-arm64/MuCodeSandbox.app');
const owned = await mkdtemp(path.join(homedir(), '.mu-actual-sleep-')), data = path.join(owned, 'private');
const artifacts = path.join(root, 'test-results', `host-sleep-actual-${Date.now()}`); await mkdir(artifacts, { mode: 0o700 });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), bundle, artifactsDirectory: artifacts,
  accountFree: true, paidModelCalls: 0, injectedPowerEvents: false, actualMacSleepTested: false, captures: [],
  scope: 'Actual current Electron package, physical Mac sleep/wake, protected VM TCP stream, native terminal and file grant revocation, manual recovery and selected guest captures; no browser/Claude task, hypervisor first-packet, Wi-Fi change, residential line or day-long claim' };
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const runtime = new LimaRuntime(data);
let application: ElectronApplication | undefined, page: Page | undefined, current: Environment | undefined;
let hits = 0, ticks = 0, activeStreams = 0;
const target = createServer((req, res) => {
  hits++;
  if (req.url === '/stream') {
    activeStreams++; res.writeHead(200, { 'Content-Type': 'text/plain' });
    const timer = setInterval(() => { ticks++; res.write('MU_ACTUAL_SLEEP_TICK\n'); }, 250);
    res.on('close', () => { activeStreams--; clearInterval(timer); });
  } else res.end('MU_ACTUAL_SLEEP_OK');
});
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const fixture = await createClaudeLocalFixture({ browserPort: (target.address() as { port: number }).port });
const admin = (args: string[], input?: string) => runtime.management(current!, args, { input, timeoutMs: 30_000, maxBytes: 32 * 2 ** 20 });
const guest = (args: string[]) => runtime.guest(current!, args, { timeoutMs: 15_000 });
async function until(check: () => Promise<boolean> | boolean, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Actual sleep observation timed out'); await delay(200); }
}
async function api(endpoint: string, method = 'GET', body?: unknown, allowError = false): Promise<any> {
  const result = await page!.evaluate(async ({ endpoint, method, body }) => {
    const response = await fetch(`/api${endpoint}`, { method, headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, body: await response.json() };
  }, { endpoint, method, body });
  if (allowError) return result; assert.ok(result.status < 400, JSON.stringify(result)); return result.body;
}
async function finish(job: { id: string }) {
  await until(async () => { const done = (await api('/snapshot')).jobs.find((row: any) => row.id === job.id);
    if (done?.status === 'running') return false; assert.equal(done?.status, 'succeeded', done?.message); return true;
  }, 120_000);
}
async function capture(name: string, file: string) {
  const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', file])).trim(), 'base64');
  assert.ok(bytes.length > 24); const local = path.join(artifacts, `${name}.pcap`); await writeFile(local, bytes, { mode: 0o600 });
  const packets = await packetLines(local, 'ifindex 2 and outbound and (ip or ip6)');
  const rejected = packets.filter(line => /\sIP6\s/.test(line) || !(line.includes('.22 > 192.168.5.2.') || /\.68 > [0-9.]+\.67:/.test(line)));
  assert.ok(packets.length > 0); assert.deepEqual(rejected, []);
  report.captures.push({ name, sha256: hash(bytes), bytes: bytes.length, physicalOut: packets.length, unapproved: rejected.length });
}
async function save(stage: string) {
  report.progress = { stage, at: new Date().toISOString() }; console.log(report.progress.at, stage);
  await writeFile(path.join(root, 'test-results/host-sleep-actual.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
}
try {
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  report.packageCdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1];
  assert.equal(report.packageCdHash, '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3');
  const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
  report.modules = Object.fromEntries(await Promise.all((await readdir(compiled)).filter(name => name.endsWith('.js')).map(async name => [name, hash(await readFile(path.join(compiled, name)))])));
  report.initialSources = Object.fromEntries(await Promise.all(['scripts/verify-host-sleep-actual.ts', 'scripts/seed-protected-test-base.ts', 'scripts/claude-local-fixture.ts', 'scripts/packet-capture.ts'].map(async file => {
    const bytes = await readFile(path.join(root, file)); await writeFile(path.join(artifacts, `source-${path.basename(file)}`), bytes, { mode: 0o600 }); return [file, hash(bytes)];
  })));
  application = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
    env: { ...process.env, MU_DATA_DIR: data, MU_DESKTOP_USER_DATA_DIR: path.join(owned, 'desktop') } });
  page = await application.firstWindow(); await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  await application.evaluate(({ BrowserWindow, powerMonitor }) => {
    BrowserWindow.getAllWindows()[0].hide(); (globalThis as any).__muActualPowerEvents = [];
    const record = (event: string) => (globalThis as any).__muActualPowerEvents.push({ event, at: new Date().toISOString() });
    powerMonitor.on('suspend', () => record('suspend')); powerMonitor.on('resume', () => record('resume'));
  });
  assert.equal((await api('/snapshot')).system.dataDir, data);
  const cache = process.env.MU_TEST_PROTECTED_BASE;
  if (cache) {
    report.baseCache = await seedProtectedTestBase(runtime, cache);
    assert.equal(report.baseCache.recipe, '5b5b8d2ce469e5c1f2c3447cc327eec55531b03ed69552f8fc3dbb39e680fbad');
  } else {
    const archive = process.env.MU_TEST_SING_BOX_CACHE; assert.ok(archive);
    assert.equal(hash(await readFile(archive)), SING_BOX_SHA256);
    await mkdir(path.join(data, 'tools/sing-box'), { recursive: true });
    await copyFile(archive, path.join(data, 'tools/sing-box', SING_BOX_ARCHIVE));
    report.normalFreshPreparation = true;
  }
  current = await api('/environments', 'POST', { name: 'Actual sleep disposable environment', cpus: 2, memoryGiB: 2, diskGiB: 10,
    network: { mode: 'http', host: '127.0.0.1', port: fixture.proxyPort, username: 'mu', password: 'tui-fixture', strict: true, transparent: true, noProxy: '' } });
  await save('Starting protected VM through normal current-package lifecycle for physical sleep acceptance');
  try { await finish(await api(`/environments/${current!.id}/actions/start`, 'POST')); }
  catch (error) {
    assert.match(String(error), /启动记录机制已升级/);
    await until(async () => (await runtime.list()).find(row => row.name === current!.instanceName)?.status === 'Stopped');
    report.legacyCaptureUpgradeRetry = true;
    await finish(await api(`/environments/${current!.id}/actions/start`, 'POST'));
  }
  current = (await api('/snapshot')).environments.find((row: any) => row.id === current!.id);
  await capture('first-boot', '/var/log/mucodesandbox/boot-network.pcap');
  fixture.restrictToLocalFixture();
  report.beforeResponse = (await guest(['curl', '--fail', '--silent', '--max-time', '4', '--proxy', '', 'http://203.0.113.81/'])).trim(); assert.equal(report.beforeResponse, 'MU_ACTUAL_SLEEP_OK');
  await admin(['sudo', 'systemd-run', '--quiet', '--unit=mu-actual-sleep-capture', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', '/var/log/mucodesandbox/actual-sleep.pcap', 'ip or ip6']);
  const project = path.join(owned, 'project'); await mkdir(project); await writeFile(path.join(project, 'fixture.txt'), 'MU_ACTUAL_SLEEP_GRANTED');
  await finish(await api(`/environments/${current!.id}/bridge`, 'POST', { root: project, writable: false, minutes: 10 }));
  const grants = await api(`/environments/${current!.id}/bridge`); assert.equal(grants.length, 1);
  assert.equal((await guest(['mu-host', grants[0].id, 'read', 'fixture.txt'])).trim(), 'MU_ACTUAL_SLEEP_GRANTED'); report.beforeGrants = grants;
  const ticket = await api(`/environments/${current!.id}/terminal-ticket`, 'POST', { command: 'shell' });
  await page.evaluate(({ ticket }) => { const w = window as any; w.__actualSleepTerminal = { connected: false, closed: false, data: '' };
    const socket = new WebSocket(`${location.origin.replace('http:', 'ws:')}/terminal?ticket=${encodeURIComponent(ticket)}`); w.__actualSleepSocket = socket;
    socket.onmessage = event => { const value = JSON.parse(event.data); if (value.type === 'connected') w.__actualSleepTerminal.connected = true; if (value.type === 'data') w.__actualSleepTerminal.data += value.data; };
    socket.onclose = () => { w.__actualSleepTerminal.closed = true; };
  }, ticket);
  await until(() => page!.evaluate(() => (window as any).__actualSleepTerminal.connected));
  await page.evaluate(() => (window as any).__actualSleepSocket.send(JSON.stringify({ type: 'input', data: "printf 'MU_ACTUAL_%s\\n' PTY_READY\r" })));
  await until(() => page!.evaluate(() => (window as any).__actualSleepTerminal.data.includes('MU_ACTUAL_PTY_READY')));
  await admin(['sudo', 'systemd-run', '--quiet', '--unit=mu-actual-sleep-stream', '--property=User=dev', '/usr/bin/curl', '--fail', '--silent', '--proxy', '', 'http://203.0.113.81/stream']);
  await until(() => activeStreams === 1 && ticks >= 6);
  report.protectionBefore = await api(`/environments/${current!.id}/network/protection`); assert.equal(report.protectionBefore.active, true);
  report.snapshotBefore = await api('/snapshot'); assert.equal(report.snapshotBefore.system.hostNetwork.state, 'ready');
  report.wakeSchedule = { afterAuthenticationSeconds: 90, owner: 'com.mucodesandbox.actual-sleep-test' }; report.sleepRequestedAt = new Date().toISOString();
  await save('Ready: requesting administrator authentication to schedule wake and perform real Mac sleep');
  const command = `set -eu
wake_date=$(/bin/date -v+90S '+%m/%d/%Y %H:%M:%S')
/usr/bin/pmset schedule wake "$wake_date" 'com.mucodesandbox.actual-sleep-test'
printf 'MU_WAKE_SCHEDULED=%s\\n' "$wake_date"
/usr/bin/pmset sleepnow`;
  report.wakeSchedule.output = await run('/usr/bin/osascript', ['-e', `do shell script ${JSON.stringify(command)} with administrator privileges`], { timeoutMs: 180_000 });
  await until(async () => (await application!.evaluate(() => (globalThis as any).__muActualPowerEvents)).some((row: any) => row.event === 'resume'), 120_000);
  report.powerEvents = await application.evaluate(() => (globalThis as any).__muActualPowerEvents);
  assert.deepEqual(report.powerEvents.map((row: any) => row.event), ['suspend', 'resume']);
  report.sleepIntervalMs = Date.parse(report.powerEvents[1].at) - Date.parse(report.powerEvents[0].at); assert.ok(report.sleepIntervalMs >= 5000);
  const powerLog = await run('/usr/bin/pmset', ['-g', 'log'], { timeoutMs: 30_000, maxBytes: 64 * 2 ** 20 });
  const since = Date.parse(report.sleepRequestedAt) - 1000;
  const lines = powerLog.split('\n').filter(line => { const match = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4})/); return match && Date.parse(match[1]) >= since && /Sleep|Wake/.test(line); });
  await writeFile(path.join(artifacts, 'physical-power.log'), lines.join('\n'), { mode: 0o600 });
  assert.ok(lines.some(line => /Entering Sleep state/.test(line))); assert.ok(lines.some(line => /Wake from/.test(line)));
  report.actualMacSleepTested = true;
  await until(async () => (await runtime.list()).find(row => row.name === current!.instanceName)?.status === 'Stopped', 120_000);
  await until(() => activeStreams === 0 && page!.evaluate(() => (window as any).__actualSleepTerminal.closed));
  report.snapshotAfterWake = await api('/snapshot');
  assert.equal(report.snapshotAfterWake.environments.find((row: any) => row.id === current!.id).state, 'error');
  assert.deepEqual(await api(`/environments/${current!.id}/bridge`), []);
  const denied = await api(`/environments/${current!.id}/terminal-ticket`, 'POST', { command: 'shell' }, true); assert.equal(denied.status, 409); report.accessAfterWake = denied;
  const frozen = { hits, ticks, activeStreams }; await delay(2000); assert.deepEqual({ hits, ticks, activeStreams }, frozen);
  assert.equal((await runtime.list()).find(row => row.name === current!.instanceName)?.status, 'Stopped'); report.noAutomaticRestart = true;
  await save('Actual sleep/wake observed; old stream, terminal and grant closed; testing manual recovery');
  await finish(await api(`/environments/${current!.id}/actions/start`, 'POST'));
  current = (await api('/snapshot')).environments.find((row: any) => row.id === current!.id);
  await capture('sleep-window', '/var/log/mucodesandbox/actual-sleep.pcap'); await capture('recovery-boot', '/var/log/mucodesandbox/boot-network.pcap');
  await assert.rejects(guest(['mu-host', grants[0].id, 'read', 'fixture.txt']));
  assert.deepEqual(await api(`/environments/${current!.id}/bridge`), []);
  report.afterResponse = (await guest(['curl', '--fail', '--silent', '--max-time', '4', '--proxy', '', 'http://203.0.113.81/'])).trim(); assert.equal(report.afterResponse, 'MU_ACTUAL_SLEEP_OK');
  report.protectionAfter = await api(`/environments/${current!.id}/network/protection`); assert.equal(report.protectionAfter.active, true);
  report.terminal = await page.evaluate(() => (window as any).__actualSleepTerminal);
  report.manualRecoveryPassed = true; report.oldGrantRejected = true; report.passed = true;
} catch (error) {
  report.error = (error as Error).stack; process.exitCode = 1;
  if (page && !page.isClosed()) try {
    await writeFile(path.join(artifacts, 'failure-snapshot.json'), JSON.stringify(await api('/snapshot'), null, 2), { mode: 0o600 });
  } catch (diagnosticError) { report.diagnosticError = String(diagnosticError); }
}
finally {
  try { await application?.close(); } catch (error) { report.cleanupError = String(error); }
  await fixture.close(); target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve()));
  try {
    for (const row of await runtime.list()) { if (row.status === 'Running') await runtime.command(['stop', '--force', row.name], { timeoutMs: 120_000 }); await runtime.command(['delete', row.name], { timeoutMs: 120_000 }); }
    assert.deepEqual(await runtime.list(), []); await rm(owned, { recursive: true }); report.testResourcesRemoved = true;
  } catch (error) { report.cleanupError = String(error); report.retainedDataDirectory = owned; }
  try { for (const [file, digest] of Object.entries(report.initialSources ?? {})) assert.equal(hash(await readFile(path.join(root, file))), digest);
    for (const [name, digest] of Object.entries(report.modules ?? {})) assert.equal(hash(await readFile(path.join(bundle, 'Contents/Resources/app/dist-server/server', name))), digest);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]); report.inputsUnchanged = true;
  } catch (error) { report.inputError = String(error); report.passed = false; }
  if (report.cleanupError) report.passed = false;
  report.receipts = { hits, ticks, activeStreams }; report.decisions = fixture.decisions;
  report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async name => [name, hash(await readFile(path.join(artifacts, name)))])));
  report.finishedAt = new Date().toISOString(); await save(report.passed ? 'Passed; temporary test resources removed' : 'Not passed; evidence retained');
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, error: report.error, actualMacSleepTested: report.actualMacSleepTested, captures: report.captures }, null, 2));
}
