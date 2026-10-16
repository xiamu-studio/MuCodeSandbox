import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { createService } from '../server/service.ts';
import type { Environment, Job } from '../shared/types.ts';
import { GUEST_CHROMIUM_VERSION } from '../server/guest-browser-runtime.ts';

interface Identity {
  timezone: string; locale: string; language: string; languages: string[];
  platform: string; userAgent: string; cores: number;
}
interface State { cookie: string; documentCookie: string; localStorage: string | null; indexedDB: string | null }
interface Receipt {
  phase: string; page: Identity; worker: Identity; iframe: Identity;
  state: State; headers: Record<string, string>; error?: string;
}

const root = path.resolve(import.meta.dirname, '..');
const reportName = process.env.MU_PROFILE_TEST_REPORT ?? 'browser-profiles.json';
assert.match(reportName, /^browser-profiles(?:-[a-z0-9-]+)?\.json$/, 'Profile reports must remain in this verifier\'s result files');
const temporary = process.env.MU_PROFILE_TEST_DATA ? path.resolve(process.env.MU_PROFILE_TEST_DATA) : await mkdtemp(path.join(homedir(), '.mu-profile-verification-'));
assert.equal(path.dirname(temporary), homedir(), 'Only this verifier\'s private home directory is reusable');
assert.match(path.basename(temporary), /^\.mu-profile-verification-[A-Za-z0-9]+$/, 'Only a profile verification directory is reusable');
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const receipts: Receipt[] = [];
const sockets = new Set<Socket>();
const requests: { path: string; cookie: string }[] = [];
const destinations: string[] = [];
const report: Record<string, any> = {
  passed: false, startedAt: new Date().toISOString(), dataDir: temporary,
  noClaudeLoginOrModelCalls: true, steps: [],
  diagnosticRootPagesOnly: process.env.MU_PROFILE_TEST_ROOT_PAGE_ONLY === '1',
  diagnosticRelatedPageTargetsOnly: process.env.MU_PROFILE_TEST_RELATED_TARGETS_ONLY === '1',
  diagnosticRendererReadyBarrier: process.env.MU_PROFILE_TEST_RENDERER_BARRIER === '1',
  diagnosticDisableGpu: process.env.MU_PROFILE_TEST_DISABLE_GPU === '1',
  diagnosticChromeNetlog: process.env.MU_PROFILE_TEST_NETLOG === '1',
  freshVmDisks: process.env.MU_PROFILE_TEST_FRESH_VM === '1',
};
const fixtureHost = '203.0.113.30';
const fixtureOrigin = `http://${fixtureHost}`;
const routeEvidenceScript = `import json,os,pathlib,subprocess
def command(args):return subprocess.check_output(args,text=True)
policy=pathlib.Path('/etc/systemd/networkd.conf.d/99-mucodesandbox.conf')
print(json.dumps({'uid':os.getuid(),'route':command(['ip','-4','route','get','${fixtureHost}','uid',str(os.getuid())]),'rules':command(['ip','-4','rule']),'routes':command(['ip','-4','route','show','table','all']),'networkdPolicy':policy.read_text(),'networkdPolicyUid':policy.stat().st_uid,'networkdPolicyMode':oct(policy.stat().st_mode & 0o777),'effectiveNetworkdConfig':command(['systemd-analyze','cat-config','systemd/networkd.conf'])}))`;
const identitySource = `() => ({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,language:navigator.language,languages:[...navigator.languages],platform:navigator.platform,userAgent:navigator.userAgent,cores:navigator.hardwareConcurrency})`;

