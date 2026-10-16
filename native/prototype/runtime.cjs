// Account-free native runtime prototype. NOT a system network filter.
// Only trusted, bundled synthetic content is served; no arbitrary URLs.
const {app, BrowserWindow, session, protocol} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(process.env.MU_NATIVE_PROTOTYPE || '{}');
const root = config.root;
if (!path.isAbsolute(root || '') || fs.realpathSync(root) !== root ||
    fs.readFileSync(path.join(root, '.mu-native-prototype'), 'utf8') !== 'owned-test-data\n' ||
    !['first', 'second'].includes(config.environment) || !['seed', 'inspect'].includes(config.action)) {
  throw new Error('Expected an explicitly owned, synthetic prototype directory');
}
const owned = path.join(root, config.environment);
fs.mkdirSync(owned, {recursive:true, mode:0o700});
const userData = path.join(owned, 'runtime');
app.setPath('userData', userData);
app.setPath('sessionData', path.join(owned, 'session'));
app.setPath('crashDumps', path.join(owned, 'crashes'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-quic');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
protocol.registerSchemesAsPrivileged([{scheme:'mu-native-test', privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>MuCodeSandbox · Native prototype</title>
<style>body{font:16px system-ui;margin:48px;background:#f3f7f6;color:#163d40}main{max-width:760px;margin:auto;padding:32px;background:white;border-radius:20px}textarea{box-sizing:border-box;width:100%;height:150px;padding:16px;font:inherit}small{color:#546869}</style>
<main><small>本机模式 · 离线测试</small><h1>直接在 Mac 上运行</h1><p>此窗口仅用于空白资料、渲染和输入测试。尚未启用系统网络防护，不能用于账号或外网。</p><textarea aria-label="输入测试" placeholder="在这里测试输入、复制和粘贴"></textarea><p id="saved"></p><canvas width="600" height="80"></canvas></main>
<script>const input=document.querySelector('textarea');input.value=localStorage.getItem('note')||'';input.oninput=()=>{localStorage.setItem('note',input.value);document.querySelector('#saved').textContent='已保存到本测试环境';};const ctx=document.querySelector('canvas').getContext('2d');ctx.fillStyle='#23816f';ctx.fillRect(0,0,600,80);ctx.fillStyle='white';ctx.font='24px system-ui';ctx.fillText('Native canvas · 真实 Mac 渲染',20,50);</script></html>`;
let window;
app.whenReady().then(async()=>{
  const profile = session.fromPath(path.join(owned,'profile'));
  // Defense for synthetic content only. This is NOT a claim that Chromium
  // background traffic, helpers or a compromised process are OS-confined.
  profile.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*','ftp://*/*']},(_details,done)=>done({cancel:true}));
  profile.setPermissionCheckHandler(()=>false);
  profile.setPermissionRequestHandler((_contents,_permission,done)=>done(false));
  profile.on('will-download',event=>event.preventDefault());
  profile.protocol.handle('mu-native-test',request=>{
    if(request.url!=='mu-native-test://home/')return new Response('',{status:404});
    return new Response(page,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'"}});
  });
  window = new BrowserWindow({width:1100,height:780,show:!!config.interactive,title:'MuCodeSandbox · 离线原型',webPreferences:{session:profile,contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(url!=='mu-native-test://home/')event.preventDefault();});
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  await window.loadURL('mu-native-test://home/');
  const before=await window.webContents.executeJavaScript('localStorage.getItem("note")');
  if(config.action==='seed'){
    await window.webContents.executeJavaScript('document.querySelector("textarea").value="synthetic note";document.querySelector("textarea").dispatchEvent(new Event("input"))');
    await profile.cookies.set({url:'https://fixture.invalid',name:'synthetic',value:'retained',expirationDate:Date.now()/1000+3600,secure:true,httpOnly:true});
  }
  const measured=await window.webContents.executeJavaScript(`(() => {
    const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl2')||canvas.getContext('webgl');
    const ext=gl&&gl.getExtension('WEBGL_debug_renderer_info');
    return {note:localStorage.getItem('note'),platform:navigator.platform,userAgent:navigator.userAgent,dpr:devicePixelRatio,
      canvas:!!document.querySelector('canvas').getContext('2d'),webgl:!!gl,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,
      nodeAvailable:typeof require!=='undefined',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};
  })()`);
  let requestBlocked=false;
  try{await profile.fetch('https://fixture.invalid/not-allowed');}catch{requestBlocked=true;}
  const preferences=window.webContents.getLastWebPreferences();
  const result={before,...measured,cookies:(await profile.cookies.get({url:'https://fixture.invalid'})).map(({name,value})=>({name,value})),requestBlocked,
    sandbox:preferences.sandbox,contextIsolation:preferences.contextIsolation,nodeIntegration:preferences.nodeIntegration,
    gpu:app.getGPUFeatureStatus(),systemNetworkProtection:false,externalBrowsingEnabled:false};
  profile.flushStorageData();await profile.cookies.flushStore();await profile.closeAllConnections();
  fs.writeFileSync(path.join(owned,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  if(config.interactive)window.on('closed',()=>app.quit());
  else { window.close();app.quit(); }
}).catch(error=>{console.error(error.message);app.exit(1);});
