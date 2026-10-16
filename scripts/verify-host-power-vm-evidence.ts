import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const network = process.argv.includes('--network');
const prefix = network ? 'host-network-vm' : 'host-power-vm';
const bytes = await readFile(path.join(root, 'test-results', `${prefix}.json`));
const report = JSON.parse(bytes.toString());
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const output = path.join(root, 'test-results', `${prefix}-evidence.json`);
const { PNG } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
try {
  assert.equal(report.passed, true); assert.equal(report.accountFree, true); assert.equal(report.paidModelCalls, 0);
  assert.equal(report.actualElectronPackageTested, true); assert.equal(report.actualVmTested, true);
  assert.equal(report.actualMacSleepTested, false); assert.equal(report.actualWifiSwitchTested, false);
  assert.equal(report.injectedPowerEvents, !network); if (network) assert.equal(report.actualNetworkHelperFailuresTested, true);
  assert.equal(report.testResourcesRemoved, true); assert.equal(report.cleanupError, undefined);
  assert.equal(path.dirname(report.artifactsDirectory), path.join(root, 'test-results'));
  assert.match(path.basename(report.artifactsDirectory), new RegExp(`^${prefix}-\\d+$`));
  assert.deepEqual(report, JSON.parse(await readFile(path.join(report.artifactsDirectory, 'report.json'), 'utf8')));
  for (const [file, expected] of Object.entries(report.artifacts)) {
    assert.equal(path.basename(file), file); assert.equal(hash(await readFile(path.join(report.artifactsDirectory, file))), expected);
  }
  for (const file of ['verify-host-power-vm.ts', 'claude-local-fixture.ts']) {
    assert.equal(hash(await readFile(path.join(root, 'scripts', file))), hash(await readFile(path.join(report.artifactsDirectory, `source-${file}`))));
  }
  const bundle = path.join(root, `release/${network ? 'host-network-candidate' : 'host-power-fix-candidate'}/mac-arm64/MuCodeSandbox.app`);
  assert.equal(report.bundle, bundle); await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]); assert.match(signature, /Signature=adhoc/);
  assert.equal(report.cdHash, network ? 'cf031a2a4bbc9d55cc8b1d97e77a935b312145d2' : '4227377499a5aaeba73db3f31b821e44a5234aff');
  assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], report.cdHash);
  assert.equal(report.application.packaged, true); assert.equal(report.application.appPath, path.join(bundle, 'Contents/Resources/app'));
  assert.ok(report.application.sandboxedRenderers.length > 0 && report.application.sandboxedRenderers.every(Boolean));
  const files = ['desktop/main.cjs', ...(network ? ['native/bin/mu-network-monitor'] : []), ...(await readdir(path.join(bundle, 'Contents/Resources/app/dist-server/server')))
    .filter(file => file.endsWith('.js')).map(file => `dist-server/server/${file}`)];
  assert.deepEqual(Object.keys(report.modules).sort(), files.sort());
  for (const file of files) {
    assert.equal(hash(await readFile(path.join(bundle, 'Contents/Resources/app', file))), report.modules[file]);
    if (file === 'native/bin/mu-network-monitor') {
      const owned = await mkdtemp(path.join(tmpdir(), 'mu-network-identity-'));
      try {
        const digests = [];
        for (const [name, directory] of [['source', root], ['packaged', report.application.appPath]]) {
          const target = path.join(owned, name!); await copyFile(path.join(directory!, file), target);
          await run('/usr/bin/codesign', ['--remove-signature', target]);
          await run('/usr/bin/codesign', ['--sign', '-', '--identifier', 'mu-network-monitor', target]);
          digests.push(hash(await readFile(target)));
        }
        assert.equal(digests[0], digests[1], 'Native code must match after canonical signing of copies');
      } finally { await rm(owned, { recursive: true, force: true }); }
    } else assert.equal(hash(await readFile(path.join(root, file))), report.modules[file]);
  }
  assert.deepEqual(report.phases.map((row: any) => row.event), network ? ['monitor-kill', 'monitor-stall'] : ['suspend', 'resume']);
  for (let i = 0; i < report.phases.length; i++) {
    const phase = report.phases[i];
    assert.ok(phase.stoppedMs > 0 && phase.stoppedMs < 180_000);
    assert.ok(['QUARANTINED', 'HOST_POWER_TRANSITION', 'HOST_NETWORK_UNAVAILABLE', 'NOT_RUNNING'].includes(phase.accessRejected));
    if (network) {
      assert.equal(phase.monitorFailure.signal, i === 0 ? 'SIGKILL' : 'SIGSTOP');
      assert.equal(phase.monitorFailure.state.state, 'failed'); assert.equal(phase.monitorFailure.oldHelperRemoved, true);
      assert.ok(phase.monitorFailure.detectedMs > 0 && phase.monitorFailure.detectedMs < 25_000);
      if (i === 1) assert.ok(phase.monitorFailure.detectedMs >= 13_000);
    }
    for (const key of ['terminalClosed', 'browserClosed', 'streamClosed', 'noAutomaticRestart', 'grantsRevoked', 'oldGrantRejectedAfterRestart', 'manualRestartProtected']) assert.equal(phase[key], true);
    assert.equal(phase.pixels.width, 1280); assert.equal(phase.pixels.height, 800); assert.ok(phase.pixels.colors > 20);
    assert.ok(phase.stoppedTraffic.hits > 0 && phase.stoppedTraffic.ticks > 0 && phase.stoppedTraffic.streams >= i + 1);
    assert.match(await readFile(path.join(report.artifactsDirectory, `terminal-phase-${i + 1}.txt`), 'utf8'), /MU_POWER_PTY_READY/);
    const png = PNG.sync.read(await readFile(path.join(report.artifactsDirectory, `browser-phase-${i + 1}.png`)));
    assert.equal(png.width, 1280); assert.equal(png.height, 800);
    const colors = new Set<string>(); for (let offset = 0; offset < png.data.length; offset += 400) colors.add(png.data.subarray(offset, offset + 3).toString('hex'));
    assert.ok(colors.size > 20); assert.equal(colors.size, phase.pixels.colors);
    const raw = JSON.parse(await readFile(path.join(report.artifactsDirectory, `phase-${i + 1}-state.json`), 'utf8'));
    assert.equal(raw.event, phase.event); assert.equal(raw.eventAt, phase.eventAt);
    if (network) {
      assert.deepEqual(raw.monitorFailure, phase.monitorFailure);
      assert.equal(raw.stoppedSnapshot.system.hostNetwork.state, 'failed');
      assert.equal(raw.resumedSnapshot.system.hostNetwork.state, 'ready');
    }
    assert.equal(raw.beforeRuntime.find((row: any) => row.name === raw.instanceName).status, 'Running');
    assert.equal(raw.stoppedRuntime.find((row: any) => row.name === raw.instanceName).status, 'Stopped');
    assert.equal(raw.afterRuntime.find((row: any) => row.name === raw.instanceName).status, 'Running');
    assert.equal(raw.protectionBefore.active, true); assert.equal(raw.protectionAfter.active, true);
    assert.equal(raw.grantBefore.guestReady, true); assert.deepEqual(raw.grantsAfter, []);
    assert.equal(raw.configOwner.uid, raw.configOwner.currentUid); assert.equal(raw.configOwner.mode, 0o700); assert.equal(raw.configOwner.writable, true);
    assert.equal(raw.immediateAccess.status, 409); assert.equal(raw.terminalEvidence.closed, true);
    const stopped = raw.stoppedSnapshot.environments.find((row: any) => row.id === raw.environmentId);
    const resumed = raw.resumedSnapshot.environments.find((row: any) => row.id === raw.environmentId);
    assert.equal(stopped.state, 'error'); assert.equal(resumed.state, 'error');
    assert.equal(raw.stoppedSnapshot.jobs.length, raw.resumedSnapshot.jobs.length);
    assert.ok(raw.stoppedSnapshot.jobs.some((row: any) => row.environmentId === raw.environmentId && row.action === 'quarantine' && row.status === 'succeeded'));
  }
  const linked = JSON.parse(await readFile(path.join(report.artifactsDirectory, 'linked-config-rejection.json'), 'utf8'));
  assert.deepEqual(linked, report.linkedConfigRejected); assert.equal(linked.job.status, 'failed');
  assert.equal(linked.sentinelUnchanged, true); assert.equal(linked.noCapabilityPublished, true); assert.equal(linked.noOutsideFilesCreated, true);
  assert.equal(report.hostReceipts.activeStreams, 0); assert.equal(report.hostReceipts.streams, 2);
  const decisions = report.proxyDecisions.filter((row: any) => row.localOnly);
  assert.ok(decisions.some((row: any) => row.allowed && row.destination === '203.0.113.81:80'));
  assert.ok(decisions.filter((row: any) => row.allowed).every((row: any) => row.destination === '203.0.113.81:80'));
  assert.deepEqual(report.captures.map((row: any) => row.name), ['first-boot', 'restart-1', 'phase-1', 'restart-2', 'phase-2']);
  const bootIds = report.captures.filter((row: any) => row.bootId).map((row: any) => row.bootId);
  assert.equal(new Set(bootIds).size, 3);
  for (const capture of report.captures.filter((row: any) => row.bootId)) { assert.match(capture.bootId, /^[a-f0-9-]{36}$/); assert.equal(capture.bootId, capture.capturedBootId); }
  const captures = [];
  for (const capture of report.captures) {
    const file = path.join(report.artifactsDirectory, `${capture.name}.pcap`), data = await readFile(file);
    assert.equal(hash(data), capture.sha256); assert.equal(data.length, capture.bytes);
    assert.match(capture.gateway, /^\d+\.\d+\.\d+\.\d+$/); assert.ok(Number.isInteger(capture.proxyPort));
    const count = async (filter: string) => (await run('/usr/sbin/tcpdump', ['-nn', '-r', file, filter], { maxBytes: 32_000_000 }))
      .split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line)).length;
    const allowed = `(tcp and dst host ${capture.gateway} and dst port ${capture.proxyPort}) or (tcp and src port 22 and dst host ${capture.gateway}) or (udp and src port 68 and dst port 67)`;
    const physicalOut = await count('ifindex 2 and outbound and (ip or ip6)'); assert.ok(physicalOut > 0); assert.equal(physicalOut, capture.physicalOut);
    const unapproved = await count(`ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`); assert.equal(unapproved, 0);
    const approvedProxy = await count(`ifindex 2 and outbound and tcp and dst host ${capture.gateway} and dst port ${capture.proxyPort}`);
    assert.equal(approvedProxy, capture.approvedProxy); if (capture.name.startsWith('phase-')) assert.ok(approvedProxy > 0);
    captures.push({ name: capture.name, physicalOut, approvedProxy, unapproved });
  }
  const evidence = { passed: true, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), cdHash: report.cdHash,
    modulesVerified: files.length, phases: report.phases.map((row: any) => ({ event: row.event, stoppedMs: row.stoppedMs })), captures,
    verifierSha256: hash(await readFile(import.meta.filename)),
    scope: network ? 'Independent packet parsing and report/artifact/module consistency review of actual native-helper kill/stall and VM shutdown; no physical Mac network change or instantaneous traffic cutoff proof' : 'Independent packet parsing and report/artifact/module consistency review of real-VM injected-event observations; not a separate event execution, physical host sleep, or first-packet timing proof' };
  await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 }); console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  const evidence = { passed: false, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), error: error instanceof Error ? error.stack : String(error) };
  await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 }); console.error(JSON.stringify(evidence, null, 2)); process.exitCode = 1;
}
