'use strict';
// Diagnostic host loads the installed renderer/preload/IPC modules unchanged.
// It does not replace the product main or automate administrator authentication.
const {app,BrowserWindow,session,ipcMain,dialog}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
assert.equal(process.env.COMPUTERNAME,'MU-CLEAN-LAB');
const file=process.argv.find(value=>/^C:\/MuLab\/public\/backup-gui-launch-[a-f0-9]{64}\.json$/.test(value));assert.ok(file);
const config=JSON.parse(fs.readFileSync(file,'utf8'));assert.match(config.nonce,/^[a-f0-9]{64}$/);
const {launchOrigin,allowedRequest}=require(config.product+'/desktop/windows/policy.cjs');
const {createBackupDialogHandler}=require(config.product+'/desktop/windows/backup-dialog.cjs');
const origin=launchOrigin(config.url);let window,epoch=0;
app.setPath('userData',config.profile);app.enableSandbox();app.commandLine.appendSwitch('disable-background-networking');app.commandLine.appendSwitch('disable-quic');
const record=value=>fs.writeFileSync('C:/MuLab/public/backup-gui-dialog-'+config.nonce+'.json',JSON.stringify({nonce:config.nonce,...value}));
const actualDialog={};for(const [name,action] of [['showSaveDialog','export'],['showOpenDialog','restore']])actualDialog[name]=async(...args)=>{record({action,phase:'opening'});try{const value=await dialog[name](...args);record({action,phase:'closed',cancelled:value.canceled});return value;}catch(error){record({action,phase:'failed',message:error.message});throw error;}};
ipcMain.handle('mu-windows:backup-file',createBackupDialogHandler({dialog:actualDialog,getState:()=>({window,origin,epoch,normal:true})}));
app.whenReady().then(async()=>{
 const isolated=session.fromPartition('backup-gui-local-only');await isolated.setProxy({mode:'direct'});isolated.setPermissionRequestHandler((_w,_p,done)=>done(false));isolated.setPermissionCheckHandler(()=>false);
 isolated.webRequest.onBeforeRequest((request,done)=>done({cancel:!allowedRequest(origin,request.url,request.resourceType==='mainFrame')}));
 window=new BrowserWindow({width:1280,height:960,show:true,webPreferences:{session:isolated,preload:path.join(config.product,'desktop/windows/preload.cjs'),nodeIntegration:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,spellcheck:false}});
 window.webContents.on('did-start-navigation',(_e,_u,_i,main)=>{if(main)epoch++;});window.webContents.setWindowOpenHandler(()=>({action:'deny'}));await window.loadURL(config.url);
});
app.on('window-all-closed',()=>setTimeout(()=>app.quit(),250));
