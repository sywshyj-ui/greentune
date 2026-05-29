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

let view = 'home';                         // home|search|library|favorites|recent|pl:<id>|online
let queue = [];                            // 当前可见列表(filePath[])
let currentPath = null;
let playMode = LS.get('playMode', 'list'); // list|shuffle|one|all
let isSeeking = false;
let lrc = null;
let lrcIdx = -1;
let sortKey = LS.get('sortKey', '');       // ''|title|artist|album|duration
let sortAsc = LS.get('sortAsc', true);
let onlineResults = [];                    // 在线搜索结果
let onlineQuery = '';                      // 当前在线搜索关键词
let onlinePlaylists = LS.get('onlinePlaylists', []); // 导入的在线歌单 {id,name,source,songs:[{neid,name,artist,album,picUrl,duration}]}
// 在线歌单播放状态:网易云歌单的歌经 QQ 解析后播放,需独立的队列以支持自动下一首
let onlinePlaylistMode = false;            // 当前是否在播放“在线歌单”里的歌
let onlinePlayList = null;                 // 正在播放的在线歌单 songs 数组
let onlinePlayIdx = -1;                    // 在该数组中的索引

// Web Audio 频谱
let audioCtx = null;
let analyser = null;
let source = null;
let dataArray = null;
let eqFilters = []; // 10 段均衡器滤波器
let eqGains = LS.get('eqGains', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // 均衡器增益
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
const VIEW_TITLES = { home: '主页', search: '搜索结果', library: '音乐库', favorites: '我喜欢', recent: '最近播放', online: '在线搜索', recommend: '为你推荐' };

function computeQueue() {
  let paths;
  if (view === 'favorites') paths = favorites.filter(byPath);
  else if (view === 'recent') paths = recent.filter(byPath);
  else if (view === 'online' || view === 'recommend') return []; // 在线搜索和推荐不用 queue,直接渲染 onlineResults
  else if (view.startsWith('opl:')) return []; // 在线歌单单独渲染
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
  // 防线:当前 view 指向已被删除的歌单时,自动退回主页(避免删了还显示旧内容)
  if (view.startsWith('pl:') && !playlists.find((p) => p.id === view.slice(3))) view = 'home';
  if (view.startsWith('opl:') && !onlinePlaylists.find((p) => p.id === view.slice(4))) view = 'home';

  // 标题
  let title = VIEW_TITLES[view] || '主页';
  if (view.startsWith('pl:')) {
    const pl = playlists.find((p) => p.id === view.slice(3));
    title = pl ? pl.name : '歌单';
  } else if (view.startsWith('opl:')) {
    const opl = onlinePlaylists.find((p) => p.id === view.slice(4));
    title = opl ? opl.name : '在线歌单';
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

  // —— 在线类视图(搜索/推荐/导入的在线歌单)单独渲染,不走本地空状态逻辑 ——
  if (view === 'online' || view === 'recommend') {
    $('view-count').textContent = onlineResults.length ? `${onlineResults.length} 首歌曲` : '';
    renderOnlineRows(onlineResults, view === 'recommend' ? '推荐' : '在线',
      view === 'recommend' ? '先听几首歌,稍后这里会有推荐' : '输入关键词搜索在线音乐');
    return;
  }
  if (view.startsWith('opl:')) {
    const opl = onlinePlaylists.find((p) => p.id === view.slice(4));
    $('view-count').textContent = (opl && opl.songs.length) ? `${opl.songs.length} 首歌曲` : '';
    renderOnlinePlaylistRows(opl);
    return;
  }

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

  // 本地歌曲渲染
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
    row.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+单击:切换该行选中,保留其他已选
        row.classList.toggle('selected');
      } else if (e.shiftKey) {
        // Shift+单击:选中从上一个选中行到当前行的区间
        const rows = Array.from(body.querySelectorAll('.st-row'));
        const cur = rows.indexOf(row);
        let last = rows.findIndex((r) => r.classList.contains('selected'));
        if (last < 0) last = cur;
        const [a, b] = [Math.min(last, cur), Math.max(last, cur)];
        for (let i = a; i <= b; i++) rows[i].classList.add('selected');
      } else {
        // 普通单击:只选中这一行
        document.querySelectorAll('.st-row').forEach((r) => r.classList.remove('selected'));
        row.classList.add('selected');
      }
    });
    row.addEventListener('dblclick', () => playPath(row.dataset.path));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, row.dataset.path);
    });
  });

  updateSortIndicators();
}

