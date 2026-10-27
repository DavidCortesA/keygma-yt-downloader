const { contextBridge, ipcRenderer } = require('electron');

/**
 * Puente seguro entre la interfaz y el proceso principal.
 * La interfaz solo puede llamar a estas funciones; no tiene acceso a Node.
 */
contextBridge.exposeInMainWorld('kerygma', {
  init: () => ipcRenderer.invoke('app:init'),
  engineVersion: () => ipcRenderer.invoke('engine:version'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  chooseFolder: (current) => ipcRenderer.invoke('dialog:chooseFolder', current),
  getInfo: (url) => ipcRenderer.invoke('video:info', url),
  startDownload: (req) => ipcRenderer.invoke('download:start', req),
  cancelDownload: () => ipcRenderer.invoke('download:cancel'),
  showItem: (filePath) => ipcRenderer.invoke('shell:showItem', filePath),
  openFolder: (dir) => ipcRenderer.invoke('shell:openFolder', dir),
  updateEngine: () => ipcRenderer.invoke('engine:update'),
  onDownloadEvent: (callback) => {
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on('download:event', listener);
    return () => ipcRenderer.removeListener('download:event', listener);
  },
});
