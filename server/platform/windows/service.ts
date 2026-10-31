import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import {z} from 'zod';
import {VERSION} from './release.ts';
import {windowsApplication} from './application.ts';
import {createUISession} from '../../ui-session.ts';
import {AppError,errorMessage} from '../../errors.ts';
import {redact} from '../../validation.ts';
import {openWindowsStore,secureWindowsDirectory} from './credentials.ts';
import {acquireWindowsServiceLock} from './service-lock.ts';
import {HyperVRuntime} from './runtime.ts';
import {initializeWindowsPrerequisites} from './startup-checks.ts';
import {WindowsManager,type WindowsBackend,type WindowsBase,type WindowsManagerOptions} from './manager.ts';
import {WindowsHostMonitor,windowsHostMonitorIssue} from './monitor.ts';
import {WindowsTerminalServer,type PtyFactory} from './terminal.ts';
import {GuestExchange,transferZone,transferName,transferPath,transferRevision} from '../../guest-exchange.ts';
import {TRANSFER_MAX_BYTES} from '../../../shared/guest-exchange.ts';
import {IMAGE_CLIPBOARD_MAX_BYTES} from '../../../shared/clipboard-image.ts';
import {readWindowsGuestClipboardImage} from './clipboard-image-read.ts';
import {WindowsBrowser} from './browser.ts';
import {WindowsBrowserComponentRecovery,loadWindowsBrowserRepairArchive,type WindowsBrowserRepairArchive} from './browser-repair-service.ts';
import {WindowsLocalChecks} from './local-checks.ts';
import {WindowsHostLab} from './host-lab.ts';
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
import {WindowsCacheSchedule} from './cache-schedule.ts';
import {WindowsDiskCompactionSchedule} from './disk-compaction-schedule.ts';
import {WindowsGuestAudio,windowsDisplayAudioSource} from './audio.ts';
import {WindowsDisplayLifecycle,type WindowsDisplayDriver} from './display-lifecycle.ts';
import {createWindowsDisplayDriver} from './display-guest.ts';
import {WindowsFileDisplay,createWindowsFileDisplayDriver,windowsFileViewClose} from './file-display.ts';
import type {Environment} from '../../../shared/types.ts';
import type {WindowsNetworkSession} from './session.ts';
import {WindowsFileDirectories} from './file-directories.ts';
import {WindowsBackupService,backupPassword,backupFilePath} from './backup-service.ts';
import {WindowsOverviewReadings} from './overview-readings.ts';
import {latencyInput} from '../../latency.ts';
import {WindowsSnapshotCoordinator} from './snapshot-coordinator.ts';
import {WindowsSnapshotProduct,type WindowsSnapshotCoordinatorPort} from './snapshot-product.ts';
import {WindowsNetworkObservations} from './network-observations.ts';
import {WindowsAgent,loadWindowsAgentArchive,type WindowsAgentArchive} from './agent.ts';
import {WindowsDesktopComponents,loadWindowsDesktopArchive,windowsDesktopComponentId,type WindowsDesktopArchive} from './desktop-components.ts';
import {WindowsDesktopClients,type WindowsDesktopClientDriver} from './desktop-clients.ts';
import {createWindowsDesktopClientGuestDriver} from './desktop-client-task.ts';
import type {WindowsDesktopClientsState} from '../../../shared/windows-desktop-clients.ts';

export interface WindowsServiceOptions {
 rootDir:string;dataDir?:string;runtimeRoot?:string;port?:number;base?:WindowsBase;
 runtime?:WindowsBackend&Pick<HyperVRuntime,'fingerprint'>&Partial<Pick<HyperVRuntime,'terminalLaunch'|'guest'|'management'|'serviceStreamFactory'|'audioLaunch'>>;
 probe?:WindowsManagerOptions['probe'];
 ptyFactory?:PtyFactory;
 enableSnapshotPreview?:boolean;
 enableSnapshotExportPreview?:boolean;
 enableLiveSnapshotDeletionPreview?:boolean;
 enableBrowserResetPreview?:boolean;
 enableBrowserRepairPreview?:boolean;
 enableLocalCheckPreview?:boolean;
 enableHostLabPreview?:boolean;
 enableAgentPreview?:boolean;
 enableDesktopComponentPreview?:boolean;
 enableDesktopClientPreview?:boolean;
 desktopClientDriver?:WindowsDesktopClientDriver;
 enableSharedDisplayPreview?:boolean;
 enableDiskCompactionPreview?:boolean;
 diskCompactionScheduleClock?:()=>number;
 displayDriver?:WindowsDisplayDriver;
 agentArchive?:WindowsAgentArchive;
 desktopComponentArchive?:WindowsDesktopArchive;
 browserRepairArchive?:WindowsBrowserRepairArchive;
 snapshotCoordinator?:(manager:WindowsManager)=>WindowsSnapshotCoordinatorPort;
 backupService?:(manager:WindowsManager)=>WindowsBackupService;
 storageFactory?:(manager:WindowsManager)=>WindowsStorage;
 cacheScheduleIdle?:()=>boolean;
}

