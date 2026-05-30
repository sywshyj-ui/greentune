const { app, BrowserWindow, ipcMain, dialog, net, Tray, Menu, nativeImage, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');
const iconv = require('iconv-lite');
const jsmediatags = require('jsmediatags');
const https = require('https');
const http = require('http');
const vm = require('vm');

// 插件运行时依赖
const axios = require('axios');
const cheerio = require('cheerio');
const CryptoJS = require('crypto-js');
const dayjs = require('dayjs');
const he = require('he');
const bigInt = require('big-integer');
const qs = require('qs');
const FormData = require('form-data');
const { createClient } = require('webdav');

let mainWindow;
let miniWindow = null;
let tray = null;

const AUDIO_EXTS = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'];

// ===== 插件运行时 =====
class PluginRuntime {
  constructor() {
    this.loadedPlugins = new Map(); // id -> {code, exports, enabled, platform, version}
    this.headerMap = new Map();     // url -> headers (for audio playback)
    this.pluginMetaPath = path.join(app.getPath('userData'), 'plugins.json');
  }

  // 创建插件沙箱环境
  createSandbox() {
    const moduleCache = {};
    const customRequire = (moduleName) => {
      if (moduleCache[moduleName]) return moduleCache[moduleName];

      const modules = {
        'axios': axios,
        'cheerio': cheerio,
        'crypto-js': CryptoJS,
        'dayjs': dayjs,
        'he': he,
        'big-integer': bigInt,
        'qs': qs,
        'form-data': FormData,
        'webdav': { createClient }
      };

      if (modules[moduleName]) {
        moduleCache[moduleName] = modules[moduleName];
        return modules[moduleName];
      }
      throw new Error(`Module not found: ${moduleName}`);
    };

    return {
      require: customRequire,
      module: { exports: {} },
      exports: {},
      console: console,
      setTimeout, clearTimeout, setInterval, clearInterval,
      Buffer, URL, URLSearchParams,
      process: { env: {}, platform: process.platform, version: process.version },
      // MusicFree 宿主注入的全局 env(用户变量等),提供空实现以兼容依赖它的插件
      env: {
        getUserVariables: () => ({}),
        os: 'electron',
        appVersion: '1.0.0',
        lang: 'zh-CN'
      }
    };
  }

  // 加载插件代码
  loadPlugin(id, code) {
    try {
      const sandbox = this.createSandbox();
      const script = new vm.Script(code, { filename: `${id}.js` });
      const context = vm.createContext(sandbox);

      script.runInContext(context, { timeout: 5000 });

      const pluginExports = sandbox.module.exports;

      // 验证必需字段
      if (!pluginExports.platform || !pluginExports.version) {
        throw new Error('插件缺少 platform 或 version 字段');
      }

      this.loadedPlugins.set(id, {
        code,
        exports: pluginExports,
        enabled: true,
        platform: pluginExports.platform,
        version: pluginExports.version
      });

      console.log(`插件加载成功: ${pluginExports.platform} v${pluginExports.version}`);
      return { ok: true, platform: pluginExports.platform };
    } catch (e) {
      console.error(`插件加载失败 (${id}):`, e);
      return { ok: false, error: e.message };
    }
  }

  // 调用插件方法
  async callPluginMethod(id, method, ...args) {
    const plugin = this.loadedPlugins.get(id);
    if (!plugin || !plugin.enabled) {
      throw new Error(`插件 ${id} 不存在或未启用`);
    }

    const fn = plugin.exports[method];
    if (typeof fn !== 'function') {
      throw new Error(`插件 ${id} 没有 ${method} 方法`);
    }

    return await fn(...args);
  }

  // 注册播放 URL 的 headers（供 session.webRequest 使用）
  registerHeaders(url, headers) {
    if (headers && Object.keys(headers).length > 0) {
      this.headerMap.set(url, headers);
      // 5分钟后自动清理
      setTimeout(() => this.headerMap.delete(url), 5 * 60 * 1000);
    }
  }

  getHeaders(url) {
    return this.headerMap.get(url) || null;
  }

  // 保存插件元数据
  savePluginMeta(id, meta) {
    let allMeta = {};
    try {
      if (fs.existsSync(this.pluginMetaPath)) {
        allMeta = JSON.parse(fs.readFileSync(this.pluginMetaPath, 'utf8'));
      }
    } catch (e) {
      console.error('读取插件元数据失败:', e);
    }
    allMeta[id] = meta;
    fs.writeFileSync(this.pluginMetaPath, JSON.stringify(allMeta, null, 2));
  }

  deletePluginMeta(id) {
    let allMeta = {};
    try {
      if (fs.existsSync(this.pluginMetaPath)) {
        allMeta = JSON.parse(fs.readFileSync(this.pluginMetaPath, 'utf8'));
      }
    } catch (e) {
      return;
    }
    delete allMeta[id];
    fs.writeFileSync(this.pluginMetaPath, JSON.stringify(allMeta, null, 2));
  }

  // 启动时恢复插件（异步版本，不阻塞窗口创建）
  async restorePlugins() {
    try {
      if (!fs.existsSync(this.pluginMetaPath)) return;
      const allMeta = JSON.parse(await fs.promises.readFile(this.pluginMetaPath, 'utf8'));

      for (const [id, meta] of Object.entries(allMeta)) {
        let code = null;
        if (meta.filePath && fs.existsSync(meta.filePath)) {
          code = await fs.promises.readFile(meta.filePath, 'utf8');
        } else if (meta.code) {
          code = meta.code;
        }

        if (code) {
          this.loadPlugin(id, code);
        }
      }
    } catch (e) {
      console.error('恢复插件失败:', e);
    }
  }
}

const pluginRuntime = new PluginRuntime();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    frame: false,
    backgroundColor: '#121212',
    title: '杨杨的专属Music',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');

  // 在输入框/可编辑区域右键时,弹出 剪切/复制/粘贴/全选 菜单
  mainWindow.webContents.on('context-menu', (_e, params) => {
    if (!params.isEditable) return; // 只在可编辑元素上弹
    const menu = Menu.buildFromTemplate([
      { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
      { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
      { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' }
    ]);
    menu.popup({ window: mainWindow });
  });

  // 阻止窗口真正关闭,改为隐藏到托盘
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// 创建系统托盘图标
function createTray() {
  // 用绿色音符图标作为托盘图标,缩放到 16x16
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch (e) {
    console.error('托盘图标加载失败:', e);
    return; // 图标加载失败则不创建托盘
  }

  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => {
      // 如果mini窗口打开，先关闭它再显示主窗口
      if (miniWindow && !miniWindow.isDestroyed()) {
        miniWindow.close();
        miniWindow = null;
      }
      mainWindow.show();
    } },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]);

  tray.setToolTip('杨杨的专属Music');
  tray.setContextMenu(contextMenu);

  // 双击托盘图标显示窗口
  tray.on('double-click', () => {
    // 如果mini窗口打开，先关闭它再显示主窗口
    if (miniWindow && !miniWindow.isDestroyed()) {
      miniWindow.close();
      miniWindow = null;
    }
    mainWindow.show();
  });
}

// 创建迷你播放器悬浮小窗
function createMiniWindow() {
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.show();
    return;
  }
  miniWindow = new BrowserWindow({
    width: 320,
    height: 150,
    frame: false,
    resizable: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  miniWindow.loadFile('mini.html');
  miniWindow.on('closed', () => { miniWindow = null; });
}

// ---- Window controls ----
ipcMain.on('win-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win-close', () => mainWindow && mainWindow.hide()); // 改为隐藏而非关闭

// ---- 迷你播放器 ----
// 打开 mini：创建小窗 + 隐藏主窗
ipcMain.on('mini:open', () => {
  createMiniWindow();
  if (mainWindow) mainWindow.hide();
});
// 关闭 mini：关掉小窗 + 显示主窗
ipcMain.on('mini:close', () => {
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close();
  if (mainWindow) mainWindow.show();
});
// 小窗 → 主窗：转发播放命令(toggle/prev/next/seek/ready)
ipcMain.on('mini:command', (_e, cmd, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mini:command', cmd, payload);
  }
});
// 主窗 → 小窗：转发播放状态
ipcMain.on('mini:sync', (_e, state) => {
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.webContents.send('mini:sync', state);
  }
});

