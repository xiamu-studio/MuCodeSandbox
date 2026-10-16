import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { LimaRuntime } from '../server/runtime.ts';
import { run } from '../server/process.ts';
import { MOCK_FILE, MOCK_BASH_FILE } from '../server/mock-messages.ts';
import type { Environment } from '../shared/types.ts';
import { createClaudeLocalFixture } from './claude-local-fixture.ts';
import { verifyClaudeTui } from './claude-tui-workflow.ts';

const root = path.resolve(import.meta.dirname, '..'), name = 'claude-tui-packaged';
const bundle = path.join(root, 'release/tui-candidate/mac-arm64/MuCodeSandbox.app');
const directory = await mkdtemp(path.join(homedir(), '.mu-tui-packaged-'));
const desktopData = await mkdtemp(path.join(homedir(), '.mu-tui-packaged-user-'));
const artifacts = path.join(root, 'test-results', name); await mkdir(artifacts, { recursive: true, mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const runtime = new LimaRuntime(directory), fixture = await createClaudeLocalFixture();
const { lab, proxyPort, decisions } = fixture;
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), accountFree: true, paidModelCalls: 0,
  scope: 'Actual packaged Electron native terminal and packaged VM lifecycle; real interactive CLI against local Messages fixture; no account onboarding or provider calls',
  demoMode: true, firstAccountOnboardingTested: false, onboarding: [], reusedTestVm: false, package: { bundle } };
