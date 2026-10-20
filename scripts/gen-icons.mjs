// Generates every VoxelWars app icon from chunky extruded voxel pixel art.
// Several designs live here; ICON=<name> picks one (default below):
//   forest  a soldier silhouette with a rifle among misty pine trunks and sunbeams
//   meadow  a combat helmet with leaf sprigs resting in a poppy meadow below the pines
//   marker  a rifle planted in the ground with a helmet on it, pines against a dusk sun
//   grenade a pineapple frag grenade on an orange sunburst
//   tank    a little voxel tank under a blue sky
//   boom    a spiky voxel explosion throwing blocks
//   helmet  a voxel soldier in a combat helmet with goggles, in front of a setting voxel sun
//   vw      a bold "VW" monogram in the team colours, one corner shot to bits
//   rifle   a carbine silhouette across a striped voxel sunset over the pines
// Emitted as SVG, rasterised with Chromium (Playwright).
//   npm run icons            (needs `playwright` resolvable, e.g. NODE_PATH to a global install)
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const DESIGN = process.env.ICON || 'forest';
const V = 512;

const hexToRgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const rgb = ([r, g, b]) => `rgb(${r | 0},${g | 0},${b | 0})`;
const mul = (c, k) => c.map((x) => Math.max(0, Math.min(255, x * k)));
const hash = (x, y) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const f2 = (v) => v.toFixed(2);
const quad = (pts, fill) => `<path d="M${pts.map((p) => p.map(f2).join(' ')).join('L')}Z" fill="${fill}"/>`;

/**
 * Pixel art extruded into voxels, seen slightly from below-left so the top and right faces show.
 * rows: strings, one char per voxel ('.' = empty); pal: char -> 0xRRGGBB
 * Returns svg centred on (cx, cy) with total width `w`.
 */
function voxels(rows, pal, { cx, cy, w, depth = 0.42, jitter = 0.05, outline = true }) {
  const cols = Math.max(...rows.map((r) => r.length));
  const u = w / (cols + depth);
  const dx = depth * u, dy = -depth * u;
  const x0 = cx - (cols * u + dx) / 2;
  const y0 = cy - (rows.length * u - dy) / 2 - dy;
  const at = (x, y) => (rows[y] && rows[y][x] && rows[y][x] !== '.' ? rows[y][x] : null);
  const sides = [], fronts = [], shadow = [];
  const cells = [];
  for (let y = 0; y < rows.length; y++) for (let x = cols - 1; x >= 0; x--) if (at(x, y)) cells.push([x, y]);
  for (const [x, y] of cells) {
    const c = mul(hexToRgb(pal[at(x, y)]), 1 - hash(x, y) * jitter);
    const L = x0 + x * u, T = y0 + y * u, R = L + u, B = T + u;
    if (!at(x, y - 1)) sides.push(quad([[L, T], [R, T], [R + dx, T + dy], [L + dx, T + dy]], rgb(mul(c, 1.22))));
    if (!at(x + 1, y)) sides.push(quad([[R, T], [R + dx, T + dy], [R + dx, B + dy], [R, B]], rgb(mul(c, 0.62))));
    fronts.push(`<rect x="${f2(L)}" y="${f2(T)}" width="${f2(u + 0.6)}" height="${f2(u + 0.6)}" fill="${rgb(c)}"/>`);
    // bevel: light top-left lip, dark bottom-right lip on each voxel
    const b = u * 0.12;
    fronts.push(quad([[L, T], [R, T], [R - b, T + b], [L + b, T + b]], 'rgba(255,255,255,.22)'));
    fronts.push(quad([[L, T], [L + b, T + b], [L + b, B - b], [L, B]], 'rgba(255,255,255,.1)'));
    fronts.push(quad([[R, B], [L, B], [L + b, B - b], [R - b, B - b]], 'rgba(0,0,0,.18)'));
    shadow.push(`<rect x="${f2(L)}" y="${f2(T)}" width="${f2(u + 0.6)}" height="${f2(u + 0.6)}"/>`);
  }
  const out = outline
    ? `<g fill="#0a0d14" opacity=".55" transform="translate(${f2(u * 0.18)} ${f2(u * 0.5)})" filter="url(#drop)">${shadow.join('')}</g>`
    : '';
  return { svg: out + sides.join('') + fronts.join(''), u, x0, y0 };
}

