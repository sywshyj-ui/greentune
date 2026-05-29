const { app, BrowserWindow, ipcMain, dialog, net, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const iconv = require('iconv-lite');
const jsmediatags = require('jsmediatags');

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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');

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
  // 使用 logo.jpg 作为托盘图标,缩放到 16x16
  const iconPath = path.join(__dirname, 'assets', 'logo.jpg');
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
// 带 music.163.com 的 Referer 直接读取公开歌单。优先用旧版 detail(一次返回完整 tracks),
// 失败再退回 v6。只取列表信息(歌名/歌手/封面/时长),实际播放交给 QQ 音乐解析。
ipcMain.handle('netease-playlist', async (_e, id) => {
  const tryUrls = [
    `https://music.163.com/api/playlist/detail?id=${id}`,
    `https://music.163.com/api/v6/playlist/detail?id=${id}&n=1000`
  ];
  for (const url of tryUrls) {
    try {
      const r = await httpGetRaw(url, 'https://music.163.com');
      const pl = r && (r.result || r.playlist);
      const tracks = pl && pl.tracks;
      if (!pl || !Array.isArray(tracks) || !tracks.length) continue;
      const songs = tracks.map((t) => ({
        neid: t.id,
        // 旧接口字段为 artists/album/duration,新接口为 ar/al/dt,两者都兼容
        name: t.name || '未知歌曲',
        artist: ((t.artists || t.ar || []).map((a) => a.name).join(', ')) || 'Unknown Artist',
        album: ((t.album && t.album.name) || (t.al && t.al.name)) || 'Unknown Album',
        picUrl: (t.album && t.album.picUrl) || (t.al && t.al.picUrl) || '',
        duration: t.duration || t.dt || 0
      }));
      return { name: pl.name || '网易云歌单', count: songs.length, songs };
    } catch (e) {
      // 试下一个接口
    }
  }
  return null;
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
  createWindow();
  createTray();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
// 窗口关闭(隐藏)后不退出应用,保持托盘运行;真正退出走托盘菜单"退出"
app.on('window-all-closed', () => {
  // 不调用 app.quit(),让应用常驻托盘
});
app.on('before-quit', () => { app.isQuitting = true; });
