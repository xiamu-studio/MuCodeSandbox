import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const bridgeOwner = process.argv.includes('--bridge-owner');
const protocol = process.argv.includes('--https') ? 'https' : process.argv.includes('--socks') ? 'socks5' : 'http';
assert.ok(!(process.argv.includes('--https') && process.argv.includes('--socks')));
assert.ok(protocol === 'http' || bridgeOwner);
const reportName = bridgeOwner ? `egress-bridge-owner-${protocol}` : 'egress-probe-packaged';
const expectedStarts = bridgeOwner ? protocol === 'https' ? 10 : 8 : 5;
const bytes = await readFile(path.join(root, `test-results/${reportName}.json`));
const report = JSON.parse(bytes.toString());
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const output = path.join(root, `test-results/${reportName}-evidence.json`);
try {
  for (const flag of ['passed', 'accountFree', 'proxyTransportPackageTested', 'actualLinuxVmVerified',
    'startupMismatchRejectedBeforeManagedAccess', 'approvedExitHasRealBusinessPositiveControlAndDirectBypassDenied',
    'authorizedGuestBridgeBeforeDrift', 'malformedReceiptBlocksActualBridgeRead', 'wrongTlsNameCannotIssueTerminal',
    'measurementServiceLossQuarantines', 'userDataPreserved', 'probeWorksBeforeBusinessLease',
    'developerCannotUseProbeListener', 'testResourcesRemoved']) assert.equal(report[flag], true, flag);
  assert.equal(report.paidModelCalls, 0); assert.equal(report.error, undefined); assert.equal(report.cleanupError, undefined);
  assert.equal(report.retainedDataDir, undefined); assert.deepEqual(report.captureFailures, []);
  const directory = report.artifactsDirectory;
  assert.equal(path.dirname(directory), path.join(root, 'test-results')); assert.match(path.basename(directory), new RegExp(`^${reportName}-\\d+$`));
  assert.deepEqual(report, JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')));
  assert.deepEqual(Object.keys(report.sources), ['scripts/verify-egress.ts', ...(protocol==='socks5'?['server/lima-config.ts']:[])]);
  for (const [file, expected] of Object.entries(report.sources)) {
    assert.equal(hash(await readFile(path.join(root, file))), expected);
    assert.equal(hash(await readFile(path.join(directory, `source-${path.basename(file)}`))), expected);
  }
  assert.deepEqual((await readdir(directory)).filter(file => file !== 'report.json').sort(), Object.keys(report.artifacts).sort());
  for (const [file, expected] of Object.entries(report.artifacts)) {
    assert.equal(path.basename(file), file); assert.equal(hash(await readFile(path.join(directory, file))), expected);
  }
  const bundle = path.join(root, `release/${bridgeOwner ? 'bridge-owner-candidate' : 'proxy-probe-candidate'}/mac-arm64/MuCodeSandbox.app`);
  assert.equal(report.bundle, bundle); await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]); assert.match(signature, /Signature=adhoc/);
  assert.equal(report.packageCdHash, bridgeOwner ? '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3' : '93781410161fcf4560c244ce5469b980ffc38976');
  assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], report.packageCdHash);
  const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
  const modules = (await readdir(compiled)).filter(file => file.endsWith('.js')).sort();
  assert.deepEqual(Object.keys(report.modules).sort(), modules);
  for (const file of modules) {
    assert.equal(hash(await readFile(path.join(compiled, file))), report.modules[file]);
    assert.equal(hash(await readFile(path.join(root, 'dist-server/server', file))), report.modules[file]);
  }
  assert.equal(report.privateProbeGuardBeforeListeners.length, expectedStarts);
  assert.equal(report.probeConfigurations.length, expectedStarts);
  for (const [index, row] of report.privateProbeGuardBeforeListeners.entries()) {
    assert.ok(Number.isInteger(row.uid) && row.uid > 0 && Number.isInteger(row.probePort) && row.probePort > 0 && row.probePort <= 65535);
    assert.ok(Number.isInteger(row.relayPort) && row.relayPort > 0 && row.relayPort <= 65535 && row.probePort !== row.relayPort);
    assert.ok(row.kernelVerified && row.listenersAbsent);
    const configuration = report.probeConfigurations[index];
    assert.deepEqual(configuration.listener, { type: 'socks', tag: 'exit-probe', listen: '127.0.0.1', listen_port: row.probePort });
    assert.ok(configuration.udpRejectedBeforeDns && configuration.oneApprovedUpstream);
    if(bridgeOwner){assert.equal(configuration.upstreamType,protocol==='socks5'?'socks':'http');assert.equal(configuration.tls,protocol==='https');}
    assert.ok(Date.parse(configuration.at) >= Date.parse(row.at));
    assert.ok(report.probeObservations.some((observation: any) => observation.leaseActive === false && observation.proxy === `socks5h://127.0.0.1:${row.probePort}`));
  }
  assert.ok(report.probeObservations.some((row: any) => row.leaseActive));
  const drift = report.backgroundDriftWhileBusy;
  for (const flag of ['terminalClosed', 'bridgeRevoked', 'unusedTicketRevoked', 'installCancelled']) assert.equal(drift[flag], true);
  assert.ok(drift.detectedAndStoppedMs > 0 && drift.detectedAndStoppedMs < 40_000);
  assert.equal(drift.status.status, 'changed'); assert.equal(drift.status.expectedIp, '8.8.8.8'); assert.equal(drift.status.actualIp, '9.9.9.9');
  assert.ok(report.measurementReceipts >= 5);
  assert.ok(report.proxyDestinations.includes('203.0.113.50:443') && report.proxyDestinations.includes('203.0.113.51:80'));
  assert.deepEqual(report.captures.map((row: any) => row.name), Array.from({length:expectedStarts},(_,index)=>`egress-${index+1}.pcap`));
  if(bridgeOwner){
    assert.equal(report.upstreamProtocol,protocol);assert.equal(report.upstreamRecoveryAndDataPreservation,true);
    assert.deepEqual(report.upstreamFailures.map((row:any)=>row.name),['wrong-password','wrong-user',...(protocol==='https'?['wrong-proxy-name','untrusted-proxy-ca']:[])]);
    assert.ok(report.upstreamFailures.every((row:any)=>row.businessPermissionNeverOpened&&row.receiptUnchanged&&row.businessUnchanged&&row.status==='unavailable'));
    if(protocol==='https')assert.ok(report.proxyTlsProtocols.length>0&&report.proxyTlsProtocols.every((value:string)=>['TLSv1.2','TLSv1.3'].includes(value)));
    if(protocol==='socks5'){
      assert.equal(report.hostSocksAuthenticationControl,true);
      assert.equal(report.socksServer.actualSeparateVm,true);assert.equal(report.socksServer.engine,'sing-box 1.14.3');assert.equal(report.socksServer.authenticated,true);
      const config=report.socksServer.configuration;
      assert.deepEqual(config.inbounds,[{type:'socks',listen:'127.0.0.1',listen_port:1080,users:[{username:'mu',password:'exit-fixture'}]}]);
      assert.deepEqual(config.route.rules.map((row:any)=>row.ip_cidr),[['203.0.113.50/32'],['203.0.113.51/32']]);
      assert.ok(config.route.rules.every((row:any)=>row.override_address==='192.168.5.2'&&Number.isInteger(row.override_port)&&row.override_port>0));
    }
  }
  const captures = [];
  for (const row of report.captures) {
    const file = path.join(directory, row.name), data = await readFile(file);
    assert.equal(row.physicalInterface, 'eth0'); assert.equal(row.onlyApprovedEgress, true);
    const allowed = '(tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67)';
    const physicalOut = (await packetLines(file, 'ifindex 2 and outbound and (ip or ip6)')).length;
    const outgoingSsh = (await packetLines(file, 'ifindex 2 and outbound and tcp and src port 22 and dst host 192.168.5.2')).length;
    const unapproved = (await packetLines(file, `ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`)).length;
    assert.ok(physicalOut > 0 && outgoingSsh > 0); assert.equal(physicalOut, row.physicalOutPackets); assert.equal(unapproved, 0);
    assert.equal(data.includes(Buffer.from('MU_EGRESS_SYNTHETIC_RECEIPT')), false);
    captures.push({ name: row.name, sha256: hash(data), physicalOut, outgoingSsh, unapproved });
  }
  const evidence = { passed: true, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), packageCdHash: report.packageCdHash,
    compiledModulesVerified: modules.length, upstreamProtocol:protocol, upstreamFaultsBeforeLeaseVerified:bridgeOwner, probeBeforeBusinessLeaseVerified: true, developerProbeBypassDenied: true,
    privateGuardsBeforeListenersVerified: true, udpRejectedBeforeDns: true, captures, temporaryResourcesRemoved: true,
    verifierSha256: hash(await readFile(import.meta.filename)), packetReaderSha256: hash(await readFile(path.join(root, 'scripts/packet-capture.ts'))),
    scope: `Frozen packaged modules and real guest with synthetic TLS exit receipts through ${protocol}: closed-lease startup check, developer listener denial, changed/malformed/wrong-name/offline quarantine, real terminal/bridge/busy-task revocation, ${expectedStarts} captures${bridgeOwner?', upstream authentication/certificate faults and recovery':''}. Not actual Electron UI, successful domain resolution, actual public IP change, residential, first boot, day-long or Mac sleep acceptance.` };
  await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 }); console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  const failure = { passed: false, verifiedAt: new Date().toISOString(), reportSha256: hash(bytes), error: (error as Error).stack };
  await writeFile(output, JSON.stringify(failure, null, 2), { mode: 0o600 }); console.error(JSON.stringify(failure, null, 2)); process.exitCode = 1;
}