// ---- File pickers ----
ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: AUDIO_EXTS }]
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(readMeta));
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return [];
  const files = scanDir(r.filePaths[0]);
  return Promise.all(files.map(readMeta));
});

// 拖拽进来的文件:按路径读元数据,过滤非音频
ipcMain.handle('read-meta', async (_e, paths) => {
  if (!Array.isArray(paths)) return [];
  const audio = paths.filter((p) => {
    const ext = (p.split('.').pop() || '').toLowerCase();
    return AUDIO_EXTS.includes(ext);
  });
  return Promise.all(audio.map(readMeta));
});

// HTTP 请求代理(主进程发请求,绕过渲染进程的 CORS 限制)
ipcMain.handle('http-get', async (_e, url) => {
  return new Promise((resolve, reject) => {
    const request = net.request({
      url,
      // 网易云接口需要带 Referer,否则返回错误
      headers: { 'Referer': 'https://music.163.com', 'User-Agent': 'Mozilla/5.0' }
    });
    const chunks = [];
    request.on('response', (response) => {
      response.on('data', (chunk) => { chunks.push(chunk); });
      response.on('end', () => {
        // 合并后整体解码,避免多字节中文被切在块边界导致乱码
        const body = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    request.on('error', (err) => reject(err.message));
    request.end();
  });
});

// 通用 HTTP GET,可自定义 Referer(QQ 音乐等需要不同 Referer)
function httpGetRaw(url, referer) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      url,
      headers: { 'Referer': referer || '', 'User-Agent': 'Mozilla/5.0' }
    });
    const chunks = [];
    request.on('response', (response) => {
      response.on('data', (chunk) => { chunks.push(chunk); });
      response.on('end', () => {
        // 合并后整体解码,避免多字节中文被切在块边界导致乱码
        const body = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(body)); } catch { resolve(body); }
      });
    });
    request.on('error', (err) => reject(err.message));
    request.end();
  });
}

