import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { shellQuote } from '../server/network-guard.ts';
import { limaPortForwards } from '../server/lima-config.ts';
import type { Job } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(homedir(), '.mu-port-verification-'));
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const manager = new Manager(temporary, undefined, new LimaRuntime(temporary));
const report: Record<string, unknown> = { passed: false, accountFree: true, paidModelCalls: 0, startedAt: new Date().toISOString(), scope: 'Lima host port exposure only; a disposable direct-network VM with no accounts or project mounts. Not a strict egress or lease acceptance.' };
const reservations: { close: () => void }[] = [];
async function reserve() {
  const tcp = createServer();
  await new Promise<void>(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const port = (tcp.address() as { port: number }).port;
  const udp = createSocket('udp4');
  try { await new Promise<void>((resolve, reject) => { udp.once('error', reject); udp.bind(port, '127.0.0.1', resolve); }); }
  catch (error) { tcp.close(); udp.close(); throw error; }
  reservations.push({ close: () => { tcp.close(); udp.close(); } });
  return port;
}
const ports = { tcpWildcard: await reserve(), tcpLoopback: await reserve(), udpWildcard: await reserve(), udpLoopback: await reserve(), explicit: await reserve() };
const hostPort = await reserve();
for (const reservation of reservations) reservation.close();
const environment = await manager.create({ name: '本机端口边界验证', cpus: 2, memoryGiB: 2, diskGiB: 10, ports: [{ id: randomUUID(), guestPort: ports.explicit, hostPort }] });
const current = () => manager.store.get(environment.id);
async function finish(job: Job) {
  await manager.tasks.get(job.id)?.promise;
  const done = manager.store.jobs().find(item => item.id === job.id)!;
  assert.equal(done.status, 'succeeded', done.message);
}
async function hostHttp(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
  return response.text();
}
async function hostUdp(port: number) {
  const socket = createSocket('udp4');
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('UDP timeout')), 1000);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('message', data => { clearTimeout(timer); resolve(data.toString()); });
      socket.send(Buffer.from('MU_PORT_PROBE'), port, '127.0.0.1', error => { if (error) { clearTimeout(timer); reject(error); } });
    });
  } finally { socket.close(); }
}
async function eventually(check: () => Promise<void>) {
  let last: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await check(); return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw last;
}
async function localPositive() {
  const code = `import socket,json,urllib.request\np=json.loads(${JSON.stringify(JSON.stringify(ports))})\nfor name in ('tcpWildcard','tcpLoopback','explicit'):\n assert urllib.request.urlopen('http://127.0.0.1:'+str(p[name]),timeout=2).read()==b'MU_PORT_FIXTURE'\nfor name in ('udpWildcard','udpLoopback'):\n s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(2);s.sendto(b'MU_PORT_PROBE',('127.0.0.1',p[name]));assert s.recv(1024)==b'MU_PORT_FIXTURE';s.close()\nprint('GUEST_SERVICES_READY')`;
  assert.match(await manager.runtime.guest(current(), ['python3', '-c', code]), /GUEST_SERVICES_READY/);
}
async function correctedChecks(label: string) {
  await localPositive();
  await eventually(async () => { assert.equal(await hostHttp(hostPort), 'MU_PORT_FIXTURE'); });
  await new Promise(resolve => setTimeout(resolve, 3000));
  for (const port of [ports.tcpWildcard, ports.tcpLoopback, ports.explicit]) await assert.rejects(hostHttp(port));
  for (const port of [ports.udpWildcard, ports.udpLoopback]) await assert.rejects(hostUdp(port));
  report[label] = { guestTcpAndUdpPositiveControls: true, explicitTcpMappingWorks: true, unapprovedWildcardAndLoopbackTcpUdpBlocked: true };
}
try {
  console.log('Starting a disposable VM with the corrected catch-all forwarding policy.');
  await finish(await manager.lifecycle(environment.id, 'start'));
  const source = await readFile(path.join(root, 'scripts/port-forward-fixture.py'), 'utf8');
  const unit = '[Unit]\nDescription=MuCodeSandbox port boundary fixture\nAfter=network.target\n[Service]\nUser=dev\nExecStart=/usr/bin/python3 /usr/local/libexec/mu-port-fixture.py\nRestart=on-failure\n[Install]\nWantedBy=multi-user.target\n';
  await manager.runtime.management(current(), ['bash', '-s'], { input: `set -eu\nsudo install -d -m 0755 /etc/mucodesandbox /usr/local/libexec\nprintf '%s' ${shellQuote(JSON.stringify(ports))} | sudo tee /etc/mucodesandbox/port-fixture.json >/dev/null\nprintf '%s' ${shellQuote(source)} | sudo tee /usr/local/libexec/mu-port-fixture.py >/dev/null\nprintf '%s' ${shellQuote(unit)} | sudo tee /etc/systemd/system/mu-port-fixture.service >/dev/null\nsudo chmod 0644 /etc/mucodesandbox/port-fixture.json /usr/local/libexec/mu-port-fixture.py /etc/systemd/system/mu-port-fixture.service\nsudo systemctl daemon-reload\nsudo systemctl enable --now mu-port-fixture.service\n` });
  await eventually(localPositive);
  await correctedChecks('freshPolicy');
  await finish(await manager.lifecycle(environment.id, 'stop'));
  const file = path.join(temporary, 'lima', environment.instanceName, 'lima.yaml');
  const config = parse(await readFile(file, 'utf8'));
  config.portForwards = [...limaPortForwards(current()).slice(0, -1), { guestPortRange: [1, 65535], proto: 'any', ignore: true }];
  await writeFile(file, stringify(config), { mode: 0o600 });
  console.log('Starting the legacy rule directly only as a synthetic positive control.');
  await manager.runtime.command(['start', '--timeout', '5m', environment.instanceName], { timeoutMs: 330_000 });
  await eventually(async () => {
    assert.equal(await hostHttp(ports.tcpWildcard), 'MU_PORT_FIXTURE');
    assert.equal(await hostUdp(ports.udpWildcard), 'MU_PORT_FIXTURE');
  });
  report.legacyWildcardAutomaticExposureReproduced = { tcp: true, udp: true };
  await manager.runtime.command(['stop', environment.instanceName], { timeoutMs: 120_000 });
  console.log('Restarting through the normal manager to verify stopped-VM migration.');
  await finish(await manager.lifecycle(environment.id, 'start'));
  assert.deepEqual(parse(await readFile(file, 'utf8')).portForwards, limaPortForwards(current()));
  await correctedChecks('migratedPolicy');
  report.passed = true;
} catch (error) {
  report.error = (error as Error).message;
  report.logs = manager.store.logs(environment.id).slice(-10);
  process.exitCode = 1;
} finally {
  await manager.lifecycle(environment.id, 'delete').then(finish).catch(error => { report.cleanupError = (error as Error).message; report.passed = false; process.exitCode = 1; });
  await manager.close();
  if (!report.cleanupError) await rm(temporary, { recursive: true, force: true });
  else report.retainedDataDir = temporary;
  report.finishedAt = new Date().toISOString();
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/port-forwards.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
