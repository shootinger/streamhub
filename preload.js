const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Fenêtre
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),

  // Mises à jour
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  startDownload: () => ipcRenderer.invoke('start-download'),
  installAndRestart: () => ipcRenderer.invoke('install-and-restart'),
  onDownloadProgress: (cb) => ipcRenderer.on('update-download-progress', (_e, pct) => cb(pct)),
  onDownloadReady: (cb) => ipcRenderer.on('update-download-ready', (_e, v) => cb(v)),
  onDownloadError: (cb) => ipcRenderer.on('update-download-error', (_e, msg) => cb(msg)),
});
