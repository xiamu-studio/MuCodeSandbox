import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import { connect, createServer as createGate, type Socket } from 'node:net';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { Manager as SourceManager } from '../server/manager.ts';
import type { Environment, Job } from '../shared/types.ts';
import { run } from '../server/process.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256, startTransparentScript } from '../server/transparent-network.ts';
import { createClaudeLocalFixture } from './claude-local-fixture.ts';
import { ProxyTransports } from '../server/proxy-transport.ts';
import { applyGuardScript, firewallRules, guestEnvironment } from '../server/network-guard.ts';

const root = path.resolve(import.meta.dirname, '..');
const portReuse = process.argv.includes('--port-reuse');
const probe = process.argv.includes('--probe');
const transportCandidate = process.argv.includes('--transport') || probe;
const sshProxy = process.argv.includes('--ssh-proxy');
const systemTun = process.argv.includes('--system-tun') || sshProxy;
assert.ok(!systemTun || portReuse, 'Experimental system stack is restricted to the port-reuse diagnostic');
const trace = process.argv.includes('--trace') || portReuse;
const diagnostics = process.argv.includes('--diagnostics') || trace;
const monitor = process.argv.includes('--monitor') || diagnostics || transportCandidate;
const reportName = probe ? (portReuse ? 'network-port-reuse-probe-candidate' : 'sustained-network-probe-candidate') : transportCandidate ? (portReuse ? 'network-port-reuse-transport-candidate' : 'sustained-network-transport-candidate') : portReuse ? (sshProxy ? 'network-port-reuse-ssh-diagnostic' : systemTun ? 'network-port-reuse-system-diagnostic' : 'network-port-reuse-diagnostic') : trace ? 'sustained-network-connection-trace' : diagnostics ? 'sustained-network-monitor-diagnostics' : monitor ? 'sustained-network-monitor' : 'sustained-network-latest';
const bundle = path.join(root, `release/${probe ? 'proxy-probe-candidate' : transportCandidate ? 'proxy-transport-guard-candidate' : monitor ? 'disk-recovery-monitor-candidate' : 'boot-capture-candidate'}/mac-arm64/MuCodeSandbox.app`);
const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
const { Manager }: { Manager: typeof SourceManager } = await import(pathToFileURL(path.join(compiled, 'manager.js')).href);
const owned = await mkdtemp(path.join(homedir(), '.mu-soak-'));
const artifacts = path.join(root, 'test-results', `${monitor ? reportName : 'sustained-network'}-${Date.now()}`);
await mkdir(artifacts, { mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const manager = new Manager(owned), runtime = manager.runtime;
const proxyTransports = new ProxyTransports(runtime.limaHome);
let relayPort: number | undefined;
let ownerWorker: ChildProcessWithoutNullStreams | undefined;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), accountFree: true, paidModelCalls: 0,
  diskRecoveryMonitorPackageTested: monitor,
  stableErrorDiagnosticsTested: diagnostics,
  connectionTraceTested: trace,
  proxyTransportCandidateTested: transportCandidate,
  bundle, artifactsDirectory: artifacts, stableDurationRequiredMs: 600_000, observations: [], captures: [],
  electronUiTested: false, browserTested: false, actualMacSleepTested: false, actualWifiSwitchTested: false,
  scope: 'Real VM using fixed packaged modules under Node; ten minutes total in two stable raw TCP stages plus controlled proxy outage, networkd renewal, tunnel quarantine and recovery; not twenty-four-hour acceptance' };