// 渲染在线搜索/推荐结果(QQ 搜索结果结构:name/artists[]/album.name/duration)
function renderOnlineRows(list, genreLabel, emptyHint) {
  const body = $('song-body'), empty = $('empty-state'), table = $('song-table');
  if (!list || !list.length) {
    table.hidden = true;
    empty.hidden = false;
    $('empty-title').textContent = '🔍 在线音乐';
    $('empty-sub').textContent = emptyHint || '输入关键词搜索';
    return;
  }
  table.hidden = false;
  empty.hidden = true;
  body.innerHTML = list.map((s, i) => {
    const playing = currentPath === s.id;
    return `<div class="st-row ${playing ? 'playing' : ''}" data-online-id="${s.id}">
      <div class="row-idx"><span class="num">${i + 1}</span><span class="play-mark">▶</span></div>
      <div class="row-main">
        <div class="row-cover">${s.picUrl ? `<img src="${s.picUrl}?param=40y40" alt="">` : '🎵'}</div>
        <div class="row-text">
          <span class="row-title">${esc(s.name)}</span>
          <span class="row-artist">${esc(s.artists.map(a => a.name).join(', '))}</span>
        </div>
      </div>
      <div class="row-album">${esc(s.album.name)}</div>
      <div class="row-genre">${genreLabel}</div>
      <div class="row-dur">${fmt(s.duration / 1000)}</div>
    </div>`;
  }).join('');
  body.querySelectorAll('.st-row').forEach((row) => {
    row.addEventListener('click', () => playOnline(row.dataset.onlineId));
  });
}

// 渲染导入的在线歌单(网易云元数据,点击经 QQ 解析播放)
function renderOnlinePlaylistRows(opl) {
  const body = $('song-body'), empty = $('empty-state'), table = $('song-table');
  const songs = opl ? opl.songs : [];
  if (!songs.length) {
    table.hidden = true;
    empty.hidden = false;
    $('empty-title').textContent = '空歌单';
    $('empty-sub').textContent = '这个在线歌单没有歌曲';
    return;
  }
  table.hidden = false;
  empty.hidden = true;
  body.innerHTML = songs.map((s, i) => {
    const playing = onlinePlaylistMode && onlinePlayList === opl.songs && onlinePlayIdx === i;
    return `<div class="st-row ${playing ? 'playing' : ''}" data-opl-idx="${i}">
      <div class="row-idx"><span class="num">${i + 1}</span><span class="play-mark">▶</span></div>
      <div class="row-main">
        <div class="row-cover">${s.picUrl ? `<img src="${s.picUrl}?param=40y40" alt="">` : '🎵'}</div>
        <div class="row-text">
          <span class="row-title">${esc(s.name)}</span>
          <span class="row-artist">${esc(s.artist)}</span>
        </div>
      </div>
      <div class="row-album">${esc(s.album)}</div>
      <div class="row-genre">网易云</div>
      <div class="row-dur">${s.duration ? fmt(s.duration / 1000) : '—'}</div>
    </div>`;
  }).join('');
  body.querySelectorAll('.st-row').forEach((row) => {
    row.addEventListener('click', () => playFromOnlinePlaylist(opl.id, +row.dataset.oplIdx));
  });
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
  // 若删除的是正在播放的歌,先停止播放并清空播放信息,避免 currentPath 变野指针
  if (path === currentPath) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    currentPath = null;
    $('now-title').textContent = '未播放';
    $('now-artist').textContent = '选择一首歌曲开始';
    $('now-cover').classList.remove('rotating');
  }
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

// 批量删除(全选/多选后按 Delete):一次性处理并只渲染一次
function deleteSongs(paths) {
  if (!paths || !paths.length) return;
  const set = new Set(paths);
  // 若正在播放的歌在删除列表里,先停掉
  if (currentPath && set.has(currentPath)) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    currentPath = null;
    $('now-title').textContent = '未播放';
    $('now-artist').textContent = '选择一首歌曲开始';
    $('now-cover').classList.remove('rotating');
  }
  library = library.filter((s) => !set.has(s.filePath));
  favorites = favorites.filter((p) => !set.has(p));
  recent = recent.filter((p) => !set.has(p));
  playlists.forEach((pl) => { pl.songs = pl.songs.filter((p) => !set.has(p)); });
  paths.forEach((p) => { delete coverCache[p]; });
  saveLib();
  LS.set('favorites', favorites);
  LS.set('recent', recent);
  LS.set('playlists', playlists);
  renderPlaylists();
  render();
}
// 归一化:去空格、转小写,用于判断标题+歌手是否相同
function dupKey(s) {
  const norm = (x) => (x || '').toString().trim().toLowerCase().replace(/\s+/g, '');
  return norm(s.title) + '|' + norm(s.artist);
}

