import assert from 'node:assert/strict';
import test from 'node:test';
import { DEVICE_LOSS_NAMES, verifyDeviceLossRecovery, verifyDeviceLossProtection } from '../scripts/webgpu-device-loss-fixture.ts';

function observation() {
  const kinds = ['Window', 'DedicatedWorkerGlobalScope', 'SharedWorkerGlobalScope', 'ServiceWorkerGlobalScope'];
  const uuid = (number: number) => `12345678-1234-1234-1234-${String(number).padStart(12, '0')}`;
  const frame = (i: number) => ({ hash: (i ? 'b' : 'a').repeat(64), green: 608, red: 3488, errors: [], lost: null });
  const presentation = { first: frame(0), repeated: frame(0), moved: frame(1) };
  const setup = Object.fromEntries(DEVICE_LOSS_NAMES.map((name, i) => [name, { kind: kinds[i], instance: uuid(i), deviceInstance: uuid(i + 10), lost: null, presentation }]));
  const lost = Object.fromEntries(DEVICE_LOSS_NAMES.map(name => [name, { ...setup[name], frames: 3, lost: { reason: 'unknown', message: 'GPU process crashed' } }]));
  const recovered = Object.fromEntries(DEVICE_LOSS_NAMES.map((name, i) => [name, { ...setup[name], deviceInstance: uuid(i + 20), previous: lost[name] }]));
  const frames = [0, .2].map((offset, i) => ({ offset,
    pixels: Object.fromEntries(DEVICE_LOSS_NAMES.map(name => [name, { green: 2432, red: 13952, pixels: 16384, hash: (i ? 'd' : 'c').repeat(64) }])),
    replies: Object.fromEntries(DEVICE_LOSS_NAMES.map(name => [name, { ...recovered[name], result: frame(i) }])) }));
  const status = { seccomp: 2, noNewPrivileges: 1, effectiveCapabilities: '0000000000000000' };
  const security = (gpuPid: number) => ({ developmentUid: 1000, processes: [
    { ...status, pid: gpuPid, role: 'gpu-process', uid: 1000, noSandboxFlag: false, threads: [{ ...status, tid: gpuPid, namespaceIds: [gpuPid] }] },
    ...DEVICE_LOSS_NAMES.map((_, i) => ({ ...status, pid: 300 + i, role: 'renderer', uid: 1000, noSandboxFlag: false, separatePidNamespace: true,
      threads: [{ ...status, tid: 300 + i, namespaceIds: [300 + i, 1] }, { ...status, tid: 400 + i, namespaceIds: [400 + i, 10 + i] }] })),
  ] });
  const gpu = { sandboxed: true, processCrashCount: 1 };
  const progress = (frames: number) => Object.fromEntries(DEVICE_LOSS_NAMES.map(name => [name, { ...recovered[name], frames }]));
  const markers: any[] = [
    { name: 'TimeStamp', ts: 100, args: { data: { message: 'MU_GPU_CHECK_BEFORE:0' } } },
    { name: 'TimeStamp', ts: 900, args: { data: { message: 'MU_GPU_CHECK_AFTER:4' } } },
    ...DEVICE_LOSS_NAMES.flatMap((name, i) => [200, 500].map(ts => ({ name: 'TimeStamp', ts, pid: 300 + i, tid: 10 + i,
      args: { data: { message: `MU_GPU_WORKER:${kinds[i]}:${setup[name].instance}:${ts}` } } }))),
  ];
  return { setup, recovered, lost, frames, markers, fault: { method: 'Browser.crashGpuProcess', completed: true },
    oldFrames: Object.fromEntries(DEVICE_LOSS_NAMES.map(name => [name, { ...lost[name], accepted: false, error: 'AbortError' }])),
    before: { gpu: { ...gpu, processCrashCount: 0 }, processes: [{ type: 'GPU', id: 100 }], security: security(100) },
    after: { gpu, processes: [{ type: 'GPU', id: 200 }], security: security(200) },
    samples: Array.from({ length: 5 }, (_, i) => ({ before: progress(i + 2), after: progress(i + 3), security: security(200), gpu, protection: { active: true, integrity: 'verified' } })),
    finished: progress(20) };
}

test('GPU recovery requires a real process change, unexpected native loss, unusable old devices and all four restored canvases', () => {
  assert.equal(verifyDeviceLossRecovery(observation()), true);
  for (const change of [
    (r: any) => { r.after.processes[0].id = 100; },
    (r: any) => { r.after.gpu.processCrashCount = 2; },
    (r: any) => { r.lost.shared.lost.reason = 'destroyed'; },
    (r: any) => { r.recovered.service.deviceInstance = r.setup.service.deviceInstance; },
    (r: any) => { r.recovered.dedicated.instance = r.setup.page.instance; },
    (r: any) => { r.oldFrames.page.accepted = true; },
    (r: any) => { r.frames[1].pixels.service.green = 0; },
  ]) { const row = observation();change(row);assert.equal(verifyDeviceLossRecovery(row), false); }
});

test('Recovery protection requires native samples and traced page/Worker threads on the new protected GPU process', () => {
  assert.equal(verifyDeviceLossProtection(observation()), true);
  for (const change of [
    (r: any) => { r.after.security.processes[0].threads[0].seccomp = 0; },
    (r: any) => { r.samples[2].gpu.processCrashCount = 2; },
    (r: any) => { r.samples[3].security.processes[0].pid = 100; },
    (r: any) => { r.samples[1].protection.active = false; },
    (r: any) => { r.markers = r.markers.filter((e: any) => !e.args.data.message.startsWith('MU_GPU_WORKER:Window:')); },
    (r: any) => { r.samples[4].after.page.frames = 2; },
  ]) { const row = observation();change(row);assert.equal(verifyDeviceLossProtection(row), false); }
});
