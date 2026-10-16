import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { createAcceptanceLab } from '../server/acceptance-lab.ts';
import { MOCK_CREDENTIAL, MOCK_CONTENT, MOCK_FILE } from '../server/mock-messages.ts';
import type { Job, Environment } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const directory = process.env.MU_CLAUDE_TEST_DATA ?? await mkdtemp(path.join(homedir(), '.mu-claude-verification-'));
assert.ok(path.isAbsolute(directory) && path.basename(directory).startsWith('.mu-claude-verification-'));
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const manager = new Manager(directory, undefined, new LimaRuntime(directory));
const lab = await createAcceptanceLab(), labURL = new URL(lab.info().url);
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), accountFree: true, paidModelCalls: 0,
  scope: 'Actual Linux Claude Code against local Messages fixture, strict transparent VM, no provider account; not paid-provider or Desktop validation' };
const artifacts = path.join(root, 'test-results', 'claude-client'); await mkdir(artifacts, { recursive: true, mode: 0o700 });
const sockets = new Set<Socket>();
const track = (s: Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); };
let localOnly = false, capture = false, e: Environment | undefined;
let captureSuffix = '';
const decisions: { at: string; destination: string; allowed: boolean; phase: string }[] = [];
const relay = createServer((req, res) => {
  const outgoing = httpRequest({ hostname: '127.0.0.1', port: labURL.port, path: req.url, method: req.method,
    headers: { ...req.headers, host: labURL.host } }, response => {
    res.writeHead(response.statusCode!, response.headers); response.pipe(res);
    response.on('aborted', () => res.destroy());
  });
  outgoing.on('error', () => res.destroy()); res.on('close', () => outgoing.destroy()); req.pipe(outgoing);
});
relay.on('connection', track);
await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
const relayPort = (relay.address() as { port: number }).port;
const proxy = createServer((_req, res) => { res.writeHead(405); res.end(); });
proxy.on('connection', track);
proxy.on('connect', (req, client, head) => {
  if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('mu:claude-fixture').toString('base64')}`) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
  const target = new URL(`http://${req.url}`), fixture = target.hostname === '203.0.113.80' && Number(target.port || 80) === 80;
  const provider = /(^|\.)(anthropic\.com|claude\.ai|claude\.com)$/.test(target.hostname);
  const allowed = fixture || (!localOnly && !provider);
  decisions.push({ at: new Date().toISOString(), destination: req.url!, allowed, phase: localOnly ? 'client-local-only' : 'dependency-setup' });
  if (!allowed) { client.end('HTTP/1.1 403 Local Test Only\r\n\r\n'); return; }
  const remote = connect(fixture ? relayPort : Number(target.port) || 80, fixture ? '127.0.0.1' : target.hostname, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client);
  });
  track(remote); remote.on('error', () => client.destroy()); client.on('error', () => remote.destroy()); client.on('close', () => remote.destroy());
});
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = (proxy.address() as { port: number }).port;
const live = () => manager.store.get(e!.id);
const guest = (args: string[], timeoutMs = 30_000) => manager.runtime.guest(live(), args, { timeoutMs });
const management = (args: string[], input?: string) => manager.runtime.management(live(), args, { input, timeoutMs: 30_000 });
async function finish(job: Job) {
  await manager.tasks.get(job.id)?.promise;
  const done = manager.store.jobs().find(j => j.id === job.id)!;
  assert.equal(done.status, 'succeeded', done.message);
}
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Condition observation timed out'); await delay(100); }
}
const cli = (scenario: string) => ['env',
  `ANTHROPIC_BASE_URL=http://203.0.113.80`, `ANTHROPIC_API_KEY=${MOCK_CREDENTIAL}`,
  'CLAUDE_CONFIG_DIR=/home/dev/.mu-claude-account-free', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
  'DISABLE_AUTOUPDATER=1', 'DISABLE_TELEMETRY=1', 'DISABLE_ERROR_REPORTING=1', 'API_TIMEOUT_MS=10000',
  'claude', '-p', `MU_LAB_CLAUDE_${scenario}`, '--model', 'claude-sonnet-4-5-20250929',
  '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--max-turns', '6',
  '--tools', 'Read,Write,Bash', '--allowedTools', 'Read,Write,Bash', '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--no-chrome'];
