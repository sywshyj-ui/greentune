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
let onlinePlaylistMode = false;            // 当前是否在播放”在线歌单”里的歌
let onlinePlayList = null;                 // 正在播放的在线歌单 songs 数组
let onlinePlayIdx = -1;                    // 在该数组中的索引

// 插件系统
let plugins = [];                          // 所有已加载的插件列表
let currentSource = LS.get('currentSource', 'builtin_qq'); // 当前选中的音源插件 ID

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
// 复制文本到剪贴板,成功后给个轻提示
async function copyText(text) {
  if (!text) return;
  const ok = await window.api.copyText(text);
  toast(ok ? '已复制:' + text : '复制失败');
}
// 顶部轻提示(复用鼓励语 toast 的位置做个临时简易提示)
function toast(msg) {
  let el = document.getElementById('mini-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mini-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1800);
}
const byPath = (p) => library.find((x) => x.filePath === p);
const saveLib = () => LS.set('library', library.map((s) => ({ ...s, cover: null })));

// ---- 封面获取(优先内存缓存,其次歌曲对象) ----
const coverOf = (path) => coverCache[path] || (byPath(path)?.cover) || null;
function coverHTML(path, fallback = '🎵') {
  const c = coverOf(path);
  return c ? `<img src="${c}" alt="">` : fallback;
}
// 左下角播放器专用:无封面时回退到原来的头像图片,这样旋转动画始终有 <img> 可作用
function playerCoverHTML(path) {
  const c = coverOf(path);
  return `<img src="${c || 'assets/logo.jpg'}" alt="">`;
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
  $('refresh-recommend').hidden = (view !== 'recommend');
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

// 渲染在线搜索/推荐结果(统一音源结构:title/artist/album/artwork/duration)
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
    // 确保每首歌都有唯一ID，如果缺失则用索引作为后备
    const songId = s.id || `fallback_${i}`;
    const playing = currentPath === songId;
    return `<div class="st-row ${playing ? 'playing' : ''}" data-online-id="${songId}" data-index="${i}">
      <div class="row-idx"><span class="num">${i + 1}</span><span class="play-mark">▶</span></div>
      <div class="row-main">
        <div class="row-cover">${s.artwork ? `<img src="${s.artwork}" alt="">` : '🎵'}</div>
        <div class="row-text">
          <span class="row-title">${esc(s.title)}</span>
          <span class="row-artist">${esc(s.artist)}</span>
        </div>
      </div>
      <div class="row-album">${esc(s.album || '')}</div>
      <div class="row-genre">${genreLabel}</div>
      <div class="row-dur">${fmt((s.duration || 0) / 1000)}</div>
    </div>`;
  }).join('');
  body.querySelectorAll('.st-row').forEach((row) => {
    row.addEventListener('click', () => playOnline(row.dataset.onlineId));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showOnlineResultMenu(e.clientX, e.clientY, row.dataset.onlineId);
    });
  });
}

// 在线搜索结果的右键菜单(目前:下载到本地)
function showOnlineResultMenu(x, y, songId) {
  closeContextMenu();
  const song = onlineResults.find((s) => s.id == songId);
  if (!song) return;
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'ctx-menu';
  menu.innerHTML = `<div class="ctx-item" data-action="dl">⬇ 下载到本地</div>
    <div class="ctx-item" data-action="copy">📋 复制歌曲名</div>`;
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
  menu.querySelector('[data-action="dl"]').addEventListener('click', () => {
    closeContextMenu();
    downloadOnlineSong(song);
  });
  menu.querySelector('[data-action="copy"]').addEventListener('click', () => {
    closeContextMenu();
    copyText(song.title);
  });
}

// 下载一首在线歌曲:先用当前音源解析试听地址,再交主进程弹保存框写盘
async function downloadOnlineSong(song) {
  try {
    const playUrl = await window.api.sourceUrl(currentSource, song, 'standard');
    if (!playUrl) { alert('该歌曲为付费/会员歌曲,无法下载'); return; }
    const name = `${song.title} - ${song.artist}`;
    const r = await window.api.downloadFile(playUrl, name);
    if (!r) return; // 用户在保存对话框取消
    if (r.ok) alert('已下载到:\n' + r.path);
    else alert('下载失败:' + (r.error || '未知错误'));
  } catch (e) {
    console.error('下载失败:', e);
    alert('下载失败,请重试');
  }
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
    // 兼容新旧字段名：优先用新字段(title/artwork)，回退到旧字段(name/picUrl)
    const title = s.title || s.name || '未知歌曲';
    const cover = s.artwork || s.picUrl;
    const coverUrl = cover ? (cover.includes('?') ? cover : `${cover}?param=40y40`) : null;
    return `<div class="st-row ${playing ? 'playing' : ''}" data-opl-idx="${i}">
      <div class="row-idx"><span class="num">${i + 1}</span><span class="play-mark">▶</span></div>
      <div class="row-main">
        <div class="row-cover">${coverUrl ? `<img src="${coverUrl}" alt="">` : '🎵'}</div>
        <div class="row-text">
          <span class="row-title">${esc(title)}</span>
          <span class="row-artist">${esc(s.artist)}</span>
        </div>
      </div>
      <div class="row-album">${esc(s.album)}</div>
      <div class="row-genre">网易云</div>
      <div class="row-dur">${s.duration ? fmt(s.duration / 1000) : '—'}</div>
    </div>`;
  }).join('');
  body.querySelectorAll('.st-row').forEach((row) => {
    // 单击=选中(支持 Ctrl 多选 / Shift 区间选),双击才播放
    row.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) {
        row.classList.toggle('selected');
      } else if (e.shiftKey) {
        const rows = Array.from(body.querySelectorAll('.st-row'));
        const cur = rows.indexOf(row);
        let last = rows.findIndex((r) => r.classList.contains('selected'));
        if (last < 0) last = cur;
        const [a, b] = [Math.min(last, cur), Math.max(last, cur)];
        for (let i = a; i <= b; i++) rows[i].classList.add('selected');
      } else {
        body.querySelectorAll('.st-row').forEach((r) => r.classList.remove('selected'));
        row.classList.add('selected');
      }
    });
    row.addEventListener('dblclick', () => playFromOnlinePlaylist(opl.id, +row.dataset.oplIdx));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showOnlineSongMenu(e.clientX, e.clientY, opl.id, +row.dataset.oplIdx);
    });
  });
}

