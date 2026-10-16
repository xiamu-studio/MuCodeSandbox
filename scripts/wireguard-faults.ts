import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import type { createService } from '../server/service.ts';
import type { Environment, Job } from '../shared/types.ts';
import { shellQuote } from '../server/network-guard.ts';

type Service = Awaited<ReturnType<typeof createService>>;
async function until(check: () => boolean | Promise<boolean>, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'Packet fault observation timed out');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

export async function verifyWireguardFaults(service: Service, gateway: Environment, clientId: string, artifacts: string) {
  const { manager } = service, runtime = manager.runtime;
  const current = () => manager.store.get(clientId);
  const admin = (args: string[], input?: string) => runtime.management(current(), args, { input, timeoutMs: 30_000 });
  const gatewayAdmin = (args: string[], input?: string) => runtime.management(gateway, args, { input, timeoutMs: 30_000 });
  const guest = (args: string[]) => runtime.guest(current(), args, { timeoutMs: 15_000 });
  const request = () => guest(['curl', '--fail', '--silent', '--max-time', '4', '--proxy', '', 'http://203.0.113.10/']);
  const report: Record<string, any> = { passed: false, accountFree: true, paidModelCalls: 0, startedAt: new Date().toISOString(), actualMacSleepTested: false, actualWifiSwitchTested: false, scenarios: [] };
  let timerPaused = false;
  async function finish(job: Job) {
    await manager.tasks.get(job.id)?.promise;
    const result = manager.store.jobs().find(entry => entry.id === job.id)!;
    assert.equal(result.status, 'succeeded', result.message);
  }
  async function stopped() {
    await until(async () => (await runtime.list()).find(entry => entry.name === current().instanceName)?.status === 'Stopped');
    await Promise.all([...manager.quarantines.values()]);
    assert.equal(current().state, 'error');
  }
  async function recover() {
    await finish(await manager.lifecycle(clientId, 'restart'));
    assert.equal((await request()).trim(), 'MU_PACKET_RUNTIME_OK');
    assert.equal((await runtime.networkProtection(current())).active, true);
  }
  function resumeTimer() {
    if (!timerPaused) return;
    manager.protectionTimer = setInterval(() => { void manager.monitorProtection().catch(() => {}); }, 8000);
    manager.protectionTimer.unref(); timerPaused = false;
  }
  async function capture(name: string) {
    const unit = `mu-fault-capture-${name}`, file = path.join(artifacts, `${name}.pcap`);
    const output = createWriteStream(file, { mode: 0o600 });
    const child = spawn('/usr/bin/ssh', ['-F', path.join(runtime.limaHome, current().instanceName, 'ssh.config'), '-S', 'none', '-T', `lima-${current().instanceName}`,
      'sudo', 'systemd-run', '--quiet', '--pipe', '--wait', '--collect', `--unit=${unit}`, '/usr/bin/timeout', '240', '/usr/bin/tcpdump', '--immediate-mode', '-ni', 'eth0', '-Q', 'out', '-U', '-s', '128', '-w', '-', shellQuote('(ip or ip6) and not (tcp src port 22 and dst host 192.168.5.2)')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errorText = '';
    child.stderr.on('data', bytes => { errorText = (errorText + bytes.toString()).slice(-2000); });
    let launchError: Error | undefined;
    const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', error => { launchError = error; resolve(); }); });
    child.stdout.pipe(output);
    await until(async () => {
      if (launchError) throw launchError;
      assert.equal(child.exitCode, null, errorText);
      try { return (await stat(file)).size >= 24; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    });
    return async () => {
      if (child.exitCode === null) await admin(['sudo', 'systemctl', 'stop', `${unit}.service`]).catch(() => {});
      if (child.exitCode === null) child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 2500); kill.unref();
      await closed; clearTimeout(kill); await finished(output);
      const bytes = await readFile(file); assert.ok(bytes.length > 24);
      const base = ['-nn', '-r', file];
      const port = current().network.port;
      const allowed = `(udp and dst host 192.168.5.2 and dst port ${port}) or (tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67)`;
      const unexpected = await runtime.runner('/usr/sbin/tcpdump', [...base, `ip6 or (ip and not (${allowed}))`], { timeoutMs: 30_000 });
      assert.ok(!unexpected.split('\n').some(line => /^\d\d:\d\d:\d\d\./.test(line)), unexpected);
      const transport = await runtime.runner('/usr/sbin/tcpdump', [...base, `udp and dst host 192.168.5.2 and dst port ${port}`], { timeoutMs: 30_000, maxBytes: 64_000_000 });
      const udpPackets = transport.split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line)).length;
      assert.ok(udpPackets > 0, 'Fault capture needs actual approved transport');
      return { file: path.basename(file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), approvedUdpPackets: udpPackets, unapprovedPackets: 0, approvedManagementSshExcludedToPreventCaptureFeedback: true };
    };
  }
  async function scenario(name: string, action: (row: any) => Promise<void>) {
    console.log(new Date().toISOString(), `Packet fault: ${name}`);
    const row: Record<string, any> = { name, startedAt: new Date().toISOString(), passed: false };
    report.scenarios.push(row);
    row.beforeResponse = (await request()).trim(); assert.equal(row.beforeResponse, 'MU_PACKET_RUNTIME_OK');
    const endCapture = await capture(name);
    try {
      row.capturedPositiveResponse = (await request()).trim(); assert.equal(row.capturedPositiveResponse, 'MU_PACKET_RUNTIME_OK');
      await action(row); row.afterResponse = (await request()).trim(); assert.equal(row.afterResponse, 'MU_PACKET_RUNTIME_OK'); row.passed = true;
    }
    catch (error) { row.error = (error as Error).stack; throw error; }
    finally {
      try { row.capture = await endCapture(); }
      catch (error) { row.captureError = (error as Error).stack; row.passed = false; }
      row.finishedAt = new Date().toISOString();
      await writeFile(path.join(artifacts, 'faults.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
      if (!row.error) assert.equal(row.passed, true, JSON.stringify(row));
    }
  }
  async function flow() {
    const controller = new AbortController(); let output = '', done = false, error: unknown;
    const operation = runtime.guest(current(), ['curl', '--fail', '--silent', '--no-buffer', '--max-time', '230', '--proxy', '', 'http://203.0.113.10/stream'], { signal: controller.signal, timeoutMs: 235_000, onOutput: bytes => { output += bytes; } })
      .catch(reason => { error = reason; }).finally(() => { done = true; });
    const count = () => (output.match(/MU_TICK/g) ?? []).length;
    await until(() => { assert.equal(done, false, String(error)); return count() >= 3; });
    return { count, stop: async () => { controller.abort(); await operation; } };
  }
  const python = `import http.server,time
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','text/plain');self.end_headers()
  if self.path!='/stream': self.wfile.write(b'MU_PACKET_RUNTIME_OK');return
  try:
   for n in range(1000):
    self.wfile.write(b'MU_TICK\\n');self.wfile.flush();time.sleep(.25)
  except OSError: pass
http.server.ThreadingHTTPServer(('203.0.113.10',80),Handler).serve_forever()
`;
  try {
    await gatewayAdmin(['bash', '-s'], `set -eu
sudo systemctl stop mu-wg-runtime-http.service
printf '%s' ${shellQuote(python)} | sudo tee /run/mu-wg-runtime/fault-http.py >/dev/null
sudo chmod 0600 /run/mu-wg-runtime/fault-http.py
sudo systemd-run --unit=mu-wg-fault-http /usr/bin/python3 /run/mu-wg-runtime/fault-http.py
`);
    await scenario('networkd-dhcp', async row => {
      const before = await runtime.networkProtection(current());
      row.beforeAddress = JSON.parse(await admin(['ip', '-j', '-4', 'address', 'show', 'dev', 'eth0']));
      await admin(['bash', '-s'], 'set -eu\nsudo systemctl restart systemd-networkd\nsudo networkctl renew eth0\n');
      await until(async () => { try { return (await request()).trim() === 'MU_PACKET_RUNTIME_OK'; } catch { return false; } });
      await until(async () => (await runtime.networkProtection(current())).active);
      const after = await runtime.networkProtection(current());
      assert.equal(after.firewallHash, before.firewallHash); assert.equal(after.wireguardStateHash, before.wireguardStateHash);
      assert.match(await guest(['getent', 'ahostsv4', 'example.com']), /STREAM/);
      row.afterAddress = JSON.parse(await admin(['ip', '-j', '-4', 'address', 'show', 'dev', 'eth0']));
      row.networkdRestartAndDhcpRenew = true; row.protectionUnchanged = true;
    });
    await scenario('dns-corruption', async row => {
      assert.match(await guest(['getent', 'ahostsv4', 'example.com']), /STREAM/);
      await admin(['bash', '-s'], `set -eu
printf '[Resolve]\\nDNS=8.8.8.8\\nFallbackDNS=8.8.4.4\\nDomains=~.\\n' | sudo tee /etc/systemd/resolved.conf.d/mucodesandbox.conf >/dev/null
sudo systemctl restart systemd-resolved
sudo resolvectl flush-caches
`);
      await assert.rejects(guest(['timeout', '4', 'getent', 'ahostsv4', 'example.com']));
      await stopped(); row.automaticQuarantine = true;
      assert.ok(manager.store.logs(clientId).some(entry => entry.message.includes('受控 DNS 配置失效')));
      await recover(); row.normalRestartRepairsDns = true;
    });
    await scenario('lease-storage-full', async row => {
      clearInterval(manager.protectionTimer); timerPaused = true; await manager.monitoring;
      await runtime.renewLease(current());
      const stream = await flow();
      try {
        await admin(['bash', '-s'], `set -eu
sudo install -d -m 0700 /run/mu-lease-fault-backup
sudo cp -a /run/mucodesandbox-lease/. /run/mu-lease-fault-backup/
sudo mount -t tmpfs -o size=64k,mode=0700 tmpfs /run/mucodesandbox-lease
sudo cp -a /run/mu-lease-fault-backup/. /run/mucodesandbox-lease/
sudo python3 - <<'MU_FULL'
import errno,os
with open('/run/mucodesandbox-lease/filler','wb',buffering=0) as f:
 try:
  while True: f.write(bytes(4096))
 except OSError as error:
  if error.errno!=errno.ENOSPC: raise
print('MU_LEASE_STORAGE_FULL')
MU_FULL
`);
        let failure: any;
        try { await runtime.renewLease(current()); } catch (error) { failure = error; }
        assert.match(failure?.message ?? '', /No space left on device/); row.actualRenewalError = failure.message;
        const permit = JSON.parse(await admin(['sudo', 'nft', '-j', 'list', 'set', 'inet', 'mu_lease', 'permit']));
        assert.ok(permit.nftables.every((entry: any) => !entry.set?.elem?.length));
        await assert.rejects(request());
        await new Promise(resolve => setTimeout(resolve, 1000)); const ticks = stream.count();
        await new Promise(resolve => setTimeout(resolve, 1000)); assert.equal(stream.count(), ticks);
        assert.equal((await runtime.networkProtection(current())).leaseActive, false);
        row.kernelPermissionClosedWithHostTimerPaused = true; row.existingAndNewBusinessBlocked = true;
      } finally { await stream.stop(); resumeTimer(); }
      await stopped(); await recover(); row.restartAfterStorageFailure = true;
    });
    await scenario('peer-outage', async row => {
      const initial = await runtime.networkProtection(current()); assert.ok(initial.wireguardHandshakeAge! <= 5);
      const stream = await flow(), start = Date.now();
      try {
        await gatewayAdmin(['bash', '-s'], `set -eu
sudo nft -f - <<'MU_PEER_OUTAGE'
table inet mu_peer_outage {
 counter blocked { }
 chain input { type filter hook input priority -50; policy accept; udp dport 51820 counter name blocked drop; }
 chain output { type filter hook output priority -50; policy accept; udp sport 51820 counter name blocked drop; }
}
MU_PEER_OUTAGE
`);
        await assert.rejects(request()); row.newBusinessFailureMs = Date.now() - start;
        await new Promise(resolve => setTimeout(resolve, 1000)); const ticks = stream.count();
        await new Promise(resolve => setTimeout(resolve, 1000)); assert.equal(stream.count(), ticks); row.existingFlowStalled = true;
        let lastNotice = Date.now();
        await until(async () => {
          if (Date.now() - lastNotice > 20_000) { console.log(new Date().toISOString(), 'Still observing the same blocked peer and automatic handshake expiry'); lastNotice = Date.now(); }
          return (await runtime.list()).find(entry => entry.name === current().instanceName)?.status === 'Stopped';
        }, 220_000);
        await Promise.all([...manager.quarantines.values()]);
        row.automaticStopMs = Date.now() - start; assert.ok(row.automaticStopMs >= 150_000);
        assert.ok(manager.store.logs(clientId).some(entry => entry.message.includes('隧道对端握手已失效')));
        row.peerDropCounter = JSON.parse(await gatewayAdmin(['sudo', 'nft', '-j', 'list', 'counter', 'inet', 'mu_peer_outage', 'blocked']));
        assert.ok(row.peerDropCounter.nftables.some((entry: any) => entry.counter?.packets > 0));
      } finally { await stream.stop(); await gatewayAdmin(['sudo', 'nft', 'delete', 'table', 'inet', 'mu_peer_outage']); }
      await recover(); row.normalRestartAfterPeerRecovery = true;
    });
    report.passed = true;
  } catch (error) { report.error = (error as Error).stack; throw error; }
  finally {
    resumeTimer(); report.finishedAt = new Date().toISOString();
    await writeFile(path.join(artifacts, 'faults.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  return report;
}
