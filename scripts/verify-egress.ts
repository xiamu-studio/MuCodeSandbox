import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createServer, request as httpRequest, type RequestListener } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect, createServer as createTcpServer, type Socket } from 'node:net';
import { parse, stringify } from 'yaml';
import { WebSocket } from 'ws';
import { pathToFileURL } from 'node:url';
import { createService as sourceCreateService } from '../server/service.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256, SING_BOX_VERSION } from '../server/transparent-network.ts';
import { buildLimaConfig } from '../server/lima-config.ts';
import { environmentSchema } from '../server/validation.ts';
import { shellQuote } from '../server/network-guard.ts';
import { EGRESS_URL } from '../server/egress.ts';
import { run } from '../server/process.ts';
import type { Environment, Job, NetworkConfig } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname,'..');
const bridgeOwner = process.argv.includes('--bridge-owner');
const protocol: 'http'|'https'|'socks5' = process.argv.includes('--https') ? 'https' : process.argv.includes('--socks') ? 'socks5' : 'http';
assert.ok(!(process.argv.includes('--https') && process.argv.includes('--socks')));
assert.ok(protocol === 'http' || bridgeOwner, 'Protocol combinations require the current frozen bridge-owner package');
const packagedProbe = process.argv.includes('--probe') || bridgeOwner;
const transport = process.argv.includes('--transport') || packagedProbe;
const sourceProbe = process.argv.includes('--source-probe');
assert.ok(!sourceProbe || !transport);
const reportName = bridgeOwner ? `egress-bridge-owner-${protocol}` : sourceProbe ? 'egress-probe-source' : packagedProbe ? 'egress-probe-packaged' : transport ? 'egress-transport' : 'egress-constraint';
const bundle = path.join(root, `release/${bridgeOwner ? 'bridge-owner-candidate' : packagedProbe ? 'proxy-probe-candidate' : 'proxy-transport-guard-candidate'}/mac-arm64/MuCodeSandbox.app`);
const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
const createService: typeof sourceCreateService = transport ? (await import(pathToFileURL(path.join(compiled, 'service.js')).href)).createService : sourceCreateService;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
assert.ok(!transport || !process.env.MU_EGRESS_TEST_DATA, 'Frozen package regression requires a fresh test-owned VM');
const temporary = process.env.MU_EGRESS_TEST_DATA ? path.resolve(process.env.MU_EGRESS_TEST_DATA) : await mkdtemp(path.join(homedir(),'.mu-egress-verification-'));
assert.ok(path.basename(temporary).startsWith('.mu-egress-verification-'),'Use only this verifier\'s disposable directory');
await mkdir(temporary,{recursive:true,mode:0o700});
const project = await mkdtemp(path.join(homedir(),'.mu-egress-project-'));
const results = path.join(root,'test-results', ...(transport || sourceProbe ? [`${reportName}-${Date.now()}`] : [])); await mkdir(results,{recursive:true,mode:0o700});
process.env.MU_LIMA_PATH ??= path.join(homedir(),'.mucodesandbox/tools/lima/bin/limactl');
const report: Record<string,any> = { passed:false, accountFree:true, paidModelCalls:0, startedAt:new Date().toISOString(),
  scope:'Real VM TUN, TLS measurement and quarantine; receipt IPs are synthetic, not actual public or residential exits',
  testOnlyOverride:'Pinned ipwho.is name resolves to a controlled TLS fixture, using a root-owned fixture CA; no production endpoint override',upstreamProtocol:protocol,proxyTransportPackageTested:transport,artifactsDirectory:results,captures:[],captureFailures:[] };
