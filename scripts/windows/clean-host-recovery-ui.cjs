'use strict';
const {app,BrowserWindow,session}=require('electron');
const {allowedRequest}=require('C:/MuLab/product/resources/app/desktop/windows/policy.cjs');
const launch=process.argv.find(value=>/^http:\/\/127\.0\.0\.1:\d+\//.test(value)),origin=new URL(launch).origin;
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw Error('An exact local recovery service is required');
app.enableSandbox();app.commandLine.appendSwitch('disable-background-networking');app.commandLine.appendSwitch('disable-quic');
app.whenReady().then(async()=>{
 const isolated=session.fromPartition('recovery-local-only');await isolated.setProxy({mode:'direct'});isolated.setPermissionRequestHandler((_w,_p,done)=>done(false));isolated.setPermissionCheckHandler(()=>false);
 isolated.webRequest.onBeforeRequest((request,done)=>done({cancel:!allowedRequest(origin,request.url,request.resourceType==='mainFrame')}));
 const window=new BrowserWindow({width:1280,height:960,show:true,webPreferences:{session:isolated,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,spellcheck:false}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));await window.loadURL(launch);
});
app.on('window-all-closed',()=>app.quit());