/** a stepped (pixel) disc made of horizontal bars */
function pixelSun(cx, cy, r, step, fill, bands = 0) {
  const out = [];
  for (let y = -r; y < r; y += step) {
    const yy = y + step / 2;
    const half = Math.floor(Math.sqrt(Math.max(0, r * r - yy * yy)) / step) * step;
    if (half <= 0) continue;
    // retro sunset cut-outs in the lower half
    if (bands && y > 0 && Math.floor(y / step) % 3 === 2) continue;
    out.push(`<rect x="${cx - half}" y="${cy + y}" width="${half * 2}" height="${step + 0.5}" fill="${fill}"/>`);
  }
  return out.join('');
}

/** row of pixel pines along the bottom */
function pines(base, step, color, seed) {
  const out = [];
  let x = -step;
  let i = 0;
  while (x < V + step) {
    const h = 4 + Math.floor(hash(i, seed) * 5);
    for (let k = 0; k < h; k++) {
      const half = Math.max(0, Math.floor((h - k) / 2));
      out.push(`<rect x="${x - half * step}" y="${base - (k + 1) * step}" width="${(half * 2 + 1) * step}" height="${step + 0.5}" fill="${color}"/>`);
    }
    x += step * (3 + Math.floor(hash(seed, i) * 3));
    i++;
  }
  out.push(`<rect x="0" y="${base}" width="${V}" height="${V - base}" fill="${color}"/>`);
  return out.join('');
}

const COMMON_DEFS = `
<filter id="drop" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter>
<radialGradient id="vignette" cx="50%" cy="48%" r="75%"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".4"/></radialGradient>
<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>`;

/** build pixel rows from a function (x, y) -> char */
const grid = (w, h, fn) => Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => fn(x, y) || '.').join(''));

/** pixel grass strip with tufts and a few flowers along y = base */
function meadow(base, step, { grass = '#5f9a3a', dark = '#3f6e2a', flowers = 0, seed = 3 } = {}) {
  let out = `<rect x="0" y="${base}" width="${V}" height="${V - base}" fill="${grass}"/>`;
  for (let x = 0, i = 0; x < V; x += step, i++) {
    const h = hash(i, seed);
    if (h > 0.55) out += `<rect x="${x}" y="${base - step}" width="${step}" height="${step + 0.5}" fill="${grass}"/>`;
    if (h > 0.85) out += `<rect x="${x}" y="${base - step * 2}" width="${step}" height="${step + 0.5}" fill="${grass}"/>`;
    for (let r = 1; r < 6; r++) if (hash(i, r + seed) > 0.8) out += `<rect x="${x}" y="${base + r * step * 1.6}" width="${step}" height="${step * 0.6}" fill="${dark}"/>`;
  }
  for (let k = 0; k < flowers; k++) {
    const x = Math.floor(hash(k, seed + 9) * (V / step)) * step, y = base + Math.floor(hash(seed, k + 4) * 6) * step;
    out += `<rect x="${x}" y="${y - step}" width="${step}" height="${step}" fill="${hash(k, 2) > 0.3 ? '#e8402a' : '#ffe6a0'}"/>`;
  }
  return out;
}
/** soft god rays falling from the top-left */
const rays = (n, op) =>
  Array.from({ length: n }, (_, i) => {
    const x = -80 + i * (V / n) * 1.3;
    return `<path d="M${x} -10L${x + 46} -10L${x + 46 + 300} ${V + 10}L${x + 300} ${V + 10}Z" fill="#fff6d0" opacity="${op}"/>`;
  }).join('');
