import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { createSecureContext, type TLSSocket } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { Manager as SourceManager } from '../server/manager.ts';
import { run } from '../server/process.ts';
import { LimaRuntime as SourceRuntime } from '../server/runtime.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';
import type { Job } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const transport = process.argv.includes('--transport');
const bundle = path.join(root, 'release/proxy-transport-guard-candidate/mac-arm64/MuCodeSandbox.app');
const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
const Manager: typeof SourceManager = transport ? (await import(pathToFileURL(path.join(compiled, 'manager.js')).href)).Manager : SourceManager;
const LimaRuntime: typeof SourceRuntime = transport ? (await import(pathToFileURL(path.join(compiled, 'runtime.js')).href)).LimaRuntime : SourceRuntime;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const retained = process.env.MU_ENCRYPTED_TEST_DATA;
if (retained) assert.ok(path.dirname(path.resolve(retained)) === homedir() && path.basename(retained).startsWith('.mu-encrypted-verification-'), 'Only this verifier\'s private retained directories may be reused');
const temporary = retained ? path.resolve(retained) : await mkdtemp(path.join(homedir(), '.mu-encrypted-verification-'));
const fixtureOnly = process.argv.includes('--fixture-only');
assert.ok(!transport || (!fixtureOnly && !retained), 'Frozen package regression needs a fresh real VM');
const reportName = transport ? 'encrypted-upstream-transport' : fixtureOnly ? 'encrypted-upstream-fixture' : 'encrypted-upstream';
const artifacts = path.join(root, 'test-results', transport ? `${reportName}-${Date.now()}` : 'encrypted-upstream');
const report: Record<string, any> = {
  passed: false, accountFree: true, paidModelCalls: 0, startedAt: new Date().toISOString(),
  scope: fixtureOnly ? 'host TLS fixture only; no VM acceptance' : 'actual isolated Linux VM with authenticated HTTPS CONNECT',
  proxyTransportPackageTested: transport, artifactsDirectory: artifacts,
};
const proxyName = 'mu-proxy.test';
const password = `mu-test-only-${randomBytes(18).toString('hex')}`;
const authorization = `Basic ${Buffer.from(`mu-encrypted:${password}`).toString('base64')}`;
const requestMarker = `MU_ENCRYPTED_REQUEST_${randomBytes(24).toString('hex')}`;
const responseMarker = `MU_ENCRYPTED_RESPONSE_${randomBytes(24).toString('hex')}`;
const fixtureAddress = '203.0.113.10:80';
const sockets = new Set<Duplex>();
const receipts: { path: string; address: string | undefined; expectedBody: boolean }[] = [];
const serverNames: string[] = [];
const protocols: string[] = [];
let proxyConnections = 0;
let authenticationRejections = 0;
let successfulConnects = 0;
let manager: SourceManager | undefined;
let environmentId = '';
let target: ReturnType<typeof createHttpServer> | undefined;
let proxy: ReturnType<typeof createHttpsServer> | undefined;
let proxyPort = 0;
let targetPort = 0;

