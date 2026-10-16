import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { LimaRuntime } from '../server/runtime.ts';
import { run } from '../server/process.ts';
import { inspectSharedMountsScript, parseSharedMountInspection } from '../server/guest-mounts.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';
import type { Environment } from '../shared/types.ts';
import { createClaudeLocalFixture } from './claude-local-fixture.ts';

const root = path.resolve(import.meta.dirname, '..');
const bridgeOwner=process.argv.includes('--bridge-owner');
const monitor=process.argv.includes('--monitor')||bridgeOwner;
const recovery=process.argv.includes('--recovery')||monitor;
const network=process.argv.includes('--network')||recovery;
const latest=process.argv.includes('--latest')||network;
const reportName=bridgeOwner?'shared-mounts-ui-bridge-owner':monitor?'shared-mounts-ui-monitor':recovery?'shared-mounts-ui-recovery':network?'shared-mounts-ui-network':latest?'shared-mounts-ui-latest':'shared-mounts-ui';
const reportFile=path.join(root,'test-results',`${reportName}.json`);
const expectedCdHash=bridgeOwner?'9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3':monitor?'b3b92b627f33d1b810011558fa4ba0c18cddd934':recovery?'e1caee59d8049dccf71e42c2e37bf62518d2d05a':network?'cf031a2a4bbc9d55cc8b1d97e77a935b312145d2':latest?'b0cd06dd921a9ba759336fb39c8cb6e40e22fde4':'5558c78a8c1feee996ee31da5149d338d183fa27';
const bundle = path.join(root, `release/${bridgeOwner?'bridge-owner-candidate':monitor?'disk-recovery-monitor-candidate':recovery?'disk-recovery-candidate':network?'host-network-candidate':latest?'boot-capture-candidate':'shared-mount-candidate'}/mac-arm64/MuCodeSandbox.app`);
const reuse = process.env.MU_TEST_SHARED_UI_REUSE_ROOT;
assert.ok(!latest||!reuse,'Latest-package acceptance requires a fresh owned data directory');
let prior: Record<string, any> | undefined;
if (reuse) {
  prior = JSON.parse(await readFile(path.join(root, 'test-results/shared-mounts-ui.json'), 'utf8'));
  assert.equal(reuse, prior!.retainedStoppedTestRoot); assert.equal(path.dirname(reuse), homedir());
  assert.equal(await realpath(reuse), reuse);
  assert.match(path.basename(reuse), /^\.mu-shared-mount-ui-[A-Za-z0-9]+$/);
  assert.equal(prior!.package.cdHash, '5558c78a8c1feee996ee31da5149d338d183fa27');
}
const owned = reuse ?? await mkdtemp(path.join(homedir(), latest?'.mu-sui-':'.mu-shared-mount-ui-'));
const directory = path.join(owned, 'private'), share = path.join(owned, 'shared project');
const artifacts = path.join(root, 'test-results', `${reportName}-${Date.now()}`);
await mkdir(artifacts, { mode: 0o700 }); await mkdir(share, { recursive: true, mode: 0o755 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const runtime = new LimaRuntime(directory), fixture = await createClaudeLocalFixture();
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), accountFree: true,
  paidModelCalls: 0, electronDesktopUiTested: true, freshVmTested: true, nativeFileDialogTested: false,
  browserOrCliTested: false, residentialEgressTested: false, freshDataDirectory: !reuse, reusedProtectedBase: Boolean(reuse), package: { bundle }, artifactsDirectory: artifacts,
  latestPackageTested:latest,scope: 'Actual Electron UI fresh shared-directory configuration, first boot and reboot identity, readonly demotion, network capture and cleanup', stages: [] };
