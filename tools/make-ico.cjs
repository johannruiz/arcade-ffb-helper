// node tools/make-ico.cjs  ->  assets/icon.ico
// The app icon (assets/icon.svg: three stripes on a navy rounded square), drawn at each
// Windows icon size with 4x4 supersampling, as 32-bit BGRA bitmaps (no PNG encoder needed).
const fs = require('fs');
const path = require('path');

const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const STRIPES = [
  [[12.5, 78], [27.5, 78], [51.5, 22], [36.5, 22], [0xe8, 0x35, 0x2b]],
  [[30.5, 78], [45.5, 78], [69.5, 22], [54.5, 22], [0x1e, 0x7b, 0xff]],
  [[48.5, 78], [63.5, 78], [87.5, 22], [72.5, 22], [0xff, 0xb0, 0x00]],
];
const BG = [0x0d, 0x12, 0x20];

// Colour (or null) of the 100x100 design at (u, w).
function sample(u, w) {
  const cx = Math.min(Math.max(u, 22), 78), cy = Math.min(Math.max(w, 22), 78);
  if ((u - cx) ** 2 + (w - cy) ** 2 > 22 * 22) return null;
  if (w >= 22 && w <= 78) {
    const t = (78 - w) / 56;
    for (const [a, b, c, d, col] of STRIPES) {
      const left = a[0] + (d[0] - a[0]) * t, right = b[0] + (c[0] - b[0]) * t;
      if (u >= left && u <= right) return col;
    }
  }
  return BG;
}

function bitmap(n) {
  const px = Buffer.alloc(n * n * 4);
  const ss = 4;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const c = sample((x + (sx + 0.5) / ss) * 100 / n, (y + (sy + 0.5) / ss) * 100 / n);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const row = n - 1 - y;                     // bottom-up
    const o = (row * n + x) * 4;
    px[o] = a ? Math.round(b / a) : 0; px[o + 1] = a ? Math.round(g / a) : 0; px[o + 2] = a ? Math.round(r / a) : 0;
    px[o + 3] = Math.round(a * 255 / (ss * ss));
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(n, 4);
  header.writeInt32LE(n * 2, 8);               // colour + mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(px.length, 20);
  const maskRow = Math.ceil(n / 32) * 4;       // 1-bit AND mask, all 0 (alpha is used)
  return Buffer.concat([header, px, Buffer.alloc(maskRow * n)]);
}

const images = SIZES.map(bitmap);
const dir = Buffer.alloc(6 + 16 * images.length);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(images.length, 4);
let offset = dir.length;
images.forEach((img, i) => {
  const n = SIZES[i], e = 6 + 16 * i;
  dir.writeUInt8(n >= 256 ? 0 : n, e);
  dir.writeUInt8(n >= 256 ? 0 : n, e + 1);
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(img.length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += img.length;
});
const out = path.join(__dirname, '..', 'assets', 'icon.ico');
fs.writeFileSync(out, Buffer.concat([dir, ...images]));
console.log('wrote', out, offset, 'bytes');
