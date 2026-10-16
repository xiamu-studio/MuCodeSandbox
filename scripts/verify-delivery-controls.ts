import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const power = process.argv.includes('--power');
const bundle = path.join(root, `release/${power ? 'host-power-fix-candidate' : 'local-test-candidate'}/mac-arm64/MuCodeSandbox.app`);
const baseline = path.join(root, `release/${power ? 'local-test-candidate' : 'boot-capture-candidate'}/mac-arm64/MuCodeSandbox.app`);
const appRoot = path.join(bundle, 'Contents/Resources/app');
const baselineRoot = path.join(baseline, 'Contents/Resources/app');
const owned = await mkdtemp(path.join(homedir(), '.mu-delivery-ui-'));
const artifacts = path.join(root, 'test-results', `delivery-controls-${power ? 'power-' : ''}${Date.now()}`);
await mkdir(artifacts, { mode: 0o700 });
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), bundle,
  baseline, artifacts, accountFree: true, paidModelCalls: 0, actualVmTested: false,
  scope: 'Actual packaged Electron configuration persistence, layout, input rejection and backend byte comparison; no VM or public network acceptance' };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let app: ElectronApplication | undefined, page: Page | undefined;
const errors: string[] = [];
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(file));
    else if (entry.isFile()) result.push(file);
  }
  return result.sort();
}
async function launch() {
  app = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'),
    args: [], chromiumSandbox: true, timeout: 60_000,
    env: { ...process.env, MU_DATA_DIR: path.join(owned, 'data'), MU_DESKTOP_USER_DATA_DIR: path.join(owned, 'desktop'), MU_DESKTOP_BACKGROUND: '1', MU_TEST_CLAUDE: '0' } });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, path: app.getAppPath(),
    renderers: app.getAppMetrics().filter(metric => metric.type === 'Tab').map(metric => metric.sandboxed),
    unsafeArguments: process.argv.filter(arg => /^--(?:no-sandbox|disable-(?:gpu|renderer|setuid)-sandbox)/.test(arg)) }));
  assert.equal(identity.packaged, true); assert.equal(identity.path, appRoot);
  assert.ok(identity.renderers.length > 0 && identity.renderers.every(Boolean));
  assert.deepEqual(identity.unsafeArguments, []); report.application = identity;
}
async function snapshot() {
  return page!.evaluate(async () => {
    const response = await fetch('/api/snapshot', { headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}` } });
    if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`);
    return response.json();
  });
}
async function save() {
  const response = page!.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname.includes('/api/environments/'));
  await page!.getByRole('button', { name: '保存', exact: true }).click();
  return response;
}
async function screenshot(name: string) {
  const result = await app!.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setOpacity(0); window.showInactive();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise(resolve => setTimeout(resolve, 150));
      const capture = await Promise.race([window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Capture timed out')), 15_000); })]);
      return { png: capture.toPNG().toString('base64'), width: capture.getSize().width, height: capture.getSize().height };
    } finally { clearTimeout(timer); window.hide(); window.setOpacity(1); }
  });
  await writeFile(path.join(artifacts, `${name}.png`), Buffer.from(result.png, 'base64'));
  return { width: result.width, height: result.height };
}
try {
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
  assert.match(signature, /Signature=adhoc/); report.cdHash = signature.match(/^CDHash=(.+)$/m)?.[1];
  assert.equal(report.cdHash, power ? '4227377499a5aaeba73db3f31b821e44a5234aff' : '26511866b6077c14947fc169a03e5496ba887a83');
  const prior = await run('/usr/bin/codesign', ['-d', '--verbose=4', baseline]);
  assert.equal(prior.match(/^CDHash=(.+)$/m)?.[1], power ? '26511866b6077c14947fc169a03e5496ba887a83' : 'b0cd06dd921a9ba759336fb39c8cb6e40e22fde4');
  const changed = power ? ['desktop/main.cjs', 'dist-server/server/manager.js', 'dist-server/server/host-bridge.js', 'dist-server/server/bridge-guest.js'] : [];
  report.changedComponents = [];
  report.unchangedComponents = [];
  for (const directory of ['dist-server', 'desktop', 'native/bin']) {
    const current = await files(path.join(appRoot, directory));
    const previous = await files(path.join(baselineRoot, directory));
    const relative = current.map(file => path.relative(appRoot, file));
    assert.deepEqual(relative, previous.map(file => path.relative(baselineRoot, file)));
    for (const file of relative) {
      const sha256 = digest(await readFile(path.join(appRoot, file)));
      const previous = digest(await readFile(path.join(baselineRoot, file)));
      if (changed.includes(file)) {
        assert.notEqual(sha256, previous); assert.equal(sha256, digest(await readFile(path.join(root, file))));
        report.changedComponents.push({ file, sha256, previous });
      } else {
        assert.equal(sha256, previous, `Backend changed: ${file}`);
        report.unchangedComponents.push({ file, sha256 });
      }
    }
  }
  report.frontend = [];
  assert.deepEqual(report.changedComponents.map((row: any) => row.file).sort(), changed.sort());
  for (const file of await files(path.join(appRoot, 'dist'))) {
    const relative = path.relative(appRoot, file), sha256 = digest(await readFile(file));
    if (power) assert.equal(sha256, digest(await readFile(path.join(baselineRoot, relative))));
    report.frontend.push({ file: relative, sha256 });
  }
  await copyFile(import.meta.filename, path.join(artifacts, 'harness.ts'));
  await launch();
  assert.equal((await snapshot()).system.dataDir, path.join(owned, 'data'));
  assert.deepEqual((await snapshot()).environments, []);
  await page!.getByRole('button', { name: '新建环境', exact: true }).first().click();
  await page!.getByRole('textbox', { name: '环境名称', exact: true }).fill('本机交付配置验收');
  await page!.getByRole('spinbutton', { name: '磁盘容量 / GiB', exact: true }).fill('9');
  await page!.getByRole('button', { name: '创建环境', exact: true }).click();
  assert.deepEqual((await snapshot()).environments, []); report.invalidDiskRejected = true;
  await page!.getByRole('spinbutton', { name: '磁盘容量 / GiB', exact: true }).fill('20');
  await page!.getByRole('button', { name: '创建环境', exact: true }).click();
  await page!.getByRole('heading', { name: '本机交付配置验收', exact: true }).waitFor();
  const created = (await snapshot()).environments[0];
  assert.equal(created.diskGiB, 20); assert.equal(created.state, 'not_created'); report.environmentId = created.id;
  await page!.getByRole('button', { name: '网络', exact: true }).click();
  await page!.getByRole('button', { name: 'HTTP 代理', exact: true }).click();
  await page!.getByRole('textbox', { name: '代理服务器', exact: true }).fill('127.0.0.1');
  await page!.getByRole('checkbox', { name: '仅代理联网（Linux 防火墙）' }).check();
  await page!.getByRole('button', { name: '透明代理', exact: true }).click();
  const dns = { address: '9.9.9.9', serverName: 'dns.quad9.net', port: 8443, path: '/custom/dns-query' };
  await page!.getByRole('textbox', { name: 'DNS 服务地址', exact: true }).fill(dns.address);
  await page!.getByRole('textbox', { name: 'TLS 服务名称', exact: true }).fill(dns.serverName);
  await page!.getByRole('spinbutton', { name: 'DNS 端口', exact: true }).fill(String(dns.port));
  await page!.getByRole('textbox', { name: 'DNS 请求路径', exact: true }).fill(dns.path);
  assert.equal((await save()).status(), 200);
  await page!.getByText('网络配置已保存', { exact: true }).waitFor();
  assert.deepEqual((await snapshot()).environments[0].network.dns, dns);
  await page!.getByRole('textbox', { name: 'DNS 请求路径', exact: true }).fill('/dns-query?unsafe=1');
  assert.equal((await save()).status(), 400, 'Unsafe DNS path must be rejected by packaged backend');
  assert.deepEqual((await snapshot()).environments[0].network.dns, dns); report.invalidDnsPathRejected = true;
  await page!.getByRole('textbox', { name: 'DNS 请求路径', exact: true }).fill(dns.path);
  assert.equal((await save()).status(), 200);
  report.desktopScreenshot = await screenshot('desktop-network');
  await page!.getByRole('button', { name: '设置', exact: true }).click();
  await page!.getByRole('combobox', { name: '时区', exact: true }).fill('Asia/Tokyo');
  assert.equal((await save()).status(), 200);
  await page!.getByText('环境设置已保存', { exact: true }).waitFor();
  assert.deepEqual((await snapshot()).environments[0].network.dns, dns);
  await app!.close(); app = undefined;
  await launch();
  await page!.getByRole('button', { name: '本机交付配置验收 Linux 沙箱', exact: true }).click();
  await page!.getByRole('button', { name: '网络', exact: true }).click();
  const restored = (await snapshot()).environments[0];
  assert.equal(restored.diskGiB, 20); assert.equal(restored.identity.timezone, 'Asia/Tokyo');
  assert.deepEqual(restored.network.dns, dns); assert.equal(restored.network.strict, true); assert.equal(restored.network.transparent, true);
  assert.equal(await page!.getByRole('spinbutton', { name: 'DNS 端口', exact: true }).inputValue(), '8443');
  assert.equal(await page!.getByRole('textbox', { name: 'DNS 请求路径', exact: true }).inputValue(), dns.path);
  report.exitAndReopenPersistent = true;
  await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setMinimumSize(320, 480); BrowserWindow.getAllWindows()[0].setSize(390, 844); });
  await page!.waitForFunction(() => window.innerWidth === 390);
  assert.ok(await page!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  report.mobileScreenshot = await screenshot('mobile-network');
  await page!.getByRole('button', { name: '新建环境', exact: true }).click();
  const modal = await page!.getByRole('dialog').boundingBox();
  assert.ok(modal && modal.x >= 0 && modal.x + modal.width <= 390);
  report.mobileCreateScreenshot = await screenshot('mobile-create');
  await page!.getByRole('button', { name: '关闭', exact: true }).click();
  report.noRuntimeJobs = (await snapshot()).jobs.length === 0; assert.equal(report.noRuntimeJobs, true);
  assert.deepEqual(errors, []); report.browserErrors = errors;
  report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  try { if (app) await app.close(); await rm(owned, { recursive: true, force: true }); report.temporaryDataRemoved = true; }
  catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, `test-results/delivery-controls-${power ? 'power' : 'packaged'}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
