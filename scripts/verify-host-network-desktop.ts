import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const bundle = path.join(root, 'release/host-network-candidate/mac-arm64/MuCodeSandbox.app');
const owned = await mkdtemp(path.join(homedir(), '.mu-network-desktop-'));
const artifacts = path.join(root, 'test-results', `host-network-desktop-${Date.now()}`);
await mkdir(artifacts, { mode: 0o700 });
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), bundle, artifactsDirectory: artifacts,
  actualElectronPackageTested: true, actualVmTested: false, actualWifiSwitchTested: false, actualHelperDeathTested: true,
  accountFree: true, paidModelCalls: 0 };
let app: ElectronApplication | undefined, page: Page | undefined;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function request(endpoint: string, body?: unknown) {
  return page!.evaluate(async ({ endpoint, body }) => {
    const response = await fetch(`/api${endpoint}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  }, { endpoint, body });
}
try {
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  report.cdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1];
  assert.equal(report.cdHash, 'cf031a2a4bbc9d55cc8b1d97e77a935b312145d2');
  app = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
    env: { ...process.env, MU_DATA_DIR: path.join(owned, 'data'), MU_DESKTOP_USER_DATA_DIR: path.join(owned, 'desktop') } });
  page = await app.firstWindow(); await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].hide(); });
  const before = (await request('/snapshot')).body;
  assert.equal(before.system.runtime.available, false); assert.equal(before.system.hostNetwork.state, 'ready');
  report.before = before;
  const created = await request('/environments', { name: 'Network monitor desktop', cpus: 1, memoryGiB: 1, diskGiB: 10,
    network: { mode: 'http', host: '127.0.0.1', port: 9, strict: true, transparent: true } });
  assert.equal(created.status, 201);
  const parent = app.process().pid!;
  const children = (await run('/bin/ps', ['-ax', '-o', 'pid=,ppid=,comm='])).split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter(match => match && Number(match[2]) === parent && match[3] === path.join(bundle, 'Contents/Resources/app/native/bin/mu-network-monitor'));
  assert.equal(children.length, 1); const pid = Number(children[0]![1]); process.kill(pid, 'SIGKILL');
  await page.getByText('电脑网络监测失效，保护环境已关闭；请重新打开应用', { exact: true }).waitFor();
  report.after = (await request('/snapshot')).body; assert.equal(report.after.system.hostNetwork.state, 'failed');
  const rejected = await request(`/environments/${created.body.id}/actions/start`, {});
  assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'HOST_NETWORK_UNAVAILABLE');
  report.rejected = rejected; assert.equal(report.after.jobs.length, 0);
  report.screenshots = [];
  for (const [name, width, height] of [['desktop', 1360, 868], ['narrow', 390, 844]] as const) {
    await app.evaluate(({ BrowserWindow }, { width, height }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(320, 400); window.setSize(width, height); window.setOpacity(0); window.showInactive();
    }, { width, height });
    await page.waitForTimeout(250);
    const bounds: { viewport: number; page: number; left: number; right: number; textLeft: number; textRight: number; scroll: number; client: number } = await page.locator('.notice-error').evaluate(node => {
      const box = node.getBoundingClientRect(), span = node.querySelector('span')!, text = span.getBoundingClientRect();
      return { viewport: innerWidth, page: document.documentElement.scrollWidth, left: box.left, right: box.right,
        textLeft: text.left, textRight: text.right, scroll: node.scrollWidth, client: node.clientWidth };
    });
    assert.equal(bounds.page, bounds.viewport); assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport);
    assert.ok(bounds.textLeft >= bounds.left && bounds.textRight <= bounds.right && bounds.scroll <= bounds.client);
    const shot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    const file = `${name}.png`; await writeFile(path.join(artifacts, file), Buffer.from(shot, 'base64'), { mode: 0o600 });
    report.screenshots.push({ file, bounds, sha256: digest(Buffer.from(shot, 'base64')) });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].hide(); });
  }
  report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  try { await app?.close(); await rm(owned, { recursive: true, force: true }); report.temporaryDataRemoved = true; }
  catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
  report.harnessSha256 = digest(await readFile(import.meta.filename)); report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'test-results/host-network-desktop.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
