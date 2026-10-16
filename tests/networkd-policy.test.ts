import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { networkdBootFingerprint, NETWORKD_POLICY_SHA256 } from '../server/guest-networkd.ts';
import { GUARD_VERSION } from '../server/network-guard.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { environmentSchema } from '../server/validation.ts';
import type { Environment } from '../shared/types.ts';

test('Strict protection rejects a changed, missing or unsafe networkd policy without changing nft rules', async () => {
  const directory = await mkdtemp(path.join(homedir(), '.mu-networkd-policy-unit-'));
  const e: Environment = {
    ...environmentSchema.parse({ name: 'Networkd policy test', network: { mode: 'http', host: 'proxy.test', strict: true } }),
    id: randomUUID(), instanceName: 'mu-networkd-policy-test', state: 'running', lastError: null,
    browserRunning: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const firewallHash = 'a'.repeat(64);
  const firewallFileHash = 'b'.repeat(64);
  const actual = {
    prepared: true, bootArmed: true, active: true, firewallActive: true, transparentReady: false,
    transparentActive: false, proxyEndpoints: ['203.0.113.1:7890'], blockedPackets: 0,
    checkedAt: new Date().toISOString(), firewallHash,
    bootFileHash: networkdBootFingerprint(firewallFileHash), tunnelConfigHash: '', routingReady: false, dnsGuardActive: false,
    leasePrepared:true,leaseActive:true,leaseRemainingMs:40_000,leaseRulesHash:'lease-rules',leaseBootHash:'lease-boot',
  };
  const runtime = new LimaRuntime(directory, async () => JSON.stringify(actual));
  runtime.executable = async () => '/test/limactl';
  try {
    await mkdir(path.join(directory, 'security'));
    const marker = path.join(directory, 'security', `${e.instanceName}.json`);
    const writeMarker = (bootFileHash: string) => writeFile(marker, JSON.stringify({
      version: GUARD_VERSION, prepared: true, bootArmed: true, conservative: false, expectedHash: firewallHash, bootFileHash,
      expectedLeaseHash:'lease-rules',leaseBootHash:'lease-boot',
    }));
    await writeMarker(networkdBootFingerprint(firewallFileHash));
    const healthy = await runtime.networkProtection(e);
    assert.equal(healthy.active, true); assert.equal(healthy.integrity, 'verified');
    for (const policyHash of ['c'.repeat(64), '']) {
      actual.bootFileHash = createHash('sha256').update(JSON.stringify([firewallFileHash, policyHash])).digest('hex');
      const changed = await runtime.networkProtection(e);
      assert.equal(changed.firewallActive, true); assert.equal(changed.firewallHash, firewallHash);
      assert.equal(changed.active, false); assert.equal(changed.integrity, 'changed');
      assert.ok(changed.issues?.some(issue => issue.includes('开机网络策略')));
    }
    actual.bootFileHash = networkdBootFingerprint(firewallFileHash);
    await writeMarker(firewallFileHash);
    assert.equal((await runtime.networkProtection(e)).active, false, 'Old nft-only fingerprints require protected migration');
    assert.notEqual(NETWORKD_POLICY_SHA256, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
