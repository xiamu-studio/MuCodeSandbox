import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';

const VENDOR_HOSTS=['archive.ubuntu.com','security.ubuntu.com','azure.archive.ubuntu.com','ports.ubuntu.com'];

// Bootstrap only: read-only requests to Ubuntu package origins. This server
// is never the egress path used by business/security acceptance tests.
export async function packageProxy(fetcher:typeof fetch=fetch) {
  const sockets=new Set<Duplex>(),pending=new Set<AbortController>();let allowed=0,denied=0;
  const permitted=(url:URL)=>VENDOR_HOSTS.includes(url.hostname)&&!url.username&&!url.password&&
    (url.protocol==='http:'&&(!url.port||url.port==='80')||url.protocol==='https:'&&(!url.port||url.port==='443'));
  const server=createServer((req,res)=>{void (async()=>{
    let url:URL;try{url=new URL(req.url??'');}catch{denied++;res.writeHead(403).end();return;}
    if(!permitted(url)||!['GET','HEAD'].includes(req.method??'')||req.headers['transfer-encoding']||Number(req.headers['content-length']??0)!==0){denied++;res.writeHead(403).end();return;}
    allowed++;const controller=new AbortController();pending.add(controller);
    try{
      const headers:Record<string,string>={'user-agent':'MuCodeSandbox image builder','accept-encoding':'identity'};
      for(const name of ['range','if-range','if-modified-since','if-none-match'])if(typeof req.headers[name]==='string')headers[name]=req.headers[name] as string;
      const response=await fetcher(url,{method:req.method,headers,redirect:'manual',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(180000)])});
      if(Number(response.headers.get('content-length')??0)>256*1024*1024)throw Error('Oversized package response');
      const output:Record<string,string>={};for(const name of ['content-type','content-length','last-modified','etag','location','content-range','accept-ranges']){const value=response.headers.get(name);if(value)output[name]=value;}
      res.writeHead(response.status,output);
      if(!response.body){res.end();return;}
      let bytes=0;const body=Readable.fromWeb(response.body as never);body.on('data',block=>{bytes+=block.length;if(bytes>256*1024*1024){controller.abort();res.destroy();}});
      body.on('error',()=>res.destroy());res.once('close',()=>controller.abort());body.pipe(res);
      await new Promise<void>(resolve=>res.once('close',resolve));
    }catch{if(!res.headersSent)res.writeHead(502).end();else res.destroy();}finally{pending.delete(controller);}
  })();});
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  server.on('connect',(req,socket,head)=>{
    let url:URL;try{url=new URL('https://'+req.url);}catch{denied++;socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
    if(!permitted(url)||url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash){denied++;socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
    allowed++;const target=connect(443,url.hostname);sockets.add(target);target.once('close',()=>sockets.delete(target));
    target.setTimeout(180000,()=>target.destroy());target.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)target.write(head);socket.pipe(target);target.pipe(socket);});
    target.on('error',()=>socket.destroy());socket.on('error',()=>target.destroy());socket.on('close',()=>target.destroy());
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {port:(server.address() as AddressInfo).port,counters:()=>({allowed,denied}),close:async()=>{
    for(const operation of pending)operation.abort();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }};
}