// 在线歌单内歌曲的右键菜单:支持对多选项批量删除/下载
function showOnlineSongMenu(x, y, plId, idx) {
  closeContextMenu();
  const opl = onlinePlaylists.find((p) => p.id === plId);
  if (!opl || !opl.songs[idx]) return;
  const song = opl.songs[idx];

  // 右键行为(同本地列表):右键的行若不在已选集合里,就单独选中它;
  // 若右键的是已选中的行(多选),则对全部选中项批量操作。
  const body = $('song-body');
  let selRows = Array.from(body.querySelectorAll('.st-row.selected'));
  let selIdxs = selRows.map((r) => +r.dataset.oplIdx).filter((n) => !isNaN(n));
  if (!selIdxs.includes(idx)) {
    body.querySelectorAll('.st-row').forEach((r) => r.classList.remove('selected'));
    const thisRow = body.querySelector(`.st-row[data-opl-idx="${idx}"]`);
    if (thisRow) thisRow.classList.add('selected');
    selIdxs = [idx];
  }
  const multi = selIdxs.length > 1;

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'ctx-menu';
  if (multi) {
    menu.innerHTML = `
      <div class="ctx-item" data-action="dl">⬇ 下载选中的 ${selIdxs.length} 首</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item danger" data-action="del">🗑 从歌单删除选中的 ${selIdxs.length} 首</div>`;
  } else {
    menu.innerHTML = `
      <div class="ctx-item" data-action="play">▶ 播放</div>
      <div class="ctx-item" data-action="dl">⬇ 下载到本地</div>
      <div class="ctx-item" data-action="copy">📋 复制歌曲名</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item danger" data-action="del">🗑 从歌单删除</div>`;
  }
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';

  const play = menu.querySelector('[data-action="play"]');
  if (play) play.addEventListener('click', () => {
    closeContextMenu();
    playFromOnlinePlaylist(plId, idx);
  });
  const copy = menu.querySelector('[data-action="copy"]');
  if (copy) copy.addEventListener('click', () => {
    closeContextMenu();
    copyText(song.name);
  });
  menu.querySelector('[data-action="dl"]').addEventListener('click', () => {
    closeContextMenu();
    if (multi) downloadOnlineSongs(plId, selIdxs);
    else downloadPlaylistSong(song);
  });
  menu.querySelector('[data-action="del"]').addEventListener('click', () => {
    closeContextMenu();
    if (multi) {
      if (!confirm(`确定从歌单删除选中的 ${selIdxs.length} 首吗?`)) return;
      deleteOnlineSongs(plId, selIdxs);
    } else {
      if (!confirm(`确定从歌单删除「${song.name}」吗?`)) return;
      deleteOnlineSong(plId, idx);
    }
  });
}

// 批量下载在线歌单里的多首歌:只弹一次文件夹选择框,然后全部自动存进去
async function downloadOnlineSongs(plId, idxs) {
  const opl = onlinePlaylists.find((p) => p.id === plId);
  if (!opl) return;
  // 复制一份歌曲引用,避免下载过程中索引因删除等变化
  const songs = idxs.map((i) => opl.songs[i]).filter(Boolean);
  if (!songs.length) return;

  // 只弹一次:让用户选保存文件夹
  const dir = await window.api.pickSaveDir();
  if (!dir) return; // 用户取消

  let ok = 0, fail = 0;
  const total = songs.length;
  for (let i = 0; i < songs.length; i++) {
    const meta = songs[i];
    toast(`下载中 ${i + 1}/${total}:${meta.name}`);
    try {
      const realArtist = meta.artist && meta.artist !== 'Unknown Artist' ? meta.artist : '';
      const q = (meta.name + ' ' + realArtist).trim();
      const result = await window.api.sourceSearch(currentSource, q, 1, 'music');
      const song = result.data && result.data[0];
      if (!song || !song.id) { fail++; continue; }
      const playUrl = await window.api.sourceUrl(currentSource, song, 'standard');
      if (!playUrl) { fail++; continue; } // 付费/会员歌曲
      const r = await window.api.downloadToDir(playUrl, dir, `${meta.name} - ${meta.artist}`);
      if (r && r.ok) ok++; else fail++;
    } catch (e) {
      console.error('批量下载失败:', meta.name, e);
      fail++;
    }
  }
  alert(`下载完成:成功 ${ok} 首${fail ? `,失败 ${fail} 首(多为付费/会员歌曲)` : ''}\n保存位置:${dir}`);
}

