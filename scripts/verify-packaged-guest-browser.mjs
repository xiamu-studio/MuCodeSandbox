import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';
import { WebSocket } from 'ws';

const root = path.resolve(import.meta.dirname, '..');
const execFileAsync = promisify(execFile);
const appBundle = process.env.MU_PACKAGED_APP ?? path.join(root, 'release/candidate/mac-arm64/MuCodeSandbox.app');
const executable = appBundle.endsWith('.app') ? path.join(appBundle, 'Contents/MacOS/MuCodeSandbox') : appBundle;
const dataDir = path.resolve(process.env.MU_PACKAGED_GUEST_DATA ?? path.join(homedir(), '.mu-transparent-verification-pkB3P0'));
const limaPath = process.env.MU_LIMA_PATH ?? path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
assert.ok(path.basename(dataDir).startsWith('.mu-transparent-verification-'), 'Use only an explicitly disposable verification directory');
const environmentId = 'b9953e36-16f7-4b64-811c-1a51193ba3a4';
await access(executable);
const desktopData = await mkdtemp(path.join(homedir(), '.mu-packaged-user-data-'));
const resultDir = path.join(root, 'test-results');
await mkdir(resultDir, { recursive: true });
const report = { passed: false, packaged: true, startedAt: new Date().toISOString(), executable, dataDir, modelCalls: 0 };
const errors = [];
const launchOutput = [];
const receipts = [];
const sockets = new Set();
let application;
let mainWindow;
let guestWindow;
let terminal;
let environment;
let cleanupError;

