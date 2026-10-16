import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { run } from '../server/process.ts';
import { validateBackupBrowser } from './backup-browser-fixture.ts';
import { packetLines } from './packet-capture.ts';

const root = path.resolve(import.meta.dirname, '..');
const wireguard = process.argv.includes('--wireguard');
const bridgeOwner=process.argv.includes('--bridge-owner');
assert.ok(!bridgeOwner||wireguard,'Current scope is WireGuard only');
const monitor=process.argv.includes('--monitor')||bridgeOwner;
const recovery=process.argv.includes('--recovery')||monitor;
const network=process.argv.includes('--network')||recovery;
const latest=process.argv.includes('--latest')||network;assert.ok(!latest||wireguard,'Latest scope is WireGuard only');
const packaged = wireguard || process.argv.includes('--packaged');
const name = bridgeOwner?'claude-tui-wireguard-bridge-owner':monitor?'claude-tui-wireguard-monitor':recovery?'claude-tui-wireguard-recovery':network?'claude-tui-wireguard-network':latest?'claude-tui-wireguard-latest':wireguard ? 'claude-tui-wireguard' : packaged ? 'claude-tui-packaged' : 'claude-tui';
let artifacts = path.join(root, 'test-results', name);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(),
  scope: `Read-only audit of recorded ${packaged ? 'packaged Electron native' : 'source web'} terminal TUI evidence${wireguard ? ' over WireGuard' : ''}; no VM or account started`, captures: [] };
