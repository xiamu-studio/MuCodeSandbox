import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { LimaRuntime } from '../server/runtime.ts';
import { run } from '../server/process.ts';
import { GUEST_CHROMIUM_VERSION, GUEST_CHROMIUM_SHA256, inspectGuestBrowserSandbox } from '../server/guest-browser-runtime.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';
import { MOCK_CREDENTIAL } from '../server/mock-messages.ts';
import type { Environment } from '../shared/types.ts';
import { createClaudeLocalFixture } from './claude-local-fixture.ts';
import { backupBrowserFixture, validateBackupBrowser } from './backup-browser-fixture.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
function numeric(name: string, fallback: number) {
  const index = args.indexOf(name), value = index < 0 ? fallback : Number(args[index + 1]);
  assert.ok(Number.isFinite(value) && value >= 30 && value <= 86_400, `Invalid ${name}`); return value * 1000;
}
const durationMs = numeric('--duration', 86_400), intervalMs = numeric('--interval', 300), chunkMs = numeric('--chunk', 1800);
const bundle = path.join(root, 'release/bridge-owner-candidate/mac-arm64/MuCodeSandbox.app');
const cdHash = '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const artifacts = process.env.MU_DAY_RUN_DIR ?? path.join(root, 'test-results', `day-workflow-${Date.now()}`);
assert.equal(path.dirname(artifacts), path.join(root, 'test-results'));
assert.match(path.basename(artifacts), /^day-workflow-\d+$/);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
if (args.includes('--launch')) {
  const log = await open(path.join(artifacts, 'runner.log'), 'wx', 0o600);
  const child = spawn(process.execPath, [import.meta.filename, ...args.filter(arg => arg !== '--launch')], {
    cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, MU_DAY_RUN_DIR: artifacts },
  });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  await writeFile(path.join(artifacts, 'job.json'), JSON.stringify({ pid: child.pid, artifacts, executable: process.execPath,
    script: import.meta.filename, launchedAt: new Date().toISOString(), durationMs, intervalMs, chunkMs }, null, 2), { mode: 0o600 });
  child.unref(); await log.close(); console.log(JSON.stringify({ pid: child.pid, artifacts, durationMs }));
  process.exit(0);
}

const owned = await mkdtemp(path.join(homedir(), '.mu-day-'));
const directory = path.join(owned, 'private');
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const runtime = new LimaRuntime(directory);
const sourceFiles = ['scripts/verify-day-workflow.ts', 'scripts/claude-local-fixture.ts', 'scripts/backup-browser-fixture.ts',
  'scripts/packet-capture.ts', 'server/guest-browser-sandbox.ts', 'server/guest-browser-runtime.ts', 'server/mock-messages.ts'];
const report: Record<string, any> = { passed: false, state: 'preparing', startedAt: new Date().toISOString(), runnerPid: process.pid,
  package: { bundle, cdHash }, artifactsDirectory: artifacts, ownedRoot: owned, durationRequiredMs: durationMs, intervalMs, chunkMs,
  accountFree: true, paidModelCalls: 0, actualElectronPackageTested: true, actualVmTested: true, actualBrowserTested: true,
  actualNativeTerminalTested: true, cliMode: 'Periodic official CLI print requests through one persistent native terminal; not one continuous CLI process',
  residentialEgressTested: false, actualMacSleepTested: false, actualWifiSwitchTested: false, desktopIntegrationTested: false,
  scope: 'One fixed actual Electron app, VM, browser and native terminal; browser streaming and heartbeat plus periodic local CLI requests, protection and bypass checks; chunked captures with explicit rotation gaps',
  observations: [], captures: [], events: [], rotationGaps: [] };