// ---- QQ 音乐:搜索 ----
ipcMain.handle('qq-search', async (_e, keyword, limit) => {
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(keyword)}&p=1&n=${limit || 50}&format=json`;
  try {
    const data = await httpGetRaw(url, 'https://y.qq.com');
    const list = (data && data.data && data.data.song && data.data.song.list) || [];
    return list.map((s) => ({
      id: s.songmid,
      name: s.songname,
      artists: (s.singer || []).map((a) => ({ name: a.name })),
      album: { name: s.albumname || 'Unknown', mid: s.albummid || '' },
      duration: (s.interval || 0) * 1000,
      picUrl: s.albummid ? `https://y.qq.com/music/photo_new/T002R300x300M000${s.albummid}.jpg` : ''
    }));
  } catch (e) {
    return [];
  }
});

// ---- QQ 音乐:获取试听 URL ----
ipcMain.handle('qq-url', async (_e, songmid) => {
  const data = {
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: { guid: '10000', songmid: [songmid], songtype: [0], uin: '0', loginflag: 1, platform: '20' }
    }
  };
  const url = `https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify(data))}`;
  try {
    const r = await httpGetRaw(url, 'https://y.qq.com');
    const info = r && r.req_0 && r.req_0.data;
    if (!info || !info.midurlinfo || !info.midurlinfo[0]) return null;
    const purl = info.midurlinfo[0].purl;
    if (!purl) return null; // 需要会员
    return info.sip[0] + purl;
  } catch (e) {
    return null;
  }
});

