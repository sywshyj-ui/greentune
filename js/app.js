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
let sortKey = LS.get('sortKey', '');       // ''|title|artist|album|duration
let sortAsc = LS.get('sortAsc', true);

// Web Audio 频谱
let audioCtx = null;
let analyser = null;
let source = null;
let dataArray = null;
let eqFilters = []; // 10 段均衡器滤波器
const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  pop: [1, 3, 5, 3, 0, -1, -1, 0, 1, 2],
  rock: [4, 3, 1, -1, -2, 0, 2, 3, 4, 4],
  jazz: [3, 2, 1, 1, -1, -1, 0, 1, 2, 3],
  classical: [3, 2, 0, 0, -1, -1, 0, 1, 2, 3],
  vocal: [-1, -2, -2, 1, 3, 3, 2, 1, 0, -1]
};

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
  let paths;
  if (view === 'favorites') paths = favorites.filter(byPath);
  else if (view === 'recent') paths = recent.filter(byPath);
  else if (view.startsWith('pl:')) {
    const pl = playlists.find((p) => p.id === view.slice(3));
    paths = pl ? pl.songs.filter(byPath) : [];
  }
  else if (view === 'search') {
    const q = $('search-input').value.trim().toLowerCase();
    paths = !q ? library.map((s) => s.filePath)
      : library.filter((s) =>
          (s.title + s.artist + s.album + s.genre).toLowerCase().includes(q)
        ).map((s) => s.filePath);
  }
  else paths = library.map((s) => s.filePath); // home + library

  // 排序(recent 默认保留时间序,除非用户主动排序)
  if (sortKey && view !== 'recent') paths = sortPaths(paths);
  return paths;
}

function sortPaths(paths) {
  const dir = sortAsc ? 1 : -1;
  return [...paths].sort((a, b) => {
    const sa = byPath(a), sb = byPath(b);
    if (!sa || !sb) return 0;
    let va, vb;
    if (sortKey === 'duration') { va = sa.duration || 0; vb = sb.duration || 0; return (va - vb) * dir; }
    va = (sa[sortKey] || '').toString().toLowerCase();
    vb = (sb[sortKey] || '').toString().toLowerCase();
    return va.localeCompare(vb, 'zh') * dir;
  });
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
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, row.dataset.path);
    });
  });

  updateSortIndicators();
}

// ===== 排序 =====
function updateSortIndicators() {
  document.querySelectorAll('.st-head .st-col[data-sort]').forEach((col) => {
    const k = col.dataset.sort;
    col.classList.toggle('sorted', sortKey === k);
    const arrow = col.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = sortKey === k ? (sortAsc ? ' ▲' : ' ▼') : '';
  });
}

function setSort(key) {
  if (sortKey === key) sortAsc = !sortAsc;
  else { sortKey = key; sortAsc = true; }
  LS.set('sortKey', sortKey);
  LS.set('sortAsc', sortAsc);
  render();
}

// ===== 歌曲管理 =====
function toggleFav(path) {
  if (favorites.includes(path)) favorites = favorites.filter((p) => p !== path);
  else favorites = [path, ...favorites];
  LS.set('favorites', favorites);
  if (path === currentPath) {
    $('like-btn').classList.toggle('liked', favorites.includes(path));
    $('like-btn').textContent = favorites.includes(path) ? '♥' : '♡';
  }
  renderPlaylists();
  render();
}

function addToPlaylist(path, plId) {
  const pl = playlists.find((p) => p.id === plId);
  if (!pl) return;
  if (!pl.songs.includes(path)) pl.songs.push(path);
  LS.set('playlists', playlists);
  renderPlaylists();
  if (view === 'pl:' + plId) render();
}

function removeFromPlaylist(path, plId) {
  const pl = playlists.find((p) => p.id === plId);
  if (!pl) return;
  pl.songs = pl.songs.filter((p) => p !== path);
  LS.set('playlists', playlists);
  renderPlaylists();
  render();
}

function deleteSong(path) {
  library = library.filter((s) => s.filePath !== path);
  favorites = favorites.filter((p) => p !== path);
  recent = recent.filter((p) => p !== path);
  playlists.forEach((pl) => { pl.songs = pl.songs.filter((p) => p !== path); });
  delete coverCache[path];
  saveLib();
  LS.set('favorites', favorites);
  LS.set('recent', recent);
  LS.set('playlists', playlists);
  renderPlaylists();
  render();
}

