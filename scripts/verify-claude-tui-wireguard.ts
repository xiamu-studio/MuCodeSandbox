import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { run } from '../server/process.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { MOCK_FILE, MOCK_BASH_FILE } from '../server/mock-messages.ts';
import type { Environment } from '../shared/types.ts';
import { createClaudeWireguardFixture } from './claude-wireguard-fixture.ts';
import { verifyClaudeTui } from './claude-tui-workflow.ts';
import { backupBrowserFixture, validateBackupBrowser } from './backup-browser-fixture.ts';
import { GUEST_CHROMIUM_VERSION, GUEST_CHROMIUM_SHA256 } from '../server/guest-browser-runtime.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';
import { DevTools } from '../server/guest-browser.ts';
import { packetLines, readPacketCapture } from './packet-capture.ts';

const bridgeOwner=process.argv.includes('--bridge-owner');
const monitor=process.argv.includes('--monitor')||bridgeOwner;
const recovery=process.argv.includes('--recovery')||monitor;
const network=process.argv.includes('--network')||recovery;
const latest=process.argv.includes('--latest')||network;
const root = path.resolve(import.meta.dirname, '..'), name = bridgeOwner?'claude-tui-wireguard-bridge-owner':monitor?'claude-tui-wireguard-monitor':recovery?'claude-tui-wireguard-recovery':network?'claude-tui-wireguard-network':latest?'claude-tui-wireguard-latest':'claude-tui-wireguard';
const bundle = path.join(root, `release/${bridgeOwner?'bridge-owner-candidate':monitor?'disk-recovery-monitor-candidate':recovery?'disk-recovery-candidate':network?'host-network-candidate':latest?'boot-capture-candidate':'tui-candidate'}/mac-arm64/MuCodeSandbox.app`);
const directory = await mkdtemp(path.join(homedir(), '.mu-wgt-'));
const desktopData = await mkdtemp(path.join(homedir(), '.mu-tui-wireguard-user-'));
const artifacts = path.join(root, 'test-results', latest?`${name}-${Date.now()}`:name); await mkdir(artifacts, { recursive: true, mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const browserFixture=backupBrowserFixture('http://203.0.113.81'),browserRequests:string[]=[];
const browserServer=createServer((request,response)=>{
  browserRequests.push(request.url??'/');
  if(request.url==='/read'&&!request.headers.cookie){response.writeHead(302,{Location:'/write'});response.end();return;}
  browserFixture.handler(request,response);
});
if(latest)await new Promise<void>(resolve=>browserServer.listen(0,'127.0.0.1',resolve));
const runtime = new LimaRuntime(directory), fixture = await createClaudeWireguardFixture(runtime, directory, latest?(browserServer.address() as {port:number}).port:undefined, network?1:2);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), accountFree: true, paidModelCalls: 0,
  scope: 'Actual packaged Electron interactive Claude Code over a real two-VM WireGuard tunnel; local Messages fixture and cold install; no account onboarding or public residential peer',
  demoMode: true, firstAccountOnboardingTested: false, realPublicLineVerified: false, onboarding: [], reusedTestVm: false,
  package: { bundle }, captures: {}, networkMode: 'wireguard',latestPackageTested:latest,artifactsDirectory:artifacts };