/** helmet in side view, brim at the bottom, with leaf sprigs in its net */
function helmetRows(W, leaves) {
  if (W <= 10)
    return ['...HHHH...', '.HHGGGGd..', 'HGGGGGGGd.', 'GGGGGGGGdd', 'gggggggggg'];
  const rows = [
    '..................',
    '......HHHHHH......',
    '....HHGGGGGGHd....',
    '...HGGGGGGGGGGd...',
    '..HGGGGGGGGGGGGd..',
    '..GGGGGGGGGGGGGd..',
    '.NNNNNNNNNNNNNNNd.',
    '.GGGGGGGGGGGGGGGd.',
    'ggggggggggggggggggg',
    '....b..............',
    '.....b.............',
  ];
  if (!leaves) return rows.slice(1).map((r) => r.replace(/N/g, 'G'));
  // leaf sprigs tucked into the helmet band and net
  const sprig = [[5, 0], [5, 1], [6, 0], [11, 0], [12, 1], [12, 0], [3, 2], [2, 3], [14, 2], [15, 3], [1, 5], [16, 5]];
  const g = rows.map((r) => r.split(''));
  for (const [x, y] of sprig) if (g[y][x] === '.') g[y][x] = 'L';
  return g.map((r) => r.join(''));
}
const HELMET_PAL = { G: 0x667a3a, H: 0x8ea055, d: 0x55672f, N: 0x3d4721, g: 0x3e4a22, b: 0x5a4632, L: 0x7cc35a, l: 0x7cc35a };

