import { createServer } from 'node:http';
import { createSocket, type RemoteInfo } from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import dns from 'dns2';
import stun from 'stun';
import { z } from 'zod';
import { FEATURES_JS, PROBE_JS, PROBE_HTML } from './probe-assets.ts';
import { createMockMessages } from './mock-messages.ts';

export async function createAcceptanceLab() {
  const receipts: { id: string; result: unknown }[] = [];
  const events: { kind: string; address: string; name?: string; port?: number; at: string }[] = [];
  const sessions = new Map<string, string>();
  let modelCalls = 0;
  const messages = createMockMessages();
  const record = (event: Omit<(typeof events)[number], 'at'>) => { events.push({ ...event, at: new Date().toISOString() }); if (events.length > 1000) events.shift(); };
  const dnsServer = dns.createUDPServer((request, send, info) => {
    const peer = info as RemoteInfo;
    const response = dns.Packet.createResponseFromRequest(request);
    for (const question of request.questions) {
      record({ kind: 'dns', address: peer.address, name: question.name, port: peer.port });
      if (question.name.endsWith('.test') && question.type === dns.Packet.TYPE.A) response.answers.push(new dns.Packet.Resource({ name: question.name, type: dns.Packet.TYPE.A, class: dns.Packet.CLASS.IN, ttl: 0, address: '198.51.100.99' }));
    }
    send(response);
  });
  dnsServer.on('error', () => {});
  const socket = createSocket('udp4');
  const stunServer = stun.createServer({ type: 'udp4', socket });
  stunServer.on('error', () => {});
  stunServer.on('bindingRequest', (request, info) => {
    record({ kind: 'stun', address: info.address, port: info.port });
    const response = stun.createMessage(Number(stun.constants.STUN_BINDING_RESPONSE), request.transactionId);
    response.addXorAddress(info.address, info.port);
    response.addSoftware('MuCodeSandbox controlled lab');
    stunServer.send(response, info.port, info.address);
  });
  const app = express(); const server = createServer(app);
  let port = 0;
  const extraOrigins = new Set<string>();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, ...extraOrigins];
    if (!hosts.includes(req.headers.host ?? '') || (req.headers.origin && !hosts.map(h => `http://${h}`).includes(req.headers.origin))) { res.status(403).json({ error: 'Lab origin rejected' }); return; }
    res.setHeader('Cache-Control', 'no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; worker-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'");
    record({ kind: 'http', address: req.socket.remoteAddress ?? '' }); next();
  });
  app.use(express.json({ limit: '96kb' }));
  app.get('/', (_req,res)=>res.type('html').send(PROBE_HTML));
  app.get('/features.js', (_req,res)=>res.type('js').send(FEATURES_JS));
  app.get('/probe.js', (_req,res)=>res.type('js').send(PROBE_JS));
  app.get('/worker.js', (_req,res)=>res.type('js').send("import {measure} from '/features.js';measure().then(result=>postMessage(result));"));
  app.get('/frame', (_req,res)=>res.type('html').send('<!doctype html><script type="module" src="/frame.js"></script>'));
  app.get('/frame.js', (_req,res)=>res.type('js').send("import {measure} from '/features.js';measure().then(result=>parent.postMessage(result,location.origin));"));
  app.get('/api/echo',(req,res)=>res.json({ address:req.socket.remoteAddress, userAgent:req.headers['user-agent']??'', acceptLanguage:req.headers['accept-language']??'', clientHints:{platform:req.headers['sec-ch-ua-platform']??'',brands:req.headers['sec-ch-ua']??''} }));
  const session = (cookie='') => cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('mu-lab='))?.slice(7)??'';
  app.post('/api/login',(req,res)=>{
    const {account}=z.object({account:z.enum(['synthetic-a','synthetic-b'])}).strict().parse(req.body);
    const id=randomUUID(); if(sessions.size>=1000)sessions.clear();sessions.set(id,account);
    res.setHeader('Set-Cookie',`mu-lab=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);res.json({account});
  });
  app.get('/api/session',(req,res)=>res.json({account:sessions.get(session(req.headers.cookie))??null}));
  app.post('/api/receipts',(req,res)=>{const result=z.record(z.string(),z.unknown()).parse(req.body);const item={id:randomUUID(),result};receipts.push(item);if(receipts.length>100)receipts.shift();res.status(201).json({id:item.id});});
  app.post('/v1/chat/completions',(req,res)=>{
    const {stream}=z.object({stream:z.boolean().default(false),messages:z.array(z.object({role:z.string(),content:z.string()})).max(20).default([])}).passthrough().parse(req.body);
    modelCalls++;
    const call={id:'mu-synthetic-tool',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'result.txt',content:'MU_MOCK_TASK_OK\n'})}};
    const completion={id:`mock-${randomUUID()}`,object:'chat.completion',model:'mu-mock',choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[call]},finish_reason:'tool_calls'}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}};
    if(!stream){res.json(completion);return;}
    res.type('text/event-stream');res.setHeader('X-Mu-Mock','true');
    res.write(`data: ${JSON.stringify({id:completion.id,object:'chat.completion.chunk',model:'mu-mock',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,...call}]},finish_reason:null}]})}\n\n`);
    res.write(`data: ${JSON.stringify({id:completion.id,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  app.post('/v1/messages', messages.handle);
  app.post('/v1/messages/count_tokens', messages.countTokens);
  app.get('/api/status',(_req,res)=>res.json(info()));
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(400).json({error:error instanceof z.ZodError?'Invalid synthetic input':'Invalid lab request'}));
  const info = () => ({running:true,url:`http://127.0.0.1:${port}`,dnsPort:dnsServer.address().port,stunPort:socket.address().port,receiptCount:receipts.length,eventCount:events.length,modelCalls:modelCalls+messages.receipts.length,scope:'loopback-only'});
  try {
    dnsServer.listen(0,'127.0.0.1');await once(dnsServer,'listening');
    stunServer.listen(0,'127.0.0.1',()=>{});await once(stunServer,'listening');
    server.listen(0,'127.0.0.1');await once(server,'listening');port=(server.address() as {port:number}).port;
  } catch(error) {try{dnsServer.close()}catch{};try{stunServer.close();socket.close()}catch{};server.close();throw error;}
  let closing:Promise<void>|null=null;
  const close=()=>closing??=(async()=>{messages.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>dnsServer.close(()=>resolve()));stunServer.close();await new Promise<void>(resolve=>socket.close(()=>resolve()));sessions.clear();receipts.length=0;events.length=0;})();
  const allowLoopbackPort = (value:number) => {
    if(!Number.isInteger(value)||value<1||value>65535)throw new Error('Invalid guest loopback port');
    extraOrigins.add(`127.0.0.1:${value}`);
  };
  return {info,receipts,events,messages:messages.receipts,close,allowLoopbackPort};
}
