/* ===== 迷你播放器 · 渲染逻辑 ===== */
const $ = (id) => document.getElementById(id);

function fmt(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

let duration = 0;
let dragging = false;

// 接收主窗推送的播放状态
window.api.onMiniSync((state) => {
  if (!state) return;
  $('m-title').textContent = state.title || '未在播放';
  $('m-artist').textContent = state.artist || '—';

  const cover = $('m-cover');
  if (state.cover) {
    cover.innerHTML = `<img src="${state.cover}" alt="">`;
  } else {
    cover.innerHTML = '<span class="ph">🎵</span>';
  }

  $('m-lyric').textContent = state.lyric || '';

  // 播放/暂停图标
  $('m-play-icon').innerHTML = state.playing
    ? '<path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/>'
    : '<path fill="currentColor" d="M8 5v14l11-7z"/>';

  // 进度
  duration = state.duration || 0;
  if (!dragging) {
    const ratio = duration ? (state.currentTime || 0) / duration : 0;
    $('m-fill').style.width = (ratio * 100) + '%';
    $('m-cur').textContent = fmt(state.currentTime || 0);
    $('m-dur').textContent = fmt(duration);
  }
});

// 控制按钮 → 发命令给主窗
$('m-play').addEventListener('click', () => window.api.miniCommand('toggle'));
$('m-prev').addEventListener('click', () => window.api.miniCommand('prev'));
$('m-next').addEventListener('click', () => window.api.miniCommand('next'));

// 还原主窗口 / 关闭迷你播放器
$('m-restore').addEventListener('click', () => window.api.miniClose());
$('m-close').addEventListener('click', () => window.api.miniClose());

// 进度条拖动/点击 seek
const progress = $('m-progress');
function seekAt(clientX) {
  const rect = progress.getBoundingClientRect();
  let ratio = (clientX - rect.left) / rect.width;
  ratio = Math.max(0, Math.min(1, ratio));
  $('m-fill').style.width = (ratio * 100) + '%';
  $('m-cur').textContent = fmt(ratio * duration);
  return ratio;
}

progress.addEventListener('mousedown', (e) => {
  dragging = true;
  seekAt(e.clientX);
});
document.addEventListener('mousemove', (e) => {
  if (dragging) seekAt(e.clientX);
});
document.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  const ratio = seekAt(e.clientX);
  window.api.miniCommand('seek', ratio);
});

// 通知主窗：mini 已就绪，请推一次当前状态
window.api.miniCommand('ready');
