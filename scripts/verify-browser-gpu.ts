import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createService as createSourceService } from '../server/service.ts';
import { DevTools } from '../server/guest-browser.ts';
import * as sourceBrowserRuntime from '../server/guest-browser-runtime.ts';
import { BROWSER_PROCESS_INSPECTION } from './browser-media-fixture.ts';
import { WEBGPU_CONTEXTS, WEBGPU_PRESENTATION, verifyWebGPUContexts, verifyWebGPUPresentation } from './browser-webgpu-fixture.ts';
import { WEBGPU_ALL_CONTEXTS, WEBGPU_WORKER_ASSETS, verifyWebGPUAllContexts } from './browser-webgpu-contexts-fixture.ts';
import { WORKER_CANVAS_ASSETS, WORKER_PROCESS_INSPECTION } from './browser-webgpu-worker-canvas-fixture.ts';
import { measureWorkerCanvases } from './worker-canvas-measurement.ts';
import { DEVICE_LOSS_ASSETS } from './webgpu-device-loss-fixture.ts';
import { measureDeviceLoss } from './webgpu-device-loss-measurement.ts';
import type { Environment, Job } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const guardOnly = process.argv.includes('--guard-only');
const mesaDiagnostic = process.argv.includes('--mesa-diagnostic');
const productionOnly = process.argv.includes('--production');
const candidateLifecycle = process.argv.includes('--webgpu-lifecycle');
const presentationDiagnostic = process.argv.includes('--webgpu-presentation-diagnostic');
const swiftshaderVulkan = process.argv.includes('--swiftshader-vulkan');
assert.ok(!swiftshaderVulkan || presentationDiagnostic || candidateLifecycle, 'SwiftShader Vulkan requires an explicit presentation or lifecycle experiment');
const graphiteCandidate = process.argv.includes('--graphite-candidate');
assert.ok(!graphiteCandidate || (swiftshaderVulkan && candidateLifecycle), 'Graphite candidate requires SwiftShader Vulkan lifecycle mode');
const candidateExtraFlags = ['--disable-dawn-features=adapter_blocklist', '--enable-features=Vulkan',
  ...(swiftshaderVulkan ? ['--use-vulkan=swiftshader'] : []),
  ...(graphiteCandidate ? ['--enable-skia-graphite', '--skia-graphite-dawn-backend=swiftshader'] : [])];