async function certificateFixtures() {
  const directory = path.join(temporary, 'tls-fixture');
  await mkdir(directory, { mode: 0o700, recursive: true });
  for (const name of ['ca', 'wrong-ca']) {
    await run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', `/CN=Mu encrypted ${name}`, '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', path.join(directory, `${name}.key`), '-out', path.join(directory, `${name}.crt`)], { timeoutMs: 30_000 });
  }
  await run('/usr/bin/openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', `/CN=${proxyName}`, '-keyout', path.join(directory, 'proxy.key'), '-out', path.join(directory, 'proxy.csr')], { timeoutMs: 30_000 });
  const extensions = path.join(directory, 'leaf.extensions');
  await writeFile(extensions, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${proxyName}\n`, { mode: 0o600 });
  await run('/usr/bin/openssl', ['x509', '-req', '-in', path.join(directory, 'proxy.csr'), '-CA', path.join(directory, 'ca.crt'), '-CAkey', path.join(directory, 'ca.key'), '-CAcreateserial', '-days', '1', '-sha256', '-extfile', extensions, '-out', path.join(directory, 'proxy.crt')], { timeoutMs: 30_000 });
  return {
    ca: await readFile(path.join(directory, 'ca.crt'), 'utf8'),
    wrongCa: await readFile(path.join(directory, 'wrong-ca.crt'), 'utf8'),
    cert: await readFile(path.join(directory, 'proxy.crt'), 'utf8'),
    key: await readFile(path.join(directory, 'proxy.key'), 'utf8'),
  };
}

function track(socket: Duplex) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }
async function closeProxy() {
  for (const socket of sockets) socket.destroy();
  if (proxy?.listening) await new Promise<void>(resolve => proxy!.close(() => resolve()));
}

async function hostConnect(ca: string, serverName = proxyName, credentials = authorization) {
  return new Promise<string>((resolve, reject) => {
    const request = httpsRequest({ hostname: '127.0.0.1', port: proxyPort, servername: serverName, ca, method: 'CONNECT', path: fixtureAddress, headers: { Host: fixtureAddress, 'Proxy-Authorization': credentials }, timeout: 8000 });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('TLS fixture timeout')));
    request.on('connect', (response, socket, head) => {
      track(socket);
      if (response.statusCode !== 200) { socket.destroy(); reject(new Error(`TLS fixture CONNECT returned ${response.statusCode}`)); return; }
      let output = head.toString();
      socket.setTimeout(8000, () => socket.destroy(new Error('TLS fixture response timeout')));
      socket.on('data', data => { output += data.toString(); });
      socket.on('error', reject);
      socket.on('end', () => resolve(output));
      socket.write(`POST /host-positive HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(requestMarker)}\r\n\r\n${requestMarker}`);
    });
    request.end();
  });
}

async function finish(job: Job) {
  await manager!.tasks.get(job.id)?.promise;
  const completed = manager!.store.jobs().find(item => item.id === job.id)!;
  if (completed.status !== 'succeeded') report.logs = manager!.store.logs(environmentId).slice(-20);
  assert.equal(completed.status, 'succeeded', completed.message);
}
const guest = (command: string[], timeoutMs = 30_000) => manager!.runtime.guest(manager!.store.get(environmentId), command, { timeoutMs });
const management = (command: string[], options: { input?: string; timeoutMs?: number } = {}) => manager!.runtime.management(manager!.store.get(environmentId), command, { timeoutMs: 30_000, ...options });
const fixtureRequest = (label: string) => guest(['curl', '--fail', '--silent', '--show-error', '--max-time', '6', '--proxy', '', '--noproxy', '*', '--data-binary', requestMarker, `http://203.0.113.10/${label}`]);

async function captureStart(label: string) {
  await management(['sudo', 'systemd-run', `--unit=mu-encrypted-capture-${label}`, '--property=Type=exec', '--property=TimeoutStopSec=10', '--property=StandardOutput=null', '--property=StandardError=journal', '/usr/bin/tcpdump', '-ni', 'eth0', '--immediate-mode', '-U', '-s', '0', '-c', '10000', '-w', `/tmp/mu-encrypted-${label}.pcap`, 'ip or ip6']);
  await management(['sleep', '1']);
  await management(['sudo', 'systemctl', 'is-active', `mu-encrypted-capture-${label}.service`]);
}

