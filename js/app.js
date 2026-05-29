/* ===== GreenTune · 渲染逻辑 ===== */
const $ = (id) => document.getElementById(id);
const audio = $('audio');

// ---- 状态 ----
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('gt_' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gt_' + k, JSON.stringify(v)); } catch {} }
};

let library = LS.get('library', []);      // 完整歌曲对象(无封面)
let coverCache = {};                       // filePath -> dataURL(仅内存)
let favorites = LS.get('favorites', []);   // filePath[]
let recent = LS.get('recent', []);         // filePath[]
let playlists = LS.get('playlists', []);   // {id,name,songs:[]}
let volume = LS.get('volume', 0.8);
let theme = LS.get('theme', 'dark');

let view = 'home';                         // home|search|library|favorites|recent|pl:<id>
let queue = [];                            // 当前可见列表(filePath[])
let currentPath = null;
let playMode = LS.get('playMode', 'list'); // list|shuffle|one|all
let isSeeking = false;
let lrc = null;
let lrcIdx = -1;

// ---- 工具 ----
const fmt = (s) => {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
};
const esc = (s) => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };
const byPath = (p) => library.find((x) => x.filePath === p);
const saveLib = () => LS.set('library', library.map((s) => ({ ...s, cover: null })));

// ---- 封面获取(优先内存缓存,其次歌曲对象) ----
const coverOf = (path) => coverCache[path] || (byPath(path)?.cover) || null;
function coverHTML(path, fallback = '🎵') {
  const c = coverOf(path);
  return c ? `<img src="${c}" alt="">` : fallback;
}

// ===== 视图渲染 =====
const VIEW_TITLES = { home: '主页', search: '搜索结果', library: '音乐库', favorites: '我喜欢', recent: '最近播放' };

function computeQueue() {
  if (view === 'favorites') return favorites.filter(byPath);
  if (view === 'recent') return recent.filter(byPath);
  if (view.startsWith('pl:')) {
    const pl = playlists.find((p) => p.id === view.slice(3));
    return pl ? pl.songs.filter(byPath) : [];
  }
  if (view === 'search') {
    const q = $('search-input').value.trim().toLowerCase();
    if (!q) return library.map((s) => s.filePath);
    return library.filter((s) =>
      (s.title + s.artist + s.album + s.genre).toLowerCase().includes(q)
    ).map((s) => s.filePath);
  }
  return library.map((s) => s.filePath); // home + library
}

function render() {
  // 标题
  let title = VIEW_TITLES[view] || '主页';
  if (view.startsWith('pl:')) {
    const pl = playlists.find((p) => p.id === view.slice(3));
    title = pl ? pl.name : '歌单';
  }
  $('view-title').textContent = title;

  queue = computeQueue();
  $('view-count').textContent = queue.length ? `${queue.length} 首歌曲` : '';

  // 导航高亮
  document.querySelectorAll('.nav-item').forEach((n) =>
    n.classList.toggle('active', n.dataset.view === view));
  document.querySelectorAll('.pl-item').forEach((n) =>
    n.classList.toggle('active', n.dataset.view === view));

  const body = $('song-body');
  const empty = $('empty-state');
  const table = $('song-table');

  if (!queue.length) {
    table.hidden = true;
    empty.hidden = false;
    if (!library.length) {
      $('empty-title').textContent = '还没有音乐';
      $('empty-sub').textContent = '点击左下角「添加音乐」导入本地文件或文件夹';
    } else {
      $('empty-title').textContent = '这里空空如也';
      $('empty-sub').textContent = view === 'favorites' ? '点击歌曲右侧的 ♡ 收藏喜欢的歌'
        : view === 'search' ? '没有匹配的结果，换个关键词试试' : '暂无歌曲';
    }
    return;
  }

  table.hidden = false;
  empty.hidden = true;
  body.innerHTML = queue.map((path, i) => {
    const s = byPath(path);
    const playing = path === currentPath;
    return `<div class="st-row ${playing ? 'playing' : ''}" data-path="${esc(path)}">
      <div class="row-idx">
        <span class="num">${i + 1}</span>
        <span class="play-mark">▶</span>
      </div>
      <div class="row-main">
        <div class="row-cover">${coverHTML(path)}</div>
        <div class="row-text">
          <span class="row-title">${esc(s.title)}</span>
          <span class="row-artist">${esc(s.artist)}</span>
        </div>
      </div>
      <div class="row-album">${esc(s.album)}</div>
      <div class="row-genre">${esc(s.genre || '—')}</div>
      <div class="row-dur">${s.duration ? fmt(s.duration) : '—'}</div>
    </div>`;
  }).join('');

  body.querySelectorAll('.st-row').forEach((row) => {
    row.addEventListener('click', () => playPath(row.dataset.path));
  });
}

