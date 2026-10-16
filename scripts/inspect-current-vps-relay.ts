import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const label = 'local.mucodesandbox.relay-dedione-lax';
const directory = '/Users/staff/.mucodesandbox/remote/dedione-lax-166-88-36-199';
const plist = `/Users/staff/Library/LaunchAgents/${label}.plist`;
const environmentId = '76c193f7-09a2-4544-83b8-4852445ab2be';
assert.ok(process.platform === 'darwin', 'This inspection is for the current Mac relay');
assert.ok(process.argv.slice(2).every(value => value === '--save'), 'Only --save is supported');

const configuration = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]));
const args: string[] = configuration.ProgramArguments;
assert.equal(configuration.Label, label);
assert.equal(args[0], '/usr/bin/ssh');
assert.equal(args.at(-1), 'mu-relay@166.88.36.199');
assert.equal(args[args.indexOf('-D') + 1], '127.0.0.1:24898');
let job = '', jobAvailable = false;
try { job = await run('/bin/launchctl', ['print', `gui/${process.getuid!()}/${label}`]); jobAvailable = true; } catch {}
const pidText = job.match(/^\s*pid = (\d+)$/m)?.[1];
const pid = pidText ? Number(pidText) : null;
let command = '', started: string | null = null, loopbackListening = false;
if (pid !== null && pid > 1) {
  try { command = await run('/bin/ps', ['-p', String(pid), '-o', 'command=']); } catch {}
  try { started = (await run('/bin/ps', ['-p', String(pid), '-o', 'lstart='])).trim(); } catch {}
  try {
    const listener = await run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP:24898', '-sTCP:LISTEN']);
    loopbackListening = /127\.0\.0\.1:24898 \(LISTEN\)/.test(listener);
  } catch {}
}
const launchCount = job.match(/^\s*runs = (\d+)$/m)?.[1];
const previousExitCode = job.match(/^\s*last exit code = (\d+)$/m)?.[1];

const info = JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json', 'utf8'));
const launch = await fetch(info.launchUrl, { redirect: 'manual' });
const cookie = launch.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie, 'Desktop session unavailable');
const html = await (await fetch(info.url, { headers: { Cookie: cookie } })).text();
const config = JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
async function api(suffix: string) {
  const response = await fetch(`${info.url}/api/${suffix}`, { headers: { Authorization: `Bearer ${config.token}` } });
  assert.ok(response.ok, `Inspection failed: ${response.status}`);
  return response.json() as Promise<any>;
}
const snapshot = await api('snapshot');
const environment = snapshot.environments.find((entry: any) => entry.id === environmentId);
assert.ok(environment, 'Existing environment unavailable');
const [egress, events] = await Promise.all([
  api(`environments/${environmentId}/network/egress`),
  api(`environments/${environmentId}/protection-events`),
]);
const legacy = path.join(directory, 'tunnel.stderr.log');
const legacyInfo = await stat(legacy);
const legacyBytes = await readFile(legacy);
const logs = JSON.parse(await run('/usr/bin/log', [
  'show', '--style', 'json', '--last', '30m', '--predicate',
  `process == "ssh" AND (${pid === null ? '' : `processID == ${pid} OR `}eventMessage CONTAINS[c] "166.88.36.199")`,
], { timeoutMs: 15_000, maxBytes: 1_000_000 }));

const report = {
  at: new Date().toISOString(),
  scope: 'Read-only current relay inspection; no new probes, routing changes or authentication',
  relay: {
    label, jobAvailable, pid, started, loopbackListener: '127.0.0.1:24898', loopbackListening,
    configuredSyslog: args.includes('-y'), runningSyslog: command ? /(?:^|\s)-y(?:\s|$)/.test(command) : null,
    launchCount: launchCount === undefined ? null : Number(launchCount),
    previousExitCode: previousExitCode === undefined ? null : Number(previousExitCode),
    hostKeyVerification: args.includes('StrictHostKeyChecking=yes'),
    physicalInterface: args.includes('ProxyCommand=/usr/bin/nc -4 -b en0 -G 10 %h %p') ? 'en0' : 'unknown',
    legacyLog: {
      modifiedAt: legacyInfo.mtime.toISOString(), bytes: legacyInfo.size,
      sha256: createHash('sha256').update(legacyBytes).digest('hex'),
      perEntryTimesAvailable: false,
    },
    recentSystemMessages: logs.map((entry: any) => ({
      at: entry.timestamp, pid: entry.processID, currentRelayProcess: pid !== null && entry.processID === pid,
      message: String(entry.eventMessage).slice(0, 1000),
    })),
  },
  application: { version: snapshot.system.version, build: snapshot.system.application.buildId },
  environment: { id: environmentId, state: environment.state, browserRunning: environment.browserRunning },
  egress,
  latestFault: events[0] ?? null,
  limitations: 'Messages from an older PID that mention this VPS are candidates, not proof of managed-relay ownership. Old untimestamped stderr cannot be assigned to a past fault. A relay timeout alone does not locate the failing network hop. Missing process metadata is unknown, not a successful check.',
};
if (process.argv.includes('--save')) {
  const destination = path.join(root, 'test-results/egress-diagnostics');
  await mkdir(destination, { recursive: true });
  const file = path.join(destination, `vps-relay-${report.at.replaceAll(':', '-')}.json`);
  await writeFile(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ file, ...report }, null, 2));
} else {
  console.log(JSON.stringify(report, null, 2));
}
