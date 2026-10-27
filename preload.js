const { contextBridge, ipcRenderer } = require('electron');

/**
 * Puente seguro entre la interfaz y el proceso principal.
 * La interfaz solo puede llamar a estas funciones; no tiene acceso a Node.
 */
const listen = (channel) => (callback) => {
  const listener = (_e, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('kerygma', {
  init: () => ipcRenderer.invoke('app:init'),
  engineVersion: () => ipcRenderer.invoke('engine:version'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  chooseFolder: (current) => ipcRenderer.invoke('dialog:chooseFolder', current),
  getInfo: (url, opts) => ipcRenderer.invoke('video:info', url, opts),
  startDownload: (req) => ipcRenderer.invoke('download:start', req),
  cancelDownload: () => ipcRenderer.invoke('download:cancel'),
  showItem: (filePath) => ipcRenderer.invoke('shell:showItem', filePath),
  openFolder: (dir) => ipcRenderer.invoke('shell:openFolder', dir),
  updateEngine: () => ipcRenderer.invoke('engine:update'),
  historyList: () => ipcRenderer.invoke('history:list'),
  historyRemove: (id) => ipcRenderer.invoke('history:remove', id),
  historyClear: () => ipcRenderer.invoke('history:clear'),
  clipboardLink: () => ipcRenderer.invoke('clipboard:link'),
  installUpdate: () => ipcRenderer.invoke('app:update-install'),
  onDownloadEvent: listen('download:event'),
  onEngineUpdated: listen('engine:updated'),
  onAppUpdate: listen('app:update'),
});
