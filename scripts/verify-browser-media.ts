import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const graphiteCandidate = process.argv.includes('--graphite-candidate');
const reportName = 'browser-media' + (graphiteCandidate ? '-graphite-candidate' : '');
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), measurementCompleted: false, issues: [] };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
try {
  report.verifierSha256 = hash(await readFile(path.join(root, 'scripts/verify-browser-media.ts')));
  if (!process.argv.includes('--audit-only')) {
    await run(process.execPath, [path.join(root, 'scripts/verify-browser-contexts.ts'), '--media', ...(graphiteCandidate ? ['--graphite-candidate'] : [])], {
      timeoutMs: 1_800_000, maxBytes: 2_000_000, onOutput: text => process.stdout.write(text),
    });
  }
  const file = path.join(root, 'test-results', `${reportName}.json`);
  const bytes = await readFile(file), observations = JSON.parse(bytes.toString());
  report.observationSha256 = hash(bytes);
  assert.equal(observations.passed, true, 'Measurement did not complete');
  if (!process.argv.includes('--audit-only')) assert.ok(Date.parse(observations.startedAt) >= Date.parse(report.startedAt), 'Do not reuse an older run after a failed measurement');
  assert.equal(observations.stages.length, 6); assert.equal(observations.captures.length, 4);
  assert.equal(observations.accountFree, true); assert.equal(observations.paidModelCalls, 0);
  for (const [file, expected] of Object.entries(observations.testedFiles)) {
    if (hash(await readFile(path.join(root, file))) === expected) continue;
    assert.ok(process.argv.includes('--audit-only'), `Tested source changed: ${file}`);
    assert.equal(hash(await readFile(path.join(root, 'test-results', reportName, 'source', file))), expected, `Historical source snapshot: ${file}`);
    (report.historicalSourceSnapshots ??= []).push(file);
  }
  for (const capture of observations.captures) {
    assert.match(capture.name, /^(?:a|b)(?:-restarted)?$/);
    const file = path.join(root, 'test-results', reportName, `${capture.name}.pcap`), bytes = await readFile(file);
    assert.equal(hash(bytes), capture.sha256); assert.equal(bytes.length, capture.bytes);
    assert.ok(capture.approvedProxyPackets > 0); assert.equal(capture.unapprovedPackets, 0);
    const endpoint = new URL(`tcp://${observations.stages[0].protection.proxyEndpoints[0]}`);
    assert.equal(endpoint.hostname, '192.168.5.2'); assert.ok(Number(endpoint.port) > 0);
    const allowed = `(tcp and dst host 192.168.5.2 and dst port ${endpoint.port}) or (tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67)`;
    const count = async (filter: string) => (await run('/usr/sbin/tcpdump', ['-nn', '-r', file, filter], { maxBytes: 64_000_000 })).split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line)).length;
    assert.equal(await count(`ip6 or (ip and not (${allowed}))`), 0);
    assert.equal(await count(`tcp and dst host 192.168.5.2 and dst port ${endpoint.port}`), capture.approvedProxyPackets);
  }
  report.physicalCapturesRechecked = true;
  let lateFontsConsistent = true, webGLVerified = true;
  for (const row of observations.stages) {
    assert.equal(row.passed, true); assert.equal(row.protection.active, true); assert.equal(row.protection.integrity, 'verified');
    assert.equal(row.profileExitType, 'Normal'); assert.equal(row.rendererSandboxVerified, true);
    assert.match(row.name, /^[ab]-(?:fresh|browser-reopened|vm-restarted)$/);
    const screenshot = await readFile(path.join(root, 'test-results', reportName, `${row.name}.png`));
    assert.equal(hash(screenshot), row.screenshot.sha256); assert.equal(screenshot.length, row.screenshot.bytes);
    const security = row.processSecurity;
    assert.ok(security.processes.some((process: any) => process.role === 'renderer'));
    assert.ok(security.processes.some((process: any) => process.role === 'gpu-process'));
    for (const process of security.processes) {
      assert.equal(process.uid, security.developmentUid); assert.equal(process.seccomp, 2); assert.equal(process.noNewPrivileges, 1);
      assert.match(process.effectiveCapabilities, /^0+$/); assert.equal(process.noSandboxFlag, false);
      if (process.role === 'renderer') assert.equal(process.separatePidNamespace, true);
      assert.ok(process.threads.length > 0 && process.threads.some((thread: any) => thread.tid === process.pid));
      for (const thread of process.threads) { assert.equal(thread.seccomp, 2); assert.equal(thread.noNewPrivileges, 1); assert.match(thread.effectiveCapabilities, /^0+$/); }
    }
    assert.equal(row.gpuDiagnostics.gpu.auxAttributes.sandboxed, true); assert.equal(row.gpuCrashCount, 0);
    const receipt = row.receipt;
    const contexts = { page: receipt.page, dedicated: receipt.dedicated, shared: receipt.shared.value, service: receipt.service.value,
      sameFrame: receipt.sameFrame, crossFrame: receipt.crossFrame, popup: receipt.popup };
    for (const [name, context] of Object.entries(contexts) as [string, any][]) {
      const font = context.media.font;
      assert.deepEqual(font.after, receipt.page.media.font.after); assert.deepEqual(font.negative, font.after);
      assert.notEqual(font.before.hash, font.after.hash); assert.notEqual(font.before.width, font.after.width);
      const consistent = font.late.hash === font.after.hash && font.late.width === font.after.width;
      assert.equal(row.lateFontConsistency[name], consistent); lateFontsConsistent &&= consistent;
      assert.deepEqual(context.media.webgl, receipt.page.media.webgl);
      if (context.media.webgl.supported) {
        assert.deepEqual(context.media.webgl.pixel, [255, 0, 0, 255]); assert.equal(context.media.webgl.error, 0);
      } else webGLVerified = false;
      const { first, repeated, changed } = context.media.audio;
      if (['page', 'sameFrame', 'crossFrame', 'popup'].includes(name)) {
        for (const frame of [first, repeated, changed]) {
          assert.equal(frame.supported, true); assert.equal(frame.sampleRate, 44100); assert.equal(frame.length, 4096); assert.equal(frame.channels, 1);
          assert.match(frame.hash, /^[a-f0-9]{64}$/);
          assert.ok(frame.nonzero > 3000 && Number.isFinite(frame.energy) && frame.energy > 0 && Number.isFinite(frame.peak) && frame.peak > 0);
        }
        assert.equal(first.hash, repeated.hash); assert.notEqual(first.hash, changed.hash); assert.equal(first.hash, receipt.page.media.audio.first.hash);
      } else for (const frame of [first, repeated, changed]) assert.equal(frame.supported, false);
    }
    if (graphiteCandidate) {
      assert.equal(row.startupGuardVerified, true); assert.equal(row.gpuDiagnostics.gpu.featureStatus.skia_graphite, 'enabled_on');
      assert.equal(hash(await readFile(path.join(root, 'test-results', reportName, `${row.name}-launcher.sh`))), row.launcherSha256);
    }
  }
  assert.equal(observations.lateRegisteredFontsConsistent, lateFontsConsistent);
  assert.equal(observations.webGLRenderingVerified, webGLVerified);
  assert.equal(observations.offlineAudioConsistent, true);
  report.rawThreadAndFontEvidenceRechecked = true;
  report.measurementCompleted = true;
  report.checks = {
    fontLoadedBeforeFirstUseConsistent: observations.fontLoadedBeforeFirstUseConsistent,
    lateRegisteredFontsConsistent: observations.lateRegisteredFontsConsistent,
    offlineAudioConsistent: observations.offlineAudioConsistent,
    rendererSandboxVerified: observations.rendererSandboxVerified,
    gpuSandboxVerified: observations.gpuSandboxVerified,
    webGLRenderingVerified: observations.webGLRenderingVerified,
  };
  for (const [name, passed] of Object.entries(report.checks)) if (passed !== true) report.issues.push(name);
  report.passed = report.issues.length === 0;
  report.scope = 'Linux browser media acceptance; not WebGPU, real audio devices, public font CDN, or packaged application';
  report.productionConfigurationChanged = false;
  report.experimentalGraphiteCandidate = graphiteCandidate;
} catch (error) { report.error = (error as Error).stack; }
finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'test-results', `${reportName}-acceptance.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