const target = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/receipt') {
    let body = '';
    request.on('data', chunk => { body += chunk; if (body.length > 32_768) request.destroy(); });
    request.on('end', () => {
      try { receipts.push(JSON.parse(body)); response.end('ok'); }
      catch { response.writeHead(400); response.end(); }
    });
    return;
  }
  if (request.url === '/clicked') { receipts.push({ clicked: true }); response.end('ok'); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html lang="en"><head><title>Packaged Mu Linux Browser</title><style>body{margin:0;font:18px Arial;background:#f4f6f8;color:#182128}header{padding:32px;background:#146c54;color:white}main{padding:40px}button{background:#ffdf57;border:2px solid #182128;padding:24px;font:24px Arial}input{display:block;margin:24px 0;padding:12px;width:400px}</style></head><body><header><h1>Mu VM Browser</h1></header><main><p>Packaged application verification</p><button onclick="fetch('/clicked');this.textContent='Interaction verified'">Verify interaction</button><input placeholder="Type a test value"><canvas width="300" height="90"></canvas></main><script>
const actual=()=>({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,language:navigator.language,languages:[...navigator.languages],platform:navigator.platform,userAgent:navigator.userAgent,cores:navigator.hardwareConcurrency});
const canvas=document.querySelector('canvas'),context=canvas.getContext('2d');context.fillStyle='#176c54';context.fillRect(0,0,300,90);context.fillStyle='#ffdf57';context.font='24px Arial';context.fillText('Packaged Linux pixels',12,52);
const worker=new Worker(URL.createObjectURL(new Blob(['postMessage(('+actual.toString()+')())'],{type:'text/javascript'})));
worker.onmessage=event=>fetch('/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:location.pathname,page:actual(),worker:event.data,headers:${JSON.stringify(request.headers)}})});
document.querySelector('input').addEventListener('input',event=>fetch('/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:event.target.value})}));
</script></body></html>`);
});
await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
const targetPort = target.address().port;
const authorization = `Basic ${Buffer.from('mu:packaged-test').toString('base64')}`;
const proxy = createServer((request, response) => {
  if (request.headers['proxy-authorization'] !== authorization) { response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Mu packaged fixture"' }); response.end(); return; }
  const url = new URL(request.url);
  if (url.hostname !== '203.0.113.10') { response.writeHead(403); response.end(); return; }
  const headers = { ...request.headers }; delete headers['proxy-authorization'];
  const outgoing = httpRequest({ hostname: '127.0.0.1', port: targetPort, path: `${url.pathname}${url.search}`, method: request.method, headers }, upstream => { response.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(response); });
  outgoing.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(outgoing);
});
proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
proxy.on('connect', (request, client, head) => {
  if (request.headers['proxy-authorization'] !== authorization) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
  if (request.url !== '203.0.113.10:80') { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const upstream = connect(targetPort, '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    client.pipe(upstream); upstream.pipe(client);
  });
  sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
  upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.on('close', () => upstream.destroy());
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));

async function request(endpoint, method = 'GET', body) {
  return mainWindow.evaluate(async ({ endpoint, method, body }) => {
    const response = await fetch(`/api${endpoint}`, { method, headers: { Authorization: `Bearer ${window.__MU_CONFIG__.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }, { endpoint, method, body });
}

async function waitJob(job, limit = 180_000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const snapshot = await request('/snapshot');
    const result = snapshot.jobs.find(entry => entry.id === job.id);
    if (result?.status !== 'running') { assert.equal(result?.status, 'succeeded', result?.message); return snapshot; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Packaged operation timed out: ${job.action}`);
}

async function until(check, limit = 15_000) {
  const deadline = Date.now() + limit;
  while (!check()) { assert.ok(Date.now() < deadline, 'Timed out waiting for packaged browser evidence'); await new Promise(resolve => setTimeout(resolve, 100)); }
}

async function bounded(promise, limit, message) {
  let timeout;
  try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), limit); })]); }
  finally { clearTimeout(timeout); }
}

async function terminalCommand(command, complete) {
  const { ticket } = await request(`/environments/${environmentId}/terminal-ticket`, 'POST', { command: 'shell', cols: 100, rows: 25 });
  const origin = new URL(mainWindow.url()).origin;
  terminal = new WebSocket(`${origin.replace('http:', 'ws:')}/terminal?ticket=${ticket}`, { origin });
  let output = '';
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = error => { if (finished) return; finished = true; clearTimeout(timeout); terminal.close(); error ? reject(error) : resolve(output); };
    const timeout = setTimeout(() => done(new Error(`Packaged terminal timed out: ${output.slice(-1500)}`)), 20_000);
    terminal.on('error', done);
    terminal.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'connected') terminal.send(JSON.stringify({ type: 'input', data: `${command}\r` }));
      if (message.type === 'error' || message.type === 'exit') done(new Error(`Terminal ${message.type}: ${message.data}`));
      if (message.type === 'data') { output += message.data; if (complete(output)) done(); }
    });
  });
}

async function closedProfile() {
  const command = `python3 -c 'import json,pathlib; p=json.loads(pathlib.Path("/home/dev/.local/share/mucodesandbox/browser/Default/Preferences").read_text()).get("profile",{}); print("MU_PROFILE_STATE_"+json.dumps({"exitType":p.get("exit_type"),"exitedCleanly":p.get("exited_cleanly")}))'`;
  const output = await terminalCommand(command, text => /(?:^|[\r\n])MU_PROFILE_STATE_\{[^\r\n]+\}\r?\n/.test(text));
  return JSON.parse(output.match(/(?:^|[\r\n])MU_PROFILE_STATE_(\{[^\r\n]+\})/)[1]);
}

async function browserServiceDiagnostics() {
  const args = ['--tty=false', 'shell', environment.instanceName];
  const options = { env: { ...process.env, LIMA_HOME: path.join(dataDir, 'lima'), LC_ALL: 'en_US.UTF-8' }, timeout: 15_000, maxBuffer: 128 * 1024 };
  const [state, journal] = await Promise.all([
    execFileAsync(limaPath, [...args, 'sudo', 'systemctl', 'show', 'mucodesandbox-browser.service', '-p', 'ExecMainStatus', '-p', 'ExecMainCode', '-p', 'Result', '-p', 'ActiveState', '-p', 'InactiveEnterTimestamp'], options),
    execFileAsync(limaPath, [...args, 'sudo', 'journalctl', '--unit=mucodesandbox-browser.service', '--no-pager', '--lines=60'], options),
  ]);
  return { state: state.stdout, journal: journal.stdout };
}

try {
  const signature = await execFileAsync('/usr/bin/codesign', ['-d', '--verbose=4', path.resolve(path.dirname(executable), '../..')], { timeout: 10_000 });
  report.signature = { cdHash: signature.stderr.match(/^CDHash=(.+)$/m)?.[1], type: signature.stderr.match(/^Signature=(.+)$/m)?.[1] };
  const serviceModule = pathToFileURL(path.join(path.dirname(executable), '../Resources/app/dist-server/server/service.js')).href;
  await execFileAsync(executable, ['-e', 'import(process.argv[1]).then(()=>console.log("PACKAGED_SERVICE_IMPORT_OK")).catch(error=>{console.error(error.stack);process.exitCode=1})', serviceModule], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15_000, maxBuffer: 32_768 });
  report.packagedServiceDependenciesLoad = true;
  console.log('Launching the packaged application with disposable data.');
  application = await electron.launch({ executablePath: executable, args: [], chromiumSandbox: true, env: { ...process.env, MU_DATA_DIR: dataDir, MU_DESKTOP_USER_DATA_DIR: desktopData, MU_LIMA_PATH: limaPath, MU_TEST_CLAUDE: '0' }, timeout: 60_000 });
  for (const stream of [application.process().stdout, application.process().stderr]) stream?.on('data', chunk => { launchOutput.push(chunk.toString()); if (launchOutput.length > 100) launchOutput.shift(); });
  await bounded(application.evaluate(({ dialog }) => { dialog.showErrorBox = (title, content) => { console.error(`PACKAGED_STARTUP_ERROR: ${title}: ${content}`); }; }), 5000, 'Packaged main process did not respond to startup diagnostics');
  application.on('window', window => { window.on('pageerror', error => errors.push(error.message)); });
  mainWindow = await application.firstWindow({ timeout: 30_000 });
  mainWindow.on('pageerror', error => errors.push(error.message));
  await mainWindow.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor({ timeout: 30_000 });
  const snapshot = await request('/snapshot');
  assert.equal(snapshot.system.version, '0.4.0');
  assert.equal(snapshot.system.dataDir, dataDir);
  report.runtime = snapshot.system.runtime;
  assert.ok(snapshot.system.runtime.available);
  report.application = await application.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, arch: process.arch, electron: process.versions.electron, sandboxDisablingArgumentsAbsent: !process.argv.some(arg => /^--(?:no-sandbox|disable-(?:gpu|renderer|setuid)-sandbox)(?:=|$)/.test(arg)) }));
  assert.ok(report.application.packaged);
  assert.equal(report.application.version, '0.4.0');
  assert.equal(report.application.sandboxDisablingArgumentsAbsent, true);
  environment = snapshot.environments.find(entry => entry.id === environmentId);
  assert.ok(environment && environment.kind === 'vm', 'The disposable prepared VM is required');
  await waitJob(await request(`/environments/${environmentId}/actions/stop`, 'POST'));
  await request(`/environments/${environmentId}`, 'PUT', {
    name: environment.name, description: environment.description, kind: environment.kind, color: environment.color,
    cpus: environment.cpus, memoryGiB: environment.memoryGiB, diskGiB: environment.diskGiB, mounts: environment.mounts, ports: environment.ports,
    browserUrl: 'http://203.0.113.10/', identity: { timezone: 'Asia/Tokyo', locale: 'ja-JP' },
    network: { mode: 'http', host: '127.0.0.1', port: proxy.address().port, username: 'mu', password: 'packaged-test', noProxy: '', strict: true, transparent: true },
  });
  console.log('Starting the protected Linux VM from the packaged app.');
  await waitJob(await request(`/environments/${environmentId}/actions/start`, 'POST'));
  const before = await request(`/environments/${environmentId}/network/protection`);
  assert.ok(before.active && before.integrity === 'verified');
  report.networkProtection = true;
  await mainWindow.getByRole('button', { name: `${environment.name} Linux 沙箱`, exact: true }).click();
  await mainWindow.getByRole('button', { name: '终端', exact: true }).click();
  await mainWindow.getByText('已连接', { exact: true }).waitFor({ timeout: 20_000 });
  await terminalCommand('printf "MU_%s_OK\\n" PACKAGED_TERMINAL; whoami', text => text.includes('MU_PACKAGED_TERMINAL_OK') && /\r?\ndev\r?\n/.test(text));
  report.terminalDevAndNativePty = true;
  await mainWindow.screenshot({ path: path.join(resultDir, 'packaged-linux-terminal.png'), fullPage: true });
  console.log('Packaged Electron terminal works as the limited Linux user.');
  report.profileBeforeBrowser = await closedProfile();
  await mainWindow.getByRole('button', { name: '浏览器', exact: true }).click();
  await waitJob(await request(`/environments/${environmentId}/browser/open`, 'POST'), 600_000);
  await until(() => application.windows().some(window => new URL(window.url() || 'about:blank').searchParams.get('guestBrowser') === environmentId));
  guestWindow = application.windows().find(window => new URL(window.url() || 'about:blank').searchParams.get('guestBrowser') === environmentId);
  await guestWindow.getByRole('status').filter({ hasText: '已连接' }).waitFor({ timeout: 30_000 });
  await until(() => receipts.some(receipt => receipt.page));
  const identity = receipts.find(receipt => receipt.page);
  assert.equal(identity.page.timezone, 'Asia/Tokyo');
  assert.equal(identity.page.language, 'ja-JP');
  assert.equal(identity.page.locale, 'ja-JP');
  assert.match(identity.page.platform, /^Linux /);
  assert.deepEqual(identity.worker, identity.page);
  assert.match(identity.headers['accept-language'], /^ja-JP/);
  report.pageWorkerHeaders = identity;
  report.inspection = await request(`/environments/${environmentId}/browser/inspect`);
  assert.ok(report.inspection.matchesConfiguration);
  assert.match(report.inspection.platform, /^Linux /);
  await application.evaluate(({ BrowserWindow }, id) => {
    const window = BrowserWindow.getAllWindows().find(window => new URL(window.webContents.getURL()).searchParams.get('guestBrowser') === id);
    window.setContentSize(1440, 1000);
  }, environmentId);
  const canvas = guestWindow.locator('.guest-browser-canvas canvas');
  await canvas.waitFor();
  await guestWindow.waitForTimeout(1000);
  report.pixels = await canvas.evaluate(node => {
    const bytes = node.getContext('2d').getImageData(0, 0, node.width, node.height).data;
    const colors = new Set();
    for (let index = 0; index < bytes.length; index += 400) colors.add(`${bytes[index]},${bytes[index + 1]},${bytes[index + 2]}`);
    return { width: node.width, height: node.height, colors: colors.size };
  });
  assert.deepEqual([report.pixels.width, report.pixels.height], [1280, 800]);
  assert.ok(report.pixels.colors > 20);
  await guestWindow.screenshot({ path: path.join(resultDir, 'packaged-linux-browser.png') });
  const bounds = await canvas.boundingBox();
  assert.ok(bounds);
  if (process.env.MU_ACK_PREVIOUS_CRASH_PROMPT === '1') {
    assert.equal(report.profileBeforeBrowser.exitType, 'Crashed', 'Only acknowledge a known previous crash in this disposable profile');
    await guestWindow.mouse.click(bounds.x + bounds.width * 0.973, bounds.y + bounds.height * 0.139);
    await guestWindow.waitForTimeout(500);
    await guestWindow.screenshot({ path: path.join(resultDir, 'packaged-linux-browser-after-old-crash-ack.png') });
    report.previousCrashPromptAcknowledgementAttempted = true;
  }
  await guestWindow.mouse.click(bounds.x + bounds.width * 0.12, bounds.y + bounds.height * 0.54);
  await until(() => receipts.some(receipt => receipt.clicked));
  report.vncMouseInteraction = true;
  await canvas.click();
  await guestWindow.keyboard.press('Control+l');
  await guestWindow.waitForTimeout(200);
  await guestWindow.keyboard.type('http://203.0.113.10/packaged-keyboard', { delay: 20 });
  await guestWindow.keyboard.press('Enter');
  await until(() => receipts.some(receipt => receipt.path === '/packaged-keyboard'));
  report.vncKeyboardNavigation = true;
  const after = await request(`/environments/${environmentId}/network/protection`);
  assert.ok(after.active);
  assert.equal(after.firewallHash, before.firewallHash);
  assert.equal(after.tunnelConfigHash, before.tunnelConfigHash);
  report.browserPreservesNetworkProtection = true;
  const firstCloseStarted = Date.now();
  await request(`/environments/${environmentId}/browser/close`, 'POST');
  report.firstCloseDurationMs = Date.now() - firstCloseStarted;
  report.firstCloseAt = new Date().toISOString();
  await until(() => guestWindow.isClosed());
  assert.equal((await request(`/environments/${environmentId}/guest-browser`)).running, false);
  report.browserCloseRevokesViewer = true;
  report.browserProfileAfterClose = await closedProfile();
  report.browserServiceAfterClose = await browserServiceDiagnostics().catch(error => ({ error: error.message }));
  const previousReceipts = receipts.length;
  await waitJob(await request(`/environments/${environmentId}/browser/open`, 'POST'), 600_000);
  await until(() => application.windows().some(window => new URL(window.url() || 'about:blank').searchParams.get('guestBrowser') === environmentId));
  guestWindow = application.windows().find(window => new URL(window.url() || 'about:blank').searchParams.get('guestBrowser') === environmentId);
  await guestWindow.getByRole('status').filter({ hasText: '已连接' }).waitFor({ timeout: 30_000 });
  await until(() => receipts.slice(previousReceipts).some(receipt => receipt.page));
  await guestWindow.waitForTimeout(1000);
  await guestWindow.screenshot({ path: path.join(resultDir, 'packaged-linux-browser-reopened.png') });
  const reopenCloseStarted = Date.now();
  await request(`/environments/${environmentId}/browser/close`, 'POST');
  report.reopenCloseDurationMs = Date.now() - reopenCloseStarted;
  report.reopenCloseAt = new Date().toISOString();
  await until(() => guestWindow.isClosed());
  report.browserProfileAfterReopenClose = await closedProfile();
  report.browserServiceAfterReopenClose = await browserServiceDiagnostics().catch(error => ({ error: error.message }));
  for (const profile of [report.browserProfileAfterClose, report.browserProfileAfterReopenClose]) {
    assert.equal(profile.exitType, 'Normal', 'Browser.close must persist a normal profile exit');
  }
  report.browserRestartsAfterCleanClose = true;
  const stopped = await waitJob(await request(`/environments/${environmentId}/actions/stop`, 'POST'));
  assert.equal(stopped.environments.find(entry => entry.id === environmentId)?.state, 'stopped');
  report.vmStopped = true;
  await mainWindow.getByRole('button', { name: '网络', exact: true }).click();
  await expect(mainWindow.getByRole('button', { name: 'HTTPS 代理', exact: true })).toBeEnabled({ timeout: 10_000 });
  report.packagedHttpsConfigurationAvailable = true;
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
  if (mainWindow) {
    report.logs = (await request(`/logs?environmentId=${environmentId}`).catch(() => [])).filter(entry => entry.createdAt >= report.startedAt).slice(-60);
    await mainWindow.screenshot({ path: path.join(resultDir, 'packaged-linux-failure-main.png'), fullPage: true }).catch(() => {});
  }
  if (guestWindow && !guestWindow.isClosed()) await guestWindow.screenshot({ path: path.join(resultDir, 'packaged-linux-failure-browser.png') }).catch(() => {});
} finally {
  terminal?.terminate();
  if (mainWindow && environment && !mainWindow.isClosed()) {
    try { const stopped = await waitJob(await request(`/environments/${environmentId}/actions/stop`, 'POST')); report.vmStopped = stopped.environments.find(entry => entry.id === environmentId)?.state === 'stopped'; assert.ok(report.vmStopped); }
    catch (error) { cleanupError = error.message; report.passed = false; process.exitCode = 1; }
  }
  if (application) {
    try { await bounded(application.close(), 15_000, 'Packaged application did not close within 15 seconds'); }
    catch (error) { application.process().kill('SIGKILL'); cleanupError ??= error.message; report.passed = false; process.exitCode = 1; }
  }
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => proxy.close(resolve));
  await new Promise(resolve => target.close(resolve));
  await rm(desktopData, { recursive: true, force: true });
  report.browserErrors = errors;
  report.launchOutput = launchOutput;
  report.finishedAt = new Date().toISOString();
  if (cleanupError) report.cleanupError = cleanupError;
  await writeFile(path.join(resultDir, 'packaged-guest-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...Object.fromEntries(Object.entries(report).filter(([, value]) => typeof value === 'boolean')), version: report.application?.version, terminal: report.terminalDevAndNativePty, error: report.error, cleanupError }, null, 2));
}
