import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../server/process.ts';
import { validateBackupBrowser } from './backup-browser-fixture.ts';
import { packetLines } from './packet-capture.ts';

const power=process.argv.includes('--power');
const probe=process.argv.includes('--probe');
const bridgeOwner=process.argv.includes('--bridge-owner');
const transport=process.argv.includes('--transport')||probe||bridgeOwner;
const monitor=process.argv.includes('--monitor')||transport;
const recovery=process.argv.includes('--recovery')||monitor;
const storage=process.argv.includes('--storage')||recovery;
const network=process.argv.includes('--network')||storage;
const delivery=process.argv.includes('--delivery')||power||network;
const reportName=`packaged-workflow-${bridgeOwner?'bridge-owner':probe?'probe':transport?'transport':monitor?'monitor':recovery?'recovery':storage?'storage':network?'network':power?'power':delivery?'delivery':'latest'}`;
const root=path.resolve(import.meta.dirname,'..'),bytes=await readFile(path.join(root,`test-results/${reportName}.json`));
const source=JSON.parse(bytes.toString()),hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const {PNG}=createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
try{
assert.equal(source.passed,true);assert.equal(source.accountFree,true);assert.equal(source.paidModelCalls,0);
assert.equal(source.actualElectronPackageTested,true);assert.equal(source.actualVmTested,true);
assert.equal(source.freshVmTested,true);assert.equal(source.reusedTestVm,false);assert.equal(source.testResourcesRemoved,true);
assert.equal(source.demoMode,true);assert.equal(source.firstAccountOnboardingTested,false);assert.equal(source.desktopIntegrationTested,false);
assert.equal(source.officialBrowserCacheReused,true);assert.equal(source.officialNetworkCacheReused,true);
assert.deepEqual(source,JSON.parse(await readFile(path.join(source.artifactsDirectory,'report.json'),'utf8')));
assert.deepEqual(Object.keys(source.sources).sort(),['scripts/verify-packaged-workflow.ts','scripts/claude-local-fixture.ts','scripts/claude-tui-workflow.ts','scripts/backup-browser-fixture.ts'].sort());
assert.deepEqual(Object.keys(source.package.modules).sort(),['desktop/main.cjs','dist-server/server/manager.js','dist-server/server/runtime.js','dist-server/server/service.js','dist-server/server/protected-base.js','dist-server/server/host-bridge.js','dist-server/server/bridge-guest.js','dist-server/server/snapshots.js','dist-server/server/backups.js','dist-server/server/guest-browser.js','dist-server/server/guest-browser-runtime.js','dist-server/server/guest-browser-sandbox.js','dist-server/server/network-guard.js','dist-server/server/transparent-network.js','dist-server/shared/types.js',...(transport?['dist-server/server/proxy-transport.js']:[]),...(network?['dist-server/server/host-network.js','native/bin/mu-network-monitor']:[]),...(storage?['dist-server/server/guest-privileges.js','dist-server/server/guest-storage.js']:[]),...(recovery?['dist-server/server/disk-recovery.js','dist-server/server/guest-disk.js']:[])].sort());
for(const [file,digest] of Object.entries(source.sources)){
  const archived=path.join(source.artifactsDirectory,`source-${path.basename(file)}`);
  const content=await readFile(archived).catch(()=>readFile(path.join(root,file)));
  assert.equal(hash(content),digest,file);
  if(delivery)assert.equal(hash(await readFile(path.join(root,file))),digest,file);
}
for(const [file,digest] of Object.entries(source.artifacts))assert.equal(hash(await readFile(path.join(source.artifactsDirectory,file))),digest,file);
assert.equal(source.package.cdHash,bridgeOwner?'9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3':probe?'93781410161fcf4560c244ce5469b980ffc38976':transport?'7395e50362e01c36299c4eacabe0cbedb636cf22':monitor?'b3b92b627f33d1b810011558fa4ba0c18cddd934':recovery?'e1caee59d8049dccf71e42c2e37bf62518d2d05a':storage?'45e0b4a3475ace48909deee9155ada564fed65a3':network?'cf031a2a4bbc9d55cc8b1d97e77a935b312145d2':power?'4227377499a5aaeba73db3f31b821e44a5234aff':delivery?'26511866b6077c14947fc169a03e5496ba887a83':'b0cd06dd921a9ba759336fb39c8cb6e40e22fde4');
const bundle=path.join(root,`release/${bridgeOwner?'bridge-owner-candidate':probe?'proxy-probe-candidate':transport?'proxy-transport-guard-candidate':monitor?'disk-recovery-monitor-candidate':recovery?'disk-recovery-candidate':storage?'guest-capacity-fix-candidate':network?'host-network-candidate':power?'host-power-fix-candidate':delivery?'local-test-candidate':'boot-capture-candidate'}/mac-arm64/MuCodeSandbox.app`);assert.equal(source.package.bundle,bundle);
if(transport)assert.equal(source.proxyTransportPackageTested,true);
if(storage)assert.equal(source.storagePackageTested,true);
if(recovery){
  assert.equal(source.diskRecoveryPackageTested,true);
  assert.deepEqual(source.diskGrowth,{actualUiGrow:true,fromGiB:10,toGiB:12,stoppedAfterGrowth:true,journalCleared:true});
  assert.equal(source.importedDiskGiB,12);
}
if(power)assert.equal(source.powerPackageTested,true);
if(network){
  assert.equal(source.hostNetworkPackageTested,true);assert.equal(source.noUnintendedHostNetworkStops,true);
  assert.ok(source.stages.length>5&&source.stages.every((stage:any)=>stage.hostNetwork.state==='ready'));
}
if(delivery){
  assert.equal(source.deliveryPackageTested,true);assert.equal(source.creation.actualUiCreate,true);
  assert.equal(source.creation.diskGiB,10);assert.equal(source.creation.memoryGiB,2);assert.equal(source.creation.cpus,2);
  assert.equal(source.creation.stateBeforeFirstBoot,'not_created');assert.equal(source.creation.strict,true);assert.equal(source.creation.transparent,true);
  assert.deepEqual(source.creation.identity,{timezone:'Asia/Tokyo',locale:'ja-JP'});assert.equal(source.creation.browserUrlSetThroughApi,true);
}
await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
const signature=await run('/usr/bin/codesign',['-d','--verbose=4',bundle]);assert.match(signature,/Signature=adhoc/);
assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1],source.package.cdHash);
for(const [file,digest] of Object.entries(source.package.modules)){
  assert.equal(hash(await readFile(path.join(bundle,'Contents/Resources/app',file))),digest,file);
  if(file==='native/bin/mu-network-monitor'){
    const owned=await mkdtemp(path.join(tmpdir(),'mu-workflow-native-'));
    try{
      const digests=[];
      for(const [name,directory] of [['source',root],['packaged',path.join(bundle,'Contents/Resources/app')]]){
        const target=path.join(owned,name!);await copyFile(path.join(directory!,file),target);
        await run('/usr/bin/codesign',['--remove-signature',target]);
        await run('/usr/bin/codesign',['--sign','-','--identifier','mu-network-monitor',target]);
        digests.push(hash(await readFile(target)));
      }
      assert.equal(digests[0],digests[1]);
    }finally{await rm(owned,{recursive:true,force:true});}
  }else assert.equal(hash(await readFile(path.join(root,file))),digest,file);
}
const app=source.package.application;assert.equal(app.packaged,true);assert.equal(app.appPath,path.join(bundle,'Contents/Resources/app'));
assert.equal(app.sandboxDisablingArgumentsAbsent,true);assert.ok(app.renderers.length>0&&app.renderers.every((item:any)=>item.sandboxed));
assert.equal(source.firstBoot.developerElevationRejected,true);assert.equal(source.firstBoot.reusedCapture,false);
assert.equal(source.networkdRestartPreservedBootCapture,true);
for(const capture of [source.firstBoot,source.restartBoot,source.firstBootImported,...(recovery?[source.growthBoot]:[])]){
  assert.match(capture.bootId,/^[a-f0-9-]{36}$/);assert.equal(capture.capturedBootId,capture.bootId);
  assert.equal(capture.activeState,'active');assert.equal(capture.subState,'exited');
}
assert.equal(new Set([source.firstBoot.bootId,source.restartBoot.bootId,source.firstBootImported.bootId]).size,3);
if(recovery)assert.equal(new Set([source.firstBoot.bootId,source.growthBoot.bootId,source.restartBoot.bootId,source.firstBootImported.bootId]).size,4);
assert.equal(source.client.installed,true);assert.match(source.client.version,/^2\.\d+\.\d+ \(Claude Code\)$/);assert.match(source.client.nodeVersion,/^v24\./);
assert.equal(source.loginRequests,1);assert.equal(source.browserEvidence.loginRequests,1);
assert.equal(source.browserEvidence.receipts.length,4);
const browserObservations=[];
for(const [index,name] of ['Initial','Restarted','Restored','Imported'].entries()){
  const value=source[`browser${name}`];validateBackupBrowser(value.receipt);
  assert.deepEqual(value.receipt,source.browserEvidence.receipts[index]);assert.equal(value.inspection.matchesConfiguration,true);
  if(index===0)assert.deepEqual(value.receipt.before,{cookie:'',documentCookie:'',localStorage:null,indexedDB:null});
  else assert.deepEqual(value.receipt.before,value.receipt.after);
  const image=PNG.sync.read(await readFile(path.join(source.artifactsDirectory,`browser-${name.toLowerCase()}.png`)));
  assert.equal(image.width,1280);assert.equal(image.height,800);
  const colors=new Set<string>();for(let offset=0;offset<image.data.length;offset+=400)colors.add(image.data.subarray(offset,offset+3).toString('hex'));
  assert.ok(colors.size>20);assert.equal(value.pixels.width,image.width);assert.equal(value.pixels.height,image.height);assert.ok(value.pixels.colors>20);
  browserObservations.push({stage:name,width:image.width,height:image.height,sampledColors:colors.size});
}
for(const field of ['bridge','snapshot','backup','denial','permissions','cancellation']){
  for(const [key,value] of Object.entries(source[field]))if(key!=='key')assert.equal(value,true,`${field}.${key}`);
}
for(const key of ['actualUiGrant','repeatedDirectoryListings','approvedGitStatus','unapprovedGitRejected','writableDoesNotApproveCommands'])assert.equal(source.bridge[key],true,key);
for(const [field,keys] of [
  ['snapshot',['actualUiCreate','actualUiRestore','changedDiskRestored','previousGrantRejected']],
  ['backup',['actualUiExportImport','independentVmIdentity','noSharedMountsOrPorts','diskAndBrowserDataPreserved','oldGrantRejected']],
  ['denial',['selectedNoThroughTui','fileAbsentAfterRefusal','actualErrorToolReceiptInNextTurn']],
  ['permissions',['writeAbsentBeforeApproval','actualWriteReadBash','noBlanketToolAllow','bashWriteAbsentBeforeApproval','bashWriteApprovedThroughTui']],
  ['cancellation',['streamClosed','sameCliProcessAlive','nextInteractiveTurnSucceeded']],
] as const)for(const key of keys)assert.equal(source[field][key],true,`${field}.${key}`);
assert.equal(source.nativeTextInputPositiveControl,true);assert.equal(source.terminalFocus.textareaFocused,true);
assert.equal(source.interactiveProcesses.length,1);assert.notEqual(source.interactiveProcesses[0].uid,'0');
assert.deepEqual(source.processesAfterCancel,source.interactiveProcesses);assert.equal(source.reopenedProcesses.length,1);
assert.notEqual(source.reopenedProcesses[0].pid,source.interactiveProcesses[0].pid);assert.deepEqual(source.processesAfterDisconnect,[]);
assert.equal(source.nativeHostPty.applicationPid,app.pid);
for(const name of ['limactl','ssh'])assert.ok(source.nativeHostPty.processes.some((item:any)=>path.basename(item.command)===name&&item.tty!=='??'));
for(const field of ['actualTerminalPaneClosed','hostPtyProcessesExited','guestCliExited','streamClosed'])assert.equal(source.terminalDisconnect[field],true,field);
assert.equal(source.terminalDisconnect.actualPageClosed,false);assert.equal(source.cancellation.key,'Escape');
assert.ok(source.reopen.resumedPromptTurns>source.reopen.previousTurnsInActualRequest);
const completed=source.messages.find((item:any)=>item.scenario==='TOOLS'&&item.emittedTool===null);
assert.equal(completed.toolResults.length,3);assert.ok(completed.toolResults.every((item:any)=>!item.error));assert.ok(completed.historyToolResults.some((item:any)=>item.error));
const bash=source.messages.find((item:any)=>item.scenario==='BASH'&&item.emittedTool===null);assert.equal(bash.toolResults.length,1);assert.equal(bash.toolResults[0].error,false);
const waiting=source.messages.filter((item:any)=>item.scenario==='WAIT');assert.ok(waiting.length>=2&&waiting.every((item:any)=>item.disconnected&&!item.completed));
assert.ok(source.messages.some((item:any)=>item.scenario==='TEXT'&&item.completed&&item.promptTurns===source.reopen.resumedPromptTurns));
for(const [file,pattern] of [['write-denied',/User rejected write/],['bash-permission',/Do you want to proceed/],['waiting',/MU_REAL_CLAUDE_WAITING/],['same-process-recovered',/MU_REAL_CLAUDE_TEXT_OK/]] as const){
  assert.match(await readFile(path.join(source.artifactsDirectory,`${file}.txt`),'utf8'),pattern);
  const image=PNG.sync.read(await readFile(path.join(source.artifactsDirectory,`${file}.png`)));assert.ok(image.width>0&&image.height>0);
}
const permitted=source.proxyDecisions.filter((item:any)=>item.localOnly&&item.allowed);assert.ok(permitted.length>0);
assert.ok(permitted.every((item:any)=>['203.0.113.80:80','203.0.113.81:80'].includes(item.destination)));
assert.ok(source.proxyDecisions.every((item:any)=>!/(?:^|\.)(?:anthropic\.com|claude\.ai|claude\.com):/.test(item.destination)||!item.allowed));
for(const item of [source.protectionBefore,source.protectionAfter,source.protectionImported])assert.ok(item.active&&item.integrity==='verified');
if(transport){
  for(const item of [source.protectionBefore,source.protectionAfter,source.protectionImported])assert.ok(item.proxyEndpoints.length===1&&/^127\.0\.0\.1:\d+$/.test(item.proxyEndpoints[0]));
}else for(const key of ['firewallHash','tunnelConfigHash'])assert.equal(source.protectionBefore[key],source.protectionAfter[key]);
assert.equal(source.directBypassRejected,true);assert.deepEqual(source.uiErrors,[]);assert.equal(source.cleanupErrors,undefined);assert.equal(source.captureError,undefined);
const captures=[];
for(const [name,metadata] of [['first-boot',source.firstBoot],...(recovery?[['growth-boot',source.growthBoot]]:[]),['original',source.captureOriginal],['restart-boot',source.restartBoot],['imported-first-boot',source.firstBootImported],['imported',source.captureImported]] as const){
  assert.equal(metadata.interfaceIndex,2);assert.equal(metadata.file,`${name}.pcap`);assert.equal(metadata.gateway,'192.168.5.2');
  assert.ok(Number.isInteger(metadata.proxyPort)&&metadata.proxyPort>0&&metadata.proxyPort<=65535);
  const file=path.join(source.artifactsDirectory,metadata.file),raw=await readFile(file);assert.equal(raw.length,metadata.bytes);assert.equal(hash(raw),metadata.sha256);
  const proxy=`tcp and dst host ${metadata.gateway} and dst port ${metadata.proxyPort}`,ssh=`tcp and src port 22 and dst host ${metadata.gateway}`,dhcp='udp and src port 68 and dst port 67';
  const packets=(filter:string)=>packetLines(file,`(ifindex 2 and outbound) and (${filter})`);
  const physical=await packets('ip or ip6'),approved=await packets(proxy),approvedSsh=await packets(ssh),bad=await packets(`ip6 or (ip and not (${transport?'':`(${proxy}) or `}(${ssh}) or (${dhcp})))`);
  assert.ok(physical.length>0);assert.equal(physical.length,metadata.physicalOut);assert.equal(approved.length,metadata.approvedProxy);
  if(name==='original'||name==='imported')assert.ok((transport?approvedSsh:approved).length>0);
  if(transport){assert.equal(approved.length,0);assert.equal(metadata.approvedSsh,approvedSsh.length);}
  assert.deepEqual(bad,[]);assert.equal(metadata.unapproved,0);captures.push({name,physicalPackets:physical.length,approvedProxy:approved.length,...(transport?{approvedSsh:approvedSsh.length}:{}),unapproved:0});
}
assert.notEqual(source.firstBoot.sha256,source.firstBootImported.sha256);
assert.equal(source.lifecycleEvents.filter((item:any)=>item.event==='application-process-exit').length,1);
assert.ok(!source.lifecycleEvents.some((item:any)=>item.event==='window-crash'));
const result={passed:true,verifiedAt:new Date().toISOString(),reportSha256:hash(bytes),verifierSha256:hash(await readFile(path.join(root,'scripts/verify-packaged-workflow-evidence.ts'))),packetReaderSha256:hash(await readFile(path.join(root,'scripts/packet-capture.ts'))),cdHash:source.package.cdHash,actualElectronAndFreshVmWorkflow:true,
  fourBrowserPersistenceObservations:browserObservations,actualCliTuiAndHostPtyCleanup:true,actualUiFileAndCommandGrants:true,actualUiSnapshotAndEncryptedImport:true,
  captures,threeDistinctKernelBootCaptures:true,networkdRestartPreservedBootCapture:true,deepStrictSignatureAndSourceModuleArtifactHashesVerified:true,testResourcesRemoved:true,
  ...(recovery?{expandedGuestWorkflowVerified:true,fourDistinctKernelBootCaptures:true}:{}),
  scope:recovery?'Frozen recovery package UI growth followed by full official browser, interactive CLI, host grants, snapshot and encrypted import on expanded guest; four distinct normal kernel boots and six raw captures; no maintenance first-packet, hard-crash, paid account, shared mount, WireGuard, power loss, long-term or second-Mac claim':'Latest frozen Electron package transparent-mode workflow with official browser and CLI/local synthetic gateway, original and imported first-boot/task captures; no paid account, WireGuard, shared mount, power loss, long-term or second-Mac claim'};
await writeFile(path.join(root,`test-results/${reportName}-evidence.json`),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result,null,2));
}catch(error){
  const failure={passed:false,verifiedAt:new Date().toISOString(),reportSha256:hash(bytes),error:(error as Error).stack,
    scope:'Independent review failed; observation success is not full workflow acceptance'};
  await writeFile(path.join(root,`test-results/${reportName}-evidence.json`),JSON.stringify(failure,null,2),{mode:0o600});
  console.error(JSON.stringify(failure,null,2));process.exitCode=1;
}
