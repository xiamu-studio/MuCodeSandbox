import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { verifyWebGPUAllContexts } from './browser-webgpu-contexts-fixture.ts';
import { verifyWorkerCanvasSetup, verifyWorkerCanvasFrames, workerCanvasPixels } from './browser-webgpu-worker-canvas-fixture.ts';
import { verifyDeviceLossRecovery } from './webgpu-device-loss-fixture.ts';

const root = path.resolve(import.meta.dirname, '..');
const name = 'browser-webgpu-host-all-contexts-worker-canvases-device-loss';
const artifacts = path.join(root, 'test-results', name);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const audit: Record<string, any> = { evidenceVerified: false, startedAt: new Date().toISOString(),
  scope: 'Independent saved host native device loss and actual screenshot review; no account or guest started, no host network or kernel protection proof' };
const server = createServer((_request, response) => response.end('<!doctype html><title>Owned evidence decoder</title>'));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  audit.verifierSha256 = hash(await readFile(path.join(root, 'scripts/verify-webgpu-device-loss-host-evidence.ts')));
  const bytes = await readFile(path.join(root, 'test-results', `${name}.json`)), report = JSON.parse(bytes.toString());
  audit.observationSha256 = hash(bytes);
  assert.equal(report.accountFree, true);assert.equal(report.paidModelCalls, 0);
  assert.equal(report.measurementCompleted, true);assert.equal(report.deviceLossTested, true);assert.equal(report.workerCanvasesTested, true);
  const files = ['scripts/browser-webgpu-fixture.ts', 'scripts/verify-webgpu-host.ts', 'scripts/browser-webgpu-contexts-fixture.ts',
    'scripts/browser-webgpu-worker-canvas-fixture.ts', 'scripts/worker-canvas-measurement.ts', 'scripts/webgpu-device-loss-fixture.ts', 'scripts/webgpu-device-loss-measurement.ts'];
  assert.deepEqual(Object.keys(report.testedFiles).sort(), files.sort());
  for (const file of files) assert.equal(hash(await readFile(path.join(artifacts, 'source', file))), report.testedFiles[file]);
  audit.deviceLossVerifierSha256 = hash(await readFile(path.join(root, 'scripts/webgpu-device-loss-fixture.ts')));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  for (const [series, suffix] of [[report.workerCanvases, ''], [report.deviceLoss, '-recovered']] as const) {
    assert.equal(series.samples.length, 5);
    assert.ok(series.samples.every((sample: any) => sample.security === null));
    assert.equal(suffix ? series.protectionVerified : series.liveProtectionVerified, null);
    for (const [index, frame] of series.frames.entries()) {
      const file = `${name}${suffix}-${index === 0 ? 'first' : 'moved'}.png`, png = await readFile(path.join(root, 'test-results', file));
      assert.equal(hash(png), frame.sha256);assert.equal(png.length, frame.bytes);
      const scale = Object.values(frame.pixels)[0] as any;
      assert.ok(Number.isFinite(scale.scale) && scale.scale > 0 && Object.values(frame.pixels).every((p: any) => p.scale === scale.scale));
      const dimensions = await page.evaluate(async encoded => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), v => v.charCodeAt(0))], { type: 'image/png' }));
        const size = { width: bitmap.width, height: bitmap.height };bitmap.close();return size;
      }, png.toString('base64'));
      const width = dimensions.width / scale.scale;assert.equal(Math.round(width), width);
      await page.setViewportSize({ width, height: Math.round(dimensions.height / scale.scale) });
      const bounds = Object.fromEntries(Object.entries(frame.replies).map(([name, reply]: [string, any]) => [name, reply.bounds]));
      assert.deepEqual(await page.evaluate(workerCanvasPixels(png.toString('base64'), bounds)), frame.pixels);
    }
  }
  const compute = verifyWebGPUAllContexts(report.observation), workers = verifyWorkerCanvasSetup(report.workerCanvases.setup)
    && verifyWorkerCanvasFrames(report.workerCanvases.frames) && !report.workerCanvases.cleanupError;
  const recovery = verifyDeviceLossRecovery(report.deviceLoss);
  assert.equal(report.workerCanvases.canvasVerified, true);assert.equal(report.workerCanvases.passed, workers);
  assert.equal(report.deviceLoss.recoveryVerified, recovery);
  const capability = compute && workers && recovery && !report.deviceLoss.cleanupError && !report.deviceLoss.traceCleanupError;
  assert.equal(report.passed, capability);
  audit.computeVerified = compute;audit.workerBaselineVerified = workers;audit.deviceRecoveryVerified = recovery;
  audit.capabilityPassed = capability;audit.evidenceVerified = true;
  audit.recoveryPixels = report.deviceLoss.frames.map((frame: any) => frame.pixels);
} catch (error) { audit.error = (error as Error).stack;process.exitCode = 1; }
finally {
  await browser?.close();server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));
  audit.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'test-results', `${name}-evidence.json`), JSON.stringify(audit, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(audit, null, 2));
}