if(network){report.hostNetworkPackageTested=true;report.hostNetworkChecks=[];}
if(recovery)report.diskRecoveryPackageTested=true;
if(monitor)report.diskRecoveryMonitorPackageTested=true;
let app: ElectronApplication | undefined, page: Page | undefined, current: Environment | undefined;
const uiErrors: string[] = [];
const guest = (args: string[]) => runtime.guest(current!, args, { timeoutMs: 30_000 });
const admin = (args: string[], input?: string) => runtime.management(current!, args, { input, timeoutMs: 30_000 });
async function until(check: () => Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Shared mount UI observation timed out'); await delay(200); }
}
async function api(endpoint: string, method = 'GET', body?: unknown): Promise<any> {
  return page!.evaluate(async ({ endpoint, method, body }) => {
    const response = await fetch(`/api${endpoint}`, { method, headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`,
      'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  }, { endpoint, method, body });
}
async function finish(job: { id: string }, timeoutMs = 950_000) {
  await until(async () => {
    const free = await statfs(owned); assert.ok(free.bavail * free.bsize > 80 * 2 ** 30, 'Insufficient disk reserve');
    const row = (await api('/snapshot')).jobs.find((row: any) => row.id === job.id);
    if (row?.status === 'running') return false;
    assert.equal(row?.status, 'succeeded', row?.message); return true;
  }, timeoutMs);
}
async function lifecycle(action: 'start' | 'stop', ui = true) {
  const id = current!.id;
  if (ui) {
    const response = page!.waitForResponse(r => new URL(r.url()).pathname === `/api/environments/${id}/actions/${action}` && r.request().method() === 'POST');
    await page!.getByRole('button', { name: action === 'start' ? '启动' : '停止', exact: true }).click();
    const result = await response; assert.equal(result.status(), 202); await finish(await result.json());
  } else await finish(await api(`/environments/${id}/actions/${action}`, 'POST'));
  current = (await api('/snapshot')).environments.find((e: Environment) => e.id === id); assert.ok(current);
}
async function checkpoint(stage: string) {
  if(network){
    const hostNetwork=(await api('/snapshot')).system.hostNetwork;assert.equal(hostNetwork.state,'ready');
    report.hostNetworkChecks.push({stage,hostNetwork});
  }
  console.log(stage); report.progress = { stage, at: new Date().toISOString() };
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
}
async function nativeScreenshot(name: string) {
  const captured = await app!.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setOpacity(0); window.showInactive();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise(resolve => setTimeout(resolve, 150));
      const image = await Promise.race([
        window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native screenshot timed out')), 15_000); }),
      ]);
      return { png: image.toPNG().toString('base64'), size: image.getSize() };
    } finally { clearTimeout(timer); window.hide(); window.setOpacity(1); }
  });
  await writeFile(path.join(artifacts, `${name}.png`), Buffer.from(captured.png, 'base64'), { mode: 0o600 });
  return captured.size;
}
async function capture(stage: string, task = false) {
  const source = task ? '/run/mu-shared-ui-task.pcap' : '/var/log/mucodesandbox/boot-network.pcap';
  let receipt: unknown;
  if (task) {
    await admin(['sudo', 'systemd-run', '--quiet', '--unit=mu-shared-ui-capture', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', source]);
    try {
      await delay(500);
      receipt = JSON.parse(await guest(['curl', '--proxy', '', '--fail', '--silent', '--max-time', '10', 'http://203.0.113.80/api/echo']));
      assert.equal((receipt as { address: string }).address, '127.0.0.1');
      await assert.rejects(guest(['curl', '--proxy', '', '--interface', 'eth0', '--fail', '--silent', '--max-time', '2', 'http://203.0.113.80/api/echo']));
    } finally { await admin(['sudo', 'systemctl', 'stop', 'mu-shared-ui-capture.service']); }
  }
  const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', source])).trim(), 'base64');
  const text = await admin(['sudo', 'tcpdump', '-nn', '-r', source]);
  await writeFile(path.join(artifacts, `${stage}.pcap`), bytes, { mode: 0o600 });
  await writeFile(path.join(artifacts, `${stage}-network.txt`), text, { mode: 0o600 });
  const route = (await admin(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+) dev (\S+)/);
  assert.ok(route); const [, gateway, physicalInterface] = route;
  assert.equal(physicalInterface, 'eth0', 'This acceptance covers the current single-NIC Lima VM');
  const interfaceIndex=Number((await admin(['cat','/sys/class/net/eth0/ifindex'])).trim());assert.equal(interfaceIndex,2);
  const physical = text.split('\n').filter(line => line.match(/^\S+\s+(\S+)\s+Out\s+IP6?\s/)?.[1] === physicalInterface);
  assert.ok(bytes.length > 24 && physical.length > 0);
  const approved = physical.filter(line => line.includes(` > ${gateway}.${fixture.proxyPort}:`));
  const approvedSsh=physical.filter(line=>line.includes(`.22 > ${gateway}.`));
  if(bridgeOwner){assert.equal(approved.length,0);assert.ok(approvedSsh.length>0);}
  else if (task) assert.ok(approved.length > 0, 'Must observe actual successful proxy traffic for the controlled request');
  const unapproved = physical.filter(line => /\sIP6\s/.test(line) || !((!bridgeOwner&&line.includes(` > ${gateway}.${fixture.proxyPort}:`)) || line.includes(`.22 > ${gateway}.`) || /\.68 > [0-9.]+\.67:/.test(line)));
  assert.deepEqual(unapproved, []);
  let boot:Record<string,string>|undefined;
  if(latest&&!task){
    const bootId=(await admin(['cat','/proc/sys/kernel/random/boot_id'])).trim();
    const capturedBootId=(await admin(['sudo','cat','/var/log/mucodesandbox/boot-network.boot-id'])).trim();
    assert.match(bootId,/^[a-f0-9-]{36}$/);assert.equal(capturedBootId,bootId);
    const activeState=(await admin(['sudo','systemctl','show','--property=ActiveState','--value','mucodesandbox-boot-capture.service'])).trim();
    const subState=(await admin(['sudo','systemctl','show','--property=SubState','--value','mucodesandbox-boot-capture.service'])).trim();
    assert.equal(activeState,'active');assert.equal(subState,'exited');boot={bootId,capturedBootId,activeState,subState};
  }
  return { bytes: bytes.length, sha256: digest(bytes), physicalInterface, interfaceIndex, gateway,proxyPort:fixture.proxyPort,physicalPackets: physical.length, approvedProxy: approved.length,approvedSsh:approvedSsh.length,...boot,
    unapproved: unapproved.length, controlledRequest: receipt, directPhysicalBypassRejected: task || undefined };
}
try {
  const disk = await statfs(owned); assert.ok(disk.bavail * disk.bsize > 100 * 2 ** 30);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  report.package.cdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1];
  assert.equal(report.package.cdHash, expectedCdHash);
  if(bridgeOwner){
    const appRoot=path.join(bundle,'Contents/Resources/app'),files=['desktop/main.cjs',...(await readdir(path.join(appRoot,'dist-server/server'))).filter(file=>file.endsWith('.js')).map(file=>`dist-server/server/${file}`)];
    assert.equal(files.length,46);report.package.initialFiles=Object.fromEntries(await Promise.all(files.map(async file=>[file,digest(await readFile(path.join(appRoot,file)))])));
    report.initialSources=Object.fromEntries(await Promise.all(['scripts/verify-shared-mounts-ui.ts','scripts/claude-local-fixture.ts','server/guest-mounts.ts','native/probes/shared-mount-id.c'].map(async file=>[file,digest(await readFile(path.join(root,file)))])));
  }
  const probe = await readFile(path.join(root, 'test-results/shared-mount/2026-10-10T05-59-01-667Z-inputs/identity-probe.elf'));
  assert.equal(digest(probe), '3bbb4224e1ab805b90938c789c98e02f276160d6fdd1b936be0f0f08fdfa2c7f');
  assert.equal(probe.subarray(0, 4).toString('hex'), '7f454c46'); assert.equal(probe.readUInt16LE(18), 183);
  assert.equal(digest(await readFile(path.join(root, 'native/probes/shared-mount-id.c'))), '4f3735b86348a36827f9a8b391923957bd6bbf93dd68b5a97d79283e67aca8d1');
  await writeFile(path.join(share, 'identity-probe'), probe, { mode: 0o755 }); await chmod(path.join(share, 'identity-probe'), 0o4755);
  await writeFile(path.join(artifacts, 'identity-probe.elf'), probe, { mode: 0o600 });
  report.probe = { sha256: digest(probe), reusedSmallIdentityProbe: true, compilerInstalled: false };
  if(latest)assert.ok(process.env.MU_TEST_SING_BOX_CACHE,'Provide the existing verified archive to avoid repeat downloads');
  if (process.env.MU_TEST_SING_BOX_CACHE) {
    assert.equal(digest(await readFile(process.env.MU_TEST_SING_BOX_CACHE)), SING_BOX_SHA256);
    const cache = path.join(directory, 'tools/sing-box'); await mkdir(cache, { recursive: true, mode: 0o700 });
    await copyFile(process.env.MU_TEST_SING_BOX_CACHE, path.join(cache, SING_BOX_ARCHIVE)); report.networkArchiveCacheReused = true;
  }
  app = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
    env: { ...process.env, MU_DATA_DIR: directory, MU_DESKTOP_USER_DATA_DIR: path.join(owned, 'desktop'), MU_LIMA_PATH: process.env.MU_LIMA_PATH, MU_TEST_CLAUDE: '0',MU_DESKTOP_BACKGROUND:'1' }, timeout: 60_000 });
  const background = () => { void app!.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) { window.webContents.setBackgroundThrottling(false); window.hide(); }
  }).catch(error => uiErrors.push(String(error))); };
  app.on('window', background); background();
  page = await app.firstWindow(); page.on('pageerror', error => uiErrors.push(error.message)); page.on('crash', () => uiErrors.push('Main window crashed'));
  await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  assert.equal((await api('/snapshot')).system.dataDir, directory);
  report.package.application = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(),
    sandboxDisablingArgumentsAbsent: !process.argv.some(arg => /^--(?:no-sandbox|disable-(?:gpu|renderer|setuid)-sandbox)(?:=|$)/.test(arg)),
    renderers: app.getAppMetrics().filter(metric => metric.type === 'Tab').map(metric => ({ sandboxed: metric.sandboxed })) }));
  assert.equal(report.package.application.packaged, true); assert.equal(report.package.application.appPath, path.join(bundle, 'Contents/Resources/app'));
  assert.ok(report.package.application.sandboxDisablingArgumentsAbsent && report.package.application.renderers.length > 0 && report.package.application.renderers.every((r: any) => r.sandboxed));
  if (reuse) {
    const previous = (await api('/snapshot')).environments; assert.equal(previous.length, 1);
    assert.equal(previous[0].id, prior!.retainedEnvironment.id); assert.equal(previous[0].state, 'stopped');
    await finish(await api(`/environments/${previous[0].id}/actions/delete`, 'POST'), 120_000);
    assert.deepEqual((await api('/snapshot')).environments, []);
  }
  await checkpoint('Configuring two project mounts through actual packaged create UI');
  await page.getByRole('button', { name: '新建环境', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建环境', exact: true });
  await dialog.getByLabel('环境名称', { exact: true }).fill('Packaged shared mount verification');
  await dialog.getByLabel('内存 / GB', { exact: true }).fill('2');
  if(network){
    await dialog.getByRole('spinbutton',{name:'磁盘容量 / GiB',exact:true}).fill('10');
    await dialog.getByLabel('CPU 核心',{exact:true}).fill('2');
  }
  for (const [index, target] of ['/workspace/project space', '/workspace/readonly'].entries()) {
    await dialog.getByRole('button', { name: '添加项目目录', exact: true }).click();
    await dialog.getByLabel('本机项目目录', { exact: true }).nth(index).fill(share);
    await dialog.getByLabel('沙箱目录', { exact: true }).nth(index).fill(target);
    if (index === 0) await dialog.getByRole('checkbox', { name: '允许修改本机文件', exact: true }).nth(index).check();
  }
  await dialog.getByRole('button', { name: 'HTTP 代理', exact: true }).click();
  await dialog.getByLabel('代理服务器', { exact: true }).fill('127.0.0.1');
  await dialog.getByLabel('端口', { exact: true }).fill(String(fixture.proxyPort));
  await dialog.getByLabel('用户名', { exact: true }).fill('mu'); await dialog.getByLabel('密码', { exact: true }).fill('tui-fixture');
  await dialog.getByRole('checkbox', { name: '仅代理联网（Linux 防火墙）', exact: true }).check();
  await dialog.getByRole('button', { name: '透明代理', exact: true }).click();
  const created = page.waitForResponse(r => new URL(r.url()).pathname === '/api/environments' && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: '创建环境', exact: true }).click();
  const response = await created; assert.equal(response.status(), 201); current = await response.json();
  assert.equal(current!.mounts.length, 2); assert.deepEqual(current!.mounts.map(m => m.writable), [true, false]);
  assert.ok(current!.network.strict && current!.network.transparent); report.actualUiCreation = true;
  if(latest&&!network){
    // Creation UI currently fixes disk capacity at 30 GiB. Bound only this owned test VM before first boot.
    current=await api(`/environments/${current!.id}`,'PUT',{name:current!.name,cpus:2,memoryGiB:2,diskGiB:10,mounts:current!.mounts,
      network:{mode:'http',host:'127.0.0.1',port:fixture.proxyPort,username:'mu',password:'tui-fixture',strict:true,transparent:true,noProxy:''}});
    assert.equal(current!.diskGiB,10);report.testDiskBudgetAdjustedThroughApi=true;
  }
  if(network){assert.equal(current!.diskGiB,10);report.diskBudgetChosenThroughUi=true;}
  await dialog.waitFor({ state: 'detached' }); await lifecycle('start');
  report.devUid = Number((await guest(['id', '-u'])).trim()); report.controlUid = Number((await admin(['id', '-u', 'mu'])).trim());
  assert.notEqual(report.devUid, report.controlUid); assert.notEqual(report.devUid, 0);
  for (const stage of ['first-boot', 'reboot']) {
    await checkpoint('Checking actual ' + stage + ' shared mount identity and network');
    if (stage === 'reboot') { await lifecycle('stop'); await lifecycle('start'); }
    const observed: Record<string, any> = { stage }; report.stages.push(observed);
    observed.boot = JSON.parse(await admin(['cat', '/run/mucodesandbox-shares/boot.json'])); assert.equal(observed.boot.length, 2);
    if (stage === 'first-boot') assert.ok(observed.boot.every((m: any) => !m.alreadyMounted));
    else assert.ok(observed.boot.every((m: any) => !m.alreadyMounted || ['nosuid', 'nodev'].every(flag => m.previousOptions.split(',').includes(flag))));
    observed.inspection = parseSharedMountInspection(await admin(['bash', '-s'], inspectSharedMountsScript(current!))); assert.deepEqual(observed.inspection.issues, []);
    observed.mountInfo = (await admin(['cat', '/proc/self/mountinfo'])).split('\n').filter(row => row.includes(' - virtiofs '));
    observed.metadata = (await admin(['stat', '-c', '%u:%g %a', '/workspace/project space/identity-probe'])).trim();
    const [owner, mode] = observed.metadata.split(' '); observed.fileOwnerUid = Number(owner.split(':')[0]);
    assert.notEqual(observed.fileOwnerUid, report.devUid); assert.equal(mode, '4755');
    observed.identity = (await guest(['/workspace/project space/identity-probe'])).trim();
    observed.readonlyIdentity = (await guest(['/workspace/readonly/identity-probe'])).trim();
    assert.equal(observed.identity, `${report.devUid} ${report.devUid} 0`); assert.equal(observed.readonlyIdentity, observed.identity);
    await guest(['python3', '-c', `open('/workspace/project space/write-${stage}', 'w').write('MU_UI_SHARED_WRITE')`]);
    assert.equal(await readFile(path.join(share, `write-${stage}`), 'utf8'), 'MU_UI_SHARED_WRITE');
    await assert.rejects(guest(['python3', '-c', `open('/workspace/readonly/denied-${stage}', 'w').write('must-fail')`]), /Read-only file system/);
    await assert.rejects(guest(['sudo', '-n', 'true']));
    observed.protection = await api(`/environments/${current!.id}/network/protection`);
    assert.ok(observed.protection.active && observed.protection.integrity === 'verified');
    if (stage === 'first-boot'||latest) observed.capture = await capture(stage);
    observed.taskCapture = await capture(`${stage}-task`, true);
    await page.getByRole('button', { name: '项目目录', exact: true }).click();
    assert.equal(await page.getByRole('checkbox', { name: '允许修改本机文件', exact: true }).first().isDisabled(), true);
    await page.screenshot({ path: path.join(artifacts, `${stage}.png`), fullPage: true });
  }
  await checkpoint('Checking effective identity positive control with immediate mount protection restoration');
  await writeFile(path.join(share, 'positive-probe'), probe, { mode: 0o755 }); await chmod(path.join(share, 'positive-probe'), 0o4755);
  // Current VZ shares also map ownership by requester. Record that behavior separately from a native-disk positive control.
  report.positiveControl = JSON.parse((await admin(['sudo', 'python3', '-c', `import json, subprocess
target='/workspace/project space'
try:
 subprocess.run(['mount','-o','remount,rw,suid,nodev',target],check=True)
 metadata_before=subprocess.check_output(['sudo','-u','mu','stat','-c','%u:%g %a',target+'/positive-probe'],text=True).strip()
 output=subprocess.check_output(['sudo','-u','dev',target+'/positive-probe'],text=True).strip()
 secondary=subprocess.check_output(['sudo','-u','nobody',target+'/positive-probe'],text=True).strip()
 metadata=subprocess.check_output(['stat','-c','%u:%g %a',target+'/positive-probe'],text=True).strip()
 with open('/proc/self/mountinfo') as f: mounts=[r.strip() for r in f if ' - virtiofs ' in r]
 native='/var/tmp/mu-ui-native-positive'
 try:
  subprocess.run(['install','-o','mu','-g','mu','-m','4755',target+'/positive-probe',native],check=True)
  native_identity=subprocess.check_output(['sudo','-u','dev',native],text=True).strip()
  native_metadata=subprocess.check_output(['stat','-c','%u:%g %a',native],text=True).strip()
 finally:
  import os
  if os.path.exists(native): os.unlink(native)
 print(json.dumps({'sharedIdentityWithoutNosuid':output,'secondaryIdentity':secondary,'metadataBefore':metadata_before,'metadataAfter':metadata,'mountInfo':mounts,'nativeIdentity':native_identity,'nativeMetadata':native_metadata}))
finally:
 subprocess.run(['mount','-o','remount,rw,nosuid,nodev',target],check=True)
`])).trim());
  assert.equal(report.positiveControl.nativeMetadata, `${report.controlUid}:${report.controlUid} 4755`);
  assert.equal(report.positiveControl.nativeIdentity, `${report.devUid} ${report.controlUid} 0`);
  report.positiveControl.sharedIdentityChangedWithoutNosuid = report.positiveControl.sharedIdentityWithoutNosuid.split(' ')[1] !== String(report.devUid);
  assert.equal(report.positiveControl.metadataBefore, `${report.controlUid}:${report.controlUid} 4755`);
  assert.equal(report.positiveControl.sharedIdentityWithoutNosuid, `${report.devUid} ${report.controlUid} 0`, 'An ineffective shared-filesystem positive control must not pass acceptance');
  report.positiveControl.scope = 'Actual shared and native positive controls change dev effective UID; metadata is checked before execution because later requester identities affect VZ attributes';
  report.positiveControl.restoredIdentity = (await guest(['/workspace/project space/positive-probe'])).trim();
  assert.equal(report.positiveControl.restoredIdentity, `${report.devUid} ${report.devUid} 0`);
  assert.deepEqual(parseSharedMountInspection(await admin(['bash', '-s'], inspectSharedMountsScript(current!))).issues, []);
  await checkpoint('Saving write permission demotion through actual UI and rebooting');
  await lifecycle('stop');
  await until(async () => !await page!.getByRole('checkbox', { name: '允许修改本机文件', exact: true }).first().isDisabled());
  await page.getByRole('checkbox', { name: '允许修改本机文件', exact: true }).first().uncheck();
  const updated = page.waitForResponse(r => new URL(r.url()).pathname === `/api/environments/${current!.id}` && r.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存', exact: true }).click(); const saved = await updated; assert.equal(saved.status(), 200);
  current = await saved.json(); assert.ok(current!.mounts.every(m => !m.writable)); await lifecycle('start');
  await assert.rejects(guest(['python3', '-c', "open('/workspace/project space/denied-after-demotion','w').write('must-fail')"]), /Read-only file system/);
  assert.equal((await guest(['cat', '/workspace/project space/write-first-boot'])).trim(), 'MU_UI_SHARED_WRITE');
  report.demotion = { actualUiSave: true, previousWriteRejected: true, existingFilePreserved: true,
    inspection: parseSharedMountInspection(await admin(['bash', '-s'], inspectSharedMountsScript(current!))),
    ...(latest?{bootCapture:await capture('demoted-boot')}:{}),
    taskCapture: await capture('demoted-task', true) };
  if(latest){
    assert.equal(new Set([report.stages[0].capture.bootId,report.stages[1].capture.bootId,report.demotion.bootCapture.bootId]).size,3);
    await app!.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setMinimumSize(390,600);window.setContentSize(390,844);});
    await until(async()=>await page!.evaluate(()=>innerWidth===390));
    report.mobileBounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.equal(report.mobileBounds.scroll,390);
    report.mobileScreenshotSize = await nativeScreenshot('demoted-mobile');
  }
  assert.deepEqual(report.demotion.inspection.issues, []); assert.deepEqual(uiErrors, []);
  if(network){assert.ok((await api('/snapshot')).jobs.every((job:any)=>job.action!=='quarantine'));report.noUnintendedHostNetworkStops=true;}
  report.passed = true; await checkpoint('All shared mount UI observations passed; cleaning owned resources');
} catch (error) {
  report.error = (error as Error).stack; process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (current && page && !page.isClosed()) {
    await lifecycle('stop', false).catch(error => { (report.cleanupErrors ??= []).push(String(error)); });
    if (report.passed || process.env.MU_TEST_KEEP_FAILED_RUNTIME !== '1') await api(`/environments/${current.id}/actions/delete`, 'POST').then(job => finish(job, 120_000)).catch(error => { (report.cleanupErrors ??= []).push(String(error)); });
  }
  await app?.close().catch(error => { (report.cleanupErrors ??= []).push(String(error)); }); await fixture.close();
  try {
    for (const row of await runtime.list()) {
      if (row.status === 'Running') await runtime.command(['stop', row.name], { timeoutMs: 120_000 });
      if (report.passed || process.env.MU_TEST_KEEP_FAILED_RUNTIME !== '1') await runtime.command(['delete', row.name], { timeoutMs: 120_000 });
    }
    const remaining = await runtime.list(); assert.ok(remaining.every(row => row.status === 'Stopped'));
    if (report.passed || process.env.MU_TEST_KEEP_FAILED_RUNTIME !== '1') {
      assert.deepEqual(remaining, []); await rm(owned, { recursive: true }); report.testResourcesRemoved = true;
    } else { report.retainedStoppedTestRoot = owned; report.retainedEnvironment = current; }
  } catch (error) { (report.cleanupErrors ??= []).push(String(error)); report.retainedTestRoot = owned; }
  if (report.cleanupErrors?.length) { report.passed = false; process.exitCode = 1; }
  report.uiErrors = uiErrors; report.finishedAt = new Date().toISOString();
  report.sources = Object.fromEntries(await Promise.all(['scripts/verify-shared-mounts-ui.ts', 'scripts/claude-local-fixture.ts', 'server/guest-mounts.ts', 'native/probes/shared-mount-id.c'].map(async file => [file, digest(await readFile(path.join(root, file)))])));
  if(network)for(const file of Object.keys(report.sources))await copyFile(path.join(root,file),path.join(artifacts,`source-${path.basename(file)}`));
  if(latest){
    const appRoot=path.join(bundle,'Contents/Resources/app');
    const files=['desktop/main.cjs',...(await readdir(path.join(appRoot,'dist-server/server'))).filter(file=>file.endsWith('.js')).map(file=>`dist-server/server/${file}`)];
    report.package.files=Object.fromEntries(await Promise.all(files.map(async file=>[file,digest(await readFile(path.join(appRoot,file)))])));
  }
  if(bridgeOwner){
    try{assert.deepEqual(report.sources,report.initialSources);assert.deepEqual(report.package.files,report.package.initialFiles);
      await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);report.inputsUnchanged=true;
    }catch(error){report.inputsError=String(error);report.passed=false;process.exitCode=1;}
  }
  report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, digest(await readFile(path.join(artifacts, file)))])));
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, stages: report.stages.map((s: any) => ({ stage: s.stage, identity: s.identity, capture: s.capture, taskCapture: s.taskCapture })),
    demotion: report.demotion, testResourcesRemoved: report.testResourcesRemoved, error: report.error, cleanupErrors: report.cleanupErrors }, null, 2));
}
