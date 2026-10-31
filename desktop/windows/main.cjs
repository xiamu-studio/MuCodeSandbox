'use strict';
const {app,BrowserWindow,session,Menu,dialog,powerMonitor,ipcMain,clipboard,nativeImage,ClipboardItem}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const crypto=require('node:crypto');
const {createController}=require('./controller.cjs');
const {allowedRequest,statusDocument,startupStatus}=require('./policy.cjs');

if(process.platform!=='win32'){app.quit();throw Error('Windows desktop entry requires Windows');}
app.setName('MuCodeSandbox Windows Preview');app.setAppUserModelId('local.mucodesandbox.windows.preview');
const preview=path.join(process.env.LOCALAPPDATA||app.getPath('appData'),'MuCodeSandbox-WindowsPreview');app.setPath('userData',process.env.MU_WINDOWS_DESKTOP_USER_DATA_DIR||path.join(preview,'desktop'));
app.enableSandbox();app.commandLine.appendSwitch('disable-background-networking');app.commandLine.appendSwitch('disable-quic');
const {createStartupHealth,startupFileWriter}=require('./startup-health.cjs');
const startupHealth=createStartupHealth({write:startupFileWriter(path.join(app.getPath('userData'),'startup-health')),windowState:()=>{
 if(!window||window.isDestroyed())return {};
 const bounds=window.getContentBounds(),web=window.webContents;
 return {visible:window.isVisible(),focused:window.isFocused(),minimized:window.isMinimized(),contentWidth:bounds.width,contentHeight:bounds.height,loadingMainFrame:web.isLoadingMainFrame(),backgroundThrottling:web.getBackgroundThrottling()};
}});
let window,controller,origin,hostLabWindowKey,quitting=false,closing,controllerOptions,mode='normal',generation=0,clipboardGeneration=0;
const hostLabWindows=require('./host-lab.cjs').createHostLabWindows({BrowserWindow,session,getState:()=>({window,origin,key:hostLabWindowKey,normal:mode==='normal'&&!quitting&&!closing,epoch:generation+':'+clipboardGeneration})});
ipcMain.handle('mu-windows:host-lab-open',(event,value)=>hostLabWindows.open(event,value));
ipcMain.handle('mu-windows:host-lab-close',(event,value)=>hostLabWindows.close(event,value));
const viewerFullscreen=require('./viewer-fullscreen.cjs').createViewerFullscreenController({getState:()=>({window,origin,normal:mode==='normal'&&!quitting&&!closing,epoch:generation+':'+clipboardGeneration}),notify:(web,value)=>web.send('mu-windows:viewer-fullscreen-state',value)});
ipcMain.handle('mu-windows:viewer-fullscreen',(event,value)=>viewerFullscreen.handle(event,value));
ipcMain.handle('mu-windows:clipboard-image',require('./clipboard-image.cjs').createClipboardImageHandler({clipboard,nativeImage,getState:()=>({window,origin,normal:mode==='normal'&&!quitting&&!closing,epoch:generation+':'+clipboardGeneration})}));
ipcMain.handle('mu-windows:clipboard-image-write',require('./clipboard-image-write.cjs').createClipboardImageWriteHandler({clipboard,nativeImage,ClipboardItem,getState:()=>({window,origin,normal:mode==='normal'&&!quitting&&!closing,epoch:generation+':'+clipboardGeneration})}));
ipcMain.handle('mu-windows:clipboard-text',require('./clipboard-text.cjs').createClipboardTextHandler({clipboard,getState:()=>({window,origin,normal:mode==='normal'&&!quitting&&!closing,epoch:generation+':'+clipboardGeneration})}));
ipcMain.handle('mu-windows:backup-file',require('./backup-dialog.cjs').createBackupDialogHandler({dialog,getState:()=>({window,origin,normal:mode==='normal'&&!quitting&&!closing,epoch:generation+':'+clipboardGeneration})}));
const locked=app.requestSingleInstanceLock();if(!locked)app.quit();
ipcMain.on('mu-windows:ui-dom-content',(event,...args)=>{if(!args.length)startupHealth.rendered(event,window,origin);});
function status(title,detail){viewerFullscreen.reset();void hostLabWindows.reset().catch(()=>{});hostLabWindowKey=undefined;origin=undefined;if(window&&!window.isDestroyed()){const navigation=startupHealth.begin('status');try{void window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(statusDocument(title,detail))).catch(error=>startupHealth.loadFailed(navigation,error));}catch(error){startupHealth.loadFailed(navigation,error);}}}
async function close(){if(closing)return closing;generation++;closing=(async()=>{status(mode==='recovery'?'正在关闭恢复模式':'正在关闭 Windows 环境',mode==='recovery'?'正在结束核验，原盘和管理资料会保留。':'正在撤销联网许可并确认虚拟机已停止。');try{await controller?.close();quitting=true;app.quit();}catch(error){const result=await dialog.showMessageBox(window,{type:'error',title:'尚未确认环境停止',message:error.message,buttons:['重试停止','退出并交由独立防护组件停机'],defaultId:0,cancelId:0,noLink:true});closing=undefined;if(result.response===0)return close();controller?.terminate();quitting=true;app.quit();}})();return closing;}
async function startMode(requested){
 if(!controllerOptions||quitting||closing)return;const ticket=++generation,previous=controller;
 if(previous){status('正在切换 Windows 模式','正在结束当前管理会话。');try{await previous.close();}catch(error){if(ticket===generation){status('尚未完成模式切换',error.message);await dialog.showMessageBox(window,{type:'error',title:'尚未完成模式切换',message:error.message,buttons:['知道了']});}return;}}
 if(ticket!==generation||quitting||closing)return;mode=requested;
 status(requested==='recovery'?'正在进入原环境恢复':'正在启动 Windows 防护','正在检查本机组件；如需管理员确认，Windows 会显示提示。');
 const current=createController({...controllerOptions,mode:requested});controller=current;
 current.events.on('status',phase=>{if(ticket!==generation||quitting||closing||origin)return;const value=startupStatus(requested,phase);if(value){startupHealth.note('worker-phase',{phase});status(value.title,value.detail);}});
 current.events.on('failure',()=>{if(ticket===generation&&!quitting)status('Windows 管理进程不可用','请退出后重新启动；独立组件会撤销连接并尝试关闭环境。');});
 current.events.on('exit',()=>{if(ticket===generation&&!quitting&&!closing&&origin)status('Windows 管理进程已退出','请退出后重新启动。');});
 current.events.on('mode-request',()=>{if(ticket===generation&&!quitting&&!closing)void startMode('normal');});
 try{const ready=await current.ready;if(ticket!==generation||quitting||closing)return;origin=ready.origin;hostLabWindowKey=ready.hostLabWindowKey;const navigation=startupHealth.begin('workspace');try{await window.loadURL(ready.url);}catch(error){startupHealth.loadFailed(navigation,error);throw error;}}
 catch(error){if(ticket!==generation||quitting||closing)return;status('Windows 桌面启动失败',error.message);const result=await dialog.showMessageBox(window,{type:'error',title:'Windows 桌面预览',message:error.message,detail:'原环境登记丢失时，可进入恢复模式核验原虚拟机和磁盘。',buttons:['重试工作区','恢复已有环境','退出'],defaultId:0,cancelId:2,noLink:true});if(ticket!==generation||quitting||closing)return;if(result.response===2)void close();else void startMode(result.response===1?'recovery':'normal');}
}
async function enterRecovery(){
 if(mode==='normal'&&origin){const ticket=generation,result=await dialog.showMessageBox(window,{type:'question',title:'进入原环境恢复',message:'进入恢复模式会停止当前环境，并关闭终端、浏览器和文件传输。请先保存工作。',buttons:['进入恢复模式','取消'],defaultId:1,cancelId:1,noLink:true});if(result.response!==0||ticket!==generation||quitting||closing)return;}
 await startMode('recovery');
}
if(locked){
 app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
 app.on('before-quit',event=>{if(!quitting){event.preventDefault();void close();}});
 app.on('window-all-closed',()=>{if(!quitting)void close();});
 app.whenReady().then(async()=>{
  const uiSession=session.fromPartition('persist:windows-manager');await uiSession.setProxy({mode:'direct'});uiSession.setPermissionRequestHandler((_web,_permission,callback)=>callback(false));uiSession.setPermissionCheckHandler(()=>false);
  uiSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!allowedRequest(origin,details.url,details.resourceType==='mainFrame')}));
  window=new BrowserWindow({width:1280,height:900,minWidth:720,minHeight:520,title:'MuCodeSandbox · Windows',backgroundColor:'#eef4f1',webPreferences:{session:uiSession,preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,spellcheck:false,navigateOnDragDrop:false}});
  for(const trigger of ['ready-to-show','show','hide','focus','blur','minimize','restore'])window.on(trigger,()=>startupHealth.note('window-state',{trigger}));
  window.webContents.on('dom-ready',()=>startupHealth.note('dom-ready'));
  window.webContents.on('did-finish-load',()=>startupHealth.note('load-finished'));
  window.webContents.on('did-fail-load',(_event,code,_description,_url,mainFrame)=>startupHealth.note('load-event-failed',{code,mainFrame}));
  window.webContents.on('preload-error',()=>startupHealth.note('preload-error'));
  window.webContents.on('console-message',event=>startupHealth.note('renderer-console',{category:startupHealth.consoleCategory(event.message)}));
  window.webContents.on('render-process-gone',(_event,details)=>startupHealth.note('renderer-gone',{reason:details.reason,code:details.exitCode}));
  window.on('unresponsive',()=>startupHealth.note('unresponsive'));window.on('responsive',()=>startupHealth.note('responsive'));
  window.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame){viewerFullscreen.reset();clipboardGeneration++;}});
  window.on('leave-full-screen',()=>viewerFullscreen.nativeLeft());
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.webContents.on('render-process-gone',()=>{if(!quitting&&!closing)void close();});powerMonitor.on('suspend',()=>{if(!quitting&&!closing)void close();});
  for(const name of ['will-navigate','will-redirect'])window.webContents.on(name,(event,url)=>{if(!allowedRequest(origin,url,true))event.preventDefault();});
  window.on('close',event=>{if(!quitting){event.preventDefault();void close();}});
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'文件',submenu:[{label:'恢复已有环境…',click:()=>void enterRecovery()},{type:'separator'},{label:'退出',accelerator:'Alt+F4',click:()=>void close()}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'视图',submenu:[{role:'reload'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]}]));
  status('正在启动 Windows 防护','正在检查本机组件；如需管理员确认，Windows 会显示提示。');
  const rootDir=path.resolve(__dirname,'../..'),node=app.isPackaged?path.join(process.resourcesPath,'node','node.exe'):process.env.MU_WINDOWS_NODE_EXE,entry=path.join(rootDir,'dist-server/server/platform/windows/desktop-worker.js');
  if(!node)throw Error('源码桌面预览需要指定已验证的 Node 24.15.0 运行时');
  if(app.isPackaged){const manifest=JSON.parse(fs.readFileSync(path.join(process.resourcesPath,'windows-runtime-manifest.json'),'utf8'));if(crypto.createHash('sha256').update(fs.readFileSync(node)).digest('hex')!==manifest.node.sha256)throw Error('内置 Node 运行时校验失败');}
  controllerOptions={node,entry,rootDir,environment:{MU_WINDOWS_DATA_DIR:process.env.MU_WINDOWS_DATA_DIR,MU_WINDOWS_APP_DIR:process.env.MU_WINDOWS_APP_DIR}};
  await startMode(process.argv.includes('--recover-storage')?'recovery':'normal');
 }).catch(async error=>{status('Windows 桌面启动失败',error.message);await dialog.showMessageBox(window,{type:'error',title:'Windows 桌面预览',message:error.message,buttons:['退出']});quitting=true;controller?.terminate();app.quit();});
}
