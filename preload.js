const { contextBridge, ipcRenderer } = require('electron');

// 通过 contextBridge 暴露最小化 API，避免在预检窗口开启 nodeIntegration
contextBridge.exposeInMainWorld('precheck', {
  onResult: (cb) => ipcRenderer.on('precheck:result', (_e, r) => cb(r)),
  onLog: (cb) => ipcRenderer.on('precheck:log', (_e, t) => cb(t)),
  onDone: (cb) => ipcRenderer.on('precheck:done', (_e, p) => cb(p)),
  install: () => ipcRenderer.send('precheck:install'),
  cancel: () => ipcRenderer.send('precheck:cancel'),
  copy: (text) => ipcRenderer.invoke('precheck:copy', text),
});
