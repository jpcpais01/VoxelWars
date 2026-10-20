// Generates the PWA icons (a grassy voxel cube on a dark field) without any image dependencies.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const TOP = [0x8fd16a, 0x7cc35a, 0x9bdb76];
const LEFT = [0x8a6242, 0x7b553a];
const RIGHT = [0x5f4330, 0x553b2a];

/** colour of an isometric 3x3x3 voxel cube at normalised coords (u right, v down, -1..1), or null */
function cube(u, v, a) {
  // projection: u = cx*a*(x - z), v = 0.5*a*(x + z) - a*y, with x, y, z in 0..1
  const cx = 0.8660254;
  const du = u / (cx * a);
  const cell = (p, q) => {
    const i = Math.floor(p * 3), j = Math.floor(q * 3);
    const edge = Math.min(p * 3 - i, q * 3 - j, 1 - (p * 3 - i), 1 - (q * 3 - j));
    return { i: Math.min(2, i), j: Math.min(2, j), edge };
  };
  // top face (y = 1)
  const sum = (v + a) / (0.5 * a);
  const tx = (sum + du) / 2, tz = (sum - du) / 2;
  if (tx >= 0 && tx <= 1 && tz >= 0 && tz <= 1) {
    const { i, j, edge } = cell(tx, tz);
    return shade(hex(TOP[(i * 7 + j * 5) % 3]), edge < 0.07 ? 0.9 : 1.04);
  }
  // left face (z = 1)
  {
    const x = du + 1;
    const y = (0.5 * a * (x + 1) - v) / a;
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
      const { i, j, edge } = cell(x, y);
      const c = j === 2 ? hex(0x6fae4a) : hex(LEFT[(i + j) % 2]);
      return shade(c, edge < 0.07 ? 0.84 : 1);
    }
  }
  // right face (x = 1)
  {
    const z = 1 - du;
    const y = (0.5 * a * (1 + z) - v) / a;
    if (z >= 0 && z <= 1 && y >= 0 && y <= 1) {
      const { i, j, edge } = cell(z, y);
      const c = j === 2 ? hex(0x4f8a36) : hex(RIGHT[(i + j) % 2]);
      return shade(c, edge < 0.07 ? 0.84 : 1);
    }
  }
  return null;
}
const shade = (c, k) => c.map((x) => Math.max(0, Math.min(255, Math.round(x * k))));

function icon(size, { maskable = false, transparent = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 3;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, al = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((px + (sx + 0.5) / SS) / size) * 2 - 1;
          const v = ((py + (sy + 0.5) / SS) / size) * 2 - 1;
          const scale = maskable ? 0.62 : 0.86;
          let c = cube(u, v, scale);
          let a = 1;
          if (!c) {
            // background: radial dusk gradient, rounded square unless maskable
            const d = Math.hypot(u, v + 0.3);
            const k = Math.max(0, 1 - d * 0.6);
            c = [14 + 30 * k, 26 + 46 * k, 20 + 30 * k];
            const rr = 0.36;
            const qx = Math.max(Math.abs(u) - (1 - rr), 0), qy = Math.max(Math.abs(v) - (1 - rr), 0);
            if (!maskable && Math.hypot(qx, qy) > rr) a = 0;
            if (transparent) a = 0;
          }
          r += c[0] * a; g += c[1] * a; b += c[2] * a; al += a;
        }
      }
      const n = SS * SS, o = (py * size + px) * 4;
      buf[o] = al ? r / al : 0;
      buf[o + 1] = al ? g / al : 0;
      buf[o + 2] = al ? b / al : 0;
      buf[o + 3] = (al / n) * 255;
    }
  }
  return png(size, size, buf);
}

writeFileSync('public/pwa-192.png', icon(192));
writeFileSync('public/pwa-512.png', icon(512));
writeFileSync('public/pwa-maskable-512.png', icon(512, { maskable: true }));
writeFileSync('public/apple-touch-icon.png', icon(180, { maskable: true }));
console.log('icons written');