async function captureStop(label: string, gateway: string, encrypted: boolean) {
  // Let the final packet arrive before stopping and flushing libpcap's writer.
  await management(['sleep', '1']);
  await management(['sudo', 'systemctl', 'stop', `mu-encrypted-capture-${label}.service`]);
  const file = `/tmp/mu-encrypted-${label}.pcap`;
  const encoded = (await management(['sudo', 'python3', '-c', 'import base64,pathlib,sys;print(base64.b64encode(pathlib.Path(sys.argv[1]).read_bytes()).decode())', file], { timeoutMs: 30_000 })).trim();
  const bytes = Buffer.from(encoded, 'base64');
  assert.ok(bytes.length > 24, 'Packet capture is empty');
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, `${label}.pcap`), bytes, { mode: 0o600 });
  const packetLines = (text: string) => text.split('\n').filter(line => /^\d\d:\d\d:\d\d/.test(line));
  if (encrypted) {
    const unexpected = await management(['sudo', 'tcpdump', '-nn', '-r', file, `${transport ? '' : `not (tcp and port ${proxyPort} and host ${gateway}) and `}not (tcp and port 22 and host ${gateway}) and not (udp and ((src port 68 and dst port 67) or (src port 67 and dst port 68)))`]);
    assert.deepEqual(packetLines(unexpected), [], unexpected);
    const approved = await management(['sudo', 'tcpdump', '-nn', '-r', file, transport ? `tcp src port 22 and dst host ${gateway}` : `tcp dst port ${proxyPort} and dst host ${gateway}`]);
    assert.ok(packetLines(approved).length > 0, 'No approved transport packet captured');
    if (transport) assert.equal(packetLines(await management(['sudo', 'tcpdump', '-nn', '-r', file, `tcp and port ${proxyPort} and host ${gateway}`])).length, 0);
    for (const value of [requestMarker, responseMarker, password, authorization, Buffer.from(`mu-encrypted:${password}`).toString('base64')])
      assert.equal(bytes.includes(Buffer.from(value)), false, 'Test plaintext or proxy credential was visible on the physical interface');
    return { bytes: bytes.length, approvedProxyPackets: transport ? 0 : packetLines(approved).length, approvedSshPackets: transport ? packetLines(approved).length : undefined, capturedBothDirections: true, onlyProxySshDhcp: true, testPlaintextAndCredentialsAbsent: true };
  }
  assert.ok(bytes.includes(Buffer.from(requestMarker)), 'Cleartext positive control did not capture the request marker');
  assert.ok(bytes.includes(Buffer.from(responseMarker)), 'Cleartext positive control did not capture the response marker');
  return { bytes: bytes.length, cleartextRequestAndResponseVisible: true };
}

