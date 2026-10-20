import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../../server/process.ts';
import dns from 'dns2';

export const LAB_EXIT='203.0.113.10'; // RFC 5737 documentation address, never a real user IP.
export const LAB_RECEIVERS=['203.0.113.10','203.0.113.11'] as const;
export const LAB_DNS={address:'203.0.113.12',serverName:'dns.mu.test',port:443,path:'/dns-query'};
export const LAB_PROBE_HOSTS=['receiver-a.mu.test','receiver-b.mu.test'] as const;

// Every possible destination is mapped to loopback or rejected. The fixture
// proxy never opens an Internet connection, including DNS or model services.
export async function localFixtures(directory:string,openssl:string,exitIp=LAB_EXIT) {
  await mkdir(directory,{recursive:true});
  const key=path.join(directory,'fixture-key.pem'),cert=path.join(directory,'fixture-cert.pem');
  await run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=Mu local test only',
    '-addext','subjectAltName=IP:203.0.113.10,IP:203.0.113.11,IP:203.0.113.12,DNS:receiver.mu.test,DNS:receiver-a.mu.test,DNS:receiver-b.mu.test,DNS:dns.mu.test','-keyout',key,'-out',cert],{timeoutMs:15000});
  const material={key:await readFile(key),cert:await readFile(cert)};
  const sockets=new Set<Duplex>();let receipts=0,denied=0,stopped=false,dnsRequests=0,available=true,conflict=false,dnsAvailable=true;
  const tunnels=new Set<Duplex>();
  const receivers=LAB_RECEIVERS.map((_,index)=>httpsServer(material,(req,res)=>{
    if(req.url==='/stream'){
      res.writeHead(200,{'content-type':'text/plain','cache-control':'no-store'});let sequence=0;
      const interval=setInterval(()=>res.write(String(++sequence)+'\n'),100);res.on('close',()=>clearInterval(interval));return;
    }
    receipts++;res.setHeader('content-type','application/json');res.end(JSON.stringify({ip:conflict&&index===1?'203.0.113.11':exitIp,fixture:true}));
  }));
  // A local RFC 8484 endpoint resolves only the synthetic acceptance hostname.
  const resolver=httpsServer(material,(req,res)=>{void(async()=>{
    try{
      const url=new URL(req.url??'/','https://dns.mu.test');if(url.pathname!==LAB_DNS.path){res.writeHead(404).end();return;}if(!dnsAvailable){res.writeHead(503).end();return;}
      const blocks:Buffer[]=[];let size=0;if(req.method==='POST')for await(const block of req){size+=block.length;if(size>4096)throw Error('Oversized DNS question');blocks.push(block);}
      const data=req.method==='GET'?Buffer.from(url.searchParams.get('dns')??'','base64url'):Buffer.concat(blocks);
      const question=dns.Packet.parse(data),answer=dns.Packet.createResponseFromRequest(question);dnsRequests++;
      const names:Record<string,string>={'receiver.mu.test':LAB_EXIT,'receiver-a.mu.test':LAB_RECEIVERS[0],'receiver-b.mu.test':LAB_RECEIVERS[1]};
      for(const q of question.questions)if(names[q.name]&&q.type===dns.Packet.TYPE.A)answer.answers.push(new dns.Packet.Resource({name:q.name,type:dns.Packet.TYPE.A,class:dns.Packet.CLASS.IN,ttl:0,address:names[q.name]}));
      res.writeHead(200,{'content-type':'application/dns-message'});res.end(answer.toBuffer());
    }catch{res.writeHead(400).end();}
  })();});
  receivers.push(resolver);
  for(const server of receivers){server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}
  const proxy=httpServer((_req,res)=>{denied++;res.writeHead(403).end();});
  proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  proxy.on('connect',(req,socket,head)=>{
    const targets=[...LAB_RECEIVERS,LAB_DNS.address];const index=targets.findIndex(ip=>req.url===`${ip}:443`);
    if(index<0||stopped||!available){denied++;socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    const target=connect((receivers[index].address() as AddressInfo).port,'127.0.0.1');
    sockets.add(target);tunnels.add(target);target.on('close',()=>{sockets.delete(target);tunnels.delete(target);});
    target.on('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)target.write(head);socket.pipe(target);target.pipe(socket);});
    target.on('error',()=>socket.destroy());socket.on('error',()=>target.destroy());socket.on('close',()=>target.destroy());
  });
  await new Promise<void>((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
  return {port:(proxy.address() as AddressInfo).port,certificate:material.cert.toString(),receivers:LAB_RECEIVERS,probeHosts:LAB_PROBE_HOSTS,
    dns:LAB_DNS,counters:()=>({receipts,denied,dnsRequests}),
    interrupt:()=>{available=false;for(const socket of tunnels)socket.destroy();},restore:()=>{available=true;},
    setConflict:(value:boolean)=>{conflict=value;},setDnsAvailable:(value:boolean)=>{dnsAvailable=value;},
    close:async()=>{stopped=true;for(const socket of sockets)socket.destroy();await Promise.all([...receivers,proxy].map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));}};
}
