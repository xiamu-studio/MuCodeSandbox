const { app, BrowserWindow, WebContentsView, session, ipcMain, dialog, Menu, powerMonitor, clipboard, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { configureIdentity } = require('./identity.cjs');

app.setName('MuCodeSandbox');
if (process.env.MU_DESKTOP_USER_DATA_DIR) app.setPath('userData', process.env.MU_DESKTOP_USER_DATA_DIR);
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
app.commandLine.appendSwitch('disable-quic');
let service;
let mainWindow;
let quitting = false;
const browsers = new Map();
const guestWindows=new Map();
// Native editing menu for our local forms only; never intercept the remote canvas.
function installLocalEditMenu(window) {
  window.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable || !service) return;
    try { if (new URL(window.webContents.getURL()).origin !== service.url || new URL(params.frameURL || params.pageURL).origin !== service.url) return; } catch { return; }
    const flags=params.editFlags;
    Menu.buildFromTemplate([
      {label:'撤销',role:'undo',enabled:flags.canUndo},
      {label:'重做',role:'redo',enabled:flags.canRedo},
      {type:'separator'},
      {label:'剪切',role:'cut',enabled:flags.canCut},
      {label:'复制',role:'copy',enabled:flags.canCopy},
      {label:'粘贴',role:'paste',enabled:flags.canPaste},
      {type:'separator'},
      {label:'全选',role:'selectAll',enabled:flags.canSelectAll},
    ]).popup({window});
  });
}
async function browserSetup(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('浏览器环境初始化超时')), 30_000); })]); }
  finally { clearTimeout(timer); }
}
const browserHost = {
  native: true,
  async available() { return true; },
  async openGuest(environment,url){
    const existing=guestWindows.get(environment.id);if(existing){existing.show();existing.focus();return;}
    const window=new BrowserWindow({width:1320,height:900,minWidth:620,minHeight:400,title:`${environment.name} · Linux 浏览器`,backgroundColor:'#f7f8fa',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    guestWindows.set(environment.id,window);
    installLocalEditMenu(window);
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,target)=>{if(new URL(target).origin!==service.url)event.preventDefault();});
    window.on('closed',()=>guestWindows.delete(environment.id));
    await window.loadURL(url);
  },
  async showGuestApplication(environment,target,application){
    if(mainWindow&&!mainWindow.isDestroyed()){mainWindow.show();mainWindow.focus();mainWindow.webContents.send('mu:guest-application',{id:environment.id,target,application});}
  },
  async closeGuest(id){const window=guestWindows.get(id);if(window&&!window.isDestroyed())window.close();guestWindows.delete(id);},
  running(id) { return browsers.has(id); },
  async open(environment) {
    const existing = browsers.get(environment.id);
    if (existing) { existing.window.show(); existing.window.focus(); return; }
    if (environment.network.mode === 'socks5' && (environment.network.username || environment.network.password)) throw new Error('Chromium 暂不支持带账号密码的 SOCKS5 代理，请使用 HTTP 代理打开浏览器');
    const profile = session.fromPartition(`persist:mu-${environment.id}`);
    profile.setUserAgent(profile.getUserAgent(), `${environment.identity.locale},${environment.identity.locale.split('-')[0]}`);
    const n = environment.network;
    await profile.setProxy(n.mode === 'direct'
      ? { mode: 'direct' }
      : { mode: 'fixed_servers', proxyRules: `${n.mode}://${n.host.includes(':') ? `[${n.host}]` : n.host}:${n.port}`, proxyBypassRules: `<-loopback>;${n.noProxy.replace(/,/g, ';')}` });
    await profile.closeAllConnections();
    profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    profile.setPermissionCheckHandler(() => false);
    const window = new BrowserWindow({ width: 1220, height: 850, minWidth: 620, minHeight: 400, title: `${environment.name} · MuCodeSandbox`, backgroundColor: '#f7f8fa', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const view = new WebContentsView({ webPreferences: { session: profile, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    window.contentView.addChildView(view);
    try {
      await browserSetup(view.webContents.loadURL(pathToFileURL(path.join(__dirname, 'identity.html')).href));
      view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      await configureIdentity(view.webContents, environment.identity, browserSetup, error => {
        service?.manager.store.log(environment.id, null, `浏览器特征配置失败：${error.message}`, 'error');
        if (!window.isDestroyed()) window.close();
      });
    } catch (error) { view.webContents.close(); window.close(); throw error; }
    const fit = () => { const [width, height] = window.getContentSize(); view.setBounds({ x: 0, y: 72, width, height: Math.max(0, height - 72) }); };
    window.on('resize', fit); fit();
    const entry = { window, view, environment };
    browsers.set(environment.id, entry);
    const allowed = url => { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; } };
    view.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
    view.webContents.setWindowOpenHandler(({ url }) => { if (allowed(url)) void view.webContents.loadURL(url).catch(() => {}); return { action: 'deny' }; });
    const sendState = () => { if (!window.isDestroyed()) window.webContents.send('mu:browser-state', { url: view.webContents.getURL(), title: view.webContents.getTitle(), loading: view.webContents.isLoading(), canGoBack: view.webContents.navigationHistory.canGoBack(), canGoForward: view.webContents.navigationHistory.canGoForward() }); };
    for (const event of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']) view.webContents.on(event, sendState);
    window.on('closed', () => { browsers.delete(environment.id); if (!view.webContents.isDestroyed()) view.webContents.close(); });
    await window.loadURL(service.launchUrl(`/?browser=${environment.id}`));
    const { localBrowserStartUrl } = await import(pathToFileURL(path.join(app.getAppPath(), 'dist-server/server/browser-startpage.js')).href);
    await view.webContents.loadURL(localBrowserStartUrl(environment.browserUrl)).catch(() => {});
    sendState();
  },
  async close(id) { const entry = browsers.get(id); if (entry) await new Promise(resolve => { entry.window.once('closed', resolve); entry.window.close(); }); },
  async inspect(id) {
    const entry = browsers.get(id);
    if (!entry) throw new Error('浏览器已关闭');
    const actual = await entry.view.webContents.executeJavaScript(`(() => ({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale, language: navigator.language, languages: [...navigator.languages], platform: navigator.platform, userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGiB: navigator.deviceMemory ?? null, screenWidth: screen.width, screenHeight: screen.height }))()`);
    const expectedZone = new Intl.DateTimeFormat('en-US', { timeZone: entry.environment.identity.timezone }).resolvedOptions().timeZone;
    return { ...actual, webRtcPolicy: entry.view.webContents.getWebRTCIPHandlingPolicy(), matchesConfiguration: actual.timezone === expectedZone && actual.language === entry.environment.identity.locale && actual.locale === entry.environment.identity.locale, checkedAt: new Date().toISOString() };
  },
  async clear(id) {
    await this.close(id);
    const profile = session.fromPartition(`persist:mu-${id}`);
    await profile.clearStorageData(); await profile.clearCache(); await profile.closeAllConnections();
  },
  async dispose() { for (const { window } of browsers.values()) window.close(); },
};

function trusted(event) { return service && event.senderFrame?.url.startsWith(`${service.url}/`); }
ipcMain.handle('mu:clipboard-image',event=>require('./clipboard-image.cjs').readClipboardImage(event,{clipboard,nativeImage,allowed:event=>{
  if(!trusted(event)||event.senderFrame!==event.sender.mainFrame)return false;
  return event.sender===mainWindow?.webContents||[...guestWindows.values()].some(window=>!window.isDestroyed()&&event.sender===window.webContents);
}}));
ipcMain.handle('mu:browser-action', async (event, input) => {
  if (!trusted(event) || !input || typeof input.id !== 'string') throw new Error('Invalid sender');
  const entry = browsers.get(input.id);
  if (!entry || entry.window.webContents.id !== event.sender.id) throw new Error('Invalid browser window');
  const contents = entry.view.webContents;
  if (input.action === 'navigate') {
    const url = new URL(input.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are allowed');
    await contents.loadURL(url.href).catch(() => {});
  } else if (input.action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  else if (input.action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
  else if (input.action === 'reload') contents.reload();
});

app.on('login', (event, webContents, _request, authInfo, callback) => {
  const entry = [...browsers.values()].find(b => b.view.webContents.id === webContents.id);
  if (entry && authInfo.isProxy && authInfo.host === entry.environment.network.host && authInfo.port === entry.environment.network.port) {
    event.preventDefault(); callback(entry.environment.network.username, entry.environment.network.password ?? '');
  }
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.whenReady().then(async () => {
    const rootDir = app.getAppPath();
    const { createService } = await import(pathToFileURL(path.join(rootDir, 'dist-server/server/service.js')).href);
    const serviceOptions = { rootDir, port: 4367, browser: browserHost, picker: async () => {
      const result = await dialog.showOpenDialog(mainWindow, { title: '选择项目目录', properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    }, backupPicker: async mode => {
      const filters = [{ name: 'MuCodeSandbox 备份', extensions: ['mu-backup'] }];
      if (mode === 'save') {
        const result = await dialog.showSaveDialog(mainWindow, { title: '导出加密备份', defaultPath: `MuCodeSandbox-${new Date().toISOString().slice(0, 10)}.mu-backup`, filters, properties: ['createDirectory'] });
        return result.canceled ? null : result.filePath;
      }
      const result = await dialog.showOpenDialog(mainWindow, { title: '导入加密备份', filters, properties: ['openFile'] });
      return result.canceled ? null : result.filePaths[0];
    } };
    try { service = await createService(serviceOptions); }
    catch (error) { if (error.code !== 'EADDRINUSE') throw error; service = await createService({ ...serviceOptions, port: 0 }); }
    for (const event of ['suspend', 'resume']) powerMonitor.on(event, () => {
      void service.manager.handleHostPowerEvent(event).catch(error => {
        if (!quitting) service.manager.store.log(null, null, `休眠防护处理失败：${error.message}`, 'error');
      });
    });
    fs.writeFileSync(path.join(service.manager.store.dataDir, 'service-info.json'), JSON.stringify({ url: service.url, launchUrl:service.launchUrl(), pid: process.pid }), { mode: 0o600 });
    mainWindow = new BrowserWindow({ width: 1360, height: 900, minWidth: 860, minHeight: 620, title: 'MuCodeSandbox', backgroundColor: '#f7f8fa', webPreferences: { preload:path.join(__dirname,'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    installLocalEditMenu(mainWindow);
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${service.url}/`)) event.preventDefault(); });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'MuCodeSandbox', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
    await mainWindow.loadURL(service.launchUrl());
  }).catch(error => { dialog.showErrorBox('MuCodeSandbox 启动失败', error.message); app.quit(); });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (service && !quitting) {
    event.preventDefault(); quitting = true;
    void service.close().finally(() => app.quit());
  }
});
