// Generates every VoxelWars app icon from chunky extruded voxel pixel art.
// Three designs live here; ICON=<name> picks one (default below):
//   helmet  a voxel soldier in a combat helmet with goggles, in front of a setting voxel sun
//   vw      a bold "VW" monogram in the team colours, one corner shot to bits
//   rifle   a carbine silhouette across a striped voxel sunset over the pines
// Emitted as SVG, rasterised with Chromium (Playwright).
//   npm run icons            (needs `playwright` resolvable, e.g. NODE_PATH to a global install)
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const DESIGN = process.env.ICON || 'helmet';
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

// ---------- designs ----------
const DESIGNS = {
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
