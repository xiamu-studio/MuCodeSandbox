import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, statfs, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { LimaRuntime } from '../server/runtime.ts';
import { run } from '../server/process.ts';
import { GUEST_CHROMIUM_VERSION, GUEST_CHROMIUM_SHA256 } from '../server/guest-browser-runtime.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';
import { MOCK_FILE, MOCK_BASH_FILE } from '../server/mock-messages.ts';
import type { Environment } from '../shared/types.ts';
import { createClaudeLocalFixture } from './claude-local-fixture.ts';
import { verifyClaudeTui } from './claude-tui-workflow.ts';
import { backupBrowserFixture, validateBackupBrowser } from './backup-browser-fixture.ts';

const root = path.resolve(import.meta.dirname, '..');
const probe = process.argv.includes('--probe');
const bridgeOwner = process.argv.includes('--bridge-owner');
const transport = process.argv.includes('--transport') || probe || bridgeOwner;
const monitor = process.argv.includes('--monitor') || transport;
const recovery = process.argv.includes('--recovery') || monitor;
const storage = process.argv.includes('--storage') || recovery;
const network = process.argv.includes('--network') || storage;
const power = process.argv.includes('--power');
const delivery = process.argv.includes('--delivery') || power || network;
const variant = bridgeOwner ? 'bridge-owner' : probe ? 'probe' : transport ? 'transport' : monitor ? 'monitor' : recovery ? 'recovery' : storage ? 'storage' : network ? 'network' : power ? 'power' : delivery ? 'delivery' : 'latest';
const bundle = path.join(root, `release/${bridgeOwner ? 'bridge-owner-candidate' : probe ? 'proxy-probe-candidate' : transport ? 'proxy-transport-guard-candidate' : monitor ? 'disk-recovery-monitor-candidate' : recovery ? 'disk-recovery-candidate' : storage ? 'guest-capacity-fix-candidate' : network ? 'host-network-candidate' : power ? 'host-power-fix-candidate' : delivery ? 'local-test-candidate' : 'boot-capture-candidate'}/mac-arm64/MuCodeSandbox.app`);
const expectedCdHash = bridgeOwner ? '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3' : probe ? '93781410161fcf4560c244ce5469b980ffc38976' : transport ? '7395e50362e01c36299c4eacabe0cbedb636cf22' : monitor ? 'b3b92b627f33d1b810011558fa4ba0c18cddd934' : recovery ? 'e1caee59d8049dccf71e42c2e37bf62518d2d05a' : storage ? '45e0b4a3475ace48909deee9155ada564fed65a3' : network ? 'cf031a2a4bbc9d55cc8b1d97e77a935b312145d2' : power ? '4227377499a5aaeba73db3f31b821e44a5234aff' : delivery ? '26511866b6077c14947fc169a03e5496ba887a83' : 'b0cd06dd921a9ba759336fb39c8cb6e40e22fde4';
const reportFile = path.join(root, `test-results/packaged-workflow-${variant}.json`);
const reuse = process.env.MU_TEST_WORKFLOW_REUSE_ROOT;
assert.ok(!delivery || !reuse, 'Delivery acceptance requires a fresh owned VM');
if (reuse) {
  const prior = JSON.parse(await readFile(reportFile, 'utf8'));
  assert.equal(reuse, prior.retainedStoppedTestRoot, 'Only the previous owned, stopped acceptance runtime may be reused');
  assert.equal(path.dirname(reuse), homedir()); assert.match(path.basename(reuse), /^\.mu-wf-[A-Za-z0-9]+$/);
  assert.equal(await realpath(reuse), reuse); assert.equal(prior.package.cdHash, expectedCdHash);
}
const owned = reuse ?? await mkdtemp(path.join(homedir(), '.mu-wf-'));
const directory = path.join(owned, 'private'), desktopData = path.join(owned, 'desktop');
const artifacts = path.join(root, 'test-results', `packaged-workflow-${delivery ? `${variant}-` : ''}${Date.now()}`);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const runtime = new LimaRuntime(directory);
const keepFailure = process.env.MU_TEST_KEEP_FAILED_RUNTIME === '1';
const browserFixture = backupBrowserFixture('http://203.0.113.81');
const browserServer = createServer(browserFixture.handler);
await new Promise<void>(resolve => browserServer.listen(0, '127.0.0.1', resolve));
const fixture = await createClaudeLocalFixture({ browserPort: (browserServer.address() as { port: number }).port });
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), accountFree: true,
  paidModelCalls: 0, demoMode: true, firstAccountOnboardingTested: false, onboarding: [],
  scope: 'Actual latest Electron package, fresh protected VM, official browser, local interactive CLI, file grants, UI snapshots and encrypted import',
  actualSecondMacTested: false, nativeFileDialogTested: false, residentialEgressTested: false,
  desktopIntegrationTested: false, actualElectronPackageTested: true, actualVmTested: true,
  reusedTestVm: Boolean(reuse), freshVmTested: !reuse, package: { bundle }, artifactsDirectory: artifacts, stages: [], lifecycleEvents: [] };
