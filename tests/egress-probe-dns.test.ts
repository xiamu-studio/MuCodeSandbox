import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { measureEgress, EGRESS_URL, EGRESS_RECEIVERS } from '../server/egress.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { environmentSchema } from '../server/validation.ts';
import { transparentConfig } from '../server/transparent-network.ts';
import type { Environment } from '../shared/types.ts';

const fakeReceipt = JSON.stringify({ success: true, ip: '8.8.8.8', country: 'Fixture' });
const fakeOutput=(args:string[])=>args.at(-1)===EGRESS_RECEIVERS[2].url?'8.8.8.8\n':fakeReceipt;
const environment = (): Environment => ({
  ...environmentSchema.parse({ name: 'DNS probe fixture', network: { mode: 'http', host: 'proxy.test', port: 42123, strict: true, transparent: true, egressLock: { expectedIp: '8.8.8.8' } } }),
  id: 'probe-fixture', instanceName: 'mu-probe-fixture', state: 'running', lastError: null,
  browserRunning: false, createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z',
});
const ports = (runtime: LimaRuntime): Map<string, number> => (runtime as unknown as { probePorts: Map<string, number> }).probePorts;
const fakeTransport = (state: { killed: boolean; exitCode: number | null; signalCode: string | null } = { killed: false, exitCode: null, signalCode: null }) => ({
  port: 42123, targetIP: '127.0.0.1', targetPort: 7890, child: state,
});
function captureRuntime(proxy: string) {
  const calls: { args: string[]; options: unknown }[] = [];
  const runtime = { egressProbeProxy: () => proxy, management: async (_e: Environment, args: string[], options: unknown) => { calls.push({ args, options }); return fakeOutput(args); } } as unknown as LimaRuntime;
  return { runtime, calls };
}

 test('the no-proxy measurement retains explicit TLS, CA verification, fixed DoH and finite timeouts', async () => {
  const { runtime, calls } = captureRuntime('');
  const e = environment(); e.network.egressLock = undefined;
  e.network.dns = { address: '9.9.9.9', serverName: 'dns.quad9.net', port: 443, path: '/dns-query' };
  assert.equal((await measureEgress(runtime, e)).ip, '8.8.8.8');
  assert.equal(calls.length, 3); const command = calls[0].args;
  assert.deepEqual(command.slice(0, 10), ['/usr/bin/sudo', '-H', '-u', 'mu-probe', '--', 'env', '-i', 'PATH=/usr/bin:/bin', '/usr/bin/curl', '-q']);
  for (const [flag, value] of [['--proxy', ''], ['--noproxy', '*'], ['--proto', '=https'], ['--cacert', '/etc/ssl/certs/ca-certificates.crt'], ['--doh-url', 'https://dns.quad9.net:443/dns-query'], ['--resolve', 'dns.quad9.net:443:9.9.9.9'], ['--connect-timeout', '4'], ['--max-time', '12']]) {
    assert.equal(command[command.indexOf(flag) + 1], value);
  }
  assert.ok(command.includes('--tlsv1.2') && command.includes('--ipv4'));
  assert.ok(!command.includes('--insecure') && !command.includes('--doh-insecure'));
  assert.equal(command.at(-1), EGRESS_URL);
  assert.equal((calls[0].options as { timeoutMs: number }).timeoutMs, 24_000);
});

test('locked transparent environments reject an absent probe channel before issuing any guest command', async () => {
  const runtime = new LimaRuntime('/unused-probe-fixture'); let commands = 0;
  runtime.management = async () => { commands++; return fakeReceipt; };
  await assert.rejects(measureEgress(runtime, environment()), { code: 'PROXY_TRANSPORT_CLOSED' });
  assert.equal(commands, 0, 'Missing probe must never turn into a no-proxy business-network attempt');
});

test('missing, stopped, killed or signalled owning transports fail before any probe or DNS command', async () => {
  const e = environment();
  for (const state of [undefined, { killed: true, exitCode: null, signalCode: null }, { killed: false, exitCode: 0, signalCode: null }, { killed: false, exitCode: null, signalCode: 'SIGTERM' }]) {
    const runtime = new LimaRuntime('/unused-probe-fixture'); ports(runtime).set(e.id, 42125);
    let commands = 0; runtime.management = async () => { commands++; return fakeReceipt; };
    if (state) runtime.proxyTransports.entries.set(e.id, fakeTransport(state) as any);
    await assert.rejects(measureEgress(runtime, e), { code: 'PROXY_TRANSPORT_CLOSED' });
    assert.equal(commands, 0);
  }
});

