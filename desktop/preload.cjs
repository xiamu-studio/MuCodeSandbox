const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('muDesktop', {
  readClipboardImage:()=>ipcRenderer.invoke('mu:clipboard-image'),
  onGuestApplication: callback=>{const handler=(_event,value)=>callback(value);ipcRenderer.on('mu:guest-application',handler);return()=>ipcRenderer.removeListener('mu:guest-application',handler);},
  browserAction: input => ipcRenderer.invoke('mu:browser-action', input),
  onBrowserState: callback => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('mu:browser-state', handler);
    return () => ipcRenderer.removeListener('mu:browser-state', handler);
  },
});