report.deliveryPackageTested = delivery;
report.proxyTransportPackageTested = transport;
if (power) report.powerPackageTested = true;
if (network) report.hostNetworkPackageTested = true;
if (storage) report.storagePackageTested = true;
if (recovery) report.diskRecoveryPackageTested = true;
report.backgroundWindows = true;
report.terminalInputMethod = 'DOM clipboard paste into the actual xterm input, CDP key presses, actual native PTY; system clipboard and input source untouched';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let application: ElectronApplication | undefined, page: Page | undefined, current: Environment | undefined;
let transcript = '', capturing = false;
let bootProxyPort = fixture.proxyPort;
type HostProcess = { pid: number; parent: number; tty: string; command: string };
let nativeHostProcesses: HostProcess[] = [];
const errors: string[] = [];
const freeBytes = async () => { const data = await statfs(owned); return data.bavail * data.bsize; };
const guest = (args: string[], input?: string) => runtime.guest(current!, args, { input, timeoutMs: 30_000 });
const admin = (args: string[]) => runtime.management(current!, args, { timeoutMs: 30_000, maxBytes: 128_000_000 });
async function checkpoint(stage: string) {
  const hostNetwork = network && page && !page.isClosed() ? (await api('/snapshot')).system.hostNetwork : undefined;
  if (network) assert.equal(hostNetwork?.state, 'ready', 'Host network monitoring must remain healthy throughout the workflow');
  report.stages.push({ stage, at: new Date().toISOString(), freeBytes: await freeBytes(), ...(hostNetwork ? { hostNetwork } : {}) });
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(stage);
}
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Packaged workflow observation timed out'); await delay(150); }
}
async function api(endpoint: string, method = 'GET', body?: unknown): Promise<any> {
  return page!.evaluate(async ({ endpoint, method, body }) => {
    const response = await fetch(`/api${endpoint}`, { method, headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`,
      'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  }, { endpoint, method, body });
}
async function finish(job: { id: string }, timeoutMs = 950_000) {
  await until(async () => {
    assert.ok(await freeBytes() > 80 * 2 ** 30, 'Insufficient disk reserve; stopping acceptance');
    const done = (await api('/snapshot')).jobs.find((entry: any) => entry.id === job.id);
    if (done?.status === 'running') return false;
    assert.equal(done?.status, 'succeeded', done?.message); return true;
  }, timeoutMs);
}
async function action(kind: string) {
  const id = current!.id;
  await finish(await api(`/environments/${id}/actions/${kind}`, 'POST'));
  current = (await api('/snapshot')).environments.find((entry: Environment) => entry.id === id);
  assert.ok(current, 'The completed lifecycle must retain its environment');
}
async function selectEnvironment() { await page!.getByRole('button', { name: `${current!.name} Linux 沙箱`, exact: true }).click(); }
async function uiJob(pathname: string, click: () => Promise<unknown>) {
  const response = page!.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === 'POST');
  await click(); const value = await response; assert.equal(value.status(), 202); await finish(await value.json());
}
async function pasteTerminal(value: string) {
  const input = page!.locator('.xterm-helper-textarea'); await input.focus();
  await input.evaluate((node, value) => {
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', value);
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, value);
}
async function hostProcesses(): Promise<HostProcess[]> {
  return (await run('/bin/ps', ['-axo', 'pid=,ppid=,tty=,comm='])).split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), tty: match[3], command: match[4] }] : [];
  });
}
async function observeHostPty() {
  const rows = await hostProcesses(), owner = application!.process().pid!;
  const descendants = new Set([owner]); let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
  }
  nativeHostProcesses = rows.filter(row => descendants.has(row.pid) && row.tty !== '??' && /(?:^|\/)(?:limactl|ssh)$/.test(row.command));
  assert.ok(nativeHostProcesses.some(row => path.basename(row.command) === 'limactl'));
  assert.ok(nativeHostProcesses.some(row => path.basename(row.command) === 'ssh'));
  return { applicationPid: owner, processes: nativeHostProcesses };
}
async function browser(suffix: string, writes = false) {
  const baseline = browserFixture.evidence.receipts.length;
  await finish(await api(`/environments/${current!.id}/browser/open`, 'POST'));
  await until(() => application!.windows().some(window => new URL(window.url() || 'about:blank').searchParams.get('guestBrowser') === current!.id));
  const viewer = application!.windows().find(window => new URL(window.url() || 'about:blank').searchParams.get('guestBrowser') === current!.id)!;
  await viewer.getByRole('status').filter({ hasText: '已连接' }).waitFor({ timeout: 30_000 });
  await until(() => browserFixture.evidence.receipts.length > baseline);
  const receipt = browserFixture.evidence.receipts[baseline]; validateBackupBrowser(receipt);
  if (writes) { assert.equal(receipt.before.cookie, ''); assert.equal(receipt.before.localStorage, null); assert.equal(receipt.before.indexedDB, null); }
  else assert.deepEqual(receipt.before, receipt.after);
  assert.equal(browserFixture.evidence.loginRequests, reuse ? 0 : 1);
  const canvas = viewer.locator('.guest-browser-canvas canvas'); await canvas.waitFor();
  let pixels: { width: number; height: number; colors: number } | undefined;
  await until(async () => {
    pixels = await canvas.evaluate((node: HTMLCanvasElement) => {
      const data = node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data, colors = new Set<string>();
      for (let index = 0; index < data.length; index += 400) colors.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
      return { width: node.width, height: node.height, colors: colors.size };
    }); return pixels.width === 1280 && pixels.height === 800 && pixels.colors > 20;
  });
  await writeFile(path.join(artifacts, `browser-${suffix}.png`), Buffer.from((await canvas.evaluate((node:HTMLCanvasElement)=>node.toDataURL('image/png'))).split(',')[1]!, 'base64'), { mode:0o600 });
  const inspection = await api(`/environments/${current!.id}/browser/inspect`); assert.equal(inspection.matchesConfiguration, true);
  await api(`/environments/${current!.id}/browser/close`, 'POST'); await until(() => viewer.isClosed());
  return { receipt, pixels, inspection };
}
async function captureStart() {
  await admin(['sudo', 'systemd-run', '--quiet', '--unit=mu-workflow-capture', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', '/run/mu-workflow.pcap']);
  capturing = true; await delay(1000);
}
async function captureStop(suffix: string) {
  await admin(['sudo', 'systemctl', 'stop', 'mu-workflow-capture.service']); capturing = false;
  const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', '/run/mu-workflow.pcap'])).trim(), 'base64');
  assert.equal(bytes.length, Number((await admin(['sudo', 'stat', '-c', '%s', '/run/mu-workflow.pcap'])).trim()));
  assert.ok(bytes.length > 24); await writeFile(path.join(artifacts, `${suffix}.pcap`), bytes, { mode: 0o600 });
  const text = await admin(['sudo', 'tcpdump', '-nn', '-r', '/run/mu-workflow.pcap']);
  await writeFile(path.join(artifacts, `${suffix}-network.txt`), text, { mode: 0o600 });
  return decodeCapture(suffix, bytes, true);
}
async function decodeCapture(suffix:string, bytes:Buffer, requireProxy=false, proxyPort=fixture.proxyPort) {
  assert.equal((await admin(['cat','/sys/class/net/eth0/ifindex'])).trim(),'2');
  const gateway = (await admin(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+)/)![1];
  const text = await run('/usr/sbin/tcpdump',['-nn','-r',path.join(artifacts,`${suffix}.pcap`),'ifindex 2 and outbound and (ip or ip6)'],{maxBytes:128_000_000});
  const outgoing = text.split('\n').filter(line => /^\d\d:\d\d:\d\d\.\d+\s/.test(line));
  assert.ok(outgoing.length>0);
  const allowedProxy = outgoing.filter(line => line.includes(` > ${gateway}.${proxyPort}:`));
  const allowedSsh = outgoing.filter(line => line.includes(`.22 > ${gateway}.`));
  const unapproved = outgoing.filter(line => /\sIP6\s/.test(line) || !((!transport && line.includes(` > ${gateway}.${proxyPort}:`)) || line.includes(`.22 > ${gateway}.`) || /\.68 > [0-9.]+\.67:/.test(line)));
  if(requireProxy)assert.ok((transport ? allowedSsh : allowedProxy).length > 0); assert.deepEqual(unapproved, []);
  if(transport)assert.equal(allowedProxy.length,0);
  return { file:`${suffix}.pcap`, gateway, proxyPort, interfaceIndex:2, bytes: bytes.length, sha256: hash(bytes), physicalOut: outgoing.length, approvedProxy: allowedProxy.length, ...(transport ? { approvedSsh: allowedSsh.length } : {}), unapproved: unapproved.length };
}
async function firstBootCapture(suffix:string,proxyPort=fixture.proxyPort){
  const bootId=(await admin(['cat','/proc/sys/kernel/random/boot_id'])).trim();
  const capturedBootId=(await admin(['sudo','cat','/var/log/mucodesandbox/boot-network.boot-id'])).trim();
  assert.match(bootId,/^[a-f0-9-]{36}$/);assert.equal(capturedBootId,bootId,'The capture must belong to this kernel boot');
  const activeState=(await admin(['sudo','systemctl','show','--property=ActiveState','--value','mucodesandbox-boot-capture.service'])).trim();
  const subState=(await admin(['sudo','systemctl','show','--property=SubState','--value','mucodesandbox-boot-capture.service'])).trim();
  assert.equal(activeState,'active');assert.equal(subState,'exited');
  const bytes=Buffer.from((await admin(['sudo','base64','-w0','/var/log/mucodesandbox/boot-network.pcap'])).trim(),'base64');
  assert.equal(bytes.length,Number((await admin(['sudo','stat','-c','%s','/var/log/mucodesandbox/boot-network.pcap'])).trim()));
  assert.ok(bytes.length>24);await writeFile(path.join(artifacts,`${suffix}.pcap`),bytes,{mode:0o600});
  return {...await decodeCapture(suffix,bytes,false,proxyPort),bootId,capturedBootId,activeState,subState};
}
try {
  report.freeBytesBefore = await freeBytes(); assert.ok(report.freeBytesBefore > 100 * 2 ** 30);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
  report.package.cdHash = signature.match(/^CDHash=(.+)$/m)?.[1];
  assert.equal(report.package.cdHash, expectedCdHash);
  const cache = `/tmp/mu-chromium-${GUEST_CHROMIUM_VERSION}-arm64.zip`;
  assert.equal(hash(await readFile(cache)), GUEST_CHROMIUM_SHA256);
  const cacheDirectory = path.join(directory, 'tools/guest-browser'); await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await copyFile(cache, path.join(cacheDirectory, `chrome-${GUEST_CHROMIUM_VERSION}-linux-arm64.zip`));
  report.officialBrowserCacheReused = true;
  assert.ok(process.env.MU_TEST_SING_BOX_CACHE,'Provide the existing verified proxy cache to avoid repeat downloads');
  if (process.env.MU_TEST_SING_BOX_CACHE) {
    assert.equal(hash(await readFile(process.env.MU_TEST_SING_BOX_CACHE)), SING_BOX_SHA256);
    const networkCache = path.join(directory, 'tools/sing-box'); await mkdir(networkCache, { recursive: true, mode: 0o700 });
    await copyFile(process.env.MU_TEST_SING_BOX_CACHE, path.join(networkCache, SING_BOX_ARCHIVE));
    report.officialNetworkCacheReused = true;
  }
  application = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
    env: { ...process.env, MU_DATA_DIR: directory, MU_DESKTOP_USER_DATA_DIR: desktopData, MU_LIMA_PATH: process.env.MU_LIMA_PATH, MU_TEST_CLAUDE: '0' }, timeout: 60_000 });
  const events = report.lifecycleEvents;
  const child = application.process();
  child.on('exit', (code, signal) => events.push({ at: new Date().toISOString(), event: 'application-process-exit', code, signal }));
  let stderr = '';
  child.stderr?.on('data', bytes => {
    stderr = (stderr + bytes.toString()).slice(-16_384);
    report.applicationStderr = stderr.replace(/([?&]launch=)[^&\s"']+/g, '$1[REDACTED]');
  });
  const observeWindow = (window: Page) => {
    window.on('close', () => events.push({ at: new Date().toISOString(), event: 'window-close', main: window === page }));
    window.on('crash', () => events.push({ at: new Date().toISOString(), event: 'window-crash', main: window === page }));
    void application!.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) { window.webContents.setBackgroundThrottling(false); window.hide(); }
    }).catch(error => events.push({ at: new Date().toISOString(), event: 'background-window-error', message: String(error) }));
  };
  application.on('window', observeWindow);
  for (const window of application.windows()) observeWindow(window);
  page = await application.firstWindow(); await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  report.package.application = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(),
    version: app.getVersion(), pid: process.pid, sandboxDisablingArgumentsAbsent: !process.argv.some(argument => /^--(?:no-sandbox|disable-(?:gpu|renderer|setuid)-sandbox)(?:=|$)/.test(argument)),
    renderers: app.getAppMetrics().filter(metric => metric.type === 'Tab').map(metric => ({ pid: metric.pid, sandboxed: metric.sandboxed })) }));
  assert.ok(report.package.application.packaged && report.package.application.sandboxDisablingArgumentsAbsent);
  assert.equal(report.package.application.appPath, path.join(bundle, 'Contents/Resources/app'));
  assert.ok(report.package.application.renderers.length > 0 && report.package.application.renderers.every((p: any) => p.sandboxed));
  assert.equal((await api('/snapshot')).system.dataDir, directory);
  if (network) assert.equal((await api('/snapshot')).system.hostNetwork.state, 'ready');
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framereceived', event => {
    try { const value = JSON.parse(event.payload.toString()); if (value.type === 'data') transcript += value.data; } catch { /* Unrelated frames. */ }
  }));
  const config = { name: 'Latest package workflow verification', cpus: 2, memoryGiB: 2, diskGiB: 10,
    browserUrl: `http://203.0.113.81/${reuse ? 'read' : 'write'}`, identity: { timezone: 'Asia/Tokyo', locale: 'ja-JP' },
    network: { mode: 'http', host: '127.0.0.1', port: fixture.proxyPort, username: 'mu', password: 'tui-fixture', strict: true, transparent: true, noProxy: delivery ? 'localhost,127.0.0.1,::1' : '' } };
  if (reuse) {
    const previous = (await api('/snapshot')).environments; assert.equal(previous.length, 1); assert.equal(previous[0].state, 'stopped');
    bootProxyPort = previous[0].network.port;
    current = await api(`/environments/${previous[0].id}`, 'PUT', config);
  } else if (delivery) {
    await page.getByRole('button', { name: '新建环境', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: '环境名称', exact: true }).fill(config.name);
    await dialog.getByRole('spinbutton', { name: 'CPU 核心', exact: true }).fill('2');
    await dialog.getByRole('spinbutton', { name: '内存 / GB', exact: true }).fill('2');
    await dialog.getByRole('spinbutton', { name: '磁盘容量 / GiB', exact: true }).fill('10');
    await dialog.getByRole('combobox', { name: '时区', exact: true }).fill(config.identity.timezone);
    await dialog.getByRole('combobox', { name: '语言', exact: true }).selectOption(config.identity.locale);
    await dialog.getByRole('button', { name: 'HTTP 代理', exact: true }).click();
    await dialog.getByRole('textbox', { name: '代理服务器', exact: true }).fill(config.network.host);
    await dialog.getByRole('spinbutton', { name: '端口', exact: true }).fill(String(config.network.port));
    await dialog.getByRole('textbox', { name: '用户名', exact: true }).fill(config.network.username);
    await dialog.getByLabel('密码', { exact: true }).fill(config.network.password);
    await dialog.getByRole('checkbox', { name: '仅代理联网（Linux 防火墙）' }).check();
    await dialog.getByRole('button', { name: '透明代理', exact: true }).click();
    const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/environments');
    await dialog.getByRole('button', { name: '创建环境', exact: true }).click();
    const created = await response; assert.equal(created.status(), 201); current = await created.json();
    assert.equal(current!.diskGiB, 10); assert.equal(current!.memoryGiB, 2); assert.equal(current!.cpus, 2);
    assert.deepEqual(current!.identity, config.identity); assert.equal(current!.network.port, fixture.proxyPort);
    assert.equal(current!.network.strict, true); assert.equal(current!.network.transparent, true);
    report.creation = { actualUiCreate: true, diskGiB: current!.diskGiB, memoryGiB: current!.memoryGiB, cpus: current!.cpus,
      stateBeforeFirstBoot: current!.state, identity: current!.identity, strict: true, transparent: true, browserUrlSetThroughApi: true };
    // Configure the controlled test website without changing the UI-selected resources.
    current = await api(`/environments/${current!.id}`, 'PUT', config);
  } else current = await api('/environments', 'POST', config);
  await checkpoint(reuse ? 'Reusing stopped owned VM for workflow diagnosis' : 'Creating fresh protected VM through latest package'); await action('start');
  current = (await api('/snapshot')).environments.find((e: Environment) => e.id === current!.id); assert.equal(current!.state, 'running');
  const bootCapture = await firstBootCapture('first-boot',bootProxyPort);
  await assert.rejects(guest(['sudo', '-n', 'true']));
  report.firstBoot = { ...bootCapture, onlyApprovedProxySshDhcp: true, developerElevationRejected: true, reusedCapture: Boolean(reuse) };
  if (recovery) {
    await action('stop'); await selectEnvironment();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('label.field').filter({ hasText: '扩容至 / GiB' }).locator('input').fill('12');
    await uiJob(`/api/environments/${current!.id}/disk`, () => page!.getByRole('button', { name: '扩容磁盘', exact: true }).click());
    current = (await api('/snapshot')).environments.find((e: Environment) => e.id === current!.id);
    assert.equal(current!.diskGiB, 12); assert.equal(current!.state, 'stopped');
    assert.deepEqual(await api(`/environments/${current!.id}/disk`), { pending: false, targetGiB: null });
    config.diskGiB = 12;
    report.diskGrowth = { actualUiGrow: true, fromGiB: 10, toGiB: 12, stoppedAfterGrowth: true, journalCleared: true };
    await action('start'); report.growthBoot = await firstBootCapture('growth-boot');
    assert.notEqual(report.growthBoot.bootId, report.firstBoot.bootId);
    await checkpoint('Disk grown through actual UI; full workflow now runs on expanded guest');
  }
  await captureStart();
  await admin(['sudo','systemctl','restart','systemd-networkd.service']);
  assert.equal((await admin(['sudo','sha256sum','/var/log/mucodesandbox/boot-network.pcap'])).split(/\s+/)[0],(recovery ? report.growthBoot : report.firstBoot).sha256);
  assert.equal((await admin(['sudo','systemctl','show','--property=SubState','--value','mucodesandbox-boot-capture.service'])).trim(),'exited');
  report.networkdRestartPreservedBootCapture=true;
  await checkpoint('Checking official CLI and browser in bounded test VM');
  if (!(await api(`/environments/${current!.id}/agent`)).installed) await action('install-agent');
  report.client = await api(`/environments/${current!.id}/agent`); assert.equal(report.client.installed, true);
  report.browserInitial = await browser('initial', !reuse);
  fixture.restrictToLocalFixture();
  await guest(['mkdir', '-p', '/workspace/mu-claude-account-free']);
  await guest(['rm', '-rf', '/home/dev/.mu-claude-tui-account-free', MOCK_FILE, MOCK_BASH_FILE]);
  report.protectionBefore = await api(`/environments/${current!.id}/network/protection`); assert.equal(report.protectionBefore.active, true);
  assert.equal((await guest(['curl', '--fail', '--silent', '--max-time', '10', 'http://203.0.113.81/'])).trim(), 'MU_BACKUP_NETWORK_OK');
  await selectEnvironment(); await checkpoint('Actual UI file grants and path escape rejection');
  const project = path.join(owned, 'project'), outside = path.join(owned, 'outside');
  await mkdir(project, { recursive: true }); await mkdir(outside, { recursive: true }); await writeFile(path.join(project, 'fixture.txt'), 'MU_WORKFLOW_READ');
  await writeFile(path.join(outside, 'secret.txt'), 'NOT_GRANTED'); await rm(path.join(project, 'escape'), { force: true }); await symlink(outside, path.join(project, 'escape'));
  const git='/Library/Developer/CommandLineTools/usr/bin/git',gitEnv={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'};
  await run(git,['-C',project,'-c','init.templateDir=','init','-q'],{env:gitEnv});
  await run(git,['-C',project,'add','fixture.txt'],{env:gitEnv});
  await run(git,['-C',project,'-c','user.name=Mu test','-c','user.email=mu@example.invalid','commit','--no-gpg-sign','-qm','MU_WORKFLOW_FIXTURE'],{env:gitEnv});
  await page.getByRole('button', { name: '宿主授权', exact: true }).click();
  async function grant(writable: boolean) {
    await page!.getByLabel('授权的本机目录', { exact: true }).fill(project);
    await page!.locator('.segmented button').filter({ hasText: writable ? /^读写$/ : /^只读$/ }).click();
    for(const name of ['Git 状态','Git 文件差异','Git 最近提交'])assert.equal(await page!.getByRole('checkbox',{name,exact:true}).isChecked(),false);
    if(!writable)await page!.getByRole('checkbox',{name:'Git 状态',exact:true}).check();
    await uiJob(`/api/environments/${current!.id}/bridge`, () => page!.getByRole('button', { name: '授权目录', exact: true }).click());
    const grants = await api(`/environments/${current!.id}/bridge`); assert.equal(grants.length, 1); assert.equal(grants[0].guestReady, true); return grants[0];
  }
  const ro = await grant(false);
  assert.deepEqual(ro.commands,['git-status']);
  const listing=JSON.parse(await guest(['mu-host',ro.id,'list']));assert.ok(listing.some((item:any)=>item.name==='fixture.txt'));
  assert.deepEqual(JSON.parse(await guest(['mu-host',ro.id,'list'])),listing);
  const status=JSON.parse(await guest(['mu-host',ro.id,'command','git-status']));assert.equal(status.exitCode,0);assert.match(status.output,/escape/);
  await assert.rejects(guest(['mu-host',ro.id,'command','git-log']),/未授权/);
  assert.equal((await guest(['mu-host', ro.id, 'read', 'fixture.txt'])).trim(), 'MU_WORKFLOW_READ');
  await assert.rejects(guest(['mu-host', ro.id, 'write', 'denied.txt'], 'DENIED'));
  await assert.rejects(guest(['mu-host', ro.id, 'read', '../outside/secret.txt']));
  await assert.rejects(guest(['mu-host', ro.id, 'read', 'escape/secret.txt']));
  const revoked = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/bridge/${ro.id}`) && response.request().method() === 'DELETE');
  await page.getByRole('button', { name: '撤销目录授权', exact: true }).click(); await finish(await (await revoked).json());
  await assert.rejects(guest(['mu-host', ro.id, 'read', 'fixture.txt']));
  const rw = await grant(true); await guest(['mu-host', rw.id, 'write', 'result.txt'], 'MU_WORKFLOW_WRITE');
  assert.deepEqual(rw.commands,[]);await assert.rejects(guest(['mu-host',rw.id,'command','git-status']),/未授权/);
  assert.ok(JSON.parse(await guest(['mu-host',rw.id,'list'])).some((item:any)=>item.name==='result.txt'));
  assert.equal(await readFile(path.join(project, 'result.txt'), 'utf8'), 'MU_WORKFLOW_WRITE');
  report.bridge = { actualUiGrant: true, readOnlyWriteRejected: true, traversalRejected: true, symlinkRejected: true, actualUiRevoke: true, revokedAccessRejected: true, authorizedWrite: true, repeatedDirectoryListings:true, approvedGitStatus:true, unapprovedGitRejected:true, writableDoesNotApproveCommands:true };
  await checkpoint('Actual packaged terminal interactive CLI against local Messages');
  await page.getByRole('button', { name: '终端', exact: true }).click();
  await page.locator('.terminal-actions').filter({ hasText: '已连接' }).waitFor();
  await until(async () => (await page!.locator('.xterm-rows').innerText()).includes('/workspace$'));
  await page.locator('.xterm-helper-textarea').focus();
  report.terminalFocus = await page.evaluate(() => ({ documentFocused: document.hasFocus(), textareaFocused: document.activeElement?.classList.contains('xterm-helper-textarea') }));
  assert.equal(report.terminalFocus.textareaFocused, true);
  await pasteTerminal("printf 'MU_TERMINAL_INPUT_READY\\n'"); await page.keyboard.press('Enter');
  await until(() => stripVTControlCharacters(transcript).split(/\r?\n/).some(line => line.trim() === 'MU_TERMINAL_INPUT_READY'));
  report.nativeTextInputPositiveControl = true;
  await verifyClaudeTui({ page, artifacts, messages: fixture.lab.messages, output: () => transcript, guest, admin, report, inputText: pasteTerminal, observeHostPty,
    closeTerminal: async () => {
      await page!.getByRole('button', { name: '总览', exact: true }).click(); await page!.locator('.xterm').waitFor({ state: 'detached' });
      await until(async () => { const alive = await hostProcesses(); return nativeHostProcesses.every(old => !alive.some(row => row.pid === old.pid)); });
      return { actualTerminalPaneClosed: true, actualPageClosed: false, hostPtyProcessesExited: true };
    } });
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--interface', 'eth0', '--proxy', '', 'http://1.1.1.1/']));
  report.protectionAfter = await api(`/environments/${current!.id}/network/protection`);
  assert.equal(report.protectionAfter.active, true); assert.equal(report.protectionAfter.integrity, 'verified');
  for (const key of ['firewallHash', 'tunnelConfigHash']) { assert.equal(typeof report.protectionBefore[key], 'string'); assert.equal(report.protectionBefore[key], report.protectionAfter[key]); }
  report.directBypassRejected = true; report.captureOriginal = await captureStop('original');
  await action('stop'); assert.deepEqual(await api(`/environments/${current!.id}/bridge`), []);
  current = await api(`/environments/${current!.id}`, 'PUT', { ...config, browserUrl: 'http://203.0.113.81/read' });
  await action('start'); report.restartBoot=await firstBootCapture('restart-boot');
  assert.notEqual(report.restartBoot.bootId,report.firstBoot.bootId);report.browserRestarted = await browser('restarted');
  await guest(['bash', '-c', 'printf MU_SNAPSHOT_ORIGINAL > /workspace/workflow-state.txt']); await action('stop');
  await checkpoint('Actual UI snapshot creation and restore'); await selectEnvironment();
  await page.getByRole('button', { name: '快照', exact: true }).click(); await page.locator('label.field').filter({ hasText: '快照名称' }).locator('input').fill('Workflow baseline');
  await uiJob(`/api/environments/${current!.id}/snapshots`, () => page!.getByRole('button', { name: '创建快照', exact: true }).click());
  const snapshots = await api(`/environments/${current!.id}/snapshots`); const snapshot = snapshots.find((s: any) => s.name === 'Workflow baseline'); assert.ok(snapshot);
  await action('start'); await guest(['bash', '-c', 'printf MU_SNAPSHOT_CHANGED > /workspace/workflow-state.txt']); await action('stop');
  await page.getByRole('button', { name: '恢复 Workflow baseline', exact: true }).click();
  await uiJob(`/api/environments/${current!.id}/snapshots/${snapshot.id}/restore`, () => page!.getByRole('dialog').getByRole('button', { name: '恢复', exact: true }).click());
  await action('start'); assert.equal((await guest(['cat', '/workspace/workflow-state.txt'])).trim(), 'MU_SNAPSHOT_ORIGINAL');
  await assert.rejects(guest(['mu-host', rw.id, 'read', 'fixture.txt']));
  report.browserRestored = await browser('restored'); await action('stop');
  report.snapshot = { actualUiCreate: true, actualUiRestore: true, changedDiskRestored: true, previousGrantRejected: true };
  await checkpoint('Actual UI encrypted export and independent environment import');
  await page.getByRole('button', { name: '导出 Workflow baseline', exact: true }).click();
  const backup = path.join(owned, 'workflow.mu-backup'), password = 'synthetic-workflow-backup-password';
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('备份文件路径', { exact: true }).fill(backup); await dialog.getByLabel('备份密码', { exact: true }).fill(password);
  await dialog.getByLabel('确认密码', { exact: true }).fill(password);
  await uiJob(`/api/environments/${current!.id}/snapshots/${snapshot.id}/export`, () => dialog.getByRole('button', { name: '导出备份', exact: true }).click());
  const original = current!;
  await page.getByRole('button', { name: '工作区', exact: true }).click(); await page.getByRole('button', { name: '导入备份', exact: true }).click();
  dialog = page.getByRole('dialog'); await dialog.getByLabel('备份文件路径', { exact: true }).fill(backup);
  await dialog.getByLabel('备份密码', { exact: true }).fill(password); await dialog.getByLabel('新环境名称', { exact: true }).fill('Workflow imported environment');
  await uiJob('/api/backups/import', () => dialog.getByRole('button', { name: '导入备份', exact: true }).click());
  current = (await api('/snapshot')).environments.find((e: Environment) => e.id !== original.id);
  assert.ok(current); assert.deepEqual(current.mounts, []); assert.deepEqual(current.ports, []);
  if (recovery) { assert.equal(current.diskGiB, 12); report.importedDiskGiB = current.diskGiB; }
  await action('start');
  assert.notDeepEqual(await readFile(path.join(runtime.limaHome, original.instanceName, 'vz-identifier')), await readFile(path.join(runtime.limaHome, current.instanceName, 'vz-identifier')));
  report.firstBootImported=await firstBootCapture('imported-first-boot');
  assert.notEqual(report.firstBootImported.bootId,report.firstBoot.bootId);assert.notEqual(report.firstBootImported.bootId,report.restartBoot.bootId);
  assert.notEqual(report.firstBootImported.sha256,report.firstBoot.sha256);
  await captureStart(); report.browserImported = await browser('imported');
  assert.equal((await guest(['cat', '/workspace/workflow-state.txt'])).trim(), 'MU_SNAPSHOT_ORIGINAL');
  await assert.rejects(guest(['mu-host', rw.id, 'read', 'fixture.txt']));
  report.protectionImported = await api(`/environments/${current.id}/network/protection`); assert.equal(report.protectionImported.active, true);
  assert.equal(report.protectionImported.integrity, 'verified'); report.captureImported = await captureStop('imported'); await action('stop');
  report.backup = { actualUiExportImport: true, independentVmIdentity: true, noSharedMountsOrPorts: true, diskAndBrowserDataPreserved: true, oldGrantRejected: true };
  if (network) {
    const snapshot = await api('/snapshot');
    assert.equal(snapshot.system.hostNetwork.state, 'ready');
    assert.ok(snapshot.jobs.every((job: any) => job.action !== 'quarantine'));
    report.noUnintendedHostNetworkStops = true;
  }
  assert.ok(fixture.decisions.filter(d => d.localOnly && d.allowed).every(d => ['203.0.113.80:80', '203.0.113.81:80'].includes(d.destination)));
  assert.deepEqual(errors, []); report.loginRequests = browserFixture.evidence.loginRequests; report.passed = true;
  await checkpoint('All workflow observations passed; cleaning owned test resources');
} catch (error) {
  report.error = (error as Error).stack; process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (capturing) await captureStop('failure').catch(error => { report.captureError = String(error); });
  report.messages = [...fixture.lab.messages]; report.proxyDecisions = fixture.decisions; report.uiErrors = errors;
  report.browserEvidence = browserFixture.evidence;
  await writeFile(path.join(artifacts, 'terminal.ansi.txt'), transcript, { mode: 0o600 });
  // Only the private temporary runtime belongs to this verification.
  if (page && application && !page.isClosed()) {
    for (const e of (await api('/snapshot').catch(() => ({ environments: [] }))).environments) {
      await api(`/environments/${e.id}/actions/stop`, 'POST').then(job => finish(job, 120_000)).catch(error => { (report.cleanupErrors ??= []).push(String(error)); });
      if (report.passed || !keepFailure) await api(`/environments/${e.id}/actions/delete`, 'POST').then(job => finish(job, 120_000)).catch(error => { (report.cleanupErrors ??= []).push(String(error)); });
    }
  }
  await application?.close().catch(error => { (report.cleanupErrors ??= []).push(String(error)); });
  await fixture.close(); browserServer.closeAllConnections(); await new Promise<void>(resolve => browserServer.close(() => resolve()));
  try {
    for (const row of await runtime.list()) {
      if (row.status === 'Running') await runtime.command(['stop', row.name], { timeoutMs: 120_000 });
      if (report.passed || !keepFailure) await runtime.command(['delete', row.name], { timeoutMs: 120_000 });
    }
    const remaining = await runtime.list(); assert.ok(remaining.every(row => row.status === 'Stopped'));
    if (report.passed || !keepFailure) {
      assert.deepEqual(remaining, []); await rm(owned, { recursive: true }); report.testResourcesRemoved = true;
    } else { report.retainedStoppedTestRoot = owned; report.retainedInstances = remaining.map(row => ({ name: row.name, status: row.status })); }
  } catch (error) { (report.cleanupErrors ??= []).push(String(error)); report.retainedTestRoot = owned; }
  if (report.cleanupErrors?.length || report.captureError) { report.passed = false; process.exitCode = 1; }
  report.sources = Object.fromEntries(await Promise.all(['scripts/verify-packaged-workflow.ts', 'scripts/claude-local-fixture.ts', 'scripts/claude-tui-workflow.ts', 'scripts/backup-browser-fixture.ts'].map(async file => [file, hash(await readFile(path.join(root, file)))])));
  if (delivery) for (const file of Object.keys(report.sources)) await copyFile(path.join(root, file), path.join(artifacts, `source-${path.basename(file)}`));
  report.package.modules=Object.fromEntries(await Promise.all(['desktop/main.cjs','dist-server/server/manager.js','dist-server/server/runtime.js','dist-server/server/service.js','dist-server/server/protected-base.js','dist-server/server/host-bridge.js','dist-server/server/bridge-guest.js','dist-server/server/snapshots.js','dist-server/server/backups.js','dist-server/server/guest-browser.js','dist-server/server/guest-browser-runtime.js','dist-server/server/guest-browser-sandbox.js','dist-server/server/network-guard.js','dist-server/server/transparent-network.js','dist-server/shared/types.js',...(transport?['dist-server/server/proxy-transport.js']:[]),...(network?['dist-server/server/host-network.js','native/bin/mu-network-monitor']:[]),...(storage?['dist-server/server/guest-privileges.js','dist-server/server/guest-storage.js']:[]),...(recovery?['dist-server/server/disk-recovery.js','dist-server/server/guest-disk.js']:[])].map(async file=>[file,hash(await readFile(path.join(bundle,'Contents/Resources/app',file)))])));
  report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, hash(await readFile(path.join(artifacts, file)))])));
  report.finishedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  await writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({ passed: report.passed, stages: report.stages, captures: [report.captureOriginal, report.captureImported],
    testResourcesRemoved: report.testResourcesRemoved, error: report.error, cleanupErrors: report.cleanupErrors }, null, 2));
}
