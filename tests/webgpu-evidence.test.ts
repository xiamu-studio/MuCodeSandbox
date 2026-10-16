import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyWebGPUContexts, verifyWebGPUPresentation } from '../scripts/browser-webgpu-fixture.ts';
import { verifyWebGPUAllContexts } from '../scripts/browser-webgpu-contexts-fixture.ts';

const fixture = () => {
  const frame = { hash: 'a'.repeat(64), green: 968, red: 3128 };
  const context = { supported: true, secureContext: true, apiAvailable: true, adapterAvailable: true,
    adapter: { vendor: 'google', architecture: 'swiftshader', device: '', description: '', isFallbackAdapter: true }, features: ['timestamp-query', 'depth-clip-control'],
    compute: { verified: true, input: [1, 2, 3, 4, 5, 6, 7, 8], output: [10, 13, 16, 19, 22, 25, 28, 31] }, render: { verified: true, first: frame, repeated: { ...frame }, changed: { hash: 'b'.repeat(64), green: 0, red: 4096 } }, errors: [], unexpectedLoss: null };
  return { page: context, worker: { result: structuredClone(context) } };
};

test('WebGPU evidence requires raw computation and pixel controls in both contexts', () => {
  assert.equal(verifyWebGPUContexts(fixture()), true);
  const incorrect = fixture(); incorrect.worker.result.compute.output[0] = 11;
  assert.equal(verifyWebGPUContexts(incorrect), false);
  const blank = fixture(); blank.page.render.first.green = 0;
  assert.equal(verifyWebGPUContexts(blank), false);
  const unchanged = fixture(); unchanged.worker.result.render.changed.hash = unchanged.worker.result.render.first.hash;
  assert.equal(verifyWebGPUContexts(unchanged), false);
});

test('WebGPU evidence rejects unavailable adapters, errors and device loss', () => {
  assert.equal(verifyWebGPUContexts(undefined), false);
  const unavailable = fixture(); unavailable.page.adapterAvailable = false;
  assert.equal(verifyWebGPUContexts(unavailable), false);
  const errors = fixture(); (errors.worker.result.errors as string[]).push('validation error');
  assert.equal(verifyWebGPUContexts(errors), false);
  const lost = fixture(); Object.assign(lost.page, { unexpectedLoss: { reason: 'unknown', message: 'lost' } });
  assert.equal(verifyWebGPUContexts(lost), false);
});

test('WebGPU evidence rejects page and Worker adapter or capability disagreement', () => {
  const differentAdapter = fixture(); differentAdapter.worker.result.adapter.architecture = 'metal';
  assert.equal(verifyWebGPUContexts(differentAdapter), false);
  const differentFallback = fixture(); differentFallback.worker.result.adapter.isFallbackAdapter = false;
  assert.equal(verifyWebGPUContexts(differentFallback), false);
  const differentFeatures = fixture(); differentFeatures.worker.result.features.pop();
  assert.equal(verifyWebGPUContexts(differentFeatures), false);
  const reordered = fixture(); reordered.worker.result.features.reverse();
  assert.equal(verifyWebGPUContexts(reordered), true);
  const missing = fixture(); Object.assign(missing.page, { adapter: undefined });
  assert.equal(verifyWebGPUContexts(missing), false);
});

test('WebGPU presentation requires actual changing pixels and no device errors', () => {
  const frame = { hash: 'a'.repeat(64), green: 608, red: 3488, errors: [], lost: null };
  const value = { first: frame, repeated: { ...frame }, moved: { ...frame, hash: 'b'.repeat(64) } };
  assert.equal(verifyWebGPUPresentation(value), true);
  assert.equal(verifyWebGPUPresentation(undefined), false);
  assert.equal(verifyWebGPUPresentation({ ...value, moved: frame }), false);
  assert.equal(verifyWebGPUPresentation({ ...value, first: { ...frame, green: 0 } }), false);
  assert.equal(verifyWebGPUPresentation({ ...value, first: { ...frame, lost: { reason: 'unknown' } } }), false);
  assert.equal(verifyWebGPUPresentation({ ...value, first: { ...frame, errors: ['validation'] } }), false);
});

test('All Worker evidence rejects missing contexts, mixed devices, wrong results and unshared instances', () => {
  const base = fixture(), instance = '12345678-1234-1234-1234-123456789abc';
  const value = { page: base.page, worker: { ...base.worker, kind: 'DedicatedWorkerGlobalScope', instance },
    shared: { result: structuredClone(base.page), kind: 'SharedWorkerGlobalScope', instance },
    sharedSecond: { result: structuredClone(base.page), kind: 'SharedWorkerGlobalScope', instance },
    service: { result: structuredClone(base.page), kind: 'ServiceWorkerGlobalScope', instance } };
  assert.equal(verifyWebGPUAllContexts(value), true);
  assert.equal(verifyWebGPUAllContexts(undefined), false);
  assert.equal(verifyWebGPUAllContexts({ ...value, service: undefined }), false);
  const unshared = structuredClone(value); unshared.sharedSecond.instance = '87654321-1234-1234-1234-123456789abc';
  assert.equal(verifyWebGPUAllContexts(unshared), false);
  const mixed = structuredClone(value); mixed.service.result.adapter.architecture = 'metal';
  assert.equal(verifyWebGPUAllContexts(mixed), false);
  const wrong = structuredClone(value); wrong.shared.result.compute.output[0] = 99;
  assert.equal(verifyWebGPUAllContexts(wrong), false);
  const missingAdapter = structuredClone(value); missingAdapter.service.result.adapterAvailable = false;
  assert.equal(verifyWebGPUAllContexts(missingAdapter), false);
  const mislabeled = structuredClone(value); mislabeled.service.kind = 'DedicatedWorkerGlobalScope';
  assert.equal(verifyWebGPUAllContexts(mislabeled), false);
});