if (transport) {
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  report.packageCdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1];
  assert.equal(report.packageCdHash, bridgeOwner ? '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3' : packagedProbe ? '93781410161fcf4560c244ce5469b980ffc38976' : '7395e50362e01c36299c4eacabe0cbedb636cf22'); report.bundle = bundle;
  report.modules = Object.fromEntries(await Promise.all((await readdir(compiled)).filter(file => file.endsWith('.js')).map(async file => [file, hash(await readFile(path.join(compiled, file)))])));
  const cache = process.env.MU_TEST_SING_BOX_CACHE; assert.ok(cache); assert.equal(hash(await readFile(cache)), SING_BOX_SHA256);
  await mkdir(path.join(temporary, 'tools/sing-box'), { recursive: true }); await copyFile(cache, path.join(temporary, 'tools/sing-box', SING_BOX_ARCHIVE));
}
if (sourceProbe) {
  const cache = process.env.MU_TEST_SING_BOX_CACHE; assert.ok(cache); assert.equal(hash(await readFile(cache)), SING_BOX_SHA256);
  await mkdir(path.join(temporary, 'tools/sing-box'), { recursive: true }); await copyFile(cache, path.join(temporary, 'tools/sing-box', SING_BOX_ARCHIVE));
  report.sourceProbeFixTested = true;
}
const sockets = new Set<Socket>();
const track = (socket:Socket) => { sockets.add(socket);socket.on('close',()=>sockets.delete(socket)); };
let advertisedIp = '9.9.9.9', responseMode:'ok'|'malformed'|'offline'|'wrong-name' = 'ok', receipts = 0, businessHits = 0;
const destinations:string[]=[];
await run('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=Mu Egress Fixture CA',
  '-addext','basicConstraints=critical,CA:TRUE','-keyout',path.join(temporary,'ca.key'),'-out',path.join(temporary,'ca.pem')]);
