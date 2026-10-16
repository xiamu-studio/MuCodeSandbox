import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WORKER_CANVAS_SETUP, workerCanvasPixels, verifyWorkerCanvasSetup, verifyWorkerCanvasFrames, verifyWorkerLiveProtection } from './browser-webgpu-worker-canvas-fixture.ts';

interface Transport {
  send(method: string, params?: Record<string, any>, session?: string): Promise<any>;
  trace(listener: (message: any) => void): () => void;
}
export async function measureWorkerCanvases(transport: Transport, session: string, save: (frame: string, bytes: Buffer) => Promise<void>, inspect?: () => Promise<any>) {
  const row: Record<string, any> = { passed: false, frames: [], samples: [], markers: [] };
  const evaluate = async (expression: string) => {
    const value = await transport.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    assert.equal(value.exceptionDetails, undefined, JSON.stringify(value.exceptionDetails));return value.result.value;
  };
  let tracing = false, complete!: () => void;
  const finished = new Promise<void>(resolve => { complete = resolve; });
  const unsubscribe = transport.trace(message => {
    if (message.method === 'Tracing.dataCollected') row.markers.push(...message.params.value.filter((event: any) => event.name === 'TimeStamp'));
    if (message.method === 'Tracing.tracingComplete') complete();
  });
  try {
    row.setup = await evaluate(WORKER_CANVAS_SETUP);assert.ok(verifyWorkerCanvasSetup(row.setup));
    await transport.send('Tracing.start', { categories: 'devtools.timeline,blink.console', transferMode: 'ReportEvents' });tracing = true;
    await evaluate('window.__MU_GPU_WORKER_JOB__=window.__MU_GPU_WORKER_WORK__(12000);void 0');
    const deadline = Date.now() + 15_000;
    while (!(await evaluate('Object.values(window.__MU_GPU_WORKER_PROGRESS__).length===3&&Object.values(window.__MU_GPU_WORKER_PROGRESS__).every(v=>v.frames>=2)'))) {
      assert.ok(Date.now() < deadline, 'Worker work did not begin');await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (let index = 0; index < 5; index++) {
      const before = await evaluate(`console.timeStamp('MU_GPU_CHECK_BEFORE:${index}');window.__MU_GPU_WORKER_PROGRESS__`);
      const security = inspect ? await inspect() : null;
      const gpu = (await transport.send('SystemInfo.getInfo')).gpu.auxAttributes;
      const after = await evaluate(`console.timeStamp('MU_GPU_CHECK_AFTER:${index}');window.__MU_GPU_WORKER_PROGRESS__`);
      row.samples.push({ before, after, security, gpu, at: new Date().toISOString() });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    row.completed = await evaluate('window.__MU_GPU_WORKER_JOB__');
    await transport.send('Tracing.end');tracing = false;
    await Promise.race([finished, new Promise((_, reject) => { const timer=setTimeout(()=>reject(Error('Worker trace timeout')),10_000);timer.unref(); })]);
    row.liveProtectionVerified = inspect ? verifyWorkerLiveProtection(row) : null;
    for (const offset of [0, .2]) {
      const replies = await evaluate(`window.__MU_GPU_WORKER_FRAME__(${offset})`);
      const screenshot = await transport.send('Page.captureScreenshot', { format: 'png' }, session), bytes = Buffer.from(screenshot.data, 'base64');
      const pixels = await evaluate(workerCanvasPixels(screenshot.data, Object.fromEntries(Object.entries(replies).map(([name, reply]: [string, any]) => [name, reply.bounds]))));
      const frame = { offset, replies, pixels, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
      row.frames.push(frame);await save(offset === 0 ? 'first' : 'moved', bytes);
    }
    row.canvasVerified = verifyWorkerCanvasFrames(row.frames);
    row.passed = row.canvasVerified && (!inspect || row.liveProtectionVerified);
  } catch (error) { row.error = (error as Error).stack; }
  finally {
    if (tracing) { await transport.send('Tracing.end').catch(() => {});await Promise.race([finished, new Promise(resolve => setTimeout(resolve, 1000))]); }
    unsubscribe();await evaluate('window.__MU_GPU_WORKER_CLEANUP__?.()').catch(error => { row.cleanupError = String(error);row.passed = false; });
  }
  return row;
}
