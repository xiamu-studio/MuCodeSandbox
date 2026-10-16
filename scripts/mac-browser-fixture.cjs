const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const config = JSON.parse(process.env.MU_MAC_BROWSER_FIXTURE);
app.setPath('userData', config.dataDir);
app.commandLine.appendSwitch('disable-quic');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
app.whenReady().then(async () => {
  const profile = session.fromPartition('persist:fixture');
  await profile.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${config.proxyPort}`, proxyBypassRules: '<-loopback>' });
  const window = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { session: profile, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await window.loadURL(`http://127.0.0.1:${config.targetPort}/`);
  const measured = await window.webContents.executeJavaScript(`(async () => {
    const worker = new Worker(URL.createObjectURL(new Blob(['onmessage=()=>postMessage({language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})'],{type:'text/javascript'})));
    const child = await new Promise(resolve => {worker.onmessage=e=>resolve(e.data);worker.postMessage(null)});worker.terminate();
    const rtc = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${config.udpPort}'}]});rtc.createDataChannel('fixture');await rtc.setLocalDescription(await rtc.createOffer());await new Promise(r=>setTimeout(r,1000));rtc.close();
    return {title:document.title,worker:child,canvas:!!document.createElement('canvas').getContext('2d')};
  })()`);
  console.log('MU_BROWSER_RESULT=' + JSON.stringify({ ...measured, rendererSandbox: window.webContents.getLastWebPreferences().sandbox }));
  window.close(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
