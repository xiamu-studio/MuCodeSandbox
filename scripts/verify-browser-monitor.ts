import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { createService as createSourceService } from '../server/service.ts';
import { GUEST_CHROMIUM_VERSION, GUEST_BROWSER_SERVICE } from '../server/guest-browser-runtime.ts';
import { INSPECT_GUEST_BROWSER_SANDBOX, assertGuestBrowserSandbox } from '../server/guest-browser-sandbox.ts';
import { BROWSER_PROCESS_INSPECTION } from './browser-media-fixture.ts';
import type { Environment, Job } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..'), packaged = process.argv.includes('--packaged');
const name = 'browser-runtime-monitor' + (packaged ? '-packaged' : '');
const bundle = path.resolve(process.env.MU_PACKAGED_APP ?? path.join(root, 'release/browser-monitor-candidate/mac-arm64/MuCodeSandbox.app'));
const appRoot = path.join(bundle, 'Contents/Resources/app');
const createService: typeof createSourceService = packaged ? (await import(pathToFileURL(path.join(appRoot, 'dist-server/server/service.js')).href)).createService : createSourceService;
const temporary = await mkdtemp(path.join(homedir(), '.mu-browser-monitor-'));
const project = await mkdtemp(path.join(homedir(), '.mu-browser-monitor-project-'));
const artifacts = path.join(root, 'test-results', name);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
await writeFile(path.join(project, 'fixture.txt'), 'MU_BROWSER_MONITOR_BRIDGE_OK');
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const sockets = new Set<Socket>(), authorization = `Basic ${Buffer.from('mu:monitor-test').toString('base64')}`;
const proxy = createServer((_request, response) => { response.writeHead(405); response.end(); });
proxy.on('connect', (request, client, head) => {
  if (request.headers['proxy-authorization'] !== authorization) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
  const destination = new URL(`https://${request.url}`);
  const remote = connect(Number(destination.port) || 443, destination.hostname, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client);
  });
  sockets.add(remote); remote.on('close', () => sockets.delete(remote)); remote.on('error', () => client.destroy());
  client.on('error', () => remote.destroy()); client.on('close', () => remote.destroy());
});
proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = (proxy.address() as { port: number }).port;
const service = await createService({ rootDir: root, dataDir: temporary, port: 0 });
const { manager, guestBrowser, terminal, bridge } = service, runtime = manager.runtime;
const report: Record<string, any> = { passed: false, measurementCompleted: false, startedAt: new Date().toISOString(), accountFree: true, paidModelCalls: 0,
  automaticMonitorIntervalMs: 8000, manualMonitorCalls: 0, inspections: [] };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['server/browser.ts', 'server/manager.ts', 'server/service.ts', 'server/guest-browser.ts', 'server/guest-browser-runtime.ts', 'server/guest-browser-sandbox.ts', 'scripts/verify-browser-monitor.ts'];
