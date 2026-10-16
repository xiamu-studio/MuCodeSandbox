import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { WebSocket } from 'ws';
import { LimaRuntime } from '../server/runtime.ts';
import { LEASE_HELPER_PATH, LEASE_SECONDS } from '../server/guest-lease.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';
import { run } from '../server/process.ts';
import type { Environment } from '../shared/types.ts';
import { createClaudeLocalFixture } from './claude-local-fixture.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const bridgeOwner = process.argv.includes('--bridge-owner');
const reportName = bridgeOwner ? 'desktop-crash-bridge-owner' : 'desktop-crash';
const expectedCdHash = bridgeOwner ? '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3' : '93781410161fcf4560c244ce5469b980ffc38976';
const bundle = path.join(root, `release/${bridgeOwner ? 'bridge-owner-candidate' : 'proxy-probe-candidate'}/mac-arm64/MuCodeSandbox.app`);
const owned = await mkdtemp(path.join(homedir(), '.mu-desktop-crash-'));
const directory = path.join(owned, 'data');
const artifacts = path.join(root, 'test-results', `${reportName}-${Date.now()}`);
await mkdir(artifacts, { mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const runtime = new LimaRuntime(directory), hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
let hits = 0, ticks = 0, streamClosed = 0;
const hostEvents: { at: number; kind: string }[] = [];
const target = createServer((req, res) => {
  hits++; hostEvents.push({ at: Date.now(), kind: 'request' });
  if (req.url !== '/stream') { res.end('MU_DESKTOP_CRASH_OK'); return; }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  const timer = setInterval(() => { ticks++; hostEvents.push({ at: Date.now(), kind: 'tick' }); res.write('MU_CRASH_TICK\n'); }, 250);
  res.once('close', () => { clearInterval(timer); streamClosed++; hostEvents.push({ at: Date.now(), kind: 'stream-closed' }); });
});
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const fixture = await createClaudeLocalFixture({ browserPort: (target.address() as { port: number }).port });
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), bundle, artifactsDirectory: artifacts,
  accountFree: true, paidModelCalls: 0, actualElectronMainSigkill: false, actualVmTested: true, leaseSeconds: LEASE_SECONDS,
  browserTested: false, claudeClientTested: false, actualMacSleepTested: false, actualWifiSwitchTested: false,
  scope: 'Frozen Electron main SIGKILL with live guest TCP and stream, native terminal, guest file grant, lease expiry, reopening and manual recovery; local fixture only', captures: [] };
