// Read-only evidence from the installed desktop service. Never mutate user data.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [label, environmentId] = process.argv.slice(2);
if (!label || !/^[a-z-]{1,40}$/.test(label) || !environmentId) {
  throw new Error('Usage: node scripts/inspect-retina-delivery.ts <label> <environment UUID>');
}
const info = JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json', 'utf8'));
const launch = await fetch(info.launchUrl, { redirect: 'manual' });
const cookie = launch.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('Desktop session unavailable');
const html = await (await fetch(info.url, { headers: { Cookie: cookie } })).text();
const config = JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const headers = { Authorization: `Bearer ${config.token}` };
const [snapshot, browser] = await Promise.all([
  fetch(`${info.url}/api/snapshot`, { headers }).then(r => r.json()),
  fetch(`${info.url}/api/environments/${environmentId}/guest-browser`, { headers }).then(r => r.json()),
]) as any[];
const environment = snapshot.environments.find((e: any) => e.id === environmentId);
if (!environment) throw new Error('Environment not found');
const report = {
  label, recordedAt: new Date().toISOString(), pid: info.pid,
  version: snapshot.system.version, application: snapshot.system.application,
  environment: { id: environment.id, name: environment.name, state: environment.state,
    identity: environment.identity, network: { mode: environment.network.mode,
      host: environment.network.host, port: environment.network.port,
      strict: environment.network.strict, transparent: environment.network.transparent } },
  browser,
};
if (!browser.ready || !browser.display?.matched || browser.display.scaleFactor !== 2) {
  throw new Error(`Native Retina display is not matched: ${JSON.stringify(browser)}`);
}
await writeFile(resolve('test-results', `retina-${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