function findDuplicates() {
  const groups = {};
  for (const s of library) {
    const k = dupKey(s);
    (groups[k] = groups[k] || []).push(s);
  }
  // 只保留有 2 首及以上的分组
  return Object.values(groups).filter((g) => g.length > 1);
}

function renderDupList() {
  const dups = findDuplicates();
  const box = $('dup-list');
  if (!dups.length) {
    box.innerHTML = '<div class="dup-empty">🎉 没有发现重复歌曲</div>';
    return;
  }
  box.innerHTML = dups.map((g) => {
    const s0 = g[0];
    const head = `${esc(s0.title)} — ${esc(s0.artist)} (${g.length} 首)`;
    const songs = g.map((s) => `
      <div class="dup-song" data-path="${esc(s.filePath)}">
        <span class="dup-name">${esc(s.title)}</span>
        <span class="dup-path">${esc(s.filePath)}</span>
        <button class="dup-del" data-del="${esc(s.filePath)}">删除</button>
      </div>`).join('');
    return `<div class="dup-group"><div class="dup-group-title">${head}</div>${songs}</div>`;
  }).join('');

  box.querySelectorAll('.dup-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      const path = btn.dataset.del;
      if (!confirm('确定从音乐库删除这首歌吗?(不会删除磁盘文件)')) return;
      deleteSong(path);
      renderDupList(); // 删完刷新弹窗
    });
  });
}

const findDupBtn = $('find-dup');
if (findDupBtn) {
  findDupBtn.addEventListener('click', () => {
    $('dup-modal').hidden = false;
    renderDupList();
  });
}
$('dup-close').addEventListener('click', () => { $('dup-modal').hidden = true; });

// 补全歌曲信息
async function completeSongInfo(path) {
  const s = byPath(path);
  if (!s) return;
  try {
    const results = await window.api.qqSearch(s.title + (s.artist ? ' ' + s.artist : ''), 1);
    const song = results && results[0];
    if (!song) { alert('未找到匹配的在线歌曲信息'); return; }

    // 更新信息
    s.artist = (song.artists || []).map(a => a.name).join(', ') || s.artist;
    s.album = (song.album && song.album.name) || s.album;
    if (song.picUrl && !coverCache[path]) {
      coverCache[path] = song.picUrl;
    }
    saveLib();
    render();
    if (currentPath === path) {
      $('now-artist').textContent = s.artist;
      if (coverCache[path]) $('now-cover').innerHTML = `<img src="${coverCache[path]}" alt="">`;
    }
    alert('歌曲信息已更新');
  } catch (e) {
    console.error('信息补全失败:', e);
    alert('信息补全失败,请检查网络连接');
  }
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
  // 当前选中的行(支持多选批量删除)
  const selPaths = Array.from(document.querySelectorAll('.st-row.selected'))
    .map((r) => r.dataset.path).filter(Boolean);
  const multi = selPaths.length > 1 && selPaths.includes(path);

  items.push({ label: '▶ 播放', fn: () => playPath(path) });
  items.push({ label: liked ? '♥ 取消喜欢' : '♡ 添加到喜欢', fn: () => toggleFav(path) });
  items.push({ label: '＋ 加入歌单…', sub: playlists.length ? playlists.map((p) => ({
    label: p.name, fn: () => addToPlaylist(path, p.id)
  })) : [{ label: '(暂无歌单,先新建)', disabled: true }] });
  if (inPl) items.push({ label: '✕ 从此歌单移除', fn: () => removeFromPlaylist(path, inPl) });
  items.push({ label: '🔄 补全歌曲信息', fn: () => completeSongInfo(path) });
  items.push({ sep: true });
  if (multi) {
    // 多选时:批量删除选中的全部
    items.push({ label: `🗑 删除选中的 ${selPaths.length} 首`, danger: true, fn: () => {
      if (confirm(`确定从音乐库删除选中的 ${selPaths.length} 首歌吗?(不会删除磁盘文件)`)) deleteSongs(selPaths);
    } });
  } else {
    items.push({ label: '🗑 从音乐库删除', danger: true, fn: () => deleteSong(path) });
  }

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
  // 导入的在线歌单(网易云),用 ☁ 区分
  const online = onlinePlaylists.map((p) => `
    <div class="pl-item" data-view="opl:${p.id}" data-opl-id="${p.id}">
      <span class="pl-ico">☁</span>
      <div class="pl-meta"><span class="pl-name">${esc(p.name)}</span><span class="pl-sub">${p.songs.length} 首 · 网易云</span></div>
    </div>`).join('');
  list.innerHTML = fixed + custom + online;
  list.querySelectorAll('.pl-item').forEach((el) => {
    el.addEventListener('click', () => { view = el.dataset.view; render(); });
    const plId = el.dataset.plId;
    if (plId) {
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showPlaylistMenu(e.clientX, e.clientY, plId);
      });
    }
    const oplId = el.dataset.oplId;
    if (oplId) {
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showOnlinePlaylistMenu(e.clientX, e.clientY, oplId);
      });
    }
  });
}