// ---- QQ 音乐:获取歌词 ----
ipcMain.handle('qq-lyric', async (_e, songmid) => {
  const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${songmid}&format=json&nobase64=1`;
  try {
    const r = await httpGetRaw(url, 'https://y.qq.com');
    return (r && r.lyric) || null;
  } catch (e) {
    return null;
  }
});

// ---- 网易云音乐:获取歌单详情 ----
// 带 music.163.com 的 Referer 直接读取公开歌单。
// 注意:playlist/detail 的 tracks 只返回前若干首,完整歌曲 ID 在 trackIds 里。
// 因此先取歌单名和全部 trackIds,再用 song/detail 分批(每批100)补全所有歌曲。
ipcMain.handle('netease-playlist', async (_e, id) => {
  // 把一首 track 归一化成我们用的字段(兼容新旧接口 artists/ar、album/al、duration/dt)
  const mapTrack = (t) => ({
    neid: t.id,
    name: t.name || '未知歌曲',
    artist: ((t.artists || t.ar || []).map((a) => a.name).join(', ')) || 'Unknown Artist',
    album: ((t.album && t.album.name) || (t.al && t.al.name)) || 'Unknown Album',
    picUrl: (t.album && t.album.picUrl) || (t.al && t.al.picUrl) || '',
    duration: t.duration || t.dt || 0
  });

  const tryUrls = [
    `https://music.163.com/api/v6/playlist/detail?id=${id}&n=100000`,
    `https://music.163.com/api/playlist/detail?id=${id}`
  ];
  for (const url of tryUrls) {
    try {
      const r = await httpGetRaw(url, 'https://music.163.com');
      const pl = r && (r.playlist || r.result);
      if (!pl) continue;
      const tracks = Array.isArray(pl.tracks) ? pl.tracks : [];
      // 全部歌曲 ID:优先 trackIds(完整),否则退回 tracks 自身
      const allIds = Array.isArray(pl.trackIds) && pl.trackIds.length
        ? pl.trackIds.map((x) => x.id)
        : tracks.map((t) => t.id);
      if (!allIds.length) continue;

      // 已在 tracks 里拿到详情的歌,先存下来;缺的再补
      const byId = {};
      tracks.forEach((t) => { byId[t.id] = mapTrack(t); });
      const missing = allIds.filter((tid) => !byId[tid]);

      // 分批补全缺失的歌曲详情(每批 100 个 id),用 v3/song/detail 的 c 参数
      for (let i = 0; i < missing.length; i += 100) {
        const batch = missing.slice(i, i + 100);
        const cParam = encodeURIComponent(JSON.stringify(batch.map((tid) => ({ id: tid }))));
        const detailUrl = `https://music.163.com/api/v3/song/detail?c=${cParam}`;
        try {
          const dr = await httpGetRaw(detailUrl, 'https://music.163.com');
          const songsArr = (dr && (dr.songs || (dr.result && dr.result.songs))) || [];
          songsArr.forEach((t) => { byId[t.id] = mapTrack(t); });
        } catch (e) { /* 这批失败就跳过,尽量保留已拿到的 */ }
      }

      // 按 trackIds 原顺序输出
      const songs = allIds.map((tid) => byId[tid]).filter(Boolean);
      if (!songs.length) continue;
      return { name: pl.name || '网易云歌单', count: songs.length, songs };
    } catch (e) {
      // 试下一个接口
    }
  }
  return null;
});

// ---- 下载在线音频到本地 ----
// 渲染层先用 qq-url 解析出试听地址,再调用本接口。弹保存对话框让用户选位置,
// 然后用 Node 原生 https/http 把音频流写到磁盘。返回 {ok,path} 或 {ok:false,error};取消返回 null。
// 下载核心:把 url 的内容写到 dest 文件,处理重定向。返回 {ok,path} 或 {ok:false,error}
function downloadUrlTo(url, dest) {
  return new Promise((resolve) => {
    const doGet = (u, redirects) => {
      if (redirects > 5) { resolve({ ok: false, error: '重定向次数过多' }); return; }
      const mod = u.startsWith('http://') ? http : https;
      const req = mod.get(u, { headers: { 'Referer': 'https://y.qq.com', 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // 丢弃响应体
          doGet(new URL(res.headers.location, u).toString(), redirects + 1);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); resolve({ ok: false, error: 'HTTP ' + res.statusCode }); return; }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve({ ok: true, path: dest })));
        out.on('error', (err) => { try { fs.unlinkSync(dest); } catch {} resolve({ ok: false, error: String(err) }); });
        res.on('error', (err) => { out.close(); try { fs.unlinkSync(dest); } catch {} resolve({ ok: false, error: String(err) }); });
      });
      req.on('error', (err) => resolve({ ok: false, error: String(err) }));
      req.end();
    };
    doGet(url, 0);
  });
}

// 从 url 推断音频扩展名,缺省 m4a(QQ 试听多为 m4a)
function audioExtFromUrl(url) {
  const m = url.split('?')[0].match(/\.(mp3|m4a|flac|ogg|wav|aac)$/i);
  return m ? m[1].toLowerCase() : 'm4a';
}
// 清掉文件名里的非法字符
function safeFileName(name) {
  return (name || 'download').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

ipcMain.handle('download-file', async (_e, url, suggestedName) => {
  if (!url) return null;
  const ext = audioExtFromUrl(url);
  const safeName = safeFileName(suggestedName);
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `${safeName}.${ext}`,
    filters: [{ name: 'Audio', extensions: [ext] }]
  });
  if (r.canceled || !r.filePath) return null;
  return downloadUrlTo(url, r.filePath);
});