function events(text: string) { return text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)); }
async function success(scenario: string, file: string) {
  await manager.assertAccess(e!.id, true);
  let output = '';
  try { await manager.runtime.guest(live(), cli(scenario), { timeoutMs: 60_000, onOutput: chunk => { output += chunk; } }); }
  finally { await writeFile(path.join(artifacts, file), output, { mode: 0o600 }); }
  const parsed = events(output), result = parsed.find(v => v.type === 'result');
  assert.ok(result && !result.is_error, output.slice(-4000));
  return parsed;
}
async function startCapture(suffix = '') {
  captureSuffix = suffix;
  await management(['bash', '-s'], `set -eu\nsudo install -d -m 0700 /var/log/mucodesandbox\nsudo systemd-run --quiet --unit=mu-claude-capture${suffix} --property=Type=exec /usr/bin/tcpdump --immediate-mode -U -i any -s 0 -w /var/log/mucodesandbox/claude-client${suffix}.pcap\nsleep 1\ntest "$(sudo stat -c %s /var/log/mucodesandbox/claude-client${suffix}.pcap)" -ge 24\n`);
  capture = true;
}
async function stopCapture() {
  if (!capture) return; capture = false;
  await management(['sudo', 'systemctl', 'stop', `mu-claude-capture${captureSuffix}.service`]);
  await management(['sudo', 'install', '-o', 'mu', '-g', 'mu', '-m', '0600', `/var/log/mucodesandbox/claude-client${captureSuffix}.pcap`, '/tmp/mu-claude-export.pcap']);
  await manager.runtime.command(['copy', `${e!.instanceName}:/tmp/mu-claude-export.pcap`, path.join(artifacts, `network${captureSuffix}.pcap`)]);
  const text = await management(['sudo', 'tcpdump', '-nn', '-r', `/var/log/mucodesandbox/claude-client${captureSuffix}.pcap`]);
  await writeFile(path.join(artifacts, `network${captureSuffix}.txt`), text, { mode: 0o600 });
  const gateway = (await management(['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+)/)![1];
  const outgoing = text.split('\n').filter(line => /^\S+\s+eth0\s+Out\s+IP6?\s/.test(line));
  assert.ok(outgoing.length > 0);
  assert.ok(outgoing.every(line => !/\sIP6\s/.test(line) && (line.includes(` > ${gateway}.${proxyPort}:`) || line.includes('.22 > ') || line.includes('.68 > '))), 'Unexpected physical egress');
  report.captures ??= [];
  report.captures.push({ file: `network${captureSuffix}.pcap`, physicalOutPackets: outgoing.length, onlyApprovedProxyManagementDhcp: true });
}
try {
  e = manager.store.list()[0];
  if (e) {
    await manager.reconcile();
    await finish(await manager.lifecycle(e.id, 'start')); await finish(await manager.lifecycle(e.id, 'stop'));
    e = await manager.update(e.id, { name: e.name, cpus: e.cpus, memoryGiB: e.memoryGiB, diskGiB: e.diskGiB,
      identity: e.identity, network: { ...e.network, port: proxyPort } });
  } else e = await manager.create({ name: 'Real Claude client account-free verification', cpus: 2, memoryGiB: 2, diskGiB: 10,
    identity: { timezone: 'UTC', locale: 'en-US' }, network: { mode: 'http', host: '127.0.0.1', port: proxyPort, username: 'mu', password: 'claude-fixture', noProxy: '', strict: true, transparent: true } });
  console.log('Starting disposable strict VM and installing the real Claude Code client.');
  await finish(await manager.lifecycle(e.id, 'start'));
  const installed = await manager.runtime.agentStatus(live());
  if (!installed.installed) await finish(await manager.lifecycle(e.id, 'install-agent'));
  report.client = await manager.runtime.agentStatus(live()); assert.ok(report.client.installed);
  localOnly = true;
  // Close setup connections so no reused download socket survives the phase boundary.
  for (const socket of sockets) socket.destroy();
  await guest(['mkdir', '-p', '/workspace/mu-claude-account-free']);
  await guest(['rm', '-f', MOCK_FILE, '/workspace/mu-claude-account-free/MUST_NOT_EXIST']);
  await startCapture();
  console.log('Checking actual streamed tool execution and guest user identity.');
  const startIndex = lab.messages.length;
  const toolEvents = await success('TOOLS', 'tools.jsonl');
  assert.equal(await guest(['cat', MOCK_FILE]), MOCK_CONTENT);
  const taskReceipts = lab.messages.slice(startIndex).filter(r => r.scenario === 'TOOLS');
  const final = taskReceipts.find(r => r.emittedTool === null)!;
  assert.ok(final); assert.equal(final.toolResults.length, 3); assert.ok(final.toolResults.every(r => !r.error));
  assert.match(JSON.stringify(final.toolResults.find(r => r.id === 'toolu_mu_2')?.content), /dev/);
  assert.match(JSON.stringify(final.toolResults.find(r => r.id === 'toolu_mu_2')?.content), /MU_REAL_CLAUDE_TOOL_OK/);
  assert.ok(toolEvents.some(v => v.type === 'stream_event' && v.event?.type === 'content_block_delta'));
  report.tools = { actualWriteReadBash: true, guestUser: 'dev', toolResults: 3, fragmentedJsonAndStreaming: true };
  console.log('Cancelling a real client while its response stream remains open.');
  let cancellationOutput = '';
  const cancelAtIndex = lab.messages.length;
  const job = manager.submit(e.id, 'claude-client-fixture', async options => {
    await manager.assertAccess(e!.id, true);
    await manager.runtime.guest(live(), cli('WAIT'), { ...options, timeoutMs: 60_000, onOutput: chunk => { cancellationOutput += chunk; options.onOutput?.(chunk); } });
  });
  await until(() => lab.messages.slice(cancelAtIndex).some(r => r.scenario === 'WAIT') && cancellationOutput.includes('MU_REAL_CLAUDE_WAITING'));
  manager.cancel(job.id); await manager.tasks.get(job.id)?.promise;
  assert.equal(manager.store.jobs().find(j => j.id === job.id)?.status, 'cancelled');
  await until(() => lab.messages.slice(cancelAtIndex).filter(r => r.scenario === 'WAIT').every(r => r.disconnected), 10_000);
  // A diagnostic job is deliberately treated as an environment error by Manager;
  // inspect through management, then use the ordinary restart recovery path.
  assert.equal((await management(['bash', '-c', "pgrep -u dev -af 'claude -p MU_LAB_CLAUDE_WAIT' | grep -v pgrep || true"])).trim(), '');
  await writeFile(path.join(artifacts, 'cancel.jsonl'), cancellationOutput, { mode: 0o600 });
  report.cancellation = { actualJobEngineCancel: true, streamClosed: true, guestProcessExited: true, resultingEnvironmentState: live().state };
  await stopCapture();
  await finish(await manager.lifecycle(e.id, 'restart'));
  await startCapture('-after');
  console.log('Checking guest deadline cleanup with a process that ignores SIGTERM.');
  let stubbornOutput = '', timeoutError: unknown;
  try {
    await manager.runtime.guest(live(), ['python3', '-c', "import os,signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nprint('MU_STUBBORN_PID='+str(os.getpid()),flush=True)\ntime.sleep(120)"],
      { timeoutMs: 5000, onOutput: chunk => { stubbornOutput += chunk; } });
  } catch (error) { timeoutError = error; }
  const stubbornPid = stubbornOutput.match(/MU_STUBBORN_PID=(\d+)/)?.[1];
  assert.ok(stubbornPid, 'Missing positive evidence that the stubborn guest process started');
  assert.equal((timeoutError as any)?.code, 'TIMEOUT');
  await until(async () => {
    try { await guest(['kill', '-0', stubbornPid!]); return false; } catch { return true; }
  });
  report.guestDeadline = { ignoresSigtermPositiveControl: true, timeoutReported: true, guestProcessExited: true };
  console.log('Truncating tool JSON mid-stream; observing retries and cancelling without executing partial tools.');
  let cutOutput = '', cutError: unknown, cutDone = false;
  const cutAt = Date.now(), cutIndex = lab.messages.length, cutController = new AbortController();
  const cutOperation = manager.runtime.guest(live(), cli('CUT'), { signal: cutController.signal, timeoutMs: 60_000, onOutput: chunk => { cutOutput += chunk; } })
    .catch(error => { cutError = error; }).finally(() => { cutDone = true; });
  await until(() => cutDone || lab.messages.slice(cutIndex).filter(r => r.scenario === 'CUT' && r.disconnected).length >= 2, 30_000);
  const cancelledRetries = !cutDone;
  if (cancelledRetries) cutController.abort();
  await cutOperation;
  if (cancelledRetries) assert.equal((cutError as any)?.code, 'CANCELLED');
  else assert.notEqual((cutError as any)?.code, 'TIMEOUT', 'A timeout is not evidence of natural client failure');
  await writeFile(path.join(artifacts, 'disconnect.jsonl'), cutOutput, { mode: 0o600 });
  const cutResult = events(cutOutput).find(v => v.type === 'result');
  assert.ok(cutError || cutResult?.is_error, 'Truncated stream was reported successful');
  assert.ok(lab.messages.slice(cutIndex).some(r => r.scenario === 'CUT' && r.disconnected));
  await assert.rejects(guest(['test', '-e', '/workspace/mu-claude-account-free/MUST_NOT_EXIST']));
  assert.equal((await management(['bash', '-c', "pgrep -u dev -af 'claude -p MU_LAB_CLAUDE_CUT' | grep -v pgrep || true"])).trim(), '');
  report.disconnect = { actualStreamTruncated: true, naturalClientFailure: !cancelledRetries, cancelledRetries,
    attempts: lab.messages.slice(cutIndex).filter(r => r.scenario === 'CUT').length, partialToolNotExecuted: true, guestProcessExited: true, elapsedMs: Date.now() - cutAt };
  await success('TEXT', 'recovered.jsonl'); report.freshRunAfterFaults = true;
  await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '4', 'https://93.184.215.14/']));
  assert.ok(decisions.some(d => d.phase === 'client-local-only' && !d.allowed));
  assert.ok(decisions.filter(d => d.phase === 'client-local-only' && d.allowed).every(d => d.destination === '203.0.113.80:80'));
  report.onlyLocalMockPermittedDuringClient = true;
  report.protection = await manager.runtime.networkProtection(live()); assert.equal(report.protection.active, true);
  await stopCapture(); report.passed = true;
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
finally {
  if (capture) await stopCapture().catch(error => { report.captureError = String(error); });
  report.messages = [...lab.messages]; report.proxyDecisions = decisions;
  if (e) report.logs = manager.store.logs(e.id).slice(-12);
  await Promise.all([...manager.quarantines.values()]);
  if (e) await manager.lifecycle(e.id, 'stop').then(finish).catch(error => { report.cleanupError = String(error); });
  if (report.passed && e && !report.cleanupError) await manager.lifecycle(e.id, 'delete').then(finish).catch(error => { report.cleanupError = String(error); });
  await manager.close();
  for (const socket of sockets) socket.destroy();
  await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => relay.close(() => resolve())), lab.close()]);
  if (report.passed && !report.cleanupError) await rm(directory, { recursive: true, force: true }); else report.retainedDataDir = directory;
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'test-results', 'claude-client.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, client: report.client, tools: report.tools, cancellation: report.cancellation, disconnect: report.disconnect, error: report.error, retainedDataDir: report.retainedDataDir }, null, 2));
}