function renderPlaylists() {
  const list = $('pl-list');
  // 保留前两个固定项(我喜欢/最近)
  const fixed = `
    <div class="pl-item" data-view="favorites">
      <span class="pl-ico heart">♥</span>
      <div class="pl-meta"><span class="pl-name">我喜欢</span><span class="pl-sub">${favorites.length} 首</span></div>
    </div>
    <div class="pl-item" data-view="recent">
      <span class="pl-ico">🕑</span>
      <div class="pl-meta"><span class="pl-name">最近播放</span><span class="pl-sub">${recent.length} 首</span></div>
    </div>`;
  const custom = playlists.map((p) => `
    <div class="pl-item" data-view="pl:${p.id}">
      <span class="pl-ico">🎵</span>
      <div class="pl-meta"><span class="pl-name">${esc(p.name)}</span><span class="pl-sub">${p.songs.length} 首</span></div>
    </div>`).join('');
  list.innerHTML = fixed + custom;
  list.querySelectorAll('.pl-item').forEach((el) => {
    el.addEventListener('click', () => { view = el.dataset.view; render(); });
  });
}

// ===== 播放引擎 =====
function playPath(path) {
  const s = byPath(path);
  if (!s) return;
  currentPath = path;
  audio.src = 'file://' + path.replace(/\\/g, '/').replace(/#/g, '%23');
  audio.play().catch((e) => console.error('play error', e));

  // 现在播放信息
  $('now-title').textContent = s.title;
  $('now-artist').textContent = s.artist;
  $('now-cover').innerHTML = coverHTML(path);
  $('lp-title').textContent = s.title;
  $('lp-artist').textContent = s.artist;
  $('lp-cover').innerHTML = coverHTML(path, '🎵');
  $('like-btn').classList.toggle('liked', favorites.includes(path));
  $('like-btn').textContent = favorites.includes(path) ? '♥' : '♡';

  // 最近播放
  recent = [path, ...recent.filter((p) => p !== path)].slice(0, 100);
  LS.set('recent', recent);

  loadLyrics(path);
  render();
  renderPlaylists();
}

function togglePlay() {
  if (!currentPath) { if (queue.length) playPath(queue[0]); return; }
  if (audio.paused) audio.play(); else audio.pause();
}

function nextIndex(dir) {
  if (!queue.length) return -1;
  const cur = queue.indexOf(currentPath);
  if (playMode === 'shuffle') {
    if (queue.length === 1) return 0;
    let r; do { r = Math.floor(Math.random() * queue.length); } while (r === cur);
    return r;
  }
  let i = cur + dir;
  if (i >= queue.length) i = playMode === 'all' || dir === 1 ? 0 : queue.length - 1;
  if (i < 0) i = queue.length - 1;
  return i;
}

function playNext() {
  const i = nextIndex(1);
  if (i >= 0) playPath(queue[i]);
}
function playPrev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const i = nextIndex(-1);
  if (i >= 0) playPath(queue[i]);
}

function onEnded() {
  if (playMode === 'one') { audio.currentTime = 0; audio.play(); return; }
  const cur = queue.indexOf(currentPath);
  if (playMode === 'list' && cur === queue.length - 1) { setPlayIcon(false); return; }
  playNext();
}

function setPlayIcon(playing) {
  $('play-icon').innerHTML = playing
    ? '<path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/>'
    : '<path fill="currentColor" d="M8 5v14l11-7z"/>';
}

// ===== 歌词 =====
async function loadLyrics(path) {
  lrc = null; lrcIdx = -1;
  const box = $('lp-lyrics');
  box.innerHTML = '<p class="lp-placeholder">正在加载歌词…</p>';
  const data = await window.api.loadLrc(path);
  if (path !== currentPath) return; // 已切歌
  if (!data || !data.length) {
    box.innerHTML = '<p class="lp-placeholder">暂无歌词（放一个同名 .lrc 文件即可）</p>';
    return;
  }
  lrc = data;
  box.innerHTML = data.map((l, i) => `<p data-i="${i}">${esc(l.text)}</p>`).join('');
}

function syncLyrics(t) {
  if (!lrc) return;
  let idx = -1;
  for (let i = 0; i < lrc.length; i++) { if (lrc[i].time <= t) idx = i; else break; }
  if (idx === lrcIdx) return;
  lrcIdx = idx;
  const box = $('lp-lyrics');
  box.querySelectorAll('p').forEach((p) => p.classList.remove('active'));
  const active = box.querySelector(`p[data-i="${idx}"]`);
  if (active) {
    active.classList.add('active');
    const offset = active.offsetTop - box.clientHeight / 2 + active.clientHeight / 2;
    box.scrollTo({ top: offset, behavior: 'smooth' });
  }
}

