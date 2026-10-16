import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const name = 'browser-sandbox-guard-packaged';
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), scope: 'Existing compiled-package 2D sandbox evidence; no VM or account started' };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
try {
  const bytes = await readFile(path.join(root, 'test-results', `${name}.json`)), source = JSON.parse(bytes.toString());
  report.observationSha256 = hash(bytes);
  assert.equal(source.passed, true); assert.equal(source.measurementCompleted, true);
  assert.equal(source.accountFree, true); assert.equal(source.paidModelCalls, 0);
  assert.equal(source.full3DAcceptancePassed, false); assert.deepEqual(source.accepted3DVariants, []);
  assert.equal(source.startupGuardFaultVerified, true); assert.equal(source.defaultRecoveryVerified, true);
  assert.equal(source.temporaryVmDataRemoved, true);
  const files = ['server/guest-browser-runtime.ts', 'server/guest-browser-sandbox.ts', 'server/guest-browser.ts', 'scripts/browser-media-fixture.ts', 'scripts/verify-browser-gpu.ts'];
  assert.deepEqual(Object.keys(source.testedFiles).sort(), [...files].sort());
  for (const file of files) {
    const current = hash(await readFile(path.join(root, file)));
    if (['scripts/verify-browser-gpu.ts', 'server/guest-browser-runtime.ts'].includes(file) && current !== source.testedFiles[file]) {
      const snapshot = file === 'scripts/verify-browser-gpu.ts' ? 'verifier.ts' : path.join('source', file);
      assert.equal(hash(await readFile(path.join(root, 'test-results', name, snapshot))), source.testedFiles[file], file);
      (report.historicalSourceSnapshots ??= []).push(file);
      report.currentSourceMatchesObservation = false;
    } else assert.equal(current, source.testedFiles[file], file);
  }
  const bundle = path.join(root, 'release/graphics-candidate/mac-arm64/MuCodeSandbox.app');
  assert.equal(source.package.bundle, bundle); assert.equal(source.package.actualCompiledServiceTested, true); assert.equal(source.package.applicationUiTested, false);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
  assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], source.package.cdHash);
  for (const file of ['guest-browser-runtime.js', 'guest-browser-sandbox.js', 'guest-browser.js'])
    assert.equal(hash(await readFile(path.join(bundle, 'Contents/Resources/app/dist-server/server', file))), source.packagedFiles[file], file);
  const row = source.variants.find((value: any) => value.name === 'production-2d'); assert.ok(row);
  assert.equal(row.sandboxed2DVerified, true); assert.equal(row.stableGraphicsVerified, true); assert.equal(row.gpuCrashCount, 0); assert.equal(row.profileExitType, 'Normal');
  assert.equal(row.canvas2D.colored, 25600); assert.ok(row.canvas2D.white > 20000);
  const protectedThreads = (process: any) => {
    assert.equal(process.seccomp, 2); assert.equal(process.noNewPrivileges, 1); assert.equal(process.uid, row.processSecurity.developmentUid);
    assert.match(process.effectiveCapabilities, /^0+$/); assert.equal(process.noSandboxFlag, false);
    assert.ok(process.threads.length > 0 && process.threads.some((thread: any) => thread.tid === process.pid));
    for (const thread of process.threads) { assert.equal(thread.seccomp, 2); assert.equal(thread.noNewPrivileges, 1); assert.match(thread.effectiveCapabilities, /^0+$/); }
  };
  assert.ok(row.processSecurity.processes.some((process: any) => process.role === 'renderer'));
  const gpuPids = row.processSecurity.processes.filter((process: any) => process.role === 'gpu-process').map((process: any) => process.pid).sort(); assert.ok(gpuPids.length > 0);
  for (const process of row.processSecurity.processes) { protectedThreads(process); if (process.role === 'renderer') assert.equal(process.separatePidNamespace, true); }
  assert.equal(row.stabilitySamples.length, 3);
  for (const sample of row.stabilitySamples) {
    assert.equal(sample.gpu.sandboxed, true); assert.equal(sample.gpu.processCrashCount, 0);
    assert.deepEqual(sample.processSecurity.processes.filter((process: any) => process.role === 'gpu-process').map((process: any) => process.pid).sort(), gpuPids);
    for (const process of sample.processSecurity.processes) protectedThreads(process);
  }
  const screenshot = await readFile(path.join(root, 'test-results', name, 'production-2d.png'));
  assert.equal(hash(screenshot), row.screenshot.sha256); assert.equal(screenshot.length, row.screenshot.bytes);
  const fault = source.guardFault; assert.equal(fault.injected, true); assert.equal(fault.rejected, true);
  const unprotected = fault.processSecurity.processes.filter((process: any) => process.role === 'gpu-process'); assert.ok(unprotected.length > 0);
  for (const process of unprotected) { assert.equal(process.seccomp, 0); assert.ok(process.threads.length > 0); for (const thread of process.threads) assert.equal(thread.seccomp, 0); }
  assert.equal(fault.remoteDisplaySecretRemoved, true); assert.ok(['inactive', 'failed'].includes(fault.finalServiceState));
  assert.ok(fault.targets.some((target: any) => target.type === 'page' && target.url === 'about:blank'));
  assert.ok(fault.targets.every((target: any) => !/^https?:/.test(target.url)));
  for (const protection of [source.initialProtection, source.finalProtection, row.protection]) { assert.equal(protection.active, true); assert.equal(protection.integrity, 'verified'); }
  for (const key of ['firewallHash', 'tunnelConfigHash']) assert.equal(source.initialProtection[key], source.finalProtection[key]);
  const endpoint = new URL(`tcp://${source.initialProtection.proxyEndpoints[0]}`);
  assert.equal(endpoint.hostname, '192.168.5.2'); const port = Number(endpoint.port); assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  assert.equal(source.captures.length, 1); const capture = source.captures[0];
  const file = path.join(root, 'test-results', name, 'physical-out.pcap'), packetBytes = await readFile(file);
  assert.equal(hash(packetBytes), capture.sha256); assert.equal(packetBytes.length, capture.bytes);
  const allowed = `(tcp and dst host 192.168.5.2 and dst port ${port}) or (tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67)`;
  const packets = async (filter: string) => (await run('/usr/sbin/tcpdump', ['-nn', '-r', file, filter])).split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line));
  assert.equal((await packets(`ip6 or (ip and not (${allowed}))`)).length, 0);
  const approved = (await packets(`tcp and dst host 192.168.5.2 and dst port ${port}`)).length;
  assert.ok(approved > 0); assert.equal(approved, capture.approvedProxyPackets);
  report.cdHash = source.package.cdHash; report.approvedProxyPackets = approved; report.unapprovedPackets = 0;
  report.full3DAcceptancePassed = false; report.applicationUiTested = false; report.passed = true;
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'test-results/browser-sandbox-evidence.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
