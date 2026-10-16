import { _electron as electron, expect } from '@playwright/test';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const root = path.resolve(import.meta.dirname, '..');
const report = { passed: false, packaged: Boolean(process.env.MU_PACKAGED_APP), nativeBrowser: false, isolatedBrowserCookies: false, terminal: false, agentInstalled: false };
const errors = [];
const languages = [];
let fixtureHits = 0;
const fixture = createServer((req, res) => { fixtureHits++; languages.push(req.headers['accept-language']); res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control', 'no-store'); res.end('<html><head><title>MuCodeSandbox browser verification</title></head><body><h1>MuCodeSandbox browser verification</h1></body></html>'); });
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
let proxyHits = 0;
const proxySockets = new Set();
const proxy = createServer((req, res) => {
  if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('mu:test-browser').toString('base64')}`) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Mu browser test"' }); res.end(); return; }
  proxyHits++;
  const url = new URL(req.url);
  if (url.hostname !== '127.0.0.1' || url.port !== String(fixture.address().port)) { res.writeHead(403); res.end(); return; }
  const headers = { ...req.headers }; delete headers['proxy-authorization'];
  const outgoing = httpRequest(url, { headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
  outgoing.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(outgoing);
});
proxy.on('connection', socket => { proxySockets.add(socket); socket.on('close', () => proxySockets.delete(socket)); });
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const application = await electron.launch(process.env.MU_PACKAGED_APP
  ? { executablePath: process.env.MU_PACKAGED_APP, args: [], env: { ...process.env } }
  : { args: [root], env: { ...process.env } });
const window = await application.firstWindow();
window.on('pageerror', error => errors.push(error.message));
async function request(endpoint, method = 'GET', body) {
  return window.evaluate(async ({ endpoint, method, body }) => {
    const response = await fetch(`/api${endpoint}`, { method, headers: { Authorization: `Bearer ${window.__MU_CONFIG__.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error); return result;
  }, { endpoint, method, body });
}
async function waitJob(job, limit = 120_000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    const snapshot = await request('/snapshot');
    const status = snapshot.jobs.find(j => j.id === job.id);
    if (status?.status !== 'running') { assert.equal(status?.status, 'succeeded', status?.message); return snapshot; }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  throw new Error('Desktop operation timed out');
}
let environment;
const browserIds = [];
try {
  await window.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  const snapshot = await request('/snapshot');
  assert.equal(snapshot.system.browser.native, true); report.nativeBrowser = true;
  if (!process.env.MU_BROWSER_ONLY) {
  environment = snapshot.environments.find(e => e.kind === 'vm');
  assert.ok(environment, 'Run smoke:vm -- --keep before desktop verification');
  await waitJob(await request(`/environments/${environment.id}/actions/start`, 'POST'), 180_000);
  await window.getByRole('button', { name: `${environment.name} Linux 沙箱`, exact: true }).click();
  await window.getByRole('button', { name: '终端', exact: true }).click();
  await window.getByText('已连接', { exact: true }).waitFor();
  const { ticket } = await request(`/environments/${environment.id}/terminal-ticket`, 'POST', { command: 'shell', cols: 100, rows: 25 });
  const url = new URL(window.url());
  const terminal = new WebSocket(`ws://${url.host}/terminal?ticket=${ticket}`, { origin: url.origin });
  let terminalText = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { terminal.close(); reject(new Error(`Terminal output timeout: ${terminalText.slice(-2000)}`)); }, 20_000);
    terminal.on('error', reject);
    terminal.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'connected') terminal.send(JSON.stringify({ type: 'input', data: 'printf "MU_%s_OK\\n" TERMINAL; whoami\r' }));
      if (message.type === 'exit') { clearTimeout(timeout); reject(new Error(`Terminal exited ${message.data}: ${terminalText.slice(-2000)}`)); }
      if (message.type === 'data') { terminalText += message.data; if (terminalText.includes('MU_TERMINAL_OK') && terminalText.match(/\r?\ndev\r?\n/)) { clearTimeout(timeout); terminal.close(); resolve(); } }
    });
  });
  report.terminal = true;
  await window.screenshot({ path: path.join(root, 'test-results/desktop-terminal.png'), fullPage: true });
  console.log('Actual Linux terminal verified.');
  if (process.env.MU_TEST_CLAUDE === '1') {
  if (!(await request(`/environments/${environment.id}/agent`)).installed)
    await waitJob(await request(`/environments/${environment.id}/actions/install-agent`, 'POST'), 900_000);
  const agent = await request(`/environments/${environment.id}/agent`);
  assert.ok(agent.installed); report.agentInstalled = true; report.agentVersion = agent.version;
  console.log(`Claude Code installed: ${agent.version}`);
  }
  }
  const identities = [{ timezone: 'America/New_York', locale: 'en-US' }, { timezone: 'Asia/Tokyo', locale: 'ja-JP' }];
  for (const [index, name] of ['浏览器验证 A', '浏览器验证 B'].entries()) {
    const e = await request('/environments', 'POST', { name, kind: 'browser', browserUrl: fixtureUrl, identity: identities[index] });
    browserIds.push(e.id);
    await waitJob(await request(`/environments/${e.id}/browser/open`, 'POST'));
    const inspection = await request(`/environments/${e.id}/browser/inspect`);
    assert.equal(inspection.timezone, identities[index].timezone);
    assert.equal(inspection.language, identities[index].locale);
    assert.equal(inspection.locale, identities[index].locale);
    assert.equal(inspection.matchesConfiguration, true);
    assert.equal(inspection.webRtcPolicy, 'disable_non_proxied_udp');
  }
  report.independentBrowserIdentity = true;
  assert.ok(languages.some(language => language?.startsWith('en-US')));
  assert.ok(languages.some(language => language?.startsWith('ja-JP')));
  report.acceptLanguageApplied = true;
  const sessions = await application.evaluate(async ({ session }, ids) => {
    const first = session.fromPartition(`persist:mu-${ids[0]}`);
    const second = session.fromPartition(`persist:mu-${ids[1]}`);
    await first.cookies.set({ url: 'http://127.0.0.1', name: 'mu-test-cookie', value: 'only-first' });
    return { first: await first.cookies.get({ name: 'mu-test-cookie' }), second: await second.cookies.get({ name: 'mu-test-cookie' }) };
  }, browserIds);
  assert.equal(sessions.first[0].value, 'only-first'); assert.equal(sessions.second.length, 0); report.isolatedBrowserCookies = true;
  const browserWindow = application.windows().find(w => w.url().includes(`browser=${browserIds[0]}`));
  assert.ok(browserWindow);
  const renderedBrowser = await application.evaluate(async ({ BrowserWindow }, { id, fixtureUrl }) => {
    const browser = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes(`browser=${id}`));
    const view = browser.contentView.children.find(child => child.webContents?.getURL() === fixtureUrl);
    if (!view) throw new Error('Native browser page did not load');
    const text = await view.webContents.executeJavaScript('document.body.innerText');
    // The window capture excludes the separate WebContentsView surface.
    return { text, screenshot: (await view.webContents.capturePage()).toPNG().toString('base64') };
  }, { id: browserIds[0], fixtureUrl });
  assert.equal(renderedBrowser.text.trim(), 'MuCodeSandbox browser verification');
  report.nativeBrowserPageRendered = true;
  await writeFile(path.join(root, 'test-results/native-browser-page.png'), Buffer.from(renderedBrowser.screenshot, 'base64'));
  const proxied = await request('/environments', 'POST', { name: '浏览器代理验证', kind: 'browser', browserUrl: fixtureUrl, network: { mode: 'http', host: '127.0.0.1', port: proxy.address().port, username: 'mu', password: 'test-browser', noProxy: '' } });
  browserIds.push(proxied.id);
  await waitJob(await request(`/environments/${proxied.id}/browser/open`, 'POST'));
  assert.ok(proxyHits > 0); report.authenticatedBrowserProxy = true;
  const hitsBeforeFailure = fixtureHits;
  for (const socket of proxySockets) socket.destroy();
  await new Promise(resolve => proxy.close(resolve));
  const failure = await application.evaluate(async ({ BrowserWindow }, { id, url }) => {
    const browser = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes(`browser=${id}`));
    const view = browser.contentView.children.find(child => child.webContents);
    await view.webContents.session.closeAllConnections();
    try { await view.webContents.loadURL(`${url}?proxy-failure=${Date.now()}`); return null; } catch (error) { return error.message; }
  }, { id: proxied.id, url: fixtureUrl });
  assert.match(failure ?? '', /ERR_PROXY_CONNECTION_FAILED/);
  assert.equal(fixtureHits, hitsBeforeFailure); report.browserProxyFailureDoesNotFallBack = true;
  if (environment) {
  await window.getByRole('button', { name: '总览', exact: true }).click();
  await expect(window.locator('.metric-strip .metric > strong').first()).toHaveText(/\d+\.\d+%/, { timeout: 30_000 });
  await window.screenshot({ path: path.join(root, 'test-results/real-vm-overview.png'), fullPage: true });
  await waitJob(await request(`/environments/${environment.id}/actions/stop`, 'POST'));
  }
  for (const id of browserIds) await waitJob(await request(`/environments/${id}/actions/delete`, 'POST'));
  const cleared = await application.evaluate(async ({ session }, id) => session.fromPartition(`persist:mu-${id}`).cookies.get({ name: 'mu-test-cookie' }), browserIds[0]);
  assert.equal(cleared.length, 0); report.deletedBrowserCookiesCleared = true;
  assert.deepEqual(errors, []); report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; await window.screenshot({ path: path.join(root, 'test-results/desktop-failure.png'), fullPage: true }).catch(() => {}); }
finally {
  report.browserErrors = errors;
  if (!report.passed && environment) await request(`/environments/${environment.id}/actions/stop`, 'POST').then(job => waitJob(job)).catch(() => {});
  for (const id of browserIds) await request(`/environments/${id}/actions/delete`, 'POST').then(job => waitJob(job)).catch(() => {});
  await application.close(); await new Promise(resolve => fixture.close(resolve));
  for (const socket of proxySockets) socket.destroy();
  if (proxy.listening) await new Promise(resolve => proxy.close(resolve));
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results', report.packaged ? 'packaged-verification.json' : 'desktop-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
