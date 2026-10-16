import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..'), owned = await mkdtemp(path.join(tmpdir(), 'mu-network-probe-'));
const binary = path.join(root, 'native/bin/mu-network-monitor');
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), actualNetworkChanged: false, actualMacSubscription: true, records: [] };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let child: ReturnType<typeof spawn> | undefined;
try {
  const probe = path.join(owned, 'probe');
  await run('/usr/bin/xcrun', ['swiftc', '-O', path.join(root, 'native/NetworkSnapshot.swift'), path.join(root, 'native/probes/network-snapshot.swift'), '-o', probe], { timeoutMs: 90_000 });
  report.fixtures = JSON.parse(await run(probe, [])); assert.equal(report.fixtures.passed, true); assert.equal(report.fixtures.fixtureChecks, 12);
  const once = JSON.parse(await run(binary, ['--once'])); assert.equal(once.kind, 'ready'); assert.equal(once.sequence, 1); assert.match(once.fingerprint, /^[a-f0-9]{64}$/);
  report.once = once;
  let buffer = '', stderr = '';
  child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', bytes => {
    buffer += bytes.toString(); let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) { report.records.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
  });
  child.stderr!.on('data', bytes => { stderr += bytes.toString(); });
  const deadline = Date.now() + 10_000;
  while (report.records.length < 3) { assert.ok(Date.now() < deadline && child.exitCode === null, stderr || 'Native heartbeat missing'); await delay(100); }
  assert.equal(report.records[0].kind, 'ready');
  report.records.forEach((record: any, index: number) => {
    assert.equal(record.sequence, index + 1); assert.match(record.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(['ready', 'heartbeat', 'change'].includes(record.kind));
    assert.deepEqual(Object.keys(record).sort(), ['fingerprint', 'kind', 'sequence']);
  });
  report.stderr = stderr; assert.equal(stderr, ''); report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise<void>(resolve => { child!.once('close', () => resolve()); child!.kill('SIGTERM'); });
  }
  await rm(owned, { recursive: true, force: true }); report.temporaryProbeRemoved = true;
  report.components = {};
  for (const file of ['native/NetworkSnapshot.swift', 'native/NetworkMonitor.swift', 'native/probes/network-snapshot.swift', 'native/bin/mu-network-monitor', 'server/host-network.ts', 'scripts/verify-host-network-native.ts']) report.components[file] = digest(await readFile(path.join(root, file)));
  report.finishedAt = new Date().toISOString();
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/host-network-native.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
