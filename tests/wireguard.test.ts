import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { wireguardSchema, wireguardSetconf, wireguardPublicKey, WIREGUARD_MARK } from '../server/wireguard.ts';
import { networkSchema, proxyUrl, environmentSchema, redact } from '../server/validation.ts';
import { wireguardFiles, wireguardDnsConfig, startWireguardScript, WG_SECRET_PATH, WG_HELPER_PATH, INSPECT_WIREGUARD_PYTHON } from '../server/wireguard-network.ts';
import { firewallRules } from '../server/network-guard.ts';
import { leaseRules } from '../server/guest-lease.ts';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { editConfig } from '../src/api.ts';
import { buildLimaConfig } from '../server/lima-config.ts';

const valid = () => ({ address: '10.77.0.2/32', privateKey: randomBytes(32).toString('base64'), peerPublicKey: randomBytes(32).toString('base64'), endpoint: { address: '192.0.2.1', port: 51820 } });

test('Packet tunnel input rejects configuration injection and unsupported routing', () => {
  for (const change of [
    { privateKey: valid().privateKey + '\nPostUp=touch /tmp/unsafe' },
    { peerPublicKey: Buffer.alloc(32).toString('base64') },
    { privateKey: 'not-a-key' },
    { endpoint: { address: 'proxy.example.com', port: 51820 } },
    { endpoint: { address: '127.0.0.1', port: 51820 } },
    { endpoint: { address: '224.0.0.1', port: 51820 } },
    { address: '10.77.0.2/24' }, { address: '2001:db8::2/128' },
    { endpoint: { address: '10.77.0.2', port: 51820 } },
    { allowedIPs: ['192.0.2.0/24'] }, { postUp: 'true' },
    { mtu: 9000 }, { listenPort: 0 },
  ]) assert.equal(wireguardSchema.safeParse({ ...valid(), ...change }).success, false, JSON.stringify(change));
  const config = wireguardSchema.parse(valid());
  assert.equal(config.mtu, 1420);
  assert.equal(config.listenPort, 51821);
  assert.match(wireguardSetconf(config), /^\[Interface\]\nPrivateKey = [A-Za-z0-9+/]+=\n/);
});

const network = () => {
  const { endpoint, ...wireguard } = wireguardSchema.parse(valid());
  return { mode: 'wireguard' as const, host: endpoint.address, port: endpoint.port, wireguard, strict: true, transparent: true, username: '', noProxy: '' };
};

test('Packet mode rejects unsafe combinations and never emits connection proxy URLs', () => {
  const n = network();
  assert.equal(proxyUrl(networkSchema.parse(n)), '');
  for (const change of [{ strict: false }, { transparent: false }, { host: 'localhost' }, { host: '10.77.0.2' }, { username: 'user' }, { password: 'secret' }, { tls: { serverName: 'example.com' } }, { wireguard: undefined }]) assert.equal(networkSchema.safeParse({ ...n,...change }).success,false);
  assert.equal(environmentSchema.safeParse({ name:'X',kind:'browser',network:n }).success,false);
  assert.equal(networkSchema.safeParse({ ...n,mode:'http' }).success,false);
  const pair = generateKeyPairSync('x25519');
  const secret = pair.privateKey.export({ format:'der',type:'pkcs8' }).subarray(-32).toString('base64');
  assert.equal(wireguardPublicKey(secret),pair.publicKey.export({ format:'der',type:'spki' }).subarray(-32).toString('base64'));
});

