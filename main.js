const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const iconv = require('iconv-lite');
const jsmediatags = require('jsmediatags');

let mainWindow;

const AUDIO_EXTS = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    frame: false,
    backgroundColor: '#121212',
    title: 'GreenTune',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');
}

// ---- Window controls ----
ipcMain.on('win-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win-close', () => mainWindow && mainWindow.close());

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
            title: t.title || fallback.title,
            artist: t.artist || fallback.artist,
            album: t.album || fallback.album,
            year: t.year || '',
            genre: t.genre || '',
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

app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => app.quit());
