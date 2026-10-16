import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createService } from '../server/service.ts';
import { shellQuote } from '../server/network-guard.ts';
import { GUEST_CHROMIUM_VERSION } from '../server/guest-browser-runtime.ts';
import type { Environment, Job } from '../shared/types.ts';
import { CONTEXT_ASSETS, CONTEXT_ORIGIN, CONTEXT_SERVER, CROSS_CONTEXT_ORIGIN, mediaContextAssets } from './browser-context-fixture.ts';
import { BROWSER_PROCESS_INSPECTION, MEDIA_FEATURES } from './browser-media-fixture.ts';
import { GRAPHITE_CANDIDATE_FLAGS, installGraphiteCandidate } from './webgpu-candidate.ts';

const root = path.resolve(import.meta.dirname, '..');
const media = process.argv.includes('--media');
const graphiteCandidate = process.argv.includes('--graphite-candidate');
assert.ok(!graphiteCandidate || media, 'Graphite candidate requires the full media measurement');
const reportName = (media ? 'browser-media' : 'browser-contexts') + (graphiteCandidate ? '-graphite-candidate' : '');
const retained = process.env.MU_CONTEXT_TEST_DATA;
if (retained) assert.ok(path.dirname(path.resolve(retained)) === homedir() && /^\.mu-context-verification-[A-Za-z0-9]+$/.test(path.basename(retained)), 'Only this verifier\'s retained private directory may be reused');
const temporary = retained ? path.resolve(retained) : await mkdtemp(path.join(homedir(), '.mu-context-verification-'));
const artifacts = path.join(root, 'test-results', reportName);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const sockets = new Set<Socket>();
const authorization = `Basic ${Buffer.from('mu:context-verification').toString('base64')}`;
const proxy = createServer((_request, response) => { response.writeHead(405); response.end(); });
let proxyConnections = 0;
proxy.on('connect', (request, client, head) => {
  if (request.headers['proxy-authorization'] !== authorization) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
  const destination = new URL(`https://${request.url}`);
  const remote = connect(Number(destination.port) || 443, destination.hostname, () => {
    proxyConnections++; client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client);
  });
  sockets.add(remote); remote.on('close', () => sockets.delete(remote));
  remote.on('error', () => client.destroy()); client.on('error', () => remote.destroy()); client.on('close', () => remote.destroy());
});
proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = (proxy.address() as { port: number }).port;
const service = await createService({ rootDir: root, dataDir: temporary, port: 0 });
const { manager, guestBrowser } = service, runtime = manager.runtime;
if (graphiteCandidate) installGraphiteCandidate(runtime);
const environments: Environment[] = [];
let lastEntry: ReturnType<typeof guestBrowser.entries.get>;
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), accountFree: true, paidModelCalls: 0, fixtureScope: 'guest-loopback-secure-contexts; not public TLS', stages: [], captures: [], observations: [] };
report.productionConfigurationChanged = false;
report.experimentalGraphiteCandidate = graphiteCandidate;
report.testedFiles = Object.fromEntries(await Promise.all(['server/guest-browser-runtime.ts', 'server/guest-browser-sandbox.ts', 'server/guest-browser.ts', 'scripts/browser-context-fixture.ts', 'scripts/browser-media-fixture.ts', 'scripts/verify-browser-contexts.ts', ...(graphiteCandidate ? ['scripts/webgpu-candidate.ts'] : [])].map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
async function finish(job: Job) {
  await manager.tasks.get(job.id)?.promise;
  const result = manager.store.jobs().find(value => value.id === job.id)!;
  assert.equal(result.status, 'succeeded', `${job.action}: ${result.message}`);
}
async function until(check: () => boolean | Promise<boolean>, milliseconds = 30_000) {
  const end = Date.now() + milliseconds;
  while (!await check()) { assert.ok(Date.now() < end, 'Browser context observation timed out'); await new Promise(resolve => setTimeout(resolve, 150)); }
}
const current = (e: Environment) => manager.store.get(e.id);
const admin = (e: Environment, args: string[], input?: string) => runtime.management(current(e), args, { input, timeoutMs: 30_000 });
async function installFixture(e: Environment) {
  const directory = '/home/dev/.local/share/mu-context-fixture';
  await admin(e, ['bash', '-s'], `set -eu
sudo -H -u dev install -d -m 0700 ${directory}
printf '%s' ${shellQuote(CONTEXT_SERVER)} | sudo -H -u dev tee ${directory}/server.py >/dev/null
printf '%s' ${shellQuote(JSON.stringify(media ? mediaContextAssets(MEDIA_FEATURES) : CONTEXT_ASSETS))} | sudo -H -u dev tee ${directory}/assets.json >/dev/null
sudo -H -u dev chmod 0600 ${directory}/server.py ${directory}/assets.json
sudo tee /etc/systemd/system/mu-context-fixture.service >/dev/null <<'MU_FIXTURE_UNIT'
[Unit]
Description=MuCodeSandbox owned loopback acceptance fixture
After=local-fs.target
[Service]
User=dev
Group=dev
WorkingDirectory=${directory}
ExecStart=/usr/bin/python3 ${directory}/server.py
NoNewPrivileges=yes
Restart=on-failure
[Install]
WantedBy=multi-user.target
MU_FIXTURE_UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now mu-context-fixture.service
`);
  await until(async () => { try { return (await runtime.guest(current(e), ['curl', '--fail', '--silent', '--max-time', '2', `${CONTEXT_ORIGIN}/blank`])).includes('fixture ready'); } catch { return false; } });
}
const commonKeys = ['timezone', 'locale', 'language', 'languages', 'platform', 'userAgent', 'hardwareConcurrency', 'deviceMemoryGiB', 'clientHints', 'canvasHash', 'fonts'];
async function stage(e: Environment, name: string, expectedOwner: string | null, owner: string) {
  console.log(new Date().toISOString(), `Browser contexts: ${name}`);
  await finish(await manager.openBrowser(e.id));
  const entry = guestBrowser.entries.get(e.id)!; assert.ok(entry?.ready && entry.tools);
  lastEntry = entry;
  entry.tools.socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.error || message.method?.startsWith('Target.')) {
      report.observations.push({ at: new Date().toISOString(), ...message });
      if (report.observations.length > 150) report.observations.shift();
    }
  });
  const targets = await entry.tools.send('Target.getTargets');
  const page = targets.targetInfos.find((target: any) => target.type === 'page' && target.url.startsWith(CONTEXT_ORIGIN));
  const session = page && entry.sessions.get(page.targetId); assert.ok(session);
  const run = randomUUID(), url = new URL(CONTEXT_ORIGIN);
  url.search = new URLSearchParams({ run, owner }).toString();
  await entry.tools.send('Page.navigate', { url: url.href }, session);
  let result: any;
  const evaluate = async (expression: string) => {
    const value = await entry.tools!.send('Runtime.evaluate', { expression, returnByValue: true }, session);
    assert.equal(value.exceptionDetails, undefined, JSON.stringify(value.exceptionDetails)); return value.result.value;
  };
  await until(async () => {
    const value = JSON.parse(await evaluate('JSON.stringify({run:new URLSearchParams(location.search).get("run"),ready:window.__MU_CONTEXT_READY__,error:window.__MU_CONTEXT_ERROR__})'));
    assert.equal(value.error, undefined, value.error); return value.run === run && value.ready;
  });
  const point = JSON.parse(await evaluate('JSON.stringify((()=>{const r=document.querySelector("#open-window").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})())'));
  await entry.tools.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, session);
  await entry.tools.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, session);
  await until(async () => {
    const value = JSON.parse(await evaluate('JSON.stringify({result:window.__MU_CONTEXT_RECEIPT__,error:window.__MU_CONTEXT_ERROR__})'));
    assert.equal(value.error, undefined, value.error); result = value.result; return !!result;
  }, 45_000);
  const row: Record<string, any> = { name, environmentId: e.id, identity: e.identity, receipt: result, passed: false };
  report.stages.push(row);
  if (graphiteCandidate) {
    const launcher = await admin(e, ['sudo', 'cat', '/usr/local/libexec/mu-guest-browser']);
    for (const flag of GRAPHITE_CANDIDATE_FLAGS) assert.ok(launcher.includes(flag), `Missing actual candidate flag: ${flag}`);
    row.launcherSha256 = createHash('sha256').update(launcher).digest('hex');
    await writeFile(path.join(artifacts, `${name}-launcher.sh`), launcher, { mode: 0o600 });
    row.startupGuardVerified = true;
  }
  assert.equal(result.run, run);
  const contexts = { page: result.page, dedicated: result.dedicated, shared: result.shared.value, service: result.service.value, sameFrame: result.sameFrame, crossFrame: result.crossFrame, popup: result.popup };
  for (const [name, context] of Object.entries(contexts) as [string, any][]) {
    assert.equal(context.secureContext, true, name);
    assert.equal(context.timezone, e.identity.timezone, name); assert.equal(context.language, e.identity.locale, name);
    const actualLocale = new Intl.Locale(context.locale), configuredLocale = new Intl.Locale(e.identity.locale);
    assert.equal(actualLocale.language, configuredLocale.language, `${name}.locale language`);
    if (actualLocale.region) assert.equal(actualLocale.region, configuredLocale.region, `${name}.locale region`);
    assert.match(context.platform, /^Linux /); assert.ok(context.headers['accept-language'].startsWith(e.identity.locale), name);
    assert.equal(context.headers['user-agent'], context.userAgent, name);
    for (const key of commonKeys) assert.deepEqual(context[key], result.page[key], `${name}.${key}`);
  }
  assert.match(result.page.canvasHash, /^[a-f0-9]{64}$/);
  assert.ok(Object.keys(result.page.fonts).length >= 5);
  assert.notDeepEqual(result.page.fonts['Liberation Sans'], result.page.fonts.__mu_missing_font__, 'Installed font needs a fallback negative control');
  row.gpuCapabilities = Object.fromEntries(Object.entries(contexts).map(([name, context]: [string, any]) => [name, context.gpu !== null]));
  for (const [name, context] of Object.entries(contexts) as [string, any][]) if (context.gpu) assert.deepEqual(context.gpu, result.page.gpu, `${name}.gpu`);
  assert.equal(result.sameFrame.sharedInstance, result.shared.instance, 'Same-site frame must use the actual shared worker instance');
  assert.equal(result.service.before, expectedOwner); assert.equal(result.service.after, owner);
  assert.equal(result.service.scope, `${CONTEXT_ORIGIN}/`); assert.equal(result.controller, true);
  assert.equal(result.crossFrame.origin, CROSS_CONTEXT_ORIGIN); assert.equal(result.popup.origin, CROSS_CONTEXT_ORIGIN);
  const actualTargets = (await entry.tools.send('Target.getTargets')).targetInfos;
  row.targets = actualTargets.map(({ type, url }: any) => ({ type, url }));
  for (const [type, url] of [['worker', '/dedicated.js'], ['shared_worker', '/shared.js'], ['service_worker', '/service.js']])
    assert.ok(actualTargets.some((target: any) => target.type === type && target.url === `${CONTEXT_ORIGIN}${url}`), `Actual fixture ${type} target missing`);
  assert.ok(actualTargets.some((target: any) => target.type === 'iframe' && target.url.startsWith(`${CROSS_CONTEXT_ORIGIN}/child`)), 'Actual cross-site iframe target missing');
  assert.ok(actualTargets.some((target: any) => target.type === 'page' && target.url.startsWith(CROSS_CONTEXT_ORIGIN)), 'Actual cross-site new window missing');
  await entry.tools.send('DOM.enable', {}, session); await entry.tools.send('CSS.enable', {}, session);
  const dom = await entry.tools.send('DOM.getDocument', {}, session);
  const node = await entry.tools.send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#font-sample' }, session);
  row.platformFonts = (await entry.tools.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId }, session)).fonts;
  assert.ok(row.platformFonts.some((font: any) => font.glyphCount > 0 && !font.isCustomFont));
  if (media) {
    row.lateFontConsistency = {};
    for (const [contextName, context] of Object.entries(contexts) as [string, any][]) {
      const measured = context.media; assert.ok(measured, contextName);
      const font = measured.font;
      assert.equal(font.initialStatus, 'unloaded', contextName); assert.equal(font.loadingStatus, 'loading', contextName); assert.equal(font.loadedStatus, 'loaded', contextName);
      assert.equal(font.preparedStatus, 'loaded', contextName);
      assert.ok(font.elapsedMs >= 800, `${contextName}: expected a genuinely delayed download`);
      assert.notEqual(font.before.width, font.after.width, `${contextName}: downloaded font must differ from fallback`);
      assert.notEqual(font.before.hash, font.after.hash, contextName);
      assert.deepEqual(font.after, result.page.media.font.after, `${contextName}: font metrics and pixels`);
      assert.deepEqual(font.before, result.page.media.font.before, `${contextName}: fallback metrics and pixels`);
      assert.deepEqual(font.negative, font.after, `${contextName}: missing font must not affect loaded font`);
      const lateConsistent = font.late.width === font.after.width && font.late.hash === font.after.hash;
      row.lateFontConsistency[contextName] = lateConsistent;
      if (!lateConsistent) assert.deepEqual(font.late, font.before, `${contextName}: unexpected late-font output needs investigation`);
      assert.equal(font.missingRejected, true, contextName); assert.equal(font.missingStatus, 'error', contextName);
      const { first, repeated, changed } = measured.audio;
      if (['page', 'sameFrame', 'crossFrame', 'popup'].includes(contextName)) {
        assert.equal(first.supported, true, contextName); assert.equal(first.sampleRate, 44100); assert.equal(first.length, 4096); assert.equal(first.channels, 1);
        assert.ok(first.nonzero > 3000 && first.peak > 0 && first.energy > 0, `${contextName}: real nonzero audio required`);
        assert.equal(first.hash, repeated.hash, `${contextName}: repeated audio`); assert.notEqual(first.hash, changed.hash, `${contextName}: changed-frequency control`);
        assert.equal(first.hash, result.page.media.audio.first.hash, `${contextName}: cross-context audio`);
      } else assert.equal(first.supported, false, `${contextName}: report the actual Worker API boundary`);
      if (measured.webgl.supported) { assert.deepEqual(measured.webgl.pixel, [255, 0, 0, 255]); assert.equal(measured.webgl.error, 0); }
      assert.deepEqual(measured.webgl, result.page.media.webgl, `${contextName}: WebGL capability`);
    }
    const customNode = await entry.tools.send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#web-font-sample' }, session);
    row.customFonts = (await entry.tools.send('CSS.getPlatformFontsForNode', { nodeId: customNode.nodeId }, session)).fonts;
    assert.ok(row.customFonts.some((font: any) => font.isCustomFont && font.glyphCount > 0), 'Chromium must actually render the downloaded font');
    row.gpuDiagnostics = await entry.tools.send('SystemInfo.getInfo');
    if (graphiteCandidate) assert.equal(row.gpuDiagnostics.gpu.featureStatus.skia_graphite, 'enabled_on');
    row.processSecurity = JSON.parse((await admin(e, ['sudo', 'python3', '-'], BROWSER_PROCESS_INSPECTION)).trim());
    const renderers = row.processSecurity.processes.filter((process: any) => process.role === 'renderer');
    assert.ok(renderers.length > 0);
    for (const process of renderers) {
      assert.equal(process.uid, row.processSecurity.developmentUid); assert.equal(process.seccomp, 2); assert.equal(process.noNewPrivileges, 1);
      assert.match(process.effectiveCapabilities, /^0+$/); assert.equal(process.separatePidNamespace, true); assert.equal(process.noSandboxFlag, false);
      assert.ok(process.threads.length > 0 && process.threads.some((thread: any) => thread.tid === process.pid));
      for (const thread of process.threads) { assert.equal(thread.seccomp, 2); assert.equal(thread.noNewPrivileges, 1); assert.match(thread.effectiveCapabilities, /^0+$/); }
    }
    const graphics = row.processSecurity.processes.filter((process: any) => process.role === 'gpu-process');
    assert.ok(graphics.length > 0);
    row.rendererSandboxVerified = true;
    row.gpuSandboxVerified = row.gpuDiagnostics.gpu.auxAttributes.sandboxed && graphics.every((process: any) =>
      process.uid === row.processSecurity.developmentUid && process.seccomp === 2 && process.noNewPrivileges === 1 && /^0+$/.test(process.effectiveCapabilities) && !process.noSandboxFlag &&
      process.threads.length > 0 && process.threads.some((thread: any) => thread.tid === process.pid) && process.threads.every((thread: any) => thread.seccomp === 2 && thread.noNewPrivileges === 1 && /^0+$/.test(thread.effectiveCapabilities)));
    row.gpuCrashCount = row.gpuDiagnostics.gpu.auxAttributes.processCrashCount;
    assert.equal(row.gpuSandboxVerified, true, 'Production graphics sandbox must be active'); assert.equal(row.gpuCrashCount, 0);
    await entry.tools.send('Page.bringToFront', {}, session);
    const screenshot = await entry.tools.send('Page.captureScreenshot', { format: 'png' }, session);
    const screenshotBytes = Buffer.from(screenshot.data, 'base64');
    await writeFile(path.join(artifacts, `${name}.png`), screenshotBytes, { mode: 0o600 });
    row.screenshot = { bytes: screenshotBytes.length, sha256: createHash('sha256').update(screenshotBytes).digest('hex') };
    row.fontFile = JSON.parse((await runtime.guest(current(e), ['python3', '-c', 'import pathlib,hashlib,json;p=sorted(pathlib.Path("/usr/share/fonts/truetype").glob("liberation*/LiberationSans-Regular.ttf"))[0];print(json.dumps({"name":p.name,"sha256":hashlib.sha256(p.read_bytes()).hexdigest()}))'])).trim());
    const previous = report.stages.find((candidate: any) => candidate.passed && candidate.environmentId === e.id);
    if (previous) {
      assert.deepEqual(result.page.media.font.after, previous.receipt.page.media.font.after, 'Downloaded font must remain consistent after reopen/restart');
      assert.equal(result.page.media.audio.first.hash, previous.receipt.page.media.audio.first.hash, 'Audio must remain consistent after reopen/restart');
    }
  }
  row.fontInventory = [...new Set((await runtime.guest(current(e), ['fc-list', ':', 'family'])).trim().split('\n'))].sort();
  assert.ok(row.fontInventory.some((font: string) => font.includes('Liberation Sans')));
  row.guestArchitecture = (await runtime.guest(current(e), ['uname', '-m'])).trim();
  assert.equal(row.guestArchitecture, 'aarch64');
  assert.equal(result.page.clientHints.platform, 'Linux'); assert.equal(result.page.clientHints.architecture, 'arm'); assert.equal(result.page.clientHints.bitness, '64');
  const protection = await runtime.networkProtection(current(e)); assert.equal(protection.active, true);
  row.protection = protection;
  await manager.closeBrowser(e.id);
  row.profileExitType = (await runtime.guest(current(e), ['python3', '-c', 'import json,pathlib;print(json.loads(pathlib.Path("/home/dev/.local/share/mucodesandbox/browser/Default/Preferences").read_text())["profile"]["exit_type"])'])).trim();
  assert.equal(row.profileExitType, 'Normal'); row.passed = true;
  await writeFile(path.join(artifacts, 'stages.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
}
async function startCapture(e: Environment, name: string) {
  const file = `/tmp/mu-context-${name}.pcap`, unit = `mu-context-capture-${name}`;
  await admin(e, ['bash', '-s'], `set -eu
sudo systemd-run --unit=${unit} /usr/bin/tcpdump --immediate-mode -ni eth0 -Q out -U -s 96 -w ${file} 'ip or ip6'
sleep 1
`);
  assert.match(await runtime.guest(current(e), ['curl', '--fail', '--silent', '--max-time', '15', '--proxy', '', 'https://example.com/']), /Example Domain/);
  return async () => {
    await admin(e, ['sudo', 'systemctl', 'stop', `${unit}.service`]);
    const size = Number((await admin(e, ['sudo', 'stat', '-c', '%s', file])).trim());
    assert.ok(size > 24 && size < 90_000_000);
    const encoded = await runtime.management(current(e), ['sudo', 'base64', '-w0', file], { timeoutMs: 60_000, maxBytes: 128_000_000 });
    const bytes = Buffer.from(encoded.trim(), 'base64'); assert.equal(bytes.length, size);
    const destination = path.join(artifacts, `${name}.pcap`); await writeFile(destination, bytes, { mode: 0o600 });
    const allowed = `(tcp and dst host 192.168.5.2 and dst port ${proxyPort}) or (tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67)`;
    const rejected = await runtime.runner('/usr/sbin/tcpdump', ['-nn', '-r', destination, `ip6 or (ip and not (${allowed}))`], { timeoutMs: 30_000 });
    assert.ok(!rejected.split('\n').some(line => /^\d\d:\d\d:\d\d\./.test(line)), rejected);
    const approved = await runtime.runner('/usr/sbin/tcpdump', ['-nn', '-r', destination, `tcp and dst host 192.168.5.2 and dst port ${proxyPort}`], { timeoutMs: 30_000, maxBytes: 64_000_000 });
    const count = approved.split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line)).length; assert.ok(count > 0);
    report.captures.push({ name, bytes: size, sha256: createHash('sha256').update(bytes).digest('hex'), approvedProxyPackets: count, unapprovedPackets: 0 });
  };
}
try {
  await mkdir(path.join(temporary, 'tools/guest-browser'), { recursive: true, mode: 0o700 });
  await copyFile(`/tmp/mu-chromium-${GUEST_CHROMIUM_VERSION}-arm64.zip`, path.join(temporary, `tools/guest-browser/chrome-${GUEST_CHROMIUM_VERSION}-linux-arm64.zip`)).catch(() => {});
  for (const [name, identity] of [['A', { timezone: 'Asia/Tokyo', locale: 'ja-JP' }], ['B', { timezone: 'America/New_York', locale: 'en-US' }]] as const)
    environments.push(await manager.create({ name: `Browser contexts ${name}`, cpus: 2, memoryGiB: 2, diskGiB: 10, browserUrl: `${CONTEXT_ORIGIN}/blank`, identity, network: { mode: 'http', host: '127.0.0.1', port: proxyPort, username: 'mu', password: 'context-verification', strict: true, transparent: true, noProxy: '' } }));
  for (let index = 0; index < environments.length; index++) {
    const e = environments[index], label = index ? 'b' : 'a', owner = `synthetic-${label}`;
    console.log(new Date().toISOString(), `Starting fresh protected VM ${label}`);
    await finish(await manager.lifecycle(e.id, 'start')); await installFixture(e);
    if (graphiteCandidate) await runtime.management(current(e), ['bash', '-s'], { timeoutMs: 600_000, input: 'set -eu\nsudo -E env DEBIAN_FRONTEND=noninteractive apt-get update -qq\nsudo -E env DEBIAN_FRONTEND=noninteractive SYSTEMD_OFFLINE=1 NEEDRESTART_MODE=l apt-get install -y --no-install-recommends mesa-vulkan-drivers\n' });
    const protection = await runtime.networkProtection(current(e));
    const end = await startCapture(e, label);
    try { await stage(e, `${label}-fresh`, null, owner); await stage(e, `${label}-browser-reopened`, owner, owner); }
    finally { await end(); }
    const after = await runtime.networkProtection(current(e)); assert.equal(after.firewallHash, protection.firewallHash); assert.equal(after.tunnelConfigHash, protection.tunnelConfigHash);
    await finish(await manager.lifecycle(e.id, 'stop'));
  }
  for (let index = 0; index < environments.length; index++) {
    const e = environments[index], label = index ? 'b' : 'a';
    await finish(await manager.lifecycle(e.id, 'start'));
    const end = await startCapture(e, `${label}-restarted`);
    try { await stage(e, `${label}-vm-restarted`, `synthetic-${label}`, `synthetic-${label}`); }
    finally { await end(); }
    await finish(await manager.lifecycle(e.id, 'stop'));
  }
  assert.ok(proxyConnections > 0); report.authenticatedProxyConnections = proxyConnections;
  if (media) {
    report.fontLoadedBeforeFirstUseConsistent = true;
    report.lateRegisteredFontsConsistent = report.stages.every((row: any) => Object.values(row.lateFontConsistency).every(Boolean));
    report.offlineAudioConsistent = true;
    report.rendererSandboxVerified = report.stages.every((row: any) => row.rendererSandboxVerified);
    report.gpuSandboxVerified = report.stages.every((row: any) => row.gpuSandboxVerified);
    report.webGLRenderingVerified = report.stages.every((row: any) => row.receipt.page.media.webgl.supported);
    report.fullMediaConsistencyVerified = report.lateRegisteredFontsConsistent && report.webGLRenderingVerified;
  }
  report.sharedAndServiceWorkersCrossSiteFramesAndNewWindowsVerified = true;
  report.serviceWorkerStorageIsolatedAndPersistent = true; report.passed = true;
} catch (error) {
  report.error = (error as Error).stack; report.logs = manager.store.logs(null).slice(-40); process.exitCode = 1;
  report.lastBrowser = lastEntry && { failure: lastEntry.failure?.stack, transportExit: lastEntry.transport.exitCode, ready: lastEntry.ready };
  if (lastEntry) report.browserJournal = await admin(lastEntry.environment, ['sudo', 'journalctl', '-u', 'mucodesandbox-browser.service', '--no-pager', '-n', '100']).catch(String);
  for (const [id, entry] of guestBrowser.entries) {
    report.observations.push({ id, failure: entry.failure?.stack, ready: entry.ready, targets: await entry.tools?.send('Target.getTargets').catch(String) });
    if (entry.tools) for (const session of entry.sessions.values()) report.observations.push({ session, page: await entry.tools.send('Runtime.evaluate', { expression: 'JSON.stringify({url:location.href,result:window.__MU_CONTEXT_RECEIPT__,partial:window.__MU_CONTEXT_PARTIAL__,error:window.__MU_CONTEXT_ERROR__})', returnByValue: true }, session).catch(String) });
  }
} finally {
  for (const e of environments) await manager.lifecycle(e.id, 'stop').then(finish).catch(async error => {
    report.cleanupError = String(error); await runtime.command(['stop', '--force', e.instanceName], { timeoutMs: 60_000 }).catch(() => {});
  });
  await service.close(); for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => proxy.close(() => resolve()));
  if (report.passed && !report.cleanupError) {
    for (const instance of await runtime.list()) await runtime.command(['delete', '--force', instance.name], { timeoutMs: 60_000 });
    await rm(temporary, { recursive: true, force: true }); report.temporaryVmDataRemoved = true;
  } else { report.passed = false; report.retainedDataDir = temporary; }
  report.finishedAt = new Date().toISOString();
  for (const [file, expected] of Object.entries(report.testedFiles)) {
    const bytes = await readFile(path.join(root, file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `Source changed during browser measurement: ${file}`);
    const destination = path.join(artifacts, 'source', file);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { mode: 0o600 });
  }
  await writeFile(path.join(root, 'test-results', `${reportName}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, stages: report.stages.length, error: report.error, retainedDataDir: report.retainedDataDir, captures: report.captures }, null, 2));
}
