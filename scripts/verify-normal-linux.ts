// One disposable protected VM; no production Manager, credentials, profile or global proxy mutation.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, cpus, totalmem } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createService } from '../server/service.ts';
import { LocalProxy } from '../server/local-proxy.ts';
import { run } from '../server/process.ts';
import { createAcceptanceLab } from '../server/acceptance-lab.ts';
import { CURRENT_BROWSER_RELEASE, browserExecutable } from '../server/browser-releases.ts';
import { DEFAULT_FIXED_DISPLAY } from '../shared/guest-display.ts';
import { INSPECT_GUEST_AUDIO_SCRIPT, GUEST_AUDIO_TEST_TONE_EXPRESSION } from '../server/guest-audio.ts';
import { collectGuestAudioSignal } from './guest-audio-proof.ts';
import { seedProtectedTestBase } from './seed-protected-test-base.ts';
import type { Job } from '../shared/types.ts';

const root=path.resolve(import.meta.dirname,'..'), production=path.join(homedir(),'.mucodesandbox');
const retained=process.env.MU_NORMAL_TEST_DATA;
if(retained)assert.ok(path.dirname(retained)===homedir()&&/^\.mu-normal-linux-verification-[A-Za-z0-9]+$/.test(path.basename(retained)));
const owned=retained??await mkdtemp(path.join(homedir(),'.mu-normal-linux-verification-'));
const artifacts=path.join(root,'test-results/normal-linux');await mkdir(artifacts,{recursive:true,mode:0o700});
const report:Record<string,any>={passed:false,startedAt:new Date().toISOString(),dataDir:owned,accountFree:true,paidModelCalls:0,stages:[],scope:'One protected 4 CPU / 4 GiB VM; official stable blank profile, output audio, US functional line, bounded session. No residence/exclusivity/anti-ban/whole-day claim.'};
const stage=(name:string)=>{report.stages.push({name,at:new Date().toISOString()});console.log(name);};
const globalConfig=path.join(homedir(),'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml');
const digest=async(file:string)=>createHash('sha256').update(await readFile(file)).digest('hex');
const originalConfig=await digest(globalConfig);
const line=new LocalProxy(path.join(owned,'us-functional-line'));
const lab=await createAcceptanceLab();const sockets=new Set<Socket>();
let selected:{name:string;port:number}|undefined, service:Awaited<ReturnType<typeof createService>>|undefined;
let environmentId='', hostBrowser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const track=(socket:Socket)=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});};
const labURL=new URL(lab.info().url!);
const fixtureRelay=createServer((request,response)=>{
  const outgoing=httpRequest({hostname:'127.0.0.1',port:Number(labURL.port),path:request.url,method:request.method,headers:{...request.headers,host:labURL.host}},received=>{response.writeHead(received.statusCode!,received.headers);received.pipe(response);});
  outgoing.on('error',()=>response.destroy());response.on('close',()=>outgoing.destroy());request.pipe(outgoing);
});
fixtureRelay.on('connection',track);await new Promise<void>(resolve=>fixtureRelay.listen(0,'127.0.0.1',resolve));
const fixturePort=(fixtureRelay.address() as {port:number}).port;
const relay=createServer((_req,res)=>res.writeHead(405).end());relay.on('connection',track);
const decisions:{target:string;route:string}[]=[];
relay.on('connect',(req,client,head)=>{
  let target:URL;try{target=new URL(`http://${req.url}`);}catch{client.destroy();return;}
  if(/(^|\.)(anthropic\.com|claude\.ai|claude\.com)$/.test(target.hostname)){decisions.push({target:target.hostname,route:'denied-provider'});client.end('HTTP/1.1 403 Local Test Only\r\n\r\n');return;}
  const fixture=target.hostname==='203.0.113.80'&&Number(target.port||80)===80;
  const remote=connect(fixture?fixturePort:selected!.port,'127.0.0.1',()=>{
    if(fixture){decisions.push({target:req.url!,route:'local-fixture'});client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);client.pipe(remote);remote.pipe(client);return;}
    remote.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n\r\n`);
    let response=Buffer.alloc(0);
    const handshake=(data:Buffer)=>{response=Buffer.concat([response,data]);if(response.length>16384){client.destroy();return;}const end=response.indexOf('\r\n\r\n');if(end<0)return;remote.off('data',handshake);if(!/^HTTP\/1\.[01] 200\b/.test(response.toString())){client.destroy();remote.destroy();return;}decisions.push({target:req.url!,route:'dedicated-us-line'});client.write('HTTP/1.1 200 Connection Established\r\n\r\n');const rest=response.subarray(end+4);if(rest.length)client.write(rest);if(head.length)remote.write(head);client.pipe(remote);remote.pipe(client);};
    remote.on('data',handshake);
  });track(remote);remote.on('error',()=>client.destroy());client.on('error',()=>remote.destroy());client.on('close',()=>remote.destroy());
});
await new Promise<void>(resolve=>relay.listen(0,'127.0.0.1',resolve));const proxyPort=(relay.address() as {port:number}).port;
async function freePort(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
async function finish(job:Job){await service!.manager.tasks.get(job.id)?.promise;const done=service!.manager.store.jobs().find(j=>j.id===job.id)!;assert.equal(done.status,'succeeded',done.message);}
const current=()=>service!.manager.store.get(environmentId);
const admin=(args:string[],input?:string,timeoutMs=30000)=>service!.manager.runtime.management(current(),args,{input,timeoutMs});
const guest=(args:string[],timeoutMs=30000)=>service!.manager.runtime.guest(current(),args,{timeoutMs});
const entry=()=>service!.guestBrowser.entries.get(environmentId)!;
async function evaluate(expression:string){const target=(await entry().tools!.send('Target.getTargets')).targetInfos.find((p:any)=>p.type==='page');const session=entry().sessions.get(target.targetId)!;const result=await entry().tools!.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},session);if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
const profilePage='http://127.0.0.1:8131/';
async function navigate(url:string){const target=(await entry().tools!.send('Target.getTargets')).targetInfos.find((p:any)=>p.type==='page');await entry().tools!.send('Page.navigate',{url},entry().sessions.get(target.targetId));for(let i=0;i<40;i++){if(await evaluate(`document.readyState==='complete'&&location.href===${JSON.stringify(url)}`))return;await new Promise(r=>setTimeout(r,100));}throw new Error('Fixture navigation did not settle');}
try{
  stage('Checking isolated US node receipts');
  const nodes=(await line.info()).nodes.filter((n:{name:string;type:string})=>/美国|United States|🇺🇸/.test(n.name));assert.ok(nodes.length);
  selected=await line.start(nodes[0].name,await freePort());report.line={...selected,residential:'unverified',exclusive:'unverified'};
  const output=await run('/usr/bin/curl',['-q','--proxy',`http://127.0.0.1:${selected.port}`,'--noproxy','','--fail','--silent','--show-error','--max-time','15','https://ipwho.is/'],{timeoutMs:18000,maxBytes:65536});
  const initial=JSON.parse(output);assert.equal(initial.success,true);assert.equal(initial.country_code,'US');
  const selectedTimezone=initial.timezone?.id??'America/Los_Angeles';
  assert.ok(selectedTimezone.startsWith('America/'),'The US receipt must supply an American time zone');
  report.initialExit={ip:initial.ip,country:initial.country,countryCode:initial.country_code,city:initial.city,timezone:selectedTimezone};
  process.env.MU_LIMA_PATH=path.join(production,'tools/lima/bin/limactl');
  service=await createService({rootDir:root,dataDir:owned,port:0});
  if(!retained){stage('Seeding a stopped verified base with APFS copy-on-write');report.baseSeed=await seedProtectedTestBase(service.manager.runtime,production);}
  const e=service.manager.store.list()[0]??await service.manager.create({name:'美国功能验证',description:'独立测试资料；不登录真实账号',cpus:4,memoryGiB:4,diskGiB:10,mounts:[],identity:{timezone:selectedTimezone,locale:'en-US'},browserUrl:'https://home.mucodesandbox.invalid/',network:{mode:'http',host:'127.0.0.1',port:proxyPort,username:'',noProxy:'',strict:true,transparent:true,egressLock:{expectedIp:initial.ip}}});
  environmentId=e.id;report.environmentId=e.id;report.instance=e.instanceName;
  if(retained)await service.manager.update(e.id,{name:e.name,description:e.description,kind:e.kind,color:e.color,cpus:4,memoryGiB:4,diskGiB:e.diskGiB,mounts:e.mounts,ports:e.ports,identity:{timezone:selectedTimezone,locale:'en-US'},browserUrl:e.browserUrl,network:{mode:'http',host:'127.0.0.1',port:proxyPort,username:'',noProxy:'',strict:true,transparent:true,egressLock:{expectedIp:initial.ip}}});
  const deb=process.env.MU_STABLE_PACKAGE;assert.ok(deb,'Set MU_STABLE_PACKAGE to the signed verified package');assert.equal(await digest(deb),CURRENT_BROWSER_RELEASE.sha256);
  await mkdir(path.join(owned,'tools/guest-browser'),{recursive:true});await copyFile(deb,path.join(owned,'tools/guest-browser',`chrome-${CURRENT_BROWSER_RELEASE.version}-linux-arm64.deb`));
  const originalMeasure=service.manager.measureExit.bind(service.manager);
  service.manager.measureExit=async(candidate,options)=>{
    try{return await originalMeasure(candidate,options);}catch(error){
      report.probeProxy=service!.manager.runtime.egressProbeProxy(candidate);
      report.startupDiagnostic=await service!.manager.runtime.management(candidate,['bash','-c','sudo ss -ltnp; sudo nft list ruleset; sudo journalctl -u mucodesandbox-tunnel.service -n 8 --no-pager'],{timeoutMs:20000}).catch(err=>String(err));
      report.probeVerbose=await service!.manager.runtime.management(candidate,['sudo','-H','-u','mu-probe','--','env','-i','PATH=/usr/bin:/bin','curl','-q','-v','--max-time','7','--proxy',report.probeProxy,'https://ipwho.is/'],{timeoutMs:10000,onOutput:out=>{report.probeTrace=(report.probeTrace??'')+out;}}).catch(err=>String(err));
      throw error;
    }
  };
  stage('Starting protected 4 CPU / 4 GiB VM');await finish(await service.manager.lifecycle(e.id,'start'));
  const hostnameState=async()=>JSON.parse(await admin(['sudo','python3','-c',`import json,pathlib,socket,os
p=pathlib.Path('/etc/mucodesandbox/guest-hostname.json')
print(json.dumps({'kernel':socket.gethostname(),'file':pathlib.Path('/etc/hostname').read_text().strip(),'state':json.loads(p.read_text()),'cpuCount':os.cpu_count(),'memKiB':int(pathlib.Path('/proc/meminfo').read_text().split('MemTotal:')[1].split()[0]),'machineIdSha256':__import__('hashlib').sha256(pathlib.Path('/etc/machine-id').read_bytes()).hexdigest()}))`]));
  report.hostnameBefore=await hostnameState();assert.equal(report.hostnameBefore.cpuCount,4);assert.ok(!report.hostnameBefore.kernel.startsWith('lima-'));assert.equal(report.hostnameBefore.kernel,report.hostnameBefore.file);
  const before=await service.manager.runtime.networkProtection(current());assert.ok(before.active&&before.integrity==='verified');report.protectionBefore=before;
  stage('Installing official stable Chrome into blank test profile');await finish(await service.manager.openBrowser(e.id,false));
  report.version=await service.guestBrowser.versionStatus(current());assert.equal(report.version.installedVersion,CURRENT_BROWSER_RELEASE.version);assert.equal(report.version.installedChannel,'stable');
  report.identity=await service.guestBrowser.inspect(e.id);assert.ok(report.identity.matchesConfiguration);assert.equal(report.identity.hardwareConcurrency,4);
  report.brand=await entry().tools!.send('Browser.getVersion');
  const pageScript=`from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(b'<title>Mu Linux Fixture</title><h1>Stable browser fixture</h1><input id="text"><canvas id="c" width="100" height="100"></canvas>')
 def log_message(self,*args):pass
ThreadingHTTPServer(('127.0.0.1',8131),H).serve_forever()`;
  await admin(['bash','-s'],`set -eu\nprintf '%s' '${Buffer.from(pageScript).toString('base64')}' | base64 -d | sudo -H -u dev tee /tmp/mu-normal-page.py >/dev/null\nsudo systemd-run --quiet --unit=mu-normal-page --uid=dev --property=Restart=no /usr/bin/python3 /tmp/mu-normal-page.py\n`);
  await navigate(profilePage);
  report.observables=await evaluate(`(async()=>({webdriver:navigator.webdriver,brands:navigator.userAgentData?.brands,screen:{width:screen.width,height:screen.height,dpr:devicePixelRatio},devices:(await navigator.mediaDevices.enumerateDevices()).map(d=>({kind:d.kind,label:d.label})),worker:await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Worker fixture timed out')),3000);const w=new Worker(URL.createObjectURL(new Blob(['postMessage({language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,platform:navigator.platform})'],{type:'text/javascript'})));w.onmessage=e=>{clearTimeout(timer);w.terminate();resolve(e.data)};w.onerror=()=>{clearTimeout(timer);w.terminate();reject(Error('Worker fixture failed'))};})}))()`);
  assert.equal(report.observables.webdriver,false);assert.ok(report.observables.brands.some((b:any)=>b.brand==='Google Chrome'));assert.equal(report.observables.worker.timezone,selectedTimezone);
  stage('Checking guest browser and CLI US exits from two public receivers');
  report.exitSamples=[];
  for(let i=0;i<3;i++){
    const browser=await evaluate(`fetch('https://api.ipify.org?format=json').then(r=>r.json())`);
    const cli=JSON.parse(await guest(['curl','-q','--fail','--silent','--show-error','--max-time','12','https://ipwho.is/']));
    assert.equal(browser.ip,initial.ip);assert.equal(cli.ip,initial.ip);assert.equal(cli.country_code,'US');report.exitSamples.push({at:new Date().toISOString(),browserIp:browser.ip,cliIp:cli.ip,countryCode:cli.country_code});
  }
  stage('Checking real guest audio over authenticated output transport');
  report.audioReadiness=await admin(['bash','-s'],INSPECT_GUEST_AUDIO_SCRIPT);
  const audio=await service.guestAudio.issue(e.id);
  report.audio=await collectGuestAudioSignal({endpoint:service.url,origin:service.url,ticket:audio.ticket,startTone:()=>evaluate(GUEST_AUDIO_TEST_TONE_EXPRESSION)});assert.ok(report.audio.expectedToneDetected);
  stage('Checking profile persistence, desktop and real viewer pixels');
  await navigate(profilePage);report.stored=await evaluate(`(()=>{localStorage.setItem('mu-normal-marker','stable-private');document.cookie='mu_normal=private; path=/; max-age=3600';const c=document.getElementById('c').getContext('2d');c.fillStyle='#27a36f';c.fillRect(0,0,100,100);return {cookie:document.cookie,pixel:[...c.getImageData(0,0,1,1).data]}})()`);assert.deepEqual(report.stored.pixel,[39,163,111,255]);
  await service.guestBrowser.resize(e.id,DEFAULT_FIXED_DISPLAY);
  hostBrowser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context=await hostBrowser.newContext({viewport:{width:1900,height:1250},deviceScaleFactor:2});const viewer=await context.newPage();await viewer.goto(service.launchUrl(`/?guestBrowser=${e.id}`));await viewer.getByRole('status').filter({hasText:'已连接'}).waitFor({timeout:30000});const canvas=viewer.locator('.guest-browser-canvas canvas');await canvas.waitFor();await viewer.waitForTimeout(1500);
  report.viewer=await canvas.evaluate((c:HTMLCanvasElement)=>({width:c.width,height:c.height,rect:{width:c.getBoundingClientRect().width,height:c.getBoundingClientRect().height},hostDpr:devicePixelRatio}));assert.equal(report.viewer.width,3200);assert.equal(report.viewer.height,2000);await viewer.screenshot({path:path.join(artifacts,'stable-browser.png')});
  const screenBefore=await evaluate('JSON.stringify({width:screen.width,height:screen.height,dpr:devicePixelRatio})');await viewer.setViewportSize({width:1100,height:780});await viewer.waitForTimeout(1600);assert.equal(await evaluate('JSON.stringify({width:screen.width,height:screen.height,dpr:devicePixelRatio})'),screenBefore);report.fixedDesktopSurvivesViewerResize=true;
  await hostBrowser.close();hostBrowser=undefined;
  await service.manager.closeBrowser(e.id);await finish(await service.manager.openBrowser(e.id,false));await navigate(profilePage);report.reopened=await evaluate(`({cookie:document.cookie,marker:localStorage.getItem('mu-normal-marker')})`);assert.equal(report.reopened.marker,'stable-private');assert.match(report.reopened.cookie,/mu_normal=private/);
  stage('Running browser and account-free native CLI together');
  const guestCli=`/tmp/mu-normal-claude-${randomUUID()}`;
  const cliFile=path.join(root,'test-results/client-environment-audit/packages/2.1.296/claude');assert.equal(await digest(cliFile),'f1f6e96e0d8342b9dbf41d7e88255397a6a52ce3d8736ad6a4c6b59c9b62fefa');await service.manager.runtime.command(['copy',cliFile,`${e.instanceName}:${guestCli}`],{timeoutMs:90000});await admin(['bash','-s'],`set -eu\nsudo chown -h dev:dev ${guestCli}\nsudo -H -u dev chmod 0700 ${guestCli}\nsudo -H -u dev mkdir -p /tmp/mu-normal-cli-home\n`);
  const cli=guest(['env','-i','HOME=/tmp/mu-normal-cli-home','PATH=/usr/bin:/bin','LANG=en_US.UTF-8',`TZ=${selectedTimezone}`,'ANTHROPIC_API_KEY=mu-lab-no-account','ANTHROPIC_BASE_URL=http://203.0.113.80','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1','DISABLE_TELEMETRY=1','DISABLE_ERROR_REPORTING=1',guestCli,'--model','claude-sonnet-4-5-20250929','--bare','-p','MU_LAB_CLAUDE_TEXT','--no-session-persistence','--tools','','--setting-sources','','--output-format','json'],60000);
  const browserWork=evaluate(`new Promise(resolve=>{let frames=0;const start=performance.now();function tick(){const c=document.getElementById('c').getContext('2d');c.fillStyle=frames%2?'#27a36f':'#d8eadb';c.fillRect(0,0,100,100);frames++;if(performance.now()-start<3000)requestAnimationFrame(tick);else resolve({frames,durationMs:performance.now()-start})}tick()})`);
  const [cliResult,browserResult]=await Promise.all([cli,browserWork]);assert.match(cliResult,/MU_REAL_CLAUDE_TEXT_OK/);report.simultaneous={cliResult:JSON.parse(cliResult),browserResult,fixtureMessages:lab.messages.length};assert.ok(lab.messages.length>0);report.metrics=await service.manager.runtime.metrics(current());
  report.oom=await admin(['bash','-c',"sudo journalctl -b --no-pager -k | grep -iE 'out of memory|oom-kill|killed process' || true"]);assert.equal(report.oom.trim(),'');report.hostCapacity={cpus:cpus().length,memoryGiB:totalmem()/2**30};
  stage('Rebooting only the disposable VM to verify persisted hostname');await finish(await service.manager.lifecycle(e.id,'restart'));report.hostnameAfter=await hostnameState();assert.equal(report.hostnameBefore.kernel,report.hostnameAfter.kernel);assert.equal(report.hostnameBefore.state.machineIdSha256,report.hostnameAfter.state.machineIdSha256);
  stage('Closing only the dedicated US test line; checking no fallback');await line.close();for(const socket of sockets)socket.destroy();
  await assert.rejects(guest(['curl','-q','--fail','--silent','--max-time','5','https://api.ipify.org'],8000));await assert.rejects(service.manager.assertAccess(e.id),/出口|访问|确认|环境/);report.proxyLossRejected=true;
  report.providerTraffic=decisions.filter(d=>d.route==='denied-provider');assert.deepEqual(report.providerTraffic,[]);report.fixtureTraffic=decisions.filter(d=>d.route==='local-fixture').length;
  assert.equal(await digest(globalConfig),originalConfig);report.globalProxyConfigUnchanged=true;report.productionUntouched=true;report.passed=true;
}catch(error){report.error=error instanceof Error?error.stack:String(error);if(service&&environmentId)report.logs=service.manager.store.logs(environmentId).slice(-12);process.exitCode=1;}
finally{
  await hostBrowser?.close();if(service&&environmentId){await service.manager.closeBrowser(environmentId).catch(()=>{});await Promise.allSettled([...service.manager.quarantines.values()]);try{await finish(await service.manager.lifecycle(environmentId,'stop'));}catch{/* Already quarantined/stopped; service.close remains mandatory. */}}await service?.close();await line.close();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>relay.close(()=>resolve()));fixtureRelay.closeAllConnections();await new Promise<void>(resolve=>fixtureRelay.close(()=>resolve()));await lab.close();
  report.routeDecisions=decisions;report.finishedAt=new Date().toISOString();report.globalProxyConfigUnchanged=await digest(globalConfig)===originalConfig;await writeFile(path.join(artifacts,'runtime.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({passed:report.passed,error:report.error,stages:report.stages.length,dataDir:owned}));
}
