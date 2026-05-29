const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  loadLrc: (musicPath) => ipcRenderer.invoke('load-lrc', musicPath),
  readMeta: (paths) => ipcRenderer.invoke('read-meta', paths),
  // 取拖拽 File 对象的真实磁盘路径(Electron 推荐方式)
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return file.path || ''; } }
});
