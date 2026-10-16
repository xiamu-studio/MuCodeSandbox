import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..'), results = path.join(root, 'test-results');
const bundle = path.join(root, 'release/bridge-owner-candidate/mac-arm64/MuCodeSandbox.app');
const appRoot = path.join(bundle, 'Contents/Resources/app');
const cdHash = '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const gates = [
  ['desktop-crash-bridge-owner', 'Desktop main-process kill and manual recovery', '89df6b5d9cb9da22bee9f51ea57a6cf0a85a87b1992a63664cb546bd354d23d0'],
  ['packaged-workflow-bridge-owner', 'Browser, interactive CLI, file/command grants, snapshots and encrypted import', '7a85fc4943dde20286080e3f6d99f4c14a863bfc40a9b1096413e40322301606'],
  ['egress-bridge-owner-https', 'HTTPS proxy plus exit measurement and fault handling', '44793e5625c787c36a793f0efd3b1822d151ed7e3447bfb9ffe1a6d0a5568897'],
  ['egress-bridge-owner-socks5', 'SOCKS5 proxy plus exit measurement and fault handling', 'a1fd73073540ef6b075844490e359bdd18bcec81e2f3752dd795336ba54471f0'],
  ['shared-mounts-migration-bridge-owner', 'Unsafe legacy shared-directory migration and retry', '40357eb594dcf3261702a6270844b48dc1f5194379a5b3796e3d6182a7f874e4'],
  ['browser-upgrade-bridge-owner', 'Official browser 153 to 156 update and profile recovery', 'bd45eccfb57bc15eedbd93bc5b76460838048a42986500c9c6798c688e1d7929'],
  ['guest-disk-growth-bridge-owner', 'Stopped old full-disk environment recovery', 'efef8a2cbad9fcf22afef45d360bd4c63567ad5309ed5e807343b9d13119ba67'],
  ['disk-recovery-faults-bridge-owner', 'Three precise maintenance interruption points and smaller snapshot', '00cbd6668f63480423de9fd9570a40e6de2022e7a5b2d70e2fcfc4baa26ecc26'],
  ['disk-recovery-startup-bridge-owner', 'Selected early maintenance boot and interrupted desktop recovery', '518931ef6871995dc44abd1f08018315db5819f1dac3f8668be1ddb548191a20'],
  ['domain-network-bridge-owner', 'Controlled encrypted system DNS and three fault windows', '7ec1da6435297d203734bb9e2a11cf9ee2f073015bea96ae38f00b5615abb79b'],
  ['claude-tui-wireguard-bridge-owner', 'Two-VM WireGuard browser/CLI workflow, peer loss and reboot', '83d1b8305e9b177f2aa4e23dbbe0885592ad695824df92470c2dc6d2970e6ab8'],
  ['shared-mounts-ui-bridge-owner', 'Actual UI shared-directory permissions and readonly demotion', '669a88030c4bd0641a7ec06520bf384ad1a145b8837db68318bb8c979ce12a8e'],
  ['wireguard-faults-bridge-owner', 'Four selected kernel-tunnel faults and recovery using frozen current modules', '6d8386410e3e0025d80159f17f4b9e4106fb9dec1b24ba38a4b67489e48780b8'],
] as const;
const report: Record<string, any> = { auditedAt: new Date().toISOString(), bundle, cdHash, version: '0.4.0',
  integrityPassed: false, objectiveComplete: false, formalReleaseReady: false, checks: [],
  scope: 'Read-only integrity and provenance audit of pinned local reports, raw artifacts and package modules; preserves each original test scope; no new live acceptance run',
  outstanding: [
    { item: '24-hour fixed-package browser/CLI stability', state: 'pending' },
    { item: 'Four selected current-package tunnel faults', state: 'recorded-scope-integrity-pending' },
    { item: 'Actual Mac network switching', state: 'deferred-by-user', reason: 'On-site disruptive test deferred on 2026-10-11; unverified' },
    { item: 'Actual Mac sleep/wake', state: 'pending-actual-test', reason: 'User subsequently requested real sleep testing on 2026-10-11' },
    { item: 'Physical power-loss windows', state: 'deferred-by-user', reason: 'Dedicated device and independent observation needed; unverified' },
    { item: 'Hypervisor capture covering every first-packet interval', state: 'deferred-by-user', reason: 'Independent capture facility needed; unverified' },
    { item: 'Public/residential line and second Mac', state: 'deferred-by-user', reason: 'Line and device not supplied; unverified' },
    { item: 'Apple signing, notarization and formal distribution/updates', state: 'deferred-by-user', reason: 'Developer identity and distribution conditions absent; not delivered' },
    { item: 'Host Network Extension and macOS VM route', state: 'deferred', reason: 'Current user-selected route is Linux VM for browser and Claude Code' },
    { item: 'Claude Desktop', state: 'deferred', reason: 'Explicitly excluded by the user from this delivery' },
  ] };