// ---- 选择一个保存文件夹(批量下载用,只弹一次) ----
ipcMain.handle('pick-save-dir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

// ---- 下载到指定文件夹(不弹保存框,批量下载用) ----
// 重名自动加 (1)(2) 后缀避免覆盖
ipcMain.handle('download-to-dir', async (_e, url, dir, suggestedName) => {
  if (!url || !dir) return { ok: false, error: '参数缺失' };
  const ext = audioExtFromUrl(url);
  const base = safeFileName(suggestedName);
  let dest = path.join(dir, `${base}.${ext}`);
  let n = 1;
  while (fs.existsSync(dest)) { dest = path.join(dir, `${base} (${n}).${ext}`); n++; }
  return downloadUrlTo(url, dest);
});

// ---- 复制文本到系统剪贴板 ----
// 渲染层 file:// 下 navigator.clipboard 不可用,preload 沙盒里的 clipboard 也可能失效,
// 统一交主进程写剪贴板最稳妥。
ipcMain.handle('copy-text', (_e, text) => {
  try { clipboard.writeText(String(text ?? '')); return true; } catch { return false; }
});

// ---- 翻译(英文歌词 -> 中文) ----
// 用有道公开 demo 接口(无需 key,国内可访问)。多行用 \n 拼成一次请求,译文也按 \n 切回各行。
// 返回与输入等长的译文数组;失败返回 null。
ipcMain.handle('translate-lines', async (_e, lines) => {
  if (!Array.isArray(lines) || !lines.length) return null;
  const joined = lines.join('\n');
  const url = 'https://aidemo.youdao.com/trans?from=en&to=zh-CHS&q=' + encodeURIComponent(joined);
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data.errorCode !== '0' && data.errorCode !== 0) { resolve(null); return; }
          // translation[0] 是整段译文(保留了 \n),切回各行
          const translated = (data.translation && data.translation[0]) || '';
          resolve(translated.split('\n'));
        } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
});

function scanDir(dir) {
  let out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(scanDir(full));
    else {
      const ext = e.name.split('.').pop().toLowerCase();
      if (AUDIO_EXTS.includes(ext)) out.push(full);
    }
  }
  return out;
}

// ---- Metadata (ID3 + cover) ----
// 修复中文 ID3 标签乱码:很多中文 MP3 的标签是 GBK 编码,
// jsmediatags 按 Latin-1 读出来会变乱码,这里重新按 GBK 解码
function fixGBK(str) {
  if (!str || typeof str !== 'string') return str;
  // 已经包含正常中文,说明编码正确,直接返回
  if (/[一-鿿]/.test(str)) return str;
  // 含有高位 Latin-1 字符,很可能是 GBK 被误读
  if (/[-ÿ]/.test(str)) {
    try {
      const buf = Buffer.from(str, 'latin1');
      const dec = iconv.decode(buf, 'gbk');
      if (/[一-鿿]/.test(dec) && !dec.includes('�')) return dec;
    } catch {}
  }
  return str;
}

function readMeta(filePath) {
  return new Promise((resolve) => {
    const fallback = {
      filePath,
      title: path.basename(filePath, path.extname(filePath)),
      artist: 'Unknown Artist',
      album: 'Unknown Album',
      year: '',
      genre: '',
      cover: null
    };
    try {
      new jsmediatags.Reader(filePath).read({
        onSuccess: (tag) => {
          const t = tag.tags || {};
          let cover = null;
          if (t.picture && t.picture.data) {
            const { data, format } = t.picture;
            let bin = '';
            const bytes = new Uint8Array(data);
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            cover = `data:${format || 'image/jpeg'};base64,${Buffer.from(bin, 'binary').toString('base64')}`;
          }
          resolve({
            filePath,
            title: fixGBK(t.title) || fallback.title,
            artist: fixGBK(t.artist) || fallback.artist,
            album: fixGBK(t.album) || fallback.album,
            year: t.year || '',
            genre: fixGBK(t.genre) || '',
            cover
          });
        },
        onError: () => resolve(fallback)
      });
    } catch {
      resolve(fallback);
    }
  });
}

// ---- Lyrics (.lrc, GBK or UTF-8) ----
function decodeText(buf) {
  // BOM / UTF-8 heuristic; fall back to GBK
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.toString('utf8');
  }
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  try { return iconv.decode(buf, 'gbk'); } catch { return utf8; }
}