const reportFile = path.join(artifacts, 'report.json');
let application: ElectronApplication | undefined, page: Page | undefined, viewer: Page | undefined, current: Environment | undefined;
let transcript = '', stableStart = 0, previousHeartbeat = 0, previousStream = 0, captureSequence = 0;
let capture: { unit: string; guestFile: string; startedAt: string; monotonic: number } | undefined;
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopping = true; });
const website = backupBrowserFixture('http://203.0.113.81');
const traffic = { heartbeats: 0, streamStarts: 0, sentTicks: 0, receivedTicks: 0, heartbeatErrors: [] as string[] };
const streams = new Set<NodeJS.Timeout>();
const server = createServer((request, response) => {
  if (request.url === '/stream') {
    traffic.streamStarts++; response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.flushHeaders();
    let ticks = 0; const timer = setInterval(() => { ticks++; traffic.sentTicks++; response.write(`${ticks}\n`); }, 1000);
    streams.add(timer); response.on('close', () => { clearInterval(timer); streams.delete(timer); }); return;
  }
  if (request.url?.startsWith('/heartbeat?')) {
    const ticks = Number(new URL(request.url, 'http://203.0.113.81').searchParams.get('ticks'));
    if (!Number.isSafeInteger(ticks) || ticks < traffic.receivedTicks) { traffic.heartbeatErrors.push('Invalid or regressed stream receipt'); response.writeHead(400).end(); return; }
    traffic.heartbeats++; traffic.receivedTicks = ticks;
    void appendFile(path.join(artifacts, 'browser-heartbeats.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ticks, count: traffic.heartbeats })}\n`, { mode: 0o600 });
    response.end('MU_DAY_HEARTBEAT_OK'); return;
  }
  // Keep the synthetic cookie valid beyond the 24-hour observation window.
  if (request.url === '/login') {
    const header = response.setHeader.bind(response);
    response.setHeader = ((name: string, value: any) => header(name, name.toLowerCase() === 'set-cookie' ? String(value).replace('Max-Age=86400', 'Max-Age=172800') : value)) as typeof response.setHeader;
  }
  if (request.url === '/read') {
    const end = response.end.bind(response);
    response.end = ((data: any) => end(typeof data === 'string' ? data + `<script>
      let ticks=0;const status=document.createElement('p');document.body.append(status);
      fetch('/stream').then(async response=>{if(!response.ok)throw Error('Stream refused');const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
        while(true){const chunk=await reader.read();if(chunk.done)throw Error('Stream ended');pending+=decoder.decode(chunk.value,{stream:true});let line;
          while((line=pending.indexOf('\\n'))>=0){ticks=Number(pending.slice(0,line));pending=pending.slice(line+1);status.textContent='Stream: '+ticks;}}}).catch(error=>{status.textContent=String(error);});
      setInterval(()=>fetch('/heartbeat?ticks='+ticks).catch(error=>{status.textContent=String(error);}),5000);
      </script>` : data)) as typeof response.end;
  }
  website.handler(request, response);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const fixture = await createClaudeLocalFixture({ browserPort: (server.address() as { port: number }).port });
const guest = (args: string[]) => runtime.guest(current!, args, { timeoutMs: 40_000 });
const admin = (args: string[]) => runtime.management(current!, args, { timeoutMs: 40_000, maxBytes: 100_000_000 });
async function save(stage: string) {
  report.progress = { stage, at: new Date().toISOString(), stableElapsedMs: stableStart ? performance.now() - stableStart : 0 };
  report.traffic = { ...traffic }; report.browserEvidence = website.evidence;
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(report.progress.at, stage, Math.round(report.progress.stableElapsedMs / 1000));
}
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 45_000) {
  const deadline = performance.now() + timeoutMs;
  while (!await check()) { assert.ok(!stopping && performance.now() < deadline, 'Day workflow observation timed out or stopped'); await delay(150); }
}
async function api(endpoint: string, method = 'GET', body?: unknown): Promise<any> {
  return page!.evaluate(async ({ endpoint, method, body }) => {
    const response = await fetch(`/api${endpoint}`, { method, headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
  }, { endpoint, method, body });
}
async function reserve() { const disk = await statfs(owned); const free = disk.bavail * disk.bsize; assert.ok(free > 80 * 2 ** 30, 'Disk reserve below 80 GiB'); return free; }
async function finish(job: { id: string }) {
  await until(async () => { await reserve(); const value = (await api('/snapshot')).jobs.find((entry: any) => entry.id === job.id);
    if (value?.status === 'running') return false; assert.equal(value?.status, 'succeeded', value?.message); return true; }, 950_000);
}
async function action(kind: string) {
  await finish(await api(`/environments/${current!.id}/actions/${kind}`, 'POST'));
  current = (await api('/snapshot')).environments.find((entry: Environment) => entry.id === current!.id);
}
async function paste(value: string) {
  const input = page!.locator('.xterm-helper-textarea'); await input.focus();
  await input.evaluate((node, value) => { const clipboard = new DataTransfer(); clipboard.setData('text/plain', value);
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true })); }, value);
  await page!.keyboard.press('Enter');
}
async function cli(index: number) {
  const marker = `MU_DAY_CLI_EXIT_${index}=`, before = transcript.length, receiptsBefore = fixture.lab.messages.length;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const args = ['env', 'ANTHROPIC_BASE_URL=http://203.0.113.80', `ANTHROPIC_AUTH_TOKEN=${MOCK_CREDENTIAL}`,
    'CLAUDE_CONFIG_DIR=/home/dev/.mu-day-cli', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', 'IS_DEMO=1',
    'DISABLE_AUTOUPDATER=1', 'DISABLE_TELEMETRY=1', 'DISABLE_ERROR_REPORTING=1', 'API_TIMEOUT_MS=10000',
    'claude', '-p', `MU_LAB_CLAUDE_TEXT day-${index}`, '--model', 'claude-sonnet-4-5-20250929', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--no-chrome'];
  await paste(`stty -echo; ${args.map(quote).join(' ')}; printf '\\n${marker}%s\\n' "$?"; stty echo`);
  await until(() => stripVTControlCharacters(transcript.slice(before)).includes(`${marker}0`), 60_000);
  const output = stripVTControlCharacters(transcript.slice(before)); assert.match(output, /MU_REAL_CLAUDE_TEXT_OK/);
  const receipts = fixture.lab.messages.slice(receiptsBefore); assert.ok(receipts.some(row => row.scenario === 'TEXT' && row.completed));
  const file = `cli-${index}.txt`; await writeFile(path.join(artifacts, file), output, { mode: 0o600 });
  return { file, sha256: hash(Buffer.from(output)), receipts, terminalExitCode: 0 };
}
async function startCapture() {
  const unit = `mu-day-capture-${++captureSequence}`, guestFile = `/run/${unit}.pcap`;
  const startedAt = new Date().toISOString(), monotonic = performance.now();
  await admin(['sudo', 'systemd-run', '--quiet', `--unit=${unit}`, '--property=Type=exec', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', guestFile]);
  capture = { unit, guestFile, startedAt, monotonic };
}
async function exportCapture(last = false) {
  assert.ok(capture); const old = capture; await admin(['sudo', 'systemctl', 'stop', `${old.unit}.service`]); capture = undefined;
  const stoppedAt = new Date().toISOString(), stoppedMonotonic = performance.now();
  if (!last) { await startCapture(); report.rotationGaps.push({ stoppedAt, nextStartedAt: capture!.startedAt, upperBoundMs: performance.now() - stoppedMonotonic }); }
  const size = Number((await admin(['sudo', 'stat', '-c', '%s', old.guestFile])).trim());
  assert.ok(size > 24 && size < 64 * 2 ** 20, 'Capture empty or exceeds 64 MiB bound');
  const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', old.guestFile])).trim(), 'base64'); assert.equal(bytes.length, size);
  const file = `${old.unit}.pcap`; await writeFile(path.join(artifacts, file), bytes, { mode: 0o600 });
  const outgoing = await packetLines(path.join(artifacts, file), 'ifindex 2 and outbound and (ip or ip6)');
  const gateway = report.gateway;
  const ssh = outgoing.filter(line => line.includes(`.22 > ${gateway}.`));
  const unapproved = outgoing.filter(line => /\sIP6\s/.test(line) || !(line.includes(`.22 > ${gateway}.`) || /\.68 > [0-9.]+\.67:/.test(line)));
  assert.ok(ssh.length > 0); assert.deepEqual(unapproved, []);
  report.captures.push({ file, bytes: size, sha256: hash(bytes), startedAt: old.startedAt, stoppedAt,
    durationMs: stoppedMonotonic - old.monotonic, physicalOut: outgoing.length, approvedSsh: ssh.length, unapproved: unapproved.length });
  await admin(['sudo', 'rm', '-f', old.guestFile]);
}
async function browserPixels(index: number) {
  await viewer!.getByRole('status').filter({ hasText: '已连接' }).waitFor({ timeout: 5000 });
  const canvas = viewer!.locator('.guest-browser-canvas canvas');
  const pixels = await canvas.evaluate((node: HTMLCanvasElement) => {
    const data = node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data, colors = new Set<string>();
    for (let i = 0; i < data.length; i += 400) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return { width: node.width, height: node.height, colors: colors.size };
  }); assert.equal(pixels.width, 1280); assert.equal(pixels.height, 800); assert.ok(pixels.colors > 20);
  const file = `browser-${index}.png`, png = Buffer.from((await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL('image/png'))).split(',')[1]!, 'base64');
  await writeFile(path.join(artifacts, file), png, { mode: 0o600 }); return { ...pixels, file, sha256: hash(png) };
}
async function observe(index: number) {
  assert.ok(!stopping); const snapshot = await api('/snapshot');
  assert.equal(snapshot.system.hostNetwork.state, 'ready'); assert.equal(snapshot.environments.find((row: any) => row.id === current!.id)?.state, 'running');
  const protection = await api(`/environments/${current!.id}/network/protection`);
  assert.ok(protection.active && protection.integrity === 'verified');
  if (report.initialProtection) for (const key of ['firewallHash', 'tunnelConfigHash']) assert.equal(protection[key], report.initialProtection[key]);
  else report.initialProtection = protection;
  const bootId = (await admin(['cat', '/proc/sys/kernel/random/boot_id'])).trim(); assert.equal(bootId, report.bootId);
  const browserProcess = (await admin(['sudo', 'systemctl', 'show', 'mucodesandbox-browser.service', '--property=MainPID', '--value'])).trim();
  assert.equal(browserProcess, report.browserProcess);
  assert.ok(traffic.heartbeats > previousHeartbeat && traffic.receivedTicks > previousStream, 'Browser network or stream stopped progressing');
  previousHeartbeat = traffic.heartbeats; previousStream = traffic.receivedTicks; assert.deepEqual(traffic.heartbeatErrors, []);
  const inspection = await api(`/environments/${current!.id}/browser/inspect`); assert.equal(inspection.matchesConfiguration, true);
  const sandbox = await inspectGuestBrowserSandbox(runtime, current!);
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--interface', 'eth0', '--proxy', '', 'http://1.1.1.1/']));
  await assert.rejects(guest(['sudo', '-n', 'true']));
  const result = await cli(index), pixels = await browserPixels(index);
  const receipt = website.evidence.receipts.at(-1)!; validateBackupBrowser(receipt); assert.deepEqual(receipt.before, receipt.after);
  const row = { index, at: new Date().toISOString(), elapsedMs: performance.now() - stableStart, bootId, browserProcess, protection,
    hostNetwork: snapshot.system.hostNetwork, traffic: { ...traffic }, receipt, inspection, sandbox, pixels, cli: result, freeBytes: await reserve(),
    memory: (await admin(['free', '-b'])).trim(), hostProcesses: (await run('/bin/ps', ['-o', 'pid=,rss=,etime=,comm=', '-p', String(application!.process().pid)])).trim() };
  report.observations.push(row); await appendFile(path.join(artifacts, 'observations.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  await save(`Observation ${index}: browser, CLI and network protection passed`);
}

try {
  await reserve(); await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  assert.equal((await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1], cdHash);
  const modules = (await readdir(path.join(bundle, 'Contents/Resources/app/dist-server/server'))).filter(file => file.endsWith('.js')).sort(); assert.equal(modules.length, 45);
  report.package.modules = {};
  for (const file of [...modules.map(file => `dist-server/server/${file}`), 'desktop/main.cjs']) report.package.modules[file] = hash(await readFile(path.join(bundle, 'Contents/Resources/app', file)));
  report.sources = {};
  for (const file of sourceFiles) { const bytes = await readFile(path.join(root, file)); report.sources[file] = hash(bytes);
    const destination = path.join(artifacts, 'inputs', file); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes, { mode: 0o600 }); }
  const browserCache = `/tmp/mu-chromium-${GUEST_CHROMIUM_VERSION}-arm64.zip`;
  assert.equal(hash(await readFile(browserCache)), GUEST_CHROMIUM_SHA256);
  await mkdir(path.join(directory, 'tools/guest-browser'), { recursive: true, mode: 0o700 });
  await copyFile(browserCache, path.join(directory, 'tools/guest-browser', `chrome-${GUEST_CHROMIUM_VERSION}-linux-arm64.zip`));
  const proxyCache = process.env.MU_TEST_SING_BOX_CACHE; assert.ok(proxyCache); assert.equal(hash(await readFile(proxyCache)), SING_BOX_SHA256);
  await mkdir(path.join(directory, 'tools/sing-box'), { recursive: true, mode: 0o700 }); await copyFile(proxyCache, path.join(directory, 'tools/sing-box', SING_BOX_ARCHIVE));
  application = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
    env: { ...process.env, MU_DATA_DIR: directory, MU_DESKTOP_USER_DATA_DIR: path.join(owned, 'desktop'), MU_TEST_CLAUDE: '0' }, timeout: 60_000 });
  application.on('window', window => { window.on('crash', () => report.events.push({ event: 'window-crash', at: new Date().toISOString() }));
    void application!.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.webContents.setBackgroundThrottling(false); window.hide(); } }).catch(() => {}); });
  application.process().once('exit', (code, signal) => report.events.push({ event: 'app-exit', code, signal, at: new Date().toISOString() }));
  page = await application.firstWindow(); await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.webContents.setBackgroundThrottling(false); window.hide(); } });
  page.on('pageerror', error => report.events.push({ event: 'page-error', error: error.message }));
  page.on('websocket', socket => socket.on('framereceived', event => { try { const value = JSON.parse(event.payload.toString()); if (value.type === 'data') transcript += value.data; } catch { /* Other frames. */ } }));
  report.package.application = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), pid: process.pid,
    renderers: app.getAppMetrics().filter(row => row.type === 'Tab').map(row => ({ pid: row.pid, sandboxed: row.sandboxed })) }));
  assert.ok(report.package.application.packaged && report.package.application.renderers.length && report.package.application.renderers.every((row: any) => row.sandboxed));
  assert.equal((await api('/snapshot')).system.dataDir, directory);
  current = await api('/environments', 'POST', { name: 'Frozen package day acceptance', cpus: 2, memoryGiB: 2, diskGiB: 10,
    browserUrl: 'http://203.0.113.81/write', identity: { timezone: 'Asia/Tokyo', locale: 'ja-JP' },
    network: { mode: 'http', host: '127.0.0.1', port: fixture.proxyPort, username: 'mu', password: 'tui-fixture', strict: true, transparent: true, noProxy: 'localhost,127.0.0.1,::1' } });
  await save('Starting owned 2 GiB VM'); await action('start');
  report.bootId = (await admin(['cat', '/proc/sys/kernel/random/boot_id'])).trim();
  report.gateway = (await admin(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+)/)![1];
  assert.equal((await admin(['cat', '/sys/class/net/eth0/ifindex'])).trim(), '2');
  await save('Installing official cached browser and official CLI'); await action('install-agent');
  report.client = await api(`/environments/${current!.id}/agent`); assert.equal(report.client.installed, true);
  await finish(await api(`/environments/${current!.id}/browser/open`, 'POST'));
  await until(() => application!.windows().some(window => new URL(window.url() || 'about:blank').searchParams.get('guestBrowser') === current!.id));
  viewer = application.windows().find(window => new URL(window.url() || 'about:blank').searchParams.get('guestBrowser') === current!.id)!;
  await viewer.getByRole('status').filter({ hasText: '已连接' }).waitFor(); await until(() => website.evidence.receipts.length === 1);
  validateBackupBrowser(website.evidence.receipts[0]); assert.equal(website.evidence.loginRequests, 1);
  fixture.restrictToLocalFixture();
  const canvas = viewer.locator('.guest-browser-canvas canvas'); await canvas.click({ position: { x: 350, y: 300 } });
  await viewer.keyboard.press('Control+l'); await viewer.keyboard.type('http://203.0.113.81/read'); await viewer.keyboard.press('Enter');
  await until(() => website.evidence.receipts.length === 2 && traffic.receivedTicks > 0);
  validateBackupBrowser(website.evidence.receipts[1]); assert.equal(website.evidence.loginRequests, 1);
  report.browserProcess = (await admin(['sudo', 'systemctl', 'show', 'mucodesandbox-browser.service', '--property=MainPID', '--value'])).trim(); assert.ok(Number(report.browserProcess) > 0);
  await page.getByRole('button', { name: `${current!.name} Linux 沙箱`, exact: true }).click();
  await page.getByRole('button', { name: '终端', exact: true }).click(); await page.locator('.terminal-actions').filter({ hasText: '已连接' }).waitFor();
  await until(async () => (await page!.locator('.xterm-rows').innerText()).includes('/workspace$'));
  await startCapture(); stableStart = performance.now(); report.stableStartedAt = new Date().toISOString(); report.state = 'running';
  await observe(0);
  let nextObservation = performance.now() + intervalMs;
  while (performance.now() - stableStart < durationMs) {
    assert.ok(!stopping, 'Acceptance interrupted'); await delay(Math.min(1000, Math.max(1, nextObservation - performance.now())));
    if (capture && performance.now() - capture.monotonic >= chunkMs) { await exportCapture(); await save('Packet segment exported; same VM continues'); }
    if (performance.now() >= nextObservation) { await observe(report.observations.length); nextObservation = performance.now() + intervalMs; }
  }
  await observe(report.observations.length); report.stableDurationMs = performance.now() - stableStart;
  assert.ok(report.stableDurationMs >= durationMs); await exportCapture(true);
  assert.deepEqual(report.events, []); report.state = 'verified'; report.passed = true; await save('Required stable duration completed');
} catch (error) {
  report.error = String(error); report.state = 'failed'; report.passed = false; console.error(error);
  if (capture && current) try { await exportCapture(true); } catch (captureError) { report.captureError = String(captureError); }
} finally {
  report.decisions = fixture.decisions; report.messages = fixture.lab.messages;
  try { await application?.close(); } catch (error) { report.applicationCleanupError = String(error); }
  for (const timer of streams) clearInterval(timer);
  await fixture.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  try { for (const row of await runtime.list()) { if (row.status === 'Running') await runtime.command(['stop', row.name], { timeoutMs: 120_000 });
      await runtime.command(['delete', row.name], { timeoutMs: 120_000 }); }
    assert.deepEqual(await runtime.list(), []); await rm(owned, { recursive: true }); report.testResourcesRemoved = true;
  } catch (error) { report.cleanupError = String(error); report.passed = false; }
  try { for (const [file, digest] of Object.entries(report.package.modules ?? {})) assert.equal(hash(await readFile(path.join(bundle, 'Contents/Resources/app', file))), digest);
    for (const [file, digest] of Object.entries(report.sources ?? {})) assert.equal(hash(await readFile(path.join(root, file))), digest);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]); report.inputsUnchanged = true;
  } catch (error) { report.inputError = String(error); report.passed = false; }
  report.finishedAt = new Date().toISOString(); await save(report.passed ? 'Passed and owned resources removed' : 'Failed; evidence retained');
}
if (!report.passed) process.exitCode = 1;
