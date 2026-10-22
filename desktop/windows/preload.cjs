'use strict';
const {contextBridge,ipcRenderer}=require('electron');
if(process.isMainFrame)contextBridge.exposeInMainWorld('muWindowsDesktop',{readClipboardImage:()=>ipcRenderer.invoke('mu-windows:clipboard-image')});