const webgpuDiagnostic = process.argv.includes('--webgpu-diagnostic') || candidateLifecycle || presentationDiagnostic;
const dawnBlocklistDiagnostic = process.argv.includes('--dawn-blocklist');
assert.ok(!dawnBlocklistDiagnostic || webgpuDiagnostic, 'Dawn blocklist experiment requires explicit WebGPU diagnostic mode');
assert.ok(!candidateLifecycle || !dawnBlocklistDiagnostic, 'Keep candidate lifecycle separate from the backend matrix');
assert.ok(!presentationDiagnostic || (!candidateLifecycle && !dawnBlocklistDiagnostic), 'Keep presentation backend and lifecycle modes separate');
const webgpu = process.argv.includes('--webgpu') || webgpuDiagnostic;
const deviceLoss = process.argv.includes('--device-loss');
const workerCanvases = process.argv.includes('--worker-canvases') || deviceLoss;
const allContexts = process.argv.includes('--all-contexts') || workerCanvases;
assert.ok(!workerCanvases || (candidateLifecycle && graphiteCandidate), 'Worker canvases require the explicit Graphite lifecycle candidate');
assert.ok(!allContexts || (webgpu && (candidateLifecycle || productionOnly)), 'All Worker contexts require explicit production WebGPU or candidate lifecycle');
assert.ok(!webgpu || productionOnly || webgpuDiagnostic, 'WebGPU acceptance requires production or explicit diagnostic mode');
assert.ok([guardOnly, mesaDiagnostic, productionOnly, webgpuDiagnostic].filter(Boolean).length <= 1, 'Choose one graphics acceptance mode');
assert.ok(!webgpuDiagnostic || !process.argv.includes('--expanded'), 'WebGPU diagnostic controls its own backend matrix');
assert.ok(!(mesaDiagnostic || productionOnly) || !process.argv.includes('--expanded'), 'Keep production and diagnostic modes separate from the expanded matrix');
const packaged = process.argv.includes('--packaged');
const bundle = path.resolve(process.env.MU_PACKAGED_APP ?? path.join(root, 'release/graphics-candidate/mac-arm64/MuCodeSandbox.app'));
const appRoot = path.join(bundle, 'Contents/Resources/app');
const browserRuntime: typeof sourceBrowserRuntime = packaged ? await import(pathToFileURL(path.join(appRoot, 'dist-server/server/guest-browser-runtime.js')).href) : sourceBrowserRuntime;
const createService: typeof createSourceService = packaged ? (await import(pathToFileURL(path.join(appRoot, 'dist-server/server/service.js')).href)).createService : createSourceService;
const { ensureGuestBrowser, startGuestBrowser, stopGuestBrowser, GUEST_CHROMIUM_VERSION, GUEST_BROWSER_SERVICE } = browserRuntime;
const reportName = (presentationDiagnostic ? 'browser-webgpu-presentation-diagnostic' : candidateLifecycle ? 'browser-webgpu-candidate-lifecycle' : dawnBlocklistDiagnostic ? 'browser-webgpu-dawn-diagnostic' : webgpuDiagnostic ? 'browser-webgpu-diagnostic' : webgpu ? 'browser-webgpu-production' : productionOnly ? 'browser-gpu-production' : mesaDiagnostic ? 'browser-mesa-diagnostic' : guardOnly ? 'browser-sandbox-guard' : 'browser-gpu') + (graphiteCandidate ? '-swiftshader-graphite' : swiftshaderVulkan ? '-swiftshader-vulkan' : '') + (allContexts ? '-all-contexts' : '') + (workerCanvases ? '-worker-canvases' : '') + (deviceLoss ? '-device-loss' : '') + (packaged ? '-packaged' : '');
const retained = process.env.MU_GPU_TEST_DATA;
if (retained) assert.ok(path.dirname(path.resolve(retained)) === homedir() && /^\.mu-gpu-verification-[A-Za-z0-9]+$/.test(path.basename(retained)));
const temporary = retained ? path.resolve(retained) : await mkdtemp(path.join(homedir(), '.mu-gpu-verification-'));
const artifacts = path.join(root, 'test-results', reportName);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
const sockets = new Set<Socket>();
const authorization = `Basic ${Buffer.from('mu:gpu-verification').toString('base64')}`;
const proxy = createServer((_request, response) => { response.writeHead(405); response.end(); });
let proxyConnections = 0;
proxy.on('connect', (request, client, head) => {
  if (request.headers['proxy-authorization'] !== authorization) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
  const destination = new URL(`https://${request.url}`);
  const remote = connect(Number(destination.port) || 443, destination.hostname, () => {
    proxyConnections++; client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client);
  });
  sockets.add(remote); remote.on('close', () => sockets.delete(remote));
  remote.on('error', () => client.destroy()); client.on('error', () => remote.destroy()); client.on('close', () => remote.destroy());
});
proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = (proxy.address() as { port: number }).port;
const service = await createService({ rootDir: root, dataDir: temporary, port: 0 });
const { manager } = service, runtime = manager.runtime;
const report: Record<string, any> = { passed: false, measurementCompleted: false, startedAt: new Date().toISOString(), accountFree: true, paidModelCalls: 0, variants: [], captures: [] };
if (candidateLifecycle) {
  const original = runtime.management.bind(runtime);
  runtime.management = (e, args, options = {}) => {
    if (args[0] === 'bash' && options.input?.includes("'MU_READY'")) {
      const marker = `sudo systemctl start ${GUEST_BROWSER_SERVICE}\n`;
      assert.equal(options.input.split(marker).length, 2, 'Candidate requires exactly one guarded startup');
      const patch = `sudo python3 - <<'MU_WEBGPU_CANDIDATE'
import pathlib,shlex
target=pathlib.Path('/usr/local/libexec/mu-guest-browser');lines=target.read_text().splitlines();count=0
for index,line in enumerate(lines):
 args=shlex.split(line)
 if args and args[0].endswith('/chrome-linux-arm64/chrome') and args[-1]=='&':
  assert '--use-angle=gl' in args and '--disable-accelerated-2d-canvas' in args
  assert not any(arg in args for arg in ['--no-sandbox','--disable-gpu-sandbox','--enable-unsafe-webgpu','--enable-unsafe-swiftshader'])
  lines[index]=shlex.join(args[:-1]+${JSON.stringify(candidateExtraFlags)})+' &';count+=1
assert count==1
target.write_text('\\n'.join(lines)+'\\n')
MU_WEBGPU_CANDIDATE
`;
      options = { ...options, input: options.input.replace(marker, patch + marker) };
    }
    return original(e, args, options);
  };
}
async function verifyPackage() {
  if (!packaged) return;
  await runtime.runner('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeoutMs: 30_000 });
  const signature = await runtime.runner('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
  report.package = { bundle, cdHash: signature.match(/^CDHash=(.+)$/m)?.[1], actualCompiledServiceTested: true, applicationUiTested: false };
  assert.ok(report.package.cdHash);
  report.packagedFiles = Object.fromEntries(await Promise.all(['guest-browser-runtime.js', 'guest-browser-sandbox.js', 'guest-browser.js'].map(async file => [file, createHash('sha256').update(await readFile(path.join(appRoot, 'dist-server/server', file))).digest('hex')])));
}
report.allWorkerContextsTested = allContexts;
report.workerCanvasesTested = workerCanvases;
report.deviceLossTested = deviceLoss;
report.testedFiles = Object.fromEntries(await Promise.all(['server/guest-browser-runtime.ts', 'server/guest-browser-sandbox.ts', 'server/guest-browser.ts', 'scripts/browser-media-fixture.ts', 'scripts/verify-browser-gpu.ts', ...(webgpu ? ['scripts/browser-webgpu-fixture.ts'] : []), ...(allContexts ? ['scripts/browser-webgpu-contexts-fixture.ts'] : []), ...(workerCanvases ? ['scripts/browser-webgpu-worker-canvas-fixture.ts', 'scripts/worker-canvas-measurement.ts'] : []), ...(deviceLoss ? ['scripts/webgpu-device-loss-fixture.ts', 'scripts/webgpu-device-loss-measurement.ts'] : [])].map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
let environment: Environment | undefined, tools: DevTools | undefined, transport: ChildProcess | undefined, directory: string | undefined;
let launcher: string | undefined, captureStarted = false;
const current = () => { assert.ok(environment); return manager.store.get(environment.id); };
const admin = (args: string[], input?: string, timeoutMs = 30_000) => runtime.management(current(), args, { input, timeoutMs });
async function finish(job: Job) {
  await manager.tasks.get(job.id)?.promise;
  const result = manager.store.jobs().find(value => value.id === job.id)!;
  assert.equal(result.status, 'succeeded', `${job.action}: ${result.message}`);
}
async function until<T>(operation: () => Promise<T>, milliseconds = 30_000): Promise<T> {
  const end = Date.now() + milliseconds; let error: unknown;
  while (Date.now() < end) {
    try { return await operation(); } catch (value) { error = value; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  throw error ?? new Error('GPU fixture timed out');
}
async function closeTransport() {
  tools?.close(); tools = undefined;
  const child = transport; transport = undefined;
  if (!child) return;
  child.kill('SIGTERM');
  if (child.exitCode === null) await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
async function openTransport() {
  assert.ok(directory && environment);
  const cdp = path.join(directory, 'cdp.sock'); await rm(cdp, { force: true });
  transport = spawn('/usr/bin/ssh', ['-F', path.join(runtime.limaHome, environment.instanceName, 'ssh.config'), '-S', 'none', '-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindMask=0077', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', '-L', `${cdp}:127.0.0.1:9222`, `lima-${environment.instanceName}`], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  transport.on('error', error => { report.transportError = String(error); });
  return cdp;
}
async function startCapture() {
  if (allContexts) await admin(['sudo', 'python3', '-'], `import json,pathlib\nassets=json.loads(${JSON.stringify(JSON.stringify({ ...WEBGPU_WORKER_ASSETS, ...(workerCanvases ? WORKER_CANVAS_ASSETS : {}), ...(deviceLoss ? DEVICE_LOSS_ASSETS : {}) }))})\nfor name,source in assets.items():pathlib.Path('/tmp',name.lstrip('/')).write_text(source)\n`);
  await admin(['bash', '-s'], `set -eu
sudo systemd-run --unit=mu-gpu-page --uid=dev --working-directory=/tmp /usr/bin/python3 -m http.server 18767 --bind 127.0.0.1
sudo systemd-run --unit=mu-gpu-capture /usr/bin/tcpdump --immediate-mode -ni eth0 -Q out -U -s 96 -w /tmp/mu-gpu.pcap 'ip or ip6'
sleep 1
`); captureStarted = true;
  assert.match(await runtime.guest(current(), ['curl', '--fail', '--silent', '--max-time', '15', '--proxy', '', 'https://example.com/']), /Example Domain/);
}
async function finishCapture(name: string) {
  await admin(['sudo', 'systemctl', 'stop', 'mu-gpu-capture.service']);
  const encoded = await runtime.management(current(), ['sudo', 'base64', '-w0', '/tmp/mu-gpu.pcap'], { timeoutMs: 60_000, maxBytes: 128_000_000 });
  const bytes = Buffer.from(encoded.trim(), 'base64'), destination = path.join(artifacts, name);
  assert.ok(bytes.length > 24); await writeFile(destination, bytes, { mode: 0o600 });
  const allowed = `(tcp and dst host 192.168.5.2 and dst port ${proxyPort}) or (tcp and src port 22 and dst host 192.168.5.2) or (udp and src port 68 and dst port 67)`;
  const rejected = await runtime.runner('/usr/sbin/tcpdump', ['-nn', '-r', destination, `ip6 or (ip and not (${allowed}))`], { timeoutMs: 30_000 });
  assert.ok(!rejected.split('\n').some(line => /^\d\d:\d\d:\d\d\./.test(line)), rejected);
  const approved = await runtime.runner('/usr/sbin/tcpdump', ['-nn', '-r', destination, `tcp and dst host 192.168.5.2 and dst port ${proxyPort}`], { timeoutMs: 30_000, maxBytes: 64_000_000 });
  const count = approved.split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line)).length; assert.ok(count > 0);
  report.captures.push({ file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), approvedProxyPackets: count, unapprovedPackets: 0 });
  captureStarted = false;
}
const draw = `(async()=>{
 document.body.style.cssText='margin:0;background:#fff;color:#152329;font:16px sans-serif';
 document.body.innerHTML='<h1>MuCodeSandbox GPU acceptance</h1>';
 const two=document.createElement('canvas');two.width=256;two.height=256;document.body.append(two);
 const context=two.getContext('2d');if(!context)throw Error('Canvas2D unavailable');
 context.fillStyle='#ffffff';context.fillRect(0,0,256,256);context.fillStyle='#16894f';context.fillRect(24,24,160,160);
 context.fillStyle='#152329';context.font='20px sans-serif';context.fillText('Canvas2D',24,220);
 const pixels=context.getImageData(0,0,256,256).data;let colored=0,white=0;
 for(let i=0;i<pixels.length;i+=4){if(pixels[i]===22&&pixels[i+1]===137&&pixels[i+2]===79)colored++;if(pixels[i]===255&&pixels[i+1]===255&&pixels[i+2]===255)white++;}
 window.__MU_GPU_2D__={colored,white,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))).map(v=>v.toString(16).padStart(2,'0')).join('')};
 const result=[];
 for(const kind of ['webgl','webgl2']){
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;document.body.append(canvas);
  let creationError=null;canvas.addEventListener('webglcontextcreationerror',event=>creationError=event.statusMessage);
  const gl=canvas.getContext(kind,{preserveDrawingBuffer:true,antialias:false});
  if(!gl){result.push({kind,supported:false,creationError});continue;}
  const shader=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));return shader;};
  const modern=kind==='webgl2';
  const vertex=shader(gl.VERTEX_SHADER,(modern?'#version 300 es\\n in':'attribute')+' vec2 position;uniform float offset;void main(){gl_Position=vec4(position+vec2(offset,0.0),0.0,1.0);}');
  const fragment=shader(gl.FRAGMENT_SHADER,modern?'#version 300 es\\n precision mediump float;out vec4 color;void main(){color=vec4(0.1,0.8,0.3,1.0);}':'precision mediump float;void main(){gl_FragColor=vec4(0.1,0.8,0.3,1.0);}');
  const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-.65,-.65,.65,-.65,0,.65]),gl.STATIC_DRAW);
  const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
  const offset=gl.getUniformLocation(program,'offset');
  const render=async(value)=>{gl.uniform1f(offset,value);gl.clearColor(.9,.1,.2,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,3);gl.finish();
   const bytes=new Uint8Array(256*256*4);gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
   let green=0,background=0;for(let i=0;i<bytes.length;i+=4){if(bytes[i+1]>180&&bytes[i]<50)green++;if(bytes[i]>200&&bytes[i+1]<50)background++;}
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');return {hash,green,background,error:gl.getError()};};
  const first=await render(0),repeated=await render(0),moved=await render(.2);
  const extension=gl.getExtension('WEBGL_debug_renderer_info');
  result.push({kind,supported:true,first,repeated,moved,version:gl.getParameter(gl.VERSION),vendor:gl.getParameter(extension?extension.UNMASKED_VENDOR_WEBGL:gl.VENDOR),renderer:gl.getParameter(extension?extension.UNMASKED_RENDERER_WEBGL:gl.RENDERER)});
 }
 return result;
})()`;
async function stopBrowser() {
  if (tools) {
    const socket = tools.socket;
    const closed = new Promise<void>(resolve => { const timer = setTimeout(resolve, 5000); socket.once('close', () => { clearTimeout(timer); resolve(); }); });
    await tools.send('Browser.close').catch(() => {}); await closed; tools.close(); tools = undefined;
  }
  await admin(['sudo', 'systemctl', 'stop', GUEST_BROWSER_SERVICE]);
}
async function variant(name: string, flags: string[], cdp: string, graphicsEnvironment: Record<string, string> = {}) {
  console.log(new Date().toISOString(), `GPU variant: ${name}`);
  const row: Record<string, any> = { name, flags, graphicsEnvironment, passed: false }; report.variants.push(row);
  try {
    if (candidateLifecycle) {
      await startGuestBrowser(runtime, current(), randomBytes(6).toString('base64url'));
      row.startupGuardVerified = true;
      const actualLauncher = await admin(['sudo', 'cat', '/usr/local/libexec/mu-guest-browser']);
      assert.match(actualLauncher, /--disable-dawn-features=adapter_blocklist/);
      assert.match(actualLauncher, /--enable-features=Vulkan/);
      if (swiftshaderVulkan) assert.match(actualLauncher, /--use-vulkan=swiftshader/);
      if (graphiteCandidate) assert.match(actualLauncher, /--skia-graphite-dawn-backend=swiftshader/);
      row.launcherSha256 = createHash('sha256').update(actualLauncher).digest('hex');
      await writeFile(path.join(artifacts, `${name}-launcher.sh`), actualLauncher, { mode: 0o600 });
      row.bootId = (await admin(['cat', '/proc/sys/kernel/random/boot_id'])).trim();
    } else {
    await admin(['sudo', 'python3', '-'], `import json,pathlib,shlex,subprocess
data=json.loads(${JSON.stringify(JSON.stringify({ launcher, flags, graphicsEnvironment, production: productionOnly, diagnostic: mesaDiagnostic }))})
lines=data['launcher'].splitlines();matches=[]
if not data['production']:lines=[line for line in lines if not line.startswith(('export LP_NUM_THREADS=','export MESA_SHADER_CACHE_DISABLE=','export GALLIUM_DRIVER=','export LIBGL_ALWAYS_SOFTWARE='))]
for index,line in enumerate(lines):
 args=shlex.split(line)
 if args and args[0].endswith('/chrome-linux-arm64/chrome') and args[-1]=='&':matches.append((index,args))
assert len(matches)==1
index,args=matches[0]
baseline=[arg for arg in args[1:-1] if arg not in ('--gpu-sandbox-start-early','--use-gl=disabled','--use-gl=angle','--use-angle=gl','--ignore-gpu-blocklist')]
if not data['production']:lines[index]=shlex.join([args[0]]+data['flags']+baseline)+' &'
assert set(data['graphicsEnvironment'])<=set(['LP_NUM_THREADS','MESA_SHADER_CACHE_DISABLE','GALLIUM_DRIVER','LIBGL_ALWAYS_SOFTWARE'])
lines[index:index]=['export '+key+'='+shlex.quote(value) for key,value in data['graphicsEnvironment'].items()]
receipt="import os,json,pathlib;keys=['LP_NUM_THREADS','MESA_SHADER_CACHE_DISABLE','GALLIUM_DRIVER','LIBGL_ALWAYS_SOFTWARE'];p=pathlib.Path('/run/mu-browser/graphics-environment.json');p.write_text(json.dumps({'uid':os.getuid(),'environment':{k:os.environ[k] for k in keys if k in os.environ}}));p.chmod(0o600)"
if data['diagnostic']:lines.insert(index+len(data['graphicsEnvironment']),shlex.join(['/usr/bin/python3','-c',receipt]))
target=pathlib.Path('/usr/local/libexec/mu-guest-browser');target.write_text('\\n'.join(lines)+'\\n');target.chmod(0o755)
subprocess.run(['systemctl','start','${GUEST_BROWSER_SERVICE}'],check=True)
`);
    }
    tools = await until(() => DevTools.open(cdp));
    row.invocationId = (await admin(['systemctl', 'show', GUEST_BROWSER_SERVICE, '--property=InvocationID', '--value'])).trim();
    assert.match(row.invocationId, /^[a-f0-9]{32}$/);
    const targets = await tools.send('Target.getTargets');
    const target = targets.targetInfos.find((value: any) => value.type === 'page'); assert.ok(target);
    const { sessionId } = await tools.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await tools.send('Page.navigate', { url: 'http://127.0.0.1:18767/' }, sessionId);
    await until(async () => {
      const value = await tools!.send('Runtime.evaluate', { expression: 'document.readyState+":"+location.port', returnByValue: true }, sessionId);
      assert.equal(value.result.value, 'complete:18767'); return true;
    });
    const evaluated = await tools.send('Runtime.evaluate', { expression: draw, awaitPromise: true, returnByValue: true }, sessionId);
    assert.equal(evaluated.exceptionDetails, undefined, JSON.stringify(evaluated.exceptionDetails)); row.rendering = evaluated.result.value;
    row.canvas2D = (await tools.send('Runtime.evaluate', { expression: 'window.__MU_GPU_2D__', returnByValue: true }, sessionId)).result.value;
    assert.equal(row.canvas2D.colored, 25600); assert.ok(row.canvas2D.white > 20000); assert.match(row.canvas2D.hash, /^[a-f0-9]{64}$/);
    if (webgpu) {
      const probe = await tools.send('Runtime.evaluate', { expression: allContexts ? WEBGPU_ALL_CONTEXTS : WEBGPU_CONTEXTS, awaitPromise: true, returnByValue: true }, sessionId);
      assert.equal(probe.exceptionDetails, undefined, JSON.stringify(probe.exceptionDetails));
      row.webGPU = probe.result.value;
      row.webGPUComputeAndRenderVerified = allContexts ? verifyWebGPUAllContexts(row.webGPU) : verifyWebGPUContexts(row.webGPU);
      if ((candidateLifecycle || presentationDiagnostic) && row.webGPUComputeAndRenderVerified) {
        const presentation = await tools.send('Runtime.evaluate', { expression: WEBGPU_PRESENTATION, awaitPromise: true, returnByValue: true }, sessionId);
        assert.equal(presentation.exceptionDetails, undefined, JSON.stringify(presentation.exceptionDetails));
        row.presentation = presentation.result.value;
        row.webGPUCanvasVerified = verifyWebGPUPresentation(row.presentation);
        row.presentationScreenshots = [];
        for (const [frameName, offset] of [['first', 0], ['moved', .2]] as const) {
          const frame = await tools.send('Runtime.evaluate', { expression: `window.__MU_WEBGPU_PRESENT__(${offset})`, awaitPromise: true, returnByValue: true }, sessionId);
          assert.equal(frame.exceptionDetails, undefined, JSON.stringify(frame.exceptionDetails));
          const screenshot = await tools.send('Page.captureScreenshot', { format: 'png' }, sessionId);
          const bytes = Buffer.from(screenshot.data, 'base64');
          await writeFile(path.join(artifacts, `${name}-webgpu-${frameName}.png`), bytes, { mode: 0o600 });
          const decoded = await tools.send('Runtime.evaluate', { expression: `(async()=>{
const bytes=Uint8Array.from(atob(${JSON.stringify(screenshot.data)}),v=>v.charCodeAt(0)),bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
const b=${JSON.stringify(frame.result.value.bounds)},scale=c.width/innerWidth;
if(b.x<0||b.y<0||b.x+b.width>innerWidth||b.y+b.height>innerHeight)throw Error('WebGPU canvas outside screenshot viewport');
const data=ctx.getImageData(Math.round(b.x*scale),Math.round(b.y*scale),Math.round(b.width*scale),Math.round(b.height*scale)).data;let green=0,red=0;
for(let i=0;i<data.length;i+=4){if(data[i]===0&&data[i+1]===255&&data[i+2]===0&&data[i+3]===255)green++;if(data[i]===255&&data[i+1]===0&&data[i+2]===0&&data[i+3]===255)red++;}
return {green,red,pixels:data.length/4,scale};
})()`, awaitPromise: true, returnByValue: true }, sessionId);
          assert.equal(decoded.exceptionDetails, undefined, JSON.stringify(decoded.exceptionDetails));
          const pixel = decoded.result.value;
          const verified = pixel.green > 1000 && pixel.red > 1000 && pixel.green + pixel.red === pixel.pixels
            && Math.abs(pixel.green / pixel.pixels - frame.result.value.green / 4096) < .01;
          row.presentationScreenshots.push({ frameName, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, pixel, verified });
        }
        row.webGPUCanvasVerified &&= row.presentationScreenshots.length === 2 && row.presentationScreenshots.every((frame: any) => frame.verified)
          && row.presentationScreenshots[0].sha256 !== row.presentationScreenshots[1].sha256;
      }
      if (workerCanvases && row.webGPUComputeAndRenderVerified) {
        row.workerCanvases = await measureWorkerCanvases({
          send: (method, params, session) => tools!.send(method, params, session),
          trace: listener => {
            const received = (data: any) => { const message = JSON.parse(data.toString());if (message.method?.startsWith('Tracing.')) listener(message); };
            tools!.socket.on('message', received);return () => tools!.socket.off('message', received);
          },
        }, sessionId, async (frame, bytes) => { await writeFile(path.join(artifacts, `${name}-workers-${frame}.png`), bytes, { mode: 0o600 }); },
        async () => JSON.parse(await admin(['sudo', 'python3', '-'], WORKER_PROCESS_INSPECTION)));
      }
    }
    row.gpuDiagnostics = await tools.send('SystemInfo.getInfo');
    row.processSecurity = JSON.parse((await admin(['sudo', 'python3', '-'], BROWSER_PROCESS_INSPECTION)).trim());
    if (mesaDiagnostic) {
      row.graphicsEnvironmentAtLaunch = JSON.parse(await admin(['sudo', 'cat', '/run/mu-browser/graphics-environment.json']));
      assert.equal(row.graphicsEnvironmentAtLaunch.uid, row.processSecurity.developmentUid);
      assert.deepEqual(row.graphicsEnvironmentAtLaunch.environment, graphicsEnvironment);
      // Chromium relocates environ when rewriting its Linux process title.
      // /proc/PID/environ is an observation, not proof of the active values.
      row.graphicsEnvironmentObserved = JSON.parse(await admin(['sudo', 'python3', '-'], `import pathlib,json
pids=${JSON.stringify(row.processSecurity.processes.filter((process: any) => process.role === 'gpu-process').map((process: any) => process.pid))}
allowed=set([b'LP_NUM_THREADS',b'MESA_SHADER_CACHE_DISABLE',b'GALLIUM_DRIVER',b'LIBGL_ALWAYS_SOFTWARE'])
rows=[]
for pid in pids:
 values={}
 for item in pathlib.Path('/proc',str(pid),'environ').read_bytes().split(bytes([0])):
  key,separator,value=item.partition(b'=')
  if separator and key in allowed:values[key.decode()]=value.decode()
 rows.append({'pid':pid,'environment':values})
print(json.dumps(rows))
`));
    }
    const renderers = row.processSecurity.processes.filter((process: any) => process.role === 'renderer');
    const graphics = row.processSecurity.processes.filter((process: any) => process.role === 'gpu-process');
    const protectedThreads = (process: any) => process.threads.length > 0 && process.threads.every((thread: any) => thread.seccomp === 2 && thread.noNewPrivileges === 1 && /^0+$/.test(thread.effectiveCapabilities));
    row.rendererSandboxVerified = renderers.length > 0 && renderers.every((process: any) => process.uid === row.processSecurity.developmentUid && process.seccomp === 2 && process.noNewPrivileges === 1 && /^0+$/.test(process.effectiveCapabilities) && process.separatePidNamespace && !process.noSandboxFlag && protectedThreads(process));
    row.gpuSandboxVerified = graphics.length > 0 && row.gpuDiagnostics.gpu.auxAttributes.sandboxed && graphics.every((process: any) => process.uid === row.processSecurity.developmentUid && process.seccomp === 2 && process.noNewPrivileges === 1 && /^0+$/.test(process.effectiveCapabilities) && !process.noSandboxFlag && protectedThreads(process));
    row.webGLRenderingVerified = row.rendering.length === 2 && row.rendering.every((value: any) => value.supported && value.first.green > 1000 && value.first.background > 1000 && value.first.hash === value.repeated.hash && value.first.hash !== value.moved.hash && [value.first, value.repeated, value.moved].every(frame => frame.error === 0));
    const screenshot = await tools.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const bytes = Buffer.from(screenshot.data, 'base64'); await writeFile(path.join(artifacts, `${name}.png`), bytes, { mode: 0o600 });
    row.screenshot = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    row.protection = await runtime.networkProtection(current()); assert.equal(row.protection.active, true);
    row.stabilitySamples = [];
    for (let sample = 0; sample < ((mesaDiagnostic || productionOnly || webgpuDiagnostic) && row.webGLRenderingVerified && row.gpuSandboxVerified ? 15 : 3); sample++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const gpu = (await tools.send('SystemInfo.getInfo')).gpu;
      const security = JSON.parse((await admin(['sudo', 'python3', '-'], BROWSER_PROCESS_INSPECTION)).trim());
      row.stabilitySamples.push({ at: new Date().toISOString(), gpu: gpu.auxAttributes, processSecurity: security });
    }
    row.gpuCrashCount = Math.max(row.gpuDiagnostics.gpu.auxAttributes.processCrashCount, ...row.stabilitySamples.map((sample: any) => sample.gpu.processCrashCount));
    const graphicsPids = graphics.map((process: any) => process.pid).sort();
    row.stableGraphicsVerified = row.stabilitySamples.every((sample: any) => {
      const processes = sample.processSecurity.processes.filter((process: any) => process.role === 'gpu-process');
      return sample.gpu.sandboxed && JSON.stringify(processes.map((process: any) => process.pid).sort()) === JSON.stringify(graphicsPids) && processes.every(protectedThreads);
    });
    row.sandboxed2DVerified = row.rendererSandboxVerified && row.gpuSandboxVerified && row.stableGraphicsVerified && row.gpuCrashCount === 0;
    row.passed = row.sandboxed2DVerified && row.webGLRenderingVerified;
    if (candidateLifecycle) row.passed &&= row.webGPUComputeAndRenderVerified && row.webGPUCanvasVerified && row.startupGuardVerified;
    if (workerCanvases) row.passed &&= row.workerCanvases?.passed === true;
    if (presentationDiagnostic) row.passed &&= row.webGPUComputeAndRenderVerified && row.webGPUCanvasVerified;
    if (deviceLoss && row.passed) {
      row.deviceLoss = await measureDeviceLoss({
        send: (method, params, session) => tools!.send(method, params, session),
        trace: listener => {
          const received = (data: any) => { const message = JSON.parse(data.toString());if (message.method?.startsWith('Tracing.')) listener(message); };
          tools!.socket.on('message', received);return () => tools!.socket.off('message', received);
        },
      }, sessionId, async (frame, bytes) => { await writeFile(path.join(artifacts, `${name}-recovered-${frame}.png`), bytes, { mode: 0o600 }); },
      async () => JSON.parse(await admin(['sudo', 'python3', '-'], WORKER_PROCESS_INSPECTION)), () => runtime.networkProtection(current()));
      row.passed &&= row.deviceLoss.passed;
    }
  } catch (error) { row.error = (error as Error).stack; }
  finally {
    row.browserJournal = await admin(['sudo', 'journalctl', ...(row.invocationId ? [`_SYSTEMD_INVOCATION_ID=${row.invocationId}`] : ['-u', GUEST_BROWSER_SERVICE]), '--no-pager', '-n', '200']).catch(String);
    const gpuExits = row.browserJournal.match(/GPU process exited unexpectedly/g)?.length ?? 0;
    if (gpuExits && !(deviceLoss && row.deviceLoss?.passed === true && gpuExits === 1)) { row.sandboxed2DVerified = false; row.passed = false; }
    await stopBrowser();
    row.profileExitType = (await runtime.guest(current(), ['python3', '-c', 'import json,pathlib;print(json.loads(pathlib.Path("/home/dev/.local/share/mucodesandbox/browser/Default/Preferences").read_text())["profile"]["exit_type"])'])).trim();
    await writeFile(path.join(artifacts, 'observations.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ name, passed: row.passed, rendererSandboxVerified: row.rendererSandboxVerified, gpuSandboxVerified: row.gpuSandboxVerified, webGLRenderingVerified: row.webGLRenderingVerified, error: row.error }));
  }
}
async function guardFault(cdp: string) {
  console.log(new Date().toISOString(), 'GPU guard: actual disabled-sandbox fault');
  const original = runtime.management.bind(runtime);
  const fault: Record<string, any> = { injected: false, rejected: false }; report.guardFault = fault;
  runtime.management = async (e, args, options = {}) => {
    const output = await original(e, args, options);
    if (!fault.injected && args[0] === 'bash' && options.input?.includes("'MU_READY'")) {
      fault.injected = true;
      await original(e, ['sudo', 'python3', '-'], { timeoutMs: 30_000, input: `import pathlib,shlex,subprocess,time,urllib.request
target=pathlib.Path('/usr/local/libexec/mu-guest-browser');lines=target.read_text().splitlines();matches=[]
for index,line in enumerate(lines):
 args=shlex.split(line)
 if args and args[0].endswith('/chrome-linux-arm64/chrome') and args[-1]=='&':matches.append((index,args))
assert len(matches)==1
index,args=matches[0];lines[index]=shlex.join(args[:-1]+['--disable-gpu-sandbox'])+' &'
subprocess.run(['systemctl','stop','${GUEST_BROWSER_SERVICE}'],check=True)
target.write_text('\\n'.join(lines)+'\\n')
subprocess.run(['systemctl','start','${GUEST_BROWSER_SERVICE}'],check=True)
for attempt in range(100):
 try:
  with urllib.request.urlopen('http://127.0.0.1:9222/json/version',timeout=1) as response:assert response.status==200
  break
 except (OSError,AssertionError):time.sleep(.1)
time.sleep(.5)
` });
      fault.processSecurity = JSON.parse((await original(e, ['sudo', 'python3', '-'], { input: BROWSER_PROCESS_INSPECTION, timeoutMs: 10_000 })).trim());
      const graphics = fault.processSecurity.processes.filter((process: any) => process.role === 'gpu-process');
      assert.ok(graphics.length > 0 && graphics.every((process: any) => process.seccomp === 0));
      const diagnostic = await DevTools.open(cdp);
      try {
        fault.targets = (await diagnostic.send('Target.getTargets')).targetInfos.map((target: any) => ({ type: target.type, url: target.url }));
        assert.ok(fault.targets.some((target: any) => target.type === 'page' && target.url === 'about:blank'));
        assert.ok(fault.targets.every((target: any) => !/^https?:/.test(target.url)));
      } finally { diagnostic.close(); }
    }
    return output;
  };
  try {
    await startGuestBrowser(runtime, current(), randomBytes(6).toString('base64url'));
  } catch (error) { fault.error = String(error); fault.rejected = (error as { code?: string }).code === 'BROWSER_SANDBOX_FAILED'; }
  finally { runtime.management = original; }
  assert.equal(fault.injected, true); assert.equal(fault.rejected, true);
  fault.finalServiceState = (await admin(['systemctl', 'show', GUEST_BROWSER_SERVICE, '--property=ActiveState', '--value'])).trim();
  assert.ok(['inactive', 'failed'].includes(fault.finalServiceState));
  await admin(['sudo', 'test', '!', '-e', '/run/mucodesandbox-browser-secret/vnc']);
  fault.remoteDisplaySecretRemoved = true; fault.noWebsiteNavigation = true;
  report.startupGuardFaultVerified = true;
}
try {
  await verifyPackage();
  await mkdir(path.join(temporary, 'tools/guest-browser'), { recursive: true, mode: 0o700 });
  await copyFile(`/tmp/mu-chromium-${GUEST_CHROMIUM_VERSION}-arm64.zip`, path.join(temporary, `tools/guest-browser/chrome-${GUEST_CHROMIUM_VERSION}-linux-arm64.zip`)).catch(() => {});
  const configuration = { name: 'Browser GPU matrix', cpus: 2, memoryGiB: 2, diskGiB: 10, browserUrl: 'http://127.0.0.1:18767/', identity: { timezone: 'Asia/Tokyo', locale: 'ja-JP' }, network: { mode: 'http', host: '127.0.0.1', port: proxyPort, username: 'mu', password: 'gpu-verification', strict: true, transparent: true, noProxy: '' } };
  const previous = retained && process.argv.includes('--reuse-environment') ? manager.store.list().findLast(value => value.name === configuration.name) : undefined;
  report.reusedStoppedEnvironment = !!previous;
  environment = previous ? await manager.update(previous.id, configuration) : await manager.create(configuration);
  await finish(await manager.lifecycle(environment.id, 'start'));
  report.initialProtection = await runtime.networkProtection(current()); assert.equal(report.initialProtection.active, true);
  await ensureGuestBrowser(runtime, current());
  if (process.argv.includes('--expanded') || webgpuDiagnostic) await admin(['bash', '-s'], 'set -eu\nsudo -E env DEBIAN_FRONTEND=noninteractive apt-get update -qq\nsudo -E env DEBIAN_FRONTEND=noninteractive SYSTEMD_OFFLINE=1 NEEDRESTART_MODE=l apt-get install -y --no-install-recommends mesa-vulkan-drivers\n', 600_000);
  report.driverInventory = await admin(['bash', '-c', 'dpkg-query -W -f=\'${binary:Package} ${db:Status-Abbrev} ${Version}\\n\' "*mesa*" "*vulkan*" 2>/dev/null || true']);
  await startCapture();
  const bypass = await runtime.guest(current(), ['curl', '--fail', '--silent', '--max-time', '3', '--proxy', '', '--interface', 'eth0', 'http://1.1.1.1/']).then(() => true, () => false);
  assert.equal(bypass, false); report.directBypassRejected = true;
  await startGuestBrowser(runtime, current(), randomBytes(6).toString('base64url'));
  launcher = await admin(['sudo', 'cat', '/usr/local/libexec/mu-guest-browser']);
  directory = await mkdtemp('/tmp/mu-gpu-view-'); let cdp = await openTransport();
  tools = await until(() => DevTools.open(cdp)); await stopBrowser();
  const softwareEnvironment = { LP_NUM_THREADS: '0', GALLIUM_DRIVER: 'llvmpipe', LIBGL_ALWAYS_SOFTWARE: '1', MESA_SHADER_CACHE_DISABLE: 'true' };
  const softwareFlags = ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'];
  const candidateFlags = [...softwareFlags, ...candidateExtraFlags];
  const variants: [string, string[], Record<string, string>?][] = presentationDiagnostic && swiftshaderVulkan ? [
    ['swiftshader-vulkan', candidateFlags, softwareEnvironment],
    ['swiftshader-vulkan-no-surface', [...candidateFlags, '--disable-vulkan-surface'], softwareEnvironment],
    ['swiftshader-graphite', [...candidateFlags, '--enable-skia-graphite', '--skia-graphite-dawn-backend=swiftshader'], softwareEnvironment],
  ] : presentationDiagnostic ? [
    ['original-shared-image', candidateFlags, softwareEnvironment],
    ['vulkan-surface-disabled', [...candidateFlags, '--disable-vulkan-surface'], softwareEnvironment],
    ['swiftshader-sharing', ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--disable-dawn-features=adapter_blocklist', '--enable-features=Vulkan,VulkanFromANGLE'], softwareEnvironment],
    ['mesa-vulkan-sharing', ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--disable-dawn-features=adapter_blocklist', '--enable-features=Vulkan,VulkanFromANGLE'], softwareEnvironment],
  ] : candidateLifecycle ? [
    ['candidate-fresh', candidateFlags, softwareEnvironment],
    ['candidate-browser-reopened', candidateFlags, softwareEnvironment],
  ] : dawnBlocklistDiagnostic ? [
    ['dawn-blocklist-control', softwareFlags, softwareEnvironment],
    ['dawn-blocklist-override', [...softwareFlags, '--disable-dawn-features=adapter_blocklist'], softwareEnvironment],
    ['dawn-blocklist-vulkan', [...softwareFlags, '--disable-dawn-features=adapter_blocklist', '--enable-features=Vulkan'], softwareEnvironment],
  ] : webgpuDiagnostic ? [
    ['vulkan-driver-only', softwareFlags, softwareEnvironment],
    ['vulkan-feature', [...softwareFlags, '--enable-features=Vulkan'], softwareEnvironment],
    ['vulkan-angle', ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'], softwareEnvironment],
  ] : productionOnly ? [['production', []]] : mesaDiagnostic ? [
    ['production-2d', ['--gpu-sandbox-start-early', '--use-gl=disabled']],
    ['mesa-early-override', ['--gpu-sandbox-start-early', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist']],
    ['mesa-early-single', ['--gpu-sandbox-start-early', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'], { LP_NUM_THREADS: '0', GALLIUM_DRIVER: 'llvmpipe', LIBGL_ALWAYS_SOFTWARE: '1', MESA_SHADER_CACHE_DISABLE: 'true' }],
    ['mesa-late-default', ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist']],
    ['mesa-late-single', ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'], { LP_NUM_THREADS: '0', GALLIUM_DRIVER: 'llvmpipe', LIBGL_ALWAYS_SOFTWARE: '1', MESA_SHADER_CACHE_DISABLE: 'true' }],
    ['mesa-late-one', ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'], { LP_NUM_THREADS: '1', GALLIUM_DRIVER: 'llvmpipe', LIBGL_ALWAYS_SOFTWARE: '1', MESA_SHADER_CACHE_DISABLE: 'true' }],
    ['mesa-late-single-repeat', ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'], { LP_NUM_THREADS: '0', GALLIUM_DRIVER: 'llvmpipe', LIBGL_ALWAYS_SOFTWARE: '1', MESA_SHADER_CACHE_DISABLE: 'true' }],
  ] : guardOnly ? [
    ['production-2d', ['--gpu-sandbox-start-early', '--use-gl=disabled']],
  ] : [
    ['default', []],
    ['early-sandbox', ['--gpu-sandbox-start-early']],
    ['early-angle-gl', ['--gpu-sandbox-start-early', '--use-gl=angle', '--use-angle=gl']],
    ['early-angle-vulkan', ['--gpu-sandbox-start-early', '--use-gl=angle', '--use-angle=vulkan']],
    ['sandboxed-2d', ['--gpu-sandbox-start-early', '--use-gl=disabled']],
  ];
  if (process.argv.includes('--expanded')) variants.push(
    ['vulkan-late-sandbox', ['--use-gl=angle', '--use-angle=vulkan']],
    ['legacy-init', ['--disable-features=GpuInitOptimization']],
  );
  for (const [name, flags, graphicsEnvironment] of variants) await variant(name, flags, cdp, graphicsEnvironment);
  if (candidateLifecycle) {
    await finishCapture('physical-before-restart.pcap');
    await closeTransport();
    const before = (await admin(['cat', '/proc/sys/kernel/random/boot_id'])).trim();
    await finish(await manager.lifecycle(environment.id, 'stop'));
    await finish(await manager.lifecycle(environment.id, 'start'));
    const after = (await admin(['cat', '/proc/sys/kernel/random/boot_id'])).trim();
    assert.notEqual(before, after);
    report.vmRestart = { before, after, verified: true };
    assert.equal((await runtime.networkProtection(current())).active, true);
    await startCapture(); cdp = await openTransport();
    await variant('candidate-vm-restarted', candidateFlags, cdp, softwareEnvironment);
  }
  await guardFault(cdp);
  await admin(['sudo', 'python3', '-'], `import pathlib;pathlib.Path('/usr/local/libexec/mu-guest-browser').write_text(${JSON.stringify(launcher)})`);
  if (candidateLifecycle) await variant('candidate-fault-recovered', candidateFlags, cdp, softwareEnvironment);
  else {
    await startGuestBrowser(runtime, current(), randomBytes(6).toString('base64url'));
    tools = await until(() => DevTools.open(cdp)); await stopBrowser();
  }
  report.defaultRecoveryVerified = !candidateLifecycle;
  if (candidateLifecycle) {
    report.candidateStartupRecoveryVerified = report.variants.at(-1)?.startupGuardVerified === true;
    report.candidateRenderingRecoveryVerified = report.variants.at(-1)?.passed === true;
  }
  report.finalProtection = await runtime.networkProtection(current()); assert.equal(report.finalProtection.active, true);
  assert.equal(report.initialProtection.firewallHash, report.finalProtection.firewallHash); assert.equal(report.initialProtection.tunnelConfigHash, report.finalProtection.tunnelConfigHash);
  report.measurementCompleted = true;
  report.accepted3DVariants = report.variants.filter((row: any) => row.passed && row.profileExitType === 'Normal').map((row: any) => row.name);
  report.sandboxed2DVariants = report.variants.filter((row: any) => row.sandboxed2DVerified && row.profileExitType === 'Normal').map((row: any) => row.name);
  report.candidate3DRenderingPassed = report.accepted3DVariants.length > 0;
  report.full3DAcceptancePassed = !mesaDiagnostic && !webgpuDiagnostic && report.candidate3DRenderingPassed;
  report.scope = productionOnly ? 'Unchanged production launcher, actual WebGL and WebGL2 rendering, graphics sandbox, failure rejection and recovery; not full media or WebGPU acceptance'
    : mesaDiagnostic ? 'Isolated Mesa software rendering and blocklist/thread-init diagnostic; not production 3D acceptance'
    : guardOnly ? 'Production 2D sandbox, actual startup failure and recovery; not 3D acceptance' : 'Graphics backend candidates, sandbox and actual 3D rendering';
  report.productionConfigurationChanged = false;
  report.experimentalDawnBlocklistOverride = dawnBlocklistDiagnostic || candidateLifecycle || presentationDiagnostic;
  report.experimentalSwiftshaderVulkan = swiftshaderVulkan;
  report.experimentalGraphiteCandidate = graphiteCandidate;
  report.presentationBackendDiagnostic = presentationDiagnostic;
  if (webgpu) {
    report.webGPUAcceptancePassed = report.variants.some((row: any) => row.passed && row.profileExitType === 'Normal' && row.webGPUComputeAndRenderVerified);
    report.scope = (webgpuDiagnostic ? 'Isolated Vulkan driver and backend diagnostic; not unchanged production acceptance.' : 'Unchanged production launcher.') + ' Default WebGPU adapter, actual compute and offscreen texture rendering in page and DedicatedWorker; graphics sandbox, physical egress, startup fault and recovery. Not WebGPU canvas presentation, all Worker kinds, or long-term stability.';
    if (candidateLifecycle) {
      report.candidateLifecycleVerified = report.vmRestart?.verified && report.startupGuardFaultVerified && report.variants.length === 4
        && report.variants.every((row: any) => row.passed && row.profileExitType === 'Normal' && row.webGPUCanvasVerified && row.startupGuardVerified)
        && new Set(report.variants.map((row: any) => row.invocationId)).size === 4;
      report.webGPUAcceptancePassed &&= report.candidateLifecycleVerified;
      report.scope = `Isolated software WebGPU candidate; ${allContexts ? 'page, DedicatedWorker, actual shared-instance SharedWorker and ServiceWorker' : 'page and DedicatedWorker'} actual compute / texture rendering, real page canvas presentation and screenshot pixels, guarded fresh launch, browser reopen, VM reboot, actual disabled-sandbox fault and candidate recovery. ${workerCanvases ? 'Also native DOM canvases transferred to all three Worker types, actual pixels, and traced active Worker thread/kernel sampling. ' : ''}Not unchanged production, full media, ${allContexts ? (workerCanvases ? '' : 'Worker canvas presentation, ') : 'all Worker kinds, '}packaged UI, first boot capture, or long-term stability.`;
    }
    if (presentationDiagnostic) report.scope = 'Isolated WebGPU presentation backend matrix: actual computation, texture readback, native canvas presentation and screenshot pixels, all observed renderer / graphics thread protection. Startup fault/recovery use unchanged production, not individual candidates. Not production, full lifecycle, media or long-term acceptance.';
  }
  report.passed = guardOnly ? report.sandboxed2DVariants.includes('production-2d') && report.startupGuardFaultVerified : report.candidate3DRenderingPassed;
  if (webgpu) report.passed = report.passed && report.webGPUAcceptancePassed;
  if (!report.passed) process.exitCode = 1;
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
finally {
  if (environment && captureStarted) {
    try {
      await finishCapture('physical-out.pcap');
    } catch (error) { report.captureError = String(error); report.passed = false; process.exitCode = 1; }
  }
  if (environment) await stopGuestBrowser(runtime, current()).catch(() => {});
  await closeTransport();
  if (directory) await rm(directory, { recursive: true, force: true });
  if (environment) await manager.lifecycle(environment.id, 'stop').then(finish).catch(async error => { report.cleanupError = String(error); await runtime.command(['stop', '--force', environment!.instanceName], { timeoutMs: 60_000 }).catch(() => {}); });
  await service.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve()));
  if (report.measurementCompleted && !report.cleanupError && !report.captureError && !process.argv.includes('--retain')) {
    for (const instance of await runtime.list()) await runtime.command(['delete', '--force', instance.name], { timeoutMs: 60_000 });
    await rm(temporary, { recursive: true, force: true }); report.temporaryVmDataRemoved = true;
  } else report.retainedDataDir = temporary;
  report.authenticatedProxyConnections = proxyConnections; report.finishedAt = new Date().toISOString();
  for (const [file, hash] of Object.entries(report.testedFiles)) {
    const bytes = await readFile(path.join(root, file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, `Source changed during GPU observation: ${file}`);
    const destination = path.join(artifacts, 'source', file);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { mode: 0o600 });
  }
  await writeFile(path.join(root, 'test-results', `${reportName}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, measurementCompleted: report.measurementCompleted, accepted3DVariants: report.accepted3DVariants, sandboxed2DVariants: report.sandboxed2DVariants, captures: report.captures, error: report.error, retainedDataDir: report.retainedDataDir }, null, 2));
}