let application: ElectronApplication | undefined, page: Page | undefined, e: Environment | undefined, capture = false, transcript = '';
const errors: string[] = [];
type HostProcess = { pid: number; parent: number; tty: string; command: string };
let nativeHostProcesses: HostProcess[] = [];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const admin = (args: string[]) => runtime.management(e!, args, { timeoutMs: 30_000, maxBytes: 128_000_000 });
const guest = (args: string[]) => runtime.guest(e!, args, { timeoutMs: 30_000 });
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Packaged TUI observation timed out'); await delay(100); }
}
async function api(endpoint: string, method = 'GET', body?: unknown): Promise<any> {
  return page!.evaluate(async ({ endpoint, method, body }) => {
    const response = await fetch(`/api${endpoint}`, { method, headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`,
      'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
  }, { endpoint, method, body });
}
async function finish(job: { id: string }, timeoutMs = 950_000) {
  await until(async () => {
    const done = (await api('/snapshot')).jobs.find((j: any) => j.id === job.id);
    if (done?.status === 'running') return false;
    assert.equal(done?.status, 'succeeded', done?.message); return true;
  }, timeoutMs);
}
async function hostProcesses(): Promise<HostProcess[]> {
  const text = await run('/bin/ps', ['-axo', 'pid=,ppid=,tty=,comm=']);
  return text.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), tty: match[3], command: match[4] }] : [];
  });
}
async function observeNativeHostPty() {
  const rows = await hostProcesses(), owner = application!.process().pid!;
  const descendants = new Set([owner]); let changed = true;
  while (changed) { changed = false; for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; } }
  nativeHostProcesses = rows.filter(row => descendants.has(row.pid) && row.tty !== '??' && /(?:^|\/)(?:limactl|ssh)$/.test(row.command));
  assert.ok(nativeHostProcesses.some(row => path.basename(row.command) === 'limactl'), 'Actual application-owned native PTY needs a positive process observation');
  assert.ok(nativeHostProcesses.some(row => path.basename(row.command) === 'ssh'));
  return { applicationPid: owner, processes: nativeHostProcesses };
}
async function stopCapture() {
  if (!capture) return; capture = false;
  await admin(['sudo', 'systemctl', 'stop', 'mu-tui-packaged-capture.service']);
  const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', '/run/mu-tui-packaged.pcap'])).trim(), 'base64');
  assert.equal(bytes.length, Number((await admin(['sudo', 'stat', '-c', '%s', '/run/mu-tui-packaged.pcap'])).trim()));
  assert.ok(bytes.length > 24); await writeFile(path.join(artifacts, 'network.pcap'), bytes, { mode: 0o600 });
  const text = await admin(['sudo', 'tcpdump', '-nn', '-r', '/run/mu-tui-packaged.pcap']);
  await writeFile(path.join(artifacts, 'network.txt'), text, { mode: 0o600 });
  const gateway = (await admin(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+)/)![1];
  const outgoing = text.split('\n').filter(line => /\seth0\s+Out\s+IP6?\s/.test(line));
  const approved = outgoing.filter(line => line.includes(` > ${gateway}.${proxyPort}:`));
  const unapproved = outgoing.filter(line => /\sIP6\s/.test(line) || !(line.includes(` > ${gateway}.${proxyPort}:`) || line.includes(`.22 > ${gateway}.`) || /\.68 > [0-9.]+\.67:/.test(line)));
  report.capture = { bytes: bytes.length, sha256: hash(bytes), physicalOut: outgoing.length, approvedProxy: approved.length,
    unapproved: unapproved.length, proxyEndpoint: `${gateway}:${proxyPort}` };
  assert.ok(approved.length > 0); assert.deepEqual(unapproved, []);
}
try {
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
  report.package.cdHash = signature.match(/^CDHash=(.+)$/m)?.[1]; report.package.signature = signature.match(/^Signature=(.+)$/m)?.[1];
  assert.equal(report.package.cdHash, '7d6e3ea1d0b2b22ec466c2f1652279e5ca7bc37e');
  application = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
    env: { ...process.env, MU_DATA_DIR: directory, MU_DESKTOP_USER_DATA_DIR: desktopData, MU_LIMA_PATH: process.env.MU_LIMA_PATH, MU_TEST_CLAUDE: '0' }, timeout: 60_000 });
  page = await application.firstWindow({ timeout: 30_000 });
  await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  report.package.application = await application.evaluate(({ app, BrowserWindow }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(),
    version: app.getVersion(), electron: process.versions.electron, pid: process.pid,
    sandboxDisablingArgumentsAbsent: !process.argv.some(arg => /^--(?:no-sandbox|disable-(?:gpu|renderer|setuid)-sandbox)(?:=|$)/.test(arg)),
    rendererProcesses: app.getAppMetrics().filter(metric => metric.type === 'Tab').map(metric => ({ pid: metric.pid, sandboxed: metric.sandboxed })),
    windows: BrowserWindow.getAllWindows().map(window => {
      // Electron 44 exposes this inspection method at runtime, outside its public types.
      const contents = window.webContents as typeof window.webContents & { getLastWebPreferences?: () => Electron.WebPreferences };
      if (typeof contents.getLastWebPreferences !== 'function') throw new Error('Electron preference inspection unavailable');
      const preferences = contents.getLastWebPreferences();
      return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration }; }) }));
  assert.equal(report.package.application.packaged, true); assert.equal(report.package.application.sandboxDisablingArgumentsAbsent, true);
  assert.equal(report.package.application.appPath, path.join(bundle, 'Contents/Resources/app'));
  assert.ok(report.package.application.windows.every((w: any) => w.sandbox && w.contextIsolation && !w.nodeIntegration));
  assert.ok(report.package.application.rendererProcesses.length > 0);
  assert.ok(report.package.application.rendererProcesses.every((p: any) => p.sandboxed === true));
  assert.equal((await api('/snapshot')).system.dataDir, directory);
  e = await api('/environments', 'POST', { name: 'Packaged Claude interactive verification', cpus: 2, memoryGiB: 2, diskGiB: 10,
    identity: { timezone: 'UTC', locale: 'en-US' }, network: { mode: 'http', host: '127.0.0.1', port: proxyPort,
      username: 'mu', password: 'tui-fixture', strict: true, transparent: true, noProxy: '' } });
  console.log('Creating a fresh protected VM through the actual packaged application.');
  await finish(await api(`/environments/${e!.id}/actions/start`, 'POST'));
  e = (await api('/snapshot')).environments.find((value: any) => value.id === e!.id); assert.equal(e!.state, 'running');
  assert.equal((await api(`/environments/${e!.id}/agent`)).installed, false);
  await finish(await api(`/environments/${e!.id}/actions/install-agent`, 'POST'));
  report.client = await api(`/environments/${e!.id}/agent`); assert.equal(report.client.installed, true);
  report.client.executableSha256 = (await guest(['sha256sum', '/home/dev/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'])).split(/\s/)[0];
  report.packagedLifecycleAndColdInstall = true;
  fixture.restrictToLocalFixture();
  await guest(['mkdir', '-p', '/workspace/mu-claude-account-free']); await guest(['rm', '-f', MOCK_FILE, MOCK_BASH_FILE]);
  report.protectionBefore = await api(`/environments/${e!.id}/network/protection`); assert.equal(report.protectionBefore.active, true);
  report.physicalInterfaceIndex = JSON.parse(await admin(['ip', '-j', 'link', 'show', 'eth0']))[0].ifindex;
  await admin(['sudo', 'systemd-run', '--quiet', '--unit=mu-tui-packaged-capture', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', '/run/mu-tui-packaged.pcap']); capture = true;
  await delay(1000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framereceived', event => {
    try { const value = JSON.parse(event.payload.toString()); if (value.type === 'data') transcript += value.data; } catch { /* Ignore unrelated frames. */ }
  }));
  await page.getByRole('button', { name: `${e!.name} Linux 沙箱` }).click();
  await page.getByRole('button', { name: '终端', exact: true }).click(); await page.getByText('已连接', { exact: false }).waitFor();
  console.log('Testing the actual Electron native terminal and interactive permission menus.');
  await verifyClaudeTui({ page, artifacts, messages: lab.messages, output: () => transcript, guest, admin, report,
    observeHostPty: observeNativeHostPty, closeTerminal: async () => {
      await page!.getByRole('button', { name: '总览', exact: true }).click(); await page!.locator('.xterm').waitFor({ state: 'detached' });
      await until(async () => { const alive = await hostProcesses(); return nativeHostProcesses.every(p => !alive.some(row => row.pid === p.pid)); });
      report.nativeHostProcessesAfterDisconnect = (await hostProcesses()).filter(p => nativeHostProcesses.some(old => old.pid === p.pid));
      await page!.screenshot({ path: path.join(artifacts, 'terminal-pane-closed.png'), fullPage: true });
      return { actualTerminalPaneClosed: true, actualPageClosed: false, hostPtyProcessExited: true };
    } });
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--interface', 'eth0', '--proxy', '', 'http://1.1.1.1/'])); report.directBypassRejected = true;
  report.protectionAfter = await api(`/environments/${e!.id}/network/protection`); assert.equal(report.protectionAfter.active, true);
  for (const key of ['firewallHash', 'tunnelConfigHash']) assert.equal(report.protectionBefore[key], report.protectionAfter[key]);
  assert.ok(decisions.filter(d => d.localOnly && d.allowed).every(d => d.destination === '203.0.113.80:80'));
  assert.deepEqual(errors, []); await stopCapture(); report.passed = true;
} catch (error) {
  report.error = (error as Error).stack; process.exitCode = 1;
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(path.join(artifacts, 'failure.txt'), await page.locator('.xterm-rows').innerText({ timeout: 1000 }).catch(() => ''), { mode: 0o600 }); }
} finally {
  if (capture) await stopCapture().catch(error => { report.captureError = String(error); report.passed = false; });
  report.messages = [...lab.messages]; report.proxyDecisions = decisions; report.uiErrors = errors;
  await writeFile(path.join(artifacts, 'terminal.ansi.txt'), transcript, { mode: 0o600 });
  if (e && application && page && !page.isClosed()) {
    await api(`/environments/${e.id}/actions/stop`, 'POST').then(job => finish(job, 120_000)).catch(error => { report.cleanupError = String(error); });
    if (report.passed && !report.cleanupError) await api(`/environments/${e.id}/actions/delete`, 'POST').then(job => finish(job, 120_000)).catch(error => { report.cleanupError = String(error); });
  }
  await application?.close().catch(error => { report.applicationCloseError = String(error); }); await fixture.close();
  if (report.cleanupError || report.applicationCloseError || report.captureError) { report.passed = false; process.exitCode = 1; }
  if (report.passed) { await rm(directory, { recursive: true, force: true }); await rm(desktopData, { recursive: true, force: true }); report.testDataRemoved = true; }
  else { report.retainedDataDir = directory; report.retainedDesktopDataDir = desktopData; }
  report.sources = Object.fromEntries(await Promise.all(['scripts/verify-claude-tui-packaged.ts', 'scripts/claude-tui-workflow.ts', 'scripts/claude-local-fixture.ts', 'server/runtime.ts', 'server/mock-messages.ts'].map(async file => [file, hash(await readFile(path.join(root, file)))])));
  const packagedRoot = path.join(bundle, 'Contents/Resources/app');
  const packagedFiles = ['desktop/main.cjs', ...((await readdir(path.join(packagedRoot, 'dist-server/server'))).filter(file => file.endsWith('.js')).map(file => `dist-server/server/${file}`))];
  report.package.files = Object.fromEntries(await Promise.all(packagedFiles.map(async file => [file, hash(await readFile(path.join(packagedRoot, file)))])));
  report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, hash(await readFile(path.join(artifacts, file)))])));
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'test-results', `${name}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, package: { cdHash: report.package.cdHash, application: report.package.application }, client: report.client,
    permissions: report.permissions, cancellation: report.cancellation, reopen: report.reopen, terminalDisconnect: report.terminalDisconnect,
    capture: report.capture, error: report.error, retainedDataDir: report.retainedDataDir }, null, 2));
}