let app: ElectronApplication | undefined, page: Page | undefined, current: Environment | undefined;
let terminal: WebSocket | undefined, terminalClosed = false, captureOpen = false;
let serviceUrl = '', oldTicket = '', grantId = '';
let terminalOutput = '';
type ProcessIdentity = { pid: number; parent: number; command: string };
let children: ProcessIdentity[] = [];
const admin = (args: string[], input?: string) => runtime.management(current!, args, { input, timeoutMs: 20_000, maxBytes: 32_000_000 });
const guest = (args: string[]) => runtime.guest({ ...current!, state: 'running' }, args, { timeoutMs: 10_000 });
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Desktop crash observation timed out'); await delay(200); }
}
async function api(endpoint: string, method = 'GET', body?: unknown, allowError = false): Promise<any> {
  const response = await page!.evaluate(async ({ endpoint, method, body }) => {
    const res = await fetch(`/api${endpoint}`, { method, headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    return { status: res.status, body: await res.json() };
  }, { endpoint, method, body });
  if (allowError) return response;
  assert.ok(response.status < 400, JSON.stringify(response)); return response.body;
}
async function finish(job: { id: string }) {
  await until(async () => {
    const space = await statfs(owned); assert.ok(space.bavail * space.bsize > 80 * 2 ** 30);
    const snapshot = await api('/snapshot'), row = snapshot.jobs.find((entry: any) => entry.id === job.id);
    if (row?.status === 'running') return false;
    assert.equal(row?.status, 'succeeded', row?.message);
    current = snapshot.environments.find((entry: Environment) => entry.id === current!.id); return true;
  }, 950_000);
}
async function open() {
  app = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
    env: { ...process.env, MU_DATA_DIR: directory, MU_DESKTOP_USER_DATA_DIR: path.join(owned, 'desktop') } });
  page = await app.firstWindow(); await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.hide(); });
  const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), pid: process.pid }));
  assert.ok(identity.packaged); assert.equal(identity.appPath, path.join(bundle, 'Contents/Resources/app'));
  assert.equal((await api('/snapshot')).system.dataDir, directory);
  assert.equal((await api('/snapshot')).system.hostNetwork.state, 'ready');
  serviceUrl = new URL(page.url()).origin;
  (report.launches ??= []).push(identity);
}
async function processRows(): Promise<ProcessIdentity[]> {
  return (await run('/bin/ps', ['-axo', 'pid=,ppid=,comm='])).split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : [];
  });
}
async function descendants() {
  const rows = await processRows(), pids = new Set([app!.process().pid!]);
  let changed = true;
  while (changed) { changed = false; for (const row of rows) if (pids.has(row.parent) && !pids.has(row.pid)) { pids.add(row.pid); changed = true; } }
  return rows.filter(row => pids.has(row.pid) && ['ssh', 'limactl', 'mu-host-bridge', 'mu-network-monitor'].includes(path.basename(row.command)));
}
const lease = async () => JSON.parse((await admin(['sudo', LEASE_HELPER_PATH, 'status'])).trim());
const counts = async () => JSON.parse((await admin(['python3', '-c', `import collections,json\nc=collections.Counter()\nwith open('/home/dev/crash-workload.jsonl') as f:\n for line in f:c[json.loads(line)['kind']]+=1\nprint(json.dumps(c))`])).trim());
const request = () => guest(['curl', '--fail', '--silent', '--max-time', '3', 'http://203.0.113.81/tick']);
async function capture(name: string, source: string, boot = false) {
  if (boot) {
    const state = () => admin(['sudo', 'systemctl', 'show', '--property=SubState', '--value', 'mucodesandbox-boot-capture.service']);
    if ((await state()).trim() !== 'exited') await admin(['sudo', 'systemctl', 'kill', '--kill-whom=main', '--signal=SIGINT', 'mucodesandbox-boot-capture.service']);
    await until(async () => (await state()).trim() === 'exited', 15_000);
  }
  const data = Buffer.from((await admin(['sudo', 'base64', '-w0', source])).trim(), 'base64'); assert.ok(data.length > 24);
  const file = path.join(artifacts, `${name}.pcap`); await writeFile(file, data, { mode: 0o600 });
  assert.equal((await admin(['cat', '/sys/class/net/eth0/ifindex'])).trim(), '2');
  const gateway = (await admin(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+) dev eth0/)![1];
  assert.equal(gateway, '192.168.5.2');
  const physical = (await packetLines(file, 'ifindex 2 and outbound and (ip or ip6)')).length;
  const ssh = (await packetLines(file, 'ifindex 2 and outbound and tcp and src port 22 and dst host 192.168.5.2')).length;
  const unapproved = (await packetLines(file, 'ifindex 2 and outbound and (ip6 or (ip and not ((tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67))))')).length;
  assert.ok(physical > 0 && ssh > 0); assert.equal(unapproved, 0);
  report.captures.push({ name, bytes: data.length, sha256: hash(data), physical, ssh, unapproved, ...(boot ? { bootId: (await admin(['cat', '/proc/sys/kernel/random/boot_id'])).trim() } : {}) });
}
async function stopCapture() {
  if (!captureOpen) return;
  await admin(['sudo', 'systemctl', 'stop', 'mu-desktop-crash-capture.service']); captureOpen = false;
  await capture('active-crash', '/run/mu-desktop-crash.pcap');
}
async function ticketRejected(ticket: string) {
  return new Promise<boolean>(resolve => {
    const ws = new WebSocket(`${serviceUrl.replace('http:', 'ws:')}/terminal?ticket=${ticket}`, { origin: serviceUrl });
    const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 5000);
    ws.once('open', () => { clearTimeout(timer); ws.terminate(); resolve(false); });
    ws.once('error', () => { clearTimeout(timer); resolve(true); });
    ws.once('close', () => { clearTimeout(timer); resolve(true); });
  });
}
try {
  const space = await statfs(owned); assert.ok(space.bavail * space.bsize > 100 * 2 ** 30);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  report.cdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1];
  assert.equal(report.cdHash, expectedCdHash);
  const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
  report.modules = Object.fromEntries(await Promise.all((await readdir(compiled)).filter(file => file.endsWith('.js')).map(async file => [file, hash(await readFile(path.join(compiled, file)))])));
  const cache = process.env.MU_TEST_SING_BOX_CACHE; assert.ok(cache); assert.equal(hash(await readFile(cache)), SING_BOX_SHA256);
  await mkdir(path.join(directory, 'tools/sing-box'), { recursive: true }); await copyFile(cache, path.join(directory, 'tools/sing-box', SING_BOX_ARCHIVE));
  await open();
  current = await api('/environments', 'POST', { name: 'Disposable active desktop crash', cpus: 2, memoryGiB: 2, diskGiB: 10,
    network: { mode: 'http', host: '127.0.0.1', port: fixture.proxyPort, username: 'mu', password: 'tui-fixture', strict: true, transparent: true, noProxy: '' } });
  console.log('Starting fresh protected VM through frozen Electron application');
  await finish(await api(`/environments/${current!.id}/actions/start`, 'POST'));
  await capture('first-boot', '/var/log/mucodesandbox/boot-network.pcap', true); fixture.restrictToLocalFixture();
  assert.equal((await request()).trim(), 'MU_DESKTOP_CRASH_OK');
  const project = path.join(owned, 'project'); await mkdir(project); await writeFile(path.join(project, 'allowed.txt'), 'MU_CRASH_AUTHORIZED_FILE');
  await finish(await api(`/environments/${current!.id}/bridge`, 'POST', { root: project, writable: false, minutes: 5, commands: [] }));
  const grants = await api(`/environments/${current!.id}/bridge`); assert.equal(grants.length, 1); grantId = grants[0].id;
  assert.equal((await guest(['mu-host', grantId, 'read', 'allowed.txt'])).trim(), 'MU_CRASH_AUTHORIZED_FILE');
  const issued = await api(`/environments/${current!.id}/terminal-ticket`, 'POST', { command: 'shell' });
  terminal = new WebSocket(`${serviceUrl.replace('http:', 'ws:')}/terminal?ticket=${issued.ticket}`, { origin: serviceUrl });
  terminal.on('error', () => {}); terminal.on('close', () => { terminalClosed = true; });
  terminal.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'data') terminalOutput += message.data; });
  await until(() => terminal!.readyState === WebSocket.OPEN);
  terminal.send(JSON.stringify({ type: 'input', data: 'printf "MU_CRASH_%s\\n" "TERMINAL_READY"\r' }));
  await until(() => terminalOutput.includes('MU_CRASH_TERMINAL_READY'));
  await admin(['sudo', 'systemd-run', '--quiet', '--unit=mu-desktop-crash-capture', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-U', '-s', '0', '-w', '/run/mu-desktop-crash.pcap']);
  captureOpen = true;
  const workload = `import json,socket,threading,time
lock=threading.Lock()
def record(kind):
 with lock:
  with open('/home/dev/crash-workload.jsonl','a') as f:f.write(json.dumps({'at':time.time(),'kind':kind})+'\\n')
def stream():
 try:
  s=socket.create_connection(('203.0.113.81',80),3);s.settimeout(70)
  s.sendall(b'GET /stream HTTP/1.1\\r\\nHost: 203.0.113.81\\r\\nConnection: close\\r\\n\\r\\n')
  with s.makefile('rb') as f:
   for line in f:
    if b'MU_CRASH_TICK' in line:record('stream')
  record('stream-closed')
 except Exception:record('stream-error')
threading.Thread(target=stream,daemon=True).start()
while True:
 try:
  with socket.create_connection(('203.0.113.81',80),2) as s:
   s.settimeout(2);s.sendall(b'GET /tick HTTP/1.0\\r\\nHost: 203.0.113.81\\r\\n\\r\\n');data=b''
   while True:
    chunk=s.recv(4096)
    if not chunk:break
    data+=chunk
   if b'MU_DESKTOP_CRASH_OK' not in data:raise RuntimeError('Wrong response')
  record('ok')
 except Exception:record('error')
 time.sleep(1)
`;
  await admin(['sudo', 'tee', '/home/dev/crash-workload.py'], workload);
  await admin(['sudo', 'chown', 'dev:dev', '/home/dev/crash-workload.py']);
  await admin(['sudo', 'systemd-run', '--quiet', '--unit=mu-crash-workload', '--uid=dev', '/usr/bin/python3', '/home/dev/crash-workload.py']);
  await until(async () => { try { const c = await counts(); return c.ok >= 4 && c.stream >= 12; } catch { return false; } });
  oldTicket = (await api(`/environments/${current!.id}/terminal-ticket`, 'POST', { command: 'shell' })).ticket;
  report.positive = { kernel: await lease(), guest: await counts(), host: { hits, ticks }, bridgeRead: true, actualTerminalRoundTrip: true };
  assert.ok(report.positive.kernel.active && report.positive.kernel.remainingMs > 30_000);
  const configuration = JSON.parse((await admin(['sudo', 'cat', '/etc/mucodesandbox/tunnel.json'])).trim());
  const relayPort = configuration.outbounds[0].server_port;
  assert.equal(configuration.outbounds[0].server, '127.0.0.1'); assert.ok(Number.isInteger(relayPort));
  assert.ok((await admin(['ss', '-H', '-lnt', `sport = :${relayPort}`])).trim());
  children = await descendants(); assert.ok(children.filter(row => path.basename(row.command) === 'ssh').length >= 2);
  assert.ok(children.some(row => path.basename(row.command) === 'mu-host-bridge'));
  report.ownedChildren = children;
  const proc = app!.process(), pid = proc.pid!, killedAt = Date.now();
  report.killedAt = killedAt;
  const exited = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })));
  console.log('Killing actual Electron main with active TCP, stream, terminal and file grant');
  assert.ok(proc.kill('SIGKILL')); report.exit = await exited;
  assert.deepEqual(report.exit, { code: null, signal: 'SIGKILL' }); report.actualElectronMainSigkill = true; report.killedPid = pid;
  app = undefined; page = undefined;
  await until(async () => !(await admin(['ss', '-H', '-lnt', `sport = :${relayPort}`])).trim(), 15_000);
  await until(() => terminalClosed && streamClosed > 0, 15_000);
  report.transportClosedMs = Date.now() - killedAt;
  await assert.rejects(request()); await assert.rejects(guest(['mu-host', grantId, 'read', 'allowed.txt']));
  const stableGuest = await counts(), stableHost = { hits, ticks };
  await delay(5000);
  const after = await counts(); assert.equal(after.ok, stableGuest.ok); assert.equal(after.stream, stableGuest.stream);
  assert.equal(hits, stableHost.hits); assert.equal(ticks, stableHost.ticks); assert.ok(after.error > (stableGuest.error ?? 0));
  report.afterKill = { terminalClosed, streamClosed, listenerAbsent: true, newRequestDenied: true, fileGrantDenied: true,
    guest: after, host: { hits, ticks }, ongoingAttemptsFail: true, stableMs: 5000 };
  await until(async () => !(await lease()).active, (LEASE_SECONDS + 5) * 1000);
  report.expired = { afterMs: Date.now() - killedAt, kernel: await lease(), vmState: (await runtime.list()).find(row => row.name === current!.instanceName)?.status };
  assert.equal(report.expired.kernel.active, false); assert.equal(report.expired.vmState, 'Running');
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '2', '--proxy', '', '--interface', 'eth0', 'http://203.0.113.81/tick']));
  await writeFile(path.join(artifacts, 'guest-workload.jsonl'), await admin(['cat', '/home/dev/crash-workload.jsonl']), { mode: 0o600 });
  await stopCapture();
  const live = await processRows(); report.survivingOwnedChildren = children.filter(child => live.some(row => row.pid === child.pid && row.command === child.command));
  assert.deepEqual(report.survivingOwnedChildren, [], 'Application-owned SSH/terminal/bridge/monitor children must not survive SIGKILL');
  console.log('Reopening frozen app, rejecting old access, then manually restarting same VM');
  await open();
  await until(async () => (await runtime.list()).find(row => row.name === current!.instanceName)?.status === 'Stopped', 30_000);
  report.reopenStateObservations = [];
  await until(async () => {
    current = (await api('/snapshot')).environments.find((row: Environment) => row.id === current!.id);
    report.reopenStateObservations.push({ at: Date.now(), state: current!.state });
    return current!.state === 'error';
  }, 30_000);
  assert.equal(current!.state, 'error'); assert.deepEqual(await api(`/environments/${current!.id}/bridge`), []);
  assert.equal((await api(`/environments/${current!.id}/terminal-ticket`, 'POST', { command: 'shell' }, true)).status, 409);
  assert.equal(await ticketRejected(oldTicket), true);
  report.reopen = { stoppedBeforeManualRestart: true, state: current!.state, grantsEmpty: true, oldTicketRejected: true, terminalIssueRejected: true };
  await finish(await api(`/environments/${current!.id}/actions/restart`, 'POST'));
  await capture('recovery-boot', '/var/log/mucodesandbox/boot-network.pcap', true);
  assert.notEqual(report.captures[0].bootId, report.captures.at(-1).bootId);
  assert.equal((await request()).trim(), 'MU_DESKTOP_CRASH_OK');
  await assert.rejects(guest(['mu-host', grantId, 'read', 'allowed.txt']));
  assert.equal((await guest(['cat', '/home/dev/crash-workload.py'])).trim(), workload.trim());
  report.manualRecovery = { newBusinessSucceeded: true, oldGrantRejected: true, guestFilePreserved: true };
  await finish(await api(`/environments/${current!.id}/actions/stop`, 'POST')); report.passed = true;
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
finally {
  terminal?.terminate();
  if (captureOpen && current) await stopCapture().catch(error => { report.captureError = String(error); report.passed = false; process.exitCode = 1; });
  await app?.close().catch(error => { report.closeError = String(error); });
  const live = await processRows();
  for (const child of children) if (live.some(row => row.pid === child.pid && row.command === child.command)) {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* A test-owned child may already have exited. */ }
  }
  try {
    for (const row of await runtime.list()) {
      if (row.status === 'Running') await runtime.command(['stop', '--force', row.name], { timeoutMs: 120_000 });
      await runtime.command(['delete', '--force', row.name], { timeoutMs: 120_000 });
    }
    assert.deepEqual(await runtime.list(), []); await rm(owned, { recursive: true }); report.testResourcesRemoved = true;
  } catch (error) { report.cleanupError = String(error); report.retainedTestDirectory = owned; report.passed = false; process.exitCode = 1; }
  await fixture.close(); target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve()));
  await writeFile(path.join(artifacts, 'host-events.json'), JSON.stringify(hostEvents, null, 2), { mode: 0o600 });
  report.finishedAt = new Date().toISOString();
  const files = ['scripts/verify-desktop-crash.ts', 'scripts/claude-local-fixture.ts', 'scripts/packet-capture.ts'];
  report.sources = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(path.join(root, file)))])));
  for (const file of files) await copyFile(path.join(root, file), path.join(artifacts, `source-${path.basename(file)}`));
  report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, hash(await readFile(path.join(artifacts, file)))])));
  const bytes = JSON.stringify(report, null, 2);
  await writeFile(path.join(artifacts, 'report.json'), bytes, { mode: 0o600 });
  await writeFile(path.join(root, `test-results/${reportName}.json`), bytes, { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, error: report.error, survivingOwnedChildren: report.survivingOwnedChildren, cleanup: report.testResourcesRemoved, artifacts }, null, 2));
}