report.testedFiles = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(path.join(root, file)))])));
if (packaged) {
  report.bundle = bundle;
  const files = ['browser.js', 'manager.js', 'service.js', 'guest-browser.js', 'guest-browser-runtime.js', 'guest-browser-sandbox.js'];
  report.packagedFiles = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(path.join(appRoot, 'dist-server/server', file)))])));
  const compiled = await import(pathToFileURL(path.join(appRoot, 'dist-server/server/guest-browser-sandbox.js')).href);
  assert.equal(compiled.INSPECT_GUEST_BROWSER_SANDBOX, INSPECT_GUEST_BROWSER_SANDBOX);
}
const originalManagement = runtime.management.bind(runtime);
runtime.management = async (environment, args, options = {}) => {
  const value = await originalManagement(environment, args, options);
  if (options.input === INSPECT_GUEST_BROWSER_SANDBOX) report.inspections.push({ at: new Date().toISOString(), value: JSON.parse(value) });
  return value;
};
let environment: Environment | undefined, viewer: WebSocket | undefined, shell: WebSocket | undefined;
const current = () => { assert.ok(environment); return manager.store.get(environment.id); };
const admin = (args: string[], input?: string, timeoutMs = 30_000) => runtime.management(current(), args, { input, timeoutMs });
async function finish(job: Job) { await manager.tasks.get(job.id)?.promise; assert.equal(manager.store.jobs().find(value => value.id === job.id)?.status, 'succeeded', job.action); }
async function until(operation: () => Promise<boolean> | boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await operation()) { assert.ok(Date.now() < deadline, 'Runtime monitor evidence timeout'); await new Promise(resolve => setTimeout(resolve, 200)); }
}
async function openViewer() {
  const credentials = guestBrowser.issue(current().id);
  const socket = new WebSocket(`${service.url.replace('http:', 'ws:')}/guest-browser?ticket=${credentials.ticket}`, { origin: service.url });
  let greeting = false; socket.on('error', () => {});
  socket.on('message', data => { if (data.toString().startsWith('RFB ')) greeting = true; });
  await until(() => greeting); return socket;
}
async function draw(name: string) {
  const entry = guestBrowser.entries.get(current().id)!; assert.ok(entry?.tools && entry.ready);
  const target = (await entry.tools.send('Target.getTargets')).targetInfos.find((target: any) => target.type === 'page');
  const session = entry.sessions.get(target.targetId); assert.ok(session);
  const value = await entry.tools.send('Runtime.evaluate', { expression: `(()=>{document.body.innerHTML='';const c=document.createElement('canvas');c.width=256;c.height=256;document.body.append(c);const gl=c.getContext('webgl');if(!gl)throw Error('No WebGL');gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);const p=new Uint8Array(4);gl.readPixels(128,128,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return {pixel:[...p],error:gl.getError()}})()`, returnByValue: true }, session);
  assert.equal(value.exceptionDetails, undefined); assert.deepEqual(value.result.value, { pixel: [0, 255, 0, 255], error: 0 });
  const png = Buffer.from((await entry.tools.send('Page.captureScreenshot', { format: 'png' }, session)).data, 'base64');
  await writeFile(path.join(artifacts, `${name}.png`), png, { mode: 0o600 });
  return { ...value.result.value, screenshotSha256: hash(png), screenshotBytes: png.length };
}
async function extraBrowser(unit: string, profile: string, port: number, join: boolean) {
  const executable = `/opt/mucodesandbox/chromium-${GUEST_CHROMIUM_VERSION}/chrome-linux-arm64/chrome`;
  const source = `import os,pathlib,pwd
if ${join ? 'True' : 'False'}:pathlib.Path('/sys/fs/cgroup/system.slice/${GUEST_BROWSER_SERVICE}/cgroup.procs').write_text(str(os.getpid()))
dev=pwd.getpwnam('dev');os.setgroups([dev.pw_gid]);os.setgid(dev.pw_gid);os.setuid(dev.pw_uid)
env=dict(os.environ,HOME='/home/dev',USER='dev',LOGNAME='dev',DISPLAY=':99',XAUTHORITY='/run/mu-browser/Xauthority',LP_NUM_THREADS='0',GALLIUM_DRIVER='llvmpipe',LIBGL_ALWAYS_SOFTWARE='1',MESA_SHADER_CACHE_DISABLE='true')
for key in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']:env.pop(key,None)
os.execve(${JSON.stringify(executable)},[${JSON.stringify(executable)},'--user-data-dir=/home/dev/.local/share/mucodesandbox/${profile}','--no-first-run','--no-default-browser-check','--use-gl=angle','--use-angle=gl','--ignore-gpu-blocklist','--disable-accelerated-2d-canvas','--disable-gpu-sandbox','--remote-debugging-address=127.0.0.1','--remote-debugging-port=${port}','about:blank'],env)
`;
  await admin(['sudo', 'systemd-run', `--unit=${unit}`, '/usr/bin/python3', '-c', source]);
}
try {
  await mkdir(path.join(temporary, 'tools/guest-browser'), { recursive: true, mode: 0o700 });
  await copyFile(`/tmp/mu-chromium-${GUEST_CHROMIUM_VERSION}-arm64.zip`, path.join(temporary, `tools/guest-browser/chrome-${GUEST_CHROMIUM_VERSION}-linux-arm64.zip`)).catch(() => {});
  environment = await manager.create({ name: 'Running browser protection', cpus: 2, memoryGiB: 2, diskGiB: 10,
    browserUrl: 'http://127.0.0.1:18787/', identity: { timezone: 'Asia/Tokyo', locale: 'ja-JP' },
    network: { mode: 'http', host: '127.0.0.1', port: proxyPort, username: 'mu', password: 'monitor-test', strict: true, transparent: true, noProxy: '' } });
  console.log(new Date().toISOString(), 'Creating isolated strict VM and installing browser');
  await finish(await manager.lifecycle(environment.id, 'start'));
  await admin(['sudo', 'systemd-run', '--unit=mu-browser-monitor-page', '--uid=dev', '/usr/bin/python3', '-m', 'http.server', '18787', '--bind', '127.0.0.1', '--directory', '/tmp']);
  await admin(['sudo', 'install', '-d', '-m', '0700', '/var/lib/mu-monitor']);
  await admin(['sudo', 'systemd-run', '--unit=mu-browser-monitor-capture', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'eth0', '-Q', 'out', '-U', '-s', '96', '-w', '/var/lib/mu-monitor/physical.pcap', 'ip or ip6']);
  assert.match(await runtime.guest(current(), ['curl', '--fail', '--silent', '--max-time', '15', '--proxy', '', 'https://example.com/']), /Example Domain/);
  await finish(await manager.openBrowser(environment.id)); report.initialRendering = await draw('healthy'); viewer = await openViewer();
  const marker = `MU_MONITOR_SHELL_${randomBytes(6).toString('hex')}`, output: string[] = [];
  shell = new WebSocket(`${service.url.replace('http:', 'ws:')}/terminal?ticket=${terminal.issue(environment.id, 'shell')}`, { origin: service.url });
  shell.on('error', () => {}); shell.on('message', data => { const value = JSON.parse(data.toString()); if (value.type === 'data') output.push(value.data); });
  await until(() => terminal.children.has(environment!.id)); shell.send(JSON.stringify({ type: 'input', data: `printf '%s%s\\n' '${marker.slice(0, 12)}' '${marker.slice(12)}'\r` }));
  await until(() => output.join('').includes(marker)); report.actualTerminalConnected = true; report.actualTerminalCommandExecuted = true;
  const grant = await bridge.create(current(), project, false);
  assert.equal((await runtime.guest(current(), ['mu-host', grant.id, 'read', 'fixture.txt'])).trim(), 'MU_BROWSER_MONITOR_BRIDGE_OK'); report.actualGuestBridgeRead = true;
  await extraBrowser('mu-browser-monitor-unrelated', 'monitor-unrelated', 9224, false);
  let all: any;
  await until(async () => {
    all = JSON.parse(await admin(['sudo', 'python3', '-'], BROWSER_PROCESS_INSPECTION));
    return all.processes.some((process: any) => process.role === 'gpu-process' && process.seccomp === 0);
  }, 15_000);
  report.unrelatedUnprotectedProcesses = all.processes.filter((process: any) => process.role === 'gpu-process' && process.seccomp === 0);
  const baseline = report.inspections.length; await until(() => report.inspections.length >= baseline + 2, 25_000);
  assert.equal(current().state, 'running'); assert.equal(guestBrowser.running(environment.id), true); assert.equal(viewer.readyState, WebSocket.OPEN);
  report.unrelatedCgroupDoesNotQuarantine = true;
  console.log(new Date().toISOString(), 'Injecting unprotected graphics process into managed browser cgroup');
  report.faultStartedAt = new Date().toISOString(); const faultStarted = performance.now();
  const outstandingViewerTicket = guestBrowser.issue(environment.id).ticket, outstandingTerminalTicket = terminal.issue(environment.id, 'shell');
  await extraBrowser('mu-browser-monitor-fault', 'monitor-fault', 9225, true);
  await until(() => current().state === 'error', 45_000);
  report.quarantinedAfterMs = performance.now() - faultStarted;
  const invalid = report.inspections.filter((row: any) => Date.parse(row.at) >= Date.parse(report.faultStartedAt))
    .find((row: any) => { try { assertGuestBrowserSandbox(row.value); return false; } catch { return true; } });
  assert.ok(invalid); report.actualRejectedInspection = invalid;
  assert.ok(invalid.value.processes.some((process: any) => process.role === 'gpu-process' && process.seccomp === 0));
  assert.match(current().lastError ?? '', /浏览器进程防护检查/);
  await until(() => viewer!.readyState === WebSocket.CLOSED && shell!.readyState === WebSocket.CLOSED && !terminal.children.has(environment!.id));
  assert.equal(guestBrowser.tickets.has(outstandingViewerTicket), false); assert.equal(terminal.tickets.has(outstandingTerminalTicket), false);
  assert.equal(guestBrowser.running(environment.id), false); assert.equal(bridge.list(environment.id).length, 0);
  assert.ok((await runtime.list()).find(instance => instance.name === environment!.instanceName)?.status !== 'Running');
  report.automaticQuarantineRevokesViewerTerminalAndBridge = true;
  await assert.rejects(manager.assertAccess(environment.id));
  await assert.rejects(bridge.perform(grant.id, { operation: 'read', path: 'fixture.txt' }));
  console.log(new Date().toISOString(), 'Restarting VM for explicit recovery and saved physical capture');
  await finish(await manager.lifecycle(environment.id, 'start'));
  await admin(['sudo', 'test', '!', '-e', '/run/mucodesandbox-browser-secret/vnc']);
  await assert.rejects(runtime.guest(current(), ['mu-host', grant.id, 'read', 'fixture.txt']));
  const packetBytes = Buffer.from((await admin(['sudo', 'base64', '-w0', '/var/lib/mu-monitor/physical.pcap'], undefined, 60_000)).trim(), 'base64');
  const file = path.join(artifacts, 'physical-until-quarantine.pcap'); await writeFile(file, packetBytes, { mode: 0o600 });
  const allowed = `(tcp and dst host 192.168.5.2 and dst port ${proxyPort}) or (tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67)`;
  const count = async (filter: string) => (await runtime.runner('/usr/sbin/tcpdump', ['-nn', '-r', file, filter], { maxBytes: 64_000_000 })).split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line)).length;
  assert.equal(await count(`ip6 or (ip and not (${allowed}))`), 0); const approved = await count(`tcp and dst host 192.168.5.2 and dst port ${proxyPort}`); assert.ok(approved > 0);
  report.capture = { file: path.basename(file), bytes: packetBytes.length, sha256: hash(packetBytes), approvedProxyPackets: approved, unapprovedPackets: 0, proxyPort };
  await admin(['sudo', 'systemd-run', '--unit=mu-browser-monitor-page', '--uid=dev', '/usr/bin/python3', '-m', 'http.server', '18787', '--bind', '127.0.0.1', '--directory', '/tmp']);
  await finish(await manager.openBrowser(environment.id)); report.recoveryRendering = await draw('recovered');
  const recovered = guestBrowser.issue(environment.id); assert.ok(recovered.ticket !== outstandingViewerTicket); assert.ok(recovered.password);
  const after = report.inspections.length; await until(() => report.inspections.length >= after + 2, 25_000);
  assert.equal(current().state, 'running'); assert.equal((await runtime.networkProtection(current())).active, true);
  await manager.closeBrowser(environment.id); const closedBaseline = report.inspections.length;
  await new Promise(resolve => setTimeout(resolve, 9000)); assert.equal(report.inspections.length, closedBaseline); assert.equal(current().state, 'running');
  report.explicitRecoveryAndNormalCloseVerified = true; report.measurementCompleted = true; report.passed = true;
} catch (error) { report.error = (error as Error).stack; report.logs = manager.store.logs(environment?.id ?? null).slice(-20); process.exitCode = 1; }
finally {
  viewer?.terminate(); shell?.terminate();
  if (environment) await manager.lifecycle(environment.id, 'stop').then(finish).catch(error => { report.cleanupError = String(error); });
  await service.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve()));
  await rm(project, { recursive: true, force: true });
  if (report.passed && !report.cleanupError) {
    for (const instance of await runtime.list()) await runtime.command(['delete', '--force', instance.name], { timeoutMs: 60_000 });
    await rm(temporary, { recursive: true, force: true }); report.temporaryVmDataRemoved = true;
  } else report.retainedDataDir = temporary;
  for (const [file, expected] of Object.entries(report.testedFiles)) {
    const bytes = await readFile(path.join(root, file)); assert.equal(hash(bytes), expected, `Source changed during browser monitor test: ${file}`);
    const destination = path.join(artifacts, 'source', file); await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); await writeFile(destination, bytes, { mode: 0o600 });
  }
  for (const [file, expected] of Object.entries(report.packagedFiles ?? {})) {
    const bytes = await readFile(path.join(appRoot, 'dist-server/server', file)); assert.equal(hash(bytes), expected);
    await mkdir(path.join(artifacts, 'package'), { recursive: true, mode: 0o700 }); await writeFile(path.join(artifacts, 'package', file), bytes, { mode: 0o600 });
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'test-results', `${name}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, measurementCompleted: report.measurementCompleted, inspections: report.inspections.length, capture: report.capture, error: report.error }, null, 2));
}