// ===== 右键上下文菜单 =====
function showContextMenu(x, y, path) {
  closeContextMenu();
  const s = byPath(path);
  if (!s) return;
  const liked = favorites.includes(path);
  const inPl = view.startsWith('pl:') ? view.slice(3) : null;

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'ctx-menu';

  const items = [];
  items.push({ label: '▶ 播放', fn: () => playPath(path) });
  items.push({ label: liked ? '♥ 取消喜欢' : '♡ 添加到喜欢', fn: () => toggleFav(path) });
  items.push({ label: '＋ 加入歌单…', sub: playlists.length ? playlists.map((p) => ({
    label: p.name, fn: () => addToPlaylist(path, p.id)
  })) : [{ label: '(暂无歌单,先新建)', disabled: true }] });
  if (inPl) items.push({ label: '✕ 从此歌单移除', fn: () => removeFromPlaylist(path, inPl) });
  items.push({ sep: true });
  items.push({ label: '🗑 从音乐库删除', danger: true, fn: () => deleteSong(path) });

  menu.innerHTML = items.map((it, i) => {
    if (it.sep) return '<div class="ctx-sep"></div>';
    const cls = ['ctx-item'];
    if (it.danger) cls.push('danger');
    if (it.sub) cls.push('has-sub');
    const sub = it.sub ? `<div class="ctx-sub">${it.sub.map((s2, j) =>
      `<div class="ctx-item ${s2.disabled ? 'disabled' : ''}" data-sub="${i}-${j}">${esc(s2.label)}</div>`
    ).join('')}</div>` : '';
    return `<div class="${cls.join(' ')}" data-i="${i}">${esc(it.label)}${it.sub ? '<span class="ctx-arrow">▸</span>' : ''}${sub}</div>`;
  }).join('');

  document.body.appendChild(menu);
  // 定位,避免溢出屏幕
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';

  menu.querySelectorAll('.ctx-item[data-i]').forEach((el) => {
    const it = items[+el.dataset.i];
    if (it.sub || it.disabled) return;
    el.addEventListener('click', (e) => { e.stopPropagation(); it.fn(); closeContextMenu(); });
  });
  menu.querySelectorAll('.ctx-item[data-sub]').forEach((el) => {
    const [i, j] = el.dataset.sub.split('-').map(Number);
    const s2 = items[i].sub[j];
    if (s2.disabled) return;
    el.addEventListener('click', (e) => { e.stopPropagation(); s2.fn(); closeContextMenu(); });
  });
}

function closeContextMenu() {
  const m = $('ctx-menu');
  if (m) m.remove();
}
document.addEventListener('click', closeContextMenu);
document.addEventListener('scroll', closeContextMenu, true);

