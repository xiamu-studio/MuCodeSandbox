import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createService } from '../server/service.ts';
import { MOCK_FILE, MOCK_BASH_FILE } from '../server/mock-messages.ts';
import { verifyClaudeTui } from './claude-tui-workflow.ts';
import { createClaudeLocalFixture } from './claude-local-fixture.ts';
import type { Environment, Job } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const directory = process.env.MU_TUI_TEST_DATA ?? await mkdtemp(path.join(homedir(), '.mu-tui-verification-'));
assert.equal(path.dirname(directory), homedir()); assert.ok(path.basename(directory).startsWith('.mu-tui-verification-'));
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const artifacts = path.join(root, 'test-results', 'claude-tui');
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const service = await createService({ rootDir: root, dataDir: directory, port: 0 });
const manager = service.manager, fixture = await createClaudeLocalFixture();
const { lab, proxyPort, decisions } = fixture;
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), accountFree: true, paidModelCalls: 0,
  scope: 'Real interactive Linux Claude Code in production web terminal, local Messages fixture; documented demo mode skips onboarding; no provider account or packaged Electron UI',
  firstAccountOnboardingTested: false, demoMode: true, onboarding: [] };
let capture = false, e: Environment | undefined, browser: Browser | undefined, page: Page | undefined, transcript = '';
const errors: string[] = [];
const live = () => manager.store.get(e!.id);
const guest = (args: string[]) => manager.runtime.guest(live(), args, { timeoutMs: 30_000 });
const admin = (args: string[], input?: string) => manager.runtime.management(live(), args, { input, timeoutMs: 30_000, maxBytes: 128_000_000 });
async function finish(job: Job) {
  await manager.tasks.get(job.id)?.promise;
  const done = manager.store.jobs().find(j => j.id === job.id)!; assert.equal(done.status, 'succeeded', done.message);
}
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { assert.ok(Date.now() < deadline, 'TUI observation timed out'); await delay(100); }
}
const screen = () => page!.locator('.xterm-rows').innerText();
async function snapshot(name: string) {
  await writeFile(path.join(artifacts, `${name}.txt`), await screen(), { mode: 0o600 });
  await page!.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true });
}
async function stopCapture() {
  if (!capture) return; capture = false;
  await admin(['sudo', 'systemctl', 'stop', 'mu-tui-capture.service']);
  const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', '/run/mu-tui.pcap'])).trim(), 'base64');
  assert.equal(bytes.length, Number((await admin(['sudo', 'stat', '-c', '%s', '/run/mu-tui.pcap'])).trim()));
  assert.ok(bytes.length > 24); await writeFile(path.join(artifacts, 'network.pcap'), bytes, { mode: 0o600 });
  const text = await admin(['sudo', 'tcpdump', '-nn', '-r', '/run/mu-tui.pcap']);
  await writeFile(path.join(artifacts, 'network.txt'), text, { mode: 0o600 });
  const gateway = (await admin(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+)/)![1];
  const outgoing = text.split('\n').filter(line => /\seth0\s+Out\s+IP6?\s/.test(line));
  const approvedProxy = outgoing.filter(line => line.includes(` > ${gateway}.${proxyPort}:`));
  const unapproved = outgoing.filter(line => /\sIP6\s/.test(line) || !(line.includes(` > ${gateway}.${proxyPort}:`) || (line.includes(`.22 > ${gateway}.`) && /:\s/.test(line)) || /\.68 > [0-9.]+\.67:/.test(line)));
  report.capture = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), physicalOut: outgoing.length,
    approvedProxy: approvedProxy.length, unapproved: unapproved.length, proxyEndpoint: `${gateway}:${proxyPort}` };
  assert.ok(approvedProxy.length > 0); assert.deepEqual(unapproved, []);
}
try {
  e = manager.store.list()[0];
  report.reusedTestVm = Boolean(e);
  if (e) {
    await manager.reconcile();
    if (live().state === 'running') await finish(await manager.lifecycle(e.id, 'stop'));
    e = await manager.update(e.id, { name: e.name, cpus: e.cpus, memoryGiB: e.memoryGiB, diskGiB: e.diskGiB,
      identity: e.identity, network: { ...e.network, port: proxyPort } });
  } else e = await manager.create({ name: 'Claude interactive account-free verification', cpus: 2, memoryGiB: 2, diskGiB: 10,
    identity: { timezone: 'UTC', locale: 'en-US' }, network: { mode: 'http', host: '127.0.0.1', port: proxyPort,
      username: 'mu', password: 'tui-fixture', strict: true, transparent: true, noProxy: '' } });
  console.log('Starting isolated VM and installing the actual CLI.');
  await finish(await manager.lifecycle(e.id, 'start'));
  if (!(await manager.runtime.agentStatus(live())).installed) await finish(await manager.lifecycle(e.id, 'install-agent'));
  report.client = await manager.runtime.agentStatus(live());
  report.client.executableSha256 = (await guest(['sha256sum', '/home/dev/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'])).split(/\s/)[0];
  fixture.restrictToLocalFixture();
  await guest(['mkdir', '-p', '/workspace/mu-claude-account-free']); await guest(['rm', '-f', MOCK_FILE, MOCK_BASH_FILE]);
  report.protectionBefore = await manager.runtime.networkProtection(live()); assert.equal(report.protectionBefore.active, true);
  report.physicalInterfaceIndex = JSON.parse(await admin(['ip', '-j', 'link', 'show', 'eth0']))[0].ifindex;
  await admin(['bash', '-s'], 'set -eu\nsudo systemd-run --quiet --unit=mu-tui-capture /usr/bin/tcpdump --immediate-mode -ni any -Q out -U -s 128 -w /run/mu-tui.pcap\nsleep 1\n'); capture = true;
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framereceived', event => {
    try { const value = JSON.parse(event.payload.toString()); if (value.type === 'data') transcript += value.data; } catch { /* Ignore non-terminal frames. */ }
  }));
  await page.goto(service.launchUrl());
  await page.getByRole('button', { name: `${e.name} Linux 沙箱` }).click();
  await page.getByRole('button', { name: '终端', exact: true }).click();
  await page.getByText('已连接', { exact: false }).waitFor();
  await until(async () => (await screen()).includes('/workspace'));
  console.log('Opening actual interactive CLI with normal tool permissions.');
  await verifyClaudeTui({ page, artifacts, messages: lab.messages, output: () => transcript, guest, admin, report,
    closeTerminal: async () => {
      await page!.close(); await until(() => !service.terminal.children.has(e!.id));
      return { actualPageClosed: true, hostPtyRemoved: true };
    } });
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--interface', 'eth0', '--proxy', '', 'http://1.1.1.1/']));
  report.directBypassRejected = true;
  report.protectionAfter = await manager.runtime.networkProtection(live()); assert.equal(report.protectionAfter.active, true);
  assert.equal(report.protectionAfter.firewallHash, report.protectionBefore.firewallHash);
  assert.equal(report.protectionAfter.tunnelConfigHash, report.protectionBefore.tunnelConfigHash);
  assert.ok(decisions.filter(d => d.localOnly && d.allowed).every(d => d.destination === '203.0.113.80:80'));
  assert.deepEqual(errors, []); await stopCapture(); report.passed = true;
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; await snapshot('failure').catch(() => {}); }
finally {
  await writeFile(path.join(artifacts, 'terminal.ansi.txt'), transcript, { mode: 0o600 });
  await browser?.close();
  if (capture) await stopCapture().catch(error => { report.captureError = String(error); report.passed = false; });
  report.messages = [...lab.messages]; report.proxyDecisions = decisions; report.uiErrors = errors;
  if (e) await manager.lifecycle(e.id, 'stop').then(finish).catch(error => { report.cleanupError = String(error); });
  if (report.passed && e && !report.cleanupError) await manager.lifecycle(e.id, 'delete').then(finish).catch(error => { report.cleanupError = String(error); });
  await service.close(); await fixture.close();
  if (report.cleanupError || report.captureError) { report.passed = false; process.exitCode = 1; }
  if (report.passed) { await rm(directory, { recursive: true, force: true }); report.testDataRemoved = true; }
  else report.retainedDataDir = directory;
  report.finishedAt = new Date().toISOString();
  report.sources = Object.fromEntries(await Promise.all(['scripts/verify-claude-tui.ts', 'scripts/claude-tui-workflow.ts', 'scripts/claude-local-fixture.ts', 'server/mock-messages.ts', 'server/terminal.ts', 'src/TerminalPanel.tsx'].map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
  report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, createHash('sha256').update(await readFile(path.join(artifacts, file))).digest('hex')])));
  await writeFile(path.join(root, 'test-results', 'claude-tui.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, client: report.client, permissions: report.permissions, cancellation: report.cancellation,
    reopen: report.reopen, capture: report.capture, error: report.error, retainedDataDir: report.retainedDataDir }, null, 2));
}
