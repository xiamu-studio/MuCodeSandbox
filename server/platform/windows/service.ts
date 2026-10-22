import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import {z} from 'zod';
import {VERSION} from './release.ts';
import {createUISession} from '../../ui-session.ts';
import {AppError,errorMessage} from '../../errors.ts';
import {redact} from '../../validation.ts';
import {openWindowsStore,secureWindowsDirectory} from './credentials.ts';
import {acquireWindowsServiceLock} from './service-lock.ts';
import {HyperVRuntime} from './runtime.ts';
import {WindowsManager,type WindowsBackend,type WindowsBase,type WindowsManagerOptions} from './manager.ts';
import {WindowsHostMonitor} from './monitor.ts';
import {WindowsTerminalServer,type PtyFactory} from './terminal.ts';
import {GuestExchange,transferZone,transferName,transferPath,transferRevision} from '../../guest-exchange.ts';
import {TRANSFER_MAX_BYTES} from '../../../shared/guest-exchange.ts';
import {IMAGE_CLIPBOARD_MAX_BYTES} from '../../../shared/clipboard-image.ts';
import {WindowsBrowser} from './browser.ts';
import {displayRequestSchema} from '../../../shared/guest-display.ts';
import {clipboardText,inlineTranslationText} from '../../guest-exchange.ts';
import {WindowsTranslationSettings} from './translation-settings.ts';
import {translationApiKey} from '../../translation-settings.ts';
import {translationDirection} from '../../deepseek-translation.ts';
import {windowsAppDirectory,windowsRuntimeDirectory} from './paths.ts';
import {windowsBaseSchema} from './config.ts';
import {WindowsSetup} from './setup.ts';
import {WindowsHostComponents,hostReady} from './host-components.ts';
import {WindowsStorage} from './storage.ts';
import {WindowsGuestAudio} from './audio.ts';

export interface WindowsServiceOptions {
 rootDir:string;dataDir?:string;runtimeRoot?:string;port?:number;base?:WindowsBase;
 runtime?:WindowsBackend&Pick<HyperVRuntime,'fingerprint'>&Partial<Pick<HyperVRuntime,'terminalLaunch'|'guest'|'management'|'serviceStreamFactory'|'audioLaunch'>>;
 probe?:WindowsManagerOptions['probe'];
 ptyFactory?:PtyFactory;
}