// ---------- designs ----------
const DESIGNS = {
  meadow: {
    defs: `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6d79a"/><stop offset=".55" stop-color="#c9d6a4"/><stop offset="1" stop-color="#8fb27a"/></linearGradient>`,
    bg: (small) => {
      const st = small ? 24 : 12;
      return `<rect width="${V}" height="${V}" fill="url(#bg)"/>${pixelSun(V * 0.72, V * 0.3, V * 0.13, st, '#fff1c8')}
        ${pines(V * 0.6, st, '#8aa883', 11)}${pines(V * 0.68, st, '#4f7a4f', 5)}${small ? '' : rays(4, 0.08)}
        ${meadow(V * 0.72, st, { flowers: small ? 0 : 18, seed: 4 })}`;
    },
    art(small) {
      let out = voxels(helmetRows(18, !small), HELMET_PAL, { cx: V * 0.5, cy: V * 0.58, w: V * 0.66, jitter: small ? 0 : 0.06 }).svg;
      if (!small) {
        // poppies in the foreground
        const poppy = ['.R.', 'RYR', '.R.', '.S.', '.S.'];
        for (const [x, y, w] of [[0.16, 0.8, 0.07], [0.8, 0.83, 0.06], [0.7, 0.86, 0.05]])
          out += voxels(poppy, { R: 0xe8402a, Y: 0x2a1f1a, S: 0x3f7d34 }, { cx: V * x, cy: V * y, w: V * w, jitter: 0, outline: false }).svg;
      }
      return out;
    },
  },

  marker: {
    defs: `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3f5e"/><stop offset=".45" stop-color="#b8664a"/><stop offset=".7" stop-color="#f2a65a"/><stop offset="1" stop-color="#f7cf86"/></linearGradient>`,
    bg: (small) => {
      const st = small ? 24 : 12;
      return `<rect width="${V}" height="${V}" fill="url(#bg)"/>${pixelSun(V * 0.5, V * 0.66, V * 0.2, st, '#ffd88a')}
        ${pines(V * 0.74, st, '#5a4a52', 21)}${pines(V * 0.8, st, '#2e2a33', 8)}
        ${meadow(V * 0.82, st, { grass: '#2f3a2a', dark: '#232b20', flowers: 0, seed: 6 })}`;
    },
    art(small) {
      const rifle = [
        '...WW...',
        '...WW...',
        '...WWW..',
        '...KK...',
        '...KKKK.',
        '...KK.KK',
        '...KK.KK',
        '...KK...',
        '...WW...',
        '...WW...',
        '...WW...',
        '....K...',
        '....K...',
        '....K...',
      ];
      const pal = { W: 0x6e4a2e, K: 0x2b2f2a };
      const u = V * 0.8 / 22;
      let out = voxels(rifle, pal, { cx: V * 0.5 + u * 0.4, cy: V * 0.66, w: 8.4 * u, jitter: 0 }).svg;
      out += voxels(helmetRows(10, false), HELMET_PAL, { cx: V * 0.5 + u * 0.3, cy: V * 0.66 - 8.4 * u, w: 9 * u, jitter: 0 }).svg;
      return out;
    },
  },

  forest: {
    defs: `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfe0c0"/><stop offset=".6" stop-color="#8fb08a"/><stop offset="1" stop-color="#4c6b48"/></linearGradient>
      <linearGradient id="fog" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2f6e8" stop-opacity="0"/><stop offset=".55" stop-color="#f2f6e8" stop-opacity=".5"/><stop offset="1" stop-color="#f2f6e8" stop-opacity="0"/></linearGradient>`,
    bg: (small) => {
      const st = small ? 24 : 12;
      let t = '';
      // pine trunks at three depths
      for (const [x, w, c] of [[40, 18, '#7d9a78'], [150, 14, '#7d9a78'], [400, 16, '#7d9a78'], [470, 12, '#7d9a78'], [90, 28, '#4a6545'], [350, 30, '#4a6545'], [10, 40, '#2c3d2a'], [450, 44, '#2c3d2a']])
        t += `<rect x="${x}" y="0" width="${w}" height="${V}" fill="${c}"/>`;
      return `<rect width="${V}" height="${V}" fill="url(#bg)"/>${pines(V * 0.62, st, '#a5bf9d', 2)}${t}
        <rect y="${V * 0.35}" width="${V}" height="${V * 0.5}" fill="url(#fog)"/>${small ? '' : rays(5, 0.1)}
        ${meadow(V * 0.84, st, { grass: '#3f5e36', dark: '#2f4a29', flowers: small ? 0 : 6, seed: 12 })}`;
    },
    art(small) {
      const rows = [
        '......HHH.........',
        '.....HHHHH........',
        '....HHHHHHH.......',
        '.....SSSS.........',
        '.....SSSS.....R...',
        '......SS.....R....',
        '...BBBBBBBB.R.....',
        '..BBBBBBBBBRR.....',
        '..BBBBBBBBRBB.....',
        '..BB.BBBBRBBBB....',
        '..BB.BBBRBB.BB....',
        '..SS.BBRBBB.SS....',
        '.....BRBBB........',
        '.....BBBBB........',
        '.....BB.BB........',
        '.....BB..BB.......',
        '....BB...BB.......',
        '...BBB...BBB......',
      ];
      const pal = { H: 0x2e3524, S: 0x232a1f, B: 0x2a3122, R: 0x15190f };
      return voxels(rows, pal, { cx: V * 0.52, cy: V * 0.62, w: V * 0.5, depth: 0.3, jitter: 0 }).svg;
    },
  },

  grenade: {
    defs: `<radialGradient id="bg" cx="50%" cy="42%" r="80%"><stop offset="0" stop-color="#ffcf5a"/><stop offset=".5" stop-color="#f08a2c"/><stop offset="1" stop-color="#7a2a12"/></radialGradient>`,
    bg: (small) => {
      // sunburst rays
      let r = '';
      if (!small) for (let i = 0; i < 16; i++) {
        const a0 = (i / 16) * Math.PI * 2, a1 = a0 + Math.PI / 16;
        r += `<path d="M256 236L${256 + Math.cos(a0) * 600} ${236 + Math.sin(a0) * 600}L${256 + Math.cos(a1) * 600} ${236 + Math.sin(a1) * 600}Z" fill="#fff" opacity=".09"/>`;
      }
      return `<rect width="${V}" height="${V}" fill="url(#bg)"/>${r}`;
    },
    art(small) {
      const W = small ? 10 : 16, H = small ? 13 : 21, top = small ? 3 : 5;
      const cx = (W - 1) / 2;
      const rows = grid(W, H, (x, y) => {
        if (y < top) {
          // fuse head: lever + cap, ring on the right
          const capL = Math.round(cx - (small ? 1 : 2)), capR = Math.round(cx + (small ? 1 : 2));
          if (x >= capL && x <= capR && y >= (small ? 1 : 2)) return y === top - 1 ? 'k' : 'M';
          if (y === 0 && x >= capL - 1 && x <= capR) return 'L';
          if (y <= 1 && x >= capL && x <= capR + 1) return 'L';
          if (!small) {
            const rx = x - (capR + 3.5), ry = y - 2.2;
            const d = Math.hypot(rx / 1.8, ry / 1.8);
            if (d > 0.6 && d < 1.25) return 'R';
          }
          return null;
        }
        const yy = y - top, bh = H - top;
        const nx = (x - cx) / (W / 2), ny = (yy - (bh - 1) / 2) / (bh / 2);
        if (nx * nx + ny * ny > 1.02) return null;
        const groove = small ? (x % 3 === 1 || yy % 3 === 2) : (Math.round(x - cx + 0.5) % 4 === 0 || yy % 4 === 3);
        if (groove) return 'g';
        if (nx < -0.2 && ny < 0.1) return 'H';
        if (nx > 0.45 || ny > 0.6) return 'd';
        return 'G';
      });
      const pal = { G: 0x6f8a3a, H: 0x9db85c, g: 0x3f5223, d: 0x56702c, M: 0x8c8f94, k: 0x4a4d52, L: 0xb8bcc2, R: 0xd9dde2 };
      return voxels(rows, pal, { cx: V / 2, cy: V * 0.5, w: small ? V * 0.6 : V * 0.6, jitter: small ? 0 : 0.05 }).svg;
    },
  },

  tank: {
    defs: `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5ab0e8"/><stop offset=".62" stop-color="#bfe3f0"/><stop offset=".62" stop-color="#7cc35a"/><stop offset="1" stop-color="#3f7d34"/></linearGradient>`,
    bg: (small) => {
      let c = '';
      if (!small) for (const [x, y, w] of [[60, 90, 120], [330, 60, 140], [250, 150, 90]]) c += `<rect x="${x}" y="${y}" width="${w}" height="26" fill="#fff" opacity=".8"/><rect x="${x + 22}" y="${y - 20}" width="${w * 0.5}" height="22" fill="#fff" opacity=".8"/>`;
      return `<rect width="${V}" height="${V}" fill="url(#bg)"/>${c}`;
    },
    art(small) {
      const rows = small
        ? [
            '....TTTT......',
            '...TTTTTTBBBBB',
            '.HHHHHHHHHHH..',
            'DDDDDDDDDDDDD.',
            '.KWKWKWKWKWK..',
            '..KKKKKKKKK...',
          ]
        : [
            '..........tTTTTTt.............',
            '.........TTTTTTTTT............',
            '........TTTSTTTTTTTBBBBBBBBBBB',
            '........TTTTTTTTTTTbbbbbbbbbbb',
            '...HHHHHHHHHHHHHHHHHHHHHHH....',
            '..HHHHHHHHHHHHHHHHHHHHHHHHH...',
            '.DDDDDDDDDDDDDDDDDDDDDDDDDDD..',
            'DDDDDDDDDDDDDDDDDDDDDDDDDDDDD.',
            '.KKKKKKKKKKKKKKKKKKKKKKKKKKK..',
            'KKWWKKWWKKWWKKWWKKWWKKWWKKWWK.',
            'KKWWKKWWKKWWKKWWKKWWKKWWKKWWK.',
            '.KKKKKKKKKKKKKKKKKKKKKKKKKKK..',
          ];
      const pal = { T: 0x7f9a44, t: 0x9db85c, S: 0x3d8bff, B: 0x55642f, b: 0x3d4822, H: 0x8fab4e, D: 0x627a33, K: 0x2b2f2a, W: 0x8a8f86 };
      return voxels(rows, pal, { cx: V / 2, cy: V * 0.55, w: V * 0.86, jitter: small ? 0 : 0.05 }).svg;
    },
  },

  boom: {
    defs: `<radialGradient id="bg" cx="50%" cy="50%" r="75%"><stop offset="0" stop-color="#3a2a6e"/><stop offset="1" stop-color="#0d0a22"/></radialGradient>`,
    bg: () => `<rect width="${V}" height="${V}" fill="url(#bg)"/>`,
    art(small) {
      const N = small ? 11 : 23, c = (N - 1) / 2;
      const rows = grid(N, N, (x, y) => {
        const dx = x - c, dy = y - c;
        const a = Math.atan2(dy, dx);
        // spiky burst outline
        const spikes = 1 + 0.32 * Math.cos(a * 7) + (small ? 0 : 0.08 * Math.cos(a * 13 + 1));
        const r = Math.hypot(dx, dy) / (c * spikes);
        if (r > 1) return null;
        if (r < 0.3) return 'W';
        if (r < 0.55) return 'Y';
        if (r < 0.8) return 'O';
        return 'R';
      });
      const pal = { W: 0xfff8e0, Y: 0xffd23f, O: 0xff8a1f, R: 0xe8402a };
      let out = voxels(rows, pal, { cx: V / 2, cy: V / 2, w: V * 0.74, depth: 0.35, jitter: small ? 0 : 0.06 }).svg;
      if (!small) {
        // blasted blocks flying out
        const chips = [[60, 90, 34, 0x86d45c], [420, 70, 28, 0x9a6a43], [440, 400, 36, 0x9aa2ad], [70, 410, 26, 0x86d45c], [250, 30, 22, 0x9a6a43], [470, 240, 20, 0x9aa2ad], [30, 250, 22, 0x9a6a43]];
        for (const [x, y, z, col] of chips) {
          const c0 = hexToRgb(col), d = z * 0.4;
          out += quad([[x, y], [x + z, y], [x + z + d, y - d], [x + d, y - d]], rgb(mul(c0, 1.2))) +
            quad([[x + z, y], [x + z + d, y - d], [x + z + d, y + z - d], [x + z, y + z]], rgb(mul(c0, 0.62))) +
            `<rect x="${x}" y="${y}" width="${z}" height="${z}" fill="${rgb(c0)}"/>`;
        }
      }
      return out;
    },
  },

  helmet: {
    defs: `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a1b4a"/><stop offset=".45" stop-color="#c2415a"/><stop offset=".75" stop-color="#ff8a3d"/><stop offset="1" stop-color="#ffc861"/></linearGradient>`,
    bg: (small) => `<rect width="${V}" height="${V}" fill="url(#bg)"/>${pixelSun(V / 2, V * 0.5, V * 0.4, small ? 32 : 16, '#ffe08a', small ? 0 : 1)}`,
    art(small) {
      const rows = small
        ? [
            '...GGGG...',
            '.GGGGGGGG.',
            '.GGGGGGGG.',
            'GFOOFFOOFG',
            'gggggggggg',
            '.SESSSSES.',
            '.SPSSSSPS.',
            '.sSSKKSSs.',
            '..bSSSSb..',
          ]
        : [
            '......GGGGGG......',
            '....GGGGGGGGHG....',
            '...GGGGGGGGGGHG...',
            '..GGGGGGGGGGGGGG..',
            '..GGGGGGGGGGGGGG..',
            '.GGFFFFFFFFFFFFGG.',
            '.GGFOOOWFFOOOWFGG.',
            '.GGFOOOOFFOOOOFGG.',
            'ggggFFFFFFFFFFgggg',
            '..bSSSSSSSSSSSSb..',
            '..bSEESSSSSSEESb..',
            '..bSPPSSSSSSPPSb..',
            '..bSSSSSssSSSSSb..',
            '..bsSSSSSSSSSSsb..',
            '...bsSSKKKKSSsb...',
            '....bbsSSSSsbb....',
            '......bbbbbb......',
          ];
      const pal = {
        G: 0x6f8a3a, H: 0x9cb35a, g: 0x4d6127, F: 0x2b2f2a, O: 0xffa63d, W: 0xfff2c8,
        S: 0xe9b48a, s: 0xc98f66, E: 0x2a1f1a, P: 0x4d6127, K: 0x8c4a3a, b: 0x5a4632,
      };
      return voxels(rows, pal, { cx: V / 2, cy: V * 0.53, w: small ? V * 0.84 : V * 0.74, jitter: small ? 0 : 0.06 }).svg;
    },
  },

  vw: {
    defs: `<radialGradient id="bg" cx="50%" cy="40%" r="80%"><stop offset="0" stop-color="#26365e"/><stop offset="1" stop-color="#0b1020"/></radialGradient>
      <radialGradient id="flash"><stop offset="0" stop-color="#fff2c4" stop-opacity=".95"/><stop offset=".4" stop-color="#ff9a45" stop-opacity=".45"/><stop offset="1" stop-color="#ff6a2b" stop-opacity="0"/></radialGradient>`,
    bg: (small) => {
      // faint voxel grid floor
      let g = '';
      if (!small) for (let i = 0; i <= V; i += 32) g += `<path d="M${i} 0V${V}M0 ${i}H${V}" stroke="#fff" stroke-opacity=".04" stroke-width="2"/>`;
      return `<rect width="${V}" height="${V}" fill="url(#bg)"/>${g}`;
    },
    art(small) {
      const rows = [
        'BB...BB..RR.....RR',
        'BB...BB..RR.....RR',
        'BB...BB..RR..R..RR',
        '.BB.BB...RR.RRR.RR',
        '.BB.BB...RRRR.RRRR',
        '..BBB....RRR...RRR',
        '...B.....RR.....R.',
      ];
      if (!small) {
        // shot-out corner on the W
        rows[0] = rows[0].slice(0, 16) + '..';
        rows[1] = rows[1].slice(0, 17) + '.';
      }
      const pal = { B: 0x3d8bff, R: 0xff4d3d };
      const { svg, u, x0, y0 } = voxels(rows, pal, { cx: V / 2, cy: V / 2, w: V * 0.82, depth: 0.6, jitter: small ? 0 : 0.08 });
      let fx = '';
      if (!small) {
        const hx = x0 + 17.4 * u, hy = y0 + 0.7 * u;
        fx += `<circle cx="${hx}" cy="${hy}" r="${u * 1.8}" fill="url(#flash)"/>`;
        for (const [ox, oy, s] of [[1.2, -1.4, 0.55], [2.1, -0.4, 0.4], [0.3, -2.2, 0.35], [2.4, -2.0, 0.28]]) {
          const L = hx + ox * u, T = hy + oy * u, z = s * u, d = z * 0.5;
          fx += quad([[L, T], [L + z, T], [L + z + d, T - d], [L + d, T - d]], '#ff8a7a') +
            quad([[L + z, T], [L + z + d, T - d], [L + z + d, T + z - d], [L + z, T + z]], '#a8251c') +
            `<rect x="${L}" y="${T}" width="${z}" height="${z}" fill="#ff4d3d"/>`;
        }
      }
      return svg + fx;
    },
  },

  rifle: {
    defs: `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1d1442"/><stop offset=".4" stop-color="#8a2f6b"/><stop offset=".7" stop-color="#f2603f"/><stop offset="1" stop-color="#ffb347"/></linearGradient>`,
    bg: (small) =>
      `<rect width="${V}" height="${V}" fill="url(#bg)"/>${pixelSun(V / 2, V * 0.56, V * 0.3, small ? 32 : 16, '#ffd36b', 1)}${pines(V * 0.86, small ? 24 : 12, '#1a1030', 7)}`,
    art(small) {
      const rows = small
        ? [
            '.....KK.......',
            'KKK.KKKKKKKKKK',
            'KKKKKKKKKKKKKK',
            '.KKK.KK.K.....',
            '.....KK.KK....',
          ]
        : [
            '..........KKKKK.................',
            '.........KK...KK................',
            'KKKKK..KKKKKKKKKKKKKKKKKKK..K...',
            'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK',
            'KKKKKKKKKKKKKKKKKKKKKKKKKK......',
            'KKKKKK.KKKKKKKKKKKKKKKKKKK......',
            'KKKKK....KKK.KKKK...............',
            '.........KKK..KKKK..............',
            '........KKK...KKKK..............',
            '........KKK....KKK..............',
            '................KK..............',
          ];
      return voxels(rows, { K: 0x221a2e }, { cx: V / 2, cy: V * 0.5, w: V * (small ? 0.9 : 0.86), depth: 0.3, jitter: 0 }).svg;
    },
  },
};

