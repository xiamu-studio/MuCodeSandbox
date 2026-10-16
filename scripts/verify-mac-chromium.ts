import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, release, tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext } from '@playwright/test';
import { macNetworkPolicy } from '../server/mac-policy.ts';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const launcher = path.join(root, 'scripts/mac-chromium-launcher.sh');
const temporary = await mkdtemp(path.join(homedir(), '.mu-mac-chromium-'));
const report: Record<string, unknown> = {
  passed: false, accountFree: true, paidModelCalls: 0, startedAt: new Date().toISOString(),
  host: { platform: process.platform, architecture: process.arch, kernel: release() },
  scope: 'Standalone Mac Chrome compatibility with the experimental inherited process network policy; no user profiles or accounts.',
};
let context: BrowserContext | undefined;
let targetHits = 0, proxyHits = 0;
const target = createServer((_req, res) => {
  targetHits++;
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>MU_MAC_CHROMIUM</title><body>MuCodeSandbox</body>');
});
const proxy = createServer((req, res) => {
  const destination = new URL(req.url ?? '/', 'http://invalid.test');
  if (destination.hostname !== '127.0.0.1' || destination.port !== String(targetPort)) {
    res.writeHead(403).end(); return;
  }
  proxyHits++;
  const outgoing = request(`http://127.0.0.1:${targetPort}${destination.pathname}`, remote => {
    res.writeHead(remote.statusCode ?? 502, remote.headers); remote.pipe(res);
  });
  outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(outgoing);
});
proxy.on('connect', (_req, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
let targetPort = 0;

async function launch(guarded: boolean) {
  const profile = path.join(temporary, guarded ? 'guarded' : 'baseline');
  const scratch = path.join(temporary, guarded ? 'guarded-tmp' : 'baseline-tmp');
  await mkdir(scratch, { mode: 0o700 });
  // Mac Chrome uses the system temporary directory despite a private TMPDIR.
  // Permit singleton binding only; connecting to other profiles remains denied.
  const systemScratch = await realpath(tmpdir());
  const singleton = '^' + systemScratch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/com[.]google[.]Chrome[.][^/]+/SingletonSocket$';
  const policy = macNetworkPolicy([{ address: '127.0.0.1', port: proxyPort }])
    + `(allow network-bind network-inbound (local unix-socket (regex #${JSON.stringify(singleton)})))\n`
    + `(allow network-bind network-inbound (local unix-socket (subpath ${JSON.stringify(scratch)})))\n`
    + `(allow network-outbound (remote unix-socket (subpath ${JSON.stringify(scratch)})))\n`;
  return chromium.launchPersistentContext(profile, {
    executablePath: guarded ? launcher : executable,
    chromiumSandbox: true,
    headless: true,
    timeout: 12_000,
    proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: '<-loopback>' },
    env: { ...process.env, TMPDIR: scratch + '/', MU_MAC_CHROMIUM_EXECUTABLE: executable, MU_MAC_CHROMIUM_POLICY: policy },
    args: ['--enable-automation', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--enable-logging=stderr'],
  });
}

let proxyPort = 0;
try {
  assert.equal(process.platform, 'darwin');
  await access(executable);
  await chmod(launcher, 0o700);
  report.browserVersion = (await run(executable, ['--version'])).trim();
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  targetPort = (target.address() as { port: number }).port;
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  proxyPort = (proxy.address() as { port: number }).port;

  context = await launch(false);
  const page = context.pages()[0];
  await page.goto(`http://127.0.0.1:${targetPort}/`, { timeout: 8_000 });
  const measured = await page.evaluate(async () => {
    const worker = new Worker(URL.createObjectURL(new Blob([
      'onmessage=()=>postMessage({platform:navigator.platform,userAgent:navigator.userAgent})',
    ], { type: 'text/javascript' })));
    const result = await new Promise<{ platform: string; userAgent: string }>((resolve, reject) => {
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker timeout')); }, 4_000);
      worker.onmessage = event => { clearTimeout(timer); worker.terminate(); resolve(event.data); };
      worker.postMessage(null);
    });
    return { title: document.title, platform: navigator.platform, userAgent: navigator.userAgent, worker: result, canvas: Boolean(document.createElement('canvas').getContext('2d')) };
  });
  assert.equal(measured.title, 'MU_MAC_CHROMIUM');
  assert.match(measured.platform, /^Mac/);
  assert.equal(measured.platform, measured.worker.platform);
  assert.equal(measured.userAgent, measured.worker.userAgent);
  assert.equal(measured.canvas, true);
  assert.ok(proxyHits > 0);
  const session = await context.browser()!.newBrowserCDPSession();
  const command = await session.send('Browser.getBrowserCommandLine');
  assert.ok(!command.arguments.some((arg: string) => /^--(?:no-sandbox|disable-(?:gpu|renderer|setuid)-sandbox)(?:=|$)/.test(arg)));
  report.baseline = { completed: true, ...measured, proxyHits, targetHits, chromiumSandboxRequested: true, sandboxDisablingArgumentsAbsent: true };
  await context.close(); context = undefined;

  const hitsBefore = { proxy: proxyHits, target: targetHits };
  try {
    context = await launch(true);
    const guardedPage = context.pages()[0];
    await guardedPage.goto(`http://127.0.0.1:${targetPort}/`, { timeout: 8_000 });
    assert.equal(await guardedPage.title(), 'MU_MAC_CHROMIUM');
    report.guarded = { completed: true, proxyHits: proxyHits - hitsBefore.proxy, targetHits: targetHits - hitsBefore.target };
    report.passed = true;
    report.enforcementAccepted = false;
    report.nextChecks = 'A successful launch alone still requires direct TCP, DNS, UDP, IPv6 and proxy-failure checks.';
  } catch (error) {
    report.guarded = { completed: false, error: (error as Error).message, proxyHits: proxyHits - hitsBefore.proxy, targetHits: targetHits - hitsBefore.target };
    report.enforcementAccepted = false;
    process.exitCode = 1;
  }
} catch (error) {
  report.error = (error as Error).message; process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  proxy.closeAllConnections(); target.closeAllConnections();
  if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
  if (target.listening) await new Promise<void>(resolve => target.close(() => resolve()));
  await rm(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/mac-chromium.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
