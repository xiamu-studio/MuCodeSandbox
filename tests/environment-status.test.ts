import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitVerified, freshReading, protectionVerified, windowsGuardSummaryVerified, jobRecovery } from '../src/environment-status.ts';
import type { Environment, EgressStatus, NetworkProtection, Job } from '../shared/types.ts';
import { WINDOWS_RESOURCE_ERRORS, WINDOWS_OLD_RESOURCE_DISK } from '../shared/windows-resource-errors.ts';

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
test('Windows summary requires a live lease and a recent non-future reading', () => {
  const protection = { active:true, integrity:'verified', leaseActive:true, leaseRemainingMs:30_000, checkedAt:at } as NetworkProtection;
  assert.equal(windowsGuardSummaryVerified(environment,protection,true,now),true);
  assert.equal(windowsGuardSummaryVerified(environment,{...protection,leaseActive:false},true,now),false);
  assert.equal(windowsGuardSummaryVerified(environment,{...protection,leaseRemainingMs:0},true,now),false);
  assert.equal(windowsGuardSummaryVerified(environment,{...protection,checkedAt:new Date(now+60_000).toISOString()},true,now),false);
  assert.equal(windowsGuardSummaryVerified(environment,protection,true,now+15_000),false);
  assert.equal(windowsGuardSummaryVerified(environment,protection,false,now),false);
});
test('failed destructive operations direct users to evidence, never a blind retry', () => {
  for (const action of ['delete', 'environment-rebuild']) {
    const guidance = jobRecovery({ status: 'failed', action } as Job);
    assert.equal(guidance?.destination, 'logs'); assert.match(guidance!.detail, /部分/);
  }
  assert.equal(jobRecovery({ status: 'succeeded', action: 'browser-update' } as Job), null);
  assert.equal(jobRecovery({ status: 'failed', action: 'browser-update' } as Job)?.destination, 'browser');
});

test('unconfirmed disk reclamation points to its maintenance controls', () => {
  for (const status of ['failed','cancelled'] as const) {
    const guidance=jobRecovery({status,action:'disk-compaction'} as Job);
    assert.equal(guidance?.destination,'settings');
    assert.match(guidance!.detail,/回收磁盘空间/);
    assert.match(guidance!.detail,/保留原磁盘/);
  }
  assert.equal(jobRecovery({status:'succeeded',action:'disk-compaction'} as Job),null);
});

test('backup failures direct users to backup status instead of snapshot history', () => {
  for (const action of ['backup-export','backup-review','backup-restore','backup-cleanup']) {
    const guidance=jobRecovery({status:'failed',action} as Job);
    assert.equal(guidance?.destination,'settings');
    assert.match(guidance!.detail,/加密备份窗口/);
  }
  assert.equal(jobRecovery({status:'failed',action:'snapshot-create'} as Job)?.destination,'snapshots');
});


test('Windows startup resource failures direct users to the real cause instead of network troubleshooting', () => {
  const failure = (message:string,action='start') => jobRecovery({status:'failed',action,message} as Job);
  for(const action of ['start','restart']) {
    const disk=failure(WINDOWS_RESOURCE_ERRORS.RESOURCE_DISK,action)!;assert.equal(disk.destination,'system');assert.match(disk.detail,/系统设置.*空间和预留/);assert.doesNotMatch(disk.label,/线路/);
    const quota=failure(WINDOWS_RESOURCE_ERRORS.RESOURCE_QUOTA,action)!;assert.equal(quota.destination,'system');assert.match(quota.detail,/虚拟磁盘配额/);
    assert.match(failure(WINDOWS_RESOURCE_ERRORS.RESOURCE_MEMORY,action)!.detail,/可用内存/);
    assert.match(failure(WINDOWS_RESOURCE_ERRORS.RESOURCE_BUSY,action)!.detail,/另一台虚拟机/);
    assert.match(failure(WINDOWS_RESOURCE_ERRORS.RESOURCE_FENCED,action)!.detail,/重新打开软件/);
    assert.equal(failure(WINDOWS_RESOURCE_ERRORS.DISK_GROWTH_PENDING,action)!.destination,'settings');
    assert.equal(failure(WINDOWS_RESOURCE_ERRORS.DISK_COMPACTION_PENDING,action)!.destination,'settings');
  }
  assert.equal(failure(WINDOWS_OLD_RESOURCE_DISK)!.destination,'system');
  assert.equal(failure('出口核验失败，联网保持关闭')!.destination,'network');
  assert.equal(jobRecovery({status:'cancelled',action:'start',message:WINDOWS_RESOURCE_ERRORS.RESOURCE_DISK} as Job)!.destination,'network');
});