// ===== 导入音乐 =====
async function importSongs(songs) {
  if (!songs || !songs.length) return;
  const existing = new Set(library.map((s) => s.filePath));
  let added = 0;
  for (const s of songs) {
    if (s.cover) coverCache[s.filePath] = s.cover; // 封面只存内存
    if (existing.has(s.filePath)) continue;
    library.push({
      filePath: s.filePath, title: s.title, artist: s.artist,
      album: s.album, year: s.year, genre: s.genre, duration: 0, cover: null
    });
    existing.add(s.filePath);
    added++;
    probeDuration(s.filePath);
  }
  saveLib();
  renderPlaylists();
  render();
}

// 用隐藏 audio 探测时长(逐个,轻量)
const durQueue = [];
let probing = false;
function probeDuration(path) {
  const s = byPath(path);
  if (s && s.duration) return;
  durQueue.push(path);
  runProbe();
}
function runProbe() {
  if (probing || !durQueue.length) return;
  probing = true;
  const path = durQueue.shift();
  const a = new Audio();
  a.preload = 'metadata';
  a.src = 'file://' + path.replace(/\\/g, '/').replace(/#/g, '%23');
  const done = () => {
    const s = byPath(path);
    if (s && a.duration && !isNaN(a.duration)) { s.duration = a.duration; saveLib(); }
    probing = false;
    if (view === 'library' || view === 'home') {
      // 局部刷新时长显示
      const row = document.querySelector(`.st-row[data-path="${CSS.escape(path)}"] .row-dur`);
      if (row && s && s.duration) row.textContent = fmt(s.duration);
    }
    runProbe();
  };
  a.addEventListener('loadedmetadata', done);
  a.addEventListener('error', () => { probing = false; runProbe(); });
}

// ===== 进度 / 音量 拖拽 =====
function setupBar(barId, fillId, knobId, onSet) {
  const bar = $(barId), fill = $(fillId), knob = $(knobId);
  let dragging = false;
  const ratioFromEvent = (e) => {
    const r = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const apply = (ratio) => {
    fill.style.width = (ratio * 100) + '%';
    knob.style.left = (ratio * 100) + '%';
  };
  bar.addEventListener('mousedown', (e) => { dragging = true; const r = ratioFromEvent(e); apply(r); onSet(r, false); });
  window.addEventListener('mousemove', (e) => { if (!dragging) return; const r = ratioFromEvent(e); apply(r); onSet(r, true); });
  window.addEventListener('mouseup', (e) => { if (!dragging) return; dragging = false; onSet(ratioFromEvent(e), false); });
  return { apply, isDragging: () => dragging };
}

const progressBar = setupBar('progress', 'progress-fill', 'progress-knob', (r, seeking) => {
  isSeeking = seeking;
  if (!audio.duration) return;
  if (!seeking) { audio.currentTime = r * audio.duration; isSeeking = false; }
  else { $('cur-time').textContent = fmt(r * audio.duration); }
});

const volBar = setupBar('vol-bar', 'vol-fill', 'vol-knob', (r) => {
  volume = r; audio.volume = r; LS.set('volume', r);
});

// ===== audio 事件 =====
audio.addEventListener('play', () => setPlayIcon(true));
audio.addEventListener('pause', () => setPlayIcon(false));
audio.addEventListener('ended', onEnded);
audio.addEventListener('loadedmetadata', () => {
  $('dur-time').textContent = fmt(audio.duration);
  const s = byPath(currentPath);
  if (s && (!s.duration || isNaN(s.duration))) { s.duration = audio.duration; saveLib(); }
});
audio.addEventListener('timeupdate', () => {
  if (!isSeeking && audio.duration) {
    const r = audio.currentTime / audio.duration;
    progressBar.apply(r);
    $('cur-time').textContent = fmt(audio.currentTime);
  }
  syncLyrics(audio.currentTime);
});

// ===== 控件绑定 =====
$('play-btn').addEventListener('click', togglePlay);
$('next-btn').addEventListener('click', playNext);
$('prev-btn').addEventListener('click', playPrev);

$('shuffle-btn').addEventListener('click', () => {
  playMode = playMode === 'shuffle' ? 'list' : 'shuffle';
  applyModeUI();
});
$('repeat-btn').addEventListener('click', () => {
  // list -> all -> one -> list
  playMode = playMode === 'list' || playMode === 'shuffle' ? 'all'
    : playMode === 'all' ? 'one' : 'list';
  applyModeUI();
});
function applyModeUI() {
  LS.set('playMode', playMode);
  $('shuffle-btn').classList.toggle('active', playMode === 'shuffle');
  $('repeat-btn').classList.toggle('active', playMode === 'all' || playMode === 'one');
  $('repeat-btn').title = playMode === 'one' ? '单曲循环' : playMode === 'all' ? '列表循环' : '循环模式';
  // 单曲循环加角标
  $('repeat-btn').innerHTML = playMode === 'one'
    ? '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="12" y="15" font-size="8" fill="currentColor" text-anchor="middle" font-weight="bold">1</text></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>';
}

$('like-btn').addEventListener('click', () => {
  if (!currentPath) return;
  if (favorites.includes(currentPath)) favorites = favorites.filter((p) => p !== currentPath);
  else favorites = [currentPath, ...favorites];
  LS.set('favorites', favorites);
  $('like-btn').classList.toggle('liked', favorites.includes(currentPath));
  $('like-btn').textContent = favorites.includes(currentPath) ? '♥' : '♡';
  renderPlaylists();
  if (view === 'favorites') render();
});

// 静音
let preMuteVol = volume;
$('vol-btn').addEventListener('click', () => {
  if (audio.volume > 0) { preMuteVol = audio.volume; audio.volume = 0; volBar.apply(0); }
  else { audio.volume = preMuteVol || 0.8; volBar.apply(audio.volume); }
});

// 导航
document.querySelectorAll('.nav-main .nav-item').forEach((n) => {
  n.addEventListener('click', () => {
    view = n.dataset.view;
    if (view === 'search') setTimeout(() => $('search-input').focus(), 50);
    render();
  });
});

// 搜索
$('search-input').addEventListener('input', () => { if (view !== 'search') view = 'search'; render(); });

// 歌词面板
$('lyrics-toggle').addEventListener('click', () => $('lyrics-panel').classList.toggle('hidden'));
$('close-lyrics').addEventListener('click', () => $('lyrics-panel').classList.add('hidden'));

// 主题
function applyTheme() {
  document.documentElement.setAttribute('data-theme', theme);
  $('theme-btn').textContent = theme === 'dark' ? '🌙' : '☀️';
  LS.set('theme', theme);
}
$('theme-btn').addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(); });

