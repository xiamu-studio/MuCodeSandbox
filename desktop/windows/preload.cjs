'use strict';
const {contextBridge,ipcRenderer}=require('electron');
if(process.isMainFrame)window.addEventListener('DOMContentLoaded',()=>{
 const root=document.getElementById('root');if(!root)return;
 let reported=false;const observer=new MutationObserver(check);
 function check(){if(!reported&&root.childElementCount>0){reported=true;observer.disconnect();ipcRenderer.send('mu-windows:ui-dom-content');}}
 observer.observe(root,{childList:true,subtree:true});window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});check();
},{once:true});
if(process.isMainFrame)contextBridge.exposeInMainWorld('muWindowsDesktop',{openHostLab:value=>ipcRenderer.invoke('mu-windows:host-lab-open',value),closeHostLab:runId=>ipcRenderer.invoke('mu-windows:host-lab-close',{runId}),chooseBackupFile:action=>ipcRenderer.invoke('mu-windows:backup-file',action),readClipboardImage:()=>ipcRenderer.invoke('mu-windows:clipboard-image'),writeClipboardImage:data=>ipcRenderer.invoke('mu-windows:clipboard-image-write',{data}),readClipboardText:()=>ipcRenderer.invoke('mu-windows:clipboard-text',{action:'read'}),writeClipboardText:text=>ipcRenderer.invoke('mu-windows:clipboard-text',{action:'write',text}),setViewerFullscreen:value=>ipcRenderer.invoke('mu-windows:viewer-fullscreen',value),onViewerFullscreenChange:listener=>{const receive=(_event,value)=>{if(typeof value==='boolean')listener(value);};ipcRenderer.on('mu-windows:viewer-fullscreen-state',receive);return()=>ipcRenderer.removeListener('mu-windows:viewer-fullscreen-state',receive);}});