/**
 * @param {object} o
 * @param {number} o.fill     scale of the art (1 = as designed)
 * @param {boolean} o.rounded rounded-square tile ("any") vs full bleed (maskable / iOS)
 * @param {boolean} o.small   simplified art for 16 to 96 px
 */
function svg({ fill, rounded, small }, design = DESIGN) {
  const d = DESIGNS[design];
  const rx = rounded ? V * 0.225 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${V} ${V}" width="${V}" height="${V}">
<defs>${COMMON_DEFS}${d.defs}<clipPath id="tile"><rect width="${V}" height="${V}" rx="${rx}"/></clipPath></defs>
<g clip-path="url(#tile)">
${d.bg(small)}
<g transform="translate(${V / 2} ${V / 2}) scale(${fill}) translate(${-V / 2} ${-V / 2})">${d.art(small)}</g>
<rect width="${V}" height="${V}" fill="url(#vignette)"/>
${rounded ? `<rect width="${V}" height="${V}" fill="url(#gloss)"/><rect x="1.5" y="1.5" width="${V - 3}" height="${V - 3}" rx="${rx - 1.5}" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="3"/>` : ''}
</g></svg>`;
}

// ---------- outputs ----------
const OUT = 'public';
mkdirSync(`${OUT}/icons`, { recursive: true });
const variants = {
  any: svg({ fill: 1, rounded: true, small: false }),
  // maskable: full bleed, art kept inside the 80% safe circle
  maskable: svg({ fill: 0.84, rounded: false, small: false }),
  // iOS rounds it itself: full bleed
  apple: svg({ fill: 1, rounded: false, small: false }),
  // tiny sizes: fewer, bigger voxels so it still reads at 16px
  small: svg({ fill: 1, rounded: true, small: true }),
};
writeFileSync(`${OUT}/favicon.svg`, variants.small);
writeFileSync(`${OUT}/icons/icon.svg`, variants.any);

const jobs = [
  ['any', 512, 'icons/pwa-512.png'],
  ['any', 384, 'icons/pwa-384.png'],
  ['any', 192, 'icons/pwa-192.png'],
  ['maskable', 512, 'icons/maskable-512.png'],
  ['maskable', 192, 'icons/maskable-192.png'],
  ['apple', 180, 'apple-touch-icon.png'],
  ['small', 96, 'icons/favicon-96.png'],
  ['small', 48, 'icons/favicon-48.png'],
  ['small', 32, 'icons/favicon-32.png'],
  ['small', 16, 'icons/favicon-16.png'],
];

// ESM ignores NODE_PATH, so resolve playwright through require to honour it
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
for (const [v, size, file] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${variants[v].replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body></html>`,
  );
  await page.screenshot({ path: `${OUT}/${file}`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', file);
}
await browser.close();

// multi-resolution favicon.ico for legacy browsers (ImageMagick, optional)
try {
  execFileSync('convert', [`${OUT}/icons/favicon-16.png`, `${OUT}/icons/favicon-32.png`, `${OUT}/icons/favicon-48.png`, `${OUT}/favicon.ico`]);
  console.log('wrote favicon.ico');
} catch {
  console.warn('ImageMagick not found, favicon.ico skipped');
}
