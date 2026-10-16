import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Page } from '@playwright/test';
import { createService } from '../server/service.ts';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(homedir(), '.mu-https-ui-'));
const results = path.join(root, 'test-results');
await mkdir(results, { recursive: true });
await promisify(execFile)('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Mu UI Fixture CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', path.join(temporary, 'ca.key'), '-out', path.join(temporary, 'ca.pem')]);
const certificate = (await readFile(path.join(temporary, 'ca.pem'), 'utf8')).trim();
const service = await createService({ rootDir: root, dataDir: path.join(temporary, 'data'), port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors: string[] = [];
const responseErrors: { path: string; status: number }[] = [];
const edits: unknown[] = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/api/')) responseErrors.push({ path: new URL(response.url()).pathname, status: response.status() }); });
page.on('request', request => { if (request.method() === 'PUT') edits.push(request.postDataJSON()); });

async function save(id: string) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === `/api/environments/${id}` && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal((await response).status(), 200);
}

async function fits(target: Page) {
  assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'network form must fit the viewport');
}

try {
  const environment = await service.manager.create({ name: 'HTTPS 配置验收', kind: 'vm', network: { mode: 'http', host: '127.0.0.1', port: 8181, username: 'synthetic-user', password: 'synthetic-password', noProxy: 'localhost,127.0.0.1', strict: false, transparent: false } });
  await page.goto(service.launchUrl());
  await page.getByRole('button', { name: 'HTTPS 配置验收 Linux 沙箱' }).click();
  await page.getByRole('button', { name: '网络', exact: true }).click();
  await page.getByRole('button', { name: 'HTTPS 代理', exact: true }).click();
  const strict = page.getByRole('checkbox', { name: '仅代理联网（Linux 防火墙）' });
  assert.ok(await strict.isChecked());
  assert.ok(await strict.isDisabled());
  assert.ok(await page.getByRole('button', { name: '应用代理', exact: true }).isDisabled());
  assert.match(await page.getByRole('button', { name: '透明代理', exact: true }).getAttribute('class') ?? '', /selected/);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('请填写代理证书的服务器名称。', { exact: true }).waitFor();
  assert.equal(edits.length, 0, 'missing certificate name must be rejected before sending the form');
  await page.getByRole('textbox', { name: '代理证书服务器名称', exact: true }).fill('proxy.fixture.test');
  await save(environment.id);
  let stored = service.manager.store.get(environment.id);
  assert.equal(stored.network.mode, 'https');
  assert.equal(stored.network.password, 'synthetic-password');
  assert.equal(stored.network.username, 'synthetic-user');
  assert.deepEqual(stored.network.tls, { serverName: 'proxy.fixture.test' });
  assert.ok(stored.network.strict && stored.network.transparent);
  const trustedCA = page.getByRole('textbox', { name: '自定义可信 CA 证书（可选）', exact: true });
  assert.equal(await trustedCA.getAttribute('maxlength'), '16384');
  await trustedCA.fill(certificate);
  await save(environment.id);
  assert.equal(service.manager.store.get(environment.id).network.tls?.certificate, certificate);
  await page.screenshot({ path: path.join(results, 'https-network-desktop.png'), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await fits(page);
    await page.screenshot({ path: path.join(results, `https-network-mobile-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  await page.getByRole('button', { name: 'HTTPS 配置验收 Linux 沙箱' }).click();
  await page.getByRole('button', { name: '网络', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '代理证书服务器名称', exact: true }).inputValue(), 'proxy.fixture.test');
  assert.equal(await trustedCA.inputValue(), certificate);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await save(environment.id);
  stored = service.manager.store.get(environment.id);
  assert.deepEqual(stored.network.tls, { serverName: 'proxy.fixture.test', certificate });
  assert.equal(stored.network.password, 'synthetic-password');
  await page.getByRole('button', { name: '项目目录', exact: true }).click();
  await save(environment.id);
  assert.deepEqual(service.manager.store.get(environment.id).network.tls, stored.network.tls);
  await page.getByRole('button', { name: '网络', exact: true }).click();
  for (const mode of ['socks5', 'http', 'direct'] as const) {
    const label = { socks5: 'SOCKS5 代理', http: 'HTTP 代理', direct: '直连' }[mode];
    await page.getByRole('button', { name: label, exact: true }).click();
    await save(environment.id);
    stored = service.manager.store.get(environment.id);
    assert.equal(stored.network.mode, mode);
    assert.equal(stored.network.tls, undefined);
    assert.equal(stored.network.password, 'synthetic-password');
  }
  assert.ok(!stored.network.strict && !stored.network.transparent);
  await page.getByRole('button', { name: '新建环境', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '环境名称', exact: true }).fill('HTTPS 创建验收');
  await dialog.getByRole('button', { name: 'HTTPS 代理', exact: true }).click();
  await dialog.getByRole('textbox', { name: '代理服务器', exact: true }).fill('127.0.0.1');
  await dialog.getByRole('textbox', { name: '代理证书服务器名称', exact: true }).fill('proxy.fixture.test');
  await dialog.getByRole('button', { name: /^本机浏览器/ }).click();
  await dialog.getByText('HTTPS 加密代理需要 Linux 沙箱，请切换环境类型或网络模式。', { exact: true }).waitFor();
  assert.ok(await dialog.getByRole('button', { name: 'HTTPS 代理', exact: true }).isDisabled());
  assert.ok(await dialog.getByRole('button', { name: '创建环境', exact: true }).isDisabled());
  await page.setViewportSize({ width: 390, height: 844 });
  await fits(page);
  await page.screenshot({ path: path.join(results, 'https-native-precondition-mobile.png'), fullPage: true });
  await dialog.getByRole('button', { name: /^Linux 沙箱/ }).click();
  assert.ok(await dialog.getByRole('button', { name: '创建环境', exact: true }).isEnabled());
  await dialog.getByRole('button', { name: '创建环境', exact: true }).click();
  await page.getByRole('heading', { name: 'HTTPS 创建验收', exact: true }).waitFor();
  const created = service.manager.store.list().find(environment => environment.name === 'HTTPS 创建验收')!;
  assert.equal(created.network.mode, 'https');
  assert.ok(created.network.strict && created.network.transparent);
  assert.ok(service.manager.store.list().every(environment => environment.state === 'not_created'));
  assert.deepEqual(errors, []);
  assert.deepEqual(responseErrors, []);
  const report = { passed: true, scope: 'Local UI and real configuration API only; no VM boot, proxy TLS connection or Claude account', viewports: ['1440x960', '390x844', '320x844'], checks: ['HTTPS enables and locks strict transparent policy', 'required certificate name', 'public CA defaults', 'custom CA save and reload', 'other settings retain TLS configuration', 'proxy password retained', 'HTTP SOCKS5 direct remain usable', 'native browser precondition enforced', 'HTTPS environment creation', 'responsive forms'], browserErrors: errors, responseErrors };
  await writeFile(path.join(results, 'https-ui-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); await service.close(); await rm(temporary, { recursive: true, force: true }); }