async function contained(directory: string, file: string) {
  const resolved = await realpath(file), base = await realpath(directory);
  assert.ok(resolved.startsWith(`${base}${path.sep}`), `Artifact escapes expected directory: ${file}`); return resolved;
}
try {
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
  assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], cdHash); assert.match(signature, /Signature=adhoc/);
  report.appleFormalSignature = false;
  for (const [name, title, digest] of gates) {
    const bytes = await readFile(path.join(results, `${name}.json`)); assert.equal(hash(bytes), digest, name);
    const source = JSON.parse(bytes.toString()), evidenceBytes = await readFile(path.join(results, `${name}-evidence.json`));
    const evidence = JSON.parse(evidenceBytes.toString()); assert.equal(source.passed, true); assert.equal(evidence.passed, true);
    assert.equal(evidence.reportSha256 ?? evidence.observationSha256, digest);
    assert.equal(evidence.cdHash ?? evidence.packageCdHash, cdHash);
    const product = source.productPackage ?? source.package ?? source;
    assert.equal(product.cdHash ?? product.packageCdHash, cdHash); assert.equal(product.bundle, bundle);
    assert.equal(source.accountFree, true); assert.equal(source.paidModelCalls, 0);
    assert.ok(source.testResourcesRemoved || source.testDataRemoved || (source.vmRemoved && source.temporaryDataRemoved));
    const modules: Record<string, string> = product.files ?? product.modules ?? source.modules ?? {};
    let modulesVerified = 0, artifactsVerified = 0;
    for (const [file, expected] of Object.entries(modules)) {
      const relative = file.includes('/') ? file : `dist-server/server/${file}`;
      assert.ok(/^dist-server\/server\/[^/]+\.js$/.test(relative) || relative === 'desktop/main.cjs'
        || relative === 'dist-server/shared/types.js' || relative === 'native/bin/mu-network-monitor');
      assert.equal(hash(await readFile(path.join(appRoot, relative))), expected, `${name}: ${file}`); modulesVerified++;
    }
    if (source.packagedInputs) for (const entry of source.packagedInputs) {
      assert.equal(path.basename(entry.file), entry.file);
      assert.equal(hash(await readFile(path.join(appRoot, 'dist-server/server', entry.file))), entry.sha256);
      assert.equal(hash(await readFile(await contained(results, path.join(root, entry.snapshot)))), entry.sha256); modulesVerified++; artifactsVerified++;
    }
    const expectedModules = name === 'packaged-workflow-bridge-owner' ? 22 : 45;
    assert.ok(modulesVerified >= expectedModules, `${name}: incomplete recorded module binding`);
    if (source.artifactsDirectory) {
      const directory = await contained(results, source.artifactsDirectory); assert.ok(source.artifacts && Object.keys(source.artifacts).length);
      for (const [file, expected] of Object.entries(source.artifacts)) {
        assert.equal(path.basename(file), file); const target = await contained(directory, path.join(directory, file));
        assert.equal(hash(await readFile(target)), expected, `${name}: ${file}`); artifactsVerified++;
      }
    }
    report.checks.push({ name, title, state: 'recorded-scope-integrity-verified', reportSha256: digest, evidenceSha256: hash(evidenceBytes),
      modulesVerified, artifactsVerified, actualScope: evidence.scope ?? source.scope, accountFree: true, paidModelCalls: 0 });
  }
  report.integrityPassed = true;
  report.outstanding[1].state = 'verified-in-recorded-scope';
} catch (error) { report.integrityError = String(error); process.exitCode = 1; }