async function certificate(name:string,prefix:string) {
  await run('/usr/bin/openssl',['req','-new','-newkey','rsa:2048','-nodes','-subj',`/CN=${name}`,'-keyout',path.join(temporary,`${prefix}.key`),'-out',path.join(temporary,`${prefix}.csr`)]);
  await writeFile(path.join(temporary,`${prefix}.ext`),`subjectAltName=DNS:${name}\nextendedKeyUsage=serverAuth\n`);
  await run('/usr/bin/openssl',['x509','-req','-days','1','-in',path.join(temporary,`${prefix}.csr`),'-CA',path.join(temporary,'ca.pem'),'-CAkey',path.join(temporary,'ca.key'),'-CAcreateserial',
    '-extfile',path.join(temporary,`${prefix}.ext`),'-out',path.join(temporary,`${prefix}.pem`)]);
  return { key:await readFile(path.join(temporary,`${prefix}.key`)),cert:await readFile(path.join(temporary,`${prefix}.pem`)) };
}
const identity = await certificate('ipwho.is','server');
const wrongIdentity = await certificate('wrong.fixture.test','wrong');
const proxyIdentity = protocol === 'https' ? await certificate('mu-egress-proxy.test','proxy') : undefined;
const proxyCa = (await readFile(path.join(temporary,'ca.pem'),'utf8')).trim();
const measurement = createTlsServer(identity,(_request,response)=>{
  receipts++;
  if(responseMode==='offline'){response.destroy();return;}
  response.setHeader('Content-Type','application/json');
  response.end(responseMode==='malformed' ? '{"ip":"not-an-ip"}' : JSON.stringify({success:true,ip:advertisedIp,country:'MU_EGRESS_SYNTHETIC_RECEIPT',city:'Fixture'}));
});
const wrongMeasurement = createTlsServer(wrongIdentity,(_request,response)=>response.end(JSON.stringify({ip:advertisedIp})));
const business = createServer((_request,response)=>{businessHits++;destinations.push('203.0.113.51:80');response.end('MU_EGRESS_BUSINESS_OK');});
for(const server of [measurement,wrongMeasurement,business]) { server.on('connection',track); await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve)); }
const measurementPort=(measurement.address() as {port:number}).port;
const wrongPort=(wrongMeasurement.address() as {port:number}).port;
const businessPort=(business.address() as {port:number}).port;
const authorization=`Basic ${Buffer.from('mu:exit-fixture').toString('base64')}`;
const handler: RequestListener = (request,response)=>{
  if(request.headers['proxy-authorization']!==authorization){response.writeHead(407);response.end();return;}
  const target=new URL(request.url!);
  const headers={...request.headers};delete headers['proxy-authorization'];
  const remote=httpRequest(target,{method:request.method,headers},incoming=>{response.writeHead(incoming.statusCode!,incoming.headers);incoming.pipe(response);});
  remote.on('error',()=>{response.writeHead(502);response.end();});request.pipe(remote);
};
const proxy=proxyIdentity ? createTlsServer({...proxyIdentity,minVersion:'TLSv1.2'},handler) : createServer(handler);
const proxyTlsProtocols:string[]=[];
if (proxyIdentity) {
  (proxy as ReturnType<typeof createTlsServer>).on('secureConnection',socket=>proxyTlsProtocols.push(socket.getProtocol()??'unknown'));
  proxy.on('tlsClientError',()=>{});
}
proxy.on('connection',track);
proxy.on('connect',(request,client,head)=>{
  if(request.headers['proxy-authorization']!==authorization){client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');return;}
  const target=new URL(`https://${request.url}`);destinations.push(request.url!);
  const fixture=target.hostname==='203.0.113.50', task=target.hostname==='203.0.113.51';
  const remote=connect(fixture ? responseMode==='wrong-name' ? wrongPort : measurementPort : task ? businessPort : Number(target.port)||443,
    fixture||task?'127.0.0.1':target.hostname,()=>{
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);client.pipe(remote);remote.pipe(client);
    });
  track(remote);remote.on('error',()=>client.destroy());client.on('error',()=>remote.destroy());client.on('close',()=>remote.destroy());
});
await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
let proxyPort=(proxy.address() as {port:number}).port;
const service=await createService({rootDir:root,dataDir:temporary,port:0});
const {manager}=service;
let socksGateway:Environment|undefined;
const measurementGate = createTcpServer(client=>{
  track(client);destinations.push('203.0.113.50:443');
  const remote=connect(responseMode==='wrong-name'?wrongPort:measurementPort,'127.0.0.1',()=>{client.pipe(remote);remote.pipe(client);});
  track(remote);remote.on('error',()=>client.destroy());client.on('error',()=>remote.destroy());client.on('close',()=>remote.destroy());
});
async function prepareSocksServer() {
  await new Promise<void>(resolve=>measurementGate.listen(0,'127.0.0.1',resolve));
  const gatePort=(measurementGate.address() as {port:number}).port;
  const reservation=createTcpServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  proxyPort=(reservation.address() as {port:number}).port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const id=randomUUID(),now=new Date().toISOString();
  socksGateway={...environmentSchema.parse({name:'Disposable exit SOCKS server',cpus:1,memoryGiB:1,diskGiB:10}),id,instanceName:`mu-${id.replaceAll('-','').slice(0,16)}`,state:'running',browserRunning:false,lastError:null,createdAt:now,updatedAt:now};
  const configuration=parse(buildLimaConfig(socksGateway));
  configuration.portForwards.unshift({guestPort:1080,hostPort:proxyPort,hostIP:'127.0.0.1',guestIP:'127.0.0.1',guestIPMustBeZero:false,proto:'tcp'});
  const configFile=path.join(temporary,'socks-gateway.yaml');await writeFile(configFile,stringify(configuration),{mode:0o600});
  console.log('Preparing independent sing-box SOCKS5 server with synthetic credentials');
  await manager.runtime.command(['start','--name',socksGateway.instanceName,'--timeout','15m',configFile],{timeoutMs:950_000});
  const archive=path.join(temporary,'tools/sing-box',SING_BOX_ARCHIVE);
  await manager.runtime.command(['copy',archive,`${socksGateway.instanceName}:/tmp/mu-egress-socks.tar.gz`],{timeoutMs:60_000});
  const config={log:{disabled:true},inbounds:[{type:'socks',listen:'127.0.0.1',listen_port:1080,users:[{username:'mu',password:'exit-fixture'}]}],outbounds:[{type:'direct',tag:'direct'}],
    route:{rules:[{ip_cidr:['203.0.113.50/32'],action:'route',outbound:'direct',override_address:'192.168.5.2',override_port:gatePort},{ip_cidr:['203.0.113.51/32'],action:'route',outbound:'direct',override_address:'192.168.5.2',override_port:businessPort}],final:'direct'}};
  await manager.runtime.management(socksGateway,['bash','-s'],{input:`set -eu
sudo install -d -m 0700 /run/mu-egress-socks
sudo tar -xzf /tmp/mu-egress-socks.tar.gz -C /run/mu-egress-socks --strip-components=1
sudo rm -f /tmp/mu-egress-socks.tar.gz
printf '%s' ${shellQuote(JSON.stringify(config))} | sudo tee /run/mu-egress-socks/config.json >/dev/null
sudo /run/mu-egress-socks/sing-box check -c /run/mu-egress-socks/config.json
sudo systemd-run --quiet --unit=mu-egress-socks /run/mu-egress-socks/sing-box run -c /run/mu-egress-socks/config.json
`,timeoutMs:30_000});
  report.socksServer={actualSeparateVm:true,engine:`sing-box ${SING_BOX_VERSION}`,authenticated:true,configuration:config};
  const url=new URL(`socks5://127.0.0.1:${proxyPort}`);url.username='mu';url.password='exit-fixture';
  const args=['--fail','--silent','--max-time','5','--proxy',url.href,'http://203.0.113.51/host-positive'];
  const before=businessHits;
  for(let n=0;;n++){try{assert.equal((await run('/usr/bin/curl',args)).trim(),'MU_EGRESS_BUSINESS_OK');break;}catch(error){if(n>=40)throw error;await new Promise(resolve=>setTimeout(resolve,250));}}
  const wrong=new URL(url);wrong.password='synthetic-wrong-password';await assert.rejects(run('/usr/bin/curl',[...args.slice(0,5),wrong.href,args.at(-1)!]));
  assert.equal(businessHits,before+1);report.hostSocksAuthenticationControl=true;
}
const baseNetwork:NetworkConfig={mode:protocol,host:'127.0.0.1',port:proxyPort,username:'mu',password:'exit-fixture',noProxy:'',strict:true,transparent:true,egressLock:{expectedIp:'8.8.8.8'},
  ...(protocol==='https'?{tls:{serverName:'mu-egress-proxy.test',certificate:proxyCa}}:{})};
