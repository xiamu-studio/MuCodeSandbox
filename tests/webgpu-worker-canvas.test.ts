import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyWorkerCanvasFrames, verifyWorkerLiveProtection } from '../scripts/browser-webgpu-worker-canvas-fixture.ts';

function live() {
  const names = ['dedicated', 'shared', 'service'], kinds = ['DedicatedWorkerGlobalScope', 'SharedWorkerGlobalScope', 'ServiceWorkerGlobalScope'];
  const setup = Object.fromEntries(names.map((name, i) => [name, { kind: kinds[i], instance: `12345678-1234-1234-1234-123456789ab${i}` }]));
  const markers: any[] = [{ name: 'TimeStamp', pid: 999, tid: 999, ts: 100, args: { data: { message: 'MU_GPU_CHECK_BEFORE:0' } } },
    { name: 'TimeStamp', pid: 999, tid: 999, ts: 900, args: { data: { message: 'MU_GPU_CHECK_AFTER:4' } } }];
  for (let i = 0; i < names.length; i++) for (const ts of [200, 500]) markers.push({ name: 'TimeStamp', pid: 300 + i, tid: 400 + i, ts,
    args: { data: { message: `MU_GPU_WORKER:${kinds[i]}:${setup[names[i]].instance}:${ts}` } } });
  const status = { seccomp: 2, noNewPrivileges: 1, effectiveCapabilities: '0000000000000000' };
  const progress = (frames: number) => Object.fromEntries(names.map(name => [name, { ...setup[name], frames }]));
  const samples = Array.from({ length: 5 }, (_, index) => ({ before: progress(index + 2), after: progress(index + 3),
    gpu: { sandboxed: true, processCrashCount: 0 }, security: { developmentUid: 1000,
      processes: [0, 1, 2].map(i => ({ ...status, pid: 300 + i, role: 'renderer', uid: 1000, noSandboxFlag: false, separatePidNamespace: true,
        threads: [{ ...status, tid: 300 + i }, { ...status, tid: 400 + i }] })) } }));
  return { setup, markers, samples, completed: Object.fromEntries(names.map(name => [name, { result: { frames: 10 } }])) };
}

test('Active Worker proof requires real traced PID/TID matches and healthy native thread samples', () => {
  assert.equal(verifyWorkerLiveProtection(live()), true);
  assert.equal(verifyWorkerLiveProtection(undefined), false);
  const wrongThread = live();wrongThread.markers[2].tid = 777;wrongThread.markers[3].tid = 777;
  assert.equal(verifyWorkerLiveProtection(wrongThread), false);
  const wrongProcess = live();wrongProcess.markers[2].pid = 999;wrongProcess.markers[3].pid = 999;
  assert.equal(verifyWorkerLiveProtection(wrongProcess), false);
  const unprotected = live();unprotected.samples[2].security.processes[1].threads[1].seccomp = 0;
  assert.equal(verifyWorkerLiveProtection(unprotected), false);
  const frozen = live();frozen.samples[4].after.dedicated.frames = frozen.samples[0].before.dedicated.frames;
  assert.equal(verifyWorkerLiveProtection(frozen), false);
  const afterExecution = live();afterExecution.markers[1].ts = 150;
  assert.equal(verifyWorkerLiveProtection(afterExecution), false);
});

test('Worker canvas proof rejects a blank canvas, a single unmoving region and device loss', () => {
  const frames = [0, .2].map((offset, i) => ({ offset,
    pixels: Object.fromEntries(['dedicated', 'shared', 'service'].map(name => [name, { green: 2432, red: 13952, pixels: 16384, hash: (i ? 'b' : 'a').repeat(64) }])),
    replies: Object.fromEntries(['dedicated', 'shared', 'service'].map(name => [name, { result: { green: 608, hash: (i ? 'd' : 'c').repeat(64), errors: [], lost: null } }])) }));
  assert.equal(verifyWorkerCanvasFrames(frames), true);
  const blank = structuredClone(frames);blank[0].pixels.service.green = 0;
  assert.equal(verifyWorkerCanvasFrames(blank), false);
  const unmoving = structuredClone(frames);unmoving[1].pixels.shared.hash = unmoving[0].pixels.shared.hash;
  assert.equal(verifyWorkerCanvasFrames(unmoving), false);
  const lost = structuredClone(frames);Object.assign(lost[1].replies.dedicated.result, { lost: { reason: 'unknown' } });
  assert.equal(verifyWorkerCanvasFrames(lost), false);
});

test('Namespace thread IDs require actual kernel namespace mappings and cannot match an unrelated thread', () => {
  const value = live();
  for (const sample of value.samples) for (const p of sample.security.processes) for (const t of p.threads)
    Object.assign(t, { namespaceIds: [t.tid, t.tid - 390] });
  for (const marker of value.markers.slice(2)) marker.tid -= 390;
  assert.equal(verifyWorkerLiveProtection(value), true);
  const forgedRoot = structuredClone(value);
  Object.assign(forgedRoot.samples[2].security.processes[0].threads[1], { namespaceIds: [888, 10] });
  assert.equal(verifyWorkerLiveProtection(forgedRoot), false);
  const unrelated = structuredClone(value);unrelated.markers[2].tid = 900;unrelated.markers[3].tid = 900;
  assert.equal(verifyWorkerLiveProtection(unrelated), false);
  const missing = structuredClone(value);Object.assign(missing.samples[2].security.processes[0].threads[1], { namespaceIds: [] });
  assert.equal(verifyWorkerLiveProtection(missing), false);
});
