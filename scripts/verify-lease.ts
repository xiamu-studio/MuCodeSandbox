import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer, connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { LimaRuntime } from '../server/runtime.ts';
import { LEASE_SECONDS, LEASE_HELPER_PATH } from '../server/guest-lease.ts';
import type { Environment } from '../shared/types.ts';

const root=path.resolve(import.meta.dirname,'..');
const temporary=process.env.MU_LEASE_TEST_DATA?path.resolve(process.env.MU_LEASE_TEST_DATA):await mkdtemp(path.join(homedir(),'.mu-lease-verification-'));
assert.ok(path.basename(temporary).startsWith('.mu-lease-verification-'));
await mkdir(temporary,{recursive:true,mode:0o700});
process.env.MU_LIMA_PATH??=path.join(homedir(),'.mucodesandbox/tools/lima/bin/limactl');
const results=path.join(root,'test-results');await mkdir(results,{recursive:true});
const report:Record<string,any>={passed:false,accountFree:true,paidModelCalls:0,startedAt:new Date().toISOString(),leaseSeconds:LEASE_SECONDS,
  scope:'Real guest kernel lease with actual host SIGKILL, live bidirectional TCP, closed reboot, renewal rejection and graceful exit; no public-exit or sleep guarantee'};
const sockets=new Set<Socket>();
const track=(socket:Socket)=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));};
let hits=0,pushes=0,connects=0;
const business=createTcpServer(socket=>{
  track(socket);connects++;
  let buffer='';
  socket.on('data',data=>{buffer+=data.toString();while(buffer.includes('\n')){const index=buffer.indexOf('\n');buffer=buffer.slice(index+1);hits++;socket.write(`E${hits}\n`);}});
  const timer=setInterval(()=>{if(!socket.destroyed){pushes++;socket.write(`T${pushes}\n`);}},1000);
  socket.on('close',()=>clearInterval(timer));socket.on('error',()=>{});
});
await new Promise<void>(resolve=>business.listen(0,'127.0.0.1',resolve));
const businessPort=(business.address() as {port:number}).port;
const auth=`Basic ${Buffer.from('mu:lease-fixture').toString('base64')}`;
const proxy=createServer((_request,response)=>{response.writeHead(405);response.end();});
proxy.on('connection',track);
proxy.on('connect',(request,client,head)=>{
  if(request.headers['proxy-authorization']!==auth){client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');return;}
  const target=new URL(`http://${request.url}`),fixture=target.hostname==='203.0.113.60';
  const remote=connect(fixture?businessPort:Number(target.port)||80,fixture?'127.0.0.1':target.hostname,()=>{
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);client.pipe(remote);remote.pipe(client);
  });
  track(remote);remote.on('error',()=>client.destroy());client.on('error',()=>remote.destroy());client.on('close',()=>remote.destroy());
});
await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const port=(proxy.address() as {port:number}).port;
const runtime=new LimaRuntime(temporary);
let child:ChildProcess|undefined,e:Environment|undefined,serial=0,childLog='',captureOpen=false;
const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
async function launch(){
  const ready=new Promise<void>((resolve,reject)=>{
    child=fork(path.join(root,'scripts/lease-service-fixture.ts'),[root,temporary,String(port)],{cwd:root,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env}});
    child.stdout!.on('data',data=>{childLog+=data.toString();});child.stderr!.on('data',data=>{childLog+=data.toString();});
    child.on('message',(message:any)=>{
      if(message.ready){resolve();return;}
      const request=pending.get(message.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timer);
      if(message.error){report.fixtureFailure=message;request.reject(new Error(message.error));}else request.resolve(message.result);
    });
    child.once('exit',(code,signal)=>{reject(new Error(`Fixture exited ${code}/${signal}`));for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('Fixture exited'));}pending.clear();});
  });
  await ready;
}
function rpc(op:string,timeoutMs=1_200_000):Promise<any>{
  return new Promise((resolve,reject)=>{
    const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Fixture ${op} timed out`));},timeoutMs);
    pending.set(id,{resolve,reject,timer});child!.send({id,op});
  });
}
const management=(args:string[],input?:string)=>runtime.management(e!,args,{input,timeoutMs:20_000});
const guest=(args:string[],timeoutMs=10_000)=>runtime.guest({...e!,state:'running'},args,{timeoutMs});
const lines=async()=>Number((await management(['bash','-c','wc -l < /home/dev/lease-stream.jsonl 2>/dev/null || echo 0'])).trim());
const newBusiness=()=>guest(['python3','-c','import socket; s=socket.create_connection(("203.0.113.60",80),2);s.settimeout(2);s.sendall(b"NEW\\n");print(s.recv(128).decode());s.close()'],5000);
async function captureStop(){
  if(!captureOpen)return;captureOpen=false;
  await management(['sudo','systemctl','stop','mu-lease-capture.service']);
  await management(['sudo','install','-o','mu','-g','mu','-m','0600','/var/log/mucodesandbox/lease-network.pcap','/tmp/mu-lease-capture-export.pcap']);
  await runtime.command(['copy',`${e!.instanceName}:/tmp/mu-lease-capture-export.pcap`,path.join(results,'guest-lease.pcap')],{timeoutMs:20_000});
  await management(['sudo','rm','-f','/tmp/mu-lease-capture-export.pcap']);
  const text=await management(['sudo','tcpdump','-nn','-r','/var/log/mucodesandbox/lease-network.pcap']);
  await writeFile(path.join(results,'guest-lease-decoded.txt'),text);
  const route=JSON.parse((await management(['ip','-j','-4','route','show','default'])).split('\n').find(line=>line.startsWith('['))!)[0];
  const physical=text.split('\n').filter(line=>{
    const packet=line.match(/^\S+\s+(\S+)\s+(In|Out)\s+(IP6?)\s/);
    return packet!==null&&packet[1]===route.dev&&packet[2]==='Out';
  });
  assert.ok(physical.length>0);
  assert.ok(physical.every(line=>!line.includes(' Out IP6 ')&&(line.includes(` > ${route.gateway}.${port}:`)||line.includes('.22 > ')||line.includes('.68 > '))), 'Unapproved physical destination');
  report.capture={physicalOutPackets:physical.length,onlyApprovedEgress:true,scope:'Pre-kill positive control through expiry; capture stopped before reboot'};
}
try{
  console.log('Starting disposable real VM with initially closed business permission.');
  await launch();const initial=await rpc('start');e=initial.environment;report.activationChecks=initial.activationChecks;
  const live=await runtime.networkProtection({...e!,state:'running'});assert.equal(live.active,true);assert.equal(live.leaseActive,true);
  const session=(await rpc('session')).session;
  await assert.rejects(guest(['sudo','-n',LEASE_HELPER_PATH,'renew',session]));
  await assert.rejects(guest(['sudo','-n','-u','mu-probe','id']));
  report.developmentCannotRefreshOrAssumeProbe=true;
  await management(['bash','-s'],`set -eu
sudo install -d -m 0700 /var/log/mucodesandbox
sudo rm -f /var/log/mucodesandbox/lease-network.pcap
sudo systemd-run --quiet --unit=mu-lease-capture --property=Type=exec /usr/bin/tcpdump --immediate-mode -U -i any -s 0 -w /var/log/mucodesandbox/lease-network.pcap
for n in $(seq 1 100); do test "$(sudo stat -c %s /var/log/mucodesandbox/lease-network.pcap 2>/dev/null || echo 0)" -ge 24 && break; sleep 0.05; done
test "$(sudo stat -c %s /var/log/mucodesandbox/lease-network.pcap)" -ge 24
sudo tee /usr/local/libexec/mu-lease-stream-fixture >/dev/null <<'MU_STREAM'
#!/usr/bin/python3
import json, socket, threading, time
s=socket.create_connection(('203.0.113.60',80),3)
s.settimeout(120)
def send():
    while True:
        s.sendall(b'Q\\n')
        time.sleep(1)
threading.Thread(target=send,daemon=True).start()
with s.makefile('r') as incoming:
    for line in incoming:
        with open('/home/dev/lease-stream.jsonl','a') as out: out.write(json.dumps({'at':time.time(),'line':line.strip()})+'\\n')
MU_STREAM
sudo chmod 0755 /usr/local/libexec/mu-lease-stream-fixture
sudo tee /etc/systemd/system/mu-lease-stream-fixture.service >/dev/null <<'MU_STREAM_UNIT'
[Unit]
After=network-online.target mucodesandbox-tunnel.service
Wants=network-online.target
[Service]
Type=exec
User=dev
ExecStart=/usr/local/libexec/mu-lease-stream-fixture
Restart=no
[Install]
WantedBy=multi-user.target
MU_STREAM_UNIT
sudo systemctl daemon-reload
sudo rm -f /home/dev/lease-stream.jsonl
sudo systemctl enable --now mu-lease-stream-fixture.service
`);captureOpen=true;
  await delay(6000);assert.ok(await lines()>=4);assert.ok(hits>=4);assert.match(await newBusiness(),/[ET]\d/);
  await rpc('access',30_000);
  const beforeKill=await runtime.networkProtection({...e!,state:'running'});assert.ok(beforeKill.leaseRemainingMs!>30_000);
  report.positiveControl={hits,receivedLines:await lines(),remainingMs:beforeKill.leaseRemainingMs};
  console.log('Sending SIGKILL to the actual manager; waiting for kernel expiry while VM and TCP remain alive.');
  const killed=child!,killAt=Date.now();const exited=new Promise<void>(resolve=>killed.once('exit',()=>resolve()));killed.kill('SIGKILL');await exited;child=undefined;
  await delay((LEASE_SECONDS+5)*1000);
  const expired=await runtime.networkProtection({...e!,state:'running'});assert.equal(expired.leaseActive,false);assert.equal(expired.active,false);
  assert.equal((await runtime.list()).find(item=>item.name===e!.instanceName)?.status,'Running');
  const settledHits=hits,settledLines=await lines();await delay(5000);
  assert.equal(hits,settledHits);assert.equal(await lines(),settledLines);
  await assert.rejects(newBusiness());
  report.hardKill={pid:killed.pid,signal:killed.signalCode,observedExpiredAfterMs:Date.now()-killAt,vmStillRunning:true,existingOutboundStopped:true,existingInboundStopped:true,newConnectionsDenied:true,managementAvailable:true,receivedLines:settledLines,hits:settledHits,status:expired};
  await assert.rejects(management(['sudo',LEASE_HELPER_PATH,'renew',session]));
  await assert.rejects(management(['sudo',LEASE_HELPER_PATH,'activate',session]));report.expiredSessionCannotReopen=true;
  await captureStop();

  console.log('Rebooting the same disk with a persistent business service; permission must stay empty.');
  const count=await lines();
  const boot=(await management(['cat','/proc/sys/kernel/random/boot_id'])).trim();
  await management(['sudo','systemctl','reboot']).catch(()=>{});
  let rebooted=false;
  for(let attempt=0;attempt<40;attempt++){
    await delay(2000);
    try{const current=(await management(['cat','/proc/sys/kernel/random/boot_id'])).trim();if(current!==boot){rebooted=true;break;}}catch{}
  }
  assert.equal(rebooted,true);await delay(8000);
  assert.equal(await lines(),count);await assert.rejects(newBusiness());
  const closed=await runtime.networkProtection({...e!,state:'running'},false);assert.equal(closed.leasePrepared,true);assert.equal(closed.leaseActive,false);
  report.rebootStartsClosed={persistentServiceCannotConnect:true,sameDisk:true,leasePrepared:closed.leasePrepared,leaseActive:closed.leaseActive};

  await launch();const resumed=await rpc('start');e=resumed.environment;
  report.activationChecks.push(...resumed.activationChecks);
  assert.match(await newBusiness(),/[ET]\d/);
  await management(['sudo','systemctl','stop','mu-lease-stream-fixture.service']);
  const closeAt=Date.now(),closingChild=child!,closedProcess=new Promise<void>(resolve=>closingChild.once('exit',()=>resolve()));
  await rpc('close',30_000);await closedProcess;child=undefined;
  await assert.rejects(newBusiness());
  const graceful=await runtime.networkProtection({...e!,state:'running'});assert.equal(graceful.leaseActive,false);
  report.gracefulClose={elapsedMs:Date.now()-closeAt,businessDenied:true,leaseActive:false};
  report.actualLinuxVmVerified=true;report.passed=true;
}catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{
  if(child){const owned=child;const exited=new Promise<void>(resolve=>owned.once('exit',()=>resolve()));owned.kill('SIGKILL');await exited;}
  if(e)await captureStop().catch(error=>{report.captureError=String(error);report.passed=false;process.exitCode=1;});
  for(const instance of await runtime.list().catch(()=>[])){
    await runtime.command(['stop','--force',instance.name],{timeoutMs:120_000}).catch(error=>{report.cleanupError=String(error);});
    if(report.passed)await runtime.command(['delete','--force',instance.name],{timeoutMs:120_000}).catch(error=>{report.cleanupError=String(error);});
  }
  for(const socket of sockets)socket.destroy();
  for(const server of [proxy,business])await new Promise<void>(resolve=>server.close(()=>resolve()));
  await writeFile(path.join(results,'guest-lease-fixture.log'),childLog);
  if(!report.passed||report.cleanupError)report.retainedDataDir=temporary;else await rm(temporary,{recursive:true,force:true});
  report.finishedAt=new Date().toISOString();await writeFile(path.join(results,'guest-lease.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,error:report.error,retainedDataDir:report.retainedDataDir},null,2));
}