// ===== 在线歌单右键菜单(重命名/删除) =====
function showOnlinePlaylistMenu(x, y, plId) {
  closeContextMenu();
  const pl = onlinePlaylists.find((p) => p.id === plId);
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
      LS.set('onlinePlaylists', onlinePlaylists);
      renderPlaylists();
      if (view === 'opl:' + plId) render();
    }
  });
  menu.querySelector('[data-action="delete"]').addEventListener('click', () => {
    closeContextMenu();
    if (!confirm(`确定删除在线歌单「${pl.name}」吗?`)) return;
    onlinePlaylists = onlinePlaylists.filter((p) => p.id !== plId);
    LS.set('onlinePlaylists', onlinePlaylists);
    if (view === 'opl:' + plId) { view = 'home'; render(); }
    renderPlaylists();
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
// 初始化 Web Audio 图(频谱 + 10 段均衡器),只建一次,所有播放共用
function ensureAudioGraph() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64; // 32 个频段
    source = audioCtx.createMediaElementSource(audio);

    // 均衡器滤波器链:source → f0 → f1 … → analyser → destination
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
  // 浏览器自动播放策略会挂起 AudioContext,导致均衡器/频谱失效,这里恢复
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playPath(path) {
  const s = byPath(path);
  if (!s) return;
  onlinePlaylistMode = false; // 切回本地播放,退出在线歌单连播
  currentPath = path;
  audio.src = 'file://' + path.replace(/\\/g, '/').replace(/#/g, '%23');
  audio.play().catch((e) => console.error('play error', e));

  ensureAudioGraph();

  // 现在播放信息
  $('now-title').textContent = s.title;
  $('now-artist').textContent = s.artist;
  const coverEl = $('now-cover');
  coverEl.innerHTML = coverHTML(path);
  coverEl.classList.add('rotating');
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

// 在线歌单连播时算下一首索引(shuffle 随机,否则顺序循环)
function onlineNextIdx(dir) {
  const n = onlinePlayList.length;
  if (n <= 1) return 0;
  if (playMode === 'shuffle') {
    let r; do { r = Math.floor(Math.random() * n); } while (r === onlinePlayIdx);
    return r;
  }
  return (onlinePlayIdx + dir + n) % n;
}

function playNext() {
  if (onlinePlaylistMode && onlinePlayList && onlinePlayList.length) {
    onlinePlayIdx = onlineNextIdx(1);
    resolveOnlineAndPlay(onlinePlayList[onlinePlayIdx]);
    return;
  }
  const i = nextIndex(1);
  if (i >= 0) playPath(queue[i]);
}
function playPrev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (onlinePlaylistMode && onlinePlayList && onlinePlayList.length) {
    onlinePlayIdx = onlineNextIdx(-1);
    resolveOnlineAndPlay(onlinePlayList[onlinePlayIdx]);
    return;
  }
  const i = nextIndex(-1);
  if (i >= 0) playPath(queue[i]);
}

function onEnded() {
  if (playMode === 'one') { audio.currentTime = 0; audio.play(); return; }
  // 在线歌单连播
  if (onlinePlaylistMode && onlinePlayList && onlinePlayList.length) {
    if (playMode === 'list' && onlinePlayIdx === onlinePlayList.length - 1) { setPlayIcon(false); return; }
    playNext();
    return;
  }
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

  // 本地没有,尝试在线搜索(只要有标题就搜,歌手可缺省)
  if (!data || !data.length) {
    const s = byPath(path);
    const realArtist = s && s.artist && s.artist !== 'Unknown Artist' ? s.artist : '';
    if (s && s.title) {
      box.innerHTML = '<p class="lp-placeholder">本地无歌词,正在联网搜索…</p>';
      data = await searchOnlineLyrics(s.title, realArtist);
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

// 在线歌词搜索(QQ 音乐 API,无需 key)
async function searchOnlineLyrics(title, artist) {
  // 仅在有歌手时才用缓存:否则两首同名无歌手的歌会共用缓存键而串词
  const cacheKey = artist ? `lrc_${title}_${artist}` : null;
  if (cacheKey) {
    const cached = LS.get(cacheKey, null);
    if (cached) return cached;
  }

  try {
    // 通过 QQ 音乐搜索歌曲(歌手可为空)
    const query = (title + ' ' + (artist || '')).trim();
    const results = await window.api.qqSearch(query, 1);
    const song = results && results[0];
    if (!song || !song.id) return null;

    // 获取歌词(QQ songmid)
    const raw = await window.api.qqLyric(song.id);
    if (!raw) return null;

    // 解析 LRC
    const lines = parseLRC(raw);
    if (lines.length) {
      if (cacheKey) LS.set(cacheKey, lines); // 仅有歌手时缓存
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

    // 如果没有封面,尝试在线获取
    if (!s.cover && !coverCache[s.filePath]) {
      fetchOnlineCover(s.filePath, s.title, s.artist);
    }
  }
  saveLib();
  renderPlaylists();
  render();
}

// 在线获取封面
async function fetchOnlineCover(filePath, title, artist) {
  if (!title) return;
  try {
    const results = await window.api.qqSearch(title + (artist ? ' ' + artist : ''), 1);
    const song = results && results[0];
    if (song && song.picUrl) {
      coverCache[filePath] = song.picUrl;
      // 局部更新封面显示
      const coverEl = document.querySelector(`.st-row[data-path="${CSS.escape(filePath)}"] .row-cover`);
      if (coverEl) coverEl.innerHTML = `<img src="${coverCache[filePath]}" alt="">`;
      if (currentPath === filePath) $('now-cover').innerHTML = `<img src="${coverCache[filePath]}" alt="">`;
    }
  } catch (e) {
    console.error('封面获取失败:', e);
  }
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

// ===== 点击头像显示鼓励性话语(可拖动、可调整大小) =====
const CHEER_WORDS = [
  '你超棒的!', '今天也要加油哦', '相信自己,你可以的', '保持热爱,奔赴山海',
  '慢慢来,比较快', '你已经很努力了', '世界因你而美好', '继续闪闪发光吧',
  '一切都会好起来的', '你值得所有美好', '勇敢的人先享受世界', '愿你被生活温柔以待'
];
let cheerTimer = null;
const cheerToast = $('cheer-toast');

// 恢复上次保存的位置和字号
const savedCheer = LS.get('cheerPos', null);
if (savedCheer) {
  if (savedCheer.left != null) { cheerToast.style.left = savedCheer.left + 'px'; cheerToast.style.right = 'auto'; }
  if (savedCheer.top != null) cheerToast.style.top = savedCheer.top + 'px';
  if (savedCheer.size) cheerToast.style.fontSize = savedCheer.size + 'px';
}

function saveCheerPos() {
  LS.set('cheerPos', {
    left: parseInt(cheerToast.style.left) || null,
    top: parseInt(cheerToast.style.top) || null,
    size: parseInt(cheerToast.style.fontSize) || 56
  });
}

$('now-cover').addEventListener('click', () => {
  const word = CHEER_WORDS[Math.floor(Math.random() * CHEER_WORDS.length)];
  cheerToast.textContent = word;
  cheerToast.classList.remove('show');
  void cheerToast.offsetWidth;
  cheerToast.classList.add('show');
  clearTimeout(cheerTimer);
  cheerTimer = setTimeout(() => cheerToast.classList.remove('show'), 10000);
});

// 拖动 + 调整大小逻辑
let dragMode = null; // 'move'
let startX, startY, startLeft, startTop;

cheerToast.addEventListener('mousedown', (e) => {
  clearTimeout(cheerTimer); // 交互时不让它消失
  const rect = cheerToast.getBoundingClientRect();
  dragMode = 'move';
  startX = e.clientX; startY = e.clientY;
  startLeft = rect.left; startTop = rect.top;
  e.preventDefault();
});

// 滚轮缩放字号(悬停在文字上滚动),范围 20~160px,比拖角更直观
cheerToast.addEventListener('wheel', (e) => {
  e.preventDefault();
  clearTimeout(cheerTimer);
  const cur = parseInt(getComputedStyle(cheerToast).fontSize) || 56;
  const next = Math.max(20, Math.min(160, cur + (e.deltaY < 0 ? 4 : -4)));
  cheerToast.style.fontSize = next + 'px';
  saveCheerPos();
  cheerTimer = setTimeout(() => cheerToast.classList.remove('show'), 10000);
}, { passive: false });

document.addEventListener('mousemove', (e) => {
  if (!dragMode) return;
  cheerToast.style.left = (startLeft + e.clientX - startX) + 'px';
  cheerToast.style.top = (startTop + e.clientY - startY) + 'px';
  cheerToast.style.right = 'auto';
});

document.addEventListener('mouseup', () => {
  if (dragMode) {
    saveCheerPos();
    dragMode = null;
    // 交互结束后重新计时 10 秒消失
    clearTimeout(cheerTimer);
    cheerTimer = setTimeout(() => cheerToast.classList.remove('show'), 10000);
  }
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
    if (view === 'search' || view === 'online') {
      // 延迟聚焦,确保 render 完成后再聚焦
      setTimeout(() => {
        const input = $('search-input');
        if (input) {
          input.disabled = false; // 确保未被禁用
          input.focus();
        }
      }, 100);
    }
    if (view === 'online') { $('search-input').placeholder = '搜索在线音乐…'; }
    else { $('search-input').placeholder = '搜索歌曲、艺术家、专辑'; }
    if (view === 'recommend') loadRecommendations();
    render();
  });
});

// 搜索
let onlineTimer = null;
$('search-input').addEventListener('input', () => {
  if (view === 'online') {
    clearTimeout(onlineTimer);
    onlineTimer = setTimeout(() => searchOnlineMusic($('search-input').value), 600);
  } else {
    if (view !== 'search') view = 'search';
    render();
  }
});

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

// ===== 导入网易云歌单 =====
// 从粘贴的链接/文本里提取歌单 ID
function parsePlaylistId(text) {
  if (!text) return null;
  const t = text.trim();
  if (/^\d+$/.test(t)) return t;            // 纯数字 = 歌单ID
  let m = t.match(/[?&]id=(\d+)/);           // ...?id=123 / &id=123
  if (m) return m[1];
  m = t.match(/playlist\/(\d+)/);            // .../playlist/123
  if (m) return m[1];
  m = t.match(/(\d{6,})/);                   // 兜底:抓一长串数字
  return m ? m[1] : null;
}

const importBtn = $('import-pl');
if (importBtn) {
  importBtn.addEventListener('click', () => {
    $('import-modal').hidden = false;
    $('import-url-input').value = '';
    $('import-status').textContent = '';
    $('import-url-input').focus();
  });
}
$('import-cancel').addEventListener('click', () => { $('import-modal').hidden = true; });
$('import-url-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doImportPlaylist();
  if (e.key === 'Escape') $('import-modal').hidden = true;
});
$('import-confirm').addEventListener('click', doImportPlaylist);

async function doImportPlaylist() {
  const id = parsePlaylistId($('import-url-input').value);
  const status = $('import-status');
  if (!id) { status.textContent = '没识别到歌单 ID,请粘贴完整链接'; return; }
  status.textContent = '正在拉取歌单…';
  $('import-confirm').disabled = true;
  try {
    const data = await window.api.neteasePlaylist(id);
    if (!data || !data.songs || !data.songs.length) {
      status.textContent = '拉取失败:歌单为空或无法访问(可能是私密歌单)';
      return;
    }
    // 同一个网易云歌单(按 neid 去重)重复导入时更新而非新增
    const existed = onlinePlaylists.find((p) => p.neid === id);
    const pl = existed || { id: 'opl' + Date.now(), neid: id, name: data.name, source: 'netease', songs: [] };
    pl.name = data.name;
    pl.songs = data.songs;
    if (!existed) onlinePlaylists.push(pl);
    LS.set('onlinePlaylists', onlinePlaylists);
    renderPlaylists();
    $('import-modal').hidden = true;
    view = 'opl:' + pl.id;
    render();
  } catch (e) {
    console.error('导入失败:', e);
    status.textContent = '导入失败,请检查网络连接';
  } finally {
    $('import-confirm').disabled = false;
  }
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
  else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A') && !typing) {
    // Ctrl+A 全选当前列表所有歌曲(在线视图不适用)
    if (view === 'online' || view === 'recommend' || view.startsWith('opl:')) return;
    e.preventDefault();
    document.querySelectorAll('.st-row').forEach((r) => r.classList.add('selected'));
  }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
    // 删除选中的歌曲(本地视图);在线视图不支持
    if (view === 'online' || view === 'recommend' || view.startsWith('opl:')) return;
    const sel = Array.from(document.querySelectorAll('.st-row.selected'))
      .map((r) => r.dataset.path).filter(Boolean);
    if (!sel.length) return;
    e.preventDefault();
    if (!confirm(`确定从音乐库删除选中的 ${sel.length} 首歌吗?(不会删除磁盘文件)`)) return;
    deleteSongs(sel);
  }
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
const eqBtn = $('eq-btn');
if (eqBtn) {
  eqBtn.addEventListener('click', () => {
    $('eq-modal').hidden = false;
    if (!$('eq-sliders').innerHTML) initEQ();
  });
}
$('eq-close').addEventListener('click', () => { $('eq-modal').hidden = true; });

// ===== 在线音乐搜索与试听 =====
async function searchOnlineMusic(keyword) {
  if (!keyword || !keyword.trim()) { onlineResults = []; render(); return; }
  onlineQuery = keyword;
  const body = $('song-body');
  body.innerHTML = '<div class="online-loading">正在搜索在线音乐…</div>';
  try {
    onlineResults = await window.api.qqSearch(keyword, 50);
    render();
  } catch (e) {
    console.error('在线搜索失败:', e);
    onlineResults = [];
    body.innerHTML = '<div class="online-loading">搜索失败,请检查网络连接</div>';
  }
}

async function playOnline(songId) {
  const song = onlineResults.find((s) => s.id == songId);
  if (!song) return;
  onlinePlaylistMode = false; // 普通在线搜索播放,非歌单连播
  try {
    const playUrl = await window.api.qqUrl(songId);
    if (!playUrl) { alert('该歌曲为付费/会员歌曲,无法试听'); return; }
    currentPath = String(songId);
    audio.src = playUrl;
    audio.play().catch((e) => console.error('播放失败', e));
    // 注意:不对在线流接入 Web Audio 图。QQ 音频是跨域资源,且 audio 未设
    // crossOrigin,经 createMediaElementSource 会被判为 tainted 而输出静音。
    // 因此在线试听跳过均衡器/频谱(本地播放不受影响)。
    $('now-title').textContent = song.name;
    $('now-artist').textContent = song.artists.map((a) => a.name).join(', ');
    const coverEl = $('now-cover');
    coverEl.innerHTML = song.picUrl ? `<img src="${song.picUrl}" alt="">` : '<img src="assets/logo.jpg" alt="">';
    coverEl.classList.add('rotating');
    $('like-btn').classList.remove('liked');
    $('like-btn').textContent = '♡';
    loadOnlineLyrics(songId);
    render();
  } catch (e) {
    console.error('播放失败:', e);
    alert('播放失败,请重试');
  }
}

// ===== 在线歌单播放(列表来自网易云,播放经 QQ 音乐解析) =====
async function playFromOnlinePlaylist(plId, idx) {
  const pl = onlinePlaylists.find((p) => p.id === plId);
  if (!pl || !pl.songs[idx]) return;
  onlinePlaylistMode = true;
  onlinePlayList = pl.songs;
  onlinePlayIdx = idx;
  await resolveOnlineAndPlay(pl.songs[idx]);
}

// 用 QQ 音乐按歌名+歌手搜一首并播放;界面信息仍用网易云的元数据(更贴合用户歌单)
async function resolveOnlineAndPlay(meta) {
  const titleEl = $('now-title'), artistEl = $('now-artist'), coverEl = $('now-cover');
  titleEl.textContent = meta.name;
  artistEl.textContent = '正在解析…';
  try {
    const realArtist = meta.artist && meta.artist !== 'Unknown Artist' ? meta.artist : '';
    const q = (meta.name + ' ' + realArtist).trim();
    const results = await window.api.qqSearch(q, 1);
    const song = results && results[0];
    if (!song || !song.id) { artistEl.textContent = meta.artist; alert('未找到可播放资源:' + meta.name); return; }
    const playUrl = await window.api.qqUrl(song.id);
    if (!playUrl) { artistEl.textContent = meta.artist; alert('「' + meta.name + '」为付费/会员歌曲,无法试听'); return; }
    currentPath = String(song.id);
    audio.src = playUrl;
    audio.play().catch((e) => console.error('播放失败', e));
    titleEl.textContent = meta.name;
    artistEl.textContent = meta.artist;
    coverEl.innerHTML = meta.picUrl ? `<img src="${meta.picUrl}?param=120y120" alt="">`
      : (song.picUrl ? `<img src="${song.picUrl}" alt="">` : '<img src="assets/logo.jpg" alt="">');
    coverEl.classList.add('rotating');
    $('like-btn').classList.remove('liked');
    $('like-btn').textContent = '♡';
    loadOnlineLyrics(song.id);
    render();
  } catch (e) {
    console.error('在线歌单播放失败:', e);
    artistEl.textContent = meta.artist;
    alert('播放失败,请重试');
  }
}

// 在线歌词获取
async function loadOnlineLyrics(songId) {
  lrc = null; lrcIdx = -1;
  const box = $('lp-lyrics');
  box.innerHTML = '<p class="lp-placeholder">正在加载歌词…</p>';
  try {
    const raw = await window.api.qqLyric(songId);
    if (path_changed(songId)) return;
    if (!raw) { box.innerHTML = '<p class="lp-placeholder">暂无歌词</p>'; return; }
    lrc = parseLrc(raw);
    if (!lrc.length) { box.innerHTML = '<p class="lp-placeholder">暂无歌词</p>'; return; }
    box.innerHTML = lrc.map((l, i) => `<p data-i="${i}">${esc(l.text)}</p>`).join('');
  } catch (e) {
    box.innerHTML = '<p class="lp-placeholder">歌词加载失败</p>';
  }
}

function path_changed(songId) { return currentPath !== String(songId); }
function parseLrc(raw) {
  const out = [];
  raw.split('\n').forEach((line) => {
    const m = line.match(/\[(\d+):(\d+)(?:\.(\d+))?\]/g);
    const text = line.replace(/\[.*?\]/g, '').trim();
    if (!m || !text) return;
    m.forEach((tag) => {
      const t = tag.match(/\[(\d+):(\d+)(?:\.(\d+))?\]/);
      const time = (+t[1]) * 60 + (+t[2]) + (t[3] ? (+t[3]) / (t[3].length === 2 ? 100 : 1000) : 0);
      out.push({ time, text });
    });
  });
  return out.sort((a, b) => a.time - b.time);
}

// ===== 音乐推荐 =====
async function loadRecommendations() {
  onlineResults = [];
  const body = $('song-body');
  body.innerHTML = '<div class="online-loading">正在生成推荐…</div>';

  // 基于最常听的艺术家推荐
  const artistCount = {};
  favorites.concat(recent).forEach((path) => {
    const s = byPath(path);
    if (s && s.artist) {
      const artist = s.artist.split(/[,，&、]/)[0].trim(); // 取第一个艺术家
      artistCount[artist] = (artistCount[artist] || 0) + 1;
    }
  });

  const topArtists = Object.entries(artistCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([artist]) => artist);

  if (!topArtists.length) {
    body.innerHTML = '<div class="online-loading">暂无推荐,先听几首歌吧~</div>';
    return;
  }

  try {
    // 搜索热门艺术家的歌曲
    const keyword = topArtists[0];
    onlineResults = await window.api.qqSearch(keyword, 30);
    render();
  } catch (e) {
    console.error('推荐加载失败:', e);
    body.innerHTML = '<div class="online-loading">推荐加载失败,请检查网络连接</div>';
  }
}

// ===== 修复旧数据乱码 =====
// 之前导入时缓存进 localStorage 的标题可能是乱码(GBK 被误读),
// 这些数据不会经过主进程的 fixGBK。启动时检测并重新读取元数据修复。
function hasMojibake(str) {
  if (!str) return false;
  // 含有高位 Latin-1 字符且没有正常中文/常规 ASCII 单词,疑似乱码
  return /[-ÿ]/.test(str) && !/[一-鿿]/.test(str);
}

async function repairGarbledTitles() {
  const bad = library.filter((s) => hasMojibake(s.title) || hasMojibake(s.artist) || hasMojibake(s.album));
  if (!bad.length) return;
  try {
    const fresh = await window.api.readMeta(bad.map((s) => s.filePath));
    if (!fresh || !fresh.length) return;
    const map = {};
    fresh.forEach((f) => { map[f.filePath] = f; });
    let changed = false;
    library.forEach((s) => {
      const f = map[s.filePath];
      if (f) {
        s.title = f.title; s.artist = f.artist; s.album = f.album;
        s.genre = f.genre; s.year = f.year;
        if (f.cover) coverCache[s.filePath] = f.cover;
        changed = true;
      }
    });
    if (changed) { saveLib(); render(); }
  } catch (e) {
    console.error('乱码修复失败:', e);
  }
}

// ===== 初始化 =====
function init() {
  applyTheme();
  audio.volume = volume;
  volBar.apply(volume);
  applyModeUI();
  renderPlaylists();
  render();
  repairGarbledTitles(); // 自动修复旧的乱码标题
}
init();
