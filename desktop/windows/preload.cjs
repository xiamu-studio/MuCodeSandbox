'use strict';
const {contextBridge,ipcRenderer}=require('electron');
if(process.isMainFrame)contextBridge.exposeInMainWorld('muWindowsDesktop',{readClipboardImage:()=>ipcRenderer.invoke('mu-windows:clipboard-image'),readClipboardText:()=>ipcRenderer.invoke('mu-windows:clipboard-text',{action:'read'}),writeClipboardText:text=>ipcRenderer.invoke('mu-windows:clipboard-text',{action:'write',text})});
