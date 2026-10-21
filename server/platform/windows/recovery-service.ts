import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import {z} from 'zod';
import {VERSION} from '../../../shared/version.ts';
import {createUISession} from '../../ui-session.ts';
import {AppError} from '../../errors.ts';
import type {HyperVBrokerClient} from './broker.ts';
import {acquireWindowsServiceLock} from './service-lock.ts';
import {recoveryCandidates} from './recovery-candidates.ts';
import {WindowsRecoveryWizard} from './recovery-wizard.ts';
import {windowsAppDirectory,windowsRuntimeDirectory} from './paths.ts';
import {protectedRecoveryInfo} from './recovery.ts';
export interface WindowsRecoveryServiceOptions {rootDir:string;dataDir?:string;runtimeRoot?:string;broker:HyperVBrokerClient;returnToNormal?:()=>void}
// There is no runtime/manager/terminal/browser in this service, and no generic
// broker forwarding endpoint. It owns the same workspace lock as normal mode.
export async function createWindowsRecoveryService(options:WindowsRecoveryServiceOptions){
 if(process.platform!=='win32')throw new AppError('恢复入口只能在 Windows 上运行',400,'WINDOWS_REQUIRED');
 const dataDir=windowsAppDirectory(options.dataDir),runtimeRoot=windowsRuntimeDirectory(options.runtimeRoot,dataDir),unlock=await acquireWindowsServiceLock(dataDir);
 const wizard=new WindowsRecoveryWizard(options.broker,async()=>{const info=await protectedRecoveryInfo(options.broker),loaded=await recoveryCandidates(dataDir,runtimeRoot);return {...loaded,candidates:loaded.candidates.map(value=>info.registeredIds.includes(value.id)?{...value,ready:false,issue:'原环境已登记，无需接管；可返回正常工作区。'}:value)};});
 let closing:Promise<void>|undefined;
 try{
  await wizard.refresh();const app=express();app.disable('x-powered-by');const server=createServer(app);
  const token=randomBytes(32).toString('base64url'),nonce=randomBytes(18).toString('base64');let port=0;
  const origins=()=>[`http://127.0.0.1:${port}`,`http://localhost:${port}`],allowedOrigin=(value?:string)=>!value||origins().includes(value);
  const ui=createUISession({allowedOrigin});
  app.use((req,res,next)=>{
   if(!req.headers.host||!origins().some(value=>new URL(value).host===req.headers.host)||!allowedOrigin(req.headers.origin)){res.status(403).json({error:'请求来源无效',code:'INVALID_ORIGIN'});return;}
   res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
   res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
   if(closing){res.status(503).json({error:'恢复服务正在退出',code:'CLOSING'});return;}next();
  });
  app.use(ui.middleware);
  app.use('/api',(req,res,next)=>{const supplied=Buffer.from(req.headers.authorization?.replace(/^Bearer /,'')??''),expected=Buffer.from(token);if(!ui.isAuthorized(req)||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.status(401).json({error:'本机会话无效，请重新进入恢复模式',code:'UNAUTHORIZED'});return;}next();});
  app.use(express.json({limit:'16kb'}));
  app.get('/api/windows/recovery',(_req,res)=>res.json(wizard.snapshot()));
  app.post('/api/windows/recovery/refresh',async(req,res)=>{z.object({}).strict().parse(req.body??{});res.json(await wizard.refresh());});
  app.post('/api/windows/recovery/review',(req,res)=>{const input=z.object({id:z.uuid()}).strict().parse(req.body);res.status(202).json(wizard.review(input.id));});
  app.post('/api/windows/recovery/adopt',(req,res)=>{const input=z.object({id:z.uuid(),plan:z.string().regex(/^[a-f0-9]{64}$/),confirmation:z.string().min(1).max(60)}).strict().parse(req.body);res.status(202).json(wizard.adopt(input.id,input.plan,input.confirmation));});
  app.post('/api/windows/recovery/cancel',(req,res)=>{z.object({}).strict().parse(req.body??{});res.json(wizard.cancel());});
  app.post('/api/windows/recovery/reopen',(req,res)=>{
   z.object({}).strict().parse(req.body??{});if(['reviewing','applying'].includes(wizard.snapshot().phase)||!options.returnToNormal)throw new AppError('请等待当前核验或恢复操作完成',409,'RECOVERY_BUSY');
   res.once('finish',()=>options.returnToNormal?.());res.json({ok:true});
  });
  app.use('/api',(_req,res)=>res.status(409).json({error:'恢复模式只提供原环境核验和登记恢复',code:'RECOVERY_MODE_ONLY'}));
  app.get('/favicon.ico',(_req,res)=>res.status(204).end());
  app.get('/',async(_req,res)=>{const html=await readFile(path.join(options.rootDir,'dist/index.html'),'utf8'),bootstrap=`<script nonce="${nonce}">window.__MU_CONFIG__=${JSON.stringify({token,version:VERSION,platform:'win32',windowsMode:'recovery',capabilities:{terminal:false,files:false,browser:false,remove:false}})};</script>`;res.type('html').send(html.replace('<!-- MU_BOOTSTRAP -->',bootstrap));});
  app.use(express.static(path.join(options.rootDir,'dist'),{index:false,dotfiles:'deny'}));
  app.use((_req,res)=>res.status(404).end());
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(error instanceof z.ZodError)res.status(400).json({error:'恢复请求格式无效',code:'VALIDATION_ERROR'});else if(error instanceof AppError)res.status(error.status).json({error:error.message,code:error.code});else if(error instanceof SyntaxError)res.status(400).json({error:'请求内容不是有效 JSON',code:'INVALID_JSON'});else if((error as {type?:string})?.type==='entity.too.large')res.status(413).json({error:'请求内容过大',code:'CONTENT_TOO_LARGE'});else res.status(500).json({error:'恢复服务未能完成请求，原盘和管理资料已保留',code:'RECOVERY_SERVICE_ERROR'});});
  server.on('upgrade',(_req,socket)=>socket.destroy());
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();if(!address||typeof address==='string')throw Error('Loopback recovery address unavailable');port=address.port;const url=`http://127.0.0.1:${port}`;
  const close=()=>closing??=(async()=>{const closed=new Promise<void>(resolve=>server.close(()=>resolve()));server.closeAllConnections();try{await wizard.close();await closed;}finally{await unlock();}})();
  return {server,wizard,url,launchUrl:()=>ui.launchUrl(url),close};
 }catch(error){try{await wizard.close();}finally{await unlock();}throw error;}
}
