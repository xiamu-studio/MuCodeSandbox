import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitVerified, freshReading, protectionVerified, jobRecovery } from '../src/environment-status.ts';
import type { Environment, EgressStatus, NetworkProtection, Job } from '../shared/types.ts';

const now = Date.now(), at = new Date(now).toISOString();
const environment = { kind: 'vm', state: 'running', network: { strict: true, egressLock: { expectedIp: '203.0.113.8' } } } as Environment;
const egress: EgressStatus = { status: 'verified', expectedIp: '203.0.113.8', actualIp: '203.0.113.8', checkedAt: at,
  verification: { requiredReceivers: 2, timedOutReceivers: [], receipts: [
    { receiver: 'ipwho', ip: '203.0.113.8', latencyMs: 100 }, { receiver: 'ipify', ip: '203.0.113.8', latencyMs: 110 },
  ] } };
test('overview requires fresh independent matching receipts and current approved IP', () => {
  assert.equal(exitVerified(environment, egress, now), true);
  for (const receipts of [egress.verification!.receipts.slice(0, 1), [egress.verification!.receipts[0], egress.verification!.receipts[0]], [egress.verification!.receipts[0], { ...egress.verification!.receipts[1], ip: '203.0.113.9' }]]) {
    assert.equal(exitVerified(environment, { ...egress, verification: { ...egress.verification!, receipts } }, now), false);
  }
  assert.equal(exitVerified(environment, egress, now + 45_000), false);
  assert.equal(exitVerified({ ...environment, state: 'stopped' }, egress, now), false);
  assert.equal(exitVerified({ ...environment, network: { ...environment.network, egressLock: { expectedIp: '203.0.113.9' } } }, egress, now), false);
});
test('protection status expires when the observed lease runs out or a reading is invalid', () => {
  const protection = { active: true, integrity: 'verified', leaseActive: true, leaseRemainingMs: 12_000, checkedAt: at } as NetworkProtection;
  assert.equal(protectionVerified(environment, protection, now), true);
  assert.equal(protectionVerified(environment, protection, now + 12_000), false);
  assert.equal(protectionVerified(environment, { ...protection, leaseActive: false }, now), false);
  assert.equal(protectionVerified(environment, { ...protection, leaseRemainingMs: undefined }, now), false);
  assert.equal(freshReading('invalid', now), false);
  assert.equal(freshReading(new Date(now + 60_000).toISOString(), now), false);
});
test('failed destructive operations direct users to evidence, never a blind retry', () => {
  for (const action of ['delete', 'environment-rebuild']) {
    const guidance = jobRecovery({ status: 'failed', action } as Job);
    assert.equal(guidance?.destination, 'logs'); assert.match(guidance!.detail, /部分/);
  }
  assert.equal(jobRecovery({ status: 'succeeded', action: 'browser-update' } as Job), null);
  assert.equal(jobRecovery({ status: 'failed', action: 'browser-update' } as Job)?.destination, 'browser');
});
