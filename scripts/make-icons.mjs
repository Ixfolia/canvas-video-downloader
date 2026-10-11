// Generates the placeholder toolbar icons (icons/icon{16,32,48,128}.png).
// Dependency-free: draws with 4x supersampling and writes PNGs with node:zlib.
// Usage: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BG = [37, 99, 235]; // blue
const FG = [255, 255, 255];

// Shape tests in a 0..1 coordinate space.
function insideRoundedRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function insideTriangle(x, y) {
  // Play triangle pointing right.
  const [ax, ay, bx, by, cx, cy] = [0.36, 0.22, 0.36, 0.62, 0.7, 0.42];
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by), d2 = s(x, y, bx, by, cx, cy), d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
function insideBar(x, y) {
  // "Save" bar under the triangle.
  return x >= 0.24 && x <= 0.76 && y >= 0.72 && y <= 0.8;
}

function render(size) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (i + (sx + 0.5) / ss) / size;
          const y = (j + (sy + 0.5) / ss) / size;
          if (!insideRoundedRect(x, y, 0.22)) continue;
          if (insideTriangle(x, y) || insideBar(x, y)) fg++;
          else bg++;
        }
      }
      const n = ss * ss, a = (bg + fg) / n, o = (j * size + i) * 4;
      for (let c = 0; c < 3; c++) px[o + c] = bg + fg ? Math.round((BG[c] * bg + FG[c] * fg) / (bg + fg)) : 0;
      px[o + 3] = Math.round(a * 255);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const file = join(root, 'icons', `icon${size}.png`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png(size, render(size)));
  console.log('wrote', file);
}