// 批量从在线歌单删除多首歌:按索引从大到小删,避免前面删除导致后面索引错位
function deleteOnlineSongs(plId, idxs) {
  const sorted = [...idxs].sort((a, b) => b - a);
  for (const i of sorted) deleteOnlineSong(plId, i);
}

// 下载在线歌单里的一首歌:歌单只有网易云元数据,先用歌名+歌手经 QQ 解析出试听地址再下载
async function downloadPlaylistSong(meta) {
  try {
    const realArtist = meta.artist && meta.artist !== 'Unknown Artist' ? meta.artist : '';
    const q = (meta.name + ' ' + realArtist).trim();
    const result = await window.api.sourceSearch(currentSource, q, 1, 'music');
    const song = result.data && result.data[0];
    if (!song || !song.id) { alert('未找到可下载资源:' + meta.name); return; }
    const playUrl = await window.api.sourceUrl(currentSource, song, 'standard');
    if (!playUrl) { alert('「' + meta.name + '」为付费/会员歌曲,无法下载'); return; }
    const r = await window.api.downloadFile(playUrl, `${meta.name} - ${meta.artist}`);
    if (!r) return; // 用户取消保存
    if (r.ok) alert('已下载到:\n' + r.path);
    else alert('下载失败:' + (r.error || '未知错误'));
  } catch (e) {
    console.error('下载失败:', e);
    alert('下载失败,请重试');
  }
}

