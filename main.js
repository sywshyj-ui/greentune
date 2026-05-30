const { app, BrowserWindow, ipcMain, dialog, net, Tray, Menu, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const iconv = require('iconv-lite');
const jsmediatags = require('jsmediatags');
const https = require('https');
const http = require('http');

let mainWindow;
let tray = null;

const AUDIO_EXTS = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    frame: false,
    backgroundColor: '#121212',
    title: '浩哥的Music',
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
    { label: '显示主窗口', click: () => { mainWindow.show(); } },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]);

  tray.setToolTip('浩哥的Music');
  tray.setContextMenu(contextMenu);

  // 双击托盘图标显示窗口
  tray.on('double-click', () => {
    mainWindow.show();
  });
}

// ---- Window controls ----
ipcMain.on('win-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win-close', () => mainWindow && mainWindow.hide()); // 改为隐藏而非关闭

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
ipcMain.handle('download-file', async (_e, url, suggestedName) => {
  if (!url) return null;
  // 从 URL 推断扩展名,缺省 m4a(QQ 试听多为 m4a)
  const extMatch = url.split('?')[0].match(/\.(mp3|m4a|flac|ogg|wav|aac)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'm4a';
  // 清掉文件名里的非法字符
  const safeName = (suggestedName || 'download').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `${safeName}.${ext}`,
    filters: [{ name: 'Audio', extensions: [ext] }]
  });
  if (r.canceled || !r.filePath) return null;
  const dest = r.filePath;
  // 用 Node 原生 https/http 下载,绕开 Electron net 被拦截(ERR_BLOCKED_BY_CLIENT)的问题
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

  createWindow();
  createTray();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
// 窗口关闭(隐藏)后不退出应用,保持托盘运行;真正退出走托盘菜单"退出"
app.on('window-all-closed', () => {
  // 不调用 app.quit(),让应用常驻托盘
});
app.on('before-quit', () => { app.isQuitting = true; });