const target = createServer((request, response) => {
  const url = new URL(request.url ?? '/', fixtureOrigin);
  if (requests.length < 1000) requests.push({ path: `${url.pathname}${url.search}`, cookie: request.headers.cookie ?? '' });
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/receipt') {
    let body = '';
    request.on('data', chunk => { body += chunk; if (body.length > 65536) request.destroy(); });
    request.on('end', () => {
      try { receipts.push(JSON.parse(body)); response.end('ok'); }
      catch { response.writeHead(400); response.end(); }
    });
    return;
  }
  if (url.pathname === '/login') {
    const owner = url.searchParams.get('owner');
    if (owner !== 'account-a' && owner !== 'account-b') { response.writeHead(400); response.end(); return; }
    response.setHeader('Set-Cookie', `synthetic=${owner}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
    response.end('ok');
    return;
  }
  if (url.pathname === '/cookie') { response.end(request.headers.cookie ?? ''); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.pathname === '/frame') {
    response.end(`<!doctype html><script>parent.postMessage({type:'mu-profile-frame',identity:(${identitySource})()},location.origin)</script>`);
    return;
  }
  const headers = JSON.stringify(request.headers).replaceAll('<', '\\u003c');
  response.end(`<!doctype html><html><head><title>Mu profile fixture</title></head><body><h1>Mu profile fixture</h1><script>
  const actual = ${identitySource};
  const query = new URLSearchParams(location.search);
  const phase = query.get('phase');
  const database = () => new Promise((resolve,reject) => {
    const request = indexedDB.open('mu-synthetic-profile',1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  const readIndexed = async () => {
    const db = await database();
    try { return await new Promise((resolve,reject) => {
      const request = db.transaction('state').objectStore('state').get('owner');
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    }); } finally { db.close(); }
  };
  const writeIndexed = async owner => {
    const db = await database();
    try { await new Promise((resolve,reject) => {
      const transaction = db.transaction('state','readwrite');
      transaction.objectStore('state').put(owner,'owner');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(new Error('IndexedDB write aborted'));
    }); } finally { db.close(); }
  };
  const workerIdentity = () => new Promise((resolve,reject) => {
    const blob = URL.createObjectURL(new Blob(['postMessage(('+actual.toString()+')())'],{type:'text/javascript'}));
    const worker = new Worker(blob);
    const timer = setTimeout(() => { worker.terminate(); URL.revokeObjectURL(blob); reject(new Error('Worker identity timeout')); },10000);
    worker.onmessage = event => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(blob); resolve(event.data); };
    worker.onerror = event => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(blob); reject(new Error(event.message)); };
  });
  const frameIdentity = () => new Promise((resolve,reject) => {
    const frame = document.createElement('iframe');
    const timer = setTimeout(() => { removeEventListener('message',receive); reject(new Error('Frame identity timeout')); },10000);
    const receive = event => {
      if(event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== 'mu-profile-frame') return;
      clearTimeout(timer); removeEventListener('message',receive); resolve(event.data.identity);
    };
    addEventListener('message',receive); frame.src = '/frame'; document.body.append(frame);
  });
  window.__MU_PROFILE_RESULT__ = (async () => {
    if(location.pathname === '/write') {
      const owner = query.get('owner');
      const login = await fetch('/login?owner='+encodeURIComponent(owner));
      if(!login.ok) throw new Error('Synthetic login failed');
      localStorage.setItem('mu-owner',owner);
      await writeIndexed(owner);
    }
    const [worker,iframe,indexed] = await Promise.all([workerIdentity(),frameIdentity(),readIndexed()]);
    const state = {cookie:await(await fetch('/cookie')).text(),documentCookie:document.cookie,localStorage:localStorage.getItem('mu-owner'),indexedDB:indexed};
    const result = {phase,page:actual(),worker,iframe,state,headers:${headers}};
    await fetch('/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
    return result;
  })().catch(async error => {
    const result = {phase,error:String(error)};
    await fetch('/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
    return result;
  });
  </script></body></html>`);
});
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const targetPort = (target.address() as { port: number }).port;
const proxyAuthorization = `Basic ${Buffer.from('mu:profile-verification').toString('base64')}`;
let proxyConnections = 0;
const proxy = createServer((request, response) => {
  if (request.headers['proxy-authorization'] !== proxyAuthorization) {
    response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Mu profile test"' }); response.end(); return;
  }
  try {
    const url = new URL(request.url!);
    if (url.hostname === fixtureHost) { url.hostname = '127.0.0.1'; url.port = String(targetPort); }
    const headers = { ...request.headers }; delete headers['proxy-authorization'];
    const remote = httpRequest(url, { method: request.method, headers }, result => { response.writeHead(result.statusCode!, result.headers); result.pipe(response); });
    remote.on('error', () => { response.writeHead(502); response.end(); });
    request.pipe(remote);
  } catch { response.writeHead(400); response.end(); }
});
proxy.on('connect', (request, client, head) => {
  if (request.headers['proxy-authorization'] !== proxyAuthorization) {
    client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Mu profile test"\r\n\r\n'); return;
  }
  const destination = new URL(`https://${request.url}`);
  if (destinations.length < 1000) destinations.push(request.url!);
  const localFixture = destination.hostname === fixtureHost;
  const remote = connect(localFixture ? targetPort : Number(destination.port) || 443, localFixture ? '127.0.0.1' : destination.hostname, () => {
    proxyConnections++;
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) remote.write(head);
    client.pipe(remote); remote.pipe(client);
  });
  sockets.add(remote); remote.on('close', () => sockets.delete(remote));
  remote.on('error', () => client.destroy()); client.on('error', () => remote.destroy()); client.on('close', () => remote.destroy());
});
proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = (proxy.address() as { port: number }).port;
const service = await createService({ rootDir: root, port: 0, dataDir: temporary });
const manager = service.manager;
const management = manager.runtime.management.bind(manager.runtime);
manager.runtime.management = async (e, args, options = {}) => {
  let injected = false;
  let netlogInjected = false;
  if (report.diagnosticDisableGpu && options.input?.includes('export CHROME_DEVEL_SANDBOX=')) {
    const quotedFlag = "'--disable-quic'".replaceAll("'", "'\\''");
    const replacement = "'--disable-gpu' '--disable-quic'".replaceAll("'", "'\\''");
    assert.ok(options.input.includes(quotedFlag), 'The diagnostic must change only the known browser launcher');
    options = { ...options, input: options.input.replace(quotedFlag, replacement) };
    injected = true;
  }
  if (report.diagnosticChromeNetlog && options.input?.includes('export CHROME_DEVEL_SANDBOX=')) {
    const quotedFlag = "'--disable-quic'".replaceAll("'", "'\\''");
    const replacement = "'--log-net-log=/tmp/mu-profile-netlog.json' '--net-log-duration=12' '--net-log-max-size-mb=10' '--disable-quic'".replaceAll("'", "'\\''");
    assert.ok(options.input.includes(quotedFlag));
    options = { ...options, input: options.input.replace(quotedFlag, replacement) };
    netlogInjected = true;
  }
  const result = await management(e, args, options);
  if (injected || netlogInjected) {
    const flags = JSON.parse((await management(e, ['python3', '-c', `import json,pathlib
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit(): continue
 try:
  if str((p/'exe').resolve())!='/opt/mucodesandbox/chromium-${GUEST_CHROMIUM_VERSION}/chrome-linux-arm64/chrome': continue
  flags=(p/'cmdline').read_bytes().replace(bytes([0]),b' ').decode(errors='replace').split()
  if not any(flag.startswith('--type=') for flag in flags): print(json.dumps(flags));break
 except OSError: pass`], { timeoutMs: 10_000 })).trim()) as string[];
    if (injected) assert.ok(flags.includes('--disable-gpu') && flags.includes('--disable-quic'), 'GPU diagnostics must preserve two independent, effective flags');
    if (netlogInjected) assert.ok(flags.includes('--log-net-log=/tmp/mu-profile-netlog.json') && flags.includes('--net-log-duration=12'));
    assert.ok(flags.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
    assert.ok(!flags.includes('--no-sandbox') && !flags.includes('--disable-setuid-sandbox'));
    if (injected) (report.diagnosticGpuLaunches ??= []).push({ environmentId: e.id, flags });
    if (netlogInjected) (report.diagnosticNetlogLaunches ??= []).push({ environmentId: e.id, flags });
  }
  return result;
};
const ids: string[] = [];
const metadata = new Map<string, { machineId: string; disk: string; inode: number; profileMode: string }>();
const started = new Set<string>();
let lastEntry: ReturnType<typeof service.guestBrowser.entries.get>;
const diagnostics = new Map<string, Record<string, any>>();
const setEntry = service.guestBrowser.entries.set.bind(service.guestBrowser.entries);
service.guestBrowser.entries.set = (id, entry) => {
  let tools = entry.tools;
  // Observe DevTools before configure() sends its first commands; a polling observer misses fast setup events.
  Object.defineProperty(entry, 'tools', {
    enumerable: true, configurable: true,
    get: () => tools,
    set: (value: typeof tools) => {
      tools = value;
      const diagnostic = diagnostics.get(id);
      if (!value || !diagnostic) return;
      const send = value.send.bind(value);
      value.send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
        if (process.env.MU_PROFILE_TEST_PAGE_ENABLE === '1' && method === 'Page.navigate' && !diagnostic.pageEnabled) {
          diagnostic.pageEnabled = true;
          report.diagnosticPageEnable = true;
          return (async () => {
            await value.send('Page.enable', {}, sessionId);
            return value.send(method, params, sessionId);
          })();
        }
        if (report.diagnosticRendererReadyBarrier && method === 'Page.navigate' && !diagnostic.rendererReadyChecked) {
          diagnostic.rendererReadyChecked = true;
          return (async () => {
            diagnostic.initialRendererLocation = await value.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId);
            return value.send(method, params, sessionId);
          })();
        }
        if (report.diagnosticRootPagesOnly && method === 'Target.setAutoAttach' && !sessionId)
          params = { ...params, filter: [{ type: 'page' }, { exclude: true }] };
        if (report.diagnosticRelatedPageTargetsOnly && method === 'Target.setAutoAttach' && sessionId)
          params = { ...params, filter: [{ type: 'iframe' }, { type: 'worker' }, { type: 'shared_worker' }, { type: 'service_worker' }, { exclude: true }] };
        if (diagnostic.commands.length < 200) diagnostic.commands.push({ at: new Date().toISOString(), id: value.sequence + 1, method, sessionId });
        return send(method, params, sessionId);
      };
      value.socket.on('message', data => {
        try {
          const event = JSON.parse(data.toString());
          if (diagnostic.events.length < 200) diagnostic.events.push({ at: new Date().toISOString(), ...event });
        } catch {}
      });
    },
  });
  return setEntry(id, entry);
};

async function finish(job: Job) {
  await manager.tasks.get(job.id)?.promise;
  const done = manager.store.jobs().find(value => value.id === job.id)!;
  assert.equal(done.status, 'succeeded', `${job.action}: ${done.message}`);
}
async function waitReceipt(phase: string) {
  const end = Date.now() + 30_000;
  while (!receipts.some(receipt => receipt.phase === phase)) {
    assert.ok(Date.now() < end, `No browser receipt for ${phase}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const receipt = receipts.find(value => value.phase === phase)!;
  assert.equal(receipt.error, undefined, receipt.error);
  return receipt;
}
function validateIdentity(e: Environment, receipt: Receipt) {
  assert.equal(receipt.page.timezone, e.identity.timezone);
  assert.equal(receipt.page.locale, e.identity.locale);
  assert.equal(receipt.page.language, e.identity.locale);
  assert.match(receipt.page.platform, /^Linux /);
  assert.deepEqual(receipt.worker, receipt.page);
  assert.deepEqual(receipt.iframe, receipt.page);
  assert.ok(receipt.headers['accept-language'].startsWith(e.identity.locale));
}
function validateState(receipt: Receipt, owner: string | null) {
  assert.deepEqual(receipt.state, {
    cookie: owner ? `synthetic=${owner}` : '', documentCookie: '', localStorage: owner, indexedDB: owner,
  });
}
async function navigate(e: Environment, pathname: string, phase: string) {
  const entry = service.guestBrowser.entries.get(e.id);
  assert.ok(entry?.ready && entry.tools, 'The real Linux browser must be ready');
  const targets = await entry.tools.send('Target.getTargets');
  const page = targets.targetInfos.find((target: { type: string }) => target.type === 'page');
  const session = page && entry.sessions.get(page.targetId);
  assert.ok(session, 'The real browser page must have an attached session');
  const url = new URL(pathname, fixtureOrigin); url.searchParams.set('phase', phase);
  await entry.tools.send('Page.navigate', { url: url.href }, session);
  const receipt = await waitReceipt(phase);
  validateIdentity(e, receipt);
  report.steps.push({ environmentId: e.id, ...receipt });
  return receipt;
}
async function start(e: Environment) {
  console.log(`Starting ${e.name}; one user VM at a time.`);
  await finish(await manager.lifecycle(e.id, 'start'));
  const current = manager.store.get(e.id);
  assert.ok((await manager.runtime.networkProtection(current)).active);
  if (!started.has(e.id)) {
    const captureFile = '/var/log/mucodesandbox/boot-network.pcap';
    const encoded = (await manager.runtime.management(current, ['sudo', 'python3', '-c', `import base64,pathlib;print(base64.b64encode(pathlib.Path('${captureFile}').read_bytes()).decode())`])).trim();
    const bytes = Buffer.from(encoded, 'base64');
    assert.ok(bytes.length > 24, 'The first user boot capture must contain a positive control');
    const capture = await manager.runtime.management(current, ['sudo', 'tcpdump', '-nn', '-r', captureFile]);
    const physical = capture.split('\n').filter(line => /\s(?!lo\b)\S+\s+Out\s+IP6?\s/.test(line));
    const gateway = (await manager.runtime.guest(current, ['ip', '-4', 'route', 'show', 'default'])).match(/default via (\S+)/)?.[1];
    assert.ok(gateway && physical.length > 0, 'First boot must have physical output evidence');
    assert.ok(physical.every(line => !/ IP6 /.test(line)), capture);
    const escapedGateway = gateway.replaceAll('.', '\\.');
    assert.ok(physical.every(line => new RegExp(`\\.22 > ${escapedGateway}\\.`).test(line)
      || new RegExp(` > ${escapedGateway}\\.${proxyPort}:`).test(line)
      || /\.68 > [0-9.]+\.67:/.test(line)), capture);
    const captureState = (await manager.runtime.management(current, ['systemctl', 'show', 'mucodesandbox-boot-capture.service', '--property=ActiveState', '--property=MainPID'])).trim();
    assert.match(captureState, /ActiveState=inactive/);
    assert.match(captureState, /MainPID=0/);
    const artifact = reportName.replace(/\.json$/, `-${e.name === 'Profile A' ? 'a' : 'b'}-first-boot.pcap`);
    await mkdir(path.join(root, 'test-results'), { recursive: true });
    await writeFile(path.join(root, 'test-results', artifact), bytes, { mode: 0o600 });
    (report.firstBootCaptures ??= []).push({ environmentId: e.id, artifact, bytes: bytes.length, physicalOutputPackets: physical.length, onlyApprovedProxySshDhcp: true, noPhysicalIpv6: true, captureStoppedBeforeBrowserInstall: true });
    await manager.runtime.guest(current, ['rm', '-rf', '/home/dev/.local/share/mucodesandbox/browser']);
    started.add(e.id);
  }
  const positive = await manager.runtime.guest(current, ['curl', '--fail', '--silent', '--max-time', '15', `${fixtureOrigin}/positive-network-control`]);
  assert.ok(positive.includes('Mu profile fixture'), 'The fixture must be reachable before browser launch');
  (report.guestStartupMetadata ??= []).push({ environmentId: e.id, values: JSON.parse((await manager.runtime.management(current, ['python3', '-c', `import json,os,pathlib
def read(p):
 try: return pathlib.Path(p).read_text()
 except OSError as e: return str(e)
print(json.dumps({'hostname':os.uname().nodename,'hostnameFile':read('/etc/hostname'),'hosts':read('/etc/hosts'),'cloudConfig':read('/etc/cloud/cloud.cfg'),'apparmorEnabled':read('/sys/module/apparmor/parameters/enabled'),'restrictUserNamespaces':read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),'browserAppArmor':read('/etc/apparmor.d/mucodesandbox-chromium')}))`], { timeoutMs: 10_000 })).trim()) });
  const diagnostic: Record<string, any> = { environmentId: e.id, environmentName: e.name, commands: [], events: [], snapshots: [] };
  diagnostics.set(e.id, diagnostic);
  (report.openDiagnostics ??= []).push(diagnostic);
  const beforeInstallRouting = JSON.parse((await manager.runtime.guest(current, ['python3', '-c', routeEvidenceScript])).trim());
  assert.match(beforeInstallRouting.route, /dev mu_tun/);
  (report.beforeBrowserInstallNetwork ??= []).push({ environmentId: e.id, protection: await manager.runtime.networkProtection(current), ...beforeInstallRouting });
  const opening = await manager.openBrowser(e.id);
  let observed: typeof lastEntry;
  let previousState = '';
  let guestDiagnostic: Promise<void> | undefined;
  let diagnosticTimer: NodeJS.Timeout | undefined;
  const observe = setInterval(() => {
    const entry = service.guestBrowser.entries.get(e.id);
    if (!entry) return;
    lastEntry = entry;
    const state = { ready: entry.ready, sessions: [...entry.sessions], activeSessions: [...(entry.tools?.activeSessions ?? [])], pending: entry.tools?.pending.size, configuration: entry.configuration.size };
    const serialized = JSON.stringify(state);
    if (serialized !== previousState) {
      previousState = serialized;
      if (diagnostic.snapshots.length < 100) diagnostic.snapshots.push({ at: new Date().toISOString(), ...state });
    }
    if (!entry.tools || observed === entry) return;
    observed = entry;
    // Capture the guest while a stuck navigation is still alive, before open() cleans it up.
    diagnosticTimer = setTimeout(() => {
      guestDiagnostic = (async () => {
        const bounded = async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
          let timer: NodeJS.Timeout | undefined;
          try {
            return await Promise.race([
              entry.tools!.send(method, params, sessionId),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method}: diagnostic timeout`)), 1500); }),
            ]);
          } catch (error) { return String(error); }
          finally { clearTimeout(timer); }
        };
        const session = [...entry.sessions.values()][0];
        const [version, targets, frames, location] = await Promise.all([
          bounded('Browser.getVersion'), bounded('Target.getTargets'),
          session ? bounded('Page.getFrameTree', {}, session) : null,
          session ? bounded('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, session) : null,
        ]);
        diagnostic.liveCdp = { version, targets, frames, location };
        diagnostic.liveGuestTargets = await manager.runtime.guest(current, ['curl', '--silent', '--max-time', '3', 'http://127.0.0.1:9222/json/list']).catch(String);
        diagnostic.liveSandboxProcesses = await manager.runtime.management(current, ['sudo', 'python3', '-c', `import json,os,pathlib
def read(p):
 try: return pathlib.Path(p).read_text()
 except OSError as e: return str(e)
processes=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit(): continue
 try:
  executable=str((p/'exe').resolve())
  if executable!='/opt/mucodesandbox/chromium-${GUEST_CHROMIUM_VERSION}/chrome-linux-arm64/chrome': continue
  status={line.split(':',1)[0]:line.split(':',1)[1].strip() for line in read(p/'status').splitlines() if ':' in line}
  command=(p/'cmdline').read_bytes().replace(bytes([0]),b' ').decode(errors='replace')
  threads=[{'tid':t.name,'name':read(t/'comm').strip(),'wchan':read(t/'wchan')} for t in (p/'task').iterdir()]
  processes.append({'pid':p.name,'type':next((part for part in command.split() if part.startswith('--type=')),'browser'),'flags':command,'status':{key:status.get(key) for key in ['State','Uid','Gid','Seccomp','NoNewPrivs']},'wchan':read(p/'wchan'),'threads':threads})
 except OSError: pass
disk=os.statvfs('/home/dev')
print(json.dumps({'processes':processes,'apparmorProfiles':read('/sys/kernel/security/apparmor/profiles'),'memory':read('/proc/meminfo'),'diskAvailableBytes':disk.f_bavail*disk.f_frsize}))`], { timeoutMs: 5000 }).catch(String);
        diagnostic.liveGuestJournal = await manager.runtime.management(current, ['sudo', 'journalctl', '--unit=mucodesandbox-browser.service', '--no-pager', '--lines=25'], { timeoutMs: 5000 }).catch(String);
        diagnostic.liveGuestNetwork = await manager.runtime.management(current, ['sudo', 'python3', '-c', `import json,os,pathlib,subprocess
def command(args):
 try:
  p=subprocess.run(args,text=True,capture_output=True,timeout=2)
  return {'code':p.returncode,'out':p.stdout,'err':p.stderr}
 except Exception as e: return str(e)
namespaces=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit(): continue
 try:
  if str((p/'exe').resolve())!='/opt/mucodesandbox/chromium-${GUEST_CHROMIUM_VERSION}/chrome-linux-arm64/chrome': continue
  flags=(p/'cmdline').read_bytes().replace(bytes([0]),b' ').decode(errors='replace')
  if '--type=utility' in flags and 'NetworkService' in flags:
   namespaces.append({'pid':p.name,'netns':os.readlink(p/'ns/net'),'route':command(['nsenter','-t',p.name,'-n','ip','-4','route','get','${fixtureHost}'])})
 except OSError: pass
print(json.dumps({'hostNetns':os.readlink('/proc/self/ns/net'),'chromeNetworkNamespaces':namespaces,'rules':command(['ip','-4','rule']),'routes':command(['ip','-4','route','show','table','all']),'sockets':command(['ss','-ntup']),'firewall':command(['nft','list','ruleset']),'tunnelJournal':command(['journalctl','--unit=mucodesandbox-tunnel.service','--no-pager','--lines=20']),'systemNetworkJournal':command(['journalctl','--unit=systemd-networkd.service','--unit=systemd-resolved.service','--no-pager','--lines=60'])}))`], { timeoutMs: 6000 }).catch(String);
        diagnostic.liveCurlPositive = await manager.runtime.guest(current, ['curl', '--fail', '--silent', '--connect-timeout', '2', '--max-time', '3', `${fixtureOrigin}/positive-network-control-after-install`], { timeoutMs: 4000 }).catch(String);
      })();
    }, 8000);
  }, 20);
  try { await finish(opening); }
  finally {
    clearInterval(observe);
    clearTimeout(diagnosticTimer);
    await guestDiagnostic;
  }
  const [protection, postInstallPositive, routing] = await Promise.all([
    manager.runtime.networkProtection(current),
    manager.runtime.guest(current, ['curl', '-q', '--fail', '--silent', '--proxy', '', '--noproxy', '*', '--max-time', '10', `${fixtureOrigin}/positive-network-control-after-install`]),
    manager.runtime.guest(current, ['python3', '-c', routeEvidenceScript]),
  ]);
  const route = JSON.parse(routing.trim());
  assert.ok(protection.active && protection.integrity === 'verified', 'Browser installation must retain the approved strict network policy');
  assert.ok(postInstallPositive.includes('Mu profile fixture'), 'Ordinary curl must still work through TUN after browser installation');
  assert.match(route.route, /dev mu_tun/);
  (report.postBrowserInstallNetwork ??= []).push({ environmentId: e.id, protection, ...route, ordinaryCurlThroughTun: true });
  if (!metadata.has(e.id)) {
    const profile = JSON.parse((await manager.runtime.guest(current, ['python3', '-c', `import json,pathlib,stat
p=pathlib.Path('/home/dev/.local/share/mucodesandbox/browser')
print(json.dumps({'machineId':pathlib.Path('/etc/machine-id').read_text().strip(),'profileMode':oct(stat.S_IMODE(p.stat().st_mode))}))`])).trim());
    const disk = path.join(temporary, 'lima', e.instanceName, 'disk');
    metadata.set(e.id, { ...profile, disk, inode: (await stat(disk)).ino });
    assert.equal(profile.profileMode, '0o700');
  }
}
async function closeBrowser(e: Environment) {
  await manager.closeBrowser(e.id);
  assert.equal(service.guestBrowser.info(e.id).running, false);
  const exitType = (await manager.runtime.guest(manager.store.get(e.id), ['python3', '-c', `import json,pathlib
preferences=json.loads(pathlib.Path('/home/dev/.local/share/mucodesandbox/browser/Default/Preferences').read_text())
print(preferences.get('profile',{}).get('exit_type','missing'))`])).trim();
  assert.equal(exitType, 'Normal', 'Chromium must finish saving its profile before its display service stops');
  (report.normalBrowserExits ??= []).push({ environmentId: e.id, exitType });
}
async function stop(e: Environment) {
  await closeBrowser(e);
  await finish(await manager.lifecycle(e.id, 'stop'));
  assert.equal((await manager.runtime.list()).find(value => value.name === e.instanceName)?.status, 'Stopped');
}

