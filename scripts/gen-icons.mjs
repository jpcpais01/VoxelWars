// Generates every VoxelWars app icon: a bright voxel cube, built from fine voxels, with a
// corner just shot out of it and the chips flying, inside a first-person crosshair, over a
// stepped blue-vs-red split for the two teams. Emitted as SVG, rasterised with Chromium.
//   npm run icons            (needs `playwright` resolvable, e.g. NODE_PATH to a global install)
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const V = 512;
const COS30 = Math.cos(Math.PI / 6);

const hexToRgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const rgb = ([r, g, b]) => `rgb(${r | 0},${g | 0},${b | 0})`;
const mul = (c, k) => c.map((x) => Math.max(0, Math.min(255, x * k)));
const hash = (x, y, z) => {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

// team colours from src/core/config.ts
const BLUE = '#3d8bff';
const RED = '#ff4d3d';
const BONE = hexToRgb(0xfff4e2);
const CHIP = hexToRgb(0xffd9a0);
// sun from the upper left: top brightest, left face lit, right face in shade
const SHADE = { top: 1.0, left: 0.84, right: 0.62 };

const pts = (a) => a.map((p) => p.map((v) => v.toFixed(2)).join(' ')).join('L');
const poly = (a, fill, extra = '') => `<path d="M${pts(a)}Z" fill="${fill}"${extra}/>`;

/** isometric cube of n^3 voxels (minus the shot-out corner), centred on 0,0, edge length `size` */
function voxelCube(n, size, { debris, gaps }) {
  const u = size / n;
  const P = (x, y, z) => [(x - y) * COS30 * u, (x + y) * 0.5 * u - z * u];
  const filled = new Set();
  const k = (x, y, z) => `${x},${y},${z}`;
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) filled.add(k(x, y, z));
  // shoot out the top-right corner so the bite shows on the silhouette
  const m = n - 1;
  const hole = n >= 4
    ? [[m, 0, m], [m - 1, 0, m], [m, 1, m], [m, 0, m - 1], [m - 1, 1, m], [m, 1, m - 1], [m - 2, 0, m]]
    : [[m, 0, m]];
  for (const h of hole) filled.delete(k(...h));
  const has = (x, y, z) => filled.has(k(x, y, z));

  const cells = [...filled].map((s) => s.split(',').map(Number)).sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]) || a[2] - b[2]);
  const out = [];
  const sw = gaps ? (size / n) * 0.045 : size * 0.012;
  for (const [x, y, z] of cells) {
    const j = 1 - hash(x, y, z) * (gaps ? 0.06 : 0);
    const c = mul(BONE, j);
    const st = ` stroke="${rgb(mul(c, 0.55))}" stroke-opacity="${gaps ? 0.5 : 0.35}" stroke-width="${sw}" stroke-linejoin="round"`;
    const t = z + 1;
    if (!has(x + 1, y, z)) out.push(poly([P(x + 1, y, z), P(x + 1, y + 1, z), P(x + 1, y + 1, t), P(x + 1, y, t)], rgb(mul(c, SHADE.right)), st));
    if (!has(x, y + 1, z)) out.push(poly([P(x, y + 1, z), P(x + 1, y + 1, z), P(x + 1, y + 1, t), P(x, y + 1, t)], rgb(mul(c, SHADE.left)), st));
    if (!has(x, y, z + 1)) out.push(poly([P(x, y, t), P(x + 1, y, t), P(x + 1, y + 1, t), P(x, y + 1, t)], rgb(mul(c, SHADE.top)), st));
  }
  // crisp outer silhouette edges catch the light
  const hi = `stroke="#fff" stroke-opacity=".9" stroke-width="${sw * 1.6}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  out.push(`<path d="M${pts([P(0, n, n), P(0, 0, n), P(n >= 4 ? n - 3 : n - 1, 0, n)])}" ${hi}/>`);

  const fx = [];
  // impact flash in the crater
  const [hx, hy] = P(n - 0.5, 0.5, n - 0.3);
  fx.push(`<circle cx="${hx}" cy="${hy}" r="${u * (n >= 4 ? 1.9 : 1.1)}" fill="url(#flash)"/>`);
  if (debris) {
    // chips flying out of the hole, up and to the right, shrinking with distance
    const chips = [
      [n + 0.3, -0.9, n + 0.5, 0.8],
      [n + 1.1, -2.0, n + 1.3, 0.62],
      [n - 0.6, -1.4, n + 1.7, 0.5],
      [n + 2.0, -2.2, n + 0.4, 0.44],
      [n + 0.6, -3.2, n + 2.2, 0.36],
      [n + 2.4, -3.6, n + 1.6, 0.3],
    ];
    for (const [x, y, z, s] of chips) {
      const c = CHIP;
      const st = ` stroke="${rgb(mul(c, 0.5))}" stroke-opacity=".45" stroke-width="${sw * 0.8}" stroke-linejoin="round"`;
      fx.push(
        poly([P(x + s, y, z), P(x + s, y + s, z), P(x + s, y + s, z + s), P(x + s, y, z + s)], rgb(mul(c, SHADE.right)), st),
        poly([P(x, y + s, z), P(x + s, y + s, z), P(x + s, y + s, z + s), P(x, y + s, z + s)], rgb(mul(c, SHADE.left)), st),
        poly([P(x, y, z + s), P(x + s, y, z + s), P(x + s, y + s, z + s), P(x, y + s, z + s)], rgb(mul(c, 1.04)), st),
      );
    }
  }
  // centre the whole cube on the origin
  const cy = (P(0, 0, n)[1] + P(n, n, 0)[1]) / 2;
  return `<g transform="translate(0 ${(-cy).toFixed(2)})">${out.join('')}${fx.join('')}</g>`;
}

function crosshair(r, w, ticks) {
  // ring broken at the four cardinal points, with ticks pointing at the target
  const gap = 0.2; // radians each side
  const arcs = [];
  for (let q = 0; q < 4; q++) {
    const a0 = q * (Math.PI / 2) + gap, a1 = (q + 1) * (Math.PI / 2) - gap;
    const p0 = [Math.cos(a0) * r, Math.sin(a0) * r], p1 = [Math.cos(a1) * r, Math.sin(a1) * r];
    arcs.push(`M${p0[0].toFixed(2)} ${p0[1].toFixed(2)}A${r} ${r} 0 0 1 ${p1[0].toFixed(2)} ${p1[1].toFixed(2)}`);
  }
  let d = arcs.join('');
  if (ticks) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) d += `M${dx * (r + w * 1.6)} ${dy * (r + w * 1.6)}L${dx * (r - w * 2.2)} ${dy * (r - w * 2.2)}`;
  return `<path d="${d}" fill="none" stroke="#06101f" stroke-opacity=".35" stroke-width="${w + 6}" stroke-linecap="round" transform="translate(0 3)"/>` +
    `<path d="${d}" fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="round"/>`;
}

function background(step) {
  // stepped (voxel) diagonal seam: blue top-left, red bottom-right
  const stair = [];
  for (let x = V, y = 0; y < V; x -= step, y += step) stair.push([x, y], [x, y + step]);
  stair.push([0, V]);
  const blue = `M0 0L${pts(stair)}Z`;
  const seam = `M${pts(stair)}`;
  return `<rect width="${V}" height="${V}" fill="url(#red)"/>
