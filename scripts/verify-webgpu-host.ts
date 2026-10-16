import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { WEBGPU_CONTEXTS, WEBGPU_PRESENTATION, verifyWebGPUContexts, verifyWebGPUPresentation } from './browser-webgpu-fixture.ts';
import { WEBGPU_ALL_CONTEXTS, WEBGPU_WORKER_ASSETS, verifyWebGPUAllContexts } from './browser-webgpu-contexts-fixture.ts';
import { WORKER_CANVAS_ASSETS } from './browser-webgpu-worker-canvas-fixture.ts';
import { measureWorkerCanvases } from './worker-canvas-measurement.ts';
import { DEVICE_LOSS_ASSETS } from './webgpu-device-loss-fixture.ts';
import { measureDeviceLoss } from './webgpu-device-loss-measurement.ts';

const root = path.resolve(import.meta.dirname, '..');
const presentation = process.argv.includes('--presentation');
const deviceLoss = process.argv.includes('--device-loss');
const workerCanvases = process.argv.includes('--worker-canvases') || deviceLoss;
const allContexts = process.argv.includes('--all-contexts') || workerCanvases;
const reportName = 'browser-webgpu-host' + (presentation ? '-presentation' : '') + (allContexts ? '-all-contexts' : '') + (workerCanvases ? '-worker-canvases' : '') + (deviceLoss ? '-device-loss' : '');
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), accountFree: true, paidModelCalls: 0, scope: 'Host Chrome isolated profile baseline; no guest VM or network protection claim' };
const server = createServer((request, response) => {
  const asset = { ...WEBGPU_WORKER_ASSETS, ...WORKER_CANVAS_ASSETS, ...DEVICE_LOSS_ASSETS }[request.url ?? ''];
  response.setHeader('Content-Type', asset ? 'text/javascript' : 'text/html');
  response.end(asset ?? '<!doctype html><title>Owned WebGPU baseline</title>');
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  report.testedFiles = Object.fromEntries(await Promise.all(['scripts/browser-webgpu-fixture.ts', 'scripts/verify-webgpu-host.ts', ...(allContexts ? ['scripts/browser-webgpu-contexts-fixture.ts'] : []), ...(workerCanvases ? ['scripts/browser-webgpu-worker-canvas-fixture.ts', 'scripts/worker-canvas-measurement.ts'] : []), ...(deviceLoss ? ['scripts/webgpu-device-loss-fixture.ts', 'scripts/webgpu-device-loss-measurement.ts'] : [])].map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  report.browserVersion = browser.version();
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  report.observation = await page.evaluate(allContexts ? WEBGPU_ALL_CONTEXTS : WEBGPU_CONTEXTS);
  report.measurementCompleted = true;
  report.allWorkerContextsTested = allContexts;
  report.passed = allContexts ? verifyWebGPUAllContexts(report.observation) : verifyWebGPUContexts(report.observation);
  if (presentation) {
    report.presentation = await page.evaluate(WEBGPU_PRESENTATION);
    report.presentationVerified = verifyWebGPUPresentation(report.presentation);
    report.passed &&= report.presentationVerified;
    const file = path.join(root, 'test-results', 'browser-webgpu-host-presentation' + (allContexts ? '-all-contexts' : '') + '.png');
    const bytes = await page.screenshot({ path: file });
    report.screenshot = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }
  if (workerCanvases) {
    const rootSession = await browser.newBrowserCDPSession(), pageSession = await page.context().newCDPSession(page);
    report.workerCanvasesTested = true;
    report.workerCanvases = await measureWorkerCanvases({
      send: (method, params, session) => (session ? pageSession : rootSession).send(method as any, params),
      trace: listener => {
        const data = (params: any) => listener({ method: 'Tracing.dataCollected', params });
        const complete = (params: any) => listener({ method: 'Tracing.tracingComplete', params });
        rootSession.on('Tracing.dataCollected', data);rootSession.on('Tracing.tracingComplete', complete);
        return () => {rootSession.off('Tracing.dataCollected', data);rootSession.off('Tracing.tracingComplete', complete);};
      },
    }, 'host', async (frame, bytes) => { await writeFile(path.join(root, 'test-results', `${reportName}-${frame}.png`), bytes, { mode: 0o600 }); });
    report.passed &&= report.workerCanvases.passed;
    if (deviceLoss) {
      report.deviceLossTested = true;
      report.deviceLoss = await measureDeviceLoss({
        send: (method, params, session) => (session ? pageSession : rootSession).send(method as any, params),
        trace: listener => {
          const data = (params: any) => listener({ method: 'Tracing.dataCollected', params });
          const complete = (params: any) => listener({ method: 'Tracing.tracingComplete', params });
          rootSession.on('Tracing.dataCollected', data);rootSession.on('Tracing.tracingComplete', complete);
          return () => {rootSession.off('Tracing.dataCollected', data);rootSession.off('Tracing.tracingComplete', complete);};
        },
      }, 'host', async (frame, bytes) => { await writeFile(path.join(root, 'test-results', `${reportName}-recovered-${frame}.png`), bytes, { mode: 0o600 }); });
      report.passed &&= report.deviceLoss.passed;
    }
    await pageSession.detach();await rootSession.detach();
  }
  assert.equal(report.passed, true, 'Default WebGPU computation/rendering did not pass both contexts');
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
finally {
  await browser?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  report.finishedAt = new Date().toISOString();
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  for (const [file, expected] of Object.entries(report.testedFiles ?? {})) {
    const bytes = await readFile(path.join(root, file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `Host source changed during measurement: ${file}`);
    const destination = path.join(root, 'test-results', reportName, 'source', file);
    await mkdir(path.dirname(destination), { recursive: true });await writeFile(destination, bytes, { mode: 0o600 });
  }
  await writeFile(path.join(root, 'test-results', `${reportName}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, browserVersion: report.browserVersion, workerCanvasesPassed: report.workerCanvases?.passed,
    deviceLossPassed: report.deviceLoss?.passed, deviceLossError: report.deviceLoss?.error, error: report.error, finishedAt: report.finishedAt }, null, 2));
}
