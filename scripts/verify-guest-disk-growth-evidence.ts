import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { run } from '../server/process.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const bridgeOwner = process.argv.includes('--bridge-owner');
const product = bridgeOwner || process.argv.includes('--product');
const reportName = bridgeOwner ? 'guest-disk-growth-bridge-owner' : product ? 'guest-disk-growth-product' : 'guest-disk-growth';
const bytes = await readFile(path.join(root, `test-results/${reportName}.json`));
const report = JSON.parse(bytes.toString());
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const output = path.join(root, `test-results/${reportName}-evidence.json`);
try {
  for (const key of ['passed', 'actualElectronPackageTested', 'actualVmTested', 'accountFree', 'testResourcesRemoved']) assert.equal(report[key], true);
  assert.equal(report.paidModelCalls, 0); assert.equal(report.diskGrowthProductUiTested, product); assert.equal(report.cleanupError, undefined);
  if(bridgeOwner)assert.equal(report.bridgeOwnerRecoveryTested,true);
  const artifacts = report.artifactsDirectory;
  assert.equal(path.dirname(artifacts), path.join(root, 'test-results')); assert.match(path.basename(artifacts), bridgeOwner ? /^guest-disk-growth-bridge-owner-\d+$/ : product ? /^guest-disk-growth-product-\d+$/ : /^guest-disk-growth-\d+$/);
  assert.deepEqual(report, JSON.parse(await readFile(path.join(artifacts, 'report.json'), 'utf8')));
  assert.deepEqual((await readdir(artifacts)).filter(file => file !== 'report.json').sort(), Object.keys(report.artifacts).sort());
  for (const [file, digest] of Object.entries(report.artifacts)) { assert.equal(path.basename(file), file); assert.equal(hash(await readFile(path.join(artifacts, file))), digest); }
  if (product) for (const file of ['verify-guest-disk-growth.ts', 'claude-local-fixture.ts']) assert.equal(hash(await readFile(path.join(root, 'scripts', file))), hash(await readFile(path.join(artifacts, `source-${file}`))));
  assert.equal(hash(await readFile(path.join(root, 'server/guest-disk.ts'))), hash(await readFile(path.join(artifacts, 'source-guest-disk.ts'))));
  if(bridgeOwner){
    assert.deepEqual(Object.keys(report.sources).sort(),['scripts/verify-guest-disk-growth.ts','scripts/claude-local-fixture.ts','server/guest-disk.ts','scripts/packet-capture.ts'].sort());
    for(const [file,digest] of Object.entries(report.sources)){assert.equal(hash(await readFile(path.join(root,file))),digest);assert.equal(hash(await readFile(path.join(artifacts,`source-${path.basename(file)}`))),digest);}
  }
  const bundle = path.join(root, 'release/host-network-candidate/mac-arm64/MuCodeSandbox.app'); assert.equal(report.bundle, bundle);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]); assert.match(signature, /Signature=adhoc/);
  assert.equal(report.cdHash, 'cf031a2a4bbc9d55cc8b1d97e77a935b312145d2'); assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], report.cdHash);
  const reserve = Number(report.reserveBefore.match(/^Reserved block count:\s+(\d+)/m)[1]) * Number(report.reserveBefore.match(/^Block size:\s+(\d+)/m)[1]);
  assert.equal(reserve, report.reservedBytesBefore); assert.ok(reserve <= 16 * 2 ** 20);
  assert.equal(report.rawBytesBefore, 10 * 2 ** 30); assert.equal(report.rawBytesAfter, 12 * 2 ** 30);
  const before = parse(report.configBefore), after = parse(report.configAfter);
  assert.equal(before.disk, '10GiB'); assert.equal(after.disk, '12GiB');
  assert.deepEqual({ ...before, disk: after.disk }, after);
  const full = JSON.parse(await readFile(path.join(artifacts, 'full.json'), 'utf8')); assert.deepEqual(full, report.full);
  assert.equal(full.uid, 502); assert.equal(full.errno, 28); assert.equal(full.availableBytes, 0);
  assert.equal(full.canary, 'MU_GROWTH_ORIGINAL');
  assert.ok(full.fillerBytes > 2 ** 30 && full.totalBytes < 10 * 2 ** 30);
  const recovered = JSON.parse(await readFile(path.join(artifacts, 'recovered.json'), 'utf8')); assert.deepEqual(recovered, report.recovered);
  assert.equal(recovered.uid, 502); assert.equal(recovered.canary, 'MU_GROWTH_ORIGINAL'); assert.equal(recovered.fillerBytes, full.fillerBytes);
  assert.equal(recovered.written, 'MU_GROWTH_RECOVERED'); assert.ok(recovered.availableBytes > 2 ** 30);
  assert.ok(recovered.totalBytes > full.totalBytes + 2 ** 30 && recovered.totalBytes < 12 * 2 ** 30);
  assert.equal(report.targetRequests, 1); assert.equal(report.protection.active, true); assert.equal(report.protection.integrity, 'verified');
  assert.equal(report.maintenanceBootEarlyCaptureTested, false);
  if (product) {
    const latest = path.join(root, `release/${bridgeOwner?'bridge-owner-candidate':'disk-recovery-candidate'}/mac-arm64/MuCodeSandbox.app`); assert.equal(report.productPackage.bundle, latest);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', latest]);
    const identity = await run('/usr/bin/codesign', ['-d', '--verbose=4', latest]); assert.match(identity, /Signature=adhoc/);
    assert.equal(report.productPackage.cdHash, bridgeOwner?'9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3':'e1caee59d8049dccf71e42c2e37bf62518d2d05a');
    assert.equal(identity.match(/^CDHash=(.+)$/m)?.[1], report.productPackage.cdHash);
    const appRoot = path.join(latest, 'Contents/Resources/app');
    assert.equal(report.productPackage.identity.packaged, true); assert.equal(report.productPackage.identity.appPath, appRoot);
    const modules = ['desktop/main.cjs', ...(await readdir(path.join(appRoot, 'dist-server/server'))).filter(file => file.endsWith('.js')).map(file => `dist-server/server/${file}`)];
    if(bridgeOwner)assert.equal(modules.length,46);
    assert.deepEqual(Object.keys(report.productPackage.modules).sort(), modules.sort());
    for (const file of modules) { assert.equal(hash(await readFile(path.join(appRoot, file))), report.productPackage.modules[file]); assert.equal(hash(await readFile(path.join(root, file))), report.productPackage.modules[file]); }
    assert.deepEqual(report.diskStatusAfter, { pending: false, targetGiB: null });
    assert.equal(report.productUi.submitted, true); assert.equal(report.productUi.status, 'succeeded'); assert.equal(report.productUi.finalDiskGiB, 12); assert.equal(report.productUi.finalState, 'stopped');
    const { PNG } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
    for (const [name, width, minimumHeight] of [['desktop', 1360, 960], ['mobile', 390, 844]] as const) {
      const png = PNG.sync.read(await readFile(path.join(artifacts, `recovery-${name}.png`))); assert.equal(png.width, width); assert.ok(png.height >= minimumHeight);
      const colors = new Set<string>(); for (let offset = 0; offset < png.data.length; offset += 400) colors.add(png.data.subarray(offset, offset + 3).toString('hex')); assert.ok(colors.size > 20);
    }
    assert.deepEqual(report.captures.map((c: any) => c.name), ['first-boot', 'grown-boot', 'grown-task']);
  } else {
    assert.equal(report.maintenanceProtection.firewallActive, true); assert.equal(report.maintenanceProtection.bootArmed, true);
    assert.equal(report.maintenanceProtection.integrity, 'verified'); assert.equal(report.maintenanceProtection.leaseActive, false);
    assert.equal(report.filesystemGrowth.diskBytes, 12 * 2 ** 30); assert.equal(report.filesystemGrowth.scratchInMemory, true);
    assert.equal(report.filesystemGrowth.beforeFilesystemBytes, full.totalBytes);
    assert.equal(report.filesystemGrowth.afterFilesystemBytes, recovered.totalBytes);
    assert.deepEqual(report.captures.map((c: any) => c.name), ['first-boot', 'maintenance-task', 'grown-boot', 'grown-task']);
  }
  assert.equal(new Set(report.captures.filter((c: any) => c.bootId).map((c: any) => c.bootId)).size, 2);
  const captures = [];
  for (const c of report.captures) {
    const file = path.join(artifacts, `${c.name}.pcap`), data = await readFile(file);
    assert.equal(hash(data), c.sha256); assert.equal(data.length, c.bytes);
    assert.match(c.gateway, /^\d+\.\d+\.\d+\.\d+$/); assert.ok(Number.isInteger(c.proxyPort) && c.proxyPort > 0 && c.proxyPort <= 65535);
    if (c.bootId) assert.match(c.bootId, /^[a-f0-9-]{36}$/);
    const count = async (filter: string) => (await packetLines(file,filter)).length;
    const sshExpected=bridgeOwner&&c.name!=='first-boot';
    if(bridgeOwner)assert.equal(c.sshTransportExpected,sshExpected);
    const allowed = `${sshExpected?'':`(tcp and dst host ${c.gateway} and dst port ${c.proxyPort}) or `}(tcp and src port 22 and dst host ${c.gateway}) or (udp and src port 68 and dst port 67)`;
    const physicalOut = await count('ifindex 2 and outbound and (ip or ip6)'); if (c.name !== 'maintenance-task') assert.ok(physicalOut > 0); assert.equal(physicalOut, c.physicalOut);
    const unapproved = await count(`ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`); assert.equal(unapproved, 0); assert.equal(c.unapproved, 0);
    const approvedProxy = await count(`ifindex 2 and outbound and tcp and dst host ${c.gateway} and dst port ${c.proxyPort}`); assert.equal(approvedProxy, c.approvedProxy);
    const approvedSsh=await count(`ifindex 2 and outbound and tcp and src port 22 and dst host ${c.gateway}`);
    if(sshExpected){assert.equal(approvedProxy,0);assert.equal(approvedSsh,c.approvedSsh);}
    if (!c.bootId && c.name !== 'maintenance-task') assert.ok((sshExpected?approvedSsh:approvedProxy) > 0);
    if (c.name === 'maintenance-task') assert.equal(approvedProxy, 0);
    captures.push({ name: c.name, physicalOut, approvedProxy, approvedSsh, unapproved });
  }
  const result = { passed: true, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), verifierSha256: hash(await readFile(import.meta.filename)),
    cdHash: product ? report.productPackage.cdHash : report.cdHash, captures,
    scope: product ? 'Actual new-package UI recovery of an old full guest, source/package hashes, fixture preservation, PNG and normal-boot/task raw-packet review; no early maintenance-boot capture, physical crash, browser/CLI/full-backup or all-file integrity claim' : 'Read-only raw-packet/configuration and fixture-file review of official Lima growth on old frozen package; not product UI, all-file integrity, power-loss or latest package acceptance' };
  await writeFile(output, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const result = { passed: false, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), error: error instanceof Error ? error.stack : String(error) };
  await writeFile(output, JSON.stringify(result, null, 2)); console.error(JSON.stringify(result, null, 2)); process.exitCode = 1;
}
