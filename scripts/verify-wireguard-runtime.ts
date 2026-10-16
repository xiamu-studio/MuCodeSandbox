import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { copyFile, mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { createService as sourceCreateService } from '../server/service.ts';
import { createWireguardWorkloads } from './wireguard-workloads.ts';
import { verifyPackagedWireguard } from './wireguard-packaged-workloads.ts';
import { verifyWireguardFaults } from './wireguard-faults.ts';
import { buildLimaConfig as sourceBuildLimaConfig } from '../server/lima-config.ts';
import { environmentSchema, redact } from '../server/validation.ts';
import { shellQuote } from '../server/network-guard.ts';
import { WIREGUARD_MARK } from '../server/wireguard.ts';
import type { Environment, Job } from '../shared/types.ts';
import { run } from '../server/process.ts';
import { GUEST_CHROMIUM_VERSION } from '../server/guest-browser-runtime.ts';
import { pathToFileURL } from 'node:url';
import { packetLines } from './packet-capture.ts';
import { seedProtectedTestBase } from './seed-protected-test-base.ts';

const root = path.resolve(import.meta.dirname,'..');
const withWorkloads = process.argv.includes('--workloads');
const withPackage = process.argv.includes('--packaged');
const withFaults = process.argv.includes('--faults');
const bridgeOwner = process.argv.includes('--bridge-owner');
assert.ok(!withPackage || withWorkloads, 'Packaged verification requires the local workloads');
assert.ok(!withFaults || (!withWorkloads && !withPackage), 'Keep fault evidence separate from workload evidence');
assert.ok(!bridgeOwner || withFaults, 'Current frozen-module mode is only for fault acceptance');
const bundle = path.join(root, 'release/bridge-owner-candidate/mac-arm64/MuCodeSandbox.app');
const appRoot = path.join(bundle, 'Contents/Resources/app');
const compiled = path.join(appRoot, 'dist-server/server');
const createService: typeof sourceCreateService = bridgeOwner
  ? (await import(pathToFileURL(path.join(compiled, 'service.js')).href)).createService : sourceCreateService;
const buildLimaConfig: typeof sourceBuildLimaConfig = bridgeOwner
  ? (await import(pathToFileURL(path.join(compiled, 'lima-config.js')).href)).buildLimaConfig : sourceBuildLimaConfig;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['scripts/verify-wireguard-runtime.ts', 'scripts/wireguard-faults.ts', 'scripts/packet-capture.ts', 'scripts/seed-protected-test-base.ts'];
let serviceClosed = false;
const temporary = await mkdtemp(path.join(homedir(),'.mu-wireguard-runtime-'));
const artifactName = bridgeOwner ? 'wireguard-faults-bridge-owner' : withFaults ? 'wireguard-faults' : withWorkloads ? 'wireguard-workloads' : 'wireguard-runtime';
const artifacts = path.join(root,'test-results',bridgeOwner ? `${artifactName}-${Date.now()}` : artifactName);
await mkdir(artifacts,{recursive:true,mode:0o700});
process.env.MU_LIMA_PATH ??= path.join(homedir(),'.mucodesandbox/tools/lima/bin/limactl');
let lastInspection = '';
const service = await createService({ rootDir:root, dataDir:temporary, port:0 });
const manager = service.manager;
manager.runtime.runner = async (file,args,options)=>{
  if (bridgeOwner && process.env.MU_TEST_PROTECTED_BASE) {
    assert.notEqual(file, '/usr/bin/curl', 'Cached-base acceptance must not download components');
  }
  const output = await run(file,args,options);
  if (options?.input?.includes("result.update({'wireguardStateHash'") && output.includes('"wireguardRoutingRules"') && !output.includes('"proxyEndpoints": []')) lastInspection = output;
  return output;
};
const runtime = manager.runtime;
const report: Record<string,unknown> = { passed:false,accountFree:true,paidModelCalls:0,startedAt:new Date().toISOString(),realPublicLineVerified:false,uiValidatedInThisRun:false,withWorkloads };
if (bridgeOwner) Object.assign(report, { bundle, artifactsDirectory: artifacts,
  scope: 'Frozen current-package modules under Node in two disposable real VMs; four selected WireGuard faults, first client boot and per-fault physical captures. No Electron UI, browser/CLI, every reboot capture, Mac sleep/switch, public residential line, physical power loss or day-long claim' });
function keys() {
  const pair = generateKeyPairSync('x25519');
  return { privateKey:pair.privateKey.export({format:'der',type:'pkcs8'}).subarray(-32).toString('base64'), publicKey:pair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64') };
}
const clientKey = keys(), gatewayKey = keys();
const udp = createSocket('udp4');
await new Promise<void>(resolve=>udp.bind(0,'127.0.0.1',resolve));
const port = udp.address().port;
await new Promise<void>(resolve=>udp.close(()=>resolve()));
const now = new Date().toISOString(), gatewayId = randomUUID();
const gateway: Environment = { ...environmentSchema.parse({name:'Disposable packet gateway',memoryGiB:bridgeOwner?1:2,diskGiB:10}),id:gatewayId,instanceName:`mu-${gatewayId.replaceAll('-','').slice(0,16)}`,state:'running',browserRunning:false,lastError:null,createdAt:now,updatedAt:now };
const client = await manager.create({name:'整包隧道双虚拟机验证',memoryGiB:2,diskGiB:10,identity:{timezone:'Asia/Tokyo',locale:'ja-JP'},browserUrl:'http://203.0.113.10/probe',network:{mode:'wireguard',host:'192.168.5.2',port,strict:true,transparent:true,wireguard:{address:'10.77.0.2/32',privateKey:clientKey.privateKey,peerPublicKey:gatewayKey.publicKey}}});
const workloads = withWorkloads ? await createWireguardWorkloads(service,gateway,client.id,artifacts) : undefined;
const current = () => manager.store.get(client.id);
const guest = (args:string[],timeoutMs=15_000)=>runtime.guest(current(),args,{timeoutMs});
const admin = (args:string[],input?:string)=>runtime.management(current(),args,{input,timeoutMs:30_000});
const gatewayAdmin = (args:string[],input?:string,timeoutMs=30_000)=>runtime.management(gateway,args,{input,timeoutMs});
async function finish(job:Job,expected='succeeded') {
  await manager.tasks.get(job.id)?.promise;
  const done = manager.store.jobs().find(j=>j.id===job.id)!;
  assert.equal(done.status,expected,done.message);
  return done;
}
function phase(message:string) { console.log(new Date().toISOString(),message); report.phase=message; }
const request = ()=>guest(['curl','--fail','--silent','--max-time','4','--proxy','','--noproxy','*','http://203.0.113.10/']);
try {
  if (bridgeOwner) {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    report.packageCdHash = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])).match(/^CDHash=(.+)$/m)?.[1];
    assert.equal(report.packageCdHash, '9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3');
    report.modules = Object.fromEntries(await Promise.all((await readdir(compiled)).filter(file => file.endsWith('.js')).map(async file => [file, hash(await readFile(path.join(compiled, file)))])));
    assert.equal(Object.keys(report.modules as object).length, 45);
    report.initialSources = Object.fromEntries(await Promise.all(sourceFiles.map(async file => {
      const bytes = await readFile(path.join(root, file)); await writeFile(path.join(artifacts, `source-${path.basename(file)}`), bytes, { mode: 0o600 }); return [file, hash(bytes)];
    })));
  }
  if (withWorkloads) {
    const cache = path.join(temporary, 'tools/guest-browser');
    await mkdir(cache, { recursive: true, mode: 0o700 });
    await copyFile(`/tmp/mu-chromium-${GUEST_CHROMIUM_VERSION}-arm64.zip`, path.join(cache, `chrome-${GUEST_CHROMIUM_VERSION}-linux-arm64.zip`)).catch(() => {});
  }
  phase('Preparing a separate disposable UDP gateway VM');
  const baseCache = process.env.MU_TEST_PROTECTED_BASE;
  if (bridgeOwner && baseCache) report.reusedProtectedBase = await seedProtectedTestBase(runtime, baseCache);
  const config = parse(buildLimaConfig(gateway));
  config.portForwards.unshift({guestPort:51820,hostPort:port,hostIP:'127.0.0.1',guestIP:'0.0.0.0',guestIPMustBeZero:false,proto:'udp'});
  const file=path.join(temporary,'gateway.yaml');
  await writeFile(file,stringify(config),{mode:0o600});
  if (bridgeOwner && baseCache) {
    await runtime.command(['clone', 'mu-protected-base-v1', gateway.instanceName], { timeoutMs: 120_000 });
    await writeFile(path.join(runtime.limaHome, gateway.instanceName, 'lima.yaml'), stringify(config), { mode: 0o600 });
    await runtime.command(['start', '--timeout', '15m', gateway.instanceName], { timeoutMs: 950_000 });
  } else await runtime.command(['start','--name',gateway.instanceName,'--timeout','15m',file],{timeoutMs:950_000});
  await gatewayAdmin(['bash','-s'],`set -euo pipefail
${bridgeOwner && baseCache ? `sudo systemctl stop mucodesandbox-egress.service mucodesandbox-lease.service || true
sudo nft flush ruleset
command -v wg
command -v nft
command -v tcpdump` : `
sudo apt-get update -qq
sudo apt-get install -y -qq wireguard-tools nftables tcpdump`}
sudo install -d -m 0700 /run/mu-wg-runtime
sudo install -m 0600 /dev/null /run/mu-wg-runtime/peer.conf
printf '%s' ${shellQuote(`[Interface]\nPrivateKey = ${gatewayKey.privateKey}\nListenPort = 51820\n[Peer]\nPublicKey = ${clientKey.publicKey}\nAllowedIPs = 10.77.0.2/32\n`)} | sudo tee /run/mu-wg-runtime/peer.conf >/dev/null
sudo chmod 0600 /run/mu-wg-runtime/peer.conf
sudo ip link add mu_gateway type wireguard
sudo wg setconf mu_gateway /run/mu-wg-runtime/peer.conf
sudo ip address add 10.77.0.1/24 dev mu_gateway
sudo ip link set mu_gateway mtu 1420 up
sudo ip link add mu_target type dummy
sudo ip address add 203.0.113.10/32 dev mu_target
sudo ip link set mu_target up
sudo sysctl -qw net.ipv4.ip_forward=1
sudo nft -f - <<'MU_NAT'
table ip mu_runtime_nat {
 chain postrouting { type nat hook postrouting priority srcnat; policy accept;
   ip saddr 10.77.0.2 oifname "eth0" masquerade
 }
}
MU_NAT
printf 'MU_PACKET_RUNTIME_OK' | sudo tee /run/mu-wg-runtime/index.html >/dev/null
sudo systemd-run --unit=mu-wg-runtime-http --property=WorkingDirectory=/run/mu-wg-runtime /usr/bin/python3 -m http.server 80 --bind 203.0.113.10
`,300_000);
  await workloads?.prepareGateway();
  phase('Starting the protected client through normal application lifecycle');
  await finish(await manager.lifecycle(client.id,'start'));
  report.initialProtection=await runtime.networkProtection(current());
  assert.equal((report.initialProtection as {active:boolean}).active,true,JSON.stringify(report.initialProtection));
  assert.equal((report.initialProtection as {policy:string}).policy,'packet-tunnel');
  assert.equal((await request()).trim(),'MU_PACKET_RUNTIME_OK');
  report.actualTwoVmHandshakeAndHttp=true;
  assert.match(await guest(['getent','ahostsv4','example.com']),/STREAM/);
  assert.match(await guest(['curl','--fail','--silent','--max-time','15','--proxy','','https://example.com/']),/Example Domain/);
  report.systemDnsAndVerifiedHttps=true;
  assert.equal((await guest(['bash','-lc','printf "%s|%s|%s" "$HTTP_PROXY" "$HTTPS_PROXY" "$ALL_PROXY"'])).trim(),'||');
  await assert.rejects(guest(['cat','/etc/mucodesandbox/wireguard.conf']));
  assert.equal((await admin(['sudo','stat','-c','%a:%U:%G','/etc/mucodesandbox/wireguard.conf'])).trim(),'600:root:root');
  report.privateKeyRootOnly=true;
  const bootFile='/var/log/mucodesandbox/boot-network.pcap';
  const bootBytes=Buffer.from((await admin(['sudo','base64','-w0',bootFile])).trim(),'base64');
  assert.ok(bootBytes.length>24);
  await writeFile(path.join(artifacts,'first-boot.pcap'),bootBytes,{mode:0o600});
  const bootText=await admin(['sudo','tcpdump','-nn','-r',bootFile]);
  const physical=bridgeOwner ? await packetLines(path.join(artifacts,'first-boot.pcap'),'ifindex 2 and outbound and (ip or ip6)') : bootText.split('\n').filter(line=>/\seth0\s+Out\s+IP6?\s/.test(line));
  assert.ok(physical.length>0);
  assert.ok(physical.every(line=>!/ IP6 /.test(line)&&(line.includes(` > 192.168.5.2.${port}:`)||/\.22 > 192\.168\.5\.2\./.test(line)||/\.68 > [0-9.]+\.67:/.test(line))),bootText);
  report.firstBootCapture={bytes:bootBytes.length,physicalOutputPackets:physical.length,onlyApprovedUdpSshDhcp:true};
  if(workloads)report.workloads=await workloads.verify();
  if(withFaults)report.faults=await verifyWireguardFaults(service,gateway,client.id,artifacts);
  if (bridgeOwner) {
    const faultReport = report.faults as Record<string, unknown>;
    assert.equal(faultReport.passed, true);
    report.physicalInterfaceIndex = Number((await admin(['cat','/sys/class/net/eth0/ifindex'])).trim());
    assert.equal(report.physicalInterfaceIndex, 2);
    report.endpoint = `192.168.5.2:${port}`;
    await writeFile(path.join(artifacts, 'application-logs.json'), JSON.stringify(manager.store.logs(client.id), null, 2), { mode: 0o600 });
  } else {
  phase('Capturing the actual client physical interface and checking bypass attempts');
  await admin(['bash','-s'],`set -eu
sudo systemd-run --unit=mu-wg-runtime-capture /usr/bin/tcpdump --immediate-mode -ni eth0 -Q out -U -w /run/mu-wg-runtime.pcap 'ip or ip6'
sleep 1
`);
  assert.equal((await request()).trim(),'MU_PACKET_RUNTIME_OK');
  const before=(await runtime.networkProtection(current())).blockedPackets;
  await assert.rejects(guest(['curl','--fail','--silent','--max-time','2','--proxy','','http://192.168.5.2:9/']));
  await admin(['sudo','python3','-c',`import socket
for address,port in [('8.8.8.8',53),('8.8.8.8',443)]:
 s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,b'eth0')
 try: s.sendto(b'blocked',(address,port))
 except PermissionError: pass
 s.close()
`]);
  assert.ok((await runtime.networkProtection(current())).blockedPackets>before);
  report.physicalTcpDnsUdpBypassBlocked=true;
  const ipv6Before=(await runtime.networkProtection(current())).blockedPackets;
  await admin(['bash','-s'],`set -eu
sudo ip link add mu6packet type dummy
trap 'sudo ip -6 rule del priority 8000; sudo ip link del mu6packet' EXIT
sudo ip link set mu6packet up
sudo ip -6 address add fd77::1/64 dev mu6packet
sudo ip -6 rule add priority 8000 to fd77::/64 lookup main
python3 - <<'MU_IPV6'
import socket
s=socket.socket(socket.AF_INET6,socket.SOCK_DGRAM)
try: s.sendto(b'blocked',('fd77::2',53))
except PermissionError: pass
MU_IPV6
`);
  assert.ok((await runtime.networkProtection(current())).blockedPackets>ipv6Before);
  report.ipv6BlockedWithRoutePresent=true;
  await admin(['sudo','systemctl','stop','mu-wg-runtime-capture.service']);
  const unapproved=await admin(['sudo','tcpdump','-nn','-r','/run/mu-wg-runtime.pcap',`not (udp dst port ${port} and dst host 192.168.5.2) and not tcp src port 22 and not (udp src port 68 and udp dst port 67)`]);
  assert.ok(!unapproved.split('\n').some(line=>/^\d\d:\d\d:\d\d/.test(line)),unapproved);
  const approved=await admin(['sudo','tcpdump','-nn','-r','/run/mu-wg-runtime.pcap',`udp dst port ${port} and dst host 192.168.5.2`]);
  assert.ok(approved.split('\n').some(line=>/^\d\d:\d\d:\d\d/.test(line)));
  const capture=Buffer.from((await admin(['sudo','base64','-w0','/run/mu-wg-runtime.pcap'])).trim(),'base64');
  assert.ok(capture.length>24);
  await writeFile(path.join(artifacts,'physical.pcap'),capture,{mode:0o600});
  report.physicalCaptureOnlyApprovedUdpAndManagement=true;
  clearInterval(manager.protectionTimer);
  await admin(['sudo','ip','-4','rule','del','priority','17101']);
  const changedRoute=await runtime.networkProtection(current());
  assert.ok(!changedRoute.routingReady&&!changedRoute.active);
  await assert.rejects(request());
  await admin(['sudo','ip','-4','rule','add','priority','17101','not','fwmark',String(WIREGUARD_MARK),'lookup','51821']);
  assert.equal((await runtime.networkProtection(current())).active,true);
  report.routeRemovalDetectedWithoutDirectFallback=true;
  phase('Checking tunnel shutdown, quarantine and recovery');
  await admin(['sudo','systemctl','stop','mucodesandbox-wireguard.service']);
  await assert.rejects(request());
  await assert.rejects(guest(['curl','--fail','--silent','--max-time','2','--proxy','','http://192.168.5.2:9/']));
  const stopped=await runtime.networkProtection(current());
  assert.ok(stopped.firewallActive&&!stopped.active);
  await manager.monitorProtection();await Promise.all([...manager.quarantines.values()]);
  assert.equal((await runtime.list()).find(i=>i.name===client.instanceName)?.status,'Stopped');
  report.tunnelLossFailsClosedAndQuarantines=true;
  await finish(await manager.lifecycle(client.id,'restart'));
  assert.equal((await request()).trim(),'MU_PACKET_RUNTIME_OK');
  phase('Checking invalid peer rejection and editable failed-start recovery');
  await finish(await manager.lifecycle(client.id,'stop'));
  const configInput=()=>{ const e=current();const {name,description,kind,color,cpus,memoryGiB,diskGiB,mounts,ports,network,browserUrl,identity}=e;return {name,description,kind,color,cpus,memoryGiB,diskGiB,mounts,ports,network,browserUrl,identity}; };
  const bad=configInput();bad.network.wireguard!.peerPublicKey=keys().publicKey;
  await manager.update(client.id,bad);
  await finish(await manager.lifecycle(client.id,'start'),'failed');
  assert.equal((await runtime.list()).find(i=>i.name===client.instanceName)?.status,'Stopped');
  const fixed=configInput();fixed.network.wireguard!.peerPublicKey=gatewayKey.publicKey;
  await manager.update(client.id,fixed);
  await finish(await manager.lifecycle(client.id,'start'));
  assert.equal((await request()).trim(),'MU_PACKET_RUNTIME_OK');
  report.wrongPeerFailsClosedAndCanBeCorrected=true;
  phase('Checking expiring business permission independently of the management timer');
  clearInterval(manager.protectionTimer);
  await runtime.renewLease(current());
  await new Promise(resolve=>setTimeout(resolve,47_000));
  await assert.rejects(request());
  const expired=await runtime.networkProtection(current());
  assert.ok(!expired.leaseActive&&!expired.active);
  await assert.rejects(runtime.renewLease(current()));
  report.kernelLeaseExpiryBlocksBusinessAndCannotReopen=true;
  await finish(await manager.lifecycle(client.id,'stop'));
  const direct=configInput();direct.network={mode:'direct',host:'',port:7890,username:'',noProxy:'',strict:false,transparent:false};
  await manager.update(client.id,direct);
  await finish(await manager.lifecycle(client.id,'start'));
  assert.match(await guest(['curl','--fail','--silent','--max-time','15','https://example.com/']),/Example Domain/);
  await assert.rejects(admin(['sudo','wg','show','mu_wg']));
  await assert.rejects(admin(['sudo','test','-e','/etc/mucodesandbox/wireguard.conf']));
  report.directModeRestoresAndRemovesTunnelSecret=true;
  const logs=JSON.stringify(manager.store.logs(client.id));
  assert.ok(!logs.includes(clientKey.privateKey)&&!logs.includes(gatewayKey.privateKey));
  report.applicationLogsContainNoPrivateKey=true;
  if (withPackage && workloads) {
    phase('Opening the actual signed candidate with the prepared packet environment');
    await finish(await manager.lifecycle(client.id,'stop'));
    const packet=configInput();packet.network={mode:'wireguard',host:'192.168.5.2',port,username:'',noProxy:'',strict:true,transparent:true,wireguard:{address:'10.77.0.2/32',privateKey:clientKey.privateKey,peerPublicKey:gatewayKey.publicKey,listenPort:51821,mtu:1420}};
    await manager.update(client.id,packet);
    const prepared=current();
    await service.close();serviceClosed=true;
    report.packagedWorkloads=await verifyPackagedWireguard({root,dataDir:temporary,artifacts,environment:prepared,runtime,fixture:workloads.packagedFixture});
  }
  }
  report.passed=true;
} catch(error) {
  report.error=redact((error as Error).message);
  report.lastInspection=lastInspection;
  if (!serviceClosed) report.logs=manager.store.logs(client.id).slice(-14);
  process.exitCode=1;
} finally {
  await Promise.all([...manager.quarantines.values()]);
  await (serviceClosed ? runtime.remove(client) : manager.lifecycle(client.id,'delete').then(job=>finish(job))).catch(error=>{report.cleanupError=redact((error as Error).message);report.passed=false;process.exitCode=1;});
  await runtime.remove(gateway).catch(error=>{report.gatewayCleanupError=redact((error as Error).message);report.passed=false;process.exitCode=1;});
  await workloads?.close();
  await service.close();
  if (bridgeOwner) for (const instance of await runtime.list()) {
    try { if (instance.status === 'Running') await runtime.command(['stop', '--force', instance.name], { timeoutMs: 120_000 }); await runtime.command(['delete', instance.name], { timeoutMs: 120_000 }); }
    catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
  }
  if (!report.cleanupError&&!report.gatewayCleanupError) { assert.deepEqual(await runtime.list(), []); await rm(temporary,{recursive:true,force:true}); report.testResourcesRemoved = true; }
  else report.retainedDataDir=temporary;
  if (bridgeOwner) {
    try {
      report.sources = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(path.join(root, file)))])));
      assert.deepEqual(report.sources, report.initialSources);
      for (const [file, digest] of Object.entries(report.modules as Record<string, string>)) assert.equal(hash(await readFile(path.join(compiled, file))), digest);
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]); report.inputsUnchanged = true;
    } catch (error) { report.inputError = String(error); report.passed = false; process.exitCode = 1; }
    report.artifacts = Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file => [file, hash(await readFile(path.join(artifacts, file)))])));
  }
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(root,'test-results',`${artifactName}.json`),JSON.stringify(report,null,2),{mode:0o600});
  if (bridgeOwner) await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report,null,2));
}
