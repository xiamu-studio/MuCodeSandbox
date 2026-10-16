import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';
import { createMockMessages, MOCK_CREDENTIAL, MOCK_FILE, MOCK_CONTENT } from '../server/mock-messages.ts';
import { shellQuote } from '../server/network-guard.ts';
import type { Environment, Job } from '../shared/types.ts';
import type { createService } from '../server/service.ts';

type Service = Awaited<ReturnType<typeof createService>>;
const relayPort = 41880;
const target = 'http://203.0.113.10';
async function until(check: () => boolean | Promise<boolean>, milliseconds = 20_000) {
  const deadline = Date.now() + milliseconds;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'Workload observation timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export async function createWireguardWorkloads(service: Service, gateway: Environment, clientId: string, artifacts: string) {
  const manager = service.manager, runtime = manager.runtime;
  const mock = createMockMessages(), receipts: any[] = [];
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.post('/v1/messages', mock.handle);
  app.post('/v1/messages/count_tokens', mock.countTokens);
  app.get('/', (_req, res) => res.end('MU_PACKET_RUNTIME_OK'));
  app.get('/login', (_req, res) => res.setHeader('Set-Cookie', 'mu_packet=synthetic; HttpOnly; SameSite=Lax').end('ok'));
  app.get('/cookies', (req, res) => res.end(req.headers.cookie ?? ''));
  app.post('/receipt', (req, res) => { receipts.push({ ...req.body, tunnelSource: req.headers['x-mu-tunnel-source'] }); res.end('ok'); });
  app.get('/clicked', (_req, res) => { receipts.push({ clicked: true }); res.end('ok'); });
  app.get(['/probe', '/keyboard', '/popup'], (req, res) => {
    res.type('html').end(`<!doctype html><html><head><title>Mu packet browser</title><style>body{margin:0;font:18px Arial;background:#f4f6f8;color:#182128}header{padding:32px;background:#146c54;color:white}main{padding:40px}button{background:#ffdf57;border:2px solid #182128;padding:24px;font:24px Arial}</style></head><body><header><h1>Mu packet browser</h1></header><main><p>Linux Chromium</p><button onclick="fetch('/clicked');this.textContent='Interaction verified';window.open('/popup','mu-packet-popup')">Verify interaction</button><canvas width="300" height="90"></canvas></main><script>
const actual=()=>({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,language:navigator.language,languages:[...navigator.languages],platform:navigator.platform,userAgent:navigator.userAgent,cores:navigator.hardwareConcurrency});
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');ctx.fillStyle='#176c54';ctx.fillRect(0,0,300,90);ctx.fillStyle='#ffdf57';ctx.font='24px Arial';ctx.fillText('Kernel packet pixels',12,52);
const worker=new Worker(URL.createObjectURL(new Blob(['postMessage(('+actual.toString()+')())'],{type:'text/javascript'})));
worker.onmessage=async event=>{await fetch('/login');const cookie=await(await fetch('/cookies')).text();const marker=localStorage.getItem('mu-packet')||'created';localStorage.setItem('mu-packet','persisted');fetch('/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:location.pathname,page:actual(),worker:event.data,headers:${JSON.stringify(req.headers)},cookie,marker,canvas:canvas.toDataURL()})});};
</script></body></html>`);
  });
  app.use((_req, res) => res.status(404).end('Local fixture only'));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const hostPort = (server.address() as { port: number }).port;
  let relay: ChildProcess | undefined, relayError = '';
  const current = () => manager.store.get(clientId);
  const admin = (args: string[], input?: string) => runtime.management(current(), args, { input, timeoutMs: 30_000, maxBytes: 128_000_000 });
  const gatewayAdmin = (args: string[], input?: string) => runtime.management(gateway, args, { input, timeoutMs: 30_000 });
  const guest = (args: string[], timeoutMs = 30_000) => runtime.guest(current(), args, { timeoutMs });
  async function finish(job: Job) {
    await manager.tasks.get(job.id)?.promise;
    const done = manager.store.jobs().find(j => j.id === job.id)!;
    assert.equal(done.status, 'succeeded', done.message);
  }
  const cli = (scenario: string) => ['env', `ANTHROPIC_BASE_URL=${target}`, `ANTHROPIC_API_KEY=${MOCK_CREDENTIAL}`,
    'CLAUDE_CONFIG_DIR=/home/dev/.mu-claude-account-free', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'DISABLE_AUTOUPDATER=1', 'DISABLE_TELEMETRY=1', 'DISABLE_ERROR_REPORTING=1', 'API_TIMEOUT_MS=10000',
    'claude', '-p', `MU_LAB_CLAUDE_${scenario}`, '--model', 'claude-sonnet-4-5-20250929',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--max-turns', '6',
    '--tools', 'Read,Write,Bash', '--allowedTools', 'Read,Write,Bash', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--no-chrome'];

  async function prepareGateway() {
    relay = spawn('/usr/bin/ssh', ['-F', path.join(runtime.limaHome, gateway.instanceName, 'ssh.config'), '-S', 'none', '-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-R', `127.0.0.1:${relayPort}:127.0.0.1:${hostPort}`, `lima-${gateway.instanceName}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    relay.stderr!.on('data', bytes => { relayError = (relayError + bytes.toString()).slice(-2000); });
    relay.on('error', error => { relayError = error.message; });
    await until(async () => {
      assert.equal(relay!.exitCode, null, relayError);
      try { return (await gatewayAdmin(['curl', '--fail', '--silent', '--max-time', '1', `http://127.0.0.1:${relayPort}/`])).trim() === 'MU_PACKET_RUNTIME_OK'; }
      catch { return false; }
    });
    const python = `import http.client, http.server
class Handler(http.server.BaseHTTPRequestHandler):
 protocol_version = 'HTTP/1.1'
 def log_message(self,*args): pass
 def do_GET(self): self.forward()
 def do_POST(self): self.forward()
 def forward(self):
  connection=http.client.HTTPConnection('127.0.0.1',${relayPort},timeout=15)
  try:
   length=int(self.headers.get('Content-Length','0'))
   if length>2*1024*1024: self.send_error(413);return
   headers={k:v for k,v in self.headers.items() if k.lower() not in ['host','connection','transfer-encoding','x-mu-tunnel-source']}
   headers['Host']='127.0.0.1:${hostPort}'
   headers['X-Mu-Tunnel-Source']=self.client_address[0]
   connection.request(self.command,self.path,self.rfile.read(length) if length else None,headers)
   response=connection.getresponse()
   self.send_response(response.status)
   for k,v in response.getheaders():
    if k.lower() not in ['connection','transfer-encoding']: self.send_header(k,v)
   self.send_header('Connection','close');self.end_headers()
   while True:
    chunk=response.read1(4096)
    if not chunk: break
    self.wfile.write(chunk);self.wfile.flush()
  except (OSError,http.client.HTTPException): pass
  finally: connection.close();self.close_connection=True
http.server.ThreadingHTTPServer(('203.0.113.10',80),Handler).serve_forever()
`;
    await gatewayAdmin(['bash', '-s'], `set -eu
sudo systemctl stop mu-wg-runtime-http.service
printf '%s' ${shellQuote(python)} | sudo tee /run/mu-wg-runtime/relay.py >/dev/null
sudo chmod 0600 /run/mu-wg-runtime/relay.py
sudo systemd-run --unit=mu-wg-workload-http /usr/bin/python3 /run/mu-wg-runtime/relay.py
`);
  }

  async function verify() {
    const report: Record<string, any> = { accountFree: true, paidModelCalls: 0, startedAt: new Date().toISOString(), fullClaudeTuiTested: false };
    let capture = false, localOnly = false;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, terminal: WebSocket | undefined;
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const before = await runtime.networkProtection(current());
    try {
      await admin(['bash', '-s'], `set -eu
sudo systemd-run --unit=mu-wg-workload-capture /usr/bin/tcpdump --immediate-mode -ni any -Q out -U -s 128 -w /run/mu-wg-workload.pcap
sleep 1
`); capture = true;
      console.log(new Date().toISOString(), 'Installing actual Claude Code and opening the cold Linux browser over the kernel tunnel');
      await finish(await manager.lifecycle(clientId, 'install-agent'));
      report.client = await runtime.agentStatus(current());
      assert.ok(report.client.installed);
      await finish(await manager.openBrowser(clientId));
      await until(() => receipts.some(r => r.page));
      await gatewayAdmin(['bash', '-s'], `set -eu
sudo nft -f - <<'MU_LOCAL_ONLY'
table inet mu_workload_local_only {
 counter external { }
 chain forward { type filter hook forward priority -20; policy accept;
  ip saddr 10.77.0.2 counter name external drop
  ip daddr 10.77.0.2 counter name external drop
 }
}
MU_LOCAL_ONLY
`); localOnly = true;
      await assert.rejects(guest(['curl', '--fail', '--silent', '--max-time', '3', '--proxy', '', 'https://1.1.1.1/']));
      report.externalForwardingBlockedDuringTasks = true;
      const receipt = receipts.find(r => r.page);
      assert.equal(receipt.tunnelSource, '10.77.0.2');
      assert.match(receipt.page.platform, /^Linux /);
      assert.equal(receipt.page.language, 'ja-JP'); assert.equal(receipt.page.timezone, 'Asia/Tokyo');
      assert.deepEqual(receipt.page, receipt.worker); assert.match(receipt.headers['accept-language'], /^ja-JP/);
      assert.equal(receipt.cookie, 'mu_packet=synthetic');
      report.identity = { ...receipt, canvas: `PNG data URL: ${receipt.canvas.length} characters` };
      report.inspection = await manager.browser.inspect!(clientId);
      assert.equal(report.inspection.matchesConfiguration, true);
      const sandbox = JSON.parse((await admin(['sudo', 'python3', '-c', `import pathlib,json
rows=[]
for p in pathlib.Path('/proc').glob('[0-9]*'):
 try:
  exe=(p/'exe').readlink().as_posix()
  if '/mucodesandbox/chromium-' not in exe: continue
  cmd=(p/'cmdline').read_bytes().replace(bytes([0]),b' ').split()
  if b'--type=renderer' not in cmd: continue
  status=dict(line.split(':',1) for line in (p/'status').read_text().splitlines() if ':' in line)
  rows.append({'seccomp':status['Seccomp'].strip(),'noNewPrivs':status['NoNewPrivs'].strip(),'uid':status['Uid'].split()[0],'pidNamespace':(p/'ns/pid').readlink().as_posix(),'rootNamespace':pathlib.Path('/proc/1/ns/pid').readlink().as_posix(),'noSandbox':b'--no-sandbox' in cmd})
 except (FileNotFoundError,ProcessLookupError): pass
print(json.dumps(rows))`])).trim());
      assert.ok(sandbox.length > 0);
      assert.ok(sandbox.every((row: any) => row.seccomp === '2' && row.noNewPrivs === '1' && row.uid !== '0' && row.pidNamespace !== row.rootNamespace && !row.noSandbox));
      report.rendererSandbox = sandbox;
      browser = await chromium.launch({ headless: true, channel: 'chrome', chromiumSandbox: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(service.launchUrl(`/?guestBrowser=${clientId}`));
      await page.getByRole('status').filter({ hasText: '已连接' }).waitFor({ timeout: 30_000 });
      const canvas = page.locator('.guest-browser-canvas canvas'); await canvas.waitFor();
      await until(async () => canvas.evaluate((node: HTMLCanvasElement) => node.width === 1280 && node.height === 800));
      const pixels = await canvas.evaluate((node: HTMLCanvasElement) => {
        const bytes = node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data, colors = new Set<string>();
        for (let i = 0; i < bytes.length; i += 400) colors.add(`${bytes[i]},${bytes[i + 1]},${bytes[i + 2]}`);
        return { width: node.width, height: node.height, colors: colors.size };
      }); assert.ok(pixels.colors > 20, JSON.stringify(pixels)); report.nonblankFrame = pixels;
      await page.screenshot({ path: path.join(artifacts, 'browser-desktop.png') });
      const bounds = await canvas.boundingBox(); assert.ok(bounds);
      const popupIndex = receipts.length;
      await page.mouse.click(bounds.x + bounds.width * .12, bounds.y + bounds.height * .60);
      await until(() => receipts.some(r => r.clicked), 5000);
      await until(() => receipts.slice(popupIndex).some(r => r.path === '/popup'), 10_000);
      const popup = receipts.slice(popupIndex).find(r => r.path === '/popup');
      assert.deepEqual(popup.page, receipt.page); assert.deepEqual(popup.worker, receipt.page);
      assert.match(popup.headers['accept-language'], /^ja-JP/);
      const popupTargets = JSON.parse(await guest(['curl', '--silent', '--max-time', '5', 'http://127.0.0.1:9222/json/list'])).filter((entry: any) => entry.type === 'page');
      assert.ok(popupTargets.length >= 2 && popupTargets.some((entry: any) => entry.url.endsWith('/popup')));
      report.nativeIdentityInNewWindow = { page: popup.page, worker: popup.worker, actualPageTargets: popupTargets.length };
      await canvas.click(); await page.keyboard.press('Control+l'); await page.waitForTimeout(200);
      await page.keyboard.type(`${target}/keyboard`, { delay: 15 }); await page.keyboard.press('Enter');
      await until(() => receipts.some(r => r.path === '/keyboard'), 10_000);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(artifacts, 'browser-mobile.png') });
      report.viewer = { mouse: true, keyboard: true, mobileFits: true }; assert.deepEqual(errors, []);
      await manager.closeBrowser(clientId);
      const profile = async () => JSON.parse((await guest(['python3', '-c', 'import json,pathlib;p=pathlib.Path.home()/".local/share/mucodesandbox/browser/Default/Preferences";print(json.dumps(json.loads(p.read_text()).get("profile",{})))'])).trim());
      report.profileAfterClose = await profile(); assert.equal(report.profileAfterClose.exit_type, 'Normal');
      const reopenIndex = receipts.length;
      await finish(await manager.openBrowser(clientId)); await until(() => receipts.slice(reopenIndex).some(r => r.page));
      assert.equal(receipts.slice(reopenIndex).find(r => r.page).marker, 'persisted');
      await manager.closeBrowser(clientId); report.profileAfterReopen = await profile(); assert.equal(report.profileAfterReopen.exit_type, 'Normal');
      report.browserClosedReopenedAndPersisted = true;
      await guest(['mkdir', '-p', '/workspace/mu-claude-account-free']);
      await guest(['rm', '-f', MOCK_FILE, '/workspace/mu-claude-account-free/MUST_NOT_EXIST']);
      console.log(new Date().toISOString(), 'Running actual Claude tools against the local fixture with external forwarding disabled');
      async function success(scenario: string, name: string) {
        let output = '';
        try { await runtime.guest(current(), cli(scenario), { timeoutMs: 60_000, onOutput: bytes => { output += bytes; } }); }
        finally { await writeFile(path.join(artifacts, name), output, { mode: 0o600 }); }
        const events = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
        assert.equal(events.find(e => e.type === 'result')?.is_error, false, output.slice(-4000));
        return events;
      }
      const toolIndex = mock.receipts.length, events = await success('TOOLS', 'claude-tools.jsonl');
      assert.equal(await guest(['cat', MOCK_FILE]), MOCK_CONTENT);
      const final = mock.receipts.slice(toolIndex).find(r => r.scenario === 'TOOLS' && r.emittedTool === null)!;
      assert.equal(final.toolResults.length, 3); assert.ok(final.toolResults.every(r => !r.error));
      assert.match(JSON.stringify(final.toolResults.find(r => r.id === 'toolu_mu_2')?.content), /dev/);
      assert.ok(events.some(e => e.type === 'stream_event' && e.event?.delta?.type === 'input_json_delta'));
      report.tools = { actualWriteReadBash: true, guestUser: 'dev', results: 3, fragmentedStreamingJson: true };
      const ticket = service.terminal.issue(clientId, 'shell');
      terminal = new WebSocket(`${service.url.replace('http:', 'ws:')}/terminal?ticket=${ticket}`, { origin: service.url });
      let terminalOutput = ''; const terminalErrors: unknown[] = [];
      terminal.on('message', bytes => { const event = JSON.parse(bytes.toString()); if (event.type === 'data') terminalOutput += event.data; if (event.type === 'error') terminalErrors.push(event.data); });
      await new Promise<void>((resolve, reject) => { terminal!.once('open', resolve); terminal!.once('error', reject); });
      const send = (data: string) => terminal!.send(JSON.stringify({ type: 'input', data }));
      send("stty -echo; printf '%s%s\\n' 'MU_PTY_' 'READY'\r"); await until(() => terminalOutput.includes('MU_PTY_READY'));
      const waitIndex = mock.receipts.length;
      send(cli('WAIT').map(shellQuote).join(' ') + '; printf "MU_CLI_EXIT=%s\\n" "$?"\r');
      await until(() => mock.receipts.slice(waitIndex).some(r => r.scenario === 'WAIT') && terminalOutput.includes('MU_REAL_CLAUDE_WAITING'));
      send('\x03');
      await until(() => terminalOutput.includes('MU_CLI_EXIT='), 10_000);
      await until(() => mock.receipts.slice(waitIndex).filter(r => r.scenario === 'WAIT').every(r => r.disconnected), 10_000);
      send("printf '%s%s\\n' 'MU_PTY_' 'RECOVERED'\r"); await until(() => terminalOutput.includes('MU_PTY_RECOVERED'));
      assert.deepEqual(terminalErrors, []);
      assert.equal((await admin(['bash', '-c', "pgrep -u dev -af 'claude -p MU_LAB_CLAUDE_WAIT' | grep -v pgrep || true"])).trim(), '');
      report.ptyCtrlC = { streamClosed: true, cliExited: true, shellUsableAfterInterrupt: true, exitCode: terminalOutput.match(/MU_CLI_EXIT=(\d+)/)?.[1], fullTui: false };
      await writeFile(path.join(artifacts, 'terminal.txt'), terminalOutput, { mode: 0o600 });
      terminal.close(); await until(() => !service.terminal.children.has(clientId)); terminal = undefined;
      const cutIndex = mock.receipts.length, controller = new AbortController(); let cutOutput = '', cutError: any, done = false;
      const cut = runtime.guest(current(), cli('CUT'), { signal: controller.signal, timeoutMs: 60_000, onOutput: bytes => { cutOutput += bytes; } }).catch(error => { cutError = error; }).finally(() => { done = true; });
      await until(() => done || mock.receipts.slice(cutIndex).filter(r => r.scenario === 'CUT' && r.disconnected).length >= 2, 30_000);
      const cancelledRetries = !done; if (cancelledRetries) controller.abort(); await cut;
      if (cancelledRetries) assert.equal(cutError?.code, 'CANCELLED');
      else assert.notEqual(cutError?.code, 'TIMEOUT');
      assert.ok(mock.receipts.slice(cutIndex).some(r => r.scenario === 'CUT' && r.disconnected));
      const cutEvents = cutOutput.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
      assert.ok(cutError || cutEvents.some(e => e.type === 'result' && e.is_error));
      await assert.rejects(guest(['test', '-e', '/workspace/mu-claude-account-free/MUST_NOT_EXIST']));
      await writeFile(path.join(artifacts, 'claude-cut.jsonl'), cutOutput, { mode: 0o600 });
      report.disconnect = { actualTruncatedStream: true, cancelledRetries, naturalClientFailure: !cancelledRetries, partialToolNotExecuted: true };
      await success('TEXT', 'claude-recovered.jsonl'); report.freshCliRunAfterFault = true;
      const after = await runtime.networkProtection(current());
      assert.equal(after.active, true); assert.equal(after.firewallHash, before.firewallHash); assert.equal(after.wireguardStateHash, before.wireguardStateHash); assert.equal(after.tunnelConfigHash, before.tunnelConfigHash);
      report.networkProtectionUnchanged = true; report.protection = after;
      report.messages = [...mock.receipts]; report.passed = true;
      return report;
    } catch (error) {
      report.error = (error as Error).stack;
      report.messages = [...mock.receipts];
      throw error;
    } finally {
      terminal?.terminate(); await browser?.close(); await manager.closeBrowser(clientId).catch(() => {});
      try {
      if (capture) {
        await admin(['sudo', 'systemctl', 'stop', 'mu-wg-workload-capture.service']);
        const bytes = Buffer.from((await admin(['sudo', 'base64', '-w0', '/run/mu-wg-workload.pcap'])).trim(), 'base64');
        assert.ok(bytes.length > 24);
        assert.equal(bytes.length, Number((await admin(['sudo', 'stat', '-c', '%s', '/run/mu-wg-workload.pcap'])).trim()), 'Capture transfer must not be truncated');
        assert.ok(['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(bytes.subarray(0, 4).toString('hex')));
        await writeFile(path.join(artifacts, 'workloads.pcap'), bytes, { mode: 0o600 });
        const text = await admin(['sudo', 'tcpdump', '-nn', '-r', '/run/mu-wg-workload.pcap']);
        const output = text.split('\n').filter(line => /\seth0\s+Out\s+IP6?\s/.test(line));
        assert.ok(output.length > 0);
        const port = current().network.port;
        assert.ok(output.every(line => !/ IP6 /.test(line) && (line.includes(` > 192.168.5.2.${port}:`) || /\.22 > 192\.168\.5\.2\./.test(line) || /\.68 > [0-9.]+\.67:/.test(line))), 'Unapproved workload physical egress');
        report.capture = { bytes: bytes.length, physicalOutputPackets: output.length, onlyApprovedUdpSshDhcp: true };
      }
      if (localOnly) {
        report.externalDrops = JSON.parse(await gatewayAdmin(['sudo', 'nft', '-j', 'list', 'counter', 'inet', 'mu_workload_local_only', 'external']));
        await gatewayAdmin(['sudo', 'nft', 'delete', 'table', 'inet', 'mu_workload_local_only']);
        assert.ok(report.externalDrops.nftables.some((entry: any) => entry.counter?.packets > 0), 'External forwarding rejection needs actual packet evidence');
      }
      } catch (error) { report.captureOrCleanupError = (error as Error).stack; report.passed = false; process.exitCode = 1; }
      report.finishedAt = new Date().toISOString();
      await writeFile(path.join(artifacts, 'workloads.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
      if (!report.error) assert.equal(report.passed, true, JSON.stringify(report));
    }
  }
  async function close() {
    mock.close(); relay?.kill('SIGTERM');
    if (relay && relay.exitCode === null) await new Promise<void>(resolve => { relay!.once('close', resolve); setTimeout(() => { relay!.kill('SIGKILL'); resolve(); }, 2000).unref(); });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
  return { prepareGateway, verify, close, packagedFixture: { receipts, mock, gatewayAdmin } };
}
