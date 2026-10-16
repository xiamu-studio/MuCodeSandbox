import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import type { Environment } from '../shared/types.ts';
import type { LimaRuntime } from '../server/runtime.ts';
import { run } from '../server/process.ts';
import { backupBrowserFixture, validateBackupBrowser } from './backup-browser-fixture.ts';

async function until(check: () => boolean | Promise<boolean>, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'Packaged backup observation timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export async function verifyPackagedBackupBrowser(options: {
  root: string; dataDir: string; environment: Environment; runtime: LimaRuntime;
  fixture: ReturnType<typeof backupBrowserFixture>;
}) {
  const { root, dataDir, environment, runtime, fixture } = options;
  const bundle = path.join(root, 'release/backup-candidate/mac-arm64/MuCodeSandbox.app');
  const desktopData = await mkdtemp(path.join(homedir(), '.mu-packaged-backup-user-'));
  const results = path.join(root, 'test-results');
  const report: Record<string, any> = { passed: false, accountFree: true, paidModelCalls: 0, startedAt: new Date().toISOString(), actualSecondMacTested: false, nativeFileDialogTested: false };
  let application: ElectronApplication | undefined, main: Page | undefined;
  let imported: Environment | undefined, capturing = false;
  async function api(endpoint: string, method = 'GET', body?: unknown): Promise<any> {
    return main!.evaluate(async ({ endpoint, method, body }) => {
      const response = await fetch(`/api${endpoint}`, { method, headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
    }, { endpoint, method, body });
  }
  async function finish(job: { id: string }, timeout = 180_000) {
    await until(async () => {
      const result = (await api('/snapshot')).jobs.find((entry: any) => entry.id === job.id);
      if (result?.status === 'running') return false;
      assert.equal(result?.status, 'succeeded', result?.message); return true;
    }, timeout);
  }
  async function browserReceipt(e: Environment, suffix: string) {
    const baseline = fixture.evidence.receipts.length;
    await finish(await api(`/environments/${e.id}/browser/open`, 'POST'));
    await until(() => application!.windows().some(window => new URL(window.url() || 'about:blank').searchParams.get('guestBrowser') === e.id));
    const viewer = application!.windows().find(window => new URL(window.url() || 'about:blank').searchParams.get('guestBrowser') === e.id)!;
    await viewer.getByRole('status').filter({ hasText: '已连接' }).waitFor({ timeout: 30_000 });
    await until(() => fixture.evidence.receipts.length > baseline);
    const receipt = fixture.evidence.receipts[baseline];
    validateBackupBrowser(receipt); assert.deepEqual(receipt.before, receipt.after);
    assert.equal(fixture.evidence.loginRequests, 1);
    const canvas = viewer.locator('.guest-browser-canvas canvas'); await canvas.waitFor();
    let pixels: { width: number; height: number; colors: number } | undefined;
    await until(async () => {
      pixels = await canvas.evaluate((node: HTMLCanvasElement) => {
        const data = node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data, colors = new Set<string>();
        for (let index = 0; index < data.length; index += 400) colors.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
        return { width: node.width, height: node.height, colors: colors.size };
      }); return pixels.width === 1280 && pixels.height === 800 && pixels.colors > 20;
    });
    await viewer.screenshot({ path: path.join(results, `packaged-backup-${suffix}.png`) });
    const inspection = await api(`/environments/${e.id}/browser/inspect`);
    assert.equal(inspection.matchesConfiguration, true);
    await api(`/environments/${e.id}/browser/close`, 'POST'); await until(() => viewer.isClosed());
    return { receipt, pixels, inspection };
  }
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeoutMs: 30_000 });
    const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
    report.cdHash = signature.match(/^CDHash=(.+)$/m)?.[1]; assert.ok(report.cdHash);
    application = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true, env: { ...process.env, MU_DATA_DIR: dataDir, MU_DESKTOP_USER_DATA_DIR: desktopData, MU_LIMA_PATH: (await runtime.executable())!, MU_TEST_CLAUDE: '0' }, timeout: 60_000 });
    main = await application.firstWindow();
    await main.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
    report.application = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), sandboxDisablingArgumentsAbsent: !process.argv.some(argument => /^--(?:no-sandbox|disable-(?:gpu|renderer|setuid)-sandbox)(?:=|$)/.test(argument)) }));
    assert.ok(report.application.packaged && report.application.sandboxDisablingArgumentsAbsent);
    assert.equal((await api('/snapshot')).system.dataDir, dataDir);
    await finish(await api(`/environments/${environment.id}/actions/start`, 'POST'));
    report.originalBrowser = await browserReceipt(environment, 'original');
    await finish(await api(`/environments/${environment.id}/actions/stop`, 'POST'));
    await finish(await api(`/environments/${environment.id}/snapshots`, 'POST', { name: '包内真实浏览器备份验收' }));
    const snapshots = await api(`/environments/${environment.id}/snapshots`);
    assert.ok(snapshots.some((snapshot: any) => snapshot.name === '包内真实浏览器备份验收'));
    await main.getByRole('button', { name: `${environment.name} Linux 沙箱`, exact: true }).click();
    await main.getByRole('button', { name: '快照', exact: true }).click();
    await main.getByRole('button', { name: '导出 包内真实浏览器备份验收', exact: true }).click();
    const file = path.join(path.dirname(dataDir), 'packaged-browser.mu-backup'), password = 'synthetic-packaged-browser-backup-password';
    let dialog = main.getByRole('dialog');
    await dialog.getByLabel('备份文件路径', { exact: true }).fill(file);
    await dialog.getByLabel('备份密码', { exact: true }).fill(password);
    await dialog.getByLabel('确认密码', { exact: true }).fill(password);
    const exported = main.waitForResponse(response => new URL(response.url()).pathname.endsWith('/export'));
    await dialog.getByRole('button', { name: '导出备份', exact: true }).click();
    const exportResponse = await exported; assert.equal(exportResponse.status(), 202); await finish(await exportResponse.json());
    await main.getByRole('button', { name: '工作区', exact: true }).click();
    await main.getByRole('button', { name: '导入备份', exact: true }).click();
    dialog = main.getByRole('dialog');
    await dialog.getByLabel('备份文件路径', { exact: true }).fill(file);
    await dialog.getByLabel('备份密码', { exact: true }).fill(password);
    await dialog.getByLabel('新环境名称', { exact: true }).fill('包内浏览器恢复环境');
    const recovered = main.waitForResponse(response => new URL(response.url()).pathname === '/api/backups/import');
    await dialog.getByRole('button', { name: '导入备份', exact: true }).click();
    const importResponse = await recovered; assert.equal(importResponse.status(), 202); await finish(await importResponse.json());
    imported = (await api('/snapshot')).environments.find((e: Environment) => e.id !== environment.id);
    assert.ok(imported); assert.equal(imported.name, '包内浏览器恢复环境');
    assert.deepEqual(imported.mounts, []); assert.deepEqual(imported.ports, []);
    await finish(await api(`/environments/${imported.id}/actions/start`, 'POST'));
    const admin = (args: string[]) => runtime.management(imported!, args, { timeoutMs: 30_000, maxBytes: 4_000_000 });
    await admin(['sudo', 'systemd-run', '--unit=mu-packaged-backup-capture', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'any', '-Q', 'out', '-U', '-s', '128', '-w', '/run/mu-packaged-backup.pcap']); capturing = true;
    report.importedBrowser = await browserReceipt(imported, 'imported');
    report.importedProtection = await api(`/environments/${imported.id}/network/protection`);
    assert.ok(report.importedProtection.active); assert.equal(report.importedProtection.integrity, 'verified');
    await admin(['sudo', 'systemctl', 'stop', 'mu-packaged-backup-capture.service']); capturing = false;
    const capture = Buffer.from((await admin(['sudo', 'base64', '-w0', '/run/mu-packaged-backup.pcap'])).trim(), 'base64');
    const captureFile = path.join(results, 'packaged-backup-browser.pcap'); await writeFile(captureFile, capture, { mode: 0o600 });
    const interfaceIndex = Number((await admin(['cat', '/sys/class/net/eth0/ifindex'])).trim());
    const physical = `ifindex ${interfaceIndex} and outbound`;
    const permitted = `(tcp and dst host 192.168.5.2 and dst port ${environment.network.port}) or (tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67)`;
    const packets = async (filter: string) => (await run('/usr/sbin/tcpdump', ['-nn', '-r', captureFile, `(${physical}) and (${filter})`], { maxBytes: 4_000_000 })).split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line));
    const [all, proxy, unapproved] = await Promise.all([packets('ip or ip6'), packets(`tcp and dst port ${environment.network.port}`), packets(`ip6 or (ip and not (${permitted}))`)]);
    assert.ok(all.length > 0 && proxy.length > 0); assert.deepEqual(unapproved, []);
    report.capture = { sha256: createHash('sha256').update(capture).digest('hex'), bytes: capture.length, interfaceIndex, physicalIpPackets: all.length, approvedProxyPackets: proxy.length, unapprovedPackets: 0 };
    assert.notDeepEqual(await readFile(path.join(runtime.limaHome, environment.instanceName, 'vz-identifier')), await readFile(path.join(runtime.limaHome, imported.instanceName, 'vz-identifier')));
    await finish(await api(`/environments/${imported.id}/actions/restart`, 'POST'));
    report.afterRestart = await browserReceipt(imported, 'restarted');
    await finish(await api(`/environments/${imported.id}/actions/stop`, 'POST'));
    report.actualUiExportImportAndVmRecovery = true;
    report.loginRequests = fixture.evidence.loginRequests;
    report.passed = true;
  } catch (error) { report.error = (error as Error).stack; throw error; }
  finally {
    if (capturing && imported) await runtime.management(imported, ['sudo', 'systemctl', 'stop', 'mu-packaged-backup-capture.service']).catch(() => {});
    await application?.close();
    await rm(desktopData, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(results, 'packaged-backup-browser.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  return report;
}
