import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { environmentSchema } from '../server/validation.ts';
import { firewallRules, guestEnvironment } from '../server/network-guard.ts';
import { Store } from '../server/store.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { transparentConfig } from '../server/transparent-network.ts';
import { buildLimaConfig } from '../server/lima-config.ts';
import { parse as parseYaml } from 'yaml';
import type { Environment } from '../shared/types.ts';

const environment = (): Environment => ({ ...environmentSchema.parse({ name: 'Security test' }), id: randomUUID(), instanceName: 'mu-security-test', state: 'stopped', lastError: null, browserRunning: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

test('Strict networking rejects direct mode, external bypasses and host browser scope', () => {
  assert.throws(() => environmentSchema.parse({ name: 'X', network: { mode: 'direct', strict: true } }));
  assert.throws(() => environmentSchema.parse({ name: 'X', network: { mode: 'http', host: 'proxy.test', strict: true, noProxy: '*' } }));
  assert.throws(() => environmentSchema.parse({ name: 'X', kind: 'browser', network: { mode: 'http', host: 'proxy.test', strict: true } }));
  assert.equal(environmentSchema.parse({ name: 'X', network: { mode: 'http', host: 'proxy.test', strict: true, noProxy: 'localhost,127.0.0.1,::1' } }).network.strict, true);
});

test('Transparent mode requires the guest firewall and never configures a direct fallback', () => {
  assert.throws(() => environmentSchema.parse({ name: 'X', network: { mode: 'http', host: 'proxy.test', transparent: true } }));
  const e = environment(); e.network = { ...e.network, mode: 'http', host: 'proxy.test', strict: true, transparent: true };
  const config = transparentConfig(e, '203.0.113.4', 999, ['192.168.5.0/24']);
  assert.deepEqual(config.outbounds.map(o => o.type), ['http']);
  assert.equal(config.inbounds[0].stack, 'system');
  assert.equal(config.dns.servers[0].detour, 'upstream');
  assert.equal(config.route.final, 'upstream');
  assert.deepEqual(config.inbounds[0].exclude_uid, [999]);
  assert.deepEqual(config.inbounds[0].route_exclude_address, ['192.168.5.0/24', '203.0.113.4/32']);
  assert.throws(() => transparentConfig(e, '203.0.113.4', 0, []));
  assert.throws(() => transparentConfig(e, '203.0.113.4', 999, ['999.1.1.1/33']));
  assert.match(guestEnvironment(e, 'http://proxy.test:7890'), /HTTP_PROXY=''/);
  assert.deepEqual(parseYaml(buildLimaConfig(e)).env, {}, 'Lima must not put application proxies into PAM environment in transparent mode');
  e.network.mode = 'socks5';
  assert.equal(transparentConfig(e, '203.0.113.4', 999, []).outbounds[0].type, 'socks');
  e.network.dns = { address: '9.9.9.9', serverName: 'dns.quad9.net', port: 443, path: '/dns-query' };
  const custom = transparentConfig(e, '203.0.113.4', 999, []).dns.servers[0];
  assert.equal(custom.server, '9.9.9.9'); assert.equal(custom.detour, 'upstream');
  assert.equal(custom.tls.server_name, 'dns.quad9.net');
  assert.throws(() => environmentSchema.parse({ name: 'X', network: { mode: 'direct', dns: { address: '999.1.1.1', serverName: 'unsafe\n.test' } } }));
});

test('Only the tunnel service may connect directly to the upstream proxy', () => {
  const rules = firewallRules(['203.0.113.4'], 8080, [], '192.168.5.2', 999);
  assert.match(rules, /meta skuid 999 ip daddr \{ 203\.0\.113\.4 \} tcp dport 8080 accept/);
  assert.match(rules, /oifname "mu_tun" meta nfproto ipv4 meta l4proto tcp accept/);
  assert.match(rules, /oifname "mu_tun" meta nfproto ipv4 udp dport 53 accept/);
  assert.throws(() => firewallRules([], 8080, [], '192.168.5.2', 0));
});

test('Timezone validation canonicalizes aliases and rejects paths and invalid zones', () => {
  assert.equal(environmentSchema.parse({ name: 'X', identity: { timezone: 'us/eastern', locale: 'en-US' } }).identity.timezone, 'America/New_York');
  for (const timezone of ['../etc/passwd', 'Invalid/Zone', 'UTC;echo test']) assert.throws(() => environmentSchema.parse({ name: 'X', identity: { timezone, locale: 'en-US' } }));
});

test('Firewall validates addresses and restricts established traffic to replies on explicit service ports', () => {
  const rules = firewallRules(['203.0.113.4'], 8080, [3000], '192.168.5.2');
  assert.equal((rules.match(/policy drop/g) ?? []).length, 2);
  assert.match(rules, /ip daddr \{ 203\.0\.113\.4 \} tcp dport 8080 accept/);
  assert.match(rules, /meta skuid 0 ip daddr 192\.168\.5\.2 tcp sport 22 accept/);
  assert.match(rules, /tcp sport \{ 3000 \} ct state established ct direction reply accept/);
  assert.doesNotMatch(rules, /ct state (?:established|related) accept/);
  assert.doesNotMatch(rules, /dport (?:53|443|80) accept/);
  assert.throws(() => firewallRules(['1.2.3.4; accept'], 8080, [], '192.168.5.2'));
  assert.throws(() => firewallRules([], 8080, [0], '192.168.5.2'));
  assert.match(firewallRules([], 8080, [], '192.168.5.2', undefined, 998), /meta skuid \{ 0, 998 \}.*udp sport 68 udp dport 67 accept/);
  assert.throws(() => firewallRules([], 8080, [], '192.168.5.2', undefined, -1));
});

test('Strict guest commands read the pinned proxy from a private guest file', () => {
  const e = environment(); e.network = { ...e.network, mode: 'http', host: 'proxy.test', password: 'test-secret', strict: true };
  const args = new LimaRuntime('/tmp/unused').guestArgs(e, ['bash', '-l'], '/workspace/project');
  assert.equal(args[2], '/workspace/project');
  assert.ok(args.includes('/usr/local/bin/mu-proxy-run'));
  assert.ok(!args.join(' ').includes('test-secret'));
  assert.ok(!args.join(' ').includes('HTTP_PROXY='));
  assert.match(guestEnvironment(e, 'http://203.0.113.4:8080'), /NO_PROXY='localhost,127\.0\.0\.1,::1'/);
});

test('Old persisted environments receive compatible defaults without losing saved identity', async () => {
  const root = await mkdtemp(path.join(homedir(), '.mu-security-unit-'));
  const store = new Store(root);
  try {
    const e = environment(); store.save(e);
    const raw = store.db.prepare('SELECT config FROM environments WHERE id = ?').get(e.id) as { config: string };
    const legacy = JSON.parse(raw.config); delete legacy.identity; delete legacy.network.strict;
    store.db.prepare('UPDATE environments SET config = ? WHERE id = ?').run(JSON.stringify(legacy), e.id);
    assert.equal(store.get(e.id).network.strict, false);
    assert.ok(store.get(e.id).identity.timezone);
    const next = store.get(e.id); next.identity = { timezone: 'Asia/Tokyo', locale: 'ja-JP' }; store.save(next);
    assert.deepEqual(store.get(e.id).identity, next.identity);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('Existing VMs cannot enable strict mode before boot protection is prepared', async () => {
  const root = await mkdtemp(path.join(homedir(), '.mu-security-unit-'));
  const runtime = new LimaRuntime(root);
  runtime.list = async () => [{ name: 'mu-security-test', status: 'Stopped' }];
  const e = environment(); e.network = { ...e.network, mode: 'http', host: 'proxy.test', strict: true };
  try { await assert.rejects(runtime.updateConfig(e), /准备防护并停止/); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('Strict configuration cannot change while an old proxy remains in the persisted boot rules', async () => {
  const root = await mkdtemp(path.join(homedir(), '.mu-security-unit-'));
  const runtime = new LimaRuntime(root);
  runtime.list = async () => [{ name: 'mu-security-test', status: 'Stopped' }];
  const e = environment(); e.network = { ...e.network, mode: 'http', host: 'proxy.test', strict: true };
  try {
    await mkdir(path.join(root, 'security'));
    await writeFile(path.join(root, 'security', `${e.instanceName}.json`), JSON.stringify({ version: 1, prepared: true, bootArmed: true, conservative: false }));
    await assert.rejects(runtime.updateConfig(e), /旧代理端点/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