test('a live probe uses remote hostname resolution, empty bypasses and target TLS verification', async () => {
  const runtime = new LimaRuntime('/unused-probe-fixture'); const e = environment();
  ports(runtime).set(e.id, 42125); runtime.proxyTransports.entries.set(e.id, fakeTransport() as any);
  let command: string[] = []; runtime.management = async (_e, args) => { if(args.at(-1)===EGRESS_URL)command = args; return fakeOutput(args); };
  assert.equal((await measureEgress(runtime, e)).ip, '8.8.8.8');
  assert.equal(command[command.indexOf('--proxy') + 1], 'socks5h://127.0.0.1:42125');
  assert.equal(command[command.indexOf('--noproxy') + 1], '');
  assert.ok(!command.includes('--doh-url') && !command.includes('--resolve'));
  assert.equal(command[command.indexOf('--cacert') + 1], '/etc/ssl/certs/ca-certificates.crt');
  assert.ok(command.includes('--tlsv1.2') && !command.includes('--insecure'));
});

test('proxy or controlled-DNS failure aborts verification without any receiver retrying through a direct path', async () => {
  const { runtime, calls } = captureRuntime('socks5h://127.0.0.1:42125');
  const failure = new Error('Controlled DNS lookup failed');
  runtime.management = async (_e, args, options) => { calls.push({ args, options }); throw failure; };
  await assert.rejects(measureEgress(runtime, environment()), error => error === failure);
  assert.equal(calls.length, 3);
  for(const call of calls)assert.equal(call.args[call.args.indexOf('--proxy') + 1], 'socks5h://127.0.0.1:42125');
});

test('the real curl command sends the fixed target hostname to SOCKS5 and terminates when that controlled listener refuses DNS', async () => {
  const requests: { addressType: number; hostname: string; port: number }[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0), greeted = false;
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      if (!greeted) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        assert.equal(buffer[0], 5); buffer = buffer.subarray(2 + buffer[1]); greeted = true;
        socket.write(Buffer.from([5, 0]));
      }
      if (!buffer.length) return;
      if (buffer.length < 5 || buffer[3] !== 3 || buffer.length < 7 + buffer[4]) return;
      const length = buffer[4];
      requests.push({ addressType: buffer[3], hostname: buffer.subarray(5, 5 + length).toString('ascii'), port: buffer.readUInt16BE(5 + length) });
      buffer = Buffer.alloc(0);
      // SOCKS host-unreachable response models a controlled resolver failure.
      socket.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const execute = promisify(execFile); let calls = 0;
  const runtime = { egressProbeProxy: () => `socks5h://127.0.0.1:${port}`, management: async (_e: Environment, args: string[]) => {
    calls++; const index = args.indexOf('/usr/bin/curl');
    // Strip the guest sudo/env wrapper. Run the exact curl arguments as the
    // current user; the local fixture never connects to the real target.
    const result = await execute('/usr/bin/curl', args.slice(index + 1), { env: { PATH: '/usr/bin:/bin' }, timeout: 10_000, maxBuffer: 65536 });
    return result.stdout;
  } } as unknown as LimaRuntime;
  try {
    await assert.rejects(measureEgress(runtime, environment()));
    assert.equal(calls, 3);
    for(let i=0;i<20&&requests.length<3;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.deepEqual(requests.map(value=>({ ...value })).sort((a,b)=>a.hostname.localeCompare(b.hostname)), EGRESS_RECEIVERS.map(value=>({addressType:3,hostname:new URL(value.url).hostname,port:443})).sort((a,b)=>a.hostname.localeCompare(b.hostname)));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('the probe hostname resolves only through the configured IPv4 DNS server and the same sole upstream', () => {
  const e = environment();
  e.network.dns = { address: '9.9.9.9', serverName: 'dns.quad9.net', port: 443, path: '/dns-query' };
  for (const mode of ['http', 'https', 'socks5'] as const) {
    const n = { ...e.network, mode, ...(mode === 'https' ? { tls: { serverName: 'proxy.example' } } : {}) };
    const config = transparentConfig({ ...e, network: n }, '127.0.0.1', 999, ['192.168.5.0/24'], 42125);
    assert.equal(config.dns.servers.length, 1);
    const resolver = config.dns.servers[0];
    assert.equal(resolver.server, '9.9.9.9'); assert.equal(resolver.detour, 'upstream');
    assert.equal(resolver.tls.server_name, 'dns.quad9.net'); assert.equal(resolver.tls.enabled, true);
    assert.equal(config.dns.final, resolver.tag); assert.equal(config.dns.strategy, 'ipv4_only');
    const actions = config.route.rules.filter(rule => rule.action === 'resolve');
    assert.deepEqual(actions, [{ inbound: ['exit-probe'], action: 'resolve', server: resolver.tag, strategy: 'ipv4_only' }]);
    assert.equal(config.outbounds.length, 1); assert.equal(config.route.final, config.outbounds[0].tag);
    assert.ok(!config.outbounds.some(outbound => (outbound.type as string) === 'direct'));
    assert.deepEqual(config.route.rules[0], { inbound: ['exit-probe'], network: 'udp', action: 'reject' });
  }
  const normal = transparentConfig(e, '127.0.0.1', 999, []);
  assert.ok(!normal.route.rules.some(rule => rule.action === 'resolve'), 'Adding a probe must not change business inbound resolution rules');
});