// 添加音乐(文件 / 文件夹 — 简单地两者都问)
$('add-music').addEventListener('click', async () => {
  const files = await window.api.pickFiles();
  if (files && files.length) importSongs(files);
});
$('add-music').addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  const songs = await window.api.pickFolder();
  if (songs && songs.length) importSongs(songs);
});

// 新建歌单
$('create-pl').addEventListener('click', () => { $('pl-modal').hidden = false; $('pl-name-input').value=''; $('pl-name-input').focus(); });
$('pl-cancel').addEventListener('click', () => { $('pl-modal').hidden = true; });
$('pl-confirm').addEventListener('click', createPlaylist);
$('pl-name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') createPlaylist(); if (e.key === 'Escape') $('pl-modal').hidden = true; });
function createPlaylist() {
  const name = $('pl-name-input').value.trim();
  if (!name) return;
  playlists.push({ id: 'p' + Date.now(), name, songs: [] });
  LS.set('playlists', playlists);
  $('pl-modal').hidden = true;
  renderPlaylists();
}

// 窗口控制
$('win-min').addEventListener('click', () => window.api.minimize());
$('win-max').addEventListener('click', () => window.api.maximize());
$('win-close').addEventListener('click', () => window.api.close());

// 快捷键
document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (e.key === ' ' && !typing) { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight' && !typing) { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5); }
  else if (e.key === 'ArrowLeft' && !typing) { audio.currentTime = Math.max(0, audio.currentTime - 5); }
  else if (e.key === 'ArrowUp' && !typing) { e.preventDefault(); volume = Math.min(1, (audio.volume||0) + 0.05); audio.volume = volume; volBar.apply(volume); LS.set('volume', volume); }
  else if (e.key === 'ArrowDown' && !typing) { e.preventDefault(); volume = Math.max(0, (audio.volume||0) - 0.05); audio.volume = volume; volBar.apply(volume); LS.set('volume', volume); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); view = 'search'; render(); $('search-input').focus(); }
});

// ===== 初始化 =====
function init() {
  applyTheme();
  audio.volume = volume;
  volBar.apply(volume);
  applyModeUI();
  renderPlaylists();
  render();
}
init();
