import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../../server/process.ts';

export const LAB_EXIT='203.0.113.10'; // RFC 5737 documentation address, never a real user IP.
export const LAB_RECEIVERS=['203.0.113.10','203.0.113.11'] as const;

// Every possible destination is mapped to loopback or rejected. The fixture
// proxy never opens an Internet connection, including DNS or model services.
export async function localFixtures(directory:string,openssl:string) {
  await mkdir(directory,{recursive:true});
  const key=path.join(directory,'fixture-key.pem'),cert=path.join(directory,'fixture-cert.pem');
  await run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=Mu local test only',
    '-addext','subjectAltName=IP:203.0.113.10,IP:203.0.113.11','-keyout',key,'-out',cert],{timeoutMs:15000});
  const material={key:await readFile(key),cert:await readFile(cert)};
  const sockets=new Set<Duplex>();let receipts=0,denied=0,stopped=false;
  const receivers=LAB_RECEIVERS.map(()=>httpsServer(material,(req,res)=>{
    receipts++;res.setHeader('content-type','application/json');res.end(JSON.stringify({ip:LAB_EXIT,fixture:true}));
  }));
  for(const server of receivers){server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}
  const proxy=httpServer((_req,res)=>{denied++;res.writeHead(403).end();});
  proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  proxy.on('connect',(req,socket,head)=>{
    const index=LAB_RECEIVERS.findIndex(ip=>req.url===`${ip}:443`);
    if(index<0||stopped){denied++;socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    const target=connect((receivers[index].address() as AddressInfo).port,'127.0.0.1');
    sockets.add(target);target.on('close',()=>sockets.delete(target));
    target.on('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)target.write(head);socket.pipe(target);target.pipe(socket);});
    target.on('error',()=>socket.destroy());socket.on('error',()=>target.destroy());socket.on('close',()=>target.destroy());
  });
  await new Promise<void>((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
  return {port:(proxy.address() as AddressInfo).port,certificate:material.cert.toString(),receivers:LAB_RECEIVERS,
    counters:()=>({receipts,denied}),
    close:async()=>{stopped=true;for(const socket of sockets)socket.destroy();await Promise.all([...receivers,proxy].map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));}};
}
