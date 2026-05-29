const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  loadLrc: (musicPath) => ipcRenderer.invoke('load-lrc', musicPath),
  readMeta: (paths) => ipcRenderer.invoke('read-meta', paths),
  httpGet: (url) => ipcRenderer.invoke('http-get', url),
  // QQ 音乐接口
  qqSearch: (keyword, limit) => ipcRenderer.invoke('qq-search', keyword, limit),
  qqUrl: (songmid) => ipcRenderer.invoke('qq-url', songmid),
  qqLyric: (songmid) => ipcRenderer.invoke('qq-lyric', songmid),
  // 网易云音乐:拉取歌单详情
  neteasePlaylist: (id) => ipcRenderer.invoke('netease-playlist', id),
  // 下载在线音频到本地(弹保存对话框)
  downloadFile: (url, suggestedName) => ipcRenderer.invoke('download-file', url, suggestedName),
  // 英文歌词翻译成中文(传入字符串数组,返回等长译文数组)
  translateLines: (lines) => ipcRenderer.invoke('translate-lines', lines),
  // 复制文本到系统剪贴板(交主进程写,最稳妥)
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  // 取拖拽 File 对象的真实磁盘路径(Electron 推荐方式)
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return file.path || ''; } }
});