// 从在线歌单删除一首歌:若删的是正在连播的当前歌则停掉,并修正播放索引
function deleteOnlineSong(plId, idx) {
  const opl = onlinePlaylists.find((p) => p.id === plId);
  if (!opl || idx < 0 || idx >= opl.songs.length) return;
  // 若正在连播这个歌单
  if (onlinePlaylistMode && onlinePlayList === opl.songs) {
    if (onlinePlayIdx === idx) {
      // 删的就是当前播放的歌,停掉播放
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      currentPath = null;
      onlinePlaylistMode = false;
      onlinePlayList = null;
      onlinePlayIdx = -1;
      $('now-title').textContent = '未播放';
      $('now-artist').textContent = '选择一首歌曲开始';
      $('now-cover').classList.remove('rotating');
    } else if (onlinePlayIdx > idx) {
      // 删的歌在当前之前,索引前移一位
      onlinePlayIdx--;
    }
  }
  opl.songs.splice(idx, 1);
  LS.set('onlinePlaylists', onlinePlaylists);
  renderPlaylists();
  render();
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

// 从「最近播放」列表移除(不动音乐库本身)
function removeFromRecent(path) {
  recent = recent.filter((p) => p !== path);
  LS.set('recent', recent);
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
  try {
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
  } catch (err) {
    console.error('deleteSongs error', err);
  }
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
    const result = await window.api.sourceSearch(currentSource, s.title + (s.artist ? ' ' + s.artist : ''), 1, 'music');
    const song = result.data && result.data[0];
    if (!song) { alert('未找到匹配的在线歌曲信息'); return; }

    // 更新信息
    s.artist = song.artist || s.artist;
    s.album = song.album || s.album;
    if (song.artwork && !coverCache[path]) {
      coverCache[path] = song.artwork;
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
  // 右键行为:若右键的行未在已选中集合里,则把它单独选中(符合文件管理器直觉);
  // 若右键的是已选中的行(且有多选),则对全部选中项批量操作。
  let selRows = Array.from(document.querySelectorAll('.st-row.selected'));
  let selPaths = selRows.map((r) => r.dataset.path).filter(Boolean);
  if (!selPaths.includes(path)) {
    document.querySelectorAll('.st-row').forEach((r) => r.classList.remove('selected'));
    const thisRow = document.querySelector(`.st-row[data-path="${CSS.escape(path)}"]`);
    if (thisRow) thisRow.classList.add('selected');
    selPaths = [path];
  }
  const multi = selPaths.length > 1;

  items.push({ label: '▶ 播放', fn: () => playPath(path) });
  items.push({ label: liked ? '♥ 取消喜欢' : '♡ 添加到喜欢', fn: () => toggleFav(path) });
  items.push({ label: '＋ 加入歌单…', sub: playlists.length ? playlists.map((p) => ({
    label: p.name, fn: () => addToPlaylist(path, p.id)
  })) : [{ label: '(暂无歌单,先新建)', disabled: true }] });
  items.push({ label: '📋 复制歌曲名', fn: () => copyText(s.title) });
  if (inPl) items.push({ label: '✕ 从此歌单移除', fn: () => removeFromPlaylist(path, inPl) });
  if (view === 'favorites') items.push({ label: '✕ 从我喜欢移除', fn: () => toggleFav(path) });
  if (view === 'recent') items.push({ label: '✕ 从最近播放移除', fn: () => removeFromRecent(path) });
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

  // 子菜单 hover-intent:进入父项即打开,离开后延迟关闭,避免斜向移动时秒关导致"点不中";
  // 同时按可用空间把子菜单翻到左侧/上方,防止溢出屏幕。
  menu.querySelectorAll('.ctx-item.has-sub').forEach((parent) => {
    const sub = parent.querySelector('.ctx-sub');
    if (!sub) return;
    let timer = null;
    const open = () => {
      clearTimeout(timer);
      parent.classList.add('open');
      // 先默认右侧,放不下则翻到左侧
      sub.style.left = '100%'; sub.style.right = 'auto';
      sub.style.top = '-4px'; sub.style.bottom = 'auto';
      const r = sub.getBoundingClientRect();
      if (r.right > window.innerWidth - 8) { sub.style.left = 'auto'; sub.style.right = '100%'; }
      if (r.bottom > window.innerHeight - 8) { sub.style.top = 'auto'; sub.style.bottom = '-4px'; }
    };
    const scheduleClose = () => {
      clearTimeout(timer);
      timer = setTimeout(() => parent.classList.remove('open'), 350);
    };
    parent.addEventListener('mouseenter', open);
    parent.addEventListener('mouseleave', scheduleClose);
    sub.addEventListener('mouseenter', () => clearTimeout(timer));
    sub.addEventListener('mouseleave', scheduleClose);
  });
}

function closeContextMenu() {
  const m = $('ctx-menu');
  if (m) m.remove();
}
document.addEventListener('click', closeContextMenu);
document.addEventListener('scroll', closeContextMenu, true);

// ===== 频谱可视化 =====
let visLevels = null;   // 各柱当前高度(0~1),用于帧间平滑
let visStarted = false; // rAF 循环是否已启动(只启动一次)
const VIS_BARS = 16;       // 柱子数量
const VIS_CAP = 1.0;       // 柱子最高可到顶
const VIS_RISE = 0.5;      // 上升平滑系数(快)
const VIS_FALL = 0.18;     // 下落平滑系数(慢)
function drawVisualizer() {
  if (visStarted) return; // 防止重复启动叠加多个 rAF 循环
  visStarted = true;
  const canvas = $('visualizer');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;

  const barWidth = w / VIS_BARS;
  visLevels = new Array(VIS_BARS).fill(0);

  function draw() {
    requestAnimationFrame(draw);
    ctx.clearRect(0, 0, w, h);

    const playing = currentPath && !audio.paused;
    const hasReal = analyser && dataArray;
    if (hasReal) analyser.getByteFrequencyData(dataArray);
    const bins = hasReal ? dataArray.length : 0;
    const t = audio.currentTime || 0;

    for (let i = 0; i < VIS_BARS; i++) {
      let target;
      // 每根柱子各自的相位种子,保证跳动节奏互不相同、高低错落看着随机
      const seed = i * 1.7 + 0.5;
      if (playing) {
        // 随机起伏:多正弦叠加,每根柱子相位不同 → 全部都在跳,高度各异
        const wiggle = 0.4
          + 0.22 * Math.sin(t * 5.0 + seed)
          + 0.16 * Math.sin(t * 9.0 + seed * 2.3)
          + 0.12 * Math.sin(t * 14.0 + seed * 0.7);
        if (hasReal) {
          // 本地真实频谱:线性切分频段,每根柱子分到独立的一段频率区间取平均
          // (不再用对数映射,避免前几根全挤进同一个低频 bin 导致不跳)
          const lo = Math.floor((i / VIS_BARS) * bins);
          const hi = Math.max(lo + 1, Math.floor(((i + 1) / VIS_BARS) * bins));
          let sum = 0;
          for (let b = lo; b < hi && b < bins; b++) sum += dataArray[b];
          const real = Math.min(1, (sum / (hi - lo)) / 255 * 1.6);
          // 真实能量与随机起伏取较大值,没能量的柱子也跳,不会出现"死柱"
          target = Math.max(real, wiggle * 0.7);
        } else {
          // 在线音频跨域接不了 Web Audio,纯用随机起伏驱动
          target = wiggle;
        }
      } else {
        target = 0; // 暂停/未播放:落回底部
      }

      // 平滑:上升快、下落慢,柱子起伏更自然
      const prev = visLevels[i];
      visLevels[i] = target > prev
        ? prev + (target - prev) * VIS_RISE
        : prev + (target - prev) * VIS_FALL;
      // 所有柱子统一限高,谁都不顶到画布最顶
      const val = Math.min(visLevels[i], VIS_CAP);

      const barHeight = Math.max(val * h * 0.95, playing ? 2 : 1);
      const x = i * barWidth;
      const y = h - barHeight;
      ctx.fillStyle = playing ? `rgba(29, 185, 84, ${0.55 + val * 0.45})` : '#3a3a3a';
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
    // 固定项「我喜欢 / 最近播放」右键:清空列表
    const v = el.dataset.view;
    if (v === 'favorites' || v === 'recent') {
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showFixedListMenu(e.clientX, e.clientY, v);
      });
    }
  });
}

