import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer, request as httpRequest } from 'node:http';
import { writeFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, stringify } from 'yaml';
import { createAcceptanceLab } from '../server/acceptance-lab.ts';
import { buildLimaConfig } from '../server/lima-config.ts';
import { shellQuote } from '../server/network-guard.ts';
import { environmentSchema } from '../server/validation.ts';
import type { LimaRuntime } from '../server/runtime.ts';
import type { Environment, NetworkConfig } from '../shared/types.ts';

function keys() {
  const pair = generateKeyPairSync('x25519');
  return { privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64'),
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
}

export async function createClaudeWireguardFixture(runtime: LimaRuntime, directory: string, browserPort?:number, gatewayMemoryGiB = 2) {
  const lab = await createAcceptanceLab(), url = new URL(lab.info().url), sockets = new Set<Socket>();
  const relay = createServer((req, res) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port: browserPort&&req.headers.host?.split(':')[0]==='203.0.113.81'?browserPort:url.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: url.host } }, response => {
      res.writeHead(response.statusCode!, response.headers); response.pipe(res); response.on('aborted', () => res.destroy());
    });
    outgoing.on('error', () => res.destroy()); res.on('close', () => outgoing.destroy()); req.pipe(outgoing);
  });
  relay.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
  const relayPort = (relay.address() as { port: number }).port, reversePort = 41881;
  const udp = createSocket('udp4'); await new Promise<void>(resolve => udp.bind(0, '127.0.0.1', resolve));
  const port = udp.address().port; await new Promise<void>(resolve => udp.close(() => resolve()));
  const clientKey = keys(), gatewayKey = keys(), id = randomUUID(), now = new Date().toISOString();
  const gateway: Environment = { ...environmentSchema.parse({ name: 'Disposable Claude TUI packet gateway', cpus: 1, memoryGiB: gatewayMemoryGiB, diskGiB: 10 }),
    id, instanceName: `mu-${id.replaceAll('-', '').slice(0, 16)}`, state: 'running', browserRunning: false, lastError: null, createdAt: now, updatedAt: now };
  const network: NetworkConfig = { mode: 'wireguard', host: '192.168.5.2', port, username: '', noProxy: '', strict: true, transparent: true,
    wireguard: { address: '10.77.0.2/32', privateKey: clientKey.privateKey, peerPublicKey: gatewayKey.publicKey, listenPort: 51821, mtu: 1420 } };
  const admin = (args: string[], input?: string, timeoutMs = 30_000) => runtime.management(gateway, args, { input, timeoutMs });
  let ssh: ChildProcess | undefined, sshDone: Promise<void> | undefined, sshError = '', localOnly = false;
  async function prepare() {
    const config = parse(buildLimaConfig(gateway));
    config.portForwards.unshift({ guestPort: 51820, hostPort: port, hostIP: '127.0.0.1', guestIP: '0.0.0.0', guestIPMustBeZero: false, proto: 'udp' });
    const file = path.join(directory, 'tui-gateway.yaml'); await writeFile(file, stringify(config), { mode: 0o600 });
    await runtime.command(['start', '--name', gateway.instanceName, '--timeout', '15m', file], { timeoutMs: 950_000 });
    // A raw duplex relay propagates TUI cancellation immediately, without buffering SSE.
    const python = `import selectors,socket,socketserver,pathlib,threading
class Handler(socketserver.BaseRequestHandler):
 def handle(self):
  if self.client_address[0]!='10.77.0.2':return
  with open('/run/mu-tui-wg/sources.log','a') as log:log.write(self.client_address[0]+'\\n')
  upstream=socket.create_connection(('127.0.0.1',${reversePort}),timeout=5)
  upstream.settimeout(None)
  try:
   with selectors.DefaultSelector() as selector:
    selector.register(self.request,selectors.EVENT_READ,upstream)
    selector.register(upstream,selectors.EVENT_READ,self.request)
    while True:
     for key,_ in selector.select(5):
      data=key.fileobj.recv(65536)
      if not data:return
      key.data.sendall(data)
  except OSError:pass
  finally:upstream.close()
class Server(socketserver.ThreadingTCPServer):
 allow_reuse_address=True
 daemon_threads=True
${browserPort?"threading.Thread(target=Server(('203.0.113.81',80),Handler).serve_forever,daemon=True).start()":''}
Server(('203.0.113.80',80),Handler).serve_forever()
`;
    await admin(['bash', '-s'], `set -euo pipefail
sudo apt-get update -qq
sudo apt-get install -y -qq wireguard-tools nftables tcpdump
sudo install -d -m 0700 /run/mu-tui-wg
printf '%s' ${shellQuote(`[Interface]\nPrivateKey = ${gatewayKey.privateKey}\nListenPort = 51820\n[Peer]\nPublicKey = ${clientKey.publicKey}\nAllowedIPs = 10.77.0.2/32\n`)} | sudo tee /run/mu-tui-wg/peer.conf >/dev/null
sudo chmod 0600 /run/mu-tui-wg/peer.conf
sudo ip link add mu_gateway type wireguard
sudo wg setconf mu_gateway /run/mu-tui-wg/peer.conf
sudo ip address add 10.77.0.1/24 dev mu_gateway
sudo ip link set mu_gateway mtu 1420 up
sudo ip link add mu_target type dummy
sudo ip address add 203.0.113.80/32 dev mu_target
${browserPort?'sudo ip address add 203.0.113.81/32 dev mu_target':''}
sudo ip link set mu_target up
sudo sysctl -qw net.ipv4.ip_forward=1
sudo nft -f - <<'MU_NAT'
table ip mu_tui_wg_nat {
 chain postrouting { type nat hook postrouting priority srcnat; policy accept;
  ip saddr 10.77.0.2 oifname "eth0" masquerade
 }
}
MU_NAT
printf '%s' ${shellQuote(python)} | sudo tee /run/mu-tui-wg/relay.py >/dev/null
sudo chmod 0600 /run/mu-tui-wg/relay.py
sudo systemd-run --quiet --unit=mu-tui-wg-relay /usr/bin/python3 /run/mu-tui-wg/relay.py
`, 300_000);
    ssh = spawn('/usr/bin/ssh', ['-F', path.join(runtime.limaHome, gateway.instanceName, 'ssh.config'), '-S', 'none', '-N', '-T',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
      '-R', `127.0.0.1:${reversePort}:127.0.0.1:${relayPort}`, `lima-${gateway.instanceName}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    sshDone = new Promise(resolve => { ssh!.once('exit', () => resolve()); ssh!.once('error', error => { sshError = error.message; resolve(); }); });
    ssh.stderr!.on('data', bytes => { sshError = (sshError + bytes.toString()).slice(-2000); });
    const deadline = Date.now() + 20_000;
    while (true) {
      assert.equal(ssh.exitCode, null, sshError); assert.equal(ssh.signalCode, null, sshError);
      try { if (JSON.parse(await admin(['curl', '--fail', '--silent', '--max-time', '1', `http://127.0.0.1:${reversePort}/api/status`])).running) break; } catch { /* Wait for SSH's owned listener. */ }
      assert.ok(Date.now() < deadline, 'Gateway reverse relay did not become ready'); await delay(100);
    }
  }
  async function restrictToLocalFixture() {
    await admin(['bash', '-s'], `set -eu
sudo nft -f - <<'MU_LOCAL_ONLY'
table inet mu_tui_local_only {
 counter external { }
 chain forward { type filter hook forward priority -20; policy accept;
  ip saddr 10.77.0.2 counter name external drop
  ip daddr 10.77.0.2 counter name external drop
 }
}
MU_LOCAL_ONLY
`); localOnly = true;
  }
  async function inspect() {
    const sources = (await admin(['sudo', 'cat', '/run/mu-tui-wg/sources.log'])).trim().split('\n').filter(Boolean);
    assert.ok(sources.length > 0); assert.ok(sources.every(source => source === '10.77.0.2'));
    assert.equal(localOnly, true);
    const rules = JSON.parse(await admin(['sudo', 'nft', '-j', 'list', 'table', 'inet', 'mu_tui_local_only']));
    const counter = rules.nftables.find((row: any) => row.counter?.name === 'external')?.counter;
    assert.ok(counter?.packets > 0, 'Actual external-forwarding rejection needs a positive counter');
    return { localOnly, clientAddresses: sources, forwardingRules: rules, rejectedForwardPackets: counter.packets };
  }
  async function close() {
    ssh?.kill('SIGTERM');
    if (sshDone) {
      await Promise.race([sshDone, delay(3000)]);
      if (ssh!.exitCode === null && ssh!.signalCode === null) { ssh!.kill('SIGKILL'); await sshDone; }
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => relay.close(() => resolve())); await lab.close(); await runtime.remove(gateway);
  }
  const setPeerAvailable=async(available:boolean)=>admin(['sudo','ip','link','set','mu_gateway',available?'up':'down']);
  return { lab, gateway, network, prepare, restrictToLocalFixture, inspect, setPeerAvailable, close };
}
