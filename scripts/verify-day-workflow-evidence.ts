import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
import { assertGuestBrowserSandbox } from '../server/guest-browser-sandbox.ts';
import { validateBackupBrowser } from './backup-browser-fixture.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const argument = process.argv[2]; assert.ok(argument, 'Provide the exact completed day-workflow report.json');
const file = await realpath(argument), artifacts = path.dirname(file);
assert.equal(path.basename(file), 'report.json'); assert.equal(path.dirname(artifacts), path.join(root, 'test-results'));
assert.match(path.basename(artifacts), /^day-workflow-\d+$/);
const bytes = await readFile(file), source = JSON.parse(bytes.toString());
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const evidence: Record<string, any> = { passed: false, independentlyVerifiedAt: new Date().toISOString(), sourceReport: file,
  sourceReportSha256: hash(bytes), accountFree: true, paidModelCalls: 0, captures: [] };
async function artifact(name: string) {
  assert.equal(path.basename(name), name); const target = await realpath(path.join(artifacts, name));
  assert.equal(path.dirname(target), artifacts); return { target, bytes: await readFile(target) };
}
try {
  assert.ok(source.passed && source.inputsUnchanged && source.testResourcesRemoved);
  assert.equal(source.state, 'verified'); assert.equal(source.artifactsDirectory, artifacts);
  assert.ok(source.accountFree && source.actualElectronPackageTested && source.actualVmTested && source.actualBrowserTested && source.actualNativeTerminalTested);
  assert.equal(source.paidModelCalls, 0); assert.equal(source.residentialEgressTested, false);
  assert.equal(source.actualMacSleepTested, false); assert.equal(source.actualWifiSwitchTested, false); assert.equal(source.desktopIntegrationTested, false);
  assert.ok(source.stableDurationMs >= source.durationRequiredMs && source.durationRequiredMs >= 30_000);
  assert.ok(Date.parse(source.finishedAt) - Date.parse(source.stableStartedAt) >= source.durationRequiredMs);
  assert.equal(source.package.cdHash, '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3');
  const bundle = path.join(root, 'release/bridge-owner-candidate/mac-arm64/MuCodeSandbox.app'); assert.equal(source.package.bundle, bundle);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  assert.equal((await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1], source.package.cdHash);
  assert.equal(Object.keys(source.package.modules).length, 46);
  for (const [name, digest] of Object.entries(source.package.modules)) {
    assert.ok(/^dist-server\/server\/[^/]+\.js$/.test(name) || name === 'desktop/main.cjs');
    assert.equal(hash(await readFile(path.join(bundle, 'Contents/Resources/app', name))), digest);
  }
  assert.equal(Object.keys(source.sources).length, 7);
  for (const [name, digest] of Object.entries(source.sources)) {
    assert.ok(/^(scripts|server)\/[^/]+\.ts$/.test(name)); assert.equal(hash(await readFile(path.join(artifacts, 'inputs', name))), digest);
  }
  const app = source.package.application; assert.equal(app.packaged, true); assert.equal(app.appPath, path.join(bundle, 'Contents/Resources/app'));
  assert.ok(app.renderers.length && app.renderers.every((row: any) => row.sandboxed));
  await assert.rejects(stat(source.ownedRoot), (error: any) => error.code === 'ENOENT');
  assert.equal(source.browserEvidence.loginRequests, 1); assert.equal(source.browserEvidence.receipts.length, 2);
  const [initial, persisted] = source.browserEvidence.receipts; validateBackupBrowser(initial); validateBackupBrowser(persisted);
  assert.deepEqual(initial.before, { cookie: '', documentCookie: '', localStorage: null, indexedDB: null }); assert.deepEqual(persisted.before, persisted.after);
  const rawRows = (await artifact('observations.jsonl')).bytes.toString().trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rawRows, source.observations); assert.ok(rawRows.length >= 2);
  let elapsed = -1, heartbeats = 0, ticks = 0;
  for (const [index, row] of rawRows.entries()) {
    assert.equal(row.index, index); assert.ok(row.elapsedMs > elapsed); elapsed = row.elapsedMs;
    assert.equal(row.bootId, source.bootId); assert.equal(row.browserProcess, source.browserProcess);
    assert.ok(row.protection.active && row.protection.integrity === 'verified'); assert.equal(row.hostNetwork.state, 'ready');
    for (const key of ['firewallHash', 'tunnelConfigHash']) { assert.match(row.protection[key], /^[a-f0-9]{64}$/); assert.equal(row.protection[key], source.initialProtection[key]); }
    assert.equal(row.inspection.matchesConfiguration, true); assertGuestBrowserSandbox(row.sandbox); validateBackupBrowser(row.receipt);
    assert.deepEqual(row.receipt.before, row.receipt.after); assert.ok(row.traffic.heartbeats > heartbeats && row.traffic.receivedTicks > ticks);
    heartbeats = row.traffic.heartbeats; ticks = row.traffic.receivedTicks; assert.deepEqual(row.traffic.heartbeatErrors, []);
    assert.ok(row.freeBytes > 80 * 2 ** 30); assert.equal(row.pixels.width, 1280); assert.equal(row.pixels.height, 800); assert.ok(row.pixels.colors > 20);
    const png = await artifact(row.pixels.file); assert.equal(hash(png.bytes), row.pixels.sha256); assert.equal(png.bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.bytes.readUInt32BE(16), 1280); assert.equal(png.bytes.readUInt32BE(20), 800);
    const cli = await artifact(row.cli.file); assert.equal(hash(cli.bytes), row.cli.sha256); assert.match(cli.bytes.toString(), /MU_REAL_CLAUDE_TEXT_OK/);
    assert.match(cli.bytes.toString(), new RegExp(`MU_DAY_CLI_EXIT_${index}=0`));
    assert.ok(row.cli.receipts.some((value: any) => value.scenario === 'TEXT' && value.completed));
    for (const receipt of row.cli.receipts) assert.ok(source.messages.some((value: any) => JSON.stringify(value) === JSON.stringify(receipt)));
  }
  assert.ok(elapsed >= source.durationRequiredMs);
  const rawHeartbeats = (await artifact('browser-heartbeats.jsonl')).bytes.toString().trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rawHeartbeats.length, source.traffic.heartbeats);
  let maxHeartbeatGapMs = 0;
  for (const [index, row] of rawHeartbeats.entries()) {
    assert.equal(row.count, index + 1); assert.ok(row.ticks > 0);
    if (index) { const previous = rawHeartbeats[index - 1]; assert.ok(row.ticks > previous.ticks);
      const gap = Date.parse(row.at) - Date.parse(previous.at); assert.ok(gap > 0 && gap <= 15_000, `Browser heartbeat gap ${gap} ms`); maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, gap); }
  }
  assert.equal(source.traffic.streamStarts, 1, 'The sustained stream must never reconnect');
  assert.ok(source.traffic.receivedTicks >= source.durationRequiredMs / 1000 - 15);
  const firstHeartbeatAt = Date.parse(rawHeartbeats[0].at), lastHeartbeatAt = Date.parse(rawHeartbeats.at(-1).at);
  assert.ok(lastHeartbeatAt - firstHeartbeatAt >= source.durationRequiredMs - 15_000, 'Raw browser receipts do not cover the required time');
  for (const row of rawRows) assert.ok(Math.abs(Date.parse(row.at) - Date.parse(source.stableStartedAt) - row.elapsedMs) < 2000);
  assert.ok(source.captures.length >= Math.ceil(source.durationRequiredMs / source.chunkMs));
  for (const row of source.captures) {
    const capture = await artifact(row.file); assert.equal(capture.bytes.length, row.bytes); assert.ok(row.bytes > 24 && row.bytes < 64 * 2 ** 20);
    assert.equal(hash(capture.bytes), row.sha256);
    const lines = await packetLines(capture.target, 'ifindex 2 and outbound and (ip or ip6)');
    const ssh = lines.filter(line => line.includes(`.22 > ${source.gateway}.`));
    const unapproved = lines.filter(line => /\sIP6\s/.test(line) || !(line.includes(`.22 > ${source.gateway}.`) || /\.68 > [0-9.]+\.67:/.test(line)));
    assert.ok(ssh.length); assert.deepEqual(unapproved, []); assert.equal(lines.length, row.physicalOut); assert.equal(ssh.length, row.approvedSsh);
    const timed = (await run('/usr/sbin/tcpdump', ['-tt', '-nn', '-r', capture.target, 'ifindex 2 and outbound and (ip or ip6)'], { maxBytes: 128 * 2 ** 20 }))
      .split('\n').flatMap(line => /^\d+\.\d+ /.test(line) ? [Number(line.split(' ')[0]) * 1000] : []);
    assert.ok(timed.length); assert.ok(timed[0] >= Date.parse(row.startedAt) - 2000 && timed.at(-1)! <= Date.parse(row.stoppedAt) + 2000);
    evidence.captures.push({ file: row.file, bytes: row.bytes, physicalOut: lines.length, approvedSsh: ssh.length, unapproved: unapproved.length,
      firstPacketAtMs: timed[0], lastPacketAtMs: timed.at(-1) });
  }
  assert.equal(source.rotationGaps.length, source.captures.length - 1);
  for (const gap of source.rotationGaps) assert.ok(gap.upperBoundMs >= 0 && gap.upperBoundMs < 15_000);
  assert.ok(source.decisions.filter((row: any) => row.localOnly).every((row: any) => !row.allowed || /^(203\.0\.113\.80|203\.0\.113\.81):80$/.test(row.destination)));
  assert.ok(source.decisions.every((row: any) => !/(anthropic\.com|claude\.ai|claude\.com)/.test(row.destination) || !row.allowed));
  assert.equal(source.events.filter((row: any) => row.event !== 'app-exit').length, 0);
  assert.equal(source.events.filter((row: any) => row.event === 'app-exit').length, 1);
  assert.equal(source.events.find((row: any) => row.event === 'app-exit').code, 0);
  evidence.passed = true; evidence.twentyFourHoursVerified = source.durationRequiredMs >= 86_400_000;
  evidence.stableDurationMs = source.stableDurationMs; evidence.observations = rawRows.length; evidence.maxHeartbeatGapMs = maxHeartbeatGapMs;
  evidence.oneStreamNeverReconnected = true; evidence.oneVmBoot = source.bootId; evidence.testResourcesRemoved = true;
  evidence.scope = source.scope;
} catch (error) { evidence.error = String(error); console.error(error); }
await writeFile(path.join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify(evidence, null, 2)); if (!evidence.passed) process.exitCode = 1;
