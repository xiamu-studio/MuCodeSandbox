'use strict';
// This is a diagnostic main, never a product startup option. OS clipboard I/O
// is restricted to the synthetic ordinary account inside the disconnected Pro VM.
const {app,BrowserWindow,session,ipcMain,clipboard,ClipboardItem,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const caseId=process.argv[process.argv.indexOf('--pro-image-case')+1];assert.match(caseId,/^[a-f0-9]{32}$/);assert.equal(process.platform,'win32');assert.equal(process.env.COMPUTERNAME,'MU-PRO-LAB');
const config=JSON.parse(fs.readFileSync('C:/MuLab/approved/image-'+caseId+'-config.json','utf8')),provisioned=JSON.parse(fs.readFileSync('C:/MuLab/public/provisioned.json','utf8')),launch=JSON.parse(fs.readFileSync('C:/MuLab/public/image-'+caseId+'-launch.json','utf8'));assert.equal(config.proNonce,provisioned.nonce);assert.equal(config.caseId,caseId);assert.equal(launch.caseId,caseId);
const product=config.tools+'/product/resources/app',{launchOrigin,allowedRequest}=require(product+'/desktop/windows/policy.cjs'),origin=launchOrigin(launch.url);let window,epoch=0,closing=false;
const stats={reads:0,formats:[],failures:[],expectedPng:null};global.muImageFixture=stats;
app.setPath('userData','C:/MuLab/public/image-'+caseId+'-electron');app.enableSandbox();app.commandLine.appendSwitch('disable-background-networking');app.commandLine.appendSwitch('disable-quic');
const read=require(product+'/desktop/windows/clipboard-image.cjs').createClipboardImageHandler({getState:()=>({window,origin,epoch,normal:!closing}),nativeImage,clipboard:{async read(){stats.reads++;const items=await clipboard.read();return items.map(item=>({types:item.types,getType:type=>{stats.formats.push(type);assert.equal(type,'image/png');return item.getType(type);}}));}}});
ipcMain.handle('mu-windows:clipboard-image',async event=>{try{const result=await read(event);stats.expectedPng=Buffer.from(result.data).toString('base64');return result;}catch(error){stats.failures.push(error.message);throw error;}});
app.whenReady().then(async()=>{
 const material=Buffer.from(config.png,'base64');stats.expectedPng=nativeImage.createFromBuffer(material).toPNG().toString('base64');
 await clipboard.write([new ClipboardItem({'image/png':new Blob([material],{type:'image/png'}),'text/plain':new Blob(['SYNTHETIC_SECONDARY_FORMAT_NOT_TO_READ'],{type:'text/plain'})})]);
 const isolated=session.fromPartition('image-'+caseId);await isolated.setProxy({mode:'direct'});isolated.setPermissionRequestHandler((_web,_permission,callback)=>callback(false));isolated.setPermissionCheckHandler(()=>false);isolated.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!allowedRequest(origin,details.url,details.resourceType==='mainFrame')}));
 window=new BrowserWindow({width:1280,height:900,show:true,webPreferences:{session:isolated,preload:path.join(product,'desktop/windows/preload.cjs'),nodeIntegration:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('did-start-navigation',(_e,_url,_place,main)=>{if(main)epoch++;});
 window.on('closed',()=>{closing=true;app.quit();});await window.loadURL(launch.url);window.focus();
}).catch(error=>{console.error(error.stack);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
