import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { run } from '../server/process.ts';
import { verifyWebGPUContexts, verifyWebGPUPresentation } from './browser-webgpu-fixture.ts';
import { verifyWebGPUAllContexts } from './browser-webgpu-contexts-fixture.ts';
import { verifyWorkerCanvasSetup, verifyWorkerCanvasFrames, verifyWorkerLiveProtection, workerCanvasPixels } from './browser-webgpu-worker-canvas-fixture.ts';
import { verifyDeviceLossRecovery, verifyDeviceLossProtection } from './webgpu-device-loss-fixture.ts';

const root = path.resolve(import.meta.dirname, '..');
const name = process.argv.find(value => value.startsWith('--report='))?.slice('--report='.length)
  ?? 'browser-webgpu-presentation-diagnostic-swiftshader-vulkan';
assert.match(name, /^browser-webgpu-(?:presentation-diagnostic|candidate-lifecycle)(?:-swiftshader-(?:vulkan|graphite))?(?:-all-contexts)?(?:-worker-canvases)?(?:-device-loss)?(?:-packaged)?$/);
const artifacts = path.join(root, 'test-results', name);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const audit: Record<string, any> = { evidenceVerified: false, startedAt: new Date().toISOString(),
  scope: 'Independent review of saved WebGPU source, pixels, thread protection and physical captures; no guest or account started', variants: [], captures: [] };
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let pixelServer: ReturnType<typeof createServer> | undefined;
try {
  audit.verifierSha256 = hash(await readFile(path.join(root, 'scripts/verify-webgpu-evidence.ts')));
  audit.contextVerifierSha256 = hash(await readFile(path.join(root, 'scripts/browser-webgpu-fixture.ts')));
  const bytes = await readFile(path.join(root, 'test-results', `${name}.json`)), source = JSON.parse(bytes.toString());
  audit.observationSha256 = hash(bytes);
  assert.equal(source.measurementCompleted, true);
  assert.equal(source.accountFree, true); assert.equal(source.paidModelCalls, 0);
  assert.equal(source.productionConfigurationChanged, false);
  assert.equal(source.allWorkerContextsTested === true, name.includes('-all-contexts'));
  audit.allWorkerContextsTested = source.allWorkerContextsTested === true;
  assert.equal(source.workerCanvasesTested === true, name.includes('-worker-canvases'));
  audit.workerCanvasesTested = source.workerCanvasesTested === true;
  assert.equal(source.deviceLossTested === true, name.includes('-device-loss'));
  audit.deviceLossTested = source.deviceLossTested === true;
  const files = ['server/guest-browser-runtime.ts', 'server/guest-browser-sandbox.ts', 'server/guest-browser.ts',
    'scripts/browser-media-fixture.ts', 'scripts/verify-browser-gpu.ts', 'scripts/browser-webgpu-fixture.ts', ...(source.allWorkerContextsTested ? ['scripts/browser-webgpu-contexts-fixture.ts'] : []), ...(source.workerCanvasesTested ? ['scripts/browser-webgpu-worker-canvas-fixture.ts', 'scripts/worker-canvas-measurement.ts'] : []), ...(source.deviceLossTested ? ['scripts/webgpu-device-loss-fixture.ts', 'scripts/webgpu-device-loss-measurement.ts'] : [])];
  if (source.allWorkerContextsTested) audit.allContextVerifierSha256 = hash(await readFile(path.join(root, 'scripts/browser-webgpu-contexts-fixture.ts')));
  assert.deepEqual(Object.keys(source.testedFiles).sort(), files.sort());
  for (const file of files) assert.equal(hash(await readFile(path.join(artifacts, 'source', file))), source.testedFiles[file], file);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  if (source.workerCanvasesTested) {
    audit.workerCanvasVerifierSha256 = hash(await readFile(path.join(root, 'scripts/browser-webgpu-worker-canvas-fixture.ts')));
    pixelServer = createServer((_request, response) => response.end('<!doctype html><title>Owned pixel decoder</title>'));
    await new Promise<void>(resolve => pixelServer!.listen(0, '127.0.0.1', resolve));
    await page.goto(`http://127.0.0.1:${(pixelServer.address() as { port: number }).port}`);
  }
  const protectedProcess = (process: any, uid: number, renderer: boolean) => process.uid === uid && process.seccomp === 2
    && process.noNewPrivileges === 1 && /^0+$/.test(process.effectiveCapabilities) && process.noSandboxFlag === false
    && (!renderer || process.separatePidNamespace === true) && process.threads.length > 0
    && process.threads.some((thread: any) => thread.tid === process.pid)
    && process.threads.every((thread: any) => thread.seccomp === 2 && thread.noNewPrivileges === 1 && /^0+$/.test(thread.effectiveCapabilities));
  assert.ok(source.variants.length > 0);
  for (const row of source.variants) {
    assert.match(row.name, /^[a-z0-9-]+$/);
    const computeVerified = source.allWorkerContextsTested ? verifyWebGPUAllContexts(row.webGPU) : verifyWebGPUContexts(row.webGPU);
    assert.equal(row.webGPUComputeAndRenderVerified, computeVerified, row.name);
    let canvasVerified = verifyWebGPUPresentation(row.presentation);
    const frames: any[] = [];
    for (const frame of row.presentationScreenshots ?? []) {
      assert.ok(['first', 'moved'].includes(frame.frameName));
      const png = await readFile(path.join(artifacts, `${row.name}-webgpu-${frame.frameName}.png`));
      assert.equal(hash(png), frame.sha256); assert.equal(png.length, frame.bytes);
      const bounds = row.presentation[frame.frameName].bounds;
      const pixel = await page.evaluate(async ({ encoded, bounds, scale }) => {
        const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
        const x = Math.round(bounds.x * scale), y = Math.round(bounds.y * scale);
        const width = Math.round(bounds.width * scale), height = Math.round(bounds.height * scale);
        if (!(scale > 0 && x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= canvas.width && y + height <= canvas.height)) throw Error('Invalid screenshot bounds');
        const data = context.getImageData(x, y, width, height).data; let green = 0, red = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] === 0 && data[i + 1] === 255 && data[i + 2] === 0 && data[i + 3] === 255) green++;
          if (data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 255) red++;
        }
        return { green, red, pixels: data.length / 4, scale };
      }, { encoded: png.toString('base64'), bounds, scale: frame.pixel.scale });
      assert.deepEqual(pixel, frame.pixel);
      const verified = pixel.green > 1000 && pixel.red > 1000 && pixel.green + pixel.red === pixel.pixels
        && Math.abs(pixel.green / pixel.pixels - row.presentation[frame.frameName].green / 4096) < .01;
      assert.equal(frame.verified, verified);
      frames.push({ frameName: frame.frameName, pixel, verified, sha256: frame.sha256 });
    }
    canvasVerified &&= frames.length === 2 && frames.every(frame => frame.verified)
      && frames[0].frameName === 'first' && frames[1].frameName === 'moved' && frames[0].sha256 !== frames[1].sha256;
    assert.equal(row.webGPUCanvasVerified === true, canvasVerified, row.name);
    let workerCanvasVerified: boolean | null = null, workerLiveVerified: boolean | null = null;
    if (source.workerCanvasesTested && row.workerCanvases) {
      const workers = row.workerCanvases;
      assert.ok(verifyWorkerCanvasSetup(workers.setup));
      for (const [index, frame] of workers.frames.entries()) {
        const png = await readFile(path.join(artifacts, `${row.name}-workers-${index === 0 ? 'first' : 'moved'}.png`));
        assert.equal(hash(png), frame.sha256);assert.equal(png.length, frame.bytes);
        const scale = frame.pixels.dedicated.scale;
        assert.ok(Number.isFinite(scale) && scale > 0);
        assert.ok(Object.values(frame.pixels).every((pixel: any) => pixel.scale === scale));
        const dimensions = await page.evaluate(async encoded => {
          const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          const size = { width: bitmap.width, height: bitmap.height };bitmap.close();return size;
        }, png.toString('base64'));
        const viewportWidth = dimensions.width / scale;
        assert.equal(Math.round(viewportWidth), viewportWidth);
        await page.setViewportSize({ width: viewportWidth, height: Math.round(dimensions.height / scale) });
        const bounds = Object.fromEntries(Object.entries(frame.replies).map(([name, reply]: [string, any]) => [name, reply.bounds]));
        const pixels = await page.evaluate(workerCanvasPixels(png.toString('base64'), bounds));
        assert.deepEqual(pixels, frame.pixels);
        for (const name of ['dedicated', 'shared', 'service']) {
          assert.equal(frame.replies[name].instance, workers.setup[name].instance);
          assert.equal(frame.replies[name].kind, workers.setup[name].kind);
        }
      }
      workerCanvasVerified = verifyWorkerCanvasFrames(workers.frames);
      workerLiveVerified = verifyWorkerLiveProtection(workers);
      assert.equal(workers.canvasVerified, workerCanvasVerified);assert.equal(workers.liveProtectionVerified, workerLiveVerified);
      for (const sample of workers.samples) for (const process of sample.security.processes)
        assert.ok(protectedProcess(process, sample.security.developmentUid, process.role === 'renderer'));
      for (const name of ['dedicated', 'shared', 'service']) {
        assert.equal(workers.completed[name].instance, workers.setup[name].instance);
        assert.equal(workers.completed[name].kind, workers.setup[name].kind);
      }
      assert.equal(workers.passed, workerCanvasVerified && workerLiveVerified && !workers.cleanupError);
    }
    let deviceRecoveryVerified: boolean | null = null, deviceProtectionVerified: boolean | null = null;
    if (source.deviceLossTested && row.deviceLoss) {
      audit.deviceLossVerifierSha256 = hash(await readFile(path.join(root, 'scripts/webgpu-device-loss-fixture.ts')));
      const loss = row.deviceLoss;
      for (const [index, frame] of loss.frames.entries()) {
        const png = await readFile(path.join(artifacts, `${row.name}-recovered-${index === 0 ? 'first' : 'moved'}.png`));
        assert.equal(hash(png), frame.sha256);assert.equal(png.length, frame.bytes);
        const scale = frame.pixels.page.scale;
        assert.ok(Number.isFinite(scale) && scale > 0 && Object.values(frame.pixels).every((p: any) => p.scale === scale));
        const dimensions = await page.evaluate(async encoded => {
          const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), v => v.charCodeAt(0))], { type: 'image/png' }));
          const size = { width: bitmap.width, height: bitmap.height };bitmap.close();return size;
        }, png.toString('base64'));
        const width = dimensions.width / scale;assert.equal(Math.round(width), width);
        await page.setViewportSize({ width, height: Math.round(dimensions.height / scale) });
        const bounds = Object.fromEntries(Object.entries(frame.replies).map(([name, reply]: [string, any]) => [name, reply.bounds]));
        assert.deepEqual(await page.evaluate(workerCanvasPixels(png.toString('base64'), bounds)), frame.pixels);
      }
      deviceRecoveryVerified = verifyDeviceLossRecovery(loss);deviceProtectionVerified = verifyDeviceLossProtection(loss);
      assert.equal(loss.recoveryVerified, deviceRecoveryVerified);assert.equal(loss.protectionVerified, deviceProtectionVerified);
      assert.equal(loss.passed, deviceRecoveryVerified && deviceProtectionVerified && !loss.cleanupError && !loss.traceCleanupError);
      if (loss.passed) assert.equal(row.browserJournal.match(/GPU process exited unexpectedly/g)?.length, 1);
    }
    let sandboxVerified: boolean | null = null, stableVerified = false;
    if (row.processSecurity) {
      const security = row.processSecurity, renderers = security.processes.filter((process: any) => process.role === 'renderer');
      const graphics = security.processes.filter((process: any) => process.role === 'gpu-process');
      const rendererVerified = renderers.length > 0 && renderers.every((process: any) => protectedProcess(process, security.developmentUid, true));
      sandboxVerified = graphics.length > 0 && row.gpuDiagnostics.gpu.auxAttributes.sandboxed === true
        && graphics.every((process: any) => protectedProcess(process, security.developmentUid, false));
      assert.equal(row.rendererSandboxVerified, rendererVerified); assert.equal(row.gpuSandboxVerified, sandboxVerified);
      stableVerified = row.stabilitySamples?.length > 0 && row.stabilitySamples.every((sample: any) => sample.gpu.sandboxed === true
        && sample.gpu.processCrashCount === 0
        && JSON.stringify(sample.processSecurity.processes.filter((process: any) => process.role === 'gpu-process').map((process: any) => process.pid).sort()) === JSON.stringify(graphics.map((process: any) => process.pid).sort())
        && sample.processSecurity.processes.every((process: any) => protectedProcess(process, sample.processSecurity.developmentUid, process.role === 'renderer')));
      assert.equal(row.stableGraphicsVerified, stableVerified);
      for (const sample of row.stabilitySamples ?? []) {
        if (!row.stableGraphicsVerified) continue;
        assert.equal(sample.gpu.sandboxed, true); assert.equal(sample.gpu.processCrashCount, 0);
        assert.deepEqual(sample.processSecurity.processes.filter((process: any) => process.role === 'gpu-process').map((process: any) => process.pid).sort(), graphics.map((process: any) => process.pid).sort());
        for (const process of sample.processSecurity.processes)
          assert.ok(protectedProcess(process, sample.processSecurity.developmentUid, process.role === 'renderer'));
      }
    }
    const webGLVerified = row.rendering?.length === 2 && row.rendering.every((value: any) => value.supported
      && value.first.green > 1000 && value.first.background > 1000 && value.first.hash === value.repeated.hash
      && value.first.hash !== value.moved.hash && [value.first, value.repeated, value.moved].every(frame => frame.error === 0));
    if (row.webGLRenderingVerified !== undefined) assert.equal(row.webGLRenderingVerified, webGLVerified);
    if (row.passed) {
      assert.ok(computeVerified && canvasVerified && sandboxVerified && stableVerified);
      assert.equal(row.webGLRenderingVerified, true); assert.equal(row.stabilitySamples.length, 15);
      assert.equal(row.stableGraphicsVerified, true); assert.equal(row.profileExitType, 'Normal');
      if (source.workerCanvasesTested) assert.ok(workerCanvasVerified && workerLiveVerified);
      if (source.deviceLossTested) assert.ok(deviceRecoveryVerified && deviceProtectionVerified);
    }
    audit.variants.push({ name: row.name, capabilityPassed: row.passed, computeVerified, canvasVerified, workerCanvasVerified, workerLiveVerified, deviceRecoveryVerified, deviceProtectionVerified, sandboxVerified, protectionObserved: !!row.processSecurity, frames });
  }
  assert.equal(source.startupGuardFaultVerified, true); assert.equal(source.guardFault.rejected, true);
  assert.equal(source.guardFault.remoteDisplaySecretRemoved, true);
  assert.ok(['inactive', 'failed'].includes(source.guardFault.finalServiceState));
  const faultGraphics = source.guardFault.processSecurity.processes.filter((process: any) => process.role === 'gpu-process');
  assert.ok(faultGraphics.length > 0);
  for (const process of faultGraphics) {
    assert.equal(process.seccomp, 0); assert.ok(process.threads.length > 0);
    for (const thread of process.threads) assert.equal(thread.seccomp, 0);
  }
  assert.ok(source.guardFault.targets.some((target: any) => target.type === 'page' && target.url === 'about:blank'));
  assert.ok(source.guardFault.targets.every((target: any) => !/^https?:/.test(target.url)));
  for (const protection of [source.initialProtection, source.finalProtection]) {
    assert.equal(protection.active, true); assert.equal(protection.integrity, 'verified');
  }
  for (const key of ['firewallHash', 'tunnelConfigHash']) assert.equal(source.initialProtection[key], source.finalProtection[key]);
  assert.ok(source.captures.length > 0);
  const endpoint = new URL(`tcp://${source.initialProtection.proxyEndpoints[0]}`);
  assert.equal(endpoint.hostname, '192.168.5.2'); assert.ok(Number(endpoint.port) > 0);
  for (const capture of source.captures) {
    assert.match(capture.file, /^physical-(?:out|before-restart)\.pcap$/);
    const file = path.join(artifacts, capture.file), bytes = await readFile(file);
    assert.equal(hash(bytes), capture.sha256); assert.equal(bytes.length, capture.bytes);
    const allowed = `(tcp and dst host 192.168.5.2 and dst port ${endpoint.port}) or (tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67)`;
    const count = async (filter: string) => (await run('/usr/sbin/tcpdump', ['-nn', '-r', file, filter], { maxBytes: 64_000_000 })).split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line)).length;
    assert.equal(await count(`ip6 or (ip and not (${allowed}))`), 0);
    const approved = await count(`tcp and dst host 192.168.5.2 and dst port ${endpoint.port}`);
    assert.ok(approved > 0); assert.equal(approved, capture.approvedProxyPackets); assert.equal(capture.unapprovedPackets, 0);
    audit.captures.push({ file: capture.file, approvedProxyPackets: approved, unapprovedPackets: 0, sha256: capture.sha256 });
  }
  const accepted = source.variants.filter((row: any) => row.passed && row.profileExitType === 'Normal').map((row: any) => row.name);
  assert.deepEqual(source.accepted3DVariants, accepted);
  const lifecycle = name.startsWith('browser-webgpu-candidate-lifecycle');
  if (lifecycle) {
    const verified = source.vmRestart?.verified === true && source.vmRestart.before !== source.vmRestart.after
      && source.variants.length === 4 && source.variants.every((row: any) => row.passed && row.profileExitType === 'Normal' && row.startupGuardVerified === true)
      && new Set(source.variants.map((row: any) => row.invocationId)).size === 4;
    assert.equal(source.candidateLifecycleVerified, verified);
  }
  assert.equal(source.passed, accepted.length > 0 && (!lifecycle || source.candidateLifecycleVerified === true));
  const actualOverride = source.variants.some((row: any) => row.flags.includes('--disable-dawn-features=adapter_blocklist'));
  if (source.experimentalDawnBlocklistOverride !== actualOverride)
    audit.metadataDiscrepancies = ['experimentalDawnBlocklistOverride differs from actual recorded flags'];
  audit.capabilityPassed = source.passed;
  audit.evidenceVerified = true;
} catch (error) { audit.error = (error as Error).stack; process.exitCode = 1; }
finally {
  if (pixelServer) { pixelServer.closeAllConnections();await new Promise<void>(resolve => pixelServer!.close(() => resolve())); }
  await browser?.close(); audit.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'test-results', `${name}-evidence.json`), JSON.stringify(audit, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(audit, null, 2));
}