export async function createWindowsService(options:WindowsServiceOptions){
 if(process.platform!=='win32')throw new AppError('Windows 入口只能在 Windows 上运行',400,'WINDOWS_REQUIRED');
 const dataDir=windowsAppDirectory(options.dataDir);
 const runtimeRoot=windowsRuntimeDirectory(options.runtimeRoot,dataDir);
 await secureWindowsDirectory(dataDir);
 const unlock=await acquireWindowsServiceLock(dataDir);
 const hostLab=new WindowsHostLab(options.enableHostLabPreview===true);
 let display:WindowsDisplayLifecycle|undefined;
 let fileViews:WindowsFileDisplay|undefined;
 let desktopClients:WindowsDesktopClients|undefined;
 let manager:WindowsManager|undefined,monitor:WindowsHostMonitor|undefined,terminal:WindowsTerminalServer|undefined,browser:WindowsBrowser|undefined,setup:WindowsSetup|undefined,host:WindowsHostComponents|undefined,storage:WindowsStorage|undefined,cacheSchedule:WindowsCacheSchedule|undefined,diskSchedule:WindowsDiskCompactionSchedule|undefined,guestAudio:WindowsGuestAudio|undefined,observations:WindowsNetworkObservations|undefined;
 try{
  const application=await windowsApplication(options.rootDir,VERSION);
  await secureWindowsDirectory(runtimeRoot);
  const runtime=options.runtime??new HyperVRuntime(runtimeRoot);
  let base=options.base;
  if(!base){
   try{let source:string;try{source=await readFile(path.join(runtimeRoot,'protected-desktop-base.json'),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;source=await readFile(path.join(runtimeRoot,'protected-base.json'),'utf8');}base=windowsBaseSchema.parse(JSON.parse(source));}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  manager=new WindowsManager(await openWindowsStore(dataDir),runtime,{runtimeRoot,base,probe:options.probe,diskCompactionPreview:options.enableDiskCompactionPreview===true});
  const controller=manager;
  const backups=options.backupService?.(controller)??(runtime instanceof HyperVRuntime&&runtime.broker?new WindowsBackupService(controller,runtime.broker,()=>!!host&&hostReady(host.snapshot())&&!setup?.running,{snapshotExportEnabled:options.enableSnapshotExportPreview}):undefined);
  const translationSettings=new WindowsTranslationSettings(controller.store);
  if(runtime instanceof HyperVRuntime&&runtime.broker){
   host=new WindowsHostComponents(runtime.broker,()=>!controller.tasks.size&&controller.store.list().every(e=>!['running','starting','creating','stopping'].includes(e.state))&&!setup?.running);
   setup=new WindowsSetup(runtime,runtimeRoot,{base,canPrepare:()=>!!host&&hostReady(host.snapshot())&&!controller.options.base&&!controller.tasks.size&&controller.store.list().every(e=>e.state==='not_created'),publish:value=>{controller.options.base=value;controller.profiles.clear();}});
   await initializeWindowsPrerequisites(()=>host!.refresh(),()=>setup!.initialize());
  }
  if(runtime instanceof HyperVRuntime&&runtime.broker)storage=new WindowsStorage(runtime.broker,()=>controller.options.base?.imageSha256??null,()=>!!host&&hostReady(host.snapshot())&&!controller.tasks.size&&!setup?.running);
  if(options.storageFactory)storage=options.storageFactory(controller);
  if(storage)cacheSchedule=new WindowsCacheSchedule(controller.store,storage,options.cacheScheduleIdle??(()=>!!host&&hostReady(host.snapshot())&&!controller.tasks.size&&!setup?.running&&controller.store.list().every(e=>['stopped','not_created'].includes(e.state))));
  if(options.enableDiskCompactionPreview===true&&runtime.diskCompactionStatus&&runtime.prepareDiskCompaction&&runtime.verifyDiskCompaction&&runtime.resumeDiskCompaction&&runtime.cancelDiskCompaction){
   diskSchedule=new WindowsDiskCompactionSchedule(controller.store,{
    eligible:id=>{try{const e=controller.store.get(id);return e.kind==='vm'&&e.state==='stopped'&&!controller.tasks.size&&!setup?.running&&(!host||hostReady(host.snapshot()));}catch{return false;}},
    pending:async id=>(await controller.diskCompactionStatus(id)).pending,
    compact:async id=>{const e=controller.store.get(id),job=await controller.compactDisk(id,'start',e.name);await controller.wait(job.id);if(controller.store.jobs().find(value=>value.id===job.id)?.status!=='succeeded')throw Error('Scheduled disk maintenance did not complete');}
   },options.diskCompactionScheduleClock);
  }
  const snapshotCoordinator=options.snapshotCoordinator?.(controller)??(runtime instanceof HyperVRuntime&&runtime.broker?new WindowsSnapshotCoordinator(controller.store,runtimeRoot,runtime.broker):undefined);
  const snapshots=snapshotCoordinator?new WindowsSnapshotProduct(controller,snapshotCoordinator,{enabled:options.enableSnapshotPreview,liveDeletionEnabled:options.enableLiveSnapshotDeletionPreview,exportEnabled:options.enableSnapshotExportPreview,available:()=>!host||hostReady(host.snapshot())&&!setup?.running,recoveryAvailable:()=>!host||host.snapshot().runtimeActive}):undefined;
  terminal=runtime.terminalLaunch?new WindowsTerminalServer(controller,{terminalLaunch:runtime.terminalLaunch.bind(runtime)},options.ptyFactory):undefined;
  const terminals=terminal,transfers=new Map<string,Set<AbortController>>(),readers=new Map<string,()=>void>(),imageTransfers=new Map<string,AbortController>(),translationTransfers=new Map<string,{abort:AbortController;sessionId:string}>(),fileOpens=new Map<string,{abort:AbortController;sessionId:string}>();
  // GuestExchange can issue several commands for one operation. Bind its
  // authorized Environment object to the original session, so a late command
  // completion cannot continue private work in a newly started guest.
  const exchangeSessions=new WeakMap<Environment,WindowsNetworkSession>();
  const assertExchangeSession=(e:Environment)=>{
   const session=exchangeSessions.get(e);
   if(!session||controller.sessions.get(e.id)!==session||session.state!=='active'||controller.guestOperationBusy(e.id)||controller.store.get(e.id).state!=='running')throw new AppError('环境已变化，请重新操作',409,'CONFIGURATION_CHANGED');
  };
  const authorizeExchange=async(id:string,signal?:AbortSignal)=>{
   const session=controller.sessions.get(id),e=await controller.assertAccess(id,false,signal);
   if(!session||controller.sessions.get(id)!==session||session.state!=='active'||controller.guestOperationBusy(id))throw new AppError('环境防护尚未通过或已失效',409,'GUARD_FAILED');
   const authorized={...e};exchangeSessions.set(authorized,session);return authorized;
  };
  const guest=runtime.guest?.bind(runtime),management=runtime.management?.bind(runtime);
  const agent=management&&terminals?new WindowsAgent(controller,{management},options.agentArchive??(runOptions=>loadWindowsAgentArchive(runtimeRoot,runOptions)),options.enableAgentPreview===true):undefined;
  const desktopComponents=management?new WindowsDesktopComponents(controller,{management},options.desktopComponentArchive??((id,runOptions)=>loadWindowsDesktopArchive(runtimeRoot,id,runOptions)),options.enableDesktopComponentPreview===true):undefined;
  if(agent?.enabled&&terminals)terminals.authorizeClaude=id=>agent.assertLaunch(id);
  observations=guest&&management?new WindowsNetworkObservations(controller,{guest,management}):undefined;
  const networkObservations=observations;
  const overview=guest?new WindowsOverviewReadings(controller,guest):undefined;
  if(runtime.serviceStreamFactory&&management){
   const displayRuntime={management,serviceStreamFactory:runtime.serviceStreamFactory.bind(runtime)};
   if(options.enableSharedDisplayPreview===true)display=new WindowsDisplayLifecycle(controller,options.displayDriver??createWindowsDisplayDriver(displayRuntime));
   const recovery=new WindowsBrowserComponentRecovery(controller,{management},id=>browser!.close(id),options.browserRepairArchive??((runOptions,version)=>loadWindowsBrowserRepairArchive(runtimeRoot,runOptions,version)),options.enableBrowserRepairPreview===true);
   browser=new WindowsBrowser(controller,displayRuntime,options.enableBrowserResetPreview===true,recovery,display);controller.browserRunning=id=>browser!.running(id);controller.browserAvailable=true;
   if(options.enableDesktopClientPreview===true){if(!display||!desktopComponents?.enabled)throw new AppError('桌面客户端需要共享显示与组件准备支持',409,'DESKTOP_CLIENT_UNAVAILABLE');desktopClients=new WindowsDesktopClients(controller,display,options.desktopClientDriver??createWindowsDesktopClientGuestDriver({management}));}
   controller.inspectAdditionalProtection=async id=>{await display?.assertProtection(id);await desktopClients?.assertProtection(id);await browser!.assertProtection(id);};
  }
  const guestBrowser=browser;
  if(options.enableDesktopClientPreview===true&&!desktopClients)throw new AppError('此入口缺少桌面客户端所需的共享显示支持',409,'DESKTOP_CLIENT_UNAVAILABLE');
  const localChecks=guestBrowser?new WindowsLocalChecks(controller,guestBrowser,options.enableLocalCheckPreview===true):undefined;
  if(guestBrowser&&runtime.audioLaunch){guestAudio=new WindowsGuestAudio(controller,display?windowsDisplayAudioSource(display):guestBrowser,{audioLaunch:runtime.audioLaunch.bind(runtime)});if(!display)guestBrowser.revokeAudio=id=>guestAudio!.revoke(id);}
  const exchange=guest&&management?new GuestExchange({guest:async(e,command,runOptions={})=>{
   assertExchangeSession(e);
   if([...transfers.values()].reduce((n,set)=>n+set.size,0)>=2)throw new AppError('同时传输数量已达到上限',429,'TRANSFER_LIMIT');
   const abort=new AbortController(),set=transfers.get(e.id)??new Set<AbortController>();set.add(abort);transfers.set(e.id,set);
   const translation=translationTransfers.get(e.id),signals=[abort.signal,runOptions.signal,translation?.abort.signal,fileOpens.get(e.id)?.abort.signal].filter((signal):signal is AbortSignal=>!!signal);
   try{const profile=await controller.profile(e);assertExchangeSession(e);if(translation&&controller.sessions.get(e.id)?.id!==translation.sessionId)throw new AppError('环境已变化，请重新翻译。',409,'CONFIGURATION_CHANGED');const signal=AbortSignal.any(signals);signal.throwIfAborted();const result=await guest(profile,command,{...runOptions,signal});assertExchangeSession(e);signal.throwIfAborted();return result;}
   finally{set.delete(abort);if(!set.size&&transfers.get(e.id)===set)transfers.delete(e.id);}
  },management:async(e,command,runOptions={})=>{
   assertExchangeSession(e);
   if([...transfers.values()].reduce((n,set)=>n+set.size,0)>=2)throw new AppError('同时传输数量已达到上限',429,'TRANSFER_LIMIT');
   const abort=new AbortController(),set=transfers.get(e.id)??new Set<AbortController>();set.add(abort);transfers.set(e.id,set);
   const signals=[abort.signal,runOptions.signal,imageTransfers.get(e.id)?.signal,fileOpens.get(e.id)?.abort.signal].filter((signal):signal is AbortSignal=>!!signal);
   try{await controller.assertAccess(e.id);const profile=await controller.profile(e),signal=AbortSignal.any(signals);signal.throwIfAborted();assertExchangeSession(e);const result=await management(profile,command,{...runOptions,signal});assertExchangeSession(e);signal.throwIfAborted();return result;}
   finally{set.delete(abort);if(!set.size&&transfers.get(e.id)===set)transfers.delete(e.id);}
  }},authorizeExchange,translationSettings):undefined;
  const directories=exchange?new WindowsFileDirectories(exchange):undefined;
  if(display&&exchange&&management)fileViews=new WindowsFileDisplay(controller,display,createWindowsFileDisplayDriver({management},async(id,input,unit,options)=>{options.assertCurrent();const result=await exchange.openFolder(id,input,{unit});options.assertCurrent();return result;}));
  controller.onAccessRevoked=id=>{terminals?.closeEnvironment(id);desktopClients?.revoke(id);fileViews?.revoke(id);display?.revoke(id);guestBrowser?.revoke(id);translationTransfers.get(id)?.abort.abort();fileOpens.get(id)?.abort.abort();for(const abort of transfers.get(id)??[])abort.abort();readers.get(id)?.();};
  if(!host||host.snapshot().runtimeActive){await snapshots?.initialize();await controller.recover();}
  monitor=new WindowsHostMonitor(()=>runtime.fingerprint(),reason=>{void controller.hostUnavailable(windowsHostMonitorIssue(reason)).catch(()=>{});});
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
  app.get('/api/windows/host-lab',(_req,res)=>res.json(hostLab.status()));
  app.get('/api/windows/host-lab/records',(_req,res)=>res.json(hostLab.records()));
  app.post('/api/windows/host-lab/start',async(req,res)=>{z.object({}).strict().parse(req.body??{});res.json(await hostLab.start());});
  app.post('/api/windows/host-lab/stop',async(req,res)=>{const input=z.object({runId:z.uuid()}).strict().parse(req.body??{});res.json(await hostLab.stop(input.runId));});
  app.post('/api/windows/host-lab/window',(req,res)=>{const input=z.object({runId:z.uuid()}).strict().parse(req.body??{});res.json(hostLab.describe('http://127.0.0.1:'+port,input.runId));});
  const id=(req:express.Request)=>z.uuid().parse(req.params.id);
  const agentHost=()=>{if(!agent)throw new AppError('此入口尚未提供 Claude Code 组件管理',409,'AGENT_UNAVAILABLE');return agent;};
  app.get('/api/environments/:id/agent',async(req,res)=>res.json(await agentHost().status(id(req))));
  app.post('/api/environments/:id/agent/install',async(req,res)=>{const input=z.object({confirm:z.literal('install-approved-agent'),environmentName:z.string().min(1).max(60)}).strict().parse(req.body??{}),envId=id(req),component=agentHost();if(!component.enabled)throw new AppError('Claude Code 安装尚未完成 Windows 实机验收，暂未开放',409,'AGENT_UNAVAILABLE');if(controller.store.get(envId).name!==input.environmentName)throw new AppError('请输入完整环境名称以确认安装',400,'AGENT_CONFIRMATION');await controller.assertAccess(envId);res.status(202).json(controller.runAgentInstall(envId,signal=>component.install(envId,input.environmentName,{signal})));});
  const desktopComponentHost=()=>{if(!desktopComponents)throw new AppError('此入口尚未提供桌面组件准备',409,'DESKTOP_COMPONENT_UNAVAILABLE');return desktopComponents;};
  const desktopClientHost=()=>{if(!desktopClients)throw new AppError('桌面客户端尚未完成 Windows 实机验收，暂未开放',409,'FEATURE_UNAVAILABLE');return desktopClients;};
  const clientView=z.object({viewId:z.uuid()}).strict();
  app.get('/api/environments/:id/desktop-clients',async(req,res)=>{
   const host=desktopClientHost(),envId=id(req),environment=controller.store.get(envId);
   if(environment.state!=='running'){res.json({version:1,enabled:true,accountTested:false,apps:(['grok-bot','claude-desktop'] as const).map(app=>({id:app,state:'unavailable',viewId:null,rendererProtected:null}))} satisfies WindowsDesktopClientsState);return;}
   const session=controller.sessions.get(envId);await controller.assertAccess(envId);await host.assertProtection(envId);if(!session||controller.sessions.get(envId)!==session||session.state!=='active')throw new AppError('客户端环境会话已变化',409,'DESKTOP_CLIENT_CHANGED');
   res.json({version:1,enabled:true,accountTested:false,apps:host.states(envId)} satisfies WindowsDesktopClientsState);
  });
  app.post('/api/environments/:id/desktop-clients/:application/start',async(req,res)=>{
   const host=desktopClientHost(),envId=id(req),application=windowsDesktopComponentId.parse(req.params.application),input=z.object({confirm:z.literal('start-approved-desktop'),environmentName:z.string().min(1).max(200)}).strict().parse(req.body),session=controller.sessions.get(envId);
   const original=()=>{if(!session||controller.sessions.get(envId)!==session||session.state!=='active'||controller.store.get(envId).state!=='running')throw new AppError('客户端环境会话已变化',409,'DESKTOP_CLIENT_CHANGED');if(controller.store.get(envId).name!==input.environmentName)throw new AppError('环境名称已变化，请刷新后重新打开',409,'DESKTOP_CLIENT_CONFIRMATION');};
   await controller.assertAccess(envId);original();res.status(202).json(controller.runDesktopClientOperation(envId,'desktop-start',async signal=>{original();return host.start(envId,application,{signal});}));
  });
  app.post('/api/environments/:id/desktop-clients/:application/stop',async(req,res)=>{
   const host=desktopClientHost(),envId=id(req),application=windowsDesktopComponentId.parse(req.params.application),input=clientView.parse(req.body),session=controller.sessions.get(envId);
   const original=()=>{if(!session||controller.sessions.get(envId)!==session||session.state!=='active')throw new AppError('客户端环境会话已变化',409,'DESKTOP_CLIENT_CHANGED');const current=host.info(envId).find(value=>value.application===application);if(current&&current.viewId!==input.viewId)throw new AppError('客户端已重新打开，请刷新后再关闭',409,'DESKTOP_CLIENT_VIEW_CHANGED');};
   await controller.assertAccess(envId);original();res.status(202).json(controller.runDesktopClientOperation(envId,'desktop-stop',async()=>{original();const value=await host.stop(envId,application,input.viewId);original();return value;}));
  });
  app.post('/api/environments/:id/desktop-clients/:application/view-ticket',async(req,res)=>{const host=desktopClientHost(),envId=id(req),app=windowsDesktopComponentId.parse(req.params.application),input=clientView.parse(req.body);await controller.assertAccess(envId);res.json(await host.viewTicket(envId,app,input.viewId));});
  app.post('/api/environments/:id/desktop-clients/:application/focus',async(req,res)=>{const host=desktopClientHost(),envId=id(req),app=windowsDesktopComponentId.parse(req.params.application),input=clientView.parse(req.body);await controller.assertAccess(envId);res.json(await host.focusView(envId,app,input.viewId));});
  app.get('/api/environments/:id/desktop-clients/:application/view',async(req,res)=>{const host=desktopClientHost(),envId=id(req),app=windowsDesktopComponentId.parse(req.params.application),input=clientView.parse(req.query);await controller.assertAccess(envId);res.json(await host.viewState(envId,app,input.viewId));});
  app.post('/api/environments/:id/desktop-clients/:application/display',async(req,res)=>{const host=desktopClientHost(),envId=id(req),app=windowsDesktopComponentId.parse(req.params.application),input=z.object({viewId:z.uuid(),display:displayRequestSchema}).strict().parse(req.body);await controller.assertAccess(envId);res.json(await host.resizeView(envId,app,input.viewId,input.display));});
  app.get('/api/environments/:id/desktop-components',async(req,res)=>res.json(await desktopComponentHost().status(id(req))));
  app.post('/api/environments/:id/desktop-components/:application/install',async(req,res)=>{const input=z.object({confirm:z.literal('install-approved-desktop'),environmentName:z.string().min(1).max(60)}).strict().parse(req.body??{}),application=windowsDesktopComponentId.parse(req.params.application),envId=id(req),component=desktopComponentHost();if(!component.enabled)throw new AppError('桌面客户端组件准备尚未完成 Windows 实机验收，暂未开放',409,'DESKTOP_COMPONENT_UNAVAILABLE');if(controller.store.get(envId).name!==input.environmentName)throw new AppError('请输入完整环境名称以确认组件准备',400,'DESKTOP_COMPONENT_CONFIRMATION');await controller.assertAccess(envId);res.status(202).json(controller.runDesktopComponentInstall(envId,signal=>component.install(envId,application,input.environmentName,{signal})));});
  const backup=()=>{if(!backups)throw new AppError('请使用 Windows 桌面权限代理进行备份',409,'FEATURE_UNAVAILABLE');return backups;};
  app.get('/api/windows/backups',(_req,res)=>res.json(backup().snapshot()));
  app.post('/api/windows/backups/export',(req,res)=>{const input=z.object({id:z.uuid(),path:backupFilePath,password:backupPassword,passwordConfirmation:backupPassword,confirmation:z.string().min(1).max(60)}).strict().parse(req.body);if(input.password!==input.passwordConfirmation)throw new AppError('两次备份密码不一致',400,'BACKUP_PASSWORD_CONFIRMATION');res.status(202).json(backup().export(input.id,input.path,input.password,input.confirmation));});
  app.post('/api/windows/backups/review',(req,res)=>{const input=z.object({path:backupFilePath,password:backupPassword}).strict().parse(req.body);res.status(202).json(backup().review(input.path,input.password));});
  app.post('/api/windows/backups/restore',(req,res)=>{const input=z.object({token:z.uuid(),confirmation:z.string().min(1).max(60),restoreName:z.string().trim().min(1).max(60).optional()}).strict().parse(req.body);res.status(202).json(backup().restore(input.token,input.confirmation,input.restoreName));});
  app.post('/api/windows/backups/cleanup',(req,res)=>{const input=z.object({id:z.uuid()}).strict().parse(req.body);res.status(202).json(backup().cleanup(input.id));});
  app.post('/api/windows/backups/output-cleanup',(req,res)=>{const input=z.object({id:z.uuid()}).strict().parse(req.body);res.status(202).json(backup().cleanupOutput(input.id));});
  app.post('/api/windows/backups/discard',(req,res)=>{z.object({}).strict().parse(req.body??{});res.json(backup().discard());});
  app.get('/api/snapshot',async(_req,res)=>{const snapshot=await controller.snapshot();if(host&&!hostReady(host.snapshot())){snapshot.system.runtime.available=false;snapshot.system.runtime.error='请完成 Windows 系统组件准备，按提示重启或重新打开软件';}const recovery=snapshots?.status();if(recovery&&(!host||host.snapshot().runtimeActive)&&(!recovery.initialized||recovery.pendingIds.length||recovery.issues.length))snapshot.system.hostSnapshotIssue='快照恢复状态尚未通过核验，相关环境的修改和启动受限；原磁盘和恢复记录已保留';res.json({...snapshot,system:{...snapshot.system,application}});});
  app.post('/api/environments',async(req,res)=>res.status(201).json(await controller.create(req.body)));
  app.put('/api/environments/:id',async(req,res)=>res.json(await controller.update(id(req),req.body)));
  app.post('/api/environments/:id/actions/delete',async(req,res)=>{const input=z.object({confirmation:z.string().min(1).max(60)}).strict().parse(req.body);res.status(202).json(await controller.remove(id(req),input.confirmation));});
  app.post('/api/environments/:id/actions/:action',async(req,res)=>{const action=z.enum(['start','stop','restart']).parse(req.params.action);if(action!=='stop'&&host&&!hostReady(await host.refresh()))throw new AppError('系统组件尚未就绪，请按系统准备提示处理',409,'HOST_REQUIREMENTS');res.status(202).json(await controller.action(id(req),action));});
  app.get('/api/environments/:id/network/protection',async(req,res)=>res.json(await controller.protection(id(req))));
  app.get('/api/environments/:id/network/egress',async(req,res)=>res.json(await controller.egress(id(req))));
  app.get('/api/environments/:id/protection-events',(req,res)=>res.json(controller.protectionRecords.list(id(req))));
  app.get('/api/windows/channel-diagnostics',async(_req,res)=>{
   if(!(runtime instanceof HyperVRuntime)||!runtime.broker)throw new AppError('权限代理不可用，无法读取通道诊断',409,'FEATURE_UNAVAILABLE');
   const schema=z.object({events:z.array(z.object({at:z.iso.datetime(),code:z.enum(['capacity','guest-connect-socket','guest-connect-timeout','guest-send-error','guest-recv-error'])}).strict()).max(32),full:z.boolean()}).strict();
   res.json(schema.parse(await runtime.broker.call('channel-diagnostics',{}, {timeoutMs:5000})));
  });
  const snapshotProduct=()=>{if(!snapshots)throw new AppError('当前入口不支持 Windows 快照管理',409,'FEATURE_UNAVAILABLE');return snapshots;};
  app.get('/api/windows/snapshots',(_req,res)=>res.json(snapshotProduct().status()));
  app.post('/api/windows/snapshots/recheck',async(req,res)=>{z.object({}).strict().parse(req.body??{});res.json(await snapshotProduct().initialize(true));});
  app.get('/api/environments/:id/windows-snapshots',async(req,res)=>res.json(await snapshotProduct().list(id(req))));
  app.post('/api/environments/:id/windows-snapshots',(req,res)=>{const input=z.object({name:z.string().min(1).max(60)}).strict().parse(req.body);res.status(202).json(snapshotProduct().create(id(req),input.name));});
  app.post('/api/environments/:id/windows-snapshots/restore',(req,res)=>{const input=z.object({snapshotId:z.uuid(),confirmation:z.string().min(1).max(60)}).strict().parse(req.body);res.status(202).json(snapshotProduct().restore(id(req),input.snapshotId,input.confirmation));});
  app.post('/api/environments/:id/windows-snapshots/export',(req,res)=>{const input=z.object({snapshotId:z.uuid(),name:z.string().min(1).max(60),createdAt:z.string().datetime({offset:true}),path:backupFilePath,password:backupPassword,passwordConfirmation:backupPassword,confirmation:z.string().min(1).max(60)}).strict().parse(req.body);if(input.password!==input.passwordConfirmation)throw new AppError('两次备份密码不一致',400,'BACKUP_PASSWORD_CONFIRMATION');res.status(202).json(backup().exportSnapshot(id(req),input.snapshotId,input.name,input.createdAt,input.path,input.password,input.confirmation));});
  app.get('/api/environments/:id/windows-snapshots/deletions',async(req,res)=>res.json(await snapshotProduct().deletions(id(req))));
  app.get('/api/environments/:id/windows-snapshots/staging',async(req,res)=>res.json(await snapshotProduct().staging(id(req))));
  app.get('/api/environments/:id/windows-snapshots/staging/review',(req,res)=>res.json(snapshotProduct().stagingReviewState(id(req))));
  app.post('/api/environments/:id/windows-snapshots/staging/review',(req,res)=>{const input=z.object({copyId:z.uuid(),operation:z.enum(['create','restore'])}).strict().parse(req.body);res.status(202).json(snapshotProduct().inspectStaging(id(req),input.copyId,input.operation));});
  app.post('/api/environments/:id/windows-snapshots/staging/cleanup',(req,res)=>{const input=z.object({copyId:z.uuid(),operation:z.enum(['create','restore']),token:z.string().regex(/^[a-f0-9]{64}$/),confirmation:z.string().min(1).max(60),resumeOnly:z.boolean()}).strict().parse(req.body);res.status(202).json(snapshotProduct().cleanupStaging(id(req),input.copyId,input.operation,input.token,input.confirmation,input.resumeOnly));});
  app.post('/api/environments/:id/windows-snapshots/delete',(req,res)=>{const input=z.object({snapshotId:z.uuid(),name:z.string().min(1).max(60),confirmation:z.string().min(1).max(60),resumeOnly:z.boolean()}).strict().parse(req.body);res.status(202).json(snapshotProduct().remove(id(req),input.snapshotId,input.name,input.confirmation,input.resumeOnly));});
  app.post('/api/environments/:id/windows-snapshots/recover',(req,res)=>{const input=z.object({confirmation:z.string().min(1).max(60)}).strict().parse(req.body);res.status(202).json(snapshotProduct().recover(id(req),input.confirmation));});
  app.get('/api/environments/:id/disk-growth',async(req,res)=>{const abort=new AbortController(),cancel=()=>{if(!res.writableFinished)abort.abort();};res.once('close',cancel);try{res.json(await controller.diskGrowthInfo(id(req),{signal:abort.signal}));}finally{res.removeListener('close',cancel);}});
  app.post('/api/environments/:id/disk-growth',async(req,res)=>{const input=z.object({targetGiB:z.number().int().min(16).max(256),confirmation:z.string().min(1).max(60)}).strict().parse(req.body);res.status(202).json(await controller.growDisk(id(req),input.targetGiB,input.confirmation));});
  app.get('/api/environments/:id/disk-compaction',async(req,res)=>{const abort=new AbortController(),cancel=()=>{if(!res.writableFinished)abort.abort();};res.once('close',cancel);try{res.json(await controller.diskCompactionStatus(id(req),{signal:abort.signal}));}finally{res.removeListener('close',cancel);}});
  app.post('/api/environments/:id/disk-compaction',async(req,res)=>{const input=z.object({operation:z.enum(['start','resume','cancel']),confirmation:z.string().min(1).max(60)}).strict().parse(req.body);if(input.operation!=='cancel'&&host&&!hostReady(await host.refresh()))throw new AppError('系统组件尚未就绪，请按系统准备提示处理',409,'HOST_REQUIREMENTS');res.status(202).json(await controller.compactDisk(id(req),input.operation,input.confirmation));});
  const diskScheduleHost=()=>{if(!diskSchedule)throw new AppError('定期磁盘回收尚未开放',409,'FEATURE_UNAVAILABLE');return diskSchedule;};
  app.get('/api/environments/:id/disk-compaction/schedule',(req,res)=>{const envId=id(req);controller.store.get(envId);res.json(diskScheduleHost().status(envId));});
  app.post('/api/environments/:id/disk-compaction/schedule',async(req,res)=>{const envId=id(req),input=z.object({enabled:z.boolean()}).strict().parse(req.body);controller.store.get(envId);res.json(await diskScheduleHost().configure(envId,input.enabled));});
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
  const cacheScheduleHost=()=>{if(!cacheSchedule)throw new AppError('此入口不提供定期缓存清理',409,'STORAGE_UNAVAILABLE');return cacheSchedule;};
  app.get('/api/windows/storage/schedule',(_req,res)=>res.json(cacheScheduleHost().status()));
  app.post('/api/windows/storage/schedule',(req,res)=>{const input=z.object({enabled:z.boolean()}).strict().parse(req.body);res.json(cacheScheduleHost().configure(input.enabled));});
  app.get('/api/windows/resources',async(_req,res)=>{if(!(runtime instanceof HyperVRuntime)||!runtime.broker)throw new AppError('此入口不提供受保护资源核验',409,'RESOURCE_UNAVAILABLE');res.json(await runtime.resources());});
  app.get('/api/windows/power',async(_req,res)=>{if(!(runtime instanceof HyperVRuntime)||!runtime.broker)throw new AppError('此入口不提供原生电源核验',409,'POWER_UNAVAILABLE');res.json(await runtime.power());});
  app.post('/api/windows/storage/prune',async(req,res)=>{const input=z.object({plan:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);res.json(await storageHost().prune(input.plan));});
  const observationHost=()=>{if(!networkObservations)throw new AppError('此入口无法读取 Linux 网络记录',409,'FEATURE_UNAVAILABLE');return networkObservations;};
  app.get('/api/environments/:id/network/observations',(req,res)=>{const query=z.object({q:z.string().max(253).optional(),scope:z.enum(['traffic','checks','all']).optional(),failures:z.enum(['0','1']).transform(value=>value==='1').optional(),before:z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()}).strict().parse(req.query);res.json(observationHost().info(id(req),Object.keys(query).length?query:undefined));});
  app.post('/api/environments/:id/network/observations',async(req,res)=>{z.object({}).strict().parse(req.body??{});res.json(await observationHost().sample(id(req)));});
  const browserHost=()=>{if(!guestBrowser)throw new AppError('Windows 浏览器运行组件不可用',409,'FEATURE_UNAVAILABLE');return guestBrowser;};
  const checkHost=()=>{if(!localChecks)throw new AppError('此入口不提供 Windows 检测实验室',409,'FEATURE_UNAVAILABLE');return localChecks;};
  app.get('/api/windows/local-checks',(_req,res)=>res.json(checkHost().status()));
  app.post('/api/environments/:id/lab/check',async(req,res)=>{z.object({}).strict().parse(req.body??{});res.status(202).json(await checkHost().start(id(req)));});
  const overviewReadings=()=>{if(!overview)throw new AppError('Linux 状态读取组件不可用',409,'FEATURE_UNAVAILABLE');return overview;};
  app.get('/api/environments/:id/metrics',async(req,res)=>res.json(await overviewReadings().metrics(id(req))));
  app.get('/api/environments/:id/browser/version',async(req,res)=>res.json(await overviewReadings().browserVersion(id(req))));
  app.get('/api/environments/:id/network/latency',async(req,res)=>res.json(await overviewReadings().latency(id(req))));
  app.post('/api/environments/:id/network/latency',async(req,res)=>res.json(await overviewReadings().measureLatency(id(req),latencyInput.parse(req.body??{}).target)));
  app.get('/api/environments/:id/guest-browser',(req,res)=>res.json(browserHost().info(id(req))));
  app.post('/api/environments/:id/browser/open',async(req,res)=>{const input=z.object({startup:z.enum(['blank','configured']).default('blank')}).strict().parse(req.body??{});const envId=id(req),host=browserHost();res.status(202).json(await controller.submit(envId,'open-browser',options=>host.open(envId,options,input.startup)));});
  app.post('/api/environments/:id/browser/close',async(req,res)=>{const envId=id(req),host=browserHost();res.status(202).json(await controller.submit(envId,'close-browser',()=>host.close(envId)));});
  app.post('/api/environments/:id/browser/reset',async(req,res)=>{const input=z.object({confirm:z.literal('erase-browser-profile'),environmentName:z.string().min(1).max(200)}).strict().parse(req.body??{}),envId=id(req),host=browserHost();if(!host.resetEnabled)throw new AppError('浏览器资料重置尚未完成 Windows 实机验收，暂未开放',409,'BROWSER_RESET_UNAVAILABLE');res.status(202).json(await controller.submit(envId,'browser-reset',options=>host.reset(envId,input.environmentName,options)));});
  app.post('/api/environments/:id/browser/component-repair',async(req,res)=>{const input=z.object({confirm:z.literal('repair-approved-browser-component'),environmentName:z.string().min(1).max(200)}).strict().parse(req.body??{}),envId=id(req),recovery=browserHost().componentRecovery;if(!recovery?.enabled)throw new AppError('浏览器组件恢复尚未完成 Windows 实机验收，暂未开放',409,'BROWSER_REPAIR_UNAVAILABLE');res.status(202).json(await controller.submit(envId,'browser-component-repair',options=>recovery.repair(envId,input.environmentName,options)));});
  app.post('/api/environments/:id/browser/navigate',async(req,res)=>{const input=z.object({url:z.url().max(2048)}).strict().parse(req.body);const envId=id(req);res.status(202).json(await controller.submit(envId,'browser-navigate',()=>browserHost().navigate(envId,input.url)));});
  app.get('/api/environments/:id/browser/inspect',async(req,res)=>{const envId=id(req);await controller.assertAccess(envId);res.json(await browserHost().inspect(envId));});
  app.post('/api/environments/:id/guest-browser-ticket',async(req,res)=>{const envId=id(req);await controller.assertAccess(envId);res.json(browserHost().issue(envId));});
  app.post('/api/environments/:id/guest-audio-ticket',async(req,res)=>{z.object({}).strict().parse(req.body??{});if(!guestAudio)throw new AppError('此入口的音频组件尚未就绪',409,'FEATURE_UNAVAILABLE');res.json(await guestAudio.issue(id(req)));});
  app.post('/api/environments/:id/guest-browser/display',async(req,res)=>{const envId=id(req),input=displayRequestSchema.parse(req.body);await controller.assertAccess(envId);res.json(await browserHost().resize(envId,input));});
  app.post('/api/environments/:id/terminal-ticket',async(req,res)=>{
   const input=z.object({command:z.enum(['shell','claude']).default('shell'),cols:z.number().int().min(20).max(300).default(100),rows:z.number().int().min(5).max(100).default(28)}).strict().parse(req.body??{});
   if(!terminals)throw new AppError('Windows 终端组件不可用',409,'FEATURE_UNAVAILABLE');const envId=id(req),session=controller.sessions.get(envId),abort=new AbortController(),cancel=()=>{if(!res.writableFinished)abort.abort(new AppError('终端连接请求已取消',409,'CANCELLED'));};
   res.once('close',cancel);req.once('aborted',cancel);
   try{if(res.destroyed)cancel();abort.signal.throwIfAborted();await controller.assertAccess(envId,false,abort.signal);abort.signal.throwIfAborted();if(input.command==='claude')await agentHost().assertLaunch(envId);abort.signal.throwIfAborted();if(!session||controller.sessions.get(envId)!==session||session.state!=='active')throw new AppError('终端防护会话已变化，请重新连接',409,'GUARD_FAILED');res.json({ticket:terminals.issue(envId,input.cols,input.rows,input.command)});}
   finally{res.removeListener('close',cancel);req.removeListener('aborted',cancel);}
  });
  const files=()=>{if(!exchange)throw new AppError('Windows 文件传输组件不可用',409,'FEATURE_UNAVAILABLE');return exchange;};
  const cancelTranslations=()=>{for(const request of translationTransfers.values())request.abort.abort();};
  app.get('/api/translation-settings',(_req,res)=>res.json(translationSettings.status()));
  app.post('/api/translation-settings',(req,res)=>{const input=z.object({apiKey:translationApiKey}).strict().parse(req.body);const status=translationSettings.save(input.apiKey);cancelTranslations();res.json(status);});
  app.delete('/api/translation-settings',(req,res)=>{z.object({}).strict().parse(req.body??{});const status=translationSettings.clear();cancelTranslations();res.json(status);});
  app.post('/api/environments/:id/translate-text',async(req,res)=>{
   const envId=id(req),input=z.object({text:inlineTranslationText,direction:translationDirection.optional()}).strict().parse(req.body);files();
   if(translationTransfers.has(envId))throw new AppError('当前翻译尚未结束，请稍后重试。',409,'TRANSLATION_BUSY');
   const session=controller.sessions.get(envId);if(!session||session.state!=='active')throw new AppError('请先启动并核验环境，再使用翻译。',409,'GUARD_FAILED');
   const context={abort:new AbortController(),sessionId:session.id};translationTransfers.set(envId,context);
   const cancel=()=>{if(!res.writableFinished)context.abort.abort();};res.once('close',cancel);req.once('aborted',cancel);
   try{if(res.destroyed)context.abort.abort();context.abort.signal.throwIfAborted();await controller.assertAccess(envId,false,context.abort.signal);context.abort.signal.throwIfAborted();if(controller.sessions.get(envId)!==session||session.state!=='active')throw new AppError('环境已变化，请重新翻译。原文已保留。',409,'CONFIGURATION_CHANGED');const result=await files().translate(envId,input.text,input.direction,context.abort.signal);context.abort.signal.throwIfAborted();if(controller.sessions.get(envId)!==session||session.state!=='active')throw new AppError('环境已变化，译文不再交付。原文已保留。',409,'CONFIGURATION_CHANGED');res.json(result);}
   finally{res.removeListener('close',cancel);req.removeListener('aborted',cancel);if(translationTransfers.get(envId)===context)translationTransfers.delete(envId);}
  });
  app.get('/api/environments/:id/transfer-files',async(req,res)=>{
   const envId=id(req),abort=new AbortController(),cancel=()=>{if(!res.writableFinished)abort.abort();};res.once('close',cancel);if(res.destroyed)abort.abort();
   try{abort.signal.throwIfAborted();const result=req.query.directory==='1'?await files().listDirectory(envId,transferZone.parse(req.query.zone),transferPath.parse(req.query.path??''),z.string().optional().parse(req.query.cursor),abort.signal):await files().listPage(envId,z.string().optional().parse(req.query.cursor),abort.signal);abort.signal.throwIfAborted();res.json(result);}finally{res.removeListener('close',cancel);}
  });
  app.post('/api/environments/:id/transfer-directories',async(req,res)=>{
   const envId=id(req);files();if(!directories)throw new AppError('Windows 文件夹组件不可用',409,'FEATURE_UNAVAILABLE');
   const abort=new AbortController(),cancel=()=>{if(!res.writableFinished)abort.abort();};res.once('close',cancel);req.once('aborted',cancel);if(res.destroyed)abort.abort();
   try{res.status(201).json(await directories.create(envId,req.body,abort.signal));}finally{res.removeListener('close',cancel);}
  });
  app.post('/api/environments/:id/transfer-folder/open',async(req,res)=>{
   const envId=id(req),input=z.object({zone:transferZone,path:transferPath.default('')}).strict().parse(req.body),host=files();
   await controller.assertAccess(envId);if(!fileViews&&!guestBrowser?.info(envId).ready)throw new AppError('请先打开浏览器画面，再打开沙箱文件夹',409,'FILE_DISPLAY_REQUIRED');
   if(fileOpens.has(envId)||host.busy.has(envId)||readers.has(envId))throw new AppError('当前环境正在传输，请稍后重试',409,'TRANSFER_BUSY');
   const context={abort:new AbortController(),sessionId:controller.sessions.get(envId)!.id};fileOpens.set(envId,context);const cancel=()=>{if(!res.writableFinished)context.abort.abort();};res.once('close',cancel);if(res.destroyed)context.abort.abort();
   let openedViewId:string|undefined;
   try{context.abort.signal.throwIfAborted();const result=fileViews?await fileViews.open(envId,input,{signal:context.abort.signal}):await host.openFolder(envId,input);if('viewId' in result)openedViewId=result.viewId as string;context.abort.signal.throwIfAborted();if(controller.sessions.get(envId)?.id!==context.sessionId)throw new AppError('环境已变化，请重新打开文件夹',409,'CONFIGURATION_CHANGED');res.json(result);}
   catch(error){if(openedViewId&&fileViews)await fileViews.close(envId,openedViewId);throw error;}
   finally{res.removeListener('close',cancel);if(fileOpens.get(envId)===context)fileOpens.delete(envId);}
  });
  app.post('/api/environments/:id/transfer-folder/close',async(req,res)=>{const envId=id(req),input=windowsFileViewClose.parse(req.body);if(!fileViews)throw new AppError('独立文件画面尚未开放',409,'FEATURE_UNAVAILABLE');res.json(await fileViews.close(envId,input.viewId));});
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
   const abort=new AbortController(),cancel=()=>{if(!res.writableFinished)abort.abort();};res.once('close',cancel);if(res.destroyed)abort.abort();
   try{abort.signal.throwIfAborted();const bytes=await files().download(id(req),input.zone,input.name,input.path,input.revision,abort.signal);abort.signal.throwIfAborted();
    res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(input.name)}`);res.type('application/octet-stream').send(bytes);
   }finally{res.removeListener('close',cancel);req.removeListener('aborted',cancel);}
  });
  app.post('/api/environments/:id/transfer-move',async(req,res)=>{
   const input=z.object({zone:transferZone,name:transferName,path:transferPath.optional(),revision:transferRevision.optional()}).strict().parse(req.body);
   res.json(await files().moveToDownloads(id(req),input.zone,input.name,input.path,input.revision));
  });
  app.post('/api/environments/:id/clipboard/write',async(req,res)=>{const input=z.object({text:clipboardText}).strict().parse(req.body);res.json(await files().writeClipboard(id(req),input.text));});
  app.post('/api/environments/:id/clipboard/read',async(req,res)=>{z.object({}).strict().parse(req.body??{});res.json(await files().readClipboard(id(req)));});
  app.post('/api/environments/:id/clipboard/image/read',async(req,res)=>{
   z.object({}).strict().parse(req.body??{});const envId=id(req),exchange=files();
   if(readers.has(envId)||imageTransfers.has(envId))throw new AppError('当前传输正在进行，请稍后重试',409,'TRANSFER_BUSY');
   const session=controller.sessions.get(envId);await controller.assertAccess(envId);if(!session||controller.sessions.get(envId)!==session)throw new AppError('环境已变化，请重新取回图片',409,'CONFIGURATION_CHANGED');
   const abort=new AbortController(),cancel=()=>{if(!res.writableFinished)abort.abort();};
   res.once('close',cancel);imageTransfers.set(envId,abort);
   try{const result=await readWindowsGuestClipboardImage(exchange,envId,abort.signal);abort.signal.throwIfAborted();if(!session||controller.sessions.get(envId)!==session)throw new AppError('环境已变化，图片结果不再交付',409,'CONFIGURATION_CHANGED');res.json(result);}
   finally{res.removeListener('close',cancel);if(imageTransfers.get(envId)===abort)imageTransfers.delete(envId);}
  });
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
  const bootstrap=`<script nonce="${nonce}">window.__MU_CONFIG__=${JSON.stringify({token,version:VERSION,platform:'win32',capabilities:{desktopClients:!!desktopClients,desktopComponents:!!desktopComponents&&options.enableDesktopComponentPreview===true,agent:!!agent,networkObservations:!!networkObservations,snapshots:!!snapshots,snapshotRecovery:!!snapshots,backups:!!backups,terminal:!!terminals,files:!!exchange,fileDirectories:!!directories,fileManager:!!exchange&&!!guestBrowser,independentFileView:!!fileViews,browser:!!guestBrowser,browserDetails:!!guestBrowser&&!!overview,browserStartup:!!guestBrowser,localChecks:!!localChecks,browserReset:!!guestBrowser?.resetEnabled,browserRepair:!!guestBrowser?.componentRecovery?.enabled,audio:!!guestAudio,imageClipboard:!!exchange&&!!guestBrowser,translation:!!exchange,diskGrowth:!!runtime.diskGrowthAvailable,diskCompaction:options.enableDiskCompactionPreview===true&&!!runtime.diskCompactionStatus&&!!runtime.prepareDiskCompaction&&!!runtime.verifyDiskCompaction&&!!runtime.resumeDiskCompaction&&!!runtime.cancelDiskCompaction,remove:!!runtime.deletionAvailable,setup:!!setup,hostSetup:!!host,storage:!!storage}})};</script>`;
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
  cacheSchedule?.start();
  diskSchedule?.start();
  const close=()=>closing??=(async()=>{
   cacheSchedule?.stop();diskSchedule?.stop();watcher.stop();terminals?.close();desktopClients?.dispose();fileViews?.dispose();guestBrowser?.dispose();display?.dispose();cancelTranslations();for(const context of fileOpens.values())context.abort.abort();for(const stop of readers.values())stop();for(const set of transfers.values())for(const abort of set)abort.abort();const closed=new Promise<void>(resolve=>server.close(()=>resolve()));server.closeAllConnections();
   const hostLabClosed=hostLab.close().then(()=>undefined,error=>error);
   try{const observationsClosed=networkObservations?.close();backups?.close();await guestAudio?.dispose();await setup?.close();await controller.close();await observationsClosed;const labError=await hostLabClosed;if(labError)throw labError;}finally{await hostLabClosed;await closed;await unlock();}
  })();
  return {app,server,manager:controller,terminal:terminals,browser:guestBrowser,display,fileViews,desktopClients,guestAudio,exchange,setup,host,snapshots,networkObservations,desktopComponents,diskSchedule,hostLabWindowKey:hostLab.windowKey,url,port,launchUrl:(pathname='/')=>ui.launchUrl(url,pathname),close};
 }catch(error){cacheSchedule?.stop();monitor?.stop();terminal?.close();desktopClients?.dispose();fileViews?.dispose();browser?.dispose();display?.dispose();try{const observationsClosed=observations?.close();await guestAudio?.dispose();await setup?.close();await manager?.close();await observationsClosed;}finally{await hostLab.close().catch(()=>{});await unlock();}throw error;}
}
