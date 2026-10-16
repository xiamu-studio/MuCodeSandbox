import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const bundle = path.join(root, 'release/host-power-fix-candidate/mac-arm64/MuCodeSandbox.app');
const owned = await mkdtemp(path.join(homedir(), '.mu-power-desktop-'));
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), bundle,
  actualElectronPackageTested: true, actualVmTested: false, actualMacSleepTested: false,
  injectedPowerEvents: true, accountFree: true, paidModelCalls: 0,
  scope: 'Real Electron powerMonitor listener and API gate, injected events, no VM or physical host sleep/wake' };
let app: ElectronApplication | undefined, page: Page | undefined;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function request(endpoint: string, body?: unknown) {
  return page!.evaluate(async ({ endpoint, body }) => {
    const response = await fetch(`/api${endpoint}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${(window as any).__MU_CONFIG__.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  }, { endpoint, body });
}
try {
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
  assert.match(signature, /Signature=adhoc/); report.cdHash = signature.match(/^CDHash=(.+)$/m)?.[1];
  assert.equal(report.cdHash, '4227377499a5aaeba73db3f31b821e44a5234aff');
  report.components = {};
  for (const file of ['desktop/main.cjs', 'dist-server/server/manager.js']) {
    const hash = digest(await readFile(path.join(bundle, 'Contents/Resources/app', file)));
    assert.equal(hash, digest(await readFile(path.join(root, file)))); report.components[file] = hash;
  }
  app = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/MuCodeSandbox'), args: [], chromiumSandbox: true,
    env: { ...process.env, MU_DATA_DIR: path.join(owned, 'data'), MU_DESKTOP_USER_DATA_DIR: path.join(owned, 'desktop') } });
  page = await app.firstWindow(); await page.getByRole('heading', { name: 'MuCodeSandbox', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].hide(); });
  const info = (await request('/snapshot')).body;
  assert.equal(info.system.dataDir, path.join(owned, 'data'));
  assert.equal(info.system.runtime.available, false, 'This test must not start a real VM or install components');
  report.application = await app.evaluate(({ app, powerMonitor }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(),
    sandboxedRenderers: app.getAppMetrics().filter(metric => metric.type === 'Tab').map(metric => metric.sandboxed),
    suspendListeners: powerMonitor.listenerCount('suspend'), resumeListeners: powerMonitor.listenerCount('resume') }));
  assert.equal(report.application.packaged, true); assert.equal(report.application.appPath, path.join(bundle, 'Contents/Resources/app'));
  assert.ok(report.application.sandboxedRenderers.length > 0 && report.application.sandboxedRenderers.every(Boolean));
  assert.ok(report.application.suspendListeners > 0 && report.application.resumeListeners > 0);
  const created = await request('/environments', { name: 'Power desktop no-VM check', cpus: 1, memoryGiB: 1, diskGiB: 10,
    network: { mode: 'http', host: '127.0.0.1', port: 9, strict: true, transparent: true } });
  assert.equal(created.status, 201);
  const id = created.body.id;
  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('suspend'); });
  const rejected = await request(`/environments/${id}/actions/start`, {});
  assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'HOST_POWER_TRANSITION');
  report.suspendRejectedStartup = rejected.body.code;
  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('resume'); });
  const resumed = await request('/snapshot');
  assert.equal(resumed.body.jobs.length, 0); assert.equal(resumed.body.environments[0].state, 'not_created');
  report.resumeDidNotAutomaticallyStart = true;
  const explicit = await request(`/environments/${id}/actions/start`, {});
  assert.equal(explicit.status, 409); assert.equal(explicit.body.code, 'RUNTIME_MISSING');
  report.explicitStartReachedNormalRuntimeCheck = true;
  assert.equal((await request('/snapshot')).body.jobs.length, 0);
  report.noRuntimeJobs = true;
  report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  try { await app?.close(); await rm(owned, { recursive: true, force: true }); report.temporaryDataRemoved = true; }
  catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  report.harnessSha256 = digest(await readFile(import.meta.filename));
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/host-power-desktop.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
