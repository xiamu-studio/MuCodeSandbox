import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { run } from '../server/process.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const bridgeOwner=process.argv.includes('--bridge-owner');
const monitor=process.argv.includes('--monitor')||bridgeOwner;
const recovery=process.argv.includes('--recovery')||monitor;
const network=process.argv.includes('--network')||recovery,latest=process.argv.includes('--latest')||network;
const name=bridgeOwner?'shared-mounts-ui-bridge-owner':monitor?'shared-mounts-ui-monitor':recovery?'shared-mounts-ui-recovery':network?'shared-mounts-ui-network':latest?'shared-mounts-ui-latest':'shared-mounts-ui';
const input = path.join(root, 'test-results',`${name}.json`);
const bytes = await readFile(input), report = JSON.parse(bytes.toString());
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
try{
assert.equal(report.passed, true); assert.equal(report.freshVmTested, true); assert.equal(report.electronDesktopUiTested, true);
assert.equal(report.actualUiCreation, true); assert.equal(report.testResourcesRemoved, true); assert.deepEqual(report.uiErrors, []);
assert.equal(report.accountFree, true); assert.equal(report.paidModelCalls, 0);
assert.equal(report.package.cdHash, bridgeOwner?'9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3':monitor?'b3b92b627f33d1b810011558fa4ba0c18cddd934':recovery?'e1caee59d8049dccf71e42c2e37bf62518d2d05a':network?'cf031a2a4bbc9d55cc8b1d97e77a935b312145d2':latest?'b0cd06dd921a9ba759336fb39c8cb6e40e22fde4':'5558c78a8c1feee996ee31da5149d338d183fa27');
if(recovery)assert.equal(report.diskRecoveryPackageTested,true);
if(monitor)assert.equal(report.diskRecoveryMonitorPackageTested,true);
assert.equal(path.dirname(report.artifactsDirectory), path.join(root, 'test-results'));
assert.deepEqual(Object.keys(report.sources).sort(),['scripts/verify-shared-mounts-ui.ts','scripts/claude-local-fixture.ts','server/guest-mounts.ts','native/probes/shared-mount-id.c'].sort());
for (const [file, expected] of Object.entries(report.sources)) assert.equal(hash(await readFile(path.join(root, file))), expected, `Source changed: ${file}`);
if(bridgeOwner){assert.equal(report.inputsUnchanged,true);assert.deepEqual(report.sources,report.initialSources);assert.deepEqual(report.package.files,report.package.initialFiles);assert.equal(Object.keys(report.package.files).length,46);}
if(network){
  for(const [file,expected]of Object.entries(report.sources))assert.equal(hash(await readFile(path.join(report.artifactsDirectory,`source-${path.basename(file)}`))),expected);
  assert.equal(report.hostNetworkPackageTested,true);assert.equal(report.noUnintendedHostNetworkStops,true);
  assert.ok(report.hostNetworkChecks.length>=5&&report.hostNetworkChecks.every((check:any)=>check.hostNetwork.state==='ready'));
}
for (const [file, expected] of Object.entries(report.artifacts)) {
  assert.equal(path.basename(file), file); assert.equal(hash(await readFile(path.join(report.artifactsDirectory, file))), expected, `Artifact changed: ${file}`);
}
if(latest){
  assert.deepEqual(report,JSON.parse(await readFile(path.join(report.artifactsDirectory,'report.json'),'utf8')));
  assert.equal(report.latestPackageTested,true);assert.equal(report.freshDataDirectory,true);assert.equal(report.reusedProtectedBase,false);
  if(network)assert.equal(report.diskBudgetChosenThroughUi,true);else assert.equal(report.testDiskBudgetAdjustedThroughApi,true);
  assert.equal(report.networkArchiveCacheReused,true);assert.equal(report.cleanupErrors,undefined);
  const bundle=path.join(root,`release/${bridgeOwner?'bridge-owner-candidate':monitor?'disk-recovery-monitor-candidate':recovery?'disk-recovery-candidate':network?'host-network-candidate':'boot-capture-candidate'}/mac-arm64/MuCodeSandbox.app`),appRoot=path.join(bundle,'Contents/Resources/app');
  assert.equal(report.package.bundle,bundle);await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
  const signature=await run('/usr/bin/codesign',['-d','--verbose=4',bundle]);assert.match(signature,/Signature=adhoc/);
  assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1],report.package.cdHash);
  const files=['desktop/main.cjs',...(await readdir(path.join(appRoot,'dist-server/server'))).filter(file=>file.endsWith('.js')).map(file=>`dist-server/server/${file}`)];
  assert.deepEqual(Object.keys(report.package.files).sort(),files.sort());
  for(const file of files){assert.equal(hash(await readFile(path.join(appRoot,file))),report.package.files[file],file);assert.equal(hash(await readFile(path.join(root,file))),report.package.files[file],file);}
  const app=report.package.application;assert.equal(app.packaged,true);assert.equal(app.appPath,appRoot);
  assert.equal(app.sandboxDisablingArgumentsAbsent,true);assert.ok(app.renderers.length>0&&app.renderers.every((renderer:any)=>renderer.sandboxed));
  assert.equal(report.probe.compilerInstalled,false);assert.equal(report.probe.reusedSmallIdentityProbe,true);
  assert.equal(hash(await readFile(path.join(report.artifactsDirectory,'identity-probe.elf'))),'3bbb4224e1ab805b90938c789c98e02f276160d6fdd1b936be0f0f08fdfa2c7f');
  const bootCaptures=[report.stages[0].capture,report.stages[1].capture,report.demotion.bootCapture];
  for(const capture of bootCaptures){assert.match(capture.bootId,/^[a-f0-9-]{36}$/);assert.equal(capture.capturedBootId,capture.bootId);assert.equal(capture.activeState,'active');assert.equal(capture.subState,'exited');}
  assert.equal(new Set(bootCaptures.map(capture=>capture.bootId)).size,3);
  assert.equal(report.mobileBounds.width,390);assert.equal(report.mobileBounds.scroll,390);
  const {PNG}=createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
  for(const name of ['first-boot','reboot','demoted-mobile']){
    const png=PNG.sync.read(await readFile(path.join(report.artifactsDirectory,`${name}.png`))),colors=new Set<string>();
    for(let n=0;n<png.data.length;n+=400)colors.add(png.data.subarray(n,n+3).toString('hex'));
    assert.ok(png.width>=390&&png.height>=600&&colors.size>20);
  }
}
assert.deepEqual(report.stages.map((s: any) => s.stage), ['first-boot', 'reboot']);
for (const stage of report.stages) {
  assert.deepEqual(stage.inspection.issues, []); assert.equal(stage.boot.length, 2);
  assert.equal(stage.identity, `${report.devUid} ${report.devUid} 0`); assert.equal(stage.readonlyIdentity, stage.identity);
  assert.ok(stage.protection.active && stage.protection.integrity === 'verified');
}
assert.ok(report.stages[0].boot.every((m: any) => !m.alreadyMounted));
assert.ok(report.stages[1].boot.every((m: any) => !m.alreadyMounted || ['nosuid', 'nodev'].every(flag => m.previousOptions.split(',').includes(flag))));
assert.equal(report.positiveControl.metadataBefore, `${report.controlUid}:${report.controlUid} 4755`);
assert.equal(report.positiveControl.sharedIdentityWithoutNosuid, `${report.devUid} ${report.controlUid} 0`);
assert.equal(report.positiveControl.nativeIdentity, `${report.devUid} ${report.controlUid} 0`);
assert.equal(report.positiveControl.restoredIdentity, `${report.devUid} ${report.devUid} 0`);
assert.ok(report.demotion.actualUiSave && report.demotion.previousWriteRejected && report.demotion.existingFilePreserved);
assert.deepEqual(report.demotion.inspection.issues, []);
const endpoint = bridgeOwner?`${report.stages[0].capture.gateway}:${report.stages[0].capture.proxyPort}`:report.stages[0].protection.proxyEndpoints[0]; assert.match(endpoint, /^\d+\.\d+\.\d+\.\d+:\d+$/);
const [gateway, port] = endpoint.split(':');
const captures = [
  ['first-boot', report.stages[0].capture], ['first-boot-task', report.stages[0].taskCapture],
  ['reboot-task', report.stages[1].taskCapture], ['demoted-task', report.demotion.taskCapture],
  ...(latest?[['reboot',report.stages[1].capture],['demoted-boot',report.demotion.bootCapture]] as const:[]),
] as const;
const checks = [];
for (const [name, measured] of captures) {
  const file = path.join(report.artifactsDirectory, `${name}.pcap`), data = await readFile(file);
  assert.equal(data.length, measured.bytes); assert.equal(hash(data), measured.sha256); assert.equal(measured.physicalInterface, 'eth0');
  if(latest)assert.equal(measured.interfaceIndex,2);
  // SLL2 stores the guest interface index. Local interface names differ on macOS.
  const packets = await packetLines(file, 'ifindex 2 and outbound and (ip or ip6)');
  assert.equal(packets.length, measured.physicalPackets); assert.ok(packets.length > 0);
  const approved = await packetLines(file, `ifindex 2 and outbound and tcp and dst host ${gateway} and dst port ${port}`); assert.equal(approved.length, measured.approvedProxy);
  const approvedSsh=await packetLines(file,`ifindex 2 and outbound and tcp and src port 22 and dst host ${gateway}`);
  const allowed=`${bridgeOwner?'':`(tcp and dst host ${gateway} and dst port ${port}) or `}(tcp and src port 22 and dst host ${gateway}) or (udp and src port 68 and dst port 67)`;
  const unapproved = await packetLines(file, `ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`);
  assert.deepEqual(unapproved, []); assert.equal(measured.unapproved, 0);
  if (name.endsWith('-task')) {
    assert.ok((bridgeOwner?approvedSsh:approved).length > 0); assert.equal(measured.controlledRequest.address, '127.0.0.1'); assert.equal(measured.directPhysicalBypassRejected, true);
  }
  if(bridgeOwner){assert.equal(approved.length,0);assert.equal(approvedSsh.length,measured.approvedSsh);assert.ok(approvedSsh.length>0);}
  checks.push({ name, physicalPackets: packets.length, approvedProxy: approved.length, approvedSsh:approvedSsh.length, unapproved: 0 });
}
const evidence = { passed: true, verifiedAt: new Date().toISOString(), input: path.relative(root, input), reportSha256: hash(bytes),
  freshDataDirectory: report.freshDataDirectory, reusedProtectedBase: report.reusedProtectedBase, sourcesAndArtifactsVerified: true,
  actualIdentityPositiveControlVerified: true, rawCaptures: checks, testResourcesRemoved: true,
  latestPackageTested:latest,packageCdHash:report.package.cdHash,threeDistinctBootRecordsVerified:latest,
  verifierSha256:hash(await readFile(path.join(root,'scripts/verify-shared-mounts-ui-evidence.ts'))),
  packetReaderSha256:hash(await readFile(path.join(root,'scripts/packet-capture.ts'))),
  scope: 'Independent validation of saved actual UI evidence and raw SLL2 captures, not a new live VM run' };
await writeFile(path.join(root, 'test-results',`${name}-evidence.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify(evidence, null, 2));
}catch(error){
  const failed={passed:false,verifiedAt:new Date().toISOString(),reportSha256:hash(bytes),error:(error as Error).stack};
  await writeFile(path.join(root,'test-results',`${name}-evidence.json`),JSON.stringify(failed,null,2),{mode:0o600});console.error(JSON.stringify(failed,null,2));process.exitCode=1;
}
