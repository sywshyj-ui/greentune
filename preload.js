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
  // 选择一个保存文件夹(批量下载用,只弹一次)
  pickSaveDir: () => ipcRenderer.invoke('pick-save-dir'),
  // 下载到指定文件夹(不弹保存框,批量下载用)
  downloadToDir: (url, dir, suggestedName) => ipcRenderer.invoke('download-to-dir', url, dir, suggestedName),
  // 英文歌词翻译成中文(传入字符串数组,返回等长译文数组)
  translateLines: (lines) => ipcRenderer.invoke('translate-lines', lines),
  // 复制文本到系统剪贴板(交主进程写,最稳妥)
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  // 取拖拽 File 对象的真实磁盘路径(Electron 推荐方式)
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return file.path || ''; } },

  // ===== 插件管理 =====
  pluginList: () => ipcRenderer.invoke('plugin:list'),
  pluginLoadFile: () => ipcRenderer.invoke('plugin:load-file'),
  pluginLoadUrl: (url) => ipcRenderer.invoke('plugin:load-url', url),
  pluginToggle: (id, enabled) => ipcRenderer.invoke('plugin:toggle', id, enabled),
  pluginRemove: (id) => ipcRenderer.invoke('plugin:remove', id),

  // ===== 统一音源接口 =====
  sourceSearch: (sourceId, keyword, page, type) => ipcRenderer.invoke('source:search', sourceId, keyword, page, type),
  sourceUrl: (sourceId, musicItem, quality) => ipcRenderer.invoke('source:url', sourceId, musicItem, quality),
  sourceLyric: (sourceId, musicItem) => ipcRenderer.invoke('source:lyric', sourceId, musicItem),

  // ===== 迷你播放器 =====
  miniOpen: () => ipcRenderer.send('mini:open'),
  miniClose: () => ipcRenderer.send('mini:close'),
  // 小窗发命令给主窗
  miniCommand: (cmd, payload) => ipcRenderer.send('mini:command', cmd, payload),
  // 主窗推状态给小窗
  miniSyncState: (state) => ipcRenderer.send('mini:sync', state),
  // 小窗监听状态推送
  onMiniSync: (cb) => ipcRenderer.on('mini:sync', (_e, state) => cb(state)),
  // 主窗监听小窗命令
  onMiniCommand: (cb) => ipcRenderer.on('mini:command', (_e, cmd, payload) => cb(cmd, payload))
});
