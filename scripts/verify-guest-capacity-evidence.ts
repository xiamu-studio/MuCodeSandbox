import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const storage = process.argv.includes('--storage');
const expectedCdHash = storage ? process.env.MU_TEST_PACKAGE_CD_HASH : 'cf031a2a4bbc9d55cc8b1d97e77a935b312145d2';
assert.match(expectedCdHash ?? '', /^[a-f0-9]{40}$/);
const bytes = await readFile(path.join(root, 'test-results/guest-capacity.json'));
const report = JSON.parse(bytes.toString());
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const output = path.join(root, 'test-results/guest-capacity-evidence.json');
const { PNG } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
try {
  for (const key of ['passed', 'actualVmTested', 'actualElectronPackageTested', 'accountFree', 'testResourcesRemoved', 'actualNativeTerminalFailure', 'actualUiRestore']) assert.equal(report[key], true);
  assert.equal(report.paidModelCalls, 0); assert.equal(report.hostDiskFullTested, false);
  assert.equal(report.guestRootReserveExhausted, false); assert.equal(report.cleanupError, undefined);
  const artifacts = report.artifactsDirectory;
  assert.equal(path.dirname(artifacts), path.join(root, 'test-results')); assert.match(path.basename(artifacts), /^guest-capacity-\d+$/);
  assert.deepEqual(report, JSON.parse(await readFile(path.join(artifacts, 'report.json'), 'utf8')));
  assert.deepEqual((await readdir(artifacts)).filter(f => f !== 'report.json').sort(), Object.keys(report.artifacts).sort());
  for (const [file, expected] of Object.entries(report.artifacts)) {
    assert.equal(path.basename(file), file); assert.equal(hash(await readFile(path.join(artifacts, file))), expected);
  }
  for (const file of ['verify-guest-capacity.ts', 'claude-local-fixture.ts']) assert.equal(hash(await readFile(path.join(root, 'scripts', file))), hash(await readFile(path.join(artifacts, `source-${file}`))));
  const bundle = path.join(root, `release/${storage ? 'guest-capacity-fix-candidate' : 'host-network-candidate'}/mac-arm64/MuCodeSandbox.app`); assert.equal(report.bundle, bundle);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]); assert.match(signature, /Signature=adhoc/);
  assert.equal(report.cdHash, expectedCdHash); assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], report.cdHash);
  const appRoot = path.join(bundle, 'Contents/Resources/app');
  assert.equal(report.application.packaged, true); assert.equal(report.application.appPath, appRoot);
  assert.ok(report.application.sandboxedRenderers.length > 0 && report.application.sandboxedRenderers.every(Boolean));
  const modules = ['desktop/main.cjs', ...(await readdir(path.join(appRoot, 'dist-server/server'))).filter(f => f.endsWith('.js')).map(f => `dist-server/server/${f}`)];
  assert.deepEqual(Object.keys(report.modules).sort(), modules.sort());
  for (const file of modules) {
    assert.equal(hash(await readFile(path.join(appRoot, file))), report.modules[file]);
    assert.equal(hash(await readFile(path.join(root, file))), report.modules[file]);
  }
  const full = JSON.parse(await readFile(path.join(artifacts, 'guest-fill.json'), 'utf8')); assert.deepEqual(full, report.full);
  assert.equal(full.uid, 502); assert.equal(full.euid, 502); assert.equal(full.errno, 28); assert.equal(full.failedWriteBytes, 4096);
  assert.ok(full.totalBytes > 2 ** 30 && full.totalBytes <= 12 * 2 ** 30); assert.ok(full.allocatedBytes > 2 ** 30 && full.allocatedBytes <= full.totalBytes);
  assert.equal(full.sameRootFilesystem, true); assert.equal(full.availableBytes, 0); assert.ok(full.rootFreeBytes > 0);
  for (const [name, expected] of [['restart-full-state', report.restartFull], ['restored-full-state', report.restoredFull]] as const) {
    const state = JSON.parse(await readFile(path.join(artifacts, `${name}.json`), 'utf8')); assert.deepEqual(state, expected);
    assert.equal(state.uid, 502); assert.equal(state.euid, 502); assert.equal(state.errno, 28); assert.equal(state.failedWriteBytes, 4096);
    assert.equal(state.availableBytes, 0); assert.ok(state.rootFreeBytes > 0); assert.equal(state.canary, 'MU_CAPACITY_ORIGINAL');
    assert.equal(state.originalFillerBytes, full.allocatedBytes); assert.ok(state.bootReleasedBytes >= 0 && state.bootReleasedBytes <= 64 * 2 ** 20);
    assert.ok(state.refilledBytes >= 0 && state.refilledBytes <= 64 * 2 ** 20);
  }
  for (const state of [report.firstRecovery, report.finalRecovery]) {
    assert.ok(state.availableBytes > 2 ** 30); assert.equal(state.written, 'MU_CAPACITY_RECOVERED'); assert.equal(state.canary, 'MU_CAPACITY_ORIGINAL');
  }
  assert.equal(report.stages.length, 4); for (const stage of report.stages) assert.equal(stage.hostNetwork.state, 'ready');
  assert.match(report.snapshot.id, /^[a-f0-9-]{36}$/); assert.equal(report.snapshot.name, 'Guest full baseline');
  const terminal = await readFile(path.join(artifacts, 'terminal-full.txt'), 'utf8');
  assert.match(terminal, /No space left on device/); assert.match(terminal, /MU_CAPACITY_SHELL_ALIVE_1/);
  const png = PNG.sync.read(await readFile(path.join(artifacts, 'terminal-full.png')));
  const scale = png.width / report.terminalScreenshot.dimensions.width;
  assert.ok([1, 2].includes(scale)); assert.equal(png.height / report.terminalScreenshot.dimensions.height, scale);
  assert.equal(report.terminalScreenshot.windowSize[0], 1360); assert.ok(report.terminalScreenshot.windowSize[1] >= 700);
  assert.ok(png.width >= 1360 && png.height >= 700);
  if (storage) {
    const reserve = await readFile(path.join(artifacts, 'root-reserve.txt'), 'utf8');
    const bytes = Number(reserve.match(/^Reserved block count:\s+(\d+)/m)![1]) * Number(reserve.match(/^Block size:\s+(\d+)/m)![1]);
    assert.equal(bytes, report.rootStorageReserveBytes); assert.ok(bytes >= 512 * 2 ** 20);
    assert.match(reserve, /^Reserved blocks uid:\s+0\b/m); assert.match(reserve, /^Reserved blocks gid:\s+\d+\s+\(group tcpdump\)/m);
  }
  const colors = new Set<string>(); for (let i = 0; i < png.data.length; i += 400) colors.add(png.data.subarray(i, i + 3).toString('hex')); assert.ok(colors.size > 20);
  assert.equal(report.targetRequests, 6);
  const local = report.proxyDecisions.filter((d: any) => d.localOnly && d.allowed);
  assert.ok(local.length > 0 && local.every((d: any) => d.destination === '203.0.113.81:80'));
  assert.deepEqual(report.captures.map((c: any) => c.name), ['first-boot', 'fill', 'restart-boot', 'restart-full', 'restored-boot', 'restored-full']);
  assert.equal(new Set(report.captures.filter((c: any) => c.bootId).map((c: any) => c.bootId)).size, 3);
  const captures = [];
  for (const c of report.captures) {
    const file = path.join(artifacts, `${c.name}.pcap`), data = await readFile(file);
    assert.equal(hash(data), c.sha256); assert.equal(data.length, c.bytes);
    assert.match(c.gateway, /^\d+\.\d+\.\d+\.\d+$/); assert.ok(Number.isInteger(c.proxyPort) && c.proxyPort > 0 && c.proxyPort <= 65535);
    if (c.bootId) { assert.match(c.bootId, /^[a-f0-9-]{36}$/); assert.equal(c.bootId, c.capturedBootId); }
    const count = async (filter: string) => (await run('/usr/sbin/tcpdump', ['-nn', '-r', file, filter], { maxBytes: 32_000_000 })).split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line)).length;
    const allowed = `(tcp and dst host ${c.gateway} and dst port ${c.proxyPort}) or (tcp and src port 22 and dst host ${c.gateway}) or (udp and src port 68 and dst port 67)`;
    const physicalOut = await count('ifindex 2 and outbound and (ip or ip6)'); assert.ok(physicalOut > 0); assert.equal(physicalOut, c.physicalOut);
    const unapproved = await count(`ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`); assert.equal(unapproved, 0); assert.equal(c.unapproved, 0);
    const approvedProxy = await count(`ifindex 2 and outbound and tcp and dst host ${c.gateway} and dst port ${c.proxyPort}`); assert.equal(approvedProxy, c.approvedProxy);
    if (!c.bootId) assert.ok(approvedProxy > 0); captures.push({ name: c.name, physicalOut, approvedProxy, unapproved });
  }
  const result = { passed: true, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), cdHash: report.cdHash,
    modulesVerified: modules.length, screenshotColors: colors.size, captures,
    verifierSha256: hash(await readFile(import.meta.filename)),
    scope: 'Read-only raw packet parsing, actual dev ENOSPC observations, screenshot and frozen package/source/archive consistency review; deleted VM is not re-executed; no root-full/host-full/power-loss/browser/CLI proof' };
  await writeFile(output, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const result = { passed: false, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), error: error instanceof Error ? error.stack : String(error) };
  await writeFile(output, JSON.stringify(result, null, 2)); console.error(JSON.stringify(result, null, 2)); process.exitCode = 1;
}
