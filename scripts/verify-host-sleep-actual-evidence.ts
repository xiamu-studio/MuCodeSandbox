import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const bytes = await readFile(path.join(root, 'test-results/host-sleep-actual.json'));
const source = JSON.parse(bytes.toString()), hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const cdHash = '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3';
const bundle = path.join(root, 'release/bridge-owner-candidate/mac-arm64/MuCodeSandbox.app');
const report: Record<string, any> = { passed: false, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), cdHash, captures: [],
  scope: 'Actual physical Mac sleep/wake confirmed by powerd log and current Electron native events, VM/stream/terminal/file-grant closure, manual recovery and three selected guest captures; no browser/Claude task, hypervisor first-packet timing, Wi-Fi switching, residential line or full-day claim' };
try {
  assert.equal(source.passed, true); assert.equal(source.accountFree, true); assert.equal(source.paidModelCalls, 0);
  assert.equal(source.packageCdHash, cdHash); assert.equal(source.bundle, bundle);
  assert.equal(source.actualMacSleepTested, true); assert.equal(source.injectedPowerEvents, false);
  assert.equal(source.inputsUnchanged, true); assert.equal(source.testResourcesRemoved, true);
  assert.equal(Object.keys(source.modules).length, 45);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  assert.equal((await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1], cdHash);
  for (const [name, digest] of Object.entries(source.modules)) {
    assert.match(name, /^[a-z][a-z-]*\.js$/);
    assert.equal(hash(await readFile(path.join(bundle, 'Contents/Resources/app/dist-server/server', name))), digest);
  }
  const directory = await realpath(source.artifactsDirectory), resultRoot = await realpath(path.join(root, 'test-results'));
  assert.ok(directory.startsWith(`${resultRoot}/host-sleep-actual-`));
  for (const [name, digest] of Object.entries(source.artifacts)) {
    assert.equal(path.basename(name), name); const artifact = await realpath(path.join(directory, name));
    assert.ok(artifact.startsWith(`${directory}/`)); assert.equal(hash(await readFile(artifact)), digest, name);
  }
  assert.deepEqual(Object.keys(source.initialSources).sort(), ['scripts/verify-host-sleep-actual.ts', 'scripts/seed-protected-test-base.ts', 'scripts/claude-local-fixture.ts', 'scripts/packet-capture.ts'].sort());
  for (const [name, digest] of Object.entries(source.initialSources)) assert.equal(hash(await readFile(path.join(directory, `source-${path.basename(name)}`))), digest);
  if (source.baseCache) assert.ok(source.baseCache.sourceStopped && source.baseCache.sourceUnchanged && source.baseCache.copiedWithFilesystemClone);
  else assert.equal(source.normalFreshPreparation, true);
  assert.deepEqual(source.powerEvents.map((row: any) => row.event), ['suspend', 'resume']);
  const suspend = Date.parse(source.powerEvents[0].at), resume = Date.parse(source.powerEvents[1].at);
  assert.ok(suspend >= Date.parse(source.sleepRequestedAt) && resume > suspend);
  assert.equal(resume - suspend, source.sleepIntervalMs); assert.ok(source.sleepIntervalMs >= 5000);
  assert.match(source.wakeSchedule.output, /^MU_WAKE_SCHEDULED=\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d\s*$/);
  const log = await readFile(path.join(directory, 'physical-power.log'), 'utf8');
  const entries = log.split('\n').flatMap(line => {
    const match = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4})/);
    return match ? [{ at: Date.parse(match[1]), line }] : [];
  });
  assert.ok(entries.some(row => /Entering Sleep state/.test(row.line) && Math.abs(row.at - suspend) < 10_000));
  assert.ok(entries.some(row => /Wake from/.test(row.line) && Math.abs(row.at - resume) < 10_000));
  assert.equal(source.beforeResponse, 'MU_ACTUAL_SLEEP_OK'); assert.equal(source.afterResponse, 'MU_ACTUAL_SLEEP_OK');
  assert.equal(source.protectionBefore.active, true); assert.equal(source.protectionAfter.active, true);
  assert.equal(source.snapshotBefore.system.hostNetwork.state, 'ready');
  const environment = source.snapshotBefore.environments.find((row: any) => row.state === 'running'); assert.ok(environment);
  assert.equal(source.snapshotAfterWake.environments.find((row: any) => row.id === environment.id).state, 'error');
  assert.equal(source.accessAfterWake.status, 409); assert.equal(source.noAutomaticRestart, true);
  assert.equal(source.manualRecoveryPassed, true); assert.equal(source.oldGrantRejected, true);
  assert.equal(source.beforeGrants.length, 1); assert.equal(source.beforeGrants[0].guestReady, true);
  assert.ok(source.terminal.connected && source.terminal.closed); assert.match(source.terminal.data, /MU_ACTUAL_PTY_READY/);
  assert.ok(source.receipts.hits > 0 && source.receipts.ticks >= 6); assert.equal(source.receipts.activeStreams, 0);
  assert.deepEqual(source.captures.map((row: any) => row.name), ['first-boot', 'sleep-window', 'recovery-boot']);
  for (const row of source.captures) {
    const file = path.join(directory, `${row.name}.pcap`), data = await readFile(file);
    assert.equal(data.length, row.bytes); assert.equal(hash(data), row.sha256);
    const packets = await packetLines(file, 'ifindex 2 and outbound and (ip or ip6)');
    const unapproved = await packetLines(file, 'ifindex 2 and outbound and (ip6 or (ip and not ((tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67))))');
    const management = await packetLines(file, 'ifindex 2 and outbound and tcp and src port 22 and dst host 192.168.5.2');
    assert.ok(packets.length > 0 && management.length > 0); assert.equal(packets.length, row.physicalOut); assert.deepEqual(unapproved, []);
    report.captures.push({ name: row.name, physicalPackets: packets.length, managementPackets: management.length, unapproved: unapproved.length });
  }
  report.physicalSleepIntervalMs = source.sleepIntervalMs; report.actualMacSleepVerified = true;
  report.manualRecoveryVerified = true; report.modulesVerified = 45; report.testResourcesRemoved = true;
  report.verifierSha256 = hash(await readFile(import.meta.filename)); report.passed = true;
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
await writeFile(path.join(root, 'test-results/host-sleep-actual-evidence.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
