import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as httpsServer } from 'node:https';
import { createServer as tcpServer, connect, type Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { EGRESS_RECEIVERS,EgressMismatchError,measureEgress } from '../server/egress.ts';
import type { Environment } from '../shared/types.ts';
import type { LimaRuntime } from '../server/runtime.ts';

// Production curl options and real TLS/SOCKS traffic; only the guest wrapper
// and CA path are substituted. No VM, public IP services, accounts or global trust changes.
const execute=promisify(execFile),dir=await mkdtemp(path.join(tmpdir(),'mu-egress-quorum-'));
const hosts=EGRESS_RECEIVERS.map(v=>new URL(v.url).hostname),sockets=new Set<Socket>();
let mode='healthy';const targets:string[]=[];
const report:{passed:boolean;fixtureOnly:boolean;scope:string;checks:unknown[];error?:string}={passed:false,fixtureOnly:true,scope:'Real local curl TLS verification and controlled SOCKS target resolution; not a real VM or public egress',checks:[]};
async function openssl(args:string[]){await execute('/usr/bin/openssl',args,{cwd:dir,timeout:10000});}
await openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=Mu Quorum Fixture CA']);
for(const name of ['valid','wrong']){
 await openssl(['req','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+(name==='valid'?hosts[0]:'wrong.invalid')]);
 await writeFile(path.join(dir,name+'.ext'),'subjectAltName='+ (name==='valid'?hosts.map(v=>'DNS:'+v).join(','):'DNS:wrong.invalid')+'\n');
 await openssl(['x509','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',name+'.pem','-days','1','-extfile',name+'.ext']);
}
const response=(req:any,res:any)=>{
 const hostname=String(req.headers.host).split(':')[0],ip=mode==='mismatch'&&hostname===hosts[0]?'9.9.9.9':'8.8.8.8';
 res.setHeader('Content-Type',hostname===hosts[2]?'text/plain':'application/json');res.setHeader('Connection','close');
 res.end(hostname===hosts[2]?ip+'\n':JSON.stringify({ip,country:'Synthetic'}));
};
const valid=httpsServer({key:await readFile(path.join(dir,'valid.key')),cert:await readFile(path.join(dir,'valid.pem'))},response);
const wrong=httpsServer({key:await readFile(path.join(dir,'wrong.key')),cert:await readFile(path.join(dir,'wrong.pem'))},response);
for(const server of [valid,wrong]){server.on('connection',(socket:Socket)=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));}
const proxy=tcpServer(socket=>{
 sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
 let buffer=Buffer.alloc(0),stage='hello';
 const onData=(data:Buffer)=>{
  buffer=Buffer.concat([buffer,data]);
  if(stage==='hello'){
   if(buffer.length<2||buffer.length<2+buffer[1])return;
   assert.equal(buffer[0],5);buffer=buffer.subarray(2+buffer[1]);socket.write(Buffer.from([5,0]));stage='connect';
  }
  if(stage!=='connect'||buffer.length<5)return;
  assert.equal(buffer[3],3);const length=buffer[4];if(buffer.length<7+length)return;
  const hostname=buffer.subarray(5,5+length).toString(),port=buffer.readUInt16BE(5+length);assert.ok(hosts.includes(hostname));assert.equal(port,443);
  targets.push(hostname);const remainder=buffer.subarray(7+length);buffer=Buffer.alloc(0);stage='forward';socket.pause();socket.removeListener('data',onData);
  socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));
  if(mode==='one-timeout'&&hostname===hosts[0]||mode==='two-timeouts'&&hostname!==hosts[2]){socket.on('data',()=>{});return;}
  const server=mode==='bad-certificate'&&hostname===hosts[0]?wrong:valid,address=server.address();assert.ok(address&&typeof address!=='string');
  const out=connect(address.port,'127.0.0.1');sockets.add(out);out.once('close',()=>sockets.delete(out));out.on('error',()=>socket.destroy());socket.on('error',()=>out.destroy());
  out.on('connect',()=>{if(remainder.length)out.write(remainder);socket.pipe(out);out.pipe(socket);});socket.once('close',()=>out.destroy());
 };
 socket.on('data',onData);socket.on('error',()=>{});
});
await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const address=proxy.address();assert.ok(address&&typeof address!=='string');
const environment={network:{egressLock:{expectedIp:'8.8.8.8'}}} as Environment;
const runtime={egressProbeProxy:()=>`socks5h://127.0.0.1:${address.port}`,management:async(_e:Environment,command:string[],options:any)=>{
 const args=command.slice(command.indexOf('/usr/bin/curl')+1);args[args.indexOf('--cacert')+1]=path.join(dir,'ca.pem');
 const result=await execute('/usr/bin/curl',args,{env:{PATH:'/usr/bin:/bin'},timeout:14000,maxBuffer:65536,signal:options.signal});return result.stdout;
}} as unknown as LimaRuntime;
try{
 for(const scenario of ['healthy','one-timeout','two-timeouts','mismatch','bad-certificate']){
  mode=scenario;targets.length=0;const started=Date.now();let result:any,error:unknown;
  try{result=await measureEgress(runtime,environment);}catch(e){error=e;}
  if(scenario==='healthy')assert.equal(result?.verification.receipts.length,3);
  else if(scenario==='one-timeout'){assert.equal(result?.verification.receipts.length,2);assert.deepEqual(result?.verification.timedOutReceivers,['ipwho']);}
  else if(scenario==='two-timeouts')assert.equal((error as any)?.code,'EGRESS_UNAVAILABLE');
  else if(scenario==='mismatch')assert.ok(error instanceof EgressMismatchError);
  else assert.ok(String(error).includes('curl: (60)'),String(error));
  assert.ok(targets.every(host=>hosts.includes(host)));report.checks.push({scenario,passed:true,targets:[...targets],durationMs:Date.now()-started,receipts:result?.verification});
  for(const socket of sockets)socket.destroy();
 }
 await new Promise<void>(r=>proxy.close(()=>r()));
 await assert.rejects(measureEgress(runtime,environment));report.checks.push({scenario:'transport-offline',passed:true});
 report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{
 for(const socket of sockets)socket.destroy();
 if(proxy.listening)await new Promise<void>(r=>proxy.close(()=>r()));
 for(const server of [valid,wrong])await new Promise<void>(r=>server.close(()=>r()));
 await rm(dir,{recursive:true,force:true});
 await writeFile(path.resolve(import.meta.dirname,'../test-results/egress-quorum-fixture.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