// ===== 固定项「我喜欢 / 最近播放」右键菜单 =====
function showFixedListMenu(x, y, which) {
  closeContextMenu();
  const isFav = which === 'favorites';
  const label = isFav ? '我喜欢' : '最近播放';
  const count = isFav ? favorites.length : recent.length;
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'ctx-menu';
  menu.innerHTML = `<div class="ctx-item danger" data-action="clear">🗑 清空${label}</div>`;
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
  menu.querySelector('[data-action="clear"]').addEventListener('click', () => {
    closeContextMenu();
    if (!count) { toast(label + '已经是空的'); return; }
    if (!confirm(`确定清空${label}列表吗?(共 ${count} 首)`)) return;
    if (isFav) { favorites = []; LS.set('favorites', favorites); }
    else { recent = []; LS.set('recent', recent); }
    renderPlaylists();
    render();
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
  coverEl.innerHTML = playerCoverHTML(path);
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
  maybeTranslateLyrics(path, data);
}

// 英文歌词翻译:若多数行含英文字母且基本无中文,则整体翻译,把译文塞到每行原文下方
// 译文会按歌曲缓存到本地(gt_trans_<key>),下次同一首歌直接读缓存,不再请求翻译接口
async function maybeTranslateLyrics(path, data) {
  try {
    const texts = data.map((l) => l.text);
    // 判断是不是英文歌词:含中文的行占比很低,且大部分行有英文字母
    const hasCJK = (s) => /[一-鿿]/.test(s);
    const hasLatin = (s) => /[a-zA-Z]/.test(s);
    const cjkLines = texts.filter(hasCJK).length;
    const latinLines = texts.filter(hasLatin).length;
    if (latinLines < 3 || cjkLines > texts.length * 0.3) return; // 不像英文歌词,跳过

    const cacheKey = 'trans_' + path;
    let trans = LS.get(cacheKey, null);            // 先读本地缓存
    if (!trans || trans.length !== texts.length) {
      trans = await window.api.translateLines(texts);
      if (path !== currentPath) return; // 切歌了
      if (!trans || trans.length !== texts.length) return;
      LS.set(cacheKey, trans);                      // 翻译成功后存本地
    }
    if (path !== currentPath) return; // 读缓存期间可能已切歌

    const box = $('lp-lyrics');
    data.forEach((l, i) => {
      const t = (trans[i] || '').trim();
      // 译文和原文不同、且原文确实是英文时才显示
      if (t && t !== l.text && hasLatin(l.text)) {
        const p = box.querySelector(`p[data-i="${i}"]`);
        if (p && !p.querySelector('.lp-trans')) {
          const span = document.createElement('span');
          span.className = 'lp-trans';
          span.textContent = t;
          p.appendChild(span);
        }
      }
    });
  } catch (e) {
    console.error('歌词翻译失败:', e);
  }
}

// 在线歌词搜索(QQ 音乐 API,无需 key)
async function searchOnlineLyrics(title, artist) {
  // 检查是否有可用的音源插件
  if (!currentSource) {
    console.warn('无可用音源插件，跳过在线歌词搜索');
    return null;
  }

  // 仅在有歌手时才用缓存:否则两首同名无歌手的歌会共用缓存键而串词
  const cacheKey = artist ? `lrc_${title}_${artist}` : null;
  if (cacheKey) {
    const cached = LS.get(cacheKey, null);
    if (cached) return cached;
  }

  try {
    // 通过当前音源搜索歌曲(歌手可为空)
    const query = (title + ' ' + (artist || '')).trim();
    const result = await window.api.sourceSearch(currentSource, query, 1, 'music');
    const song = result.data && result.data[0];
    if (!song || !song.id) return null;

    // 获取歌词
    const raw = await window.api.sourceLyric(currentSource, song);
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
    const result = await window.api.sourceSearch(currentSource, title + (artist ? ' ' + artist : ''), 1, 'music');
    const song = result.data && result.data[0];
    if (song && song.artwork) {
      coverCache[filePath] = song.artwork;
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
audio.addEventListener('play', () => { setPlayIcon(true); $('now-cover').classList.remove('paused'); pushMiniState(); });
audio.addEventListener('pause', () => { setPlayIcon(false); $('now-cover').classList.add('paused'); pushMiniState(); });
audio.addEventListener('ended', onEnded);
audio.addEventListener('loadedmetadata', () => {
  $('dur-time').textContent = fmt(audio.duration);
  const s = byPath(currentPath);
  if (s && (!s.duration || isNaN(s.duration))) { s.duration = audio.duration; saveLib(); }
  pushMiniState();
});

// 节流：timeupdate 每秒只推送一次状态给 mini 窗口
let lastMiniPush = 0;
audio.addEventListener('timeupdate', () => {
  if (!isSeeking && audio.duration) {
    const r = audio.currentTime / audio.duration;
    progressBar.apply(r);
    $('cur-time').textContent = fmt(audio.currentTime);
  }
  syncLyrics(audio.currentTime);

  // 节流：每秒最多推送一次
  const now = Date.now();
  if (now - lastMiniPush > 1000) {
    pushMiniState();
    lastMiniPush = now;
  }
});

// ===== 迷你播放器状态同步 =====
// 取当前"现在播放"状态推给小窗(从 DOM 读已渲染好的标题/歌手/封面,兼容本地与在线)
function pushMiniState() {
  const coverImg = $('now-cover').querySelector('img');
  const curLyric = (lrc && lrcIdx >= 0 && lrc[lrcIdx]) ? lrc[lrcIdx].text : '';
  window.api.miniSyncState({
    title: $('now-title').textContent,
    artist: $('now-artist').textContent,
    cover: coverImg ? coverImg.getAttribute('src') : '',
    playing: !audio.paused,
    currentTime: audio.currentTime || 0,
    duration: audio.duration || 0,
    lyric: curLyric
  });
}

// 监听小窗发来的命令
window.api.onMiniCommand((cmd, payload) => {
  switch (cmd) {
    case 'toggle': togglePlay(); break;
    case 'next': playNext(); break;
    case 'prev': playPrev(); break;
    case 'seek':
      if (audio.duration) audio.currentTime = payload * audio.duration;
      break;
    case 'ready': pushMiniState(); break; // 小窗就绪,立即推一次
  }
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

// 推荐视图「换一批」:重新随机生成推荐
$('refresh-recommend').addEventListener('click', () => {
  if (view !== 'recommend') return;
  loadRecommendations();
});

// 搜索
let onlineTimer = null;
$('search-input').addEventListener('input', () => {
  if (view === 'online') {
    clearTimeout(onlineTimer);
    onlineTimer = setTimeout(() => searchOnlineMusic($('search-input').value), 600);
  } else {
    if (view !== 'search') view = 'search';
    // 记录光标位置，render 后恢复焦点（搜索框是静态 DOM，render 不会重建它，但保险起见恢复焦点）
    const inp = $('search-input');
    const pos = inp.selectionStart;
    render();
    inp.focus();
    try { inp.setSelectionRange(pos, pos); } catch (e) {}
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
$('win-mini').addEventListener('click', () => window.api.miniOpen());
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
    // Ctrl+A 全选当前列表所有歌曲(在线搜索/推荐不支持,导入的歌单 opl: 支持)
    if (view === 'online' || view === 'recommend') return;
    e.preventDefault();
    document.querySelectorAll('.st-row').forEach((r) => r.classList.add('selected'));
  }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
    if (view === 'online' || view === 'recommend') return;
    // 在线歌单视图:删除选中的歌(从歌单移除)
    if (view.startsWith('opl:')) {
      const plId = view.slice(4);
      const idxs = Array.from(document.querySelectorAll('.st-row.selected'))
        .map((r) => +r.dataset.oplIdx).filter((n) => !isNaN(n));
      if (!idxs.length) return;
      e.preventDefault();
      if (!confirm(`确定从歌单删除选中的 ${idxs.length} 首吗?`)) return;
      deleteOnlineSongs(plId, idxs);
      return;
    }
    // 本地视图:从音乐库删除选中的歌
    const sel = Array.from(document.querySelectorAll('.st-row.selected'))
      .map((r) => r.dataset.path).filter(Boolean);
    if (!sel.length) return;
    e.preventDefault();
    if (!confirm(`确定从音乐库删除选中的 ${sel.length} 首歌吗?(不会删除磁盘文件)`)) return;
    deleteSongs(sel);
  }
});

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
    // 用是否已生成滑块来判断,避免容器里的 HTML 注释让 innerHTML 永远非空导致 initEQ 不执行
    if (!$('eq-0')) initEQ();
  });
}
$('eq-close').addEventListener('click', () => { $('eq-modal').hidden = true; });

// ===== 在线音乐搜索与试听 =====
async function searchOnlineMusic(keyword) {
  if (!keyword || !keyword.trim()) { onlineResults = []; render(); return; }
  if (!currentSource) {
    alert('请先加载音源插件（按 Ctrl+P 打开插件管理）');
    return;
  }
  onlineQuery = keyword;
  const body = $('song-body');
  body.innerHTML = '<div class="online-loading">正在搜索在线音乐…</div>';

  if (!currentSource) {
    body.innerHTML = '<div class="online-loading">请先在插件管理中启用至少一个音源</div>';
    return;
  }

  try {
    const result = await window.api.sourceSearch(currentSource, keyword, 1, 'music');
    onlineResults = result.data || [];
    render();
  } catch (e) {
    console.error('在线搜索失败:', e);
    onlineResults = [];
    body.innerHTML = '<div class="online-loading">搜索失败,请检查网络连接</div>';
  }
}

async function playOnline(songId) {
  // 优先用 id 匹配，如果是 fallback_N 格式则用索引匹配
  let song;
  if (songId.startsWith('fallback_')) {
    const index = parseInt(songId.replace('fallback_', ''), 10);
    song = onlineResults[index];
  } else {
    song = onlineResults.find((s) => s.id == songId);
  }
  if (!song) return;
  onlinePlaylistMode = false; // 普通在线搜索播放,非歌单连播
  try {
    const playUrl = await window.api.sourceUrl(currentSource, song, 'standard');
    if (!playUrl) { alert('该歌曲为付费/会员歌曲,无法试听'); return; }
    currentPath = String(songId);
    audio.src = playUrl;
    audio.play().catch((e) => console.error('播放失败', e));
    // 注意:不对在线流接入 Web Audio 图。在线音频是跨域资源,且 audio 未设
    // crossOrigin,经 createMediaElementSource 会被判为 tainted 而输出静音。
    // 因此在线试听跳过均衡器/频谱(本地播放不受影响)。
    $('now-title').textContent = song.title;
    $('now-artist').textContent = song.artist;
    const coverEl = $('now-cover');
    coverEl.innerHTML = song.artwork ? `<img src="${song.artwork}" alt="">` : '<img src="assets/logo.jpg" alt="">';
    coverEl.classList.add('rotating');
    $('like-btn').classList.remove('liked');
    $('like-btn').textContent = '♡';
    loadOnlineLyrics(song);
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

// 用当前音源按歌名+歌手搜一首并播放;界面信息仍用网易云的元数据(更贴合用户歌单)
async function resolveOnlineAndPlay(meta) {
  const titleEl = $('now-title'), artistEl = $('now-artist'), coverEl = $('now-cover');
  titleEl.textContent = meta.name;
  artistEl.textContent = '正在解析…';
  try {
    const realArtist = meta.artist && meta.artist !== 'Unknown Artist' ? meta.artist : '';
    const q = (meta.name + ' ' + realArtist).trim();
    const result = await window.api.sourceSearch(currentSource, q, 1, 'music');
    const song = result.data && result.data[0];
    if (!song || !song.id) { artistEl.textContent = meta.artist; alert('未找到可播放资源:' + meta.name); return; }
    const playUrl = await window.api.sourceUrl(currentSource, song, 'standard');
    if (!playUrl) { artistEl.textContent = meta.artist; alert('「' + meta.name + '」为付费/会员歌曲,无法试听'); return; }
    currentPath = String(song.id);
    audio.src = playUrl;
    audio.play().catch((e) => console.error('播放失败', e));
    titleEl.textContent = meta.name;
    artistEl.textContent = meta.artist;
    coverEl.innerHTML = meta.picUrl ? `<img src="${meta.picUrl}?param=120y120" alt="">`
      : (song.artwork ? `<img src="${song.artwork}" alt="">` : '<img src="assets/logo.jpg" alt="">');
    coverEl.classList.add('rotating');
    $('like-btn').classList.remove('liked');
    $('like-btn').textContent = '♡';
    loadOnlineLyrics(song);
    render();
  } catch (e) {
    console.error('在线歌单播放失败:', e);
    artistEl.textContent = meta.artist;
    alert('播放失败,请重试');
  }
}

// 在线歌词获取(传入 musicItem 对象)
async function loadOnlineLyrics(song) {
  lrc = null; lrcIdx = -1;
  const songId = song.id;
  const box = $('lp-lyrics');
  box.innerHTML = '<p class="lp-placeholder">正在加载歌词…</p>';
  try {
    const raw = await window.api.sourceLyric(currentSource, song);
    if (path_changed(songId)) return;
    if (!raw) { box.innerHTML = '<p class="lp-placeholder">暂无歌词</p>'; return; }
    lrc = parseLrc(raw);
    if (!lrc.length) { box.innerHTML = '<p class="lp-placeholder">暂无歌词</p>'; return; }
    box.innerHTML = lrc.map((l, i) => `<p data-i="${i}">${esc(l.text)}</p>`).join('');
    maybeTranslateLyrics(String(songId), lrc);
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
    .slice(0, 5)
    .map(([artist]) => artist);

  if (!topArtists.length) {
    body.innerHTML = '<div class="online-loading">暂无推荐,先听几首歌吧~</div>';
    return;
  }

  try {
    // 从最常听的几个艺术家里随机挑一个搜索,「换一批」时结果会变化
    const keyword = topArtists[Math.floor(Math.random() * topArtists.length)];
    const result = await window.api.sourceSearch(currentSource, keyword, 1, 'music');
    let results = result.data || [];
    // 打乱顺序,让每次"换一批"更有新鲜感
    results = results.sort(() => Math.random() - 0.5);
    onlineResults = results;
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
async function init() {
  applyTheme();
  audio.volume = volume;
  volBar.apply(volume);
  applyModeUI();
  renderPlaylists();
  render();
  repairGarbledTitles(); // 自动修复旧的乱码标题
  drawVisualizer();      // 启动频谱循环,纯在线播放时音柱也能跳
  await loadPlugins();   // 等待插件列表加载完成，确保 currentSource 正确初始化
}
init();

// ===== 插件管理 =====

// 加载插件列表
async function loadPlugins() {
  plugins = await window.api.pluginList();

  // 如果当前选中的音源不存在或未启用，自动选择第一个启用的插件
  const current = plugins.find(p => p.id === currentSource && p.enabled);
  if (!current) {
    const enabled = plugins.find(p => p.enabled);
    if (enabled) {
      currentSource = enabled.id;
      LS.set('currentSource', currentSource);
    } else {
      // 所有插件都被禁用，清空 currentSource 并提示用户
      currentSource = null;
      LS.set('currentSource', '');
      console.warn('所有插件都已禁用，请至少启用一个音源插件');
    }
  }
}

// 渲染插件列表
function renderPluginList() {
  const list = $('plugin-list');
  if (!plugins.length) {
    list.innerHTML = '<p class="empty-hint">暂无插件，点击上方按钮加载</p>';
    return;
  }

  list.innerHTML = plugins.map(p => `
    <div class="plugin-item ${p.enabled ? '' : 'disabled'}">
      <div class="plugin-info">
        <span class="plugin-name">${esc(p.platform)}</span>
        <span class="plugin-version">v${esc(p.version)}</span>
      </div>
      <div class="plugin-controls">
        <label class="switch">
          <input type="checkbox" ${p.enabled ? 'checked' : ''}
                 data-plugin-id="${p.id}">
          <span class="slider"></span>
        </label>
        <button data-plugin-id="${p.id}" data-action="remove">🗑</button>
      </div>
    </div>
  `).join('');

  // 绑定事件
  list.querySelectorAll('.switch input').forEach(input => {
    input.addEventListener('change', () => togglePlugin(input.dataset.pluginId, input.checked));
  });

  list.querySelectorAll('button[data-action="remove"]').forEach(btn => {
    btn.addEventListener('click', () => removePlugin(btn.dataset.pluginId));
  });
}

// 打开插件管理弹窗
function openPluginModal() {
  $('plugin-modal').hidden = false;
  renderPluginList();
}

// 关闭插件管理弹窗
$('plugin-close').addEventListener('click', () => {
  $('plugin-modal').hidden = true;
});

// ===== 定时关闭功能 =====
let shutdownTimer = null;
let shutdownTime = null;
let shutdownInterval = null;

function updateTimerDisplay() {
  if (!shutdownTime) return;
  const now = Date.now();
  const remaining = Math.max(0, shutdownTime - now);
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  $('timer-remaining').textContent = `${minutes}分${seconds}秒`;

  if (remaining <= 0) {
    clearInterval(shutdownInterval);
    window.api.quitApp();
  }
}

function startShutdownTimer(minutes) {
  // 取消现有定时器
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    clearInterval(shutdownInterval);
  }

  shutdownTime = Date.now() + minutes * 60000;

  // 显示状态
  $('timer-status').hidden = false;
  updateTimerDisplay();

  // 每秒更新显示
  shutdownInterval = setInterval(updateTimerDisplay, 1000);

  // 设置定时器
  shutdownTimer = setTimeout(() => {
    window.api.quitApp();
  }, minutes * 60000);

  // 更新按钮提示
  $('timer-btn').title = `定时关闭 (${minutes}分钟后)`;
  $('timer-btn').style.color = 'var(--green)';
}

function cancelShutdownTimer() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    clearInterval(shutdownInterval);
    shutdownTimer = null;
    shutdownTime = null;
  }
  $('timer-status').hidden = true;
  $('timer-btn').title = '定时关闭';
  $('timer-btn').style.color = '';
}

// 打开定时关闭弹窗
$('timer-btn').addEventListener('click', () => {
  $('timer-modal').hidden = false;
});

// 关闭定时关闭弹窗
$('timer-close').addEventListener('click', () => {
  $('timer-modal').hidden = true;
});

// 预设时间按钮
document.querySelectorAll('.timer-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const minutes = parseInt(btn.dataset.minutes);
    startShutdownTimer(minutes);
    $('timer-modal').hidden = true;
  });
});

// 自定义时间
$('timer-custom-set').addEventListener('click', () => {
  const minutes = parseInt($('timer-custom-input').value);
  if (minutes > 0 && minutes <= 480) {
    startShutdownTimer(minutes);
    $('timer-modal').hidden = true;
    $('timer-custom-input').value = '';
  } else {
    alert('请输入1-480之间的分钟数');
  }
});

// 取消定时
$('timer-cancel').addEventListener('click', () => {
  cancelShutdownTimer();
});

// 从文件加载插件
$('plugin-load-file').addEventListener('click', async () => {
  const result = await window.api.pluginLoadFile();
  if (result && result.ok) {
    toast(`插件「${result.platform}」加载成功`);
    await loadPlugins();
    renderPluginList();
  } else if (result) {
    alert(`加载失败: ${result.error}`);
  }
});

// 从 URL 加载插件
$('plugin-load-url').addEventListener('click', async () => {
  const url = prompt('请输入插件 URL:\n\n例如: https://example.com/plugin.js');
  if (!url) return;

  toast('正在下载插件...');
  const result = await window.api.pluginLoadUrl(url);
  if (result.ok) {
    toast(`插件「${result.platform}」加载成功`);
    await loadPlugins();
    renderPluginList();
  } else {
    alert(`加载失败: ${result.error}`);
  }
});

// 切换插件启用状态
async function togglePlugin(id, enabled) {
  await window.api.pluginToggle(id, enabled);
  await loadPlugins();
  renderPluginList();
}

// 删除插件
async function removePlugin(id) {
  if (!confirm('确定删除该插件?')) return;
  await window.api.pluginRemove(id);
  await loadPlugins();
  renderPluginList();
}

// 侧边栏"插件"导航项打开插件管理弹窗
const navPluginBtn = $('nav-plugin');
if (navPluginBtn) navPluginBtn.addEventListener('click', openPluginModal);

// 快捷键 Ctrl+P 也能打开插件管理
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
    e.preventDefault();
    openPluginModal();
  }
});

// 点击弹窗遮罩空白处关闭
$('plugin-modal').addEventListener('click', (e) => {
  if (e.target.id === 'plugin-modal') $('plugin-modal').hidden = true;
});

