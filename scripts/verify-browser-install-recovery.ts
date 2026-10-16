import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../server/service.ts';
import { ensureGuestBrowser, GUEST_CHROMIUM_SHA256, GUEST_CHROMIUM_VERSION, inspectGuestBrowserSandbox } from '../server/guest-browser-runtime.ts';
import { browserInstallTransactionScript, RECOVER_BROWSER_INSTALL_SCRIPT } from '../server/browser-install-transaction.ts';
import { CURRENT_BROWSER_RELEASE } from '../server/browser-releases.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';
import type { Environment, Job } from '../shared/types.ts';
import { createClaudeLocalFixture } from './claude-local-fixture.ts';
import { backupBrowserFixture, backupBrowserReceipt, validateBackupBrowser } from './backup-browser-fixture.ts';

const root = path.resolve(import.meta.dirname, '..');
const owned = await mkdtemp(path.join(homedir(), '.mu-browser-install-test-'));
const artifacts = path.join(root, 'test-results', `browser-install-recovery-${Date.now()}`); await mkdir(artifacts, { mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const browserFixture = backupBrowserFixture('http://203.0.113.81');
const server = createServer(browserFixture.handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const fixture = await createClaudeLocalFixture({ browserPort: (server.address() as { port: number }).port });
const service = await createService({ rootDir: root, port: 0, dataDir: owned });
const manager = service.manager, runtime = manager.runtime;
const release = CURRENT_BROWSER_RELEASE;
assert.equal(release.format, 'deb', 'This run must cover the official stable Debian package');
const recipe = release.recipe;
const controlledArchive = `/var/lib/mucodesandbox/browser-install/archive.${release.format}`;
const target = `/opt/mucodesandbox/chromium-${GUEST_CHROMIUM_VERSION}`;
const executable = `${target}/chrome-linux-arm64/chrome`;
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), accountFree: true, paidModelCalls: 0,
  sourceRuntimeTested: true, electronPackageTested: false, actualVersionUpgradeTested: false,
  release: { version: release.version, format: release.format, sha256: release.sha256, recipe },
  scope: 'Official stable ARM64 Debian same-version binary repair, actual installer process SIGKILL recovery, synthetic profile persistence, sandbox and guest network capture',
  stages: [], artifactsDirectory: artifacts };
let current: Environment | undefined, captureRunning = false;
const admin = (args: string[], input?: string) => runtime.management(current!, args, { input, timeoutMs: 30_000 });
async function finish(job: Job) {
  await manager.tasks.get(job.id)?.promise;
  const row = manager.store.jobs().find(row => row.id === job.id)!;
  if (row.status !== 'succeeded') report.logs = manager.store.logs(current!.id).slice(-20);
  assert.equal(row.status, 'succeeded', row.message); current = manager.store.get(current!.id);
}
async function checkpoint(stage: string) {
  const disk = await statfs(owned); assert.ok(disk.bavail * disk.bsize > 80 * 2 ** 30);
  report.progress = { stage, at: new Date().toISOString() }; console.log(stage);
  await writeFile(path.join(root, 'test-results/browser-install-recovery.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
}
async function verifyBrowser(stage: string, first = false) {
  await finish(await manager.openBrowser(current!.id));
  const { receipt, entry, session } = await backupBrowserReceipt(service, current!.id); validateBackupBrowser(receipt);
  if (!first) assert.deepEqual(receipt.before, receipt.after);
  assert.equal(browserFixture.evidence.loginRequests, 1);
  const pixels = await entry.tools!.send('Runtime.evaluate', { expression: `JSON.stringify((()=>{const c=document.createElement('canvas');c.width=64;c.height=64;const x=c.getContext('2d');x.fillStyle='#27a36f';x.fillRect(0,0,64,64);x.fillStyle='#ea4b72';x.fillRect(16,16,32,32);return {green:[...x.getImageData(0,0,1,1).data],red:[...x.getImageData(32,32,1,1).data]};})())`, returnByValue: true }, session);
  const rendered = JSON.parse(pixels.result.value); assert.deepEqual(rendered.green, [39, 163, 111, 255]); assert.deepEqual(rendered.red, [234, 75, 114, 255]);
  const sandbox = await inspectGuestBrowserSandbox(runtime, current!); const protection = await runtime.networkProtection(current!);
  assert.ok(protection.active && protection.integrity === 'verified');
  const screenshot = await entry.tools!.send('Page.captureScreenshot', { format: 'png' }, session);
  await writeFile(path.join(artifacts, `${stage}.png`), Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
  report.stages.push({ stage, receipt, rendered, sandbox, protection }); await manager.closeBrowser(current!.id);
}
try {
  const disk = await statfs(owned); assert.ok(disk.bavail * disk.bsize > 100 * 2 ** 30);
  const cached = process.env.MU_TEST_BROWSER_CACHE ?? path.join(homedir(), '.mucodesandbox/tools/guest-browser', `chrome-${GUEST_CHROMIUM_VERSION}-linux-arm64.${release.format}`);
  assert.equal(hash(await readFile(cached)), GUEST_CHROMIUM_SHA256);
  const cache = path.join(owned, 'tools/guest-browser'); await mkdir(cache, { recursive: true });
  await copyFile(cached, path.join(cache, `chrome-${GUEST_CHROMIUM_VERSION}-linux-arm64.${release.format}`));
  const singBoxCache = process.env.MU_TEST_SING_BOX_CACHE ?? path.join(homedir(), '.mucodesandbox/tools/sing-box', SING_BOX_ARCHIVE);
  assert.equal(hash(await readFile(singBoxCache)), SING_BOX_SHA256);
  const tunnelCache = path.join(owned, 'tools/sing-box'); await mkdir(tunnelCache, { recursive: true }); await copyFile(singBoxCache, path.join(tunnelCache, SING_BOX_ARCHIVE));
  current = await manager.create({ name: 'Stable Debian browser installation recovery test', cpus: 4, memoryGiB: 4, diskGiB: 10,
    browserUrl: 'http://203.0.113.81/write', identity: { timezone: 'Asia/Tokyo', locale: 'ja-JP' },
    network: { mode: 'http', host: '127.0.0.1', port: fixture.proxyPort, username: 'mu', password: 'tui-fixture', strict: true, transparent: true, noProxy: '' } });
  await checkpoint('Starting protected browser installation recovery VM'); await finish(await manager.lifecycle(current.id, 'start'));
  await checkpoint('Installing official browser using staged transaction'); await verifyBrowser('initial', true);
  await finish(await manager.lifecycle(current.id, 'stop'));
  const { id: _id, instanceName: _instance, state: _state, lastError: _error, createdAt: _created, updatedAt: _updated, browserRunning: _browser, ...config } = current;
  const { passwordConfigured: _configured, ...network } = config.network;
  current = await manager.update(current.id, { ...config, network: { ...network, password: 'tui-fixture' }, browserUrl: 'http://203.0.113.81/read' });
  await finish(await manager.lifecycle(current.id, 'start')); fixture.restrictToLocalFixture();
  const transport = runtime.proxyTransports.entries.get(current.id);
  assert.ok(transport && runtime.proxyTransports.matches(current.id, transport));
  assert.equal(transport.targetIP, '127.0.0.1'); assert.equal(transport.targetPort, fixture.proxyPort);
  report.proxyTransport = { port: transport.port, targetIP: transport.targetIP, targetPort: transport.targetPort };
  await admin(['sudo', 'systemd-run', '--quiet', '--unit=mu-browser-install-capture', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', '/run/mu-browser-install.pcap']); captureRunning = true;
  await admin(['sudo', 'touch', `${target}/preserved-canary`]);
  await runtime.command(['copy', cached, `${current.instanceName}:/tmp/mu-install-test.${release.format}`], { timeoutMs: 90_000 });
  await admin(['sudo', 'install', '-d', '-m', '0700', '/var/lib/mucodesandbox/browser-install']);
  await admin(['sudo', 'install', '-m', '0600', `/tmp/mu-install-test.${release.format}`, controlledArchive]);
  const script = browserInstallTransactionScript(GUEST_CHROMIUM_VERSION, recipe, controlledArchive, release.format);
  const originalPolicy = await admin(['sudo', 'cat', '/etc/apparmor.d/mucodesandbox-chromium']);
  const originalBinary = (await admin(['sha256sum', executable])).split(' ')[0];
  await checkpoint('Rejecting extraction failure without replacing the existing official binary');
  const failUnpack = script.replace("process = subprocess.Popen(['dpkg-deb', '--fsys-tarfile', str(private_archive)], stdout=subprocess.PIPE)", "raise RuntimeError('MU_TEST_EXTRACTION_FAILURE')");
  assert.notEqual(failUnpack, script, 'The Debian extraction failure must actually be injected');
  await assert.rejects(admin(['bash', '-s'], failUnpack), /MU_TEST_EXTRACTION_FAILURE/);
  assert.equal((await admin(['sha256sum', executable])).split(' ')[0], originalBinary); await admin(['test', '-f', `${target}/preserved-canary`]);
  assert.equal((await admin(['sudo', 'cat', '/var/lib/mucodesandbox/browser-recipe'])).trim(), recipe); report.extractionFailureRetainsPrevious = true;
  for (const stage of ['prepared', 'backed-up', 'switched', 'configured', 'committed']) {
    await checkpoint('Injecting actual installer SIGKILL at ' + stage);
    let output = '', processId: number | undefined;
    const stop = `print('MU_TEST_INSTALL_PID', os.getpid(), flush=True)\n        os.kill(os.getpid(), 19)`;
    const instrumented = script.replace(`print('MU_BROWSER_INSTALL_STAGE ${stage}', flush=True)`, `print('MU_BROWSER_INSTALL_STAGE ${stage}', flush=True)\n        ${stop}`);
    assert.notEqual(instrumented, script);
    const running = runtime.management(current!, ['bash', '-s'], { input: instrumented, timeoutMs: 120_000,
      onOutput: value => { output += value; const match = output.match(/MU_TEST_INSTALL_PID (\d+)/); if (match) processId = Number(match[1]); } });
    const result = running.then(() => ({ succeeded: true }), error => ({ error: String(error) }));
    try {
      const deadline = Date.now() + 90_000;
      while (!processId) { assert.ok(Date.now() < deadline, 'Installer checkpoint timed out'); await delay(100); }
      const processState = JSON.parse(await admin(['sudo', 'python3', '-c', `import json,pathlib; p=pathlib.Path('/proc/${processId}'); s=dict(x.split(':',1) for x in (p/'status').read_text().splitlines() if ':' in x); print(json.dumps({'state':s['State'].strip(),'exe':str((p/'exe').readlink())}))`]));
      assert.match(processState.state, /^T/); assert.match(processState.exe, /python3/);
      const journal = JSON.parse(await admin(['sudo', 'cat', '/var/lib/mucodesandbox/browser-install-transaction.json']));
      assert.equal(journal.committed, stage === 'committed');
      await admin(['sudo', 'kill', '-KILL', String(processId)]); const outcome = await result; assert.ok('error' in outcome);
      await admin(['bash', '-s'], RECOVER_BROWSER_INSTALL_SCRIPT);
      assert.equal((await admin(['sha256sum', executable])).split(' ')[0], originalBinary);
      assert.equal(await admin(['sudo', 'cat', '/etc/apparmor.d/mucodesandbox-chromium']), originalPolicy);
      assert.equal((await admin(['sudo', 'cat', '/var/lib/mucodesandbox/browser-recipe'])).trim(), recipe);
      await assert.rejects(admin(['sudo', 'test', '-e', '/var/lib/mucodesandbox/browser-install-transaction.json']));
      const canary = await admin(['test', '-f', `${target}/preserved-canary`]).then(() => true, () => false); assert.equal(canary, stage !== 'committed');
      report.stages.push({ stage: `killed-${stage}`, actualInstallerProcessKilled: true, pid: processId, processState, journal, outcome, previousCanaryRetained: canary });
      await verifyBrowser(`recovered-${stage}`);
      if (stage === 'committed') await admin(['sudo', 'touch', `${target}/preserved-canary`]);
    } finally {
      if (processId) await admin(['sudo', 'kill', '-KILL', String(processId)]).catch(() => {});
      await result;
    }
  }
  await checkpoint('Rejecting changed checksum before extraction');
  await admin(['sudo', 'python3', '-c', "import sys\nwith open(sys.argv[1], 'r+b') as f:\n f.seek(32); b=f.read(1); f.seek(32); f.write(bytes([b[0]^1]))", controlledArchive]);
  await assert.rejects(admin(['bash', '-s'], script), /checksum mismatch/);
  await admin(['sudo', 'install', '-m', '0600', `/tmp/mu-install-test.${release.format}`, controlledArchive]);
  await admin(['test', '-f', `${target}/preserved-canary`]); report.checksumFailureRetainsPrevious = true;
  await ensureGuestBrowser(runtime, current!); await verifyBrowser('final');
  report.passed = true;
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
finally {
  if (captureRunning) {
    try {
      await admin(['sudo', 'systemctl', 'stop', 'mu-browser-install-capture.service']);
      const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', '/run/mu-browser-install.pcap'])).trim(), 'base64');
      await writeFile(path.join(artifacts, 'tasks.pcap'), bytes, { mode: 0o600 });
      const text = await admin(['sudo', 'tcpdump', '-nn', '-r', '/run/mu-browser-install.pcap']); await writeFile(path.join(artifacts, 'tasks-network.txt'), text, { mode: 0o600 });
      const gateway = (await admin(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+)/)![1];
      const physical = text.split('\n').filter(line => /\seth0\s+Out\s+IP6?\s/.test(line));
      // Current local upstreams are carried by the owned reverse-SSH transport,
      // not a direct guest connection to gateway:fixture.proxyPort.
      const ssh = physical.filter(line => line.includes(`.22 > ${gateway}.`));
      const bad = physical.filter(line => /\sIP6\s/.test(line) || !(line.includes(`.22 > ${gateway}.`) || /\.68 > [0-9.]+\.67:/.test(line)));
      assert.ok(ssh.length > 0); assert.deepEqual(bad, []);
      assert.ok(browserFixture.evidence.protectedRequests.length >= 6);
      report.capture = { bytes: bytes.length, sha256: hash(bytes), physicalPackets: physical.length, approvedSshPackets: ssh.length, unapproved: bad.length, scope: 'Controlled proxy payload travels through verified reverse SSH; protected fixture requests prove application transfer, not arbitrary per-connection Internet egress' };
    } catch (error) { report.captureError = String(error); report.passed = false; process.exitCode = 1; }
  }
  report.browserEvidence = browserFixture.evidence; report.uiOrAccountLoginTested = false;
  await service.close(); await fixture.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  try {
    for (const row of await runtime.list()) { if (row.status === 'Running') await runtime.command(['stop', row.name], { timeoutMs: 120_000 }); await runtime.command(['delete', row.name], { timeoutMs: 120_000 }); }
    assert.deepEqual(await runtime.list(), []); await rm(owned, { recursive: true }); report.testResourcesRemoved = true;
  } catch (error) { report.cleanupError = String(error); report.retainedTestRoot = owned; report.passed = false; process.exitCode = 1; }
  report.sources = Object.fromEntries(await Promise.all(['scripts/verify-browser-install-recovery.ts', 'server/browser-install-transaction.ts', 'server/guest-browser-runtime.ts'].map(async file => [file, hash(await readFile(path.join(root, file)))])));
  report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, hash(await readFile(path.join(artifacts, file)))])));
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'test-results/browser-install-recovery.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, stages: report.stages.map((s: any) => s.stage), capture: report.capture, error: report.error, cleanup: report.testResourcesRemoved }, null, 2));
}
