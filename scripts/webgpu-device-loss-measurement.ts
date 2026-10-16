import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEVICE_LOSS_SETUP, DEVICE_LOSS_NAMES, verifyDeviceLossSetup, verifyDeviceLossRecovery, verifyDeviceLossProtection } from './webgpu-device-loss-fixture.ts';
import { workerCanvasPixels } from './browser-webgpu-worker-canvas-fixture.ts';

interface Transport {
  send(method: string, params?: Record<string, any>, session?: string): Promise<any>;
  trace(listener: (message: any) => void): () => void;
}
export async function measureDeviceLoss(transport: Transport, session: string, save: (frame: string, bytes: Buffer) => Promise<void>, inspect?: () => Promise<any>, protection?: () => Promise<any>) {
  const row: Record<string, any> = { passed: false, frames: [], samples: [], markers: [] };
  const evaluate = async (expression: string) => {
    const result = await transport.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));return result.result.value;
  };
  const request = (op: string, extra: Record<string, any> = {}) => evaluate(`window.__MU_GPU_LOSS_REQUEST__(${JSON.stringify(op)},${JSON.stringify(extra)})`);
  const snapshot = async () => ({ at: new Date().toISOString(), gpu: (await transport.send('SystemInfo.getInfo')).gpu.auxAttributes,
    processes: (await transport.send('SystemInfo.getProcessInfo')).processInfo, security: inspect ? await inspect() : null });
  const until = async (operation: () => Promise<any>, accept: (value: any) => boolean, message: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (true) { const value = await operation();if (accept(value)) return value;assert.ok(Date.now() < deadline, message);await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  let tracing = false, completed!: () => void;
  const traceDone = new Promise<void>(resolve => { completed = resolve; });
  const unsubscribe = transport.trace(message => {
    if (message.method === 'Tracing.dataCollected') row.markers.push(...message.params.value.filter((event: any) => event.name === 'TimeStamp'));
    if (message.method === 'Tracing.tracingComplete') completed();
  });
  const finishTrace = async () => {
    await transport.send('Tracing.end');tracing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([traceDone, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Device recovery trace timeout')), 10_000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    row.setup = await evaluate(DEVICE_LOSS_SETUP);assert.ok(verifyDeviceLossSetup(row.setup));
    await request('start', { durationMs: 8000 });
    row.active = await until(() => request('status'), value => DEVICE_LOSS_NAMES.every(name => value[name].frames >= 2), 'GPU workload did not begin');
    row.before = await snapshot();assert.equal(row.before.gpu.processCrashCount, 0);
    row.fault = { method: 'Browser.crashGpuProcess', at: new Date().toISOString(), completed: false };
    await transport.send('Browser.crashGpuProcess');row.fault.completed = true;
    row.lost = await until(() => request('status'), value => DEVICE_LOSS_NAMES.every(name => value[name].lost?.reason === 'unknown'), 'All four native devices did not report unexpected loss');
    row.oldFrames = await request('old-frame');
    row.recovered = await request('recover');assert.ok(verifyDeviceLossSetup(row.recovered));
    row.after = await snapshot();
    await transport.send('Tracing.start', { categories: 'devtools.timeline,blink.console', transferMode: 'ReportEvents' });tracing = true;
    await request('start', { durationMs: 12000 });
    await until(() => request('status'), value => DEVICE_LOSS_NAMES.every(name => value[name].frames >= 2), 'Recovery work did not begin');
    for (let index = 0; index < 5; index++) {
      await evaluate(`console.timeStamp('MU_GPU_CHECK_BEFORE:${index}')`);
      const before = await request('status'), security = inspect ? await inspect() : null;
      const gpu = (await transport.send('SystemInfo.getInfo')).gpu.auxAttributes;
      const network = protection ? await protection() : null, after = await request('status');
      await evaluate(`console.timeStamp('MU_GPU_CHECK_AFTER:${index}')`);
      row.samples.push({ before, after, security, gpu, protection: network, at: new Date().toISOString() });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    // Finish the real loop before requesting still frames on its device.
    row.finished = await until(() => request('status'), value => DEVICE_LOSS_NAMES.every(name => value[name].running === false), 'Recovery loop did not finish');
    await finishTrace();
    for (const offset of [0, .2]) {
      const replies = await request('frame', { offset });
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const screenshot = await transport.send('Page.captureScreenshot', { format: 'png' }, session), bytes = Buffer.from(screenshot.data, 'base64');
      const bounds = Object.fromEntries(Object.entries(replies).map(([name, reply]: [string, any]) => [name, reply.bounds]));
      const pixels = await evaluate(workerCanvasPixels(screenshot.data, bounds));
      row.frames.push({ offset, replies, pixels, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
      await save(offset === 0 ? 'first' : 'moved', bytes);
    }
    row.recoveryVerified = verifyDeviceLossRecovery(row);
    row.protectionVerified = inspect ? verifyDeviceLossProtection(row) : null;
    row.passed = row.recoveryVerified && (!inspect || row.protectionVerified);
  } catch (error) { row.error = (error as Error).stack; }
  finally {
    if (tracing) await finishTrace().catch(error => { row.traceCleanupError = String(error);row.passed = false; });
    unsubscribe();await evaluate('window.__MU_GPU_LOSS_CLEANUP__?.()').catch(error => { row.cleanupError = String(error);row.passed = false; });
  }
  return row;
}