<path d="${blue}" fill="url(#blue)"/>
<path d="${seam}" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="${step * 0.42}" stroke-linejoin="miter" filter="url(#soft)"/>
<path d="${seam}" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="${Math.max(3, step * 0.12)}" stroke-linejoin="miter"/>`;
}

const DEFS = `
<linearGradient id="blue" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#7cb4ff"/><stop offset=".45" stop-color="${BLUE}"/><stop offset="1" stop-color="#1c3f9e"/>
</linearGradient>
<linearGradient id="red" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#ff8a5c"/><stop offset=".55" stop-color="${RED}"/><stop offset="1" stop-color="#8e1a14"/>
</linearGradient>
<radialGradient id="flash"><stop offset="0" stop-color="#fff8d6" stop-opacity=".95"/><stop offset=".35" stop-color="#ffb347" stop-opacity=".55"/><stop offset="1" stop-color="#ff7a2b" stop-opacity="0"/></radialGradient>
<radialGradient id="shadow"><stop offset="0" stop-color="#071022" stop-opacity=".5"/><stop offset="1" stop-color="#071022" stop-opacity="0"/></radialGradient>
<radialGradient id="vignette" cx="50%" cy="50%" r="72%"><stop offset=".65" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></radialGradient>
<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".18"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
<filter id="soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="6"/></filter>`;

/**
 * @param {object} o
 * @param {number} o.fill     scale of the emblem (1 = ring nearly touches the tile edge)
 * @param {boolean} o.rounded rounded-square tile ("any") vs full bleed (maskable / iOS)
 * @param {boolean} o.small   chunkier cube, no chips, thicker ring: for 16 to 96 px
 */
function svg({ fill, rounded, small }) {
  const rx = rounded ? V * 0.225 : 0;
  const cube = small
    ? voxelCube(2, 186, { debris: false, gaps: false })
    : voxelCube(4, 166, { debris: true, gaps: true });
  const ring = small ? crosshair(214, 30, false) : crosshair(206, 18, true);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${V} ${V}" width="${V}" height="${V}">
<defs>${DEFS}<clipPath id="tile"><rect width="${V}" height="${V}" rx="${rx}"/></clipPath></defs>
<g clip-path="url(#tile)">
${background(small ? 64 : 32)}
<rect width="${V}" height="${V}" fill="url(#vignette)"/>
<g transform="translate(${V / 2} ${V / 2}) scale(${fill})">
<ellipse cx="0" cy="${small ? 150 : 158}" rx="150" ry="34" fill="url(#shadow)"/>
${ring}
${cube}
</g>
${rounded ? `<rect width="${V}" height="${V}" fill="url(#gloss)"/><rect x="1.5" y="1.5" width="${V - 3}" height="${V - 3}" rx="${rx - 1.5}" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="3"/>` : ''}
</g></svg>`;
}

// ---------- outputs ----------
const OUT = 'public';
mkdirSync(`${OUT}/icons`, { recursive: true });
const variants = {
  any: svg({ fill: 1, rounded: true, small: false }),
  // maskable: full bleed, emblem kept inside the 80% safe circle
  maskable: svg({ fill: 0.86, rounded: false, small: false }),
  // iOS rounds it itself: full bleed
  apple: svg({ fill: 0.96, rounded: false, small: false }),
  // tiny sizes: 2x2x2 cube, bigger steps, thicker ring so it still reads at 16px
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