function parseLRC(text) {
  const lines = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of text.split(/\r?\n/)) {
    const tags = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(raw)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0;
      tags.push(min * 60 + sec + frac / 1000);
    }
    const content = raw.replace(re, '').trim();
    if (tags.length && content) {
      for (const time of tags) lines.push({ time, text: content });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

ipcMain.handle('load-lrc', async (_e, musicPath) => {
  const lrcPath = musicPath.replace(/\.[^.]+$/, '.lrc');
  try {
    if (fs.existsSync(lrcPath)) return parseLRC(decodeText(fs.readFileSync(lrcPath)));
  } catch (err) {
    console.error('LRC error:', err);
  }
  return null;
});

app.whenReady().then(() => {
  // 无边框窗口默认没有应用菜单,会导致输入框里 Ctrl+C/V/X/A 等编辑快捷键失效。
  // 注册一个带编辑角色的菜单(无边框下菜单栏不显示,但快捷键生效),让复制粘贴可用。
  const editMenu = Menu.buildFromTemplate([
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    }
  ]);
  Menu.setApplicationMenu(editMenu);

  // 拦截 audio 请求，注入插件返回的自定义 headers
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = pluginRuntime.getHeaders(details.url);
    if (headers) {
      Object.assign(details.requestHeaders, headers);
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  // 追踪重定向，将原始URL的headers复制到重定向后的URL
  session.defaultSession.webRequest.onBeforeRedirect((details) => {
    const headers = pluginRuntime.getHeaders(details.url);
    if (headers && details.redirectURL) {
      pluginRuntime.registerHeaders(details.redirectURL, headers);
    }
  });

  // 先创建窗口，让用户看到界面
  createWindow();
  createTray();

  // 异步加载插件，不阻塞窗口显示
  (async () => {
    await pluginRuntime.restorePlugins();
    await loadBuiltinPlugins();
    console.log('所有插件加载完成');
  })().catch(err => console.error('插件加载失败:', err));
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
// 窗口关闭(隐藏)后不退出应用,保持托盘运行;真正退出走托盘菜单"退出"
app.on('window-all-closed', () => {
  // 不调用 app.quit(),让应用常驻托盘
});
app.on('before-quit', () => { app.isQuitting = true; });

// ===== 内置插件 =====
async function loadBuiltinPlugins() {
  // 内置 QQ 音乐插件
  const builtinQQPlugin = `
const axios = require('axios');

async function httpGet(url, referer) {
  const res = await axios.get(url, {
    headers: { 'Referer': referer || '', 'User-Agent': 'Mozilla/5.0' },
    timeout: 10000
  });
  return res.data;
}

module.exports = {
  platform: 'QQ音乐',
  version: '1.0.0',
  author: '内置',
  supportedSearchType: ['music'],

  async search(keyword, page, type) {
    const url = \`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=\${encodeURIComponent(keyword)}&p=\${page || 1}&n=50&format=json\`;
    const data = await httpGet(url, 'https://y.qq.com');
    const list = (data && data.data && data.data.song && data.data.song.list) || [];
    return {
      isEnd: list.length < 50,
      data: list.map((s) => ({
        id: s.songmid,
        title: s.songname,
        artist: (s.singer || []).map((a) => a.name).join(', '),
        album: s.albumname || 'Unknown',
        artwork: s.albummid ? \`https://y.qq.com/music/photo_new/T002R300x300M000\${s.albummid}.jpg\` : '',
        duration: (s.interval || 0) * 1000,
        platform: 'QQ音乐'
      }))
    };
  },

  async getMediaSource(musicItem, quality) {
    const data = {
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: { guid: '10000', songmid: [musicItem.id], songtype: [0], uin: '0', loginflag: 1, platform: '20' }
      }
    };
    const url = \`https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=\${encodeURIComponent(JSON.stringify(data))}\`;
    const r = await httpGet(url, 'https://y.qq.com');
    const info = r && r.req_0 && r.req_0.data;
    if (!info || !info.midurlinfo || !info.midurlinfo[0]) return null;
    const purl = info.midurlinfo[0].purl;
    if (!purl) return null;
    return { url: info.sip[0] + purl };
  },

  async getLyric(musicItem) {
    const url = \`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=\${musicItem.id}&format=json&nobase64=1\`;
    const data = await httpGet(url, 'https://y.qq.com');
    return { rawLrc: data && data.lyric ? data.lyric : null };
  }
};
`;

  pluginRuntime.loadPlugin('builtin_qq', builtinQQPlugin);

  // 自动扫描并加载 plugins/ 目录下的内置 .js 插件 (B站/酷狗/网易/酷我/咪咕等) - 异步版本
  try {
    const pluginsDir = path.join(__dirname, 'plugins');
    if (fs.existsSync(pluginsDir)) {
      const files = await fs.promises.readdir(pluginsDir);
      for (const file of files) {
        if (!file.endsWith('.js')) continue;
        try {
          const code = await fs.promises.readFile(path.join(pluginsDir, file), 'utf8');
          const id = 'builtin_' + path.basename(file, '.js');
          const r = pluginRuntime.loadPlugin(id, code);
          if (r.ok) console.log(`内置插件已加载: ${file} -> ${r.platform}`);
          else console.error(`内置插件加载失败 ${file}: ${r.error}`);
        } catch (e) {
          console.error(`读取内置插件失败 ${file}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('扫描内置插件目录失败:', e);
  }
}

// ===== 插件管理 IPC 接口 =====

// 列出所有插件
ipcMain.handle('plugin:list', async () => {
  const list = [];
  pluginRuntime.loadedPlugins.forEach((plugin, id) => {
    list.push({
      id,
      platform: plugin.platform,
      version: plugin.version,
      enabled: plugin.enabled
    });
  });
  return list;
});

// 从本地文件加载插件
ipcMain.handle('plugin:load-file', async (_e) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'JavaScript', extensions: ['js'] }]
  });

  if (result.canceled || !result.filePaths.length) return null;

  const filePath = result.filePaths[0];
  const code = fs.readFileSync(filePath, 'utf8');
  const id = 'local_' + path.basename(filePath, '.js') + '_' + Date.now();

  const loadResult = pluginRuntime.loadPlugin(id, code);
  if (loadResult.ok) {
    pluginRuntime.savePluginMeta(id, { filePath, platform: loadResult.platform });
    return { ok: true, id, platform: loadResult.platform };
  }
  return loadResult;
});

// 从 URL 加载插件
ipcMain.handle('plugin:load-url', async (_e, url) => {
  try {
    const response = await axios.get(url, { timeout: 15000 });
    const code = response.data;
    const id = 'remote_' + url.split('/').pop().replace('.js', '') + '_' + Date.now();

    const loadResult = pluginRuntime.loadPlugin(id, code);
    if (loadResult.ok) {
      pluginRuntime.savePluginMeta(id, { url, code, platform: loadResult.platform });
      return { ok: true, id, platform: loadResult.platform };
    }
    return loadResult;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 启用/禁用插件
ipcMain.handle('plugin:toggle', async (_e, id, enabled) => {
  const plugin = pluginRuntime.loadedPlugins.get(id);
  if (!plugin) return { ok: false, error: '插件不存在' };
  plugin.enabled = enabled;
  return { ok: true };
});

// 删除插件
ipcMain.handle('plugin:remove', async (_e, id) => {
  pluginRuntime.loadedPlugins.delete(id);
  pluginRuntime.deletePluginMeta(id);
  return { ok: true };
});

// 统一音源接口：搜索
ipcMain.handle('source:search', async (_e, sourceId, keyword, page, type) => {
  try {
    return await pluginRuntime.callPluginMethod(sourceId, 'search', keyword, page || 1, type || 'music');
  } catch (e) {
    console.error(`插件 ${sourceId} 搜索失败:`, e);
    return { isEnd: true, data: [] };
  }
});

// 统一音源接口：获取播放 URL
ipcMain.handle('source:url', async (_e, sourceId, musicItem, quality) => {
  try {
    const result = await pluginRuntime.callPluginMethod(sourceId, 'getMediaSource', musicItem, quality || 'standard');

    // 注册 headers（如果有）
    if (result && result.url) {
      const headers = {};
      if (result.headers) Object.assign(headers, result.headers);
      if (result.userAgent) headers['User-Agent'] = result.userAgent;
      pluginRuntime.registerHeaders(result.url, headers);
      return result.url;
    }
    return null;
  } catch (e) {
    console.error(`插件 ${sourceId} 获取URL失败:`, e);
    return null;
  }
});

// 统一音源接口：获取歌词
ipcMain.handle('source:lyric', async (_e, sourceId, musicItem) => {
  try {
    const result = await pluginRuntime.callPluginMethod(sourceId, 'getLyric', musicItem);
    return result && result.rawLrc ? result.rawLrc : null;
  } catch (e) {
    console.error(`插件 ${sourceId} 获取歌词失败:`, e);
    return null;
  }
});