// A report or PID file alone cannot establish that the long run is still alive.
const dayDirectory = path.join(results, 'day-workflow-1791676780916');
try {
  const source = JSON.parse(await readFile(path.join(dayDirectory, 'report.json'), 'utf8'));
  assert.equal(source.package.cdHash, cdHash);
  const job = JSON.parse(await readFile(path.join(dayDirectory, 'job.json'), 'utf8'));
  assert.equal(job.pid, source.runnerPid); assert.equal(job.script, path.join(root, 'scripts/verify-day-workflow.ts'));
  assert.ok(Number.isSafeInteger(job.pid) && job.pid > 1);
  const processText = await run('/bin/ps', ['-p', String(job.pid), '-o', 'pid=,etime=,command=']).catch(() => '');
  const alive = processText.includes(`${job.executable} ${job.script}`) && Number(processText.trim().split(/\s+/)[0]) === job.pid;
  const rows = (await readFile(path.join(dayDirectory, 'browser-heartbeats.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const last = rows.at(-1); assert.ok(last);
  let maxGapMs = 0;
  for (let index = 1; index < rows.length; index++) {
    assert.equal(rows[index].count, rows[index - 1].count + 1); assert.ok(rows[index].ticks > rows[index - 1].ticks);
    maxGapMs = Math.max(maxGapMs, Date.parse(rows[index].at) - Date.parse(rows[index - 1].at));
  }
  const ageMs = Date.now() - Date.parse(last.at), captures = [];
  for (const row of source.captures) {
    const file = await contained(dayDirectory, path.join(dayDirectory, row.file)); assert.equal(path.basename(row.file), row.file);
    const bytes = await readFile(file); assert.equal(hash(bytes), row.sha256); assert.equal(bytes.length, row.bytes);
    const packets = await packetLines(file, 'ifindex 2 and outbound and (ip or ip6)');
    const unapproved = packets.filter(line => /\sIP6\s/.test(line) || !(line.includes(`.22 > ${source.gateway}.`) || /\.68 > [0-9.]+\.67:/.test(line)));
    assert.deepEqual(unapproved, []); assert.equal(packets.length, row.physicalOut);
    captures.push({ file: row.file, bytes: row.bytes, physicalOut: packets.length, unapproved: unapproved.length });
  }
  report.dayRun = { state: source.state, liveProcessConfirmed: alive, process: processText.trim(), runnerPid: job.pid,
    stableStartedAt: source.stableStartedAt, observations: source.observations.length, lastObservation: source.progress,
    heartbeatCount: rows.length, lastHeartbeat: last, heartbeatAgeMs: ageMs, maxHeartbeatGapMs: maxGapMs, captures,
    complete: false, sourceReport: path.join(dayDirectory, 'report.json') };
  if (source.state === 'verified' && source.passed) {
    const evidenceBytes = await readFile(path.join(dayDirectory, 'evidence.json')), evidence = JSON.parse(evidenceBytes.toString());
    assert.ok(evidence.passed && evidence.twentyFourHoursVerified && evidence.stableDurationMs >= 86_400_000);
    assert.equal(hash(await readFile(path.join(dayDirectory, 'report.json'))), evidence.sourceReportSha256);
    report.dayRun.complete = true; report.outstanding[0].state = 'verified';
  } else {
    report.outstanding[0].state = alive && source.state === 'running' && ageMs >= 0 && ageMs < 15_000 && maxGapMs < 15_000 ? 'running-confirmed' : 'needs-review';
    const interruption = await readFile(path.join(dayDirectory, 'interruption-context.json'), 'utf8').then(text => JSON.parse(text)).catch(() => null);
    if (!alive && source.state === 'failed' && source.testResourcesRemoved && interruption?.kind === 'user-requested-defer'
        && interruption.targetPid === job.pid && interruption.signal === 'SIGTERM' && /Acceptance interrupted/.test(source.error)) {
      report.dayRun.interruption = interruption; report.dayRun.disposition = 'stopped-by-user-request';
      report.outstanding[0].state = 'deferred-by-user'; report.outstanding[0].reason = 'Partial observations preserved; full-day run deliberately stopped and owned resources removed';
    }
  }
} catch (error) { report.dayRun = { state: 'unknown', error: String(error) }; }
try {
  const sourceFile = path.join(results, 'host-sleep-actual.json'), bytes = await readFile(sourceFile);
  const source = JSON.parse(bytes.toString()); assert.equal(source.packageCdHash, cdHash);
  const requirement = report.outstanding.find((row: any) => row.item === 'Actual Mac sleep/wake');
  report.actualSleep = { reportSha256: hash(bytes), sourceReport: sourceFile,
    passed: false, actualMacSleepTested: source.actualMacSleepTested,
    testResourcesRemoved: source.testResourcesRemoved, error: source.error };
  if (source.passed) {
    const evidence = JSON.parse(await readFile(path.join(results, 'host-sleep-actual-evidence.json'), 'utf8'));
    assert.ok(evidence.passed && evidence.actualMacSleepVerified); assert.equal(evidence.reportSha256, hash(bytes));
    assert.equal(evidence.cdHash, cdHash); report.actualSleep.passed = true;
    requirement.state = 'verified-in-recorded-scope'; requirement.reason = evidence.scope;
  } else {
    requirement.state = 'not-verified';
    requirement.reason = 'Actual-sleep attempt did not pass; current timed-out privileged OS request requires local administrator authentication. No injected result is substituted.';
  }
} catch (error) { report.actualSleep = { passed: false, error: String(error) }; }
await writeFile(path.join(results, 'local-delivery-audit.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ integrityPassed: report.integrityPassed, integrityError: report.integrityError,
  verifiedRecordedScopes: report.checks.length, objectiveComplete: report.objectiveComplete, dayRun: report.dayRun, outstanding: report.outstanding }, null, 2));