let current: Environment | undefined, captureActive = false, captureIndex = 0;
let hits = 0, ticks = 0, streams = 0;
const connectionEvents: Record<string, unknown>[] = [];
function connectionEvent(event: string, details: Record<string, unknown> = {}) {
  if (trace) connectionEvents.push({ event, at: new Date().toISOString(), ...details });
}
const sockets = new Set<Socket>();
const track = (socket: Socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); };
const target = createServer((req, res) => {
  connectionEvent('target-request', { path: req.url, remotePort: req.socket.remotePort });
  hits++; res.writeHead(200, { 'Content-Type': 'text/plain' });
  if (req.url !== '/stream') { res.end('MU_SUSTAINED_OK'); return; }
  streams++;
  const timer = setInterval(() => { ticks++; res.write('MU_TICK\n'); }, 250);
  res.once('close', () => clearInterval(timer));
});
target.on('connection', track);
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const fixture = await createClaudeLocalFixture({ browserPort: (target.address() as { port: number }).port });
const gateSockets = new Set<Socket>();
const gate = createGate(client => {
  const id = crypto.randomUUID();
  connectionEvent('gate-accept', { id, remoteAddress: client.remoteAddress, remotePort: client.remotePort, localPort: client.localPort });
  client.once('close', hadError => connectionEvent('gate-close', { id, hadError }));
  client.once('error', error => connectionEvent('gate-error', { id, error: String(error) }));
  gateSockets.add(client); track(client); client.once('close', () => gateSockets.delete(client));
  const upstream = connect(fixture.proxyPort, '127.0.0.1', () => { connectionEvent('gate-upstream-connected', { id, localPort: upstream.localPort }); client.pipe(upstream); upstream.pipe(client); });
  upstream.once('error', error => connectionEvent('gate-upstream-error', { id, error: String(error) }));
  gateSockets.add(upstream); track(upstream); upstream.once('close', () => gateSockets.delete(upstream));
  upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
});
await new Promise<void>(resolve => gate.listen(0, '127.0.0.1', resolve));
const proxyPort = (gate.address() as { port: number }).port;
const guest = (args: string[]) => runtime.guest(manager.store.get(current!.id), args, { timeoutMs: 20_000 });
const admin = (args: string[], input?: string) => runtime.management(manager.store.get(current!.id), args, { input, timeoutMs: 30_000 });
const status = () => runtime.networkProtection(manager.store.get(current!.id));
if (transportCandidate) {
  const transports = runtime.proxyTransports as any, original = transports.runner;
  transports.runner = async (file: string, args: string[], options: any) => {
    if (args.includes('-O') && args.includes('forward')) {
      const port = Number(args[args.indexOf('-R') + 1].split(':')[1]); assert.ok(port > 0);
      const uid = Number((await admin(['id', '-u', 'mu-net'])).trim());
      const kernel = JSON.parse(await admin(['sudo', 'nft', '-j', 'list', 'chain', 'inet', 'mu_egress', 'output']));
      const rules = kernel.nftables.filter((row: any) => row.rule).map((row: any) => row.rule.expr);
      const privateIndex = rules.findIndex((expr: any[]) => expr.some(row => 'drop' in row)
        && expr.some(row => row.match?.left?.payload?.protocol === 'tcp' && row.match.left.payload.field === 'dport' && row.match.right === port)
        && expr.some(row => row.match?.left?.meta?.key === 'skuid' && row.match.op === '!=' && row.match.right === uid));
      const loopbackIndex = rules.findIndex((expr: any[]) => expr.some(row => 'accept' in row)
        && expr.some(row => row.match?.left?.meta?.key === 'oifname' && row.match.right === 'lo'));
      assert.ok(privateIndex >= 0 && privateIndex < loopbackIndex, 'Private listener restriction must precede the loopback exception before SSH opens it');
      assert.equal((await admin(['ss', '-H', '-lnt', `sport = :${port}`])).trim(), '');
      (report.privateGuardBeforeForward ??= []).push({ port, uid, at: new Date().toISOString(), actualKernelRuleVerified: true, listenerAbsent: true });
    }
    return original(file, args, options);
  };
}
const request = () => guest(['curl', '--fail', '--silent', '--max-time', '3', '--proxy', '', 'http://203.0.113.81/tick']);
async function reserve() { const disk = await statfs(owned); assert.ok(disk.bavail * disk.bsize > 80 * 2 ** 30, 'Insufficient disk reserve'); }
async function until(check: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Sustained network observation timed out'); await delay(500); }
}
async function finish(job: Job) {
  await manager.tasks.get(job.id)?.promise;
  const done = manager.store.jobs().find(row => row.id === job.id)!;
  assert.equal(done.status, 'succeeded', done.message);
}
async function checkpoint(message: string) {
  console.log(new Date().toISOString(), message); report.progress = { message, at: new Date().toISOString() };
  await writeFile(path.join(root, 'test-results', `${reportName}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
}
async function bootCapture(name: string) {
  const bootId = (await admin(['cat', '/proc/sys/kernel/random/boot_id'])).trim();
  assert.equal((await admin(['sudo', 'cat', '/var/log/mucodesandbox/boot-network.boot-id'])).trim(), bootId);
  const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', '/var/log/mucodesandbox/boot-network.pcap'])).trim(), 'base64');
  await writeFile(path.join(artifacts, `${name}.pcap`), bytes, { mode: 0o600 });
  report.captures.push({ name, bootId, bytes: bytes.length, sha256: hash(bytes) });
}
async function startCapture() {
  await admin(['sudo', 'systemd-run', '--quiet', '--unit=mu-soak-capture', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', trace ? 'inout' : 'out', '-U', '-s', '128', '-w', transportCandidate ? '/var/log/mucodesandbox/sustained-network.pcap' : '/run/mu-soak.pcap', transportCandidate ? 'ip or ip6' : trace ? 'not (tcp port 22)' : 'not (tcp src port 22)']);
  captureActive = true; await delay(500);
}
async function stopCapture(alreadyStopped = false) {
  if (!captureActive) return;
  if (!alreadyStopped) await admin(['sudo', 'systemctl', 'stop', 'mu-soak-capture.service']); captureActive = false;
  const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', transportCandidate ? '/var/log/mucodesandbox/sustained-network.pcap' : '/run/mu-soak.pcap'])).trim(), 'base64');
  const name = `tasks-${++captureIndex}`; await writeFile(path.join(artifacts, `${name}.pcap`), bytes, { mode: 0o600 });
  report.captures.push({ name, bytes: bytes.length, sha256: hash(bytes) });
}
async function counters() {
  return JSON.parse(await guest(['python3', '-c', "import json,collections\nc=collections.Counter()\nfor line in open('/home/dev/mu-soak.jsonl'):\n try: c[json.loads(line)['kind']]+=1\n except ValueError: pass\nprint(json.dumps(c))"]));
}
async function startWorkload() {
  await admin(['bash', '-s'], `set -eu
sudo tee /usr/local/libexec/mu-soak-fixture >/dev/null <<'MU_PY'
#!/usr/bin/python3
import json,socket,threading,time
lock=threading.Lock()
def record(kind,error=None):
 with lock:
  row={'kind':kind,'at':time.monotonic(),'epoch':time.time()}
  if error is not None: row['error']={'type':type(error).__name__,'errno':error.errno,'message':str(error),'phase':getattr(error,'mu_phase','read')}
  with open('/home/dev/mu-soak.jsonl','a') as out: out.write(json.dumps(row)+'\\n')
def connection(path):
 s=socket.socket(socket.AF_INET,socket.SOCK_STREAM);s.settimeout(2)
 phase='connect'
 try:
  s.connect(('203.0.113.81',80));s.settimeout(3);phase='send'
  s.sendall(('GET '+path+' HTTP/1.0\\r\\nHost: fixture\\r\\n\\r\\n').encode());return s
 except OSError as error:
  error.mu_phase=phase;s.close();raise
def stream():
 while True:
  try:
   with connection('/stream') as s:
    for line in s.makefile('rb'):
     if line.strip()==b'MU_TICK': record('stream')
  except OSError as error: record('stream-error',error)
  time.sleep(.25)
threading.Thread(target=stream,daemon=True).start()
while True:
 try:
  with connection('/tick') as s:
   data=b''
   while True:
    chunk=s.recv(4096)
    if not chunk: break
    data+=chunk
   record('ok' if b'MU_SUSTAINED_OK' in data else 'invalid')
 except OSError as error: record('error',error)
 time.sleep(1)
MU_PY
sudo chmod 0755 /usr/local/libexec/mu-soak-fixture
sudo systemd-run --quiet --unit=mu-soak-workload --property=User=dev /usr/local/libexec/mu-soak-fixture
`);
  await until(async () => { const counts = await counters(); return counts.ok >= 3 && counts.stream >= 3; });
}
async function stable(name: string) {
  const started = Date.now(), before = await counters(), hostBefore = { hits, ticks };
  while (Date.now() - started < 300_000) {
    await delay(30_000); await reserve();
    assert.equal((await request()).trim(), 'MU_SUSTAINED_OK');
    const protection = await status(); assert.equal(protection.active, true); assert.equal(protection.integrity, 'verified');
    const counts = await counters(); assert.equal(counts.invalid ?? 0, 0);
    report.observations.push({ phase: name, at: new Date().toISOString(), elapsedMs: Date.now() - started, counts, hits, ticks,
      protection: { active: protection.active, integrity: protection.integrity, leaseActive: protection.leaseActive } });
    await checkpoint(`${name}: ${Math.floor((Date.now() - started) / 1000)} seconds, ${counts.ok} requests, ${counts.stream} stream messages`);
  }
  const after = await counters(); assert.ok(after.ok - before.ok >= 200); assert.ok(after.stream - before.stream >= 800);
  assert.ok(hits - hostBefore.hits >= 200 && ticks - hostBefore.ticks >= 800);
  if (diagnostics && ((after.error ?? 0) !== (before.error ?? 0) || (after['stream-error'] ?? 0) !== (before['stream-error'] ?? 0))) {
    report.failedStableStage = { name, elapsedMs: Date.now() - started, before, after };
    assert.fail(`Unexpected socket errors during ${name}; raw exception details preserved`);
  }
  return { name, elapsedMs: Date.now() - started, before, after, hostBefore, hostAfter: { hits, ticks } };
}
async function diagnosePortReuse() {
  if (transportCandidate) {
    const config = JSON.parse(await admin(['sudo', 'cat', '/etc/mucodesandbox/tunnel.json']));
    const relay = runtime.proxyTransports.entries.get(current!.id); assert.ok(relay);
    relayPort = relay.port;
    assert.equal(config.inbounds[0].stack, 'system');
    assert.equal(config.outbounds[0].server, '127.0.0.1'); assert.equal(config.outbounds[0].server_port, relayPort);
    report.productConfigurationTested = { tunStack: 'system', relayPort, targetIP: relay.targetIP, targetPort: relay.targetPort };
  }
  if (systemTun) {
    const environment = manager.store.get(current!.id);
    const config = JSON.parse(await admin(['sudo', 'cat', '/etc/mucodesandbox/tunnel.json']));
    assert.equal(config.inbounds[0].stack, 'gvisor');
    config.inbounds[0].stack = 'system';
    manager.active.set(environment.id, 'experimental-network-diagnostic');
    try {
      const marker = await (runtime as any).guardMarker(environment);
      if (sshProxy) {
        const relay = await proxyTransports.open(environment.id, environment.instanceName, '127.0.0.1', proxyPort);
        relayPort = relay.port; config.outbounds[0].server = '127.0.0.1'; config.outbounds[0].server_port = relay.port;
      }
      await runtime.management(environment, ['bash', '-s'], { input: startTransparentScript(config), timeoutMs: 60_000 });
      let expectedHash = marker.expectedHash, bootFileHash = marker.bootFileHash;
      if (relayPort) {
        const uid = Number((await admin(['id', '-u', 'mu-net'])).trim());
        const networkUid = Number((await admin(['id', '-u', 'systemd-network'])).trim());
        const relayEnvironment = { ...environment, network: { ...environment.network, port: relayPort } };
        const rules = firewallRules(['127.0.0.1'], relayPort, [], report.gateway, uid, networkUid, undefined, relayPort);
        await admin(['bash', '-s'], applyGuardScript(rules, [`127.0.0.1:${relayPort}`], guestEnvironment(relayEnvironment, ''), true));
        const inspected = await status(); expectedHash = inspected.firewallHash; bootFileHash = inspected.bootFileHash;
      }
      await (runtime as any).saveGuard(environment, true, false, expectedHash, bootFileHash, hash(Buffer.from(JSON.stringify(config))));
      assert.equal((await status()).active, true);
      report.experimentalConfiguration = { tunStack: 'system', sshProxy, relayPort, productDefaultChanged: false, protectionVerified: true };
    } finally { manager.active.delete(environment.id); }
  }
  const script = `import json,socket,time,sys
mode,host,port=sys.argv[1],sys.argv[2],int(sys.argv[3])
rows=[]
def attempt(source_port,label):
 s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.settimeout(2)
 row={'label':label,'sourcePort':source_port,'epoch':time.time(),'phase':'bind'}
 try:
  s.bind(('',source_port));row['phase']='connect';s.connect((host,port));row['phase']='read'
  if mode=='physical':
   s.sendall(b'CONNECT 203.0.113.81:80 HTTP/1.1\\r\\nHost: 203.0.113.81:80\\r\\nProxy-Authorization: Basic bXU6dHVpLWZpeHR1cmU=\\r\\n\\r\\n')
   data=b''
   while b'\\r\\n\\r\\n' not in data: data+=s.recv(4096)
   if b' 200 ' not in data: raise RuntimeError('Proxy CONNECT refused')
  s.sendall(b'GET /tick HTTP/1.0\\r\\nHost: fixture\\r\\n\\r\\n');data=b''
  while True:
   chunk=s.recv(4096)
   if not chunk: break
   data+=chunk
  row['ok']=b'MU_SUSTAINED_OK' in data
 except (OSError,RuntimeError) as e: row.update(ok=False,error=type(e).__name__,message=str(e))
 finally: s.close()
 rows.append(row)
for source in [46101,46103,46105]:
 attempt(source,'initial');time.sleep(2);attempt(source,'reuse-after-2s')
if any(not r['ok'] for r in rows):
 time.sleep(65)
 for source in [46101,46103,46105]: attempt(source,'reuse-after-time-wait')
print(json.dumps({'mode':mode,'rows':rows}))`;
  await startCapture();
  report.portReuse = [];
  for (const mode of ['tun', 'physical']) {
    await checkpoint(`Checking controlled source-port reuse at ${mode} layer`);
    const args = ['python3', '-c', script, mode, mode === 'tun' ? '203.0.113.81' : relayPort ? '127.0.0.1' : report.gateway, String(mode === 'tun' ? 80 : relayPort ?? proxyPort)];
    const output = mode === 'tun'
      ? await runtime.guest(manager.store.get(current!.id), args, { timeoutMs: 110_000 })
      : await runtime.management(manager.store.get(current!.id), ['sudo', '-u', 'mu-net', ...args], { timeoutMs: 110_000 });
    const result = JSON.parse(output);
    if (mode === 'physical' && relayPort) result.mode = 'ssh-loopback';
    assert.ok(result.rows.filter((row: any) => row.label === 'initial').every((row: any) => row.ok), 'Initial positive control failed');
    report.portReuse.push(result);
  }
  if (transportCandidate) {
    assert.ok(report.portReuse.every((layer: any) => layer.rows.length === 6 && layer.rows.every((row: any) => row.ok)), 'The candidate must pass every initial and reused connection');
    report.portReuseFixVerified = true;
  }
  if (relayPort) {
    const receipts = hits;
    await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '2', '--proxy', `http://mu:tui-fixture@127.0.0.1:${relayPort}`, 'http://203.0.113.81/tick']));
    assert.equal(hits, receipts);
    await assert.rejects(admin(['sudo', '-u', 'mu-net', 'curl', '--fail', '--silent', '--max-time', '2', '--proxy', '', `http://${report.gateway}:${proxyPort}/`]));
    report.developerRelayBypassRejected = true; report.physicalProxyExceptionRemoved = true;
    if (transportCandidate) await proveTransportOwnerDeath();
    await (transportCandidate ? runtime.proxyTransports : proxyTransports).close(current!.id);
    await until(async () => {
      if ((await runtime.list()).find(row => row.name === current!.instanceName)?.status === 'Stopped') return true;
      try { return !(await admin(['ss', '-H', '-lnt', `sport = :${relayPort}`])).trim(); }
      catch { return (await runtime.list()).find(row => row.name === current!.instanceName)?.status === 'Stopped'; }
    }, 10_000);
    await assert.rejects(request());
    report.transportClosureRemovedGuestListener = true;
    if (transportCandidate) {
      await until(async () => (await runtime.list()).find(row => row.name === current!.instanceName)?.status === 'Stopped');
      await Promise.all([...manager.quarantines.values()]);
      assert.equal(manager.store.get(current!.id).state, 'error'); report.transportFailureAutomaticallyQuarantined = true;
      await finish(await manager.lifecycle(current!.id, 'restart'));
      await bootCapture('transport-recovery-boot'); await stopCapture(true); await startCapture();
      assert.equal((await request()).trim(), 'MU_SUSTAINED_OK'); assert.equal((await status()).active, true);
      report.transportQuarantineRestartRecovered = true;
    }
  }
  await stopCapture();
  report.portReuseTimeoutReproduced = report.portReuse.some((layer: any) => layer.rows.some((row: any) => row.label === 'reuse-after-2s' && row.error === 'TimeoutError' && row.phase === 'connect'));
  report.stabilityPassed = false;
  report.scope = 'Controlled fixed source-port diagnostic at TUN and physical proxy layers; successful diagnostic execution does not mean network stability passed';
}
async function proveTransportOwnerDeath() {
  const environment = manager.store.get(current!.id);
  const ownerPort = Number((await admin(['python3', '-c', "import socket\nwith socket.socket() as s:\n s.bind(('127.0.0.1',0));print(s.getsockname()[1])"])).trim());
  const uid = Number((await admin(['id', '-u', 'mu-net'])).trim());
  await admin(['sudo', 'nft', '-f', '-'], `table inet mu_owner_test {\n chain output {\n  type filter hook output priority -1; policy accept;\n  ip daddr 127.0.0.1 tcp dport ${ownerPort} meta skuid != ${uid} drop\n }\n}\n`);
  const worker = spawn(process.execPath, [path.join(root, 'scripts/proxy-transport-owner.ts'), path.join(compiled, 'proxy-transport.js'), runtime.limaHome,
    environment.instanceName, String(proxyPort), String(ownerPort)], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  ownerWorker = worker; worker.stdin.on('error', () => {}); worker.stderr.resume();
  const info: any = await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('Proxy owner worker timed out')), 20_000);
    worker.stdout.on('data', data => { text += data.toString(); if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('close', () => { clearTimeout(timer); reject(new Error('Proxy owner worker closed early')); });
  });
  assert.equal(info.identity.port, ownerPort);
  await admin(['sudo', 'install', '-d', '-m', '0700', '-o', 'mu-net', '-g', 'mu-net', '/run/mu-owner-test']);
  const probe = `import socket\ns=socket.create_connection(('127.0.0.1',${ownerPort}),2);s.settimeout(8)\ns.sendall(b'CONNECT 203.0.113.81:80 HTTP/1.1\\r\\nHost: fixture\\r\\nProxy-Authorization: Basic bXU6dHVpLWZpeHR1cmU=\\r\\n\\r\\n')\ndata=b''\nwhile b'\\r\\n\\r\\n' not in data:\n chunk=s.recv(4096)\n if not chunk: raise RuntimeError('Unexpected proxy EOF')\n data+=chunk\ns.sendall(b'GET /stream HTTP/1.0\\r\\nHost: fixture\\r\\n\\r\\n')\ntry:\n while s.recv(4096): pass\nfinally:\n s.close()\n with open('/run/mu-owner-test/closed','w') as f: f.write('closed')\n`;
  const before = ticks;
  await admin(['sudo', 'systemd-run', '--quiet', '--unit=mu-owner-stream', '--property=User=mu-net', '/usr/bin/python3', '-c', probe]);
  await until(async () => ticks >= before + 2, 10_000);
  const closed = new Promise<void>(resolve => worker.once('close', () => resolve())); worker.kill('SIGKILL'); await closed; ownerWorker = undefined;
  await until(async () => { try { process.kill(info.sshPid, 0); return false; } catch (error: any) { assert.equal(error.code, 'ESRCH'); return true; } }, 10_000);
  await until(async () => !(await admin(['ss', '-H', '-lnt', `sport = :${ownerPort}`])).trim(), 10_000);
  await until(async () => { try { return (await admin(['sudo', 'cat', '/run/mu-owner-test/closed'])).trim() === 'closed'; } catch { return false; } }, 10_000);
  const stopped = ticks; await delay(1000); assert.equal(ticks, stopped);
  report.actualTransportOwnerSigkill = { ownerPid: worker.pid, sshPid: info.sshPid, listenerRemoved: true, activeStreamClosed: true, hostTicksStopped: true };
}
try {
  assert.ok((await statfs(owned)).bavail * (await statfs(owned)).bsize > 100 * 2 ** 30);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  report.packageCdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1];
  assert.equal(report.packageCdHash, probe ? '93781410161fcf4560c244ce5469b980ffc38976' : transportCandidate ? '7395e50362e01c36299c4eacabe0cbedb636cf22' : monitor ? 'b3b92b627f33d1b810011558fa4ba0c18cddd934' : 'b0cd06dd921a9ba759336fb39c8cb6e40e22fde4');
  const files = (await readdir(compiled)).filter(file => file.endsWith('.js')).sort();
  report.modules = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(path.join(compiled, file)))])));
  const cache = process.env.MU_TEST_SING_BOX_CACHE; assert.ok(cache); assert.equal(hash(await readFile(cache)), SING_BOX_SHA256);
  await mkdir(path.join(owned, 'tools/sing-box'), { recursive: true }); await copyFile(cache, path.join(owned, 'tools/sing-box', SING_BOX_ARCHIVE));
  current = await manager.create({ name: 'Disposable sustained network acceptance', cpus: 2, memoryGiB: 2, diskGiB: 10,
    network: { mode: 'http', host: '127.0.0.1', port: proxyPort, username: 'mu', password: 'tui-fixture', strict: true, transparent: true, noProxy: '' } });
  await checkpoint('Starting fresh protected VM with latest packaged modules');
  await finish(await manager.lifecycle(current.id, 'start'));
  const gateway = (await admin(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+) dev eth0/); assert.ok(gateway);
  assert.equal((await admin(['cat', '/sys/class/net/eth0/ifindex'])).trim(), '2'); report.gateway = gateway[1]; report.proxyPort = proxyPort;
  await bootCapture('first-boot'); fixture.restrictToLocalFixture();
  assert.equal((await request()).trim(), 'MU_SUSTAINED_OK');
  assert.equal((await guest(['bash', '-lc', 'printf "%s|%s|%s" "$HTTP_PROXY" "$HTTPS_PROXY" "$ALL_PROXY"'])).trim(), '||');
  if (portReuse) await diagnosePortReuse();
  else {
  await startCapture(); await startWorkload();
  report.stable = [await stable('before-fault')];
  await checkpoint('Disconnecting the actual proxy listener and all existing transport connections');
  for (const socket of gateSockets) socket.destroy(); await new Promise<void>(resolve => gate.close(() => resolve()));
  await assert.rejects(request()); await delay(4000);
  const stoppedCounts = await counters(), stoppedHost = { hits, ticks }; await delay(15_000);
  const blockedCounts = await counters(); assert.equal(blockedCounts.ok, stoppedCounts.ok); assert.equal(blockedCounts.stream, stoppedCounts.stream);
  assert.equal(hits, stoppedHost.hits); assert.equal(ticks, stoppedHost.ticks); assert.ok(blockedCounts.error > stoppedCounts.error);
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '2', '--proxy', '', '--interface', 'eth0', 'http://203.0.113.81/tick']));
  report.proxyOutage = { stoppedCounts, blockedCounts, stoppedHost, newAndExistingConnectionsBlocked: true, directBypassRejected: true };
  await new Promise<void>(resolve => gate.listen(proxyPort, '127.0.0.1', resolve));
  await until(async () => { try { return (await request()).trim() === 'MU_SUSTAINED_OK'; } catch { return false; } });
  report.proxyOutage.recoveredWithoutVmRestart = true;
  await admin(['bash', '-s'], 'set -eu\nsudo systemctl restart systemd-networkd\nsudo networkctl renew eth0\n');
  await until(async () => { try { return (await request()).trim() === 'MU_SUSTAINED_OK'; } catch { return false; } });
  await until(async () => (await status()).active); report.networkdRestartAndRenewRecovered = true;
  report.stable.push(await stable('after-recovery'));
  await stopCapture();
  await checkpoint('Stopping the tunnel service and observing automatic quarantine');
  await admin(['sudo', 'systemctl', 'stop', 'mucodesandbox-tunnel.service']);
  await assert.rejects(request());
  await until(async () => (await runtime.list()).find(row => row.name === current!.instanceName)?.status === 'Stopped');
  await Promise.all([...manager.quarantines.values()]); assert.equal(manager.store.get(current.id).state, 'error');
  report.tunnelFailureAutomaticallyQuarantined = true;
  await finish(await manager.lifecycle(current.id, 'restart')); await bootCapture('recovery-boot'); await startCapture();
  assert.equal((await request()).trim(), 'MU_SUSTAINED_OK'); assert.equal((await status()).active, true);
  report.restartAfterQuarantineRecovered = true; await stopCapture();
  await writeFile(path.join(artifacts, 'guest-requests.jsonl'), await guest(['cat', '/home/dev/mu-soak.jsonl']), { mode: 0o600 });
  report.hostReceipts = { hits, ticks, streams }; report.proxyDecisions = fixture.decisions;
  const localDecisions = fixture.decisions.filter(row => row.localOnly);
  assert.ok(localDecisions.filter(row => row.allowed).every(row => row.destination === '203.0.113.81:80'));
  const denied = localDecisions.filter(row => !row.allowed);
  assert.ok(denied.every(row => row.destination === '1.1.1.1:443'));
  report.controlledDnsRequestsDeniedByFixture = denied.length;
  report.successfulDomainResolutionTested = false;
  }
  for (const [file, expected] of Object.entries(report.modules)) assert.equal(hash(await readFile(path.join(compiled, file))), expected);
  report.passed = true;
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
finally {
  if (ownerWorker) { const closed = new Promise<void>(resolve => ownerWorker!.once('close', () => resolve())); ownerWorker.kill('SIGTERM'); await closed; }
  if (current) await proxyTransports.close(current.id);
  if (diagnostics && !report.passed && current) {
    await guest(['cat', '/home/dev/mu-soak.jsonl']).then(bytes => writeFile(path.join(artifacts, 'guest-requests.jsonl'), bytes, { mode: 0o600 }))
      .catch(error => { report.diagnosticReadError = String(error); });
  }
  if (captureActive) await stopCapture().catch(error => { report.captureError = String(error); report.passed = false; process.exitCode = 1; });
  await Promise.all([...manager.quarantines.values()]);
  if (current) {
    try { await finish(await manager.lifecycle(current.id, 'stop')); await finish(await manager.lifecycle(current.id, 'delete')); }
    catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
  }
  await manager.close();
  for (const row of await runtime.list()) {
    try { if (row.status === 'Running') await runtime.command(['stop', row.name], { timeoutMs: 120_000 }); await runtime.command(['delete', row.name], { timeoutMs: 120_000 }); }
    catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
  }
  for (const socket of sockets) socket.destroy();
  if (trace) await writeFile(path.join(artifacts, 'host-connections.json'), JSON.stringify(connectionEvents, null, 2), { mode: 0o600 });
  if (gate.listening) await new Promise<void>(resolve => gate.close(() => resolve()));
  await fixture.close(); await new Promise<void>(resolve => target.close(() => resolve()));
  if (!report.cleanupError) { assert.deepEqual(await runtime.list(), []); await rm(owned, { recursive: true }); report.testResourcesRemoved = true; }
  else report.retainedDataDirectory = owned;
  report.finishedAt = new Date().toISOString();
  report.sources = Object.fromEntries(await Promise.all(['scripts/verify-sustained-network.ts', 'scripts/claude-local-fixture.ts', ...(sshProxy || transportCandidate ? ['server/proxy-transport.ts', 'server/network-guard.ts'] : []), ...(transportCandidate ? ['scripts/proxy-transport-owner.ts'] : [])].map(async file => [file, hash(await readFile(path.join(root, file)))])));
  if (monitor) for (const file of Object.keys(report.sources)) await copyFile(path.join(root, file), path.join(artifacts, `source-${path.basename(file)}`));
  report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, hash(await readFile(path.join(artifacts, file)))])));
  const bytes = JSON.stringify(report, null, 2); await writeFile(path.join(root, 'test-results', `${reportName}.json`), bytes, { mode: 0o600 });
  await writeFile(path.join(artifacts, 'report.json'), bytes, { mode: 0o600 }); console.log(JSON.stringify({ passed: report.passed, error: report.error, cleanupError: report.cleanupError, finishedAt: report.finishedAt, artifacts }, null, 2));
}