// ===== 频谱可视化 =====
function drawVisualizer() {
  const canvas = $('visualizer');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;

  function draw() {
    requestAnimationFrame(draw);
    if (!analyser || !dataArray) return;
    analyser.getByteFrequencyData(dataArray);

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, w, h);

    const barCount = 16;
    const barWidth = w / barCount;
    const step = Math.floor(dataArray.length / barCount);

    for (let i = 0; i < barCount; i++) {
      const val = dataArray[i * step] / 255;
      const barHeight = val * h * 0.9;
      const x = i * barWidth;
      const y = h - barHeight;

      // 绿色渐变
      const green = audio.paused ? '#3a3a3a' : `rgba(29, 185, 84, ${0.6 + val * 0.4})`;
      ctx.fillStyle = green;
      ctx.fillRect(x + 1, y, barWidth - 2, barHeight);
    }
  }
  draw();
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
    <div class="pl-item" data-view="pl:${p.id}" data-pl-id="${p.id}">
      <span class="pl-ico">🎵</span>
      <div class="pl-meta"><span class="pl-name">${esc(p.name)}</span><span class="pl-sub">${p.songs.length} 首</span></div>
    </div>`).join('');
  list.innerHTML = fixed + custom;
  list.querySelectorAll('.pl-item').forEach((el) => {
    el.addEventListener('click', () => { view = el.dataset.view; render(); });
    const plId = el.dataset.plId;
    if (plId) {
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showPlaylistMenu(e.clientX, e.clientY, plId);
      });
    }
  });
}

// ===== 歌单右键菜单 =====
function showPlaylistMenu(x, y, plId) {
  closeContextMenu();
  const pl = playlists.find((p) => p.id === plId);
  if (!pl) return;

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'ctx-menu';
  menu.innerHTML = `
    <div class="ctx-item" data-action="rename">✏ 重命名</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item danger" data-action="delete">🗑 删除歌单</div>
  `;
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';

  menu.querySelector('[data-action="rename"]').addEventListener('click', () => {
    closeContextMenu();
    const name = prompt('重命名歌单:', pl.name);
    if (name && name.trim()) {
      pl.name = name.trim();
      LS.set('playlists', playlists);
      renderPlaylists();
      if (view === 'pl:' + plId) render();
    }
  });
  menu.querySelector('[data-action="delete"]').addEventListener('click', () => {
    closeContextMenu();
    if (!confirm(`确定删除歌单「${pl.name}」吗?`)) return;
    playlists = playlists.filter((p) => p.id !== plId);
    LS.set('playlists', playlists);
    if (view === 'pl:' + plId) { view = 'home'; render(); }
    renderPlaylists();
  });
}

// ===== 播放引擎 =====
function playPath(path) {
  const s = byPath(path);
  if (!s) return;
  currentPath = path;
  audio.src = 'file://' + path.replace(/\\/g, '/').replace(/#/g, '%23');
  audio.play().catch((e) => console.error('play error', e));

  // Web Audio 频谱初始化(首次播放时)
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64; // 32 个频段
    source = audioCtx.createMediaElementSource(audio);

    // 均衡器滤波器链
    let prev = source;
    for (let i = 0; i < EQ_BANDS.length; i++) {
      const filter = audioCtx.createBiquadFilter();
      filter.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
      filter.frequency.value = EQ_BANDS[i];
      filter.Q.value = 1;
      filter.gain.value = eqGains[i];
      prev.connect(filter);
      eqFilters.push(filter);
      prev = filter;
    }

    prev.connect(analyser);
    analyser.connect(audioCtx.destination);
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    drawVisualizer();
  }

  // 现在播放信息
  $('now-title').textContent = s.title;
  $('now-artist').textContent = s.artist;
  $('now-cover').innerHTML = coverHTML(path);
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

  // 先尝试本地
  let data = await window.api.loadLrc(path);
  if (path !== currentPath) return;

  // 本地没有,尝试在线搜索
  if (!data || !data.length) {
    const s = byPath(path);
    if (s && s.title && s.artist) {
      box.innerHTML = '<p class="lp-placeholder">本地无歌词,正在联网搜索…</p>';
      data = await searchOnlineLyrics(s.title, s.artist);
      if (path !== currentPath) return;
    }
  }

  if (!data || !data.length) {
    box.innerHTML = '<p class="lp-placeholder">暂无歌词（放一个同名 .lrc 文件,或联网自动搜索）</p>';
    return;
  }
  lrc = data;
  box.innerHTML = data.map((l, i) => `<p data-i="${i}">${esc(l.text)}</p>`).join('');
}

// 在线歌词搜索(网易云 API,无需 key)
async function searchOnlineLyrics(title, artist) {
  const cacheKey = `lrc_${title}_${artist}`;
  const cached = LS.get(cacheKey, null);
  if (cached) return cached;

  try {
    // 搜索歌曲
    const searchUrl = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(title + ' ' + artist)}&type=1&limit=1`;
    const searchRes = await fetch(searchUrl, { method: 'GET' });
    const searchData = await searchRes.json();
    if (!searchData.result?.songs?.[0]?.id) return null;

    const songId = searchData.result.songs[0].id;
    // 获取歌词
    const lrcUrl = `https://music.163.com/api/song/lyric?id=${songId}&lv=1&tv=-1`;
    const lrcRes = await fetch(lrcUrl, { method: 'GET' });
    const lrcData = await lrcRes.json();
    if (!lrcData.lrc?.lyric) return null;

    // 解析 LRC
    const lines = parseLRC(lrcData.lrc.lyric);
    if (lines.length) {
      LS.set(cacheKey, lines); // 缓存
      return lines;
    }
  } catch (e) {
    console.error('在线歌词获取失败:', e);
  }
  return null;
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
    // 始终居中:当前行的中心对齐到容器中心
    const containerCenter = box.clientHeight / 2;
    const activeCenter = active.offsetTop + active.clientHeight / 2;
    box.scrollTo({ top: activeCenter - containerCenter, behavior: 'smooth' });
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

// 播放模式切换:list → all → one → shuffle → list
$('mode-btn').addEventListener('click', () => {
  const modes = ['list', 'all', 'one', 'shuffle'];
  const cur = modes.indexOf(playMode);
  playMode = modes[(cur + 1) % modes.length];
  applyModeUI();
});

function applyModeUI() {
  LS.set('playMode', playMode);
  const btn = $('mode-btn');
  const icon = $('mode-icon');
  btn.classList.toggle('active', playMode !== 'list');

  // 图标和提示
  if (playMode === 'shuffle') {
    btn.title = '随机播放';
    icon.innerHTML = '<path fill="currentColor" d="M17 3l4 4-4 4V8h-2.5l-2.2 3.1-1.2-1.7L13 7h4V3zM3 7h4l3.1 4.4 3.6 5.1H21l-4 4v-3h-2.5l-3.6-5.1L8 8H3V7zm14 6.9l4 4-4 4V18h-2.3l-1.5-2.1 1.2-1.7 1.3 1.8H17v-2.1z"/>';
  } else if (playMode === 'one') {
    btn.title = '单曲循环';
    icon.innerHTML = '<path fill="currentColor" d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="12" y="15" font-size="8" fill="currentColor" text-anchor="middle" font-weight="bold">1</text>';
  } else if (playMode === 'all') {
    btn.title = '列表循环';
    icon.innerHTML = '<path fill="currentColor" d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>';
  } else {
    btn.title = '顺序播放';
    icon.innerHTML = '<path fill="currentColor" d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>';
  }
}

