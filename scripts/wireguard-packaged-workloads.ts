import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { WebSocket } from 'ws';
import type { Environment } from '../shared/types.ts';
import type { LimaRuntime } from '../server/runtime.ts';
import type { createMockMessages } from '../server/mock-messages.ts';
import { MOCK_CREDENTIAL, MOCK_FILE, MOCK_CONTENT } from '../server/mock-messages.ts';
import { shellQuote } from '../server/network-guard.ts';
import { run } from '../server/process.ts';

async function until(check: () => boolean | Promise<boolean>, milliseconds = 20_000) {
  const deadline = Date.now() + milliseconds;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'Packaged packet workload observation timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export async function verifyPackagedWireguard(options: {
  root: string; dataDir: string; artifacts: string; environment: Environment; runtime: LimaRuntime;
  fixture: { receipts: any[]; mock: ReturnType<typeof createMockMessages>; gatewayAdmin: (args: string[], input?: string) => Promise<string> };
}) {
  const { root, dataDir, artifacts, environment, runtime, fixture } = options;
  const appBundle = path.join(root, 'release/candidate/mac-arm64/MuCodeSandbox.app');
  const executable = path.join(appBundle, 'Contents/MacOS/MuCodeSandbox');
  const desktopData = await mkdtemp(path.join(homedir(), '.mu-packaged-wireguard-user-'));
  const report: Record<string, any> = { passed: false, packaged: true, accountFree: true, paidModelCalls: 0, fullClaudeTuiTested: false, startedAt: new Date().toISOString() };
  let application: ElectronApplication | undefined, main: Page | undefined, terminal: WebSocket | undefined;
  let capture = false, localOnly = false;
  const admin = (args: string[]) => runtime.management(environment, args, { timeoutMs: 30_000, maxBytes: 64_000_000 });
  async function api(endpoint: string, method = 'GET', body?: unknown): Promise<any> {
    return main!.evaluate(async ({ endpoint, method, body }) => {
      const response = await fetch(`/api${endpoint}`, { method, headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
    }, { endpoint, method, body });
  }
  const base = `/environments/${environment.id}`;
  async function finish(job: { id: string }, limit = 180_000) {
    await until(async () => {
      const result = (await api('/snapshot')).jobs.find((entry: any) => entry.id === job.id);
      if (result?.status === 'running') return false;
      assert.equal(result?.status, 'succeeded', result?.message); return true;
    }, limit);
  }
  async function openTerminal() {
    const { ticket } = await api(`${base}/terminal-ticket`, 'POST', { command: 'shell', cols: 120, rows: 35 });
    const origin = new URL(main!.url()).origin;
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/terminal?ticket=${ticket}`, { origin });
    terminal = socket;
    let output = '', connected = false;
    const errors: string[] = [];
    socket.on('error', error => errors.push(error.message));
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString());
      if (event.type === 'connected') connected = true;
      if (event.type === 'data') output += event.data;
      if (event.type === 'error') errors.push(event.data);
    });
    await until(() => { assert.deepEqual(errors, []); return connected; });
    const send = (data: string) => socket.send(JSON.stringify({ type: 'input', data }));
    send("stty -echo; printf '%s%s\\n' 'MU_PACKAGE_' 'READY'\r");
    await until(() => output.includes('MU_PACKAGE_READY'));
    return { socket, send, output: () => output, errors };
  }
  const cli = (scenario: string) => ['env', 'ANTHROPIC_BASE_URL=http://203.0.113.10', `ANTHROPIC_API_KEY=${MOCK_CREDENTIAL}`,
    'CLAUDE_CONFIG_DIR=/home/dev/.mu-claude-account-free', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'DISABLE_AUTOUPDATER=1', 'DISABLE_TELEMETRY=1', 'DISABLE_ERROR_REPORTING=1', 'API_TIMEOUT_MS=10000',
    'claude', '-p', `MU_LAB_CLAUDE_${scenario}`, '--model', 'claude-sonnet-4-5-20250929',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--max-turns', '6',
    '--tools', 'Read,Write,Bash', '--allowedTools', 'Read,Write,Bash', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--no-chrome'].map(shellQuote).join(' ');
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundle], { timeoutMs: 30_000 });
    const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', appBundle], { timeoutMs: 10_000 });
    report.signature = { cdHash: signature.match(/^CDHash=(.+)$/m)?.[1], type: signature.match(/^Signature=(.+)$/m)?.[1] };
    assert.ok(report.signature.cdHash);
    const limaPath = await runtime.executable(); assert.ok(limaPath);
    application = await electron.launch({ executablePath: executable, args: [], chromiumSandbox: true, env: { ...process.env, MU_DATA_DIR: dataDir, MU_DESKTOP_USER_DATA_DIR: desktopData, MU_LIMA_PATH: limaPath, MU_TEST_CLAUDE: '0' }, timeout: 60_000 });
    main = await application.firstWindow({ timeout: 30_000 });
    await main.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor({ timeout: 30_000 });
    report.application = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), electron: process.versions.electron, sandboxDisablingArgumentsAbsent: !process.argv.some(arg => /^--(?:no-sandbox|disable-(?:gpu|renderer|setuid)-sandbox)(?:=|$)/.test(arg)) }));
    assert.ok(report.application.packaged && report.application.sandboxDisablingArgumentsAbsent);
    const snapshot = await api('/snapshot'); assert.equal(snapshot.system.dataDir, dataDir);
    assert.equal(snapshot.environments.find((entry: any) => entry.id === environment.id)?.network.mode, 'wireguard');
    await finish(await api(`${base}/actions/start`, 'POST'));
    const before = await api(`${base}/network/protection`); assert.ok(before.active && before.policy === 'packet-tunnel');
    report.initialProtection = before;
    await admin(['sudo', 'systemd-run', '--unit=mu-wg-packaged-capture', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', '/run/mu-wg-packaged.pcap']); capture = true;
    await fixture.gatewayAdmin(['bash', '-s'], `set -eu
sudo nft -f - <<'MU_LOCAL_ONLY'
table inet mu_workload_local_only {
 counter external { }
 chain forward { type filter hook forward priority -20; policy accept;
  ip saddr 10.77.0.2 counter name external drop
  ip daddr 10.77.0.2 counter name external drop
 }
}
MU_LOCAL_ONLY
`); localOnly = true;
    const receiptIndex = fixture.receipts.length;
    await finish(await api(`${base}/browser/open`, 'POST'));
    await until(() => application!.windows().some(window => new URL(window.url() || 'about:blank').searchParams.get('guestBrowser') === environment.id));
    const viewer = application.windows().find(window => new URL(window.url() || 'about:blank').searchParams.get('guestBrowser') === environment.id)!;
    const errors: string[] = []; viewer.on('pageerror', error => errors.push(error.message));
    await viewer.getByRole('status').filter({ hasText: '已连接' }).waitFor({ timeout: 30_000 });
    await until(() => fixture.receipts.slice(receiptIndex).some(receipt => receipt.page));
    const receipt = fixture.receipts.slice(receiptIndex).find(receipt => receipt.page);
    assert.equal(receipt.tunnelSource, '10.77.0.2'); assert.match(receipt.page.platform, /^Linux /);
    assert.equal(receipt.page.timezone, 'Asia/Tokyo'); assert.equal(receipt.page.language, 'ja-JP');
    assert.deepEqual(receipt.page, receipt.worker); assert.equal(receipt.marker, 'persisted');
    report.browserIdentity = { ...receipt, canvas: `PNG data URL: ${receipt.canvas.length} characters` };
    report.inspection = await api(`${base}/browser/inspect`); assert.equal(report.inspection.matchesConfiguration, true);
    const canvas = viewer.locator('.guest-browser-canvas canvas'); await canvas.waitFor();
    let pixels: any;
    await until(async () => {
      pixels = await canvas.evaluate((node: HTMLCanvasElement) => {
        const bytes = node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data, colors = new Set<string>();
        for (let i = 0; i < bytes.length; i += 400) colors.add(`${bytes[i]},${bytes[i + 1]},${bytes[i + 2]}`);
        return { width: node.width, height: node.height, colors: colors.size };
      }); return pixels.width === 1280 && pixels.height === 800 && pixels.colors > 20;
    }); report.nonblankFrame = pixels;
    await viewer.screenshot({ path: path.join(artifacts, 'packaged-browser-desktop.png') });
    const bounds = await canvas.boundingBox(); assert.ok(bounds);
    const clickIndex = fixture.receipts.length;
    await viewer.mouse.click(bounds.x + bounds.width * .12, bounds.y + bounds.height * .60);
    await until(() => fixture.receipts.slice(clickIndex).some(receipt => receipt.clicked));
    await until(() => fixture.receipts.slice(clickIndex).some(receipt => receipt.path === '/popup'));
    const popup = fixture.receipts.slice(clickIndex).find(receipt => receipt.path === '/popup');
    assert.deepEqual(popup.page, receipt.page); assert.deepEqual(popup.worker, receipt.page);
    assert.match(popup.headers['accept-language'], /^ja-JP/);
    const popupTargets = JSON.parse(await admin(['curl', '--silent', '--max-time', '5', 'http://127.0.0.1:9222/json/list'])).filter((entry: any) => entry.type === 'page');
    assert.ok(popupTargets.length >= 2 && popupTargets.some((entry: any) => entry.url.endsWith('/popup')));
    report.nativeIdentityInNewWindow = { page: popup.page, worker: popup.worker, actualPageTargets: popupTargets.length };
    await canvas.click(); await viewer.keyboard.press('Control+l'); await viewer.waitForTimeout(200);
    const keyboardIndex = fixture.receipts.length;
    await viewer.keyboard.type('http://203.0.113.10/keyboard', { delay: 15 }); await viewer.keyboard.press('Enter');
    await until(() => fixture.receipts.slice(keyboardIndex).some(receipt => receipt.path === '/keyboard'));
    await viewer.setViewportSize({ width: 390, height: 844 });
    assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await viewer.screenshot({ path: path.join(artifacts, 'packaged-browser-mobile.png') });
    assert.deepEqual(errors, []); report.actualElectronViewer = { mouse: true, keyboard: true, mobileFits: true };
    await api(`${base}/browser/close`, 'POST'); await until(() => viewer.isClosed());
    const session = await openTerminal(), toolIndex = fixture.mock.receipts.length;
    session.send(`rm -f ${shellQuote(MOCK_FILE)}; ${cli('TOOLS')}; printf 'MU_PACKAGE_TOOLS_EXIT=%s\\n' "$?"\r`);
    await until(() => session.output().includes('MU_PACKAGE_TOOLS_EXIT='), 60_000);
    assert.match(session.output(), /MU_PACKAGE_TOOLS_EXIT=0/);
    const final = fixture.mock.receipts.slice(toolIndex).find(receipt => receipt.scenario === 'TOOLS' && receipt.emittedTool === null);
    assert.equal(final?.toolResults.length, 3); assert.ok(final!.toolResults.every(result => !result.error));
    session.send(`cat ${shellQuote(MOCK_FILE)}; whoami; python3 -c 'import json,pathlib;print("MU_PACKAGE_PROFILE="+json.loads(pathlib.Path("/home/dev/.local/share/mucodesandbox/browser/Default/Preferences").read_text())["profile"]["exit_type"])'\r`);
    await until(() => session.output().includes('MU_PACKAGE_PROFILE=Normal'));
    assert.ok(session.output().includes(MOCK_CONTENT.trim())); assert.match(session.output(), /\r?\ndev\r?\n/);
    report.actualClaudeToolsViaPackagedNativePty = { writeReadBash: true, results: 3, user: 'dev', profileExitType: 'Normal' };
    const waitIndex = fixture.mock.receipts.length;
    session.send(`${cli('WAIT')}; printf 'MU_PACKAGE_WAIT_EXIT=%s\\n' "$?"\r`);
    await until(() => fixture.mock.receipts.slice(waitIndex).some(receipt => receipt.scenario === 'WAIT') && session.output().includes('MU_REAL_CLAUDE_WAITING'));
    session.send('\x03'); await until(() => session.output().includes('MU_PACKAGE_WAIT_EXIT='));
    await until(() => fixture.mock.receipts.slice(waitIndex).filter(receipt => receipt.scenario === 'WAIT').every(receipt => receipt.disconnected));
    session.send("printf '%s%s\\n' 'MU_PACKAGE_' 'RECOVERED'\r"); await until(() => session.output().includes('MU_PACKAGE_RECOVERED'));
    assert.deepEqual(session.errors, []);
    report.ptyCtrlC = { streamClosed: true, shellUsableAfterInterrupt: true, exitCode: session.output().match(/MU_PACKAGE_WAIT_EXIT=(\d+)/)?.[1], fullTui: false };
    await writeFile(path.join(artifacts, 'packaged-terminal.txt'), session.output(), { mode: 0o600 });
    session.socket.close(); terminal = undefined;
    const after = await api(`${base}/network/protection`); assert.ok(after.active); assert.equal(after.wireguardStateHash, before.wireguardStateHash); assert.equal(after.firewallHash, before.firewallHash);
    report.finalProtection = after;
    report.externalForwardingDisabledDuringTasks = true;
    report.passed = true;
  } catch (error) { report.error = (error as Error).stack; throw error; }
  finally {
    terminal?.terminate();
    try {
      if (capture) {
        await admin(['sudo', 'systemctl', 'stop', 'mu-wg-packaged-capture.service']);
        const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', '/run/mu-wg-packaged.pcap'])).trim(), 'base64');
        assert.ok(bytes.length > 24);
        assert.equal(bytes.length, Number((await admin(['sudo', 'stat', '-c', '%s', '/run/mu-wg-packaged.pcap'])).trim()));
        assert.ok(['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(bytes.subarray(0, 4).toString('hex')));
        await writeFile(path.join(artifacts, 'packaged-workloads.pcap'), bytes, { mode: 0o600 });
        const lines = (await admin(['sudo', 'tcpdump', '-nn', '-r', '/run/mu-wg-packaged.pcap'])).split('\n').filter(line => /\seth0\s+Out\s+IP6?\s/.test(line));
        assert.ok(lines.length > 0 && lines.every(line => !/ IP6 /.test(line) && (line.includes(` > 192.168.5.2.${environment.network.port}:`) || /\.22 > 192\.168\.5\.2\./.test(line) || /\.68 > [0-9.]+\.67:/.test(line))));
        report.capture = { bytes: bytes.length, physicalOutputPackets: lines.length, onlyApprovedUdpSshDhcp: true };
      }
      if (localOnly) {
        report.externalDrops = JSON.parse(await fixture.gatewayAdmin(['sudo', 'nft', '-j', 'list', 'counter', 'inet', 'mu_workload_local_only', 'external']));
        await fixture.gatewayAdmin(['sudo', 'nft', 'delete', 'table', 'inet', 'mu_workload_local_only']);
      }
      if (main) await finish(await api(`${base}/actions/stop`, 'POST'));
    } catch (error) { report.cleanupError = (error as Error).message; report.passed = false; process.exitCode = 1; }
    await application?.close();
    await rm(desktopData, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(artifacts, 'packaged-workloads.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    assert.ok(report.passed, JSON.stringify(report));
  }
  return report;
}
