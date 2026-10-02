// Generates the PWA icons (PNG) with no native dependencies: a tiny rasteriser
// with 4x4 supersampling and a minimal PNG encoder built on node:zlib.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../web/public');
const BG = [13, 17, 23];
const FG = [47, 129, 247];
const FG2 = [230, 237, 243];

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Signed-distance helpers in unit coordinates (0..1)
const segDist = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
};
const roundRect = (px, py, x0, y0, x1, y1, r) => {
  const cx = Math.max(x0 + r, Math.min(x1 - r, px));
  const cy = Math.max(y0 + r, Math.min(y1 - r, py));
  return Math.hypot(px - cx, py - cy) <= r;
};

function render(size, { maskable }) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 4;
  // Maskable icons need the glyph inside the 80% safe zone and a full-bleed background.
  const pad = maskable ? 0.2 : 0.06;
  const scale = 1 - 2 * pad;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          const inBg = maskable || roundRect(u, v, 0.04, 0.04, 0.96, 0.96, 0.2);
          if (!inBg) continue;
          // glyph space
          const gx = (u - pad) / scale;
          const gy = (v - pad) / scale;
          const w = 0.075;
          const chevron = Math.min(segDist(gx, gy, 0.22, 0.3, 0.46, 0.5), segDist(gx, gy, 0.46, 0.5, 0.22, 0.7)) < w;
          const underscore = segDist(gx, gy, 0.52, 0.72, 0.78, 0.72) < w;
          const c = chevron ? FG : underscore ? FG2 : BG;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      const cov = a / 255;
      buf[i] = cov ? Math.round(r / cov) : 0;
      buf[i + 1] = cov ? Math.round(g / cov) : 0;
      buf[i + 2] = cov ? Math.round(b / cov) : 0;
      buf[i + 3] = Math.round(a / n);
    }
  }
  return png(size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon-192.png'), render(192, { maskable: false }));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), render(512, { maskable: false }));
fs.writeFileSync(path.join(OUT, 'icon-maskable-512.png'), render(512, { maskable: true }));
fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), render(180, { maskable: true }));
console.log('icons written to', OUT);