const management=manager.runtime.management.bind(manager.runtime);
const start=manager.runtime.start.bind(manager.runtime), stop=manager.runtime.stop.bind(manager.runtime);
let capture=0, environmentId='', terminal:WebSocket|undefined;
const captureOpen=new Set<string>();
if (packagedProbe) {
  const transports = manager.runtime.proxyTransports as any, original = transports.runner;
  transports.runner = async (file:string,args:string[],options:any) => {
    if(args.includes('-O') && args.includes('forward')) {
      const e = manager.store.get(environmentId), relayPort = Number(args[args.indexOf('-R')+1].split(':')[1]);
      const uid = Number((await management(e,['id','-u','mu-probe'])).trim());
      const table = JSON.parse(await management(e,['sudo','nft','-j','list','chain','inet','mu_egress','output']));
      const rules = table.nftables.filter((row:any)=>row.rule).map((row:any)=>row.rule.expr);
      const loopback = rules.findIndex((expr:any[])=>expr.some(row=>'accept' in row) && expr.some(row=>row.match?.left?.meta?.key==='oifname' && row.match.right==='lo'));
      const probeRule = rules.findIndex((expr:any[])=>expr.some(row=>'drop' in row) && expr.some(row=>row.match?.left?.meta?.key==='skuid' && row.match.op==='!=' && row.match.right===uid));
      assert.ok(probeRule>=0 && probeRule<loopback);
      const probePort = rules[probeRule].find((row:any)=>row.match?.left?.payload?.protocol==='tcp' && row.match.left.payload.field==='dport')?.match.right;
      assert.ok(Number.isInteger(probePort) && probePort!==relayPort);
      for (const port of [relayPort,probePort]) assert.equal((await management(e,['ss','-H','-lnt',`sport = :${port}`])).trim(),'');
      (report.privateProbeGuardBeforeListeners ??= []).push({at:new Date().toISOString(),probePort,relayPort,uid,kernelVerified:true,listenersAbsent:true});
    }
    return original(file,args,options);
  };
}
manager.runtime.management=async(e,command,options)=>{
  if(command.at(-1)===EGRESS_URL){
    if (sourceProbe || packagedProbe) {
      const protection = await manager.runtime.networkProtection({...e,state:'running'},false);
      (report.probeObservations ??= []).push({ at:new Date().toISOString(),leaseActive:protection.leaseActive,proxy:command[command.indexOf('--proxy')+1] });
    }
    assert.deepEqual(command.slice(0,11),['/usr/bin/sudo','-H','-u','mu-probe','--','env','-i','PATH=/usr/bin:/bin','/usr/bin/curl','-q','--ipv4']);
    const adjusted=[...command];adjusted[adjusted.indexOf('--cacert')+1]='/etc/mucodesandbox/egress-fixture-ca.pem';
    adjusted.splice(adjusted.length-1,0,'--resolve','ipwho.is:443:203.0.113.50');
    return management(e,adjusted,options);
  }
  return management(e,command,options);
};
manager.runtime.start=async(e,options)=>{
  await start(e,options);
  if (packagedProbe) {
    const configuration = JSON.parse(await management(e,['sudo','cat','/etc/mucodesandbox/tunnel.json']));
    const listener = configuration.inbounds.find((row:any)=>row.tag==='exit-probe');
    assert.deepEqual(listener,{type:'socks',tag:'exit-probe',listen:'127.0.0.1',listen_port:report.privateProbeGuardBeforeListeners.at(-1).probePort});
    assert.deepEqual(configuration.route.rules[0],{inbound:['exit-probe'],network:'udp',action:'reject'});
    assert.equal(configuration.outbounds.length,1); assert.equal(configuration.outbounds[0].server,'127.0.0.1');
    assert.equal(configuration.outbounds[0].type,protocol==='socks5'?'socks':'http');
    if(protocol==='https'){assert.equal(configuration.outbounds[0].tls.enabled,true);assert.equal(configuration.outbounds[0].tls.server_name,e.network.tls!.serverName);}
    (report.probeConfigurations ??= []).push({at:new Date().toISOString(),listener,udpRejectedBeforeDns:true,oneApprovedUpstream:true,upstreamType:configuration.outbounds[0].type,tls:configuration.outbounds[0].tls?.enabled??false});
  }
  await manager.runtime.command(['copy',path.join(temporary,'ca.pem'),`${e.instanceName}:/tmp/mu-egress-fixture-ca.pem`],{timeoutMs:30_000});
  await management(e,['bash','-s'],{input:`set -eu
sudo install -m 0644 -o root -g root /tmp/mu-egress-fixture-ca.pem /etc/mucodesandbox/egress-fixture-ca.pem
sudo rm -f /tmp/mu-egress-fixture-ca.pem
sudo rm -f /tmp/mu-egress-verification.pcap
sudo systemctl reset-failed mu-egress-verification-capture.service 2>/dev/null || true
sudo systemd-run --quiet --unit=mu-egress-verification-capture --property=Type=exec /usr/bin/tcpdump --immediate-mode -U -i any -s 0 -w /tmp/mu-egress-verification.pcap
for attempt in $(seq 1 100); do
  if [ "$(sudo stat -c %s /tmp/mu-egress-verification.pcap 2>/dev/null || echo 0)" -ge 24 ]; then break; fi
  sleep 0.05
done
test "$(sudo stat -c %s /tmp/mu-egress-verification.pcap)" -ge 24
`,timeoutMs:20_000});
  captureOpen.add(e.id);
};
manager.runtime.stop=async(e,options)=>{
  try {
  if(captureOpen.delete(e.id)){
    await management(e,['sudo','systemctl','stop','mu-egress-verification-capture.service'],{timeoutMs:15_000});
    const output=await management(e,['sudo','tcpdump','-nn','-r','/tmp/mu-egress-verification.pcap'],{timeoutMs:15_000});
    const routes=JSON.parse((await management(e,['ip','-j','-4','route','show','default'])).split('\n').find(line=>line.startsWith('['))!) as {gateway:string;dev:string}[];
    const {gateway,dev}=routes.find(route=>route.gateway)!;
    const name=`egress-${++capture}.pcap`;
    await manager.runtime.command(['copy',`${e.instanceName}:/tmp/mu-egress-verification.pcap`,path.join(results,name)],{timeoutMs:20_000});
    await writeFile(path.join(results,`egress-${capture}-decoded.txt`),output);
    const physical=output.split('\n').filter(line=>{
      const packet=line.match(/^\S+\s+(\S+)\s+(In|Out)\s+(IP6?)\s/);
      return packet?.[1]===dev&&packet[2]==='Out';
    });
    assert.ok(physical.length>0,'A physical positive control is required');
    const unexpected=physical.filter(line=>/ IP6 /.test(line)||!(/\.22 > /.test(line)||(!transport&&line.includes(` > ${gateway}.${proxyPort}:`))||/\.68 > [0-9.]+\.67:/.test(line)));
    assert.deepEqual(unexpected,[],'Physical output must use approved proxy, management replies or DHCP');
    assert.equal((await readFile(path.join(results,name))).includes(Buffer.from('MU_EGRESS_SYNTHETIC_RECEIPT')),false);
    report.captures.push({name,physicalInterface:dev,physicalOutPackets:physical.length,onlyApprovedEgress:true,scope:'Startup measurement through detection; capture stops just before VM stop'});
  }
  } catch(error) { report.captureFailures.push(error instanceof Error?error.message:String(error));throw error; }
  finally { await stop(e,options); }
};
async function job(job:Job,expected='succeeded') {
  await manager.tasks.get(job.id)?.promise;
  const done=manager.store.jobs().find(item=>item.id===job.id)!;
  assert.equal(done.status,expected,done.message);return done;
}
async function request(endpoint:string,body?:unknown) {
  const response=await fetch(`${service.url}/api/environments/${environmentId}${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:JSON.stringify(body??{})});
  return {status:response.status,body:await response.json() as any};
}
async function until(check:()=>boolean,limit=40_000) {
  const deadline=Date.now()+limit;
  while(!check()){assert.ok(Date.now()<deadline,'Egress verification timed out');await new Promise(resolve=>setTimeout(resolve,100));}
}
async function stopped() {
  await until(()=>manager.store.get(environmentId).state==='error');
  await Promise.all([...manager.quarantines.values()]);
  const e=manager.store.get(environmentId);
  assert.equal((await manager.runtime.list()).find(instance=>instance.name===e.instanceName)?.status,'Stopped');
  assert.equal(report.captureFailures.length,0,JSON.stringify(report.captureFailures));
  assert.equal(e.network.egressLock!.expectedIp,'8.8.8.8');
}
const current=()=>manager.store.get(environmentId);
const updateNetwork=(network:NetworkConfig)=>{
  const e=current();return manager.update(environmentId,{name:e.name,cpus:e.cpus,memoryGiB:e.memoryGiB,diskGiB:e.diskGiB,identity:e.identity,mounts:e.mounts,ports:e.ports,browserUrl:e.browserUrl,network});
};
try {
  if(protocol==='socks5'){await prepareSocksServer();baseNetwork.port=proxyPort;}
  const environment=await manager.create({name:'Controlled exit approval',cpus:2,memoryGiB:2,diskGiB:10,identity:{timezone:'UTC',locale:'en-US'},
    network:baseNetwork});
  environmentId=environment.id;
  console.log('Verifying startup rejection through a real VM and verified TLS receipt.');
  await job(await manager.lifecycle(environmentId,'start'),'failed');
  await stopped();assert.equal(manager.egressStatus(environmentId).status,'changed');
  assert.equal((await request('/terminal-ticket')).status,409);
  assert.equal((await request('/browser/open')).status,409);
  report.startupMismatchRejectedBeforeManagedAccess=true;

  advertisedIp='8.8.8.8'; await job(await manager.lifecycle(environmentId,'start'));
  const protection=await manager.runtime.networkProtection(current());assert.ok(protection.active&&protection.routingReady);
  const beforeHits=businessHits;
  const guest=(command:string[])=>manager.runtime.guest(current(),command,{timeoutMs:25_000});
  assert.equal((await guest(['/usr/bin/curl','-q','--fail','--silent','--max-time','5','--proxy','','--noproxy','*','http://203.0.113.51/'])).trim(),'MU_EGRESS_BUSINESS_OK');
  assert.equal(businessHits,beforeHits+1);
  if (sourceProbe || packagedProbe) {
    const proxy = manager.runtime.egressProbeProxy(current()); assert.match(proxy, /^socks5:\/\/127\.0\.0\.1:\d+$/);
    const hits = businessHits;
    await assert.rejects(guest(['/usr/bin/curl','-q','--fail','--silent','--max-time','3','--proxy',proxy,'--noproxy','','http://203.0.113.51/']));
    assert.equal(businessHits,hits); report.developerCannotUseProbeListener = true;
    assert.ok(report.probeObservations.some((row:any) => !row.leaseActive && row.proxy === proxy));
    report.probeWorksBeforeBusinessLease = true;
  }
  await guest(['bash','-c','printf egress-data-retained > /home/dev/egress-marker']);
  await assert.rejects(guest(['/usr/bin/curl','-q','--max-time','2','--interface','eth0','--proxy','','http://203.0.113.51/']));
  report.approvedExitHasRealBusinessPositiveControlAndDirectBypassDenied=true;
  await writeFile(path.join(project,'allowed.txt'),'MU_EGRESS_BRIDGE_ALLOWED');
  const grant=await service.bridge.create(current(),project,false,5,true);
  assert.equal((await guest(['mu-host',grant.id,'read','allowed.txt'])).trim(),'MU_EGRESS_BRIDGE_ALLOWED');
  report.authorizedGuestBridgeBeforeDrift=true;
  const issued=await request('/terminal-ticket',{command:'shell',cols:100,rows:25});assert.equal(issued.status,200);
  terminal=new WebSocket(`${service.url.replace('http:','ws:')}/terminal?ticket=${issued.body.ticket}`,{origin:service.url});
  let output='', terminalClosed=false;
  terminal.on('error',()=>{});terminal.on('close',()=>{terminalClosed=true;});
  terminal.on('message',data=>{const message=JSON.parse(data.toString());if(message.type==='connected')terminal!.send(JSON.stringify({type:'input',data:'echo MU_EGRESS_TERMINAL_READY\r'}));if(message.type==='data')output+=message.data;});
  await until(()=>output.includes('MU_EGRESS_TERMINAL_READY'));
  const staleTicket=await request('/terminal-ticket',{command:'shell'});assert.equal(staleTicket.status,200);
  console.log('Changing the synthetic exit during a real running install task; waiting for the background monitor.');
  const busy=manager.submit(environmentId,'install-agent',options=>manager.runtime.guest(current(),['bash','-c','echo MU_EGRESS_BUSY; sleep 90'],{...options,timeoutMs:100_000}).then(()=>{}));
  await until(()=>manager.store.logs(environmentId).some(log=>log.message.includes('MU_EGRESS_BUSY')));
  const changedAt=Date.now();advertisedIp='9.9.9.9';
  await stopped();await until(()=>terminalClosed);
  assert.equal(manager.store.jobs().find(item=>item.id===busy.id)?.status,'cancelled');
  assert.equal(service.bridge.list(environmentId).length,0);assert.equal(service.terminal.tickets.has(staleTicket.body.ticket),false);
  report.backgroundDriftWhileBusy={detectedAndStoppedMs:Date.now()-changedAt,terminalClosed,bridgeRevoked:true,unusedTicketRevoked:true,installCancelled:true,status:manager.egressStatus(environmentId)};
  assert.equal(manager.egressStatus(environmentId).status,'changed');

  console.log('Checking each bridge call against a malformed measurement, then testing TLS-name failure and service loss.');
  advertisedIp='8.8.8.8';await job(await manager.lifecycle(environmentId,'start'));
  assert.equal((await guest(['cat','/home/dev/egress-marker'])).trim(),'egress-data-retained');
  const nextGrant=await service.bridge.create(current(),project,false,5,true);
  responseMode='malformed';await assert.rejects(service.bridge.perform(nextGrant.id,{operation:'read',path:'allowed.txt'}));
  await stopped();assert.equal(manager.egressStatus(environmentId).status,'unavailable');
  report.malformedReceiptBlocksActualBridgeRead=true;

  responseMode='ok';await job(await manager.lifecycle(environmentId,'start'));
  responseMode='wrong-name';const rejected=await request('/terminal-ticket',{command:'shell'});
  assert.equal(rejected.status,409);assert.equal(rejected.body.code,'EGRESS_FAILED');
  await stopped();report.wrongTlsNameCannotIssueTerminal=true;

  responseMode='ok';await job(await manager.lifecycle(environmentId,'start'));
  responseMode='offline';await stopped();
  assert.equal(manager.egressStatus(environmentId).status,'unavailable');report.measurementServiceLossQuarantines=true;
  assert.equal(await readFile(path.join(project,'allowed.txt'),'utf8'),'MU_EGRESS_BRIDGE_ALLOWED');
  report.userDataPreserved=true;report.actualLinuxVmVerified=true;report.measurementReceipts=receipts;
  if (bridgeOwner) {
    console.log(`Checking ${protocol} upstream faults before business permission opens`);
    responseMode='ok';
    const variants:{name:string;network:NetworkConfig}[]=[{name:'wrong-password',network:{...baseNetwork,password:'synthetic-wrong-password'}},{name:'wrong-user',network:{...baseNetwork,username:'synthetic-wrong-user'}}];
    if(protocol==='https')variants.push({name:'wrong-proxy-name',network:{...baseNetwork,tls:{...baseNetwork.tls!,serverName:'wrong-proxy.invalid'}}},{name:'untrusted-proxy-ca',network:{...baseNetwork,tls:{serverName:baseNetwork.tls!.serverName}}});
    report.upstreamFailures=[];
    for(const variant of variants){
      await updateNetwork(variant.network);
      const before={receipts,businessHits};await job(await manager.lifecycle(environmentId,'start'),'failed');await stopped();
      assert.equal(manager.egressStatus(environmentId).status,'unavailable');assert.equal(receipts,before.receipts);assert.equal(businessHits,before.businessHits);
      report.upstreamFailures.push({name:variant.name,businessPermissionNeverOpened:true,receiptUnchanged:true,businessUnchanged:true,status:manager.egressStatus(environmentId).status});
    }
    await updateNetwork(baseNetwork);await job(await manager.lifecycle(environmentId,'start'));
    assert.equal((await guest(['/usr/bin/curl','-q','--fail','--silent','--max-time','5','http://203.0.113.51/recovery'])).trim(),'MU_EGRESS_BUSINESS_OK');
    assert.equal((await guest(['cat','/home/dev/egress-marker'])).trim(),'egress-data-retained');
    await job(await manager.lifecycle(environmentId,'stop'));report.upstreamRecoveryAndDataPreservation=true;
  }
  report.measurementReceipts=receipts;report.proxyDestinations=destinations;report.proxyTlsProtocols=proxyTlsProtocols;
  if(protocol==='https')assert.ok(proxyTlsProtocols.length>0&&proxyTlsProtocols.every(value=>['TLSv1.2','TLSv1.3'].includes(value)));
  assert.equal(report.captures.length,bridgeOwner?protocol==='https'?10:8:5);assert.equal(report.captureFailures.length,0);report.passed=true;
} catch(error) {
  report.error=error instanceof Error?error.stack:String(error);
  if(environmentId)report.logs=manager.store.logs(environmentId).slice(-40);
  process.exitCode=1;
} finally {
  terminal?.close();
  await service.close();
  // The verifier owns this entire private Lima home, including its trusted base.
  for(const instance of await manager.runtime.list().catch(()=>[])) {
    await manager.runtime.command(['stop','--force',instance.name],{timeoutMs:120_000}).catch(error=>{report.cleanupError=String(error);});
    if(report.passed)await manager.runtime.command(['delete','--force',instance.name],{timeoutMs:120_000}).catch(error=>{report.cleanupError=String(error);});
  }
  for(const socket of sockets)socket.destroy();
  for(const server of [proxy,measurement,wrongMeasurement,business,...(measurementGate.listening?[measurementGate]:[])])await new Promise<void>(resolve=>server.close(()=>resolve()));
  if(report.cleanupError||!report.passed)report.retainedDataDir=temporary;else { await rm(temporary,{recursive:true,force:true}); report.testResourcesRemoved=true; }
  if(report.cleanupError){report.passed=false;process.exitCode=1;}
  await rm(project,{recursive:true,force:true});report.finishedAt=new Date().toISOString();
  if (transport || sourceProbe) {
    if (transport) for (const [file,expected] of Object.entries(report.modules)) assert.equal(hash(await readFile(path.join(compiled,file))),expected);
    const sourceFiles=['scripts/verify-egress.ts',...(protocol==='socks5'?['server/lima-config.ts']:[])];
    report.sources=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,hash(await readFile(path.join(root,file)))])));
    for(const file of sourceFiles)await copyFile(path.join(root,file),path.join(results,`source-${path.basename(file)}`));
    report.artifacts = Object.fromEntries(await Promise.all((await readdir(results)).map(async file => [file, hash(await readFile(path.join(results, file)))])));
    await writeFile(path.join(results, 'report.json'), JSON.stringify(report,null,2), {mode:0o600});
  }
  await writeFile(path.join(root, 'test-results', `${reportName}.json`),JSON.stringify(report,null,2), {mode:0o600});
  console.log(JSON.stringify({passed:report.passed,error:report.error,captures:report.captures.length,cleanupError:report.cleanupError},null,2));
}
