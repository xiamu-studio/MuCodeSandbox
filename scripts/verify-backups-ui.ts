import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createService } from '../server/service.ts';
import type { Job } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..'), temporary = await mkdtemp(path.join(homedir(), '.mu-backup-ui-'));
const results = path.join(root, 'test-results'); await mkdir(results, { recursive: true });
const file = path.join(temporary, 'ui-backup.mu-backup');
const service = await createService({ rootDir: root, dataDir: path.join(temporary, 'data'), port: 0, backupPicker: async () => file });
service.manager.runtime.info = async () => ({ available: false, path: null, version: null, error: null });
service.manager.runtime.list = async () => service.manager.store.list().map(e => ({ name: e.instanceName, status: 'Stopped' }));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const report: Record<string, unknown> = { passed: false, scope: 'Rendered UI and real local archive API; synthetic disk, no VM, Claude account or paid request', startedAt: new Date().toISOString() };
async function complete(job: Job, status = 'succeeded') {
  await service.manager.tasks.get(job.id)?.promise;
  assert.equal(service.manager.store.jobs().find(item => item.id === job.id)?.status, status);
}
async function layout(mode: string) {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(await page.getByRole('dialog').locator('button').evaluateAll(elements => elements.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent)), []);
    await page.screenshot({ path: path.join(results, `backup-${mode}-${width}.png`), fullPage: true });
  }
}
try {
  const created = await service.manager.create({ name: '备份界面验收', memoryGiB: 2 });
  service.manager.store.state(created.id, 'stopped');
  const e = service.manager.store.get(created.id), instance = path.join(service.manager.runtime.limaHome, e.instanceName);
  await mkdir(instance, { recursive: true });
  await writeFile(path.join(instance, 'disk'), 'MU_UI_SYNTHETIC_DISK');
  await service.manager.snapshots.create(e, '恢复点与加密导出范围验收');
  const password = 'mu-ui-synthetic-password';
  await page.goto(service.launchUrl());
  await page.getByRole('button', { name: '备份界面验收 Linux 沙箱', exact: true }).click();
  await page.getByRole('button', { name: '快照', exact: true }).click();
  await page.getByRole('button', { name: '导出 恢复点与加密导出范围验收', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '选择保存位置', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '备份文件路径' })).toHaveValue(file);
  await dialog.getByLabel('备份密码', { exact: true }).fill(password);
  await dialog.getByLabel('确认密码', { exact: true }).fill('different-password');
  assert.ok(await dialog.getByRole('button', { name: '导出备份', exact: true }).isDisabled());
  await dialog.getByLabel('确认密码', { exact: true }).fill(password);
  await layout('export');
  const exported = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/export'));
  await dialog.getByRole('button', { name: '导出备份', exact: true }).click();
  const exportResponse = await exported; assert.equal(exportResponse.status(), 202);
  await complete(await exportResponse.json());
  assert.ok((await stat(file)).size > 52);
  assert.equal(service.manager.store.get(e.id).state, 'stopped');
  await page.getByRole('button', { name: '工作区', exact: true }).click();
  await page.getByRole('button', { name: '导入备份', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '选择备份文件', exact: true }).click();
  await dialog.getByLabel('新环境名称', { exact: true }).fill('从加密备份导入');
  await dialog.getByLabel('备份密码', { exact: true }).fill(password);
  await layout('import');
  const imported = page.waitForResponse(response => new URL(response.url()).pathname === '/api/backups/import');
  await dialog.getByRole('button', { name: '导入备份', exact: true }).click();
  const importResponse = await imported; assert.equal(importResponse.status(), 202);
  await complete(await importResponse.json());
  assert.equal(service.manager.store.list().length, 2);
  const recovered = service.manager.store.list().find(item => item.id !== e.id)!;
  assert.equal(recovered.name, '从加密备份导入'); assert.equal(recovered.state, 'not_created');
  assert.deepEqual(recovered.mounts, []); assert.deepEqual(recovered.ports, []);
  assert.ok(!JSON.stringify(service.manager.store.logs(null)).includes(password));
  assert.ok(!(await readFile(file)).includes(Buffer.from('MU_UI_SYNTHETIC_DISK')));
  assert.deepEqual(errors, []);
  report.checks = ['password confirmation', 'path picker callbacks', '1440/390/320 export and import modals', 'real encrypted archive export and import', 'background job success', 'fresh environment without host grants', 'password absent from logs'];
  report.passed = true;
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
finally {
  await browser.close(); await service.close(); await rm(temporary, { recursive: true, force: true });
  report.browserErrors = errors; report.finishedAt = new Date().toISOString();
  await writeFile(path.join(results, 'portable-backups-ui.json'), JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report, null, 2));
}
