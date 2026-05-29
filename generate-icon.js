// 一次性生成应用图标:声破天绿圆底 + 白色双八分音符(♫)。纯 Node zlib,无需第三方库。
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 256;
const cx = 128, cy = 128, R = 124;       // 绿色圆
const GREEN = [29, 185, 84];
const WHITE = [255, 255, 255];

// 音符几何
const headR = 22;
const lHead = [96, 188], rHead = [168, 188];   // 两个符头中心
const stemW = 9;
const lStemX = 116, rStemX = 188;              // 符干左缘
const stemTop = 70, stemBot = 188;
const beamTop = 70, beamBot = 92;              // 横梁

function inCircle(x, y, c, r) {
  const dx = x - c[0], dy = y - c[1];
  return dx * dx + dy * dy <= r * r;
}
function inRect(x, y, x0, x1, y0, y1) {
  return x >= x0 && x < x1 && y >= y0 && y < y1;
}
function isNote(x, y) {
  if (inCircle(x, y, lHead, headR) || inCircle(x, y, rHead, headR)) return true;
  if (inRect(x, y, lStemX, lStemX + stemW, stemTop, stemBot)) return true;
  if (inRect(x, y, rStemX, rStemX + stemW, stemTop, stemBot)) return true;
  if (inRect(x, y, lStemX, rStemX + stemW, beamTop, beamBot)) return true;
  return false;
}

// 构造 RGBA 原始像素 + 每行 filter 字节(0)
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
let p = 0;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // filter type none
  for (let x = 0; x < SIZE; x++) {
    let col = null;
    if (inCircle(x, y, [cx, cy], R)) {
      col = isNote(x, y) ? WHITE : GREEN;
    } else if (isNote(x, y)) {
      col = WHITE;
    }
    if (col) { raw[p++] = col[0]; raw[p++] = col[1]; raw[p++] = col[2]; raw[p++] = 255; }
    else { raw[p++] = 0; raw[p++] = 0; raw[p++] = 0; raw[p++] = 0; }
  }
}

// CRC32
const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8bit RGBA
const idat = zlib.deflateSync(raw);
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);

const out = path.join(__dirname, 'assets', 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
