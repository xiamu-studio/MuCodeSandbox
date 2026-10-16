import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const bundle = path.join(root, 'release/normal-linux-candidate/mac-arm64/MuCodeSandbox.app');
const appRoot = path.join(bundle, 'Contents/Resources/app');
const artifacts = path.join(root, 'test-results/normal-linux');
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const owned = await mkdtemp('/tmp/mu-normal-linux-package-');
const dataDir = path.join(owned, 'data'), desktopData = path.join(owned, 'desktop');
const execute = promisify(execFile), digest = value => createHash('sha256').update(value).digest('hex');
const report = {
  passed: false, bundle, accountFree: true, paidModelCalls: 0,
  actualElectronPackageTested: true, actualVmCreated: false, actualVmStarted: false,
  scope: 'Actual 0.4.6 packaged Electron with isolated blank data; signature/build/modules/sandbox/default resources/stopped-environment UI only',
  limitations: ['Guest screen/audio/browser operation requires the separate isolated VM acceptance.', 'Fixed display controls were exercised by the no-VM noVNC fixture; matching packaged asset hashes bind that source build to this package.', 'Ad-hoc local signature is not Apple notarization.'],
};
let application;
const errors = [], apiRequests = [];
async function regularFiles(directory, prefix = '') {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) names.push(...await regularFiles(path.join(directory, entry.name), relative));
    else { assert.ok(entry.isFile(), `Unexpected compiled resource type ${relative}`); names.push(relative); }
  }
  return names.sort();
}
async function bindTree(name) {
  const source = path.join(root, name), packaged = path.join(appRoot, name);
  const files = await regularFiles(source);
  assert.deepEqual(await regularFiles(packaged), files, `${name} packaged file set must match current compiled output`);
  const bindings = {};
  for (const file of files) {
    const expected = digest(await readFile(path.join(source, file))), actual = digest(await readFile(path.join(packaged, file)));
    assert.equal(actual, expected, `Packaged ${name}/${file} differs from current compiled output`);
    bindings[file] = actual;
  }
  return bindings;
}
try {
  const verification = await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], { timeout: 30000 });
  const details = await execute('/usr/bin/codesign', ['-d', '--verbose=4', bundle], { timeout: 30000 });
  const signature = details.stdout + details.stderr;
  assert.match(signature, /Signature=adhoc/); assert.match(signature, /Format=app bundle with Mach-O thin \(arm64\)/);
  report.signature = { verified: true, deepStrict: true, adHoc: true, notarizationVerified: false, cdHash: signature.match(/^CDHash=(\S+)/m)?.[1] ?? null, verification: verification.stdout + verification.stderr };
  const currentPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const packagedPackage = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
  const currentBuild = JSON.parse(await readFile(path.join(root, 'build-info.json'), 'utf8'));
  const packagedBuild = JSON.parse(await readFile(path.join(appRoot, 'build-info.json'), 'utf8'));
  assert.equal(currentPackage.version, '0.4.6'); assert.equal(packagedPackage.version, currentPackage.version);
  assert.deepEqual(packagedBuild, currentBuild); assert.match(packagedBuild.buildId, /^[a-f0-9]{16}$/);
  report.build = packagedBuild;
  report.compiledServerBindings = await bindTree('dist-server');
  report.frontendBindings = await bindTree('dist');
  for (const name of ['browser-releases', 'browser-install-transaction', 'browser-profile-version', 'browser-profile-transaction', 'guest-browser-runtime', 'guest-browser', 'guest-audio', 'guest-display-session', 'guest-display', 'vnc-display', 'guest-hostname', 'resource-budget', 'validation', 'manager', 'service']) {
    assert.ok(report.compiledServerBindings[`server/${name}.js`], `Required module ${name} must be present and bound`);
  }
  assert.ok(report.compiledServerBindings['shared/guest-display.js']);
  assert.equal(digest(await readFile(path.join(root, 'desktop/main.cjs'))), digest(await readFile(path.join(appRoot, 'desktop/main.cjs'))));
  const releases = await import(pathToFileURL(path.join(appRoot, 'dist-server/server/browser-releases.js')).href);
  const release = releases.CURRENT_BROWSER_RELEASE;
  assert.equal(release.channel, 'stable'); assert.equal(release.format, 'deb'); assert.equal(release.version, '155.0.8059.39');
  assert.equal(release.packageVersion, '155.0.8059.39-1');
  assert.equal(release.sha256, '3556494580a71ecee15cbeb3b6ce23bf3af360bc053d90d3105241c2247da52b');
  report.bundledStableRelease = release;
  const displayChunk = Object.keys(report.frontendBindings).find(file => /^assets\/GuestBrowserView-.*\.js$/.test(file));
  assert.ok(displayChunk);
  const displayCode = await readFile(path.join(appRoot, 'dist', displayChunk), 'utf8');
  for (const feature of ['固定尺寸 · 本次浏览器会话', '原始像素 · 清晰 / 可滚动', '适合窗口 · 只缩小', '开启声音', 'guest-audio-ticket']) assert.ok(displayCode.includes(feature), `Packaged guest controls missing ${feature}`);
  report.guestControlsAsset = { path: displayChunk, sha256: report.frontendBindings[displayChunk], staticFeaturesPresent: true };

  // Keep both service and Chromium/Electron state independent from the production app.
  const permitted = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'XPC_FLAGS', 'XPC_SERVICE_NAME'];
  const launchEnvironment = Object.fromEntries(permitted.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  application = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
    env: { ...launchEnvironment, MU_DATA_DIR: dataDir, MU_DESKTOP_USER_DATA_DIR: desktopData, MU_TEST_CLAUDE: '0' }, timeout: 60000 });
  const hide = () => void application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) { window.webContents.setBackgroundThrottling(false); window.hide(); }
  }).catch(error => errors.push(String(error)));
  application.on('window', hide); hide();
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname }); });
  await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  report.application = await application.evaluate(({ app, BrowserWindow }) => ({
    packaged: app.isPackaged, appPath: app.getAppPath(), version: app.getVersion(), desktopUserData: app.getPath('userData'),
    sandboxDisablingArgumentsAbsent: !process.argv.some(argument => /^--(?:no-sandbox|disable-(?:gpu|renderer|setuid)-sandbox)(?:=|$)/.test(argument)),
    windows: BrowserWindow.getAllWindows().map(window => {
      const settings = window.webContents.getLastWebPreferences();
      return { sandbox: settings.sandbox, contextIsolation: settings.contextIsolation, nodeIntegration: settings.nodeIntegration };
    }),
    renderers: app.getAppMetrics().filter(metric => metric.type === 'Tab').map(metric => ({ pid: metric.pid, sandboxed: metric.sandboxed })),
  }));
  assert.ok(report.application.packaged && report.application.sandboxDisablingArgumentsAbsent);
  assert.equal(report.application.appPath, appRoot); assert.equal(report.application.version, '0.4.6'); assert.equal(report.application.desktopUserData, desktopData);
  assert.ok(report.application.windows.length > 0 && report.application.windows.every(window => window.sandbox && window.contextIsolation && !window.nodeIntegration));
  assert.ok(report.application.renderers.length > 0 && report.application.renderers.every(renderer => renderer.sandboxed));
  const snapshot = () => page.evaluate(async () => {
    const response = await fetch('/api/snapshot', { headers: { Authorization: `Bearer ${window.__MU_CONFIG__.token}` } });
    if (!response.ok) throw Error('Candidate snapshot request failed'); return response.json();
  });
  const initial = await snapshot();
  assert.equal(initial.system.dataDir, dataDir); assert.equal(initial.system.version, '0.4.6'); assert.equal(initial.environments.length, 0);
  assert.equal(initial.system.application.buildId, packagedBuild.buildId);
  assert.equal(initial.system.application.builtAt, packagedBuild.builtAt);
  assert.equal(initial.system.application.channel, 'desktop-test');
  report.service = { origin: new URL(page.url()).origin, version: initial.system.version, dataDir: initial.system.dataDir, application: initial.system.application };

  await page.getByRole('button', { name: '新建环境', exact: true }).first().click();
  assert.equal(await page.getByRole('spinbutton', { name: 'CPU 核心', exact: true }).inputValue(), '4');
  assert.equal(await page.getByRole('spinbutton', { name: '内存 / GB', exact: true }).inputValue(), '4');
  await page.getByRole('textbox', { name: '环境名称', exact: true }).fill('0.4.6 候选包空白数据验收');
  await page.getByRole('button', { name: '创建环境', exact: true }).click();
  await page.getByRole('heading', { name: '0.4.6 候选包空白数据验收', exact: true }).waitFor();
  const created = await snapshot();
  assert.equal(created.environments.length, 1);
  const environment = created.environments[0];
  assert.equal(environment.cpus, 4); assert.equal(environment.memoryGiB, 4); assert.equal(environment.kind, 'vm');
  assert.equal(environment.state, 'not_created'); assert.equal(environment.browserRunning, false);
  report.environment = { id: environment.id, name: environment.name, cpus: environment.cpus, memoryGiB: environment.memoryGiB, state: environment.state, browserRunning: environment.browserRunning };
  await page.getByRole('button', { name: '浏览器', exact: true }).click();
  const versionHeading = page.getByRole('heading', { name: '浏览器版本', exact: true });
  await versionHeading.waitFor();
  for (const label of ['更新浏览器', '恢复浏览器', '检测浏览器版本', '重置浏览器资料', '打开浏览器']) assert.equal(await page.getByRole('button', { name: label, exact: true }).isDisabled(), true, `${label} must be disabled before VM startup`);
  await versionHeading.evaluate(node => node.closest('section').scrollIntoView({ block: 'center' }));
  report.versionLayout = await versionHeading.evaluate(node => {
    const section = node.closest('section'), bounds = section.getBoundingClientRect();
    const buttons = [...section.querySelectorAll('.button-row button')].map(button => {
      const box = button.getBoundingClientRect(); return { label: button.textContent.trim(), disabled: button.disabled, left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    });
    return { text: section.innerText, bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }, buttons, documentHasNoHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth };
  });
  assert.equal(report.versionLayout.buttons.length, 2); assert.ok(report.versionLayout.documentHasNoHorizontalOverflow);
  for (const button of report.versionLayout.buttons) assert.ok(button.disabled && button.width > 70 && button.height >= 25 && button.left >= report.versionLayout.bounds.left && button.right <= report.versionLayout.bounds.right && button.bottom <= report.versionLayout.bounds.bottom);
  const [update, recover] = report.versionLayout.buttons; assert.ok(update.right <= recover.left || update.bottom <= recover.top);
  const screenshot = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setOpacity(0); window.showInactive();
    try {
      await new Promise(resolve => setTimeout(resolve, 180));
      const image = await Promise.race([window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }), new Promise((_, reject) => setTimeout(() => reject(Error('Native candidate capture timed out')), 15000))]);
      const bitmap = image.getBitmap(), colors = new Set();
      for (let offset = 0; offset < bitmap.length; offset += 4) colors.add(bitmap.readUInt32LE(offset));
      return { png: image.toPNG().toString('base64'), size: image.getSize(), distinctColors: colors.size };
    } finally { window.hide(); window.setOpacity(1); }
  });
  assert.ok(screenshot.size.width > 300 && screenshot.size.height > 300 && screenshot.distinctColors > 32);
  await writeFile(path.join(artifacts, 'package-version-ui.png'), Buffer.from(screenshot.png, 'base64'), { mode: 0o600 });
  report.screenshot = { path: 'test-results/normal-linux/package-version-ui.png', size: screenshot.size, distinctColors: screenshot.distinctColors, method: 'Native transparent inactive-window capture' };
  const final = await snapshot();
  assert.equal(final.environments.length, 1); assert.equal(final.environments[0].state, 'not_created');
  assert.equal(final.jobs.length, 0); assert.equal(final.system.dataDir, dataDir);
  assert.ok(!apiRequests.some(request => /\/actions\/(?:start|restart)|\/browser\/open|guest-(?:browser|audio)-ticket/.test(request.path)));
  report.apiRequests = apiRequests;
  const fixedFixture = JSON.parse(await readFile(path.join(root, 'test-results/fixed-display/ui.json'), 'utf8'));
  assert.equal(fixedFixture.passed, true); assert.equal(fixedFixture.fixtureOnly, true);
  report.fixedDisplayFixture = { passed: true, source: 'test-results/fixed-display/ui.json', fixtureOnly: true, checks: fixedFixture.checked };
  assert.deepEqual(errors, []); report.errors = errors; report.passed = true;
} catch (error) {
  report.error = error.stack ?? String(error); report.errors = errors; report.apiRequests = apiRequests; process.exitCode = 1;
} finally {
  if (application) await application.close();
  await rm(owned, { recursive: true, force: true });
  report.testResourcesRemoved = true;
  await writeFile(path.join(artifacts, 'package.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, version: report.application?.version, buildId: report.build?.buildId, sandboxed: report.application?.renderers, receipt: 'test-results/normal-linux/package.json', error: report.error ?? null }, null, 2));
}
