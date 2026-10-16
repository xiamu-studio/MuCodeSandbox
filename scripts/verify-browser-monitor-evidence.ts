import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
import { assertGuestBrowserSandbox } from '../server/guest-browser-sandbox.ts';

const root = path.resolve(import.meta.dirname, '..');
const name = 'browser-runtime-monitor' + (process.argv.includes('--packaged') ? '-packaged' : '');
const artifacts = path.join(root, 'test-results', name);
const report = JSON.parse(await readFile(path.join(root, 'test-results', `${name}.json`), 'utf8'));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const audit: Record<string, unknown> = { passed: false, startedAt: new Date().toISOString(), report: `${name}.json` };
try {
  assert.equal(report.passed, true); assert.equal(report.measurementCompleted, true);
  assert.equal(report.accountFree, true); assert.equal(report.paidModelCalls, 0);
  assert.equal(report.automaticMonitorIntervalMs, 8000); assert.equal(report.manualMonitorCalls, 0);
  assert.equal(report.actualTerminalConnected, true); assert.equal(report.actualTerminalCommandExecuted, true);
  assert.equal(report.actualGuestBridgeRead, true); assert.equal(report.unrelatedCgroupDoesNotQuarantine, true);
  assert.equal(report.automaticQuarantineRevokesViewerTerminalAndBridge, true);
  assert.equal(report.explicitRecoveryAndNormalCloseVerified, true); assert.equal(report.temporaryVmDataRemoved, true);
  assert.ok(Number.isFinite(report.quarantinedAfterMs) && report.quarantinedAfterMs > 0 && report.quarantinedAfterMs < 45_000);
  for (const [file, expected] of Object.entries(report.testedFiles)) {
    assert.equal(hash(await readFile(path.join(artifacts, 'source', file))), expected, file);
  }
  for (const [file, expected] of Object.entries(report.packagedFiles ?? {})) {
    assert.equal(hash(await readFile(path.join(artifacts, 'package', file))), expected, file);
  }
  const unrelated = report.unrelatedUnprotectedProcesses;
  assert.ok(unrelated.length > 0 && unrelated.every((p: any) => p.role === 'gpu-process' && p.seccomp === 0));
  const faultTime = Date.parse(report.faultStartedAt);
  const before = report.inspections.filter((row: any) => Date.parse(row.at) < faultTime);
  const failed: any[] = [], healthy: any[] = [];
  for (const row of report.inspections) {
    assert.ok(Number.isFinite(Date.parse(row.at)));
    try { assertGuestBrowserSandbox(row.value); healthy.push(row); } catch { failed.push(row); }
  }
  assert.ok(before.length >= 2); assert.ok(healthy.length >= 4); assert.equal(failed.length, 1);
  assert.deepEqual(failed[0], report.actualRejectedInspection);
  assert.ok(Date.parse(failed[0].at) >= faultTime);
  assert.ok(failed[0].value.processes.some((p: any) => p.role === 'gpu-process' && p.seccomp === 0));
  assert.ok(before.every((row: any) => row.value.processes.every((p: any) => !unrelated.some((extra: any) => extra.pid === p.pid))));
  assert.ok(healthy.some((row: any) => Date.parse(row.at) > Date.parse(failed[0].at)), 'Actual protected recovery inspection');
  for (const [stage, file] of [['initialRendering', 'healthy.png'], ['recoveryRendering', 'recovered.png']]) {
    const observed = report[stage], bytes = await readFile(path.join(artifacts, file));
    assert.deepEqual(observed.pixel, [0, 255, 0, 255]); assert.equal(observed.error, 0);
    assert.equal(hash(bytes), observed.screenshotSha256); assert.equal(bytes.length, observed.screenshotBytes);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  const capture = report.capture, file = path.join(artifacts, capture.file), bytes = await readFile(file);
  assert.equal(hash(bytes), capture.sha256); assert.equal(bytes.length, capture.bytes);
  assert.ok(Number.isInteger(capture.proxyPort) && capture.proxyPort > 0 && capture.proxyPort < 65536);
  const count = async (filter: string) => (await run('/usr/sbin/tcpdump', ['-nn', '-r', file, filter], { maxBytes: 64_000_000 })).split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line)).length;
  const allowed = `(tcp and dst host 192.168.5.2 and dst port ${capture.proxyPort}) or (tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67)`;
  const approved = await count(`tcp and dst host 192.168.5.2 and dst port ${capture.proxyPort}`);
  assert.ok(approved > 0); assert.equal(approved, capture.approvedProxyPackets);
  assert.equal(await count(`ip6 or (ip and not (${allowed}))`), 0); assert.equal(capture.unapprovedPackets, 0);
  Object.assign(audit, { passed: true, approvedProxyPackets: approved, unapprovedPackets: 0,
    healthyInspections: healthy.length, rejectedInspections: failed.length, quarantinedAfterMs: report.quarantinedAfterMs,
    scope: 'Archived exact sources, raw per-thread inspections and fault, screenshot fingerprints, and independent physical capture parsing. Not instantaneous detection, root compromise resistance, first boot capture, or desktop UI.' });
} catch (error) { audit.error = (error as Error).stack; process.exitCode = 1; }
audit.finishedAt = new Date().toISOString();
await writeFile(path.join(root, 'test-results', `${name}-evidence.json`), JSON.stringify(audit, null, 2), { mode: 0o600 });
console.log(JSON.stringify(audit, null, 2));
