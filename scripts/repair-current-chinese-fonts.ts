// Narrow, authorized maintenance: fonts only; never changes a guard or profile.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LimaRuntime } from '../server/runtime.ts';
import type { Environment } from '../shared/types.ts';

const id = '76c193f7-09a2-4544-83b8-4852445ab2be';
const results = path.resolve(import.meta.dirname, '../test-results/chinese-font-repair');
const info = JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json', 'utf8'));
const launch = await fetch(info.launchUrl, { redirect: 'manual' });
const cookie = launch.headers.get('set-cookie')!.split(';')[0];
const html = await (await fetch(info.url, { headers: { Cookie: cookie } })).text();
const config = JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
async function api(route: string) {
  const response = await fetch(info.url + route, { headers: { Authorization: `Bearer ${config.token}`, Cookie: cookie } });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}
const e = (await api('/api/snapshot')).environments.find((row: Environment) => row.id === id) as Environment;
assert.ok(e?.state === 'running' && e.network.strict && e.network.transparent);
const runtime = new LimaRuntime('/Users/staff/.mucodesandbox');
const report: Record<string, any> = { startedAt: new Date().toISOString(), passed: false, environmentId: id, profileTouched: false };
const command = (args: string[], input?: string, timeoutMs = 15_000) => runtime.management(e, args, { input, timeoutMs, maxBytes: 64_000 });
try {
  report.before = await api(`/api/environments/${id}/network/protection`);
  assert.ok(report.before.active && report.before.integrity === 'verified' && report.before.leaseActive);
  report.browserBefore = await command(['systemctl', 'show', 'mucodesandbox-browser.service', '-p', 'MainPID', '-p', 'ActiveState']);
  report.fontBefore = await command(['sudo', '-H', '-u', 'dev', '--', 'env', '-i', 'HOME=/home/dev', 'PATH=/usr/bin:/bin', 'LANG=en_US.UTF-8', 'fc-match', '-f', '%{family}\t%{file}\n', 'sans-serif:lang=zh-cn']);
  console.log('Installing only fonts-noto-cjk through the existing protected guest network.');
  report.install = await command(['bash', '-s'], `set -euo pipefail
if ! dpkg-query -W -f='\${db:Status-Status}' fonts-noto-cjk 2>/dev/null | grep -qx installed; then
  sudo env DEBIAN_FRONTEND=noninteractive SYSTEMD_OFFLINE=1 NEEDRESTART_MODE=l apt-get -y --no-install-recommends --no-remove -o APT::Sandbox::User=dev -o Acquire::Retries=1 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::http::Dl-Limit=2048 -o Acquire::https::Dl-Limit=2048 install fonts-noto-cjk
fi
sudo -H -u dev -- fc-cache -f
dpkg-query -W -f='\${Package}\t\${Version}\t\${db:Status-Status}\\n' fonts-noto-cjk
`, 180_000);
  report.fontAfter = await command(['sudo', '-H', '-u', 'dev', '--', 'env', '-i', 'HOME=/home/dev', 'PATH=/usr/bin:/bin', 'LANG=en_US.UTF-8', 'bash', '-c', `for pattern in 'sans-serif:lang=zh-cn' 'sans-serif:lang=zh-cn:weight=bold' 'sans-serif:charset=98ce' 'serif:lang=zh-cn' 'monospace:lang=zh-cn'; do fc-match -f '%{family}\t%{style}\t%{file}\n' "$pattern"; done`]);
  assert.match(report.fontAfter, /Noto Sans CJK/);
  report.after = await api(`/api/environments/${id}/network/protection`);
  assert.ok(report.after.active && report.after.integrity === 'verified' && report.after.leaseActive);
  for (const key of ['firewallHash', 'bootFileHash', 'tunnelConfigHash', 'leaseRulesHash', 'leaseBootHash']) assert.equal(report.after[key], report.before[key]);
  report.browserAfter = await command(['systemctl', 'show', 'mucodesandbox-browser.service', '-p', 'MainPID', '-p', 'ActiveState']);
  assert.equal(report.browserAfter, report.browserBefore);
  report.receipts = [];
  for (const [provider, url] of [['ipify', 'https://api.ipify.org'], ['icanhazip', 'https://ipv4.icanhazip.com']]) {
    const ip = (await command(['sudo', '-H', '-u', 'dev', '--', 'env', '-i', 'HOME=/home/dev', 'PATH=/usr/bin:/bin', '/usr/bin/curl', '-q', '--ipv4', '--fail', '--silent', '--show-error', '--proto', '=https', '--proxy', '', '--noproxy', '*', '--connect-timeout', '8', '--max-time', '12', url], undefined, 16_000)).trim();
    assert.equal(ip, '166.88.36.199');
    report.receipts.push({ provider, ip, checkedAt: new Date().toISOString() });
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(results, { recursive: true });
  await writeFile(path.join(results, 'install.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, before: report.fontBefore, after: report.fontAfter, receipts: report.receipts, browserPidUnchanged: report.browserBefore === report.browserAfter, error: report.error }, null, 2));
}