if(network){report.hostNetworkPackageTested=true;report.hostNetworkChecks=[];report.testGatewayMemoryGiB=1;}
if(recovery)report.diskRecoveryPackageTested=true;
if(monitor)report.diskRecoveryMonitorPackageTested=true;
let application: ElectronApplication | undefined, page: Page | undefined, e: Environment | undefined, capture = false, transcript = '';
const errors: string[] = [];
const admin = (args: string[]) => runtime.management(e!, args, { timeoutMs: 30_000, maxBytes: 128_000_000 });
const guest = (args: string[]) => runtime.guest(e!, args, { timeoutMs: 30_000 });
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { assert.ok(Date.now() < deadline, 'WireGuard TUI observation timed out'); await delay(100); }
}
async function api(endpoint: string, method = 'GET', body?: unknown): Promise<any> {
  return page!.evaluate(async ({ endpoint, method, body }) => {
    const response = await fetch(`/api${endpoint}`, { method, headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`,
      'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
  }, { endpoint, method, body });
}
async function checkHostNetwork(stage:string){
  if(!network)return;
  const snapshot=await api('/snapshot');assert.equal(snapshot.system.hostNetwork.state,'ready');
  assert.ok(snapshot.jobs.every((job:any)=>job.action!=='quarantine'));
  report.hostNetworkChecks.push({stage,hostNetwork:snapshot.system.hostNetwork});
}
async function finish(job: { id: string }, timeoutMs = 950_000) {
  await until(async () => {
    if(latest){const disk=await statfs(directory);assert.ok(disk.bavail*disk.bsize>80*2**30,'Acceptance disk reserve exhausted');}
    const done = (await api('/snapshot')).jobs.find((j: any) => j.id === job.id);
    if (done?.status === 'running') return false;
    assert.equal(done?.status, 'succeeded', done?.message); return true;
  }, timeoutMs);
}
type HostProcess = { pid: number; parent: number; tty: string; command: string };
let nativeHostProcesses: HostProcess[] = [];
async function hostProcesses(): Promise<HostProcess[]> {
  return (await run('/bin/ps', ['-axo', 'pid=,ppid=,tty=,comm='])).split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), tty: match[3], command: match[4] }] : [];
  });
}
async function observeNativeHostPty() {
  const rows = await hostProcesses(), owner = application!.process().pid!, descendants = new Set([owner]);
  let changed = true;
  while (changed) { changed = false; for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; } }
  nativeHostProcesses = rows.filter(row => descendants.has(row.pid) && row.tty !== '??' && /(?:^|\/)(?:limactl|ssh)$/.test(row.command));
  for (const command of ['limactl', 'ssh']) assert.ok(nativeHostProcesses.some(row => path.basename(row.command) === command));
  return { applicationPid: owner, processes: nativeHostProcesses };
}
async function saveCapture(guestFile: string, name: string) {
  const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', guestFile])).trim(), 'base64');
  assert.equal(bytes.length, Number((await admin(['sudo', 'stat', '-c', '%s', guestFile])).trim())); assert.ok(bytes.length > 24);
  const localFile = path.join(artifacts, `${name}.pcap`);
  await writeFile(localFile, bytes, { mode: 0o600 });
  const text = await readPacketCapture(localFile);
  await writeFile(path.join(artifacts, `${name}.txt`), text, { mode: 0o600 });
  const allowed = `(udp and dst host 192.168.5.2 and dst port ${fixture.network.port}) or (tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67)`;
  const outgoing = await packetLines(localFile, 'ifindex 2 and outbound and (ip or ip6)');
  const approved = await packetLines(localFile, `ifindex 2 and outbound and udp and dst host 192.168.5.2 and dst port ${fixture.network.port}`);
  const unapproved = await packetLines(localFile, `ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`);
  report.captures[name] = { bytes: bytes.length, sha256: hash(bytes), physicalOut: outgoing.length, approvedTunnel: approved.length,
    unapproved: unapproved.length, peerEndpoint: `192.168.5.2:${fixture.network.port}` };
  assert.ok(outgoing.length > 0); if (name === 'network') assert.ok(approved.length > 0); assert.deepEqual(unapproved, []);
  if(latest&&name.endsWith('boot')){
    const bootId=(await admin(['cat','/proc/sys/kernel/random/boot_id'])).trim();
    const capturedBootId=(await admin(['sudo','cat','/var/log/mucodesandbox/boot-network.boot-id'])).trim();
    assert.match(bootId,/^[a-f0-9-]{36}$/);assert.equal(capturedBootId,bootId);
    Object.assign(report.captures[name],{bootId,capturedBootId});
  }
}
async function stopCapture(name='network') {
  if (!capture) return; capture = false;
  await admin(['sudo', 'systemctl', 'stop', 'mu-tui-wireguard-capture.service']);
  await saveCapture('/run/mu-tui-wireguard.pcap', name);
}
async function browser(stage:string,keepOpen=false){
  const baseline=browserFixture.evidence.receipts.length;
  await finish(await api(`/environments/${e!.id}/browser/open`,'POST'));
  await until(()=>application!.windows().some(window=>new URL(window.url()||'about:blank').searchParams.get('guestBrowser')===e!.id));
  const viewer=application!.windows().find(window=>new URL(window.url()||'about:blank').searchParams.get('guestBrowser')===e!.id)!;
  await viewer.getByRole('status').filter({hasText:'已连接'}).waitFor({timeout:30_000});
  await until(()=>browserFixture.evidence.receipts.length>baseline);
  const receipt=browserFixture.evidence.receipts[baseline];validateBackupBrowser(receipt);
  if(stage==='initial'){assert.equal(receipt.before.cookie,'');assert.equal(receipt.before.localStorage,null);assert.equal(receipt.before.indexedDB,null);}
  else assert.deepEqual(receipt.before,receipt.after);
  assert.equal(browserFixture.evidence.loginRequests,1);
  const canvas=viewer.locator('.guest-browser-canvas canvas');await canvas.waitFor();
  await until(async()=>canvas.evaluate((node:HTMLCanvasElement)=>{
    const image=node.getContext('2d')!.getImageData(0,0,node.width,node.height),colors=new Set<number>();
    for(let n=0;n<image.data.length;n+=400)colors.add((image.data[n]<<16)|(image.data[n+1]<<8)|image.data[n+2]);
    return node.width===1280&&node.height===800&&colors.size>20;
  }));
  await writeFile(path.join(artifacts,`browser-${stage}.png`),Buffer.from((await canvas.evaluate((node:HTMLCanvasElement)=>node.toDataURL('image/png'))).split(',')[1],'base64'),{mode:0o600});
  const inspection=await api(`/environments/${e!.id}/browser/inspect`);assert.equal(inspection.matchesConfiguration,true);
  if(!keepOpen){await api(`/environments/${e!.id}/browser/close`,'POST');await until(()=>viewer.isClosed());}
  report[`browser${stage[0].toUpperCase()+stage.slice(1)}`]={receipt,inspection};
}
async function browserFetch(probe:string){
  const socket=path.join(directory,'b.cdp');await rm(socket,{force:true});
  const transport=spawn('/usr/bin/ssh',['-F',path.join(runtime.limaHome,e!.instanceName,'ssh.config'),'-S','none','-N','-T','-o','ExitOnForwardFailure=yes','-L',`${socket}:127.0.0.1:9222`,`lima-${e!.instanceName}`],{stdio:'ignore'});
  const closed=new Promise<void>(resolve=>transport.once('close',()=>resolve()));let tools:DevTools|undefined;
  try{
    await until(async()=>{assert.equal(transport.exitCode,null);try{tools=await DevTools.open(socket);return true;}catch{return false;}});
    const targets=await tools!.send('Target.getTargets'),target=targets.targetInfos.find((target:any)=>target.type==='page'&&target.url.startsWith('http://203.0.113.81/'));
    assert.ok(target,'The production browser must have the actual fixture page');
    const {sessionId}=await tools!.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
    const result=await tools!.send('Runtime.evaluate',{expression:`(async()=>{try{const r=await fetch(${JSON.stringify(`http://203.0.113.81/probe?mu_probe=${probe}`)},{cache:'no-store',signal:AbortSignal.timeout(1500)});return {ok:r.ok,body:await r.text()};}catch(error){return {ok:false,error:String(error)};}})()`,awaitPromise:true,returnByValue:true},sessionId);
    assert.equal(result.exceptionDetails,undefined);await tools!.send('Target.detachFromTarget',{sessionId});return result.result.value;
  }finally{tools?.close();transport.kill('SIGTERM');const timer=setTimeout(()=>transport.kill('SIGKILL'),2000);try{await closed;}finally{clearTimeout(timer);await rm(socket,{force:true});}}
}
try {
  if(latest){
    const disk=await statfs(directory);assert.ok(disk.bavail*disk.bsize>100*2**30);
    const browserCache=`/tmp/mu-chromium-${GUEST_CHROMIUM_VERSION}-arm64.zip`;
    assert.equal(hash(await readFile(browserCache)),GUEST_CHROMIUM_SHA256);
    await mkdir(path.join(directory,'tools/guest-browser'),{recursive:true,mode:0o700});
    await copyFile(browserCache,path.join(directory,`tools/guest-browser/chrome-${GUEST_CHROMIUM_VERSION}-linux-arm64.zip`));
    assert.ok(process.env.MU_TEST_SING_BOX_CACHE,'Provide the verified existing network archive');
    assert.equal(hash(await readFile(process.env.MU_TEST_SING_BOX_CACHE!)),SING_BOX_SHA256);
    await mkdir(path.join(directory,'tools/sing-box'),{recursive:true,mode:0o700});
    await copyFile(process.env.MU_TEST_SING_BOX_CACHE!,path.join(directory,'tools/sing-box',SING_BOX_ARCHIVE));
    report.officialCachesReused=true;
  }
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
  report.package.cdHash = signature.match(/^CDHash=(.+)$/m)?.[1]; report.package.signature = signature.match(/^Signature=(.+)$/m)?.[1];
  assert.equal(report.package.cdHash, bridgeOwner?'9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3':monitor?'b3b92b627f33d1b810011558fa4ba0c18cddd934':recovery?'e1caee59d8049dccf71e42c2e37bf62518d2d05a':network?'cf031a2a4bbc9d55cc8b1d97e77a935b312145d2':latest?'b0cd06dd921a9ba759336fb39c8cb6e40e22fde4':'7d6e3ea1d0b2b22ec466c2f1652279e5ca7bc37e');
  if(bridgeOwner){
    const appRoot=path.join(bundle,'Contents/Resources/app'),files=['desktop/main.cjs',...(await readdir(path.join(appRoot,'dist-server/server'))).filter(file=>file.endsWith('.js')).map(file=>`dist-server/server/${file}`)];
    assert.equal(files.length,46);report.package.initialFiles=Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await readFile(path.join(appRoot,file)))])));
    report.initialSources=Object.fromEntries(await Promise.all(['scripts/verify-claude-tui-wireguard.ts','scripts/packet-capture.ts','scripts/claude-wireguard-fixture.ts','scripts/claude-tui-workflow.ts','server/runtime.ts','server/mock-messages.ts','scripts/backup-browser-fixture.ts'].map(async file=>[file,hash(await readFile(path.join(root,file)))])));
  }
  console.log('Preparing the independent disposable WireGuard peer and local Messages relay.');
  await fixture.prepare(); report.separateGatewayVm = true;
  if(network){
    report.testGatewayMemoryKiB=Number((await runtime.management(fixture.gateway,['python3','-c',"print(next(line.split()[1] for line in open('/proc/meminfo') if line.startswith('MemTotal:')))"])).trim());
    assert.ok(report.testGatewayMemoryKiB>800_000&&report.testGatewayMemoryKiB<1_100_000);
  }
  application = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
    env: { ...process.env, MU_DATA_DIR: directory, MU_DESKTOP_USER_DATA_DIR: desktopData, MU_LIMA_PATH: process.env.MU_LIMA_PATH, MU_TEST_CLAUDE: '0',MU_DESKTOP_BACKGROUND:'1' }, timeout: 60_000 });
  page = await application.firstWindow({ timeout: 30_000 }); await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  report.package.application = await application.evaluate(({ app, BrowserWindow }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(),
    version: app.getVersion(), electron: process.versions.electron, pid: process.pid,
    sandboxDisablingArgumentsAbsent: !process.argv.some(arg => /^--(?:no-sandbox|disable-(?:gpu|renderer|setuid)-sandbox)(?:=|$)/.test(arg)),
    rendererProcesses: app.getAppMetrics().filter(metric => metric.type === 'Tab').map(metric => ({ pid: metric.pid, sandboxed: metric.sandboxed })),
    windows: BrowserWindow.getAllWindows().map(window => {
      const contents = window.webContents as typeof window.webContents & { getLastWebPreferences?: () => Electron.WebPreferences };
      if (typeof contents.getLastWebPreferences !== 'function') throw new Error('Electron preference inspection unavailable');
      const preferences = contents.getLastWebPreferences();
      return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
    }) }));
  const app = report.package.application;
  assert.ok(app.packaged && app.sandboxDisablingArgumentsAbsent); assert.equal(app.appPath, path.join(bundle, 'Contents/Resources/app'));
  assert.ok(app.rendererProcesses.length > 0 && app.rendererProcesses.every((p: any) => p.sandboxed));
  assert.ok(app.windows.length > 0 && app.windows.every((w: any) => w.sandbox && w.contextIsolation && !w.nodeIntegration));
  assert.equal((await api('/snapshot')).system.dataDir, directory);
  await checkHostNetwork('before-client-creation');
  e = await api('/environments', 'POST', { name: 'WireGuard interactive verification', cpus: 2, memoryGiB: 2, diskGiB: 10,
    identity: { timezone: 'Asia/Tokyo', locale: 'ja-JP' }, network: fixture.network,...(latest?{browserUrl:'http://203.0.113.81/read'}:{}) });
  console.log('Creating a fresh protected client and cold-installing the actual CLI through the packaged API.');
  await finish(await api(`/environments/${e!.id}/actions/start`, 'POST'));
  e = (await api('/snapshot')).environments.find((value: any) => value.id === e!.id); assert.equal(e!.state, 'running');
  await checkHostNetwork('first-client-boot');
  report.protectionBefore = await api(`/environments/${e!.id}/network/protection`);
  assert.ok(report.protectionBefore.active && report.protectionBefore.policy === 'packet-tunnel');
  report.physicalInterfaceIndex = JSON.parse(await admin(['ip', '-j', 'link', 'show', 'eth0']))[0].ifindex;
  await saveCapture('/var/log/mucodesandbox/boot-network.pcap', 'first-boot');
  if(latest){await admin(['sudo','systemd-run','--quiet','--unit=mu-tui-wireguard-capture','/usr/bin/tcpdump','--immediate-mode','-ni','any','-Q','out','-U','-s','128','-w','/run/mu-tui-wireguard.pcap']);capture=true;await delay(1000);}
  assert.equal((await api(`/environments/${e!.id}/agent`)).installed, false);
  await finish(await api(`/environments/${e!.id}/actions/install-agent`, 'POST'));
  report.client = await api(`/environments/${e!.id}/agent`); assert.equal(report.client.installed, true);
  report.client.executableSha256 = (await guest(['sha256sum', '/home/dev/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'])).split(/\s/)[0];
  report.packagedLifecycleAndColdInstall = true;
  if(latest)await browser('initial',true);
  await fixture.restrictToLocalFixture();
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--proxy', '', 'https://1.1.1.1/']));
  report.externalForwardingBlockedDuringTasks = true;
  assert.equal(JSON.parse(await guest(['curl', '--fail', '--silent', '--max-time', '5', 'http://203.0.113.80/api/status'])).running, true);
  await guest(['mkdir', '-p', '/workspace/mu-claude-account-free']); await guest(['rm', '-f', MOCK_FILE, MOCK_BASH_FILE]);
  report.protectionBefore = await api(`/environments/${e!.id}/network/protection`); assert.equal(report.protectionBefore.active, true);
  if(!latest){await admin(['sudo', 'systemd-run', '--quiet', '--unit=mu-tui-wireguard-capture', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', '/run/mu-tui-wireguard.pcap']); capture = true;await delay(1000);}
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framereceived', event => {
    try { const value = JSON.parse(event.payload.toString()); if (value.type === 'data') transcript += value.data; } catch { /* Ignore unrelated frames. */ }
  }));
  await page.getByRole('button', { name: `${e!.name} Linux 沙箱` }).click(); await page.getByRole('button', { name: '终端', exact: true }).click();
  await page.getByText('已连接', { exact: false }).waitFor(); console.log('Running actual interactive permissions, cancellation, continuation and pane-close cleanup over WireGuard.');
  await verifyClaudeTui({ page, artifacts, messages: fixture.lab.messages, output: () => transcript, guest, admin, report,
    ...(latest?{inputText:async(value:string)=>{await page!.locator('.xterm-helper-textarea').evaluate((node,value)=>{
      const clipboard=new DataTransfer();clipboard.setData('text/plain',value);node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:clipboard,bubbles:true,cancelable:true}));
    },value);}}:{}),
    observeHostPty: observeNativeHostPty, closeTerminal: async () => {
      await page!.getByRole('button', { name: '总览', exact: true }).click(); await page!.locator('.xterm').waitFor({ state: 'detached' });
      await until(async () => { const alive = await hostProcesses(); return nativeHostProcesses.every(p => !alive.some(row => row.pid === p.pid)); });
      report.nativeHostProcessesAfterDisconnect = (await hostProcesses()).filter(p => nativeHostProcesses.some(old => old.pid === p.pid));
      await page!.screenshot({ path: path.join(artifacts, 'terminal-pane-closed.png'), fullPage: true });
      return { actualTerminalPaneClosed: true, actualPageClosed: false, hostPtyProcessExited: true };
    } });
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--interface', 'eth0', '--proxy', '', 'http://1.1.1.1/'])); report.directBypassRejected = true;
  report.protectionAfter = await api(`/environments/${e!.id}/network/protection`); assert.equal(report.protectionAfter.active, true);
  await checkHostNetwork('cli-tools-and-terminal-cleanup');
  for (const key of ['firewallHash', 'tunnelConfigHash', 'wireguardStateHash']) assert.equal(report.protectionBefore[key], report.protectionAfter[key]);
  if(latest){
    console.log('Checking peer loss, no direct fallback, recovery and real browser persistence.');
    const positive=await browserFetch('before-loss');assert.deepEqual(positive,{ok:true,body:'MU_BACKUP_NETWORK_OK'});
    await fixture.setPeerAvailable(false);report.peerLossStartedAt=new Date().toISOString();
    const unavailable=await browserFetch('during-loss');assert.equal(unavailable.ok,false);assert.match(unavailable.error,/Timeout|abort|Failed to fetch/i);
    assert.ok(!browserRequests.includes('/probe?mu_probe=during-loss'));
    await assert.rejects(guest(['curl','--fail','--silent','--max-time','3','http://203.0.113.80/api/status']));
    await assert.rejects(guest(['curl','--fail','--silent','--max-time','3','http://203.0.113.81/read']));
    await assert.rejects(guest(['curl','--fail','--silent','--max-time','3','--interface','eth0','--proxy','','http://203.0.113.81/read']));
    await fixture.setPeerAvailable(true);
    await until(async()=>{try{return JSON.parse(await guest(['curl','--fail','--silent','--max-time','2','http://203.0.113.80/api/status'])).running===true;}catch{return false;}},30_000);
    const recovered=await browserFetch('after-loss');assert.deepEqual(recovered,positive);
    report.peerLoss={normalRequestsRejected:true,browserOriginRequestsRejected:true,physicalBypassRejected:true,recovered:true,actualBrowser:{positive,unavailable,recovered}};
    await checkHostNetwork('peer-loss-and-recovery');
    await api(`/environments/${e!.id}/browser/close`,'POST');
    await browser('recovered');
  }
  report.gateway = await fixture.inspect(); assert.deepEqual(errors, []); await stopCapture(); report.passed = true;
  if(latest){
    report.passed=false;
    console.log('Restarting the actual packaged client and checking a fresh boot record and retained browser data.');
    await finish(await api(`/environments/${e!.id}/actions/stop`,'POST'));
    await finish(await api(`/environments/${e!.id}/actions/start`,'POST'));e=(await api('/snapshot')).environments.find((value:any)=>value.id===e!.id);
    await saveCapture('/var/log/mucodesandbox/boot-network.pcap','restart-boot');
    assert.notEqual(report.captures['first-boot'].bootId,report.captures['restart-boot'].bootId);
    await admin(['sudo','systemd-run','--quiet','--unit=mu-tui-wireguard-capture','/usr/bin/tcpdump','--immediate-mode','-ni','any','-Q','out','-U','-s','128','-w','/run/mu-tui-wireguard.pcap']);capture=true;await delay(1000);
    await browser('restarted');report.browserEvidence=browserFixture.evidence;report.browserRequests=browserRequests;
    report.restartProtection=await api(`/environments/${e!.id}/network/protection`);assert.ok(report.restartProtection.active);
    await checkHostNetwork('client-restart-and-browser-persistence');
    await stopCapture('restart-network');
    report.passed=true;
  }
} catch (error) {
  report.error = (error as Error).stack; process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(path.join(artifacts, 'failure.txt'), await page.locator('.xterm-rows').innerText({ timeout: 1000 }).catch(() => ''), { mode: 0o600 });
  }
} finally {
  if (capture) await stopCapture().catch(error => { report.captureError = String(error); report.passed = false; });
  report.messages = [...fixture.lab.messages]; report.uiErrors = errors;
  await writeFile(path.join(artifacts, 'terminal.ansi.txt'), transcript, { mode: 0o600 });
  if (e && application && page && !page.isClosed()) {
    await api(`/environments/${e.id}/actions/stop`, 'POST').then(job => finish(job, 120_000)).catch(error => { report.cleanupError = String(error); });
    if (report.passed && !report.cleanupError) await api(`/environments/${e.id}/actions/delete`, 'POST').then(job => finish(job, 120_000)).catch(error => { report.cleanupError = String(error); });
  }
  await application?.close().catch(error => { report.applicationCloseError = String(error); });
  await fixture.close().catch(error => { report.gatewayCleanupError = String(error); });
  if(latest){browserServer.closeAllConnections();await new Promise<void>(resolve=>browserServer.close(()=>resolve()));}
  if (report.cleanupError || report.applicationCloseError || report.captureError || report.gatewayCleanupError) { report.passed = false; process.exitCode = 1; }
  if(latest&&!report.cleanupError&&!report.gatewayCleanupError&&!report.applicationCloseError){
    try{for(const instance of await runtime.list()){if(instance.status==='Running')await runtime.command(['stop','--force',instance.name],{timeoutMs:120_000});await runtime.command(['delete',instance.name],{timeoutMs:120_000});}assert.deepEqual(await runtime.list(),[]);}
    catch(error){report.cleanupError=String(error);report.passed=false;process.exitCode=1;}
  }
  if ((report.passed||latest)&&!report.cleanupError&&!report.gatewayCleanupError&&!report.applicationCloseError) { await rm(directory, { recursive: true, force: true }); await rm(desktopData, { recursive: true, force: true }); report.testDataRemoved = true; }
  else { report.retainedDataDir = directory; report.retainedDesktopDataDir = desktopData; }
  report.sources = Object.fromEntries(await Promise.all(['scripts/verify-claude-tui-wireguard.ts', 'scripts/packet-capture.ts', 'scripts/claude-wireguard-fixture.ts', 'scripts/claude-tui-workflow.ts', 'server/runtime.ts', 'server/mock-messages.ts',...(latest?['scripts/backup-browser-fixture.ts']:[])].map(async file => [file, hash(await readFile(path.join(root, file)))])));
  if(network)for(const file of Object.keys(report.sources))await copyFile(path.join(root,file),path.join(artifacts,`source-${path.basename(file)}`));
  const packagedRoot = path.join(bundle, 'Contents/Resources/app');
  const packagedFiles = ['desktop/main.cjs', ...(await readdir(path.join(packagedRoot, 'dist-server/server'))).filter(file => file.endsWith('.js')).map(file => `dist-server/server/${file}`)];
  report.package.files = Object.fromEntries(await Promise.all(packagedFiles.map(async file => [file, hash(await readFile(path.join(packagedRoot, file)))])));
  if(bridgeOwner){
    try{assert.deepEqual(report.package.files,report.package.initialFiles);assert.deepEqual(report.sources,report.initialSources);
      await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);report.inputsUnchanged=true;
    }catch(error){report.inputsError=String(error);report.passed=false;process.exitCode=1;}
  }
  report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, hash(await readFile(path.join(artifacts, file)))])));
  report.finishedAt = new Date().toISOString(); await writeFile(path.join(root, 'test-results', `${name}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, packageCdHash: report.package.cdHash, client: report.client,
    permissions: report.permissions, cancellation: report.cancellation, reopen: report.reopen, terminalDisconnect: report.terminalDisconnect,
    captures: report.captures, error: report.error, retainedDataDir: report.retainedDataDir }, null, 2));
}