// 定位当前播放
$('locate-btn').addEventListener('click', () => {
  if (!currentPath) return;
  const row = document.querySelector(`.st-row[data-path="${CSS.escape(currentPath)}"]`);
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.style.animation = 'none';
    setTimeout(() => { row.style.animation = 'highlight-flash 0.6s ease'; }, 10);
  }
});

$('like-btn').addEventListener('click', () => {
  if (!currentPath) return;
  toggleFav(currentPath);
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

// 拖拽导入:拖文件到窗口即导入
const dropOverlay = document.createElement('div');
dropOverlay.id = 'drop-overlay';
dropOverlay.innerHTML = '<div class="drop-hint">🎵 松手即可导入音乐</div>';
document.body.appendChild(dropOverlay);

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.add('show');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.remove('show');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('show');
  const files = Array.from(e.dataTransfer.files || []);
  if (!files.length) return;
  const paths = files.map((f) => window.api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const songs = await window.api.readMeta(paths);
  if (songs && songs.length) importSongs(songs);
});

// 表头排序
document.querySelectorAll('.st-head .st-col[data-sort]').forEach((col) => {
  col.addEventListener('click', () => setSort(col.dataset.sort));
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

// ===== 拖拽导入 =====
document.body.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
document.body.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files);
  if (!files.length) return;
  const paths = files.map((f) => window.api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const songs = await window.api.readMeta(paths);
  if (songs && songs.length) importSongs(songs);
});

// ===== 表头排序绑定 =====
document.querySelectorAll('.st-head .st-col[data-sort]').forEach((col) => {
  col.addEventListener('click', () => setSort(col.dataset.sort));
});

// ===== 频谱可视化 =====
function drawVisualizer() {
  const canvas = $('visualizer');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  function draw() {
    requestAnimationFrame(draw);
    if (!analyser || !dataArray) return;
    analyser.getByteFrequencyData(dataArray);

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, W, H);

    const barCount = 20;
    const barWidth = W / barCount;
    const step = Math.floor(dataArray.length / barCount);

    for (let i = 0; i < barCount; i++) {
      const val = dataArray[i * step] || 0;
      const barHeight = (val / 255) * H * 0.9;
      const x = i * barWidth;
      const y = H - barHeight;
      const hue = 140; // 绿色
      ctx.fillStyle = audio.paused ? '#3a3a3a' : `hsl(${hue}, 70%, ${45 + val / 255 * 20}%)`;
      ctx.fillRect(x + 1, y, barWidth - 2, barHeight);
    }
  }
  draw();
}

// ===== 均衡器 =====
function initEQ() {
  const container = $('eq-sliders');
  container.innerHTML = EQ_BANDS.map((freq, i) => {
    const label = freq >= 1000 ? (freq / 1000) + 'k' : freq + '';
    return `<div class="eq-band">
      <span class="eq-value" id="eq-val-${i}">0dB</span>
      <input type="range" class="eq-slider" id="eq-${i}" min="-12" max="12" step="1" value="${eqGains[i]}">
      <span class="eq-label">${label}Hz</span>
    </div>`;
  }).join('');

  EQ_BANDS.forEach((_, i) => {
    const slider = $(`eq-${i}`);
    const valLabel = $(`eq-val-${i}`);
    const update = () => {
      const val = +slider.value;
      eqGains[i] = val;
      valLabel.textContent = (val > 0 ? '+' : '') + val + 'dB';
      if (eqFilters[i]) eqFilters[i].gain.value = val;
      LS.set('eqGains', eqGains);
    };
    slider.addEventListener('input', update);
    update();
  });

  document.querySelectorAll('.eq-preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = EQ_PRESETS[btn.dataset.preset];
      if (!preset) return;
      eqGains = [...preset];
      EQ_BANDS.forEach((_, i) => {
        $(`eq-${i}`).value = eqGains[i];
        $(`eq-val-${i}`).textContent = (eqGains[i] > 0 ? '+' : '') + eqGains[i] + 'dB';
        if (eqFilters[i]) eqFilters[i].gain.value = eqGains[i];
      });
      LS.set('eqGains', eqGains);
      document.querySelectorAll('.eq-preset-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

// 均衡器按钮(侧边栏底部已有,绑定打开弹窗)
const eqBtn = document.querySelector('#btn-equalizer');
if (eqBtn) {
  eqBtn.addEventListener('click', () => {
    $('eq-modal').hidden = false;
    if (!$('eq-sliders').innerHTML) initEQ();
  });
}
$('eq-close').addEventListener('click', () => { $('eq-modal').hidden = true; });

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