try {
  await mkdir(path.join(temporary, 'tools/guest-browser'), { recursive: true, mode: 0o700 });
  await copyFile(`/tmp/mu-chromium-${GUEST_CHROMIUM_VERSION}-arm64.zip`, path.join(temporary, `tools/guest-browser/chrome-${GUEST_CHROMIUM_VERSION}-linux-arm64.zip`)).catch(() => {});
  const network = { mode: 'http', host: '127.0.0.1', port: proxyPort, username: 'mu', password: 'profile-verification', noProxy: '', strict: true, transparent: true };
  await manager.reconcile(true);
  let existing = manager.store.list();
  assert.ok(existing.every(e => e.kind === 'vm' && ['Profile A', 'Profile B'].includes(e.name)), 'The reusable data directory must contain only this verifier\'s environments');
  if (report.freshVmDisks) {
    for (const e of existing) await finish(await manager.lifecycle(e.id, 'delete'));
    existing = [];
  }
  async function environment(name: string, phase: string, identity: Environment['identity']) {
    const config = { name, cpus: 2, memoryGiB: 2, diskGiB: 10, browserUrl: `${fixtureOrigin}/probe?phase=${phase}`, identity, network };
    const old = existing.find(e => e.name === name);
    if (!old) return manager.create(config);
    await finish(await manager.lifecycle(old.id, 'stop'));
    return manager.update(old.id, config);
  }
  const a = await environment('Profile A', 'a-initial', { timezone: 'Asia/Tokyo', locale: 'ja-JP' });
  const b = await environment('Profile B', 'b-initial', { timezone: 'America/New_York', locale: 'en-US' });
  ids.push(a.id, b.id);
  await start(a);
  const initialA = await waitReceipt('a-initial'); validateIdentity(a, initialA); validateState(initialA, null);
  report.steps.push({ environmentId: a.id, ...initialA });
  validateState(await navigate(a, '/write?owner=account-a', 'a-write'), 'account-a');
  await closeBrowser(a);
  await finish(await manager.openBrowser(a.id));
  validateState(await navigate(a, '/probe', 'a-browser-reopened'), 'account-a');
  report.browserReopenPreservesCookieLocalStorageAndIndexedDB = true;
  await stop(a);

  await start(b);
  const initialB = await waitReceipt('b-initial'); validateIdentity(b, initialB); validateState(initialB, null);
  report.steps.push({ environmentId: b.id, ...initialB });
  report.secondVmCannotReadFirstVmProfile = true;
  validateState(await navigate(b, '/write?owner=account-b', 'b-write'), 'account-b');
  await stop(b);

  await start(a);
  validateState(await navigate(a, '/probe', 'a-vm-restarted'), 'account-a');
  report.firstVmRestartPreservesOwnProfileAndRejectsSecondAccount = true;
  await stop(a);
  await start(b);
  validateState(await navigate(b, '/probe', 'b-vm-restarted'), 'account-b');
  report.secondVmRestartPreservesOwnProfileAndRejectsFirstAccount = true;
  await stop(b);

  const diskA = metadata.get(a.id)!, diskB = metadata.get(b.id)!;
  assert.notEqual(diskA.disk, diskB.disk); assert.notEqual(diskA.inode, diskB.inode);
  assert.notEqual(diskA.machineId, diskB.machineId);
  assert.ok(proxyConnections > 0);
  report.independentDisksAndMachineIds = Object.fromEntries(metadata);
  report.pageWorkerIframeHeadersMatchTwoConfigurations = true;
  report.persistentHttpOnlyCookiesRemainUnavailableToJavaScript = true;
  report.authenticatedProxyConnections = proxyConnections;
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  report.logs = manager.store.logs(null).slice(-40);
  for (const id of ids) report[`logs-${id}`] = manager.store.logs(id).slice(-40);
  report.browserFailure = lastEntry?.failure?.stack;
  report.transportExit = lastEntry?.transport.exitCode;
  report.cdpState = lastEntry && { ready: lastEntry.ready, activeSessions: [...(lastEntry.tools?.activeSessions ?? [])], pending: lastEntry.tools?.pending.size, configuration: lastEntry.configuration.size };
  for (const id of ids) {
    const e = manager.store.get(id);
    if ((await manager.runtime.list()).some(instance => instance.name === e.instanceName && instance.status === 'Running')) {
      report[`browserJournal-${id}`] = await manager.runtime.management(e, ['sudo', 'journalctl', '--unit=mucodesandbox-browser.service', '--no-pager', '--lines=80'], { timeoutMs: 15_000 }).catch(String);
      report[`guestTargets-${id}`] = await manager.runtime.guest(e, ['curl', '--silent', '--max-time', '5', 'http://127.0.0.1:9222/json/list']).catch(String);
      if (report.diagnosticChromeNetlog) report[`chromeNetlog-${id}`] = await manager.runtime.guest(e, ['python3', '-c', `import json,pathlib
data=json.loads(pathlib.Path('/tmp/mu-profile-netlog.json').read_text())
events=data.get('events',[])
constants=data.get('constants',{})
print(json.dumps({'eventCount':len(events),'events':events[-2000:],'eventTypes':constants.get('logEventTypes',{}),'sourceTypes':constants.get('logSourceType',{})}))`], { timeoutMs: 15_000 }).catch(String);
    }
  }
  process.exitCode = 1;
} finally {
  for (const id of ids) {
    await manager.browser.close(id).catch(error => { report.cleanupError = String(error); });
    const environment = manager.store.get(id);
    if ((await manager.runtime.list()).some(value => value.name === environment.instanceName && value.status === 'Running')) {
      await finish(await manager.lifecycle(id, 'stop')).catch(async error => {
        report.cleanupError = String(error);
        await manager.runtime.command(['stop', '--force', environment.instanceName], { timeoutMs: 60_000 }).catch(() => {});
      });
    }
  }
  await service.close();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => proxy.close(() => resolve()));
  await new Promise<void>(resolve => target.close(() => resolve()));
  if (report.passed && !report.cleanupError && !process.env.MU_KEEP_PROFILE_TEST) {
    for (const instance of await manager.runtime.list()) await manager.runtime.command(['delete', '--force', instance.name], { timeoutMs: 60_000 });
    await rm(temporary, { recursive: true, force: true });
    report.temporaryVmDataRemoved = true;
  } else report.retainedDataDir = temporary;
  report.finishedAt = new Date().toISOString();
  report.fixtureRequests = requests;
  report.proxyDestinations = destinations;
  report.receipts = receipts;
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results', reportName), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, error: report.error, retainedDataDir: report.retainedDataDir, steps: report.steps.length }, null, 2));
}