try {
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  if (transport) {
    const disk = await statfs(temporary); assert.ok(disk.bavail * disk.bsize > 100 * 2 ** 30);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    report.packageCdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1];
    assert.equal(report.packageCdHash, '7395e50362e01c36299c4eacabe0cbedb636cf22'); report.bundle = bundle;
    report.modules = Object.fromEntries(await Promise.all((await readdir(compiled)).filter(file => file.endsWith('.js')).map(async file => [file, hash(await readFile(path.join(compiled, file)))])));
    const cache = process.env.MU_TEST_SING_BOX_CACHE; assert.ok(cache); assert.equal(hash(await readFile(cache)), SING_BOX_SHA256);
    await mkdir(path.join(temporary, 'tools/sing-box'), { recursive: true }); await copyFile(cache, path.join(temporary, 'tools/sing-box', SING_BOX_ARCHIVE));
  }
  const certificates = await certificateFixtures();
  target = createHttpServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      receipts.push({ path: req.url ?? '', address: req.socket.remoteAddress, expectedBody: body === requestMarker });
      res.setHeader('Connection', 'close'); res.end(responseMarker);
    });
  });
  target.on('connection', track);
  await new Promise<void>(resolve => target!.listen(0, '127.0.0.1', resolve));
  targetPort = (target.address() as { port: number }).port;
  const context = createSecureContext({ cert: certificates.cert, key: certificates.key, minVersion: 'TLSv1.2' });
  proxy = createHttpsServer({ cert: certificates.cert, key: certificates.key, minVersion: 'TLSv1.2', SNICallback: (name, callback) => { serverNames.push(name); callback(null, context); } }, (_req, res) => { res.writeHead(405); res.end(); });
  proxy.on('connection', socket => { proxyConnections++; track(socket); });
  proxy.on('secureConnection', socket => { protocols.push((socket as TLSSocket).getProtocol() ?? 'unknown'); });
  proxy.on('tlsClientError', () => {});
  proxy.on('connect', (req, client, head) => {
    track(client);
    if (req.headers['proxy-authorization'] !== authorization) { authenticationRejections++; client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Mu synthetic TLS fixture"\r\nConnection: close\r\n\r\n'); return; }
    if (req.url !== fixtureAddress) { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    successfulConnects++;
    const remote = connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote); remote.pipe(client);
    });
    track(remote);
    remote.on('error', () => client.destroy()); client.on('error', () => remote.destroy()); client.on('close', () => remote.destroy());
  });
  await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', resolve));
  proxyPort = (proxy.address() as { port: number }).port;
  assert.match(await hostConnect(certificates.ca), new RegExp(responseMarker));
  assert.ok(receipts.at(-1)?.expectedBody);
  await assert.rejects(hostConnect(certificates.wrongCa));
  await assert.rejects(hostConnect(certificates.ca, 'wrong-proxy.test'));
  await assert.rejects(hostConnect(certificates.ca, proxyName, 'Basic incorrect'));
  assert.ok(serverNames.includes(proxyName) && authenticationRejections > 0);
  report.hostTlsAndAuthenticationPositiveControls = true;
  if (!fixtureOnly) {
    process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
    manager = new Manager(temporary, undefined, new LimaRuntime(temporary));
    const tlsNetwork = (options: { certificate?: string; serverName?: string; password?: string } = {}) => ({
      mode: 'https', host: '127.0.0.1', port: proxyPort, username: 'mu-encrypted', password: options.password ?? password,
      noProxy: '', strict: true, transparent: true,
      tls: { serverName: options.serverName ?? proxyName, certificate: options.certificate ?? certificates.ca },
    });
    const e = await manager.create({ name: 'Encrypted upstream verification', cpus: 2, memoryGiB: 2, diskGiB: 10, identity: { timezone: 'UTC', locale: 'en-US' }, network: tlsNetwork() });
    environmentId = e.id;
    console.log('Starting a disposable protected VM with an authenticated TLS upstream.');
    await finish(await manager.lifecycle(environmentId, 'start'));
    const status = await manager.runtime.networkProtection(manager.store.get(environmentId));
    assert.ok(status.active && status.transparentActive && status.integrity === 'verified');
    report.initialProtection = status;
    const gateway = (await guest(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+)/)?.[1];
    assert.ok(gateway);
    await captureStart('valid');
    const before = receipts.length; const namesBefore = serverNames.length; const connectsBefore = successfulConnects;
    assert.equal((await fixtureRequest('valid')).trim(), responseMarker);
    assert.equal(receipts.length, before + 1);
    assert.equal(receipts.at(-1)?.path, '/valid'); assert.ok(receipts.at(-1)?.expectedBody);
    assert.ok(serverNames.slice(namesBefore).includes(proxyName)); assert.ok(successfulConnects > connectsBefore);
    report.plainHttpApplicationUsesAuthenticatedTlsProxy = true;
    const directBefore = receipts.length;
    await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--proxy', '', `http://${gateway}:${targetPort}/unapproved-direct`]));
    assert.equal(receipts.length, directBefore);
    report.validCapture = await captureStop('valid', gateway, true);
    report.directBypassDenied = true;
    async function configuration(network: unknown) {
      await finish(await manager!.lifecycle(environmentId, 'stop'));
      const saved = manager!.store.get(environmentId);
      await manager!.update(environmentId, { name: saved.name, cpus: saved.cpus, memoryGiB: saved.memoryGiB, diskGiB: saved.diskGiB, identity: saved.identity, network });
      await finish(await manager!.lifecycle(environmentId, 'start'));
    }
    for (const variant of [
      { label: 'wrong-ca', network: tlsNetwork({ certificate: certificates.wrongCa }) },
      { label: 'wrong-name', network: tlsNetwork({ serverName: 'wrong-proxy.test' }) },
      { label: 'wrong-credentials', network: tlsNetwork({ password: 'wrong-synthetic-password' }) },
    ]) {
      console.log(`Checking fail-closed behavior: ${variant.label}.`);
      await configuration(variant.network);
      const hits = receipts.length; const attempts = proxyConnections; const authErrors = authenticationRejections;
      await captureStart(variant.label);
      await assert.rejects(fixtureRequest(variant.label));
      assert.equal(receipts.length, hits);
      assert.ok(proxyConnections > attempts, 'Failure case never reached the TLS proxy');
      if (variant.label === 'wrong-name') assert.ok(serverNames.includes('wrong-proxy.test'));
      if (variant.label === 'wrong-credentials') assert.ok(authenticationRejections > authErrors);
      await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--proxy', '', `http://${gateway}:${targetPort}/${variant.label}-direct`]));
      assert.equal(receipts.length, hits);
      report[variant.label] = { failedClosed: true, capture: await captureStop(variant.label, gateway, true) };
    }
    await configuration(tlsNetwork());
    assert.equal((await fixtureRequest('recovered')).trim(), responseMarker);
    report.correctConfigurationRecovers = true;
    await captureStart('proxy-loss');
    await closeProxy();
    const hits = receipts.length;
    await assert.rejects(fixtureRequest('proxy-loss'));
    await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--proxy', '', `http://${gateway}:${targetPort}/after-proxy-loss-direct`]));
    assert.equal(receipts.length, hits);
    report.proxyLoss = { failedClosed: true, capture: await captureStop('proxy-loss', gateway, true) };
    console.log('Running a separate, explicitly unprotected cleartext capture positive control.');
    await configuration({ mode: 'direct', host: '', port: proxyPort, username: '', password: '', noProxy: '', strict: false, transparent: false });
    assert.equal((await manager.runtime.networkProtection(manager.store.get(environmentId))).firewallActive, false);
    await captureStart('cleartext-positive');
    assert.equal((await guest(['curl', '--fail', '--silent', '--max-time', '6', '--proxy', '', '--data-binary', requestMarker, `http://${gateway}:${targetPort}/cleartext-positive`])).trim(), responseMarker);
    report.cleartextCapturePositiveControl = await captureStop('cleartext-positive', gateway, false);
    report.actualLinuxVmVerified = true;
    await finish(await manager.lifecycle(environmentId, 'stop'));
  }
  report.tlsProtocols = [...new Set(protocols)];
  report.tlsServerNames = [...new Set(serverNames)];
  report.successfulConnects = successfulConnects;
  report.authenticationRejections = authenticationRejections;
  report.destinationReceipts = receipts.map(receipt => ({ path: receipt.path, sourceAddress: receipt.address, expectedBody: receipt.expectedBody }));
  if (transport) {
    await writeFile(path.join(artifacts, 'test-markers.json'), JSON.stringify({ requestMarker, responseMarker, password, authorization }), { mode: 0o600 });
    for (const [file, expected] of Object.entries(report.modules)) assert.equal(hash(await readFile(path.join(compiled, file))), expected);
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
  if (manager && environmentId) report.logs = manager.store.logs(environmentId).slice(-25);
} finally {
  await closeProxy();
  for (const socket of sockets) socket.destroy();
  if (target?.listening) await new Promise<void>(resolve => target!.close(() => resolve()));
  const keep = !report.passed && !!process.env.MU_KEEP_FAILED_ENCRYPTED;
  if (manager) {
    if (keep) {
      if (environmentId) await manager.runtime.command(['stop', '--force', manager.store.get(environmentId).instanceName], { timeoutMs: 120_000 }).catch(error => { report.cleanupError = String(error); });
    } else {
      for (const instance of await manager.runtime.list().catch(() => [])) await manager.runtime.command(['delete', '--force', instance.name], { timeoutMs: 120_000 }).catch(error => { report.cleanupError = String(error); });
    }
    await manager.close();
  }
  if (keep || report.cleanupError) report.retainedDataDir = temporary;
  else { await rm(temporary, { recursive: true, force: true }); report.testResourcesRemoved = true; }
  if (report.cleanupError) { report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  if (transport) {
    report.sources = { 'scripts/verify-encrypted-upstream.ts': hash(await readFile(path.join(root, 'scripts/verify-encrypted-upstream.ts'))) };
    await copyFile(path.join(root, 'scripts/verify-encrypted-upstream.ts'), path.join(artifacts, 'source-verify-encrypted-upstream.ts'));
    report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, hash(await readFile(path.join(artifacts, file)))])));
    await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results', `${reportName}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
