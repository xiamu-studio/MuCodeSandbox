import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type SpawnOptions } from 'node:child_process';
import { ProxyTransports } from '../server/proxy-transport.ts';
import { firewallRules } from '../server/network-guard.ts';

const session = `process.stderr.write('Allocated port 42123 for remote forward to 127.0.0.1:7890\\n');
process.stdout.write('MU_PROXY_SESSION_READY\\n');
process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));`;
function controlled(script = session) {
  const invocations: { file: string; args: string[] }[] = [];
  const launch = ((file: string, args: string[], options: SpawnOptions) => {
    invocations.push({ file, args }); return spawn(process.execPath, ['-e', script], options);
  }) as typeof spawn;
  const forwardings: string[][] = [];
  return { transports: new ProxyTransports('/tmp/private-lima', launch, async (_file, args) => { forwardings.push(args); return '42123'; }), invocations, forwardings };
}

test('Proxy transport binds only guest loopback and closes its owned process on EOF', async () => {
  const { transports, invocations, forwardings } = controlled();
  try {
    const identity = await transports.open('one', 'mu-test', '127.0.0.1', 7890);
    assert.equal(identity.port, 42123); assert.equal(transports.matches('one', identity), true);
    assert.equal(transports.matches('one', { ...identity, targetPort: 7891 }), false);
    const { file, args } = invocations[0];
    assert.equal(file, '/usr/bin/ssh');
    assert.ok(!args.includes('-R'), 'The ownership session must be ready before creating a proxy listener');
    assert.equal(forwardings[0][forwardings[0].indexOf('-R') + 1], '127.0.0.1:0:127.0.0.1:7890');
    assert.ok(args.includes('ExitOnForwardFailure=yes')); assert.ok(args.includes('BatchMode=yes'));
    assert.ok(!args.includes('-N'), 'The session must read owner stdin to observe parent death');
    const pid = transports.entries.get('one')!.child.pid!;
    await transports.close('one'); await transports.close('one');
    assert.equal(transports.matches('one', identity), false);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await transports.close('one'); }
});

test('A proxy transport requires both port allocation and a live ownership watcher', async () => {
  const { transports } = controlled("process.stderr.write('Allocated port 42123 for remote forward to target\\n');process.exit(1)");
  await assert.rejects(transports.open('one', 'mu-test', '192.0.2.1', 7890), { code: 'PROXY_TRANSPORT_CLOSED' });
  assert.equal(transports.entries.size, 0);
});

test('Cancellation closes an unready proxy transport and rejects invalid destinations before spawn', async () => {
  const { transports, invocations } = controlled('process.stdin.resume();process.stdin.on("end",()=>process.exit(0))');
  await assert.rejects(transports.open('one', '../mu-test', '127.0.0.1', 7890), { code: 'PROXY_TRANSPORT_CONFIGURATION' });
  await assert.rejects(transports.open('one', 'mu-test', 'proxy.example', 7890), { code: 'PROXY_TRANSPORT_CONFIGURATION' });
  assert.equal(invocations.length, 0);
  const controller = new AbortController();
  const pending = transports.open('one', 'mu-test', '127.0.0.1', 7890, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 50);
  try { await assert.rejects(pending, { code: 'CANCELLED' }); }
  finally { clearTimeout(timer); await transports.close('one'); }
  assert.equal(transports.entries.size, 0);
});

test('The private proxy listener denies other local users before the loopback exception', () => {
  const rules = firewallRules(['127.0.0.1'], 42123, [], '192.168.5.2', 999, 998, undefined, 42123);
  const deny = 'oifname "lo" ip daddr 127.0.0.1 tcp dport 42123 meta skuid != 999 counter name blocked drop';
  assert.ok(rules.includes(deny)); assert.ok(rules.indexOf(deny) < rules.indexOf('oifname "lo" accept'));
  assert.throws(() => firewallRules(['192.0.2.1'], 42123, [], '192.168.5.2', 999, 998, undefined, 42123));
  assert.throws(() => firewallRules(['127.0.0.1'], 42123, [], '192.168.5.2', undefined, 998, undefined, 42123));
  assert.throws(() => firewallRules(['127.0.0.1'], 42123, [], '192.168.5.2', 999, 998, undefined, 42124));
});

test('A failed fixed-port forward closes its ownership session and never publishes a transport', async () => {
  const launch = ((_file: string, _args: string[], options: SpawnOptions) => spawn(process.execPath, ['-e', session], options)) as typeof spawn;
  const transports = new ProxyTransports('/tmp/private-lima', launch, async (_file, args) => {
    assert.equal(args[args.indexOf('-R') + 1], '127.0.0.1:42123:127.0.0.1:7890');
    throw new Error('Remote port is already occupied');
  });
  await assert.rejects(transports.open('one', 'mu-test', '127.0.0.1', 7890, {}, 42123), /already occupied/);
  assert.equal(transports.entries.size, 0);
});