test('Packet credentials survive encrypted storage and editing without appearing in public data or Lima files', async () => {
  const temporary = await mkdtemp(path.join(homedir(),'.mu-wg-key-test-'));
  const manager = new Manager(temporary,undefined,new LimaRuntime(temporary,async () => ''));
  try {
    const n = network(), key = n.wireguard.privateKey;
    await assert.rejects(manager.create({ name:'Missing',network:{...n,wireguard:{...n.wireguard,privateKey:undefined}} }),/私钥/);
    const e = await manager.create({ name:'WG',network:n,memoryGiB:2 });
    assert.equal(e.network.wireguard?.privateKey,undefined);
    assert.equal(e.network.wireguard?.privateKeyConfigured,true);
    assert.equal(manager.store.get(e.id).network.wireguard?.privateKey,key);
    const raw = manager.store.db.prepare('SELECT config FROM environments WHERE id=?').get(e.id) as { config:string };
    assert.ok(!raw.config.includes(key));
    assert.match(raw.config,/enc:/);
    const updated = await manager.update(e.id,{ ...editConfig(e),name:'Edited' });
    assert.equal(updated.name,'Edited');
    assert.equal(manager.store.get(e.id).network.wireguard?.privateKey,key);
    const ownConfig = buildLimaConfig(manager.store.get(e.id));
    assert.ok(!ownConfig.includes(key));
    const replacement = valid().privateKey;
    await manager.update(e.id,{ ...editConfig(updated),network:{...editConfig(updated).network,wireguard:{...editConfig(updated).network.wireguard,privateKey:replacement}} });
    assert.equal(manager.store.get(e.id).network.wireguard?.privateKey,replacement);
    for (const value of [`PrivateKey = ${key}`,JSON.stringify({privateKey:key}),`private_key=${key}`]) assert.ok(!redact(value).includes(key));
  } finally { await manager.close(); await rm(temporary,{recursive:true,force:true}); }
});

test('Packet firewall and lease allow only marked peer transport and do not exempt the DNS service', () => {
  const c = wireguardSchema.parse(valid());
  const firewall = firewallRules([],c.endpoint.port,[],'192.168.5.2',undefined,101,c);
  assert.match(firewall,/oifname "mu_wg" meta nfproto ipv4 meta l4proto tcp tcp dport != 53 accept/);
  assert.match(firewall,new RegExp(`meta mark ${WIREGUARD_MARK} ip daddr 192\\.0\\.2\\.1 udp sport 51821 udp dport 51820 accept`));
  assert.ok(!firewall.includes('udp dport 53 accept'));
  assert.throws(()=>firewallRules(['192.0.2.1'],51820,[],'192.168.5.2',undefined,101,c));
  const lease = leaseRules('192.168.5.2',101,998,undefined,c);
  assert.match(lease,/meta skuid 998 oifname "mu_wg"/);
  assert.ok(!lease.includes('meta skuid 999'));
  assert.throws(()=>leaseRules('192.168.5.2',101,998,999,c));
  assert.throws(()=>leaseRules('192.168.5.2',101,998,undefined,{...c,endpoint:{address:'1.1.1.1;accept',port:51820}}));
});

test('Packet lifecycle uses root-only stdin secrets and a DNS-only service with no TCP proxy', async () => {
  const temporary = await mkdtemp(path.join(homedir(),'.mu-wg-files-test-'));
  const manager = new Manager(temporary);
  try {
    const publicEnvironment = await manager.create({name:'WG',network:network(),memoryGiB:2});
    const e = manager.store.get(publicEnvironment.id), files = wireguardFiles(e), dns = wireguardDnsConfig(e);
    assert.ok(files[WG_SECRET_PATH].includes(e.network.wireguard!.privateKey!));
    assert.ok(!JSON.stringify(dns).includes(e.network.wireguard!.privateKey!));
    assert.equal(dns.inbounds[0].type,'direct');
    assert.equal(dns.outbounds[0].bind_interface,'mu_wg');
    assert.match(files[WG_HELPER_PATH],/routing priorities are already in use/);
    const script = startWireguardScript(e);
    assert.ok(script.indexOf('install -o root -g root -m 0600 /dev/null /etc/mucodesandbox/wireguard.conf.next') < script.indexOf('PrivateKey ='));
    assert.ok(!INSPECT_WIREGUARD_PYTHON.includes("wg('private-key')"));
    assert.ok(!INSPECT_WIREGUARD_PYTHON.includes("wg('dump')"));
  } finally { await manager.close(); await rm(temporary,{recursive:true,force:true}); }
});