try {
  const bytes = await readFile(path.join(root, 'test-results', `${name}.json`)), source = JSON.parse(bytes.toString());
  if(latest){artifacts=source.artifactsDirectory;assert.equal(path.dirname(artifacts),path.join(root,'test-results'));assert.match(path.basename(artifacts),bridgeOwner?/^claude-tui-wireguard-bridge-owner-\d+$/:monitor?/^claude-tui-wireguard-monitor-\d+$/:recovery?/^claude-tui-wireguard-recovery-\d+$/:network?/^claude-tui-wireguard-network-\d+$/:/^claude-tui-wireguard-latest-\d+$/);}
  if(recovery)assert.equal(source.diskRecoveryPackageTested,true);
  if(monitor)assert.equal(source.diskRecoveryMonitorPackageTested,true);
  if(latest)for(const field of ['cleanupError','applicationCloseError','captureError','gatewayCleanupError'])assert.equal(source[field],undefined,field);
  report.observationSha256 = hash(bytes);
  assert.equal(source.passed, true); assert.equal(source.accountFree, true); assert.equal(source.paidModelCalls, 0);
  assert.equal(source.reusedTestVm, false); assert.equal(source.testDataRemoved, true);
  assert.equal(source.demoMode, true); assert.equal(source.firstAccountOnboardingTested, false);
  assert.equal(source.client.installed, true); assert.match(source.client.executableSha256, /^[a-f0-9]{64}$/);
  const files = wireguard
    ? ['scripts/verify-claude-tui-wireguard.ts', 'scripts/packet-capture.ts', 'scripts/claude-wireguard-fixture.ts', 'scripts/claude-tui-workflow.ts', 'server/runtime.ts', 'server/mock-messages.ts',...(latest?['scripts/backup-browser-fixture.ts']:[])]
    : packaged
    ? ['scripts/verify-claude-tui-packaged.ts', 'scripts/claude-tui-workflow.ts', 'scripts/claude-local-fixture.ts', 'server/runtime.ts', 'server/mock-messages.ts']
    : ['scripts/verify-claude-tui.ts', 'scripts/claude-tui-workflow.ts', 'scripts/claude-local-fixture.ts', 'server/mock-messages.ts', 'server/terminal.ts', 'src/TerminalPanel.tsx'];
  assert.deepEqual(Object.keys(source.sources).sort(), files.sort());
  for (const file of files) assert.equal(hash(await readFile(path.join(root, file))), source.sources[file], file);
  if(bridgeOwner){assert.equal(source.inputsUnchanged,true);assert.deepEqual(source.initialSources,source.sources);assert.deepEqual(source.package.initialFiles,source.package.files);assert.equal(Object.keys(source.package.files).length,46);}
  if(network){
    for(const file of files)assert.equal(hash(await readFile(path.join(artifacts,`source-${path.basename(file)}`))),source.sources[file]);
    assert.equal(source.hostNetworkPackageTested,true);
    assert.equal(source.testGatewayMemoryGiB,1);
    assert.ok(source.testGatewayMemoryKiB>800_000&&source.testGatewayMemoryKiB<1_100_000);
    assert.ok(source.hostNetworkChecks.length===5&&source.hostNetworkChecks.every((check:any)=>check.hostNetwork.state==='ready'));
  }
  assert.deepEqual(Object.keys(source.artifacts).sort(), (await readdir(artifacts)).sort());
  for (const [file, expected] of Object.entries(source.artifacts)) {
    assert.equal(path.basename(file), file);
    assert.equal(hash(await readFile(path.join(artifacts, file))), expected, file);
  }
  for (const name of ['initial-ready', 'write-denial-prompt', 'write-denied', 'write-permission', 'tools-completed',
    'bash-permission', 'waiting', 'same-process-recovered', 'continued-conversation', 'continued-turn-completed', 'before-terminal-disconnect']) {
    const png = await readFile(path.join(artifacts, `${name}.png`));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.ok(png.length > 1000);
    assert.ok(source.artifacts[`${name}.png`] && source.artifacts[`${name}.txt`]);
  }
  assert.match(await readFile(path.join(artifacts, 'write-denial-prompt.txt'), 'utf8'), /3\. No/);
  assert.match(await readFile(path.join(artifacts, 'write-denied.txt'), 'utf8'), /User rejected write/);
  assert.match(await readFile(path.join(artifacts, 'bash-permission.txt'), 'utf8'), /Do you want to proceed/);
  assert.match(await readFile(path.join(artifacts, 'waiting.txt'), 'utf8'), /MU_REAL_CLAUDE_WAITING/);
  assert.match(await readFile(path.join(artifacts, 'same-process-recovered.txt'), 'utf8'), /MU_REAL_CLAUDE_TEXT_OK/);
  assert.equal(source.denial.actualErrorToolReceiptInNextTurn, true); assert.equal(source.denial.fileAbsentAfterRefusal, true);
  for (const key of ['writeAbsentBeforeApproval', 'actualWriteReadBash', 'noBlanketToolAllow', 'bashWriteAbsentBeforeApproval', 'bashWriteApprovedThroughTui'])
    assert.equal(source.permissions[key], true, key);
  assert.equal(source.interactiveProcesses.length, 1); assert.notEqual(source.interactiveProcesses[0].uid, '0');
  assert.deepEqual(source.processesAfterCancel, source.interactiveProcesses);
  assert.equal(source.reopenedProcesses.length, 1); assert.notEqual(source.reopenedProcesses[0].pid, source.interactiveProcesses[0].pid);
  assert.deepEqual(source.processesAfterDisconnect, []);
  for (const key of ['streamClosed', 'sameCliProcessAlive', 'nextInteractiveTurnSucceeded']) assert.equal(source.cancellation[key], true, key);
  assert.equal(source.cancellation.key, 'Escape');
  assert.ok(source.reopen.resumedPromptTurns > source.reopen.previousTurnsInActualRequest);
  for (const key of packaged
    ? ['actualTerminalPaneClosed', 'guestCliExited', 'streamClosed', 'hostPtyProcessExited']
    : ['actualPageClosed', 'guestCliExited', 'streamClosed', 'hostPtyRemoved']) assert.equal(source.terminalDisconnect[key], true, key);
  if (packaged) {
    assert.equal(source.terminalDisconnect.actualPageClosed, false);
    assert.equal(source.packagedLifecycleAndColdInstall, true);
    const bundle = path.join(root, `release/${bridgeOwner?'bridge-owner-candidate':monitor?'disk-recovery-monitor-candidate':recovery?'disk-recovery-candidate':network?'host-network-candidate':latest?'boot-capture-candidate':'tui-candidate'}/mac-arm64/MuCodeSandbox.app`);
    assert.equal(source.package.bundle, bundle);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
    assert.equal(source.package.cdHash, bridgeOwner?'9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3':monitor?'b3b92b627f33d1b810011558fa4ba0c18cddd934':recovery?'e1caee59d8049dccf71e42c2e37bf62518d2d05a':network?'cf031a2a4bbc9d55cc8b1d97e77a935b312145d2':latest?'b0cd06dd921a9ba759336fb39c8cb6e40e22fde4':'7d6e3ea1d0b2b22ec466c2f1652279e5ca7bc37e');
    assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1], source.package.cdHash);
    assert.equal(source.package.signature, 'adhoc');
    assert.equal(signature.match(/^Signature=(.+)$/m)?.[1], 'adhoc');
    const app = source.package.application;
    assert.equal(app.packaged, true); assert.equal(app.appPath, path.join(bundle, 'Contents/Resources/app'));
    assert.equal(app.sandboxDisablingArgumentsAbsent, true); assert.ok(app.windows.length > 0);
    assert.ok(app.windows.every((w: any) => w.sandbox && w.contextIsolation && !w.nodeIntegration));
    assert.ok(app.rendererProcesses.length > 0);
    assert.ok(app.rendererProcesses.every((p: any) => Number.isInteger(p.pid) && p.pid > 0 && p.sandboxed === true));
    assert.equal(source.nativeHostPty.applicationPid, app.pid);
    const processes = source.nativeHostPty.processes;
    for (const command of ['limactl', 'ssh']) assert.ok(processes.some((p: any) => path.basename(p.command) === command));
    assert.ok(processes.every((p: any) => Number.isInteger(p.pid) && p.pid > 0 && p.tty !== '??'));
    assert.deepEqual(source.nativeHostProcessesAfterDisconnect, []);
    assert.ok(source.artifacts['terminal-pane-closed.png']);
    const packageRoot = path.join(bundle, 'Contents/Resources/app');
    const packageFiles = ['desktop/main.cjs', ...(await readdir(path.join(packageRoot, 'dist-server/server')))
      .filter(file => file.endsWith('.js')).map(file => `dist-server/server/${file}`)];
    assert.deepEqual(Object.keys(source.package.files).sort(), packageFiles.sort());
    for (const file of packageFiles){assert.equal(hash(await readFile(path.join(packageRoot, file))), source.package.files[file], file);if(latest)assert.equal(hash(await readFile(path.join(root,file))),source.package.files[file],file);}
    report.packageCdHash = source.package.cdHash;
  }
  const completed = source.messages.find((r: any) => r.scenario === 'TOOLS' && r.emittedTool === null);
  assert.equal(completed.toolResults.length, 3); assert.ok(completed.toolResults.every((r: any) => !r.error));
  assert.ok(completed.historyToolResults.some((r: any) => r.error));
  const bash = source.messages.find((r: any) => r.scenario === 'BASH' && r.emittedTool === null);
  assert.equal(bash.toolResults.length, 1); assert.equal(bash.toolResults[0].error, false);
  const waiting = source.messages.filter((r: any) => r.scenario === 'WAIT');
  assert.ok(waiting.length >= 2); assert.ok(waiting.every((r: any) => r.disconnected && !r.completed));
  assert.ok(source.messages.some((r: any) => r.scenario === 'TEXT' && r.completed && r.promptTurns === source.reopen.resumedPromptTurns));
  if (wireguard) {
    assert.equal(source.networkMode, 'wireguard'); assert.equal(source.realPublicLineVerified, false);
    assert.equal(source.separateGatewayVm, true); assert.equal(source.externalForwardingBlockedDuringTasks, true);
    assert.equal(source.gateway.localOnly, true); assert.ok(source.gateway.rejectedForwardPackets > 0);
    assert.ok(source.gateway.clientAddresses.length > 0);
    assert.ok(source.gateway.clientAddresses.every((address: string) => address === '10.77.0.2'));
    const entries = source.gateway.forwardingRules.nftables;
    const chain = entries.find((entry: any) => entry.chain)?.chain;
    assert.equal(chain.family, 'inet'); assert.equal(chain.table, 'mu_tui_local_only');
    assert.equal(chain.hook, 'forward'); assert.equal(chain.prio, -20); assert.equal(chain.policy, 'accept');
    const rules = entries.filter((entry: any) => entry.rule).map((entry: any) => entry.rule);
    assert.equal(rules.length, 2);
    const counter = entries.find((entry: any) => entry.counter?.name === 'external')?.counter;
    assert.equal(counter.packets, source.gateway.rejectedForwardPackets); assert.ok(counter.bytes > 0);
    for (const field of ['saddr', 'daddr']) {
      assert.ok(rules.some((rule: any) => rule.expr.some((expr: any) => expr.match?.op === '==' &&
        expr.match.left?.payload?.protocol === 'ip' && expr.match.left.payload.field === field && expr.match.right === '10.77.0.2') &&
        rule.expr.some((expr: any) => Object.hasOwn(expr, 'drop')) && rule.expr.some((expr: any) => expr.counter === 'external')));
    }
    for (const protection of [source.protectionBefore, source.protectionAfter]) {
      assert.equal(protection.policy, 'packet-tunnel'); assert.equal(protection.transparentActive, true);
      assert.equal(protection.routingReady, true); assert.equal(protection.dnsGuardActive, true);
      assert.match(protection.wireguardStateHash, /^[a-f0-9]{64}$/);
    }
    assert.equal(source.protectionBefore.wireguardStateHash, source.protectionAfter.wireguardStateHash);
    assert.equal(source.captures['first-boot'].peerEndpoint, source.captures.network.peerEndpoint);
    assert.deepEqual(source.protectionBefore.proxyEndpoints, [source.captures.network.peerEndpoint]);
    assert.deepEqual(source.protectionAfter.proxyEndpoints, [source.captures.network.peerEndpoint]);
    if(latest){
      assert.equal(source.latestPackageTested,true);assert.equal(source.officialCachesReused,true);
      assert.equal(source.browserEvidence.loginRequests,1);assert.equal(source.browserEvidence.receipts.length,3);
      const {PNG}=createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
      for(const [index,stage] of ['Initial','Recovered','Restarted'].entries()){
        const browser=source[`browser${stage}`];validateBackupBrowser(browser.receipt);
        assert.deepEqual(browser.receipt,source.browserEvidence.receipts[index]);assert.equal(browser.inspection.matchesConfiguration,true);
        if(index===0){assert.equal(browser.receipt.before.cookie,'');assert.equal(browser.receipt.before.localStorage,null);assert.equal(browser.receipt.before.indexedDB,null);}
        else assert.deepEqual(browser.receipt.before,browser.receipt.after);
        const png=PNG.sync.read(await readFile(path.join(artifacts,`browser-${stage.toLowerCase()}.png`)));
        assert.equal(png.width,1280);assert.equal(png.height,800);const colors=new Set<string>();
        for(let n=0;n<png.data.length;n+=400)colors.add(png.data.subarray(n,n+3).toString('hex'));assert.ok(colors.size>20);
      }
      for(const key of ['normalRequestsRejected','browserOriginRequestsRejected','physicalBypassRejected','recovered'])assert.equal(source.peerLoss[key],true,key);
      assert.deepEqual(source.peerLoss.actualBrowser.positive,{ok:true,body:'MU_BACKUP_NETWORK_OK'});
      assert.deepEqual(source.peerLoss.actualBrowser.recovered,source.peerLoss.actualBrowser.positive);
      assert.equal(source.peerLoss.actualBrowser.unavailable.ok,false);assert.match(source.peerLoss.actualBrowser.unavailable.error,/Timeout|abort|Failed to fetch/i);
      for(const phase of ['before-loss','after-loss'])assert.ok(source.browserRequests.includes(`/probe?mu_probe=${phase}`));
      assert.ok(!source.browserRequests.includes('/probe?mu_probe=during-loss'));
      for(const name of ['first-boot','restart-boot']){assert.match(source.captures[name].bootId,/^[a-f0-9-]{36}$/);assert.equal(source.captures[name].capturedBootId,source.captures[name].bootId);}
      assert.notEqual(source.captures['first-boot'].bootId,source.captures['restart-boot'].bootId);
      assert.equal(source.restartProtection.active,true);assert.equal(source.restartProtection.policy,'packet-tunnel');
      assert.deepEqual(Object.keys(source.captures).sort(),['first-boot','network','restart-boot','restart-network'].sort());
      report.latestBrowserAndPeerFaultAndRestartVerified=true;
    }
  } else {
    const permitted = source.proxyDecisions.filter((r: any) => r.localOnly && r.allowed);
    assert.ok(permitted.length > 0); assert.ok(permitted.every((r: any) => r.destination === '203.0.113.80:80'));
  }
  assert.equal(source.directBypassRejected, true); assert.deepEqual(source.uiErrors, []);
  for (const protection of [source.protectionBefore, source.protectionAfter]) assert.equal(protection.active, true);
  for (const key of ['firewallHash', 'tunnelConfigHash']) assert.equal(source.protectionBefore[key], source.protectionAfter[key]);
  let approvedPackets = 0;
  for (const captureName of wireguard ? latest?['first-boot','network','restart-boot','restart-network']:['first-boot', 'network'] : ['network']) {
    const metadata = wireguard ? source.captures[captureName] : source.capture;
    assert.equal(metadata.unapproved, 0);
    const captureFile = path.join(artifacts, `${captureName}.pcap`);
    assert.ok(source.artifacts[`${captureName}.pcap`]);
    const capture = await readFile(captureFile);
    assert.equal(hash(capture), metadata.sha256); assert.equal(capture.length, metadata.bytes);
    const little = ['d4c3b2a1', '4d3cb2a1'].includes(capture.subarray(0, 4).toString('hex'));
    const linkType = (little ? capture.readUInt32LE(20) : capture.readUInt32BE(20)) & 0xffff;
    assert.equal(linkType, 276); assert.ok(Number.isInteger(source.physicalInterfaceIndex) && source.physicalInterfaceIndex > 0);
    const endpoint = new URL(`${wireguard ? 'udp' : 'tcp'}://${wireguard ? metadata.peerEndpoint : metadata.proxyEndpoint}`);
    assert.equal(endpoint.hostname, '192.168.5.2'); const port = Number(endpoint.port); assert.ok(port > 0 && port <= 65535);
    const proxy = `${wireguard ? 'udp' : 'tcp'} and dst host 192.168.5.2 and dst port ${port}`;
    const ssh = 'tcp and src port 22 and dst host 192.168.5.2', dhcp = 'udp and src port 68 and dst port 67';
    const packets = (filter: string) => packetLines(captureFile, `(ifindex ${source.physicalInterfaceIndex} and outbound) and (${filter})`);
    const rejected = await packets(`ip6 or (ip and not ((${proxy}) or (${ssh}) or (${dhcp})))`);
    assert.deepEqual(rejected, []);
    const approved = await packets(proxy); if (captureName.endsWith('network')) assert.ok(approved.length > 0);
    assert.equal(approved.length, wireguard ? metadata.approvedTunnel : metadata.approvedProxy);
    assert.equal((await packets('ip or ip6')).length, metadata.physicalOut);
    if (captureName.endsWith('boot')) assert.ok((await packets(dhcp)).length > 0);
    approvedPackets += approved.length;
    report.captures.push({ name: captureName, bytes: capture.length, sha256: hash(capture), approvedPackets: approved.length,
      physicalOutputPackets: metadata.physicalOut, unapprovedPackets: rejected.length });
  }
  if (wireguard) report.approvedTunnelPackets = approvedPackets;
  else report.approvedProxyPackets = approvedPackets;
  report.wireguardInteractiveTested = wireguard; report.unapprovedPackets = 0; report.sourceWebTerminalTested = !packaged;
  report.packagedElectronTuiTested = packaged; report.firstAccountOnboardingTested = false; report.passed = true;
  report.verifierSha256 = hash(await readFile(import.meta.filename));
  report.packetReaderSha256 = hash(await readFile(path.join(root, 'scripts/packet-capture.ts')));
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'test-results', `${name}-evidence.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
