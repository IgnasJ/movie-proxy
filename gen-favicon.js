/* One-off generator for the raster favicons. Draws the same mark as
   public/favicon.svg (dark rounded square + gold play triangle) with 4x
   supersampling for clean anti-aliased edges, then writes PNGs by hand
   (no image deps). Run: node gen-favicon.js  */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x14, 0x15, 0x1a];   // #14151a app background
const GOLD = [0xe5, 0xa0, 0x0d]; // #e5a00d accent
const SS = 4;                     // supersampling factor

// rounded-rect signed distance (<=0 means inside), all in normalized 0..1
function insideRect(nx, ny, r) {
  const qx = Math.abs(nx - 0.5) - (0.5 - r);
  const qy = Math.abs(ny - 0.5) - (0.5 - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r <= 0;
}

// play triangle, matching the SVG (M26 18.5 -> 26 45.5 -> 49 32, /64)
const TA = [26 / 64, 18.5 / 64], TB = [26 / 64, 45.5 / 64], TC = [49 / 64, 32 / 64];
function insideTri(px, py) {
  const d = (a, b, c) => (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
  const d1 = d(TA, TB, [0, 0]), d2 = d(TB, TC, [0, 0]), d3 = d(TC, TA, [0, 0]);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}

function render(size, { transparent }) {
  const r = transparent ? 0.22 : 0; // iOS masks its own corners, so square there
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = (x + (sx + 0.5) / SS) / size;
          const ny = (y + (sy + 0.5) / SS) / size;
          let col = null;
          if (insideTri(nx, ny)) col = GOLD;
          else if (insideRect(nx, ny, r)) col = BG;
          if (col) { rr += col[0]; gg += col[1]; bb += col[2]; aa += 255; }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const a = aa / n;
      // un-premultiply so edge pixels keep true colour
      buf[i] = a ? Math.round(rr / aa * 255) : 0;
      buf[i + 1] = a ? Math.round(gg / aa * 255) : 0;
      buf[i + 2] = a ? Math.round(bb / aa * 255) : 0;
      buf[i + 3] = Math.round(a);
    }
  }
  return buf;
}

// ---- minimal PNG writer (RGBA, 8-bit) ----
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
}

function toPng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  // raw scanlines, each prefixed with filter byte 0
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, 'public');
fs.writeFileSync(path.join(out, 'favicon.png'), toPng(32, render(32, { transparent: true })));
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), toPng(180, render(180, { transparent: false })));
console.log('wrote public/favicon.png (32) and public/apple-touch-icon.png (180)');
