import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import express from 'express';
import {z} from 'zod';
import {VERSION} from '../../../shared/version.ts';
import {createUISession} from '../../ui-session.ts';
import {AppError,errorMessage} from '../../errors.ts';
import {redact} from '../../validation.ts';
import {openWindowsStore,secureWindowsDirectory} from './credentials.ts';
import {acquireWindowsServiceLock} from './service-lock.ts';
import {HyperVRuntime} from './runtime.ts';
import {WindowsManager,type WindowsBackend,type WindowsBase,type WindowsManagerOptions} from './manager.ts';
import {WindowsHostMonitor} from './monitor.ts';

export interface WindowsServiceOptions {
 rootDir:string;dataDir?:string;runtimeRoot?:string;port?:number;base?:WindowsBase;
 runtime?:WindowsBackend&Pick<HyperVRuntime,'fingerprint'>;
 probe?:WindowsManagerOptions['probe'];
}

export async function createWindowsService(options:WindowsServiceOptions){
 if(process.platform!=='win32')throw new AppError('Windows 入口只能在 Windows 上运行',400,'WINDOWS_REQUIRED');
 const dataDir=path.resolve(options.dataDir??path.join(process.env.LOCALAPPDATA??homedir(),'MuCodeSandbox-WindowsPreview','app'));
 const runtimeRoot=path.resolve(options.runtimeRoot??path.join(dataDir,'hyperv'));
 await secureWindowsDirectory(dataDir);
 const unlock=await acquireWindowsServiceLock(dataDir);
 let manager:WindowsManager|undefined,monitor:WindowsHostMonitor|undefined;
 try{
  await secureWindowsDirectory(runtimeRoot);
  const runtime=options.runtime??new HyperVRuntime(runtimeRoot);
  let base=options.base;
  if(!base){
   try{base=z.object({image:z.string().refine(path.isAbsolute),imageSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(JSON.parse(await readFile(path.join(runtimeRoot,'protected-base.json'),'utf8')));}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  manager=new WindowsManager(await openWindowsStore(dataDir),runtime,{runtimeRoot,base,probe:options.probe});
  const controller=manager;
  await controller.recover();
  monitor=new WindowsHostMonitor(()=>runtime.fingerprint(),()=>{void controller.hostUnavailable('宿主网络发生变化、监测中断或电脑从休眠恢复').catch(()=>{});});
  await monitor.start();
  const watcher=monitor;
  const app=express();app.disable('x-powered-by');
  const server=createServer(app),token=randomBytes(32).toString('base64url'),nonce=randomBytes(18).toString('base64');
  let port=options.port??0,closing:Promise<void>|undefined;
  const origins=()=>[`http://127.0.0.1:${port}`,`http://localhost:${port}`];
  const allowedOrigin=(origin?:string)=>!origin||origins().includes(origin);
  const ui=createUISession({allowedOrigin});
  app.use((req,res,next)=>{
   if(!req.headers.host||!origins().some(origin=>new URL(origin).host===req.headers.host)||!allowedOrigin(req.headers.origin)){res.status(403).json({error:'请求来源无效',code:'INVALID_ORIGIN'});return;}
   res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
   res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
   if(closing){res.status(503).json({error:'服务正在退出',code:'CLOSING'});return;}next();
  });
  app.use(ui.middleware);
  app.use('/api',(req,res,next)=>{
   const supplied=Buffer.from(req.headers.authorization?.replace(/^Bearer /,'')??''),expected=Buffer.from(token);
   if(!ui.isAuthorized(req)||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.status(401).json({error:'本机会话无效，请重新打开 Windows 预览',code:'UNAUTHORIZED'});return;}next();
  });
  app.use(express.json({limit:'256kb'}));
  const id=(req:express.Request)=>z.uuid().parse(req.params.id);
  app.get('/api/snapshot',async(_req,res)=>{const snapshot=await controller.snapshot();res.json({...snapshot,system:{...snapshot.system,application:{channel:'source-preview',buildId:'working-tree',builtAt:null}}});});
  app.post('/api/environments',async(req,res)=>res.status(201).json(await controller.create(req.body)));
  app.put('/api/environments/:id',async(req,res)=>res.json(await controller.update(id(req),req.body)));
  app.post('/api/environments/:id/actions/:action',async(req,res)=>res.status(202).json(await controller.action(id(req),z.enum(['start','stop','restart']).parse(req.params.action))));
  app.get('/api/environments/:id/network/protection',async(req,res)=>res.json(await controller.protection(id(req))));
  app.get('/api/logs',(req,res)=>res.json(controller.store.logs(req.query.environmentId?z.uuid().parse(req.query.environmentId):null,z.coerce.number().int().min(0).parse(req.query.after??0))));
  app.post('/api/jobs/:id/cancel',(req,res)=>{controller.cancel(id(req));res.json({ok:true});});
  app.use('/api',(_req,res)=>res.status(409).json({error:'此功能尚未完成 Windows 适配',code:'FEATURE_UNAVAILABLE'}));
  app.get('/favicon.ico',(_req,res)=>res.status(204).end());
  const bootstrap=`<script nonce="${nonce}">window.__MU_CONFIG__=${JSON.stringify({token,version:VERSION,platform:'win32'})};</script>`;
  app.get('/',async(_req,res)=>{
   let html:string;try{html=await readFile(path.join(options.rootDir,'dist/index.html'),'utf8');}catch{throw new AppError('请先构建界面：npm run build',503,'UI_MISSING');}
   res.type('html').send(html.replace('<!-- MU_BOOTSTRAP -->',bootstrap));
  });
  app.use(express.static(path.join(options.rootDir,'dist'),{index:false,dotfiles:'deny'}));
  app.use((_req,res)=>res.status(404).type('text').send('Not found'));
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
   if(error instanceof z.ZodError)res.status(400).json({error:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；'),code:'VALIDATION_ERROR'});
   else if(error instanceof AppError)res.status(error.status).json({error:redact(error.message),code:error.code});
   else if(error&&typeof error==='object'&&'type' in error&&error.type==='entity.too.large')res.status(413).json({error:'请求内容过大',code:'CONTENT_TOO_LARGE'});
   else if(error instanceof SyntaxError)res.status(400).json({error:'请求内容不是有效 JSON',code:'INVALID_JSON'});
   else res.status(500).json({error:redact(errorMessage(error)),code:'INTERNAL_ERROR'});
  });
  server.on('upgrade',(_req,socket)=>socket.destroy());
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const address=server.address();if(typeof address==='object'&&address)port=address.port;
  const url=`http://127.0.0.1:${port}`;
  const close=()=>closing??=(async()=>{
   watcher.stop();const closed=new Promise<void>(resolve=>server.close(()=>resolve()));server.closeAllConnections();
   try{await controller.close();}finally{await closed;await unlock();}
  })();
  return {app,server,manager:controller,url,port,launchUrl:(pathname='/')=>ui.launchUrl(url,pathname),close};
 }catch(error){monitor?.stop();try{await manager?.close();}finally{await unlock();}throw error;}
}