export async function createWindowsService(options:WindowsServiceOptions){
 if(process.platform!=='win32')throw new AppError('Windows 入口只能在 Windows 上运行',400,'WINDOWS_REQUIRED');
 const dataDir=windowsAppDirectory(options.dataDir);
 const runtimeRoot=windowsRuntimeDirectory(options.runtimeRoot,dataDir);
 await secureWindowsDirectory(dataDir);
 const unlock=await acquireWindowsServiceLock(dataDir);
 let manager:WindowsManager|undefined,monitor:WindowsHostMonitor|undefined,terminal:WindowsTerminalServer|undefined,browser:WindowsBrowser|undefined,setup:WindowsSetup|undefined,host:WindowsHostComponents|undefined,storage:WindowsStorage|undefined,guestAudio:WindowsGuestAudio|undefined;
 try{
  await secureWindowsDirectory(runtimeRoot);
  const runtime=options.runtime??new HyperVRuntime(runtimeRoot);
  let base=options.base;
  if(!base){
   try{let source:string;try{source=await readFile(path.join(runtimeRoot,'protected-desktop-base.json'),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;source=await readFile(path.join(runtimeRoot,'protected-base.json'),'utf8');}base=windowsBaseSchema.parse(JSON.parse(source));}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  manager=new WindowsManager(await openWindowsStore(dataDir),runtime,{runtimeRoot,base,probe:options.probe});
  const controller=manager;
  const translationSettings=new WindowsTranslationSettings(controller.store);
  if(runtime instanceof HyperVRuntime&&runtime.broker){host=new WindowsHostComponents(runtime.broker,()=>!controller.tasks.size&&controller.store.list().every(e=>!['running','starting','creating','stopping'].includes(e.state))&&!setup?.running);await host.refresh();setup=new WindowsSetup(runtime,runtimeRoot,{base,canPrepare:()=>!!host&&hostReady(host.snapshot())&&!controller.options.base&&!controller.tasks.size&&controller.store.list().every(e=>e.state==='not_created'),publish:value=>{controller.options.base=value;controller.profiles.clear();}});await setup.initialize();}
  if(runtime instanceof HyperVRuntime&&runtime.broker)storage=new WindowsStorage(runtime.broker,()=>controller.options.base?.imageSha256??null,()=>!!host&&hostReady(host.snapshot())&&!controller.tasks.size&&!setup?.running);
  terminal=runtime.terminalLaunch?new WindowsTerminalServer(controller,{terminalLaunch:runtime.terminalLaunch.bind(runtime)},options.ptyFactory):undefined;
  const terminals=terminal,transfers=new Map<string,Set<AbortController>>(),readers=new Map<string,()=>void>(),imageTransfers=new Map<string,AbortController>(),translationTransfers=new Map<string,{abort:AbortController;sessionId:string}>();
  const guest=runtime.guest?.bind(runtime),management=runtime.management?.bind(runtime);
  if(runtime.serviceStreamFactory&&management){browser=new WindowsBrowser(controller,{management,serviceStreamFactory:runtime.serviceStreamFactory.bind(runtime)});controller.browserRunning=id=>browser!.running(id);controller.browserAvailable=true;controller.inspectAdditionalProtection=id=>browser!.assertProtection(id);}
  const guestBrowser=browser;
  if(guestBrowser&&runtime.audioLaunch){guestAudio=new WindowsGuestAudio(controller,guestBrowser,{audioLaunch:runtime.audioLaunch.bind(runtime)});guestBrowser.revokeAudio=id=>guestAudio!.revoke(id);}
  const exchange=guest&&management?new GuestExchange({guest:async(e,command,runOptions={})=>{
   if([...transfers.values()].reduce((n,set)=>n+set.size,0)>=2)throw new AppError('同时传输数量已达到上限',429,'TRANSFER_LIMIT');
   const abort=new AbortController(),set=transfers.get(e.id)??new Set<AbortController>();set.add(abort);transfers.set(e.id,set);
   const translation=translationTransfers.get(e.id),signals=[abort.signal,runOptions.signal,translation?.abort.signal].filter((signal):signal is AbortSignal=>!!signal);
   try{const profile=await controller.profile(e);if(translation&&controller.sessions.get(e.id)?.id!==translation.sessionId)throw new AppError('环境已变化，请重新翻译。',409,'CONFIGURATION_CHANGED');const signal=AbortSignal.any(signals);signal.throwIfAborted();return await guest(profile,command,{...runOptions,signal});}
   finally{set.delete(abort);if(!set.size&&transfers.get(e.id)===set)transfers.delete(e.id);}
  },management:async(e,command,runOptions={})=>{
   await controller.assertAccess(e.id);
   if([...transfers.values()].reduce((n,set)=>n+set.size,0)>=2)throw new AppError('同时传输数量已达到上限',429,'TRANSFER_LIMIT');
   const abort=new AbortController(),set=transfers.get(e.id)??new Set<AbortController>();set.add(abort);transfers.set(e.id,set);
   const signals=[abort.signal,runOptions.signal,imageTransfers.get(e.id)?.signal].filter((signal):signal is AbortSignal=>!!signal);
   try{return await management(await controller.profile(e),command,{...runOptions,signal:AbortSignal.any(signals)});}
   finally{set.delete(abort);if(!set.size&&transfers.get(e.id)===set)transfers.delete(e.id);}
  }},id=>controller.assertAccess(id),translationSettings):undefined;
  controller.onAccessRevoked=id=>{terminals?.closeEnvironment(id);guestBrowser?.revoke(id);translationTransfers.get(id)?.abort.abort();for(const abort of transfers.get(id)??[])abort.abort();readers.get(id)?.();};
  if(!host||host.snapshot().runtimeActive)await controller.recover();
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
   res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
   if(closing){res.status(503).json({error:'服务正在退出',code:'CLOSING'});return;}next();
  });
  app.use(ui.middleware);
  app.use('/api',(req,res,next)=>{
   const supplied=Buffer.from(req.headers.authorization?.replace(/^Bearer /,'')??''),expected=Buffer.from(token);
   if(!ui.isAuthorized(req)||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.status(401).json({error:'本机会话无效，请重新打开 Windows 预览',code:'UNAUTHORIZED'});return;}next();
  });
  app.use(express.json({limit:'256kb'}));
  const id=(req:express.Request)=>z.uuid().parse(req.params.id);
  app.get('/api/snapshot',async(_req,res)=>{const snapshot=await controller.snapshot();if(host&&!hostReady(host.snapshot())){snapshot.system.runtime.available=false;snapshot.system.runtime.error='请完成 Windows 系统组件准备，按提示重启或重新打开软件';}res.json({...snapshot,system:{...snapshot.system,application:{channel:'source-preview',buildId:'working-tree',builtAt:null}}});});
  app.post('/api/environments',async(req,res)=>res.status(201).json(await controller.create(req.body)));
  app.put('/api/environments/:id',async(req,res)=>res.json(await controller.update(id(req),req.body)));
  app.post('/api/environments/:id/actions/delete',async(req,res)=>{const input=z.object({confirmation:z.string().min(1).max(60)}).strict().parse(req.body);res.status(202).json(await controller.remove(id(req),input.confirmation));});
  app.post('/api/environments/:id/actions/:action',async(req,res)=>{const action=z.enum(['start','stop','restart']).parse(req.params.action);if(action!=='stop'&&host&&!hostReady(await host.refresh()))throw new AppError('系统组件尚未就绪，请按系统准备提示处理',409,'HOST_REQUIREMENTS');res.status(202).json(await controller.action(id(req),action));});
  app.get('/api/environments/:id/network/protection',async(req,res)=>res.json(await controller.protection(id(req))));
  app.get('/api/environments/:id/disk-growth',async(req,res)=>{const abort=new AbortController(),cancel=()=>{if(!res.writableFinished)abort.abort();};res.once('close',cancel);try{res.json(await controller.diskGrowthInfo(id(req),{signal:abort.signal}));}finally{res.removeListener('close',cancel);}});
  app.post('/api/environments/:id/disk-growth',async(req,res)=>{const input=z.object({targetGiB:z.number().int().min(16).max(256),confirmation:z.string().min(1).max(60)}).strict().parse(req.body);res.status(202).json(await controller.growDisk(id(req),input.targetGiB,input.confirmation));});
  app.get('/api/logs',(req,res)=>res.json(controller.store.logs(req.query.environmentId?z.uuid().parse(req.query.environmentId):null,z.coerce.number().int().min(0).parse(req.query.after??0))));
  app.post('/api/jobs/:id/cancel',(req,res)=>{controller.cancel(id(req));res.json({ok:true});});
  const setupHost=()=>{if(!setup)throw new AppError('此入口不支持自动准备，请使用普通用户桌面入口',409,'SETUP_UNAVAILABLE');return setup;};
  app.get('/api/windows/setup',(_req,res)=>res.json(setupHost().snapshot()));
  app.post('/api/windows/setup',(req,res)=>{z.object({}).strict().parse(req.body??{});res.status(202).json(setupHost().start());});
  app.post('/api/windows/setup/cancel',(req,res)=>{z.object({}).strict().parse(req.body??{});res.json(setupHost().cancel());});
  const hostComponents=()=>{if(!host)throw new AppError('此入口不提供系统组件准备，请使用 Windows 桌面',409,'HOST_SETUP_UNAVAILABLE');return host;};
  app.get('/api/windows/host',async(_req,res)=>res.json(await hostComponents().refresh()));
  app.post('/api/windows/host',async(req,res)=>{z.object({}).strict().parse(req.body??{});res.status(202).json(await hostComponents().prepare());});
  const storageHost=()=>{if(!storage)throw new AppError('此入口不提供受保护缓存管理，请使用 Windows 桌面',409,'STORAGE_UNAVAILABLE');return storage;};
  app.get('/api/windows/storage',async(_req,res)=>res.json(await storageHost().inspect()));
  app.get('/api/windows/resources',async(_req,res)=>{if(!(runtime instanceof HyperVRuntime)||!runtime.broker)throw new AppError('此入口不提供受保护资源核验',409,'RESOURCE_UNAVAILABLE');res.json(await runtime.resources());});
  app.get('/api/windows/power',async(_req,res)=>{if(!(runtime instanceof HyperVRuntime)||!runtime.broker)throw new AppError('此入口不提供原生电源核验',409,'POWER_UNAVAILABLE');res.json(await runtime.power());});
  app.post('/api/windows/storage/prune',async(req,res)=>{const input=z.object({plan:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);res.json(await storageHost().prune(input.plan));});
  const browserHost=()=>{if(!guestBrowser)throw new AppError('Windows 浏览器运行组件不可用',409,'FEATURE_UNAVAILABLE');return guestBrowser;};
  app.get('/api/environments/:id/guest-browser',(req,res)=>res.json(browserHost().info(id(req))));
  app.post('/api/environments/:id/browser/open',async(req,res)=>{z.object({}).strict().parse(req.body??{});const envId=id(req),host=browserHost();res.status(202).json(await controller.submit(envId,'open-browser',options=>host.open(envId,options)));});
  app.post('/api/environments/:id/browser/close',async(req,res)=>{const envId=id(req),host=browserHost();res.status(202).json(await controller.submit(envId,'close-browser',()=>host.close(envId)));});
  app.post('/api/environments/:id/browser/navigate',async(req,res)=>{const input=z.object({url:z.url().max(2048)}).strict().parse(req.body);const envId=id(req);res.status(202).json(await controller.submit(envId,'browser-navigate',()=>browserHost().navigate(envId,input.url)));});
  app.get('/api/environments/:id/browser/inspect',async(req,res)=>{const envId=id(req);await controller.assertAccess(envId);res.json(await browserHost().inspect(envId));});
  app.post('/api/environments/:id/guest-browser-ticket',async(req,res)=>{const envId=id(req);await controller.assertAccess(envId);res.json(browserHost().issue(envId));});
  app.post('/api/environments/:id/guest-audio-ticket',async(req,res)=>{z.object({}).strict().parse(req.body??{});if(!guestAudio)throw new AppError('此入口的音频组件尚未就绪',409,'FEATURE_UNAVAILABLE');res.json(await guestAudio.issue(id(req)));});
  app.post('/api/environments/:id/guest-browser/display',async(req,res)=>{const envId=id(req),input=displayRequestSchema.parse(req.body);await controller.assertAccess(envId);res.json(await browserHost().resize(envId,input));});
  app.post('/api/environments/:id/terminal-ticket',async(req,res)=>{
   const input=z.object({command:z.literal('shell').default('shell'),cols:z.number().int().min(20).max(300).default(100),rows:z.number().int().min(5).max(100).default(28)}).strict().parse(req.body??{});
   if(!terminals)throw new AppError('Windows 终端组件不可用',409,'FEATURE_UNAVAILABLE');const envId=id(req);await controller.assertAccess(envId);res.json({ticket:terminals.issue(envId,input.cols,input.rows)});
  });
  const files=()=>{if(!exchange)throw new AppError('Windows 文件传输组件不可用',409,'FEATURE_UNAVAILABLE');return exchange;};
  const cancelTranslations=()=>{for(const request of translationTransfers.values())request.abort.abort();};
  app.get('/api/translation-settings',(_req,res)=>res.json(translationSettings.status()));
  app.post('/api/translation-settings',(req,res)=>{const input=z.object({apiKey:translationApiKey}).strict().parse(req.body);const status=translationSettings.save(input.apiKey);cancelTranslations();res.json(status);});
  app.delete('/api/translation-settings',(req,res)=>{z.object({}).strict().parse(req.body??{});const status=translationSettings.clear();cancelTranslations();res.json(status);});
  app.post('/api/environments/:id/translate-text',async(req,res)=>{
   const envId=id(req),input=z.object({text:inlineTranslationText,direction:translationDirection.optional()}).strict().parse(req.body);files();
   if(translationTransfers.has(envId))throw new AppError('当前翻译尚未结束，请稍后重试。',409,'TRANSLATION_BUSY');
   await controller.assertAccess(envId);const context={abort:new AbortController(),sessionId:controller.sessions.get(envId)!.id};
   if(translationTransfers.has(envId))throw new AppError('当前翻译尚未结束，请稍后重试。',409,'TRANSLATION_BUSY');
   translationTransfers.set(envId,context);const cancel=()=>{if(!res.writableFinished)context.abort.abort();};res.once('close',cancel);
   try{if(res.destroyed)context.abort.abort();context.abort.signal.throwIfAborted();const result=await files().translate(envId,input.text,input.direction);context.abort.signal.throwIfAborted();if(controller.sessions.get(envId)?.id!==context.sessionId)throw new AppError('环境已变化，译文不再交付。原文已保留。',409,'CONFIGURATION_CHANGED');res.json(result);}
   finally{res.removeListener('close',cancel);if(translationTransfers.get(envId)===context)translationTransfers.delete(envId);}
  });
  app.get('/api/environments/:id/transfer-files',async(req,res)=>{
   const envId=id(req);if(req.query.directory==='1')res.json(await files().listDirectory(envId,transferZone.parse(req.query.zone),transferPath.parse(req.query.path??''),z.string().optional().parse(req.query.cursor)));
   else res.json(await files().listPage(envId,z.string().optional().parse(req.query.cursor)));
  });
  app.post('/api/environments/:id/transfer-files',async(req,res,next)=>{
   const envId=id(req);transferName.parse(req.query.name);files();
   if(Number(req.headers['content-length']??0)>TRANSFER_MAX_BYTES)throw new AppError('单个文件最多150 MiB',413,'CONTENT_TOO_LARGE');
   if(readers.has(envId)||exchange!.busy.has(envId)||readers.size>=2)throw new AppError('当前传输正在进行，请稍后重试',409,'TRANSFER_BUSY');
   const stop=()=>res.destroy(),release=()=>{clearTimeout(deadline);if(readers.get(envId)===stop)readers.delete(envId);};
   const deadline=setTimeout(stop,180000);deadline.unref();readers.set(envId,stop);res.once('finish',release);res.once('close',release);
   try{await controller.assertAccess(envId);res.locals.uploadSession=controller.sessions.get(envId)?.id;next();}catch(error){release();next(error);}
  },express.raw({type:'application/octet-stream',limit:TRANSFER_MAX_BYTES}),async(req,res)=>{
   const envId=id(req),name=transferName.parse(req.query.name);if(!Buffer.isBuffer(req.body))throw new AppError('请选择一个文件',400,'FILE_REQUIRED');
   if(controller.sessions.get(envId)?.id!==res.locals.uploadSession)throw new AppError('环境已变化，请重新传入文件',409,'CONFIGURATION_CHANGED');
   const abort=new AbortController(),cancel=()=>{if(!res.writableFinished)abort.abort();};res.once('close',cancel);
   try{res.json(await files().upload(envId,name,req.body,abort.signal));}finally{res.removeListener('close',cancel);}
  });
  app.post('/api/environments/:id/transfer-download',async(req,res)=>{
   const input=z.object({zone:transferZone,name:transferName,path:transferPath.optional(),revision:transferRevision.optional()}).strict().parse(req.body);
   const bytes=await files().download(id(req),input.zone,input.name,input.path,input.revision);
   res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(input.name)}`);res.type('application/octet-stream').send(bytes);
  });
  app.post('/api/environments/:id/clipboard/write',async(req,res)=>{const input=z.object({text:clipboardText}).strict().parse(req.body);res.json(await files().writeClipboard(id(req),input.text));});
  app.post('/api/environments/:id/clipboard/read',async(req,res)=>{z.object({}).strict().parse(req.body??{});res.json(await files().readClipboard(id(req)));});
  app.post('/api/environments/:id/clipboard/image',async(req,res,next)=>{
   const envId=id(req);files();
   if(Number(req.headers['content-length']??0)>IMAGE_CLIPBOARD_MAX_BYTES)throw new AppError('图片超过10 MiB，请缩小后再复制。',413,'CLIPBOARD_IMAGE_TOO_LARGE');
   if(readers.has(envId)||exchange!.busy.has(envId)||readers.size>=2)throw new AppError('当前传输正在进行，请稍后重试',409,'TRANSFER_BUSY');
   const stop=()=>res.destroy(),release=()=>{clearTimeout(deadline);if(readers.get(envId)===stop)readers.delete(envId);};
   const deadline=setTimeout(stop,90000);deadline.unref();readers.set(envId,stop);res.once('finish',release);res.once('close',release);
   try{await controller.assertAccess(envId);res.locals.imageSession=controller.sessions.get(envId)?.id;next();}catch(error){release();next(error);}
  },express.raw({type:'image/png',limit:IMAGE_CLIPBOARD_MAX_BYTES}),async(req,res)=>{
   const envId=id(req);if(!Buffer.isBuffer(req.body))throw new AppError('请选择 PNG 图片',400,'INVALID_CLIPBOARD_IMAGE');
   if(controller.sessions.get(envId)?.id!==res.locals.imageSession)throw new AppError('环境已变化，请重新传入图片',409,'CONFIGURATION_CHANGED');
   const abort=new AbortController(),cancel=()=>{if(!res.writableFinished)abort.abort();};res.once('close',cancel);imageTransfers.set(envId,abort);
   try{const result=await files().writeClipboardImage(envId,req.body);abort.signal.throwIfAborted();if(controller.sessions.get(envId)?.id!==res.locals.imageSession)throw new AppError('环境已变化，图片结果不再交付',409,'CONFIGURATION_CHANGED');res.json(result);}
   finally{res.removeListener('close',cancel);if(imageTransfers.get(envId)===abort)imageTransfers.delete(envId);}
  });
  app.use('/api',(_req,res)=>res.status(409).json({error:'此功能尚未完成 Windows 适配',code:'FEATURE_UNAVAILABLE'}));
  app.get('/favicon.ico',(_req,res)=>res.status(204).end());
  const bootstrap=`<script nonce="${nonce}">window.__MU_CONFIG__=${JSON.stringify({token,version:VERSION,platform:'win32',capabilities:{terminal:!!terminals,files:!!exchange,browser:!!guestBrowser,audio:!!guestAudio,imageClipboard:!!exchange&&!!guestBrowser,translation:!!exchange,diskGrowth:!!runtime.diskGrowthAvailable,remove:!!runtime.deletionAvailable,setup:!!setup,hostSetup:!!host,storage:!!storage}})};</script>`;
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
  server.on('upgrade',(req,socket,head)=>{
   if(closing){socket.destroy();return;}const authorize=(request:import('node:http').IncomingMessage)=>!!request.headers.host&&origins().some(origin=>new URL(origin).host===request.headers.host)&&!!request.headers.origin&&allowedOrigin(request.headers.origin)&&ui.isAuthorized(request as express.Request);
   if(new URL(req.url??'/','http://127.0.0.1').pathname==='/guest-browser'&&guestBrowser){void guestBrowser.upgrade(req,socket,head,authorize).catch(()=>socket.destroy());return;}
   if(new URL(req.url??'/','http://127.0.0.1').pathname==='/guest-audio'&&guestAudio){void guestAudio.host.upgrade(req,socket,head,request=>{const query=new URL(request.url!,'http://127.0.0.1').searchParams;return authorize(request)&&query.size===1&&query.getAll('ticket').length===1&&/^[a-f0-9]{48}$/.test(query.get('ticket')??'');}).catch(()=>socket.destroy());return;}
   if(!terminals){socket.destroy();return;}void terminals.upgrade(req,socket,head,authorize).catch(()=>socket.destroy());
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const address=server.address();if(typeof address==='object'&&address)port=address.port;
  const url=`http://127.0.0.1:${port}`;
  const close=()=>closing??=(async()=>{
   watcher.stop();terminals?.close();guestBrowser?.dispose();cancelTranslations();for(const stop of readers.values())stop();for(const set of transfers.values())for(const abort of set)abort.abort();const closed=new Promise<void>(resolve=>server.close(()=>resolve()));server.closeAllConnections();
   try{await guestAudio?.dispose();await setup?.close();await controller.close();}finally{await closed;await unlock();}
  })();
  return {app,server,manager:controller,terminal:terminals,browser:guestBrowser,guestAudio,exchange,setup,host,url,port,launchUrl:(pathname='/')=>ui.launchUrl(url,pathname),close};
 }catch(error){monitor?.stop();terminal?.close();browser?.dispose();try{await guestAudio?.dispose();await setup?.close();await manager?.close();}finally{await unlock();}throw error;}
}
