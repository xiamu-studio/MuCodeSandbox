'use strict';
// Local synthetic receivers only. No clipboard API, shell, broker or guest VM.
const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const caseId=process.argv[process.argv.indexOf('--pro-ime-case')+1];
assert.match(caseId,/^[a-f0-9]{32}$/);assert.equal(process.platform,'win32');assert.equal(process.env.COMPUTERNAME,'MU-PRO-LAB');
const config=JSON.parse(fs.readFileSync('C:/MuLab/approved/ime-'+caseId+'-config.json','utf8'));
assert.equal(config.caseId,caseId);assert.equal(config.proNonce,JSON.parse(fs.readFileSync('C:/MuLab/public/provisioned.json','utf8')).nonce);
const {WebSocketServer}=require(config.support+'/product/resources/app/node_modules/ws');
const prefix='C:/MuLab/public/ime-'+caseId,root=path.resolve(config.tools,'ui');
const report={caseId,pid:process.pid,scope:'native-Windows-IME-with-synthetic-receivers',events:[],writes:[],keys:[],terminal:[],stopped:false,hostClipboardAccessed:false,aiWebsitesVisited:0};
const save=()=>{fs.writeFileSync(prefix+'-state.json.next',JSON.stringify(report,null,2));fs.renameSync(prefix+'-state.json.next',prefix+'-state.json');};
save();let origin='',window;
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,origin||'http://127.0.0.1');
 if(req.headers.host!==new URL(origin).host){res.writeHead(403).end();return;}
 const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
 if(req.method==='POST'){
  if(req.headers.origin!==origin){res.writeHead(403).end();return;}
  let body='',bytes=0;req.on('data',chunk=>{bytes+=chunk.length;if(bytes>262144)req.destroy();else body+=chunk;});
  req.on('end',()=>{try{
   const value=JSON.parse(body||'{}');
   if(url.pathname==='/telemetry'){assert.ok(report.events.length<10000);report.events.push(value);save();json({ok:true});}
   else if(url.pathname.endsWith('/clipboard/write')){assert.equal(typeof value.text,'string');report.writes.push(value.text);save();json({ok:true});}
   else if(url.pathname.endsWith('/clipboard/read'))json({text:'本地合成取回文字'});
   else if(url.pathname.endsWith('-ticket'))json({ticket:'fixture',password:'fixture8'});
   else res.writeHead(404).end();
  }catch(error){res.writeHead(400).end(String(error.message));}});return;
 }
 if(req.method!=='GET'){res.writeHead(405).end();return;}
 if(url.pathname==='/state'){json({writes:report.writes,terminal:report.terminal,events:report.events.slice(-3)});return;}
 let file;try{file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));}catch{res.writeHead(400).end();return;}
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
 const ext=path.extname(file);res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css'})[ext]||'application/octet-stream');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; object-src 'none'; frame-src 'none'");
 fs.createReadStream(file).pipe(res);
});
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{
 if(req.headers.origin!==origin||req.headers.host!==new URL(origin).host||!/^\/(guest-browser|terminal)\?ticket=fixture$/.test(req.url)){socket.destroy();return;}
 wss.handleUpgrade(req,socket,head,peer=>{
  if(req.url.startsWith('/terminal?')){peer.send(JSON.stringify({type:'connected'}));peer.send(JSON.stringify({type:'data',data:'\x1b[?2004h本地合成接收端（无 shell）'}));peer.on('message',raw=>{const value=JSON.parse(raw.toString());if(value.type==='input'){report.terminal.push(value.data);save();}});return;}
  let buffer=Buffer.alloc(0),stage='version';peer.send(Buffer.from('RFB 003.008\n'));
  peer.on('message',raw=>{buffer=Buffer.concat([buffer,Buffer.from(raw)]);while(buffer.length){
   if(stage==='version'){if(buffer.length<12)return;buffer=buffer.subarray(12);peer.send(Buffer.from([1,1]));stage='security';}
   else if(stage==='security'){buffer=buffer.subarray(1);peer.send(Buffer.alloc(4));stage='init';}
   else if(stage==='init'){buffer=buffer.subarray(1);const name=Buffer.from('Local synthetic receiver'),init=Buffer.alloc(24);init.writeUInt16BE(64,0);init.writeUInt16BE(40,2);init[4]=32;init[5]=24;init[7]=1;for(const n of [8,10,12])init.writeUInt16BE(255,n);init[14]=16;init[15]=8;init.writeUInt32BE(name.length,20);peer.send(Buffer.concat([init,name]));stage='messages';}
   else{const type=buffer[0];let size=0;if(type===0)size=20;else if(type===2){if(buffer.length<4)return;size=4+4*buffer.readUInt16BE(2);}else if(type===3||type===150)size=10;else if(type===4)size=8;else if(type===5)size=6;else if(type===6){if(buffer.length<8)return;size=8+buffer.readUInt32BE(4);}else{peer.close();return;}if(buffer.length<size)return;
    if(type===4){report.keys.push({key:buffer.readUInt32BE(4),down:!!buffer[1]});save();}if(type===3){const frame=Buffer.alloc(20);frame.writeUInt16BE(1,2);frame.writeUInt16BE(1,8);frame.writeUInt16BE(1,10);peer.send(frame);}buffer=buffer.subarray(size);
   }
  }});
 });
});
app.setPath('userData',prefix+'-electron');app.enableSandbox();app.commandLine.appendSwitch('disable-background-networking');app.commandLine.appendSwitch('disable-quic');
app.whenReady().then(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 const isolated=session.fromPartition('ime-'+caseId);await isolated.setProxy({mode:'direct'});isolated.setPermissionRequestHandler((_w,_p,cb)=>cb(false));isolated.setPermissionCheckHandler(()=>false);
 isolated.webRequest.onBeforeRequest((details,cb)=>{const url=new URL(details.url);cb({cancel:!((url.origin===origin||url.origin===origin.replace('http:','ws:'))&&!url.username&&!url.password)});});
 window=new BrowserWindow({title:'Mu Windows IME 验收',width:900,height:500,show:true,autoHideMenuBar:true,webPreferences:{session:isolated,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin)event.preventDefault();});
 window.on('closed',()=>app.quit());window.maximize();await window.loadURL(origin);window.focus();
 const started=Date.now();setInterval(()=>{if(fs.existsSync(prefix+'-stop.json')||Date.now()-started>30*60*1000)app.quit();},500).unref();
}).catch(error=>{report.error=error.stack;save();app.exit(1);});
app.on('will-quit',()=>{report.stopped=true;save();for(const peer of wss.clients)peer.terminate();wss.close();server.close();});app.on('window-all-closed',()=>app.quit());
