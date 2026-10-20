// Generates every VoxelWars app icon from one hand-placed isometric voxel diorama:
// a floating chunk of Pinewater Valley with a pine, a river spilling off the edge as a
// waterfall, the enemy core glowing on its pad and a blasted corner throwing debris.
// The scene is emitted as SVG, then rasterised with Chromium (Playwright) for crisp PNGs.
//   npm run icons            (needs `playwright` resolvable, e.g. NODE_PATH to a global install)
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const COS30 = Math.cos(Math.PI / 6);

// ---------- colour helpers ----------
const hexToRgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const rgb = ([r, g, b], a = 1) =>
  a >= 1 ? `rgb(${r | 0},${g | 0},${b | 0})` : `rgba(${r | 0},${g | 0},${b | 0},${a})`;
const mul = (c, k) => c.map((x) => Math.max(0, Math.min(255, x * k)));
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
// deterministic jitter so every build gives the same icon
const hash = (x, y, z) => {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

// Warm golden-hour palette with a slight toy saturation
const PAL = {
  grass: hexToRgb(0x86d45c),
  grassDeep: hexToRgb(0x5fae45),
  dirt: hexToRgb(0x9a6a43),
  dirtDeep: hexToRgb(0x7a5136),
  stone: hexToRgb(0x9aa2ad),
  stoneDark: hexToRgb(0x6f7783),
  sand: hexToRgb(0xd9c08a),
  bark: hexToRgb(0x7b5134),
  pine: hexToRgb(0x2f8a4f),
  pineLight: hexToRgb(0x49b062),
  leaf: hexToRgb(0x8fcf4a),
  water: hexToRgb(0x3fb8e6),
  waterDeep: hexToRgb(0x1f7fb8),
  concrete: hexToRgb(0xc9c3b6),
  core: hexToRgb(0xff6a2b),
  flag: hexToRgb(0x3d8bff),
};

// Light: sun from the upper-left-back, so +y (left) faces are lit, +x (right) faces in shade
const SHADE = { top: 1.0, left: 0.8, right: 0.6 };

// ---------- scene ----------
/** @type {Map<string, {x:number,y:number,z:number,c:number[],h?:number,kind?:string,s?:number}>} */
const vox = new Map();
const key = (x, y, z) => `${x},${y},${z}`;
const put = (x, y, z, c, extra = {}) => vox.set(key(x, y, z), { x, y, z, c, ...extra });
const del = (x, y, z) => vox.delete(key(x, y, z));

function buildScene(detail) {
  vox.clear();
  const N = detail ? 7 : 5;
  const river = detail
    ? [[3, 0], [3, 1], [3, 2], [4, 2], [4, 3], [5, 3], [5, 4], [6, 4]]
    : [[2, 0], [2, 1], [3, 1], [3, 2], [4, 2]];
  const isRiver = (x, y) => river.some(([a, b]) => a === x && b === y);

  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) {
      put(x, y, 0, mix(PAL.stone, PAL.stoneDark, hash(x, y, 0) * 0.5), { kind: 'stone' });
      put(x, y, 1, mix(PAL.dirt, PAL.dirtDeep, hash(x, y, 1) * 0.6), { kind: 'dirt' });
      if (isRiver(x, y)) {
        put(x, y, 1, mix(PAL.sand, PAL.dirt, 0.35 + hash(x, y, 5) * 0.2), { kind: 'dirt' });
        put(x, y, 2, PAL.water, { kind: 'water', h: 0.72 });
      } else {
        put(x, y, 2, mix(PAL.grass, PAL.grassDeep, hash(x, y, 2) * 0.55), { kind: 'grass' });
      }
    }
  }

  // pine tree
  const pine = (tx, ty, base, tall) => {
    for (let z = base; z < base + 2; z++) put(tx, ty, z, PAL.bark, { kind: 'bark' });
    // [radius, chamfer] per level
    const lv = tall ? [[1, 0], [1, 1], [1, 1], [0, 0], [0, 0]] : [[1, 0], [1, 1], [0, 0]];
    lv.forEach(([r, ch], i) => {
      const z = base + 2 + i;
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (ch && Math.abs(dx) + Math.abs(dy) > 1) continue;
          const lightness = (i + 1) / lv.length;
          put(tx + dx, ty + dy, z, mix(PAL.pine, PAL.pineLight, lightness * 0.8 + hash(dx, dy, z) * 0.2), { kind: 'leaf' });
        }
      }
    });
  };

  if (detail) {
    pine(1, 4, 3, true);
    // bushes
    put(1, 1, 3, mix(PAL.leaf, PAL.pineLight, 0.3), { kind: 'leaf', h: 0.7 });
    put(2, 1, 3, mix(PAL.leaf, PAL.pineLight, 0.6), { kind: 'leaf', h: 0.5 });

    // enemy core: concrete pad + glowing crystal
    for (const [x, y] of [[5, 0], [6, 0], [5, 1], [6, 1]]) put(x, y, 3, mix(PAL.concrete, PAL.stone, hash(x, y, 3) * 0.4), { kind: 'stone', h: 0.4 });
    // sandbag/stone wall on the front-left, one block already blown out
    put(0, 6, 3, PAL.stoneDark, { kind: 'stone', h: 0.7 });
    put(2, 6, 3, PAL.stoneDark, { kind: 'stone', h: 0.7 });
    // rocks
    put(4, 5, 3, PAL.stone, { kind: 'stone', h: 0.5 });
    // blasted front corner
    for (const [x, y, z] of [[6, 6, 2], [6, 6, 1], [5, 6, 2], [6, 5, 2], [6, 6, 0]]) del(x, y, z);
    put(5, 6, 1, PAL.dirtDeep, { kind: 'dirt' });
  } else {
    pine(1, 3, 3, false);
    for (const [x, y] of [[3, 0], [4, 0], [4, 1]]) put(x, y, 3, PAL.concrete, { kind: 'stone', h: 0.4 });
    del(4, 4, 2); del(4, 4, 1);
  }
  return { N, river };
}

// ---------- isometric projection & painter ----------
const S = 32; // cube edge in scene units
const P = (x, y, z) => [(x - y) * COS30 * S, (x + y) * 0.5 * S - z * S];
const poly = (pts, fill, extra = '') =>
  `<path d="M${pts.map((p) => p.map((v) => v.toFixed(2)).join(' ')).join('L')}Z" fill="${fill}"${extra}/>`;

function renderScene(detail) {
  const { N, river } = buildScene(detail);
  const opaque = (x, y, z) => {
    const v = vox.get(key(x, y, z));
    return v && v.kind !== 'water' && !v.h;
  };
  const list = [...vox.values()].sort((a, b) => a.x + a.y + a.z - (b.x + b.y + b.z) || a.z - b.z);
  const out = [];
  const edge = detail ? 0.9 : 1.6;

  for (const v of list) {
    const { x, y, z } = v;
    const h = v.h ?? 1;
    const t = z + h;
    const top = [P(x, y, t), P(x + 1, y, t), P(x + 1, y + 1, t), P(x, y + 1, t)];
    const right = [P(x + 1, y, z), P(x + 1, y + 1, z), P(x + 1, y + 1, t), P(x + 1, y, t)];
    const left = [P(x, y + 1, z), P(x + 1, y + 1, z), P(x + 1, y + 1, t), P(x, y + 1, t)];

    if (v.kind === 'water') {
      // translucent volume: deep sides, glossy top with a sky streak
      if (!opaque(x + 1, y, z)) out.push(poly(right, rgb(mul(PAL.waterDeep, 0.9), 0.82)));
      if (!opaque(x, y + 1, z)) out.push(poly(left, rgb(PAL.waterDeep, 0.78)));
      out.push(poly(top, 'url(#water)'));
      const a = P(x + 0.25, y + 0.3, t), b = P(x + 0.7, y + 0.3, t);
      out.push(`<path d="M${a.join(' ')}L${b.join(' ')}" stroke="rgba(255,255,255,.55)" stroke-width="${edge * 1.6}" stroke-linecap="round"/>`);
      continue;
    }

    // fake AO on tops: darker where taller neighbours crowd the cell
    let ao = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (opaque(x + dx, y + dy, z + 1)) ao++;
    const topC = mul(v.c, SHADE.top * (1 - ao * 0.07) * 1.06);
    const stroke = ` stroke="${rgb(mul(v.c, 0.42), 0.55)}" stroke-width="${edge}" stroke-linejoin="round"`;

    if (!opaque(x + 1, y, z)) {
      out.push(poly(right, rgb(mul(v.c, SHADE.right)), stroke));
      if (v.kind === 'grass') out.push(poly([P(x + 1, y, t - 0.28), P(x + 1, y + 1, t - 0.28), P(x + 1, y + 1, t), P(x + 1, y, t)], rgb(mul(PAL.grassDeep, SHADE.right * 1.05))));
    }
    if (!opaque(x, y + 1, z)) {
      out.push(poly(left, rgb(mul(v.c, SHADE.left)), stroke));
      if (v.kind === 'grass') out.push(poly([P(x, y + 1, t - 0.28), P(x + 1, y + 1, t - 0.28), P(x + 1, y + 1, t), P(x, y + 1, t)], rgb(mul(PAL.grassDeep, SHADE.left * 1.05))));
    }
    if (!opaque(x, y, z + 1) || v.h) {
      out.push(poly(top, rgb(topC), stroke));
      // bevel highlight on the two sun-facing top edges
      const [a, b, , d] = top;
      out.push(`<path d="M${d.join(' ')}L${a.join(' ')}L${b.join(' ')}" fill="none" stroke="rgba(255,250,225,.38)" stroke-width="${edge * 1.1}" stroke-linejoin="round"/>`);
    }
  }

  // waterfall off the edge where the river leaves the chunk
  const [ex, ey] = river[river.length - 1];
  const fx = ex + 1;
  const fall = [P(fx, ey + 0.08, 2.72), P(fx, ey + 0.92, 2.72), P(fx, ey + 0.92, -1.4), P(fx, ey + 0.08, -1.4)];
  const fallFx = [];
  fallFx.push(poly(fall, 'url(#fall)'));
  for (let i = 0; i < (detail ? 4 : 2); i++) {
    const yy = ey + 0.2 + i * (detail ? 0.2 : 0.5);
    const a = P(fx, yy, 2.6 - hash(i, 1, 1) * 0.6), b = P(fx, yy, 0.2 - hash(i, 2, 2) * 1.2);
    fallFx.push(`<path d="M${a.join(' ')}L${b.join(' ')}" stroke="rgba(255,255,255,.5)" stroke-width="${edge * 1.3}" stroke-linecap="round"/>`);
  }
  const mist = P(fx + 0.15, ey + 0.5, -1.4);
  fallFx.push(`<ellipse cx="${mist[0]}" cy="${mist[1]}" rx="${S * 0.75}" ry="${S * 0.32}" fill="url(#mist)"/>`);
  out.splice(out.length, 0, ...fallFx);

  // the enemy core: floating octahedron crystal with a bloom
  const coreAt = detail ? [6, 1, 4.45] : [4, 1, 4.0];
  const [cx, cy] = P(...coreAt);
  const r = S * (detail ? 0.78 : 0.9);
  const core = [];
  core.push(`<circle cx="${cx}" cy="${cy}" r="${r * 3.2}" fill="url(#bloom)"/>`);
  const tip = [cx, cy - r * 1.35], bot = [cx, cy + r * 1.35], l = [cx - r, cy], rr = [cx + r, cy], f = [cx + r * 0.15, cy + r * 0.35];
  core.push(poly([tip, l, f], rgb(hexToRgb(0xffb36b))));
  core.push(poly([tip, f, rr], rgb(PAL.core)));
  core.push(poly([bot, l, f], rgb(mul(PAL.core, 0.85))));
  core.push(poly([bot, f, rr], rgb(mul(PAL.core, 0.62))));
  core.push(`<path d="M${tip.join(' ')}L${l.join(' ')}" stroke="rgba(255,240,200,.85)" stroke-width="${edge * 1.4}" stroke-linecap="round"/>`);
  // light pool on the pad
  const pool = P(coreAt[0], coreAt[1], 3.4);
  const poolSvg = `<ellipse cx="${pool[0]}" cy="${pool[1]}" rx="${S * 1.2}" ry="${S * 0.6}" fill="url(#bloom)" opacity=".7"/>`;

  // debris blasted from the corner
  const debris = [];
  if (detail) {
    const chunks = [
      [6.5, 7.9, 3.3, 0.46, PAL.grass],
      [5.9, 8.1, 4.4, 0.3, PAL.dirt],
      [7.2, 7.6, 4.2, 0.24, PAL.grass],
      [6.2, 8.6, 2.0, 0.28, PAL.stone],
    ];
    const puff = P(6.6, 7.3, 2.4);
    debris.push(`<circle cx="${puff[0]}" cy="${puff[1]}" r="${S * 1.5}" fill="url(#blast)"/>`);
    for (const [x, y, z, s, c] of chunks) {
      const top = [P(x, y, z + s), P(x + s, y, z + s), P(x + s, y + s, z + s), P(x, y + s, z + s)];
      const right = [P(x + s, y, z), P(x + s, y + s, z), P(x + s, y + s, z + s), P(x + s, y, z + s)];
      const left = [P(x, y + s, z), P(x + s, y + s, z), P(x + s, y + s, z + s), P(x, y + s, z + s)];
      const st = ` stroke="${rgb(mul(c, 0.4), 0.6)}" stroke-width="${edge * 0.8}" stroke-linejoin="round"`;
      debris.push(poly(right, rgb(mul(c, SHADE.right)), st), poly(left, rgb(mul(c, SHADE.left)), st), poly(top, rgb(mul(c, 1.08)), st));
    }
  }

  // little blue team flag on the wall
  const flag = [];
  if (detail) {
    const base = P(0.5, 6.5, 3.7), topP = P(0.5, 6.5, 5.6);
    flag.push(`<path d="M${base.join(' ')}L${topP.join(' ')}" stroke="#e9e3d2" stroke-width="${edge * 2.2}" stroke-linecap="round"/>`);
    const f1 = P(0.5, 6.5, 5.55), f2 = P(0.5, 5.3, 5.3), f3 = P(0.5, 6.5, 4.85);
    flag.push(poly([f1, [f2[0], f2[1] - 2], f3], rgb(PAL.flag)));
    flag.push(poly([f1, [f2[0], f2[1] - 2], [ (f1[0] + f2[0]) / 2, (f1[1] + f2[1]) / 2 + 3 ]], rgb(mul(PAL.flag, 1.25))));
  }

  // drop shadow under the floating chunk
  const sc = P(N / 2, N / 2, -1.6);
  const shadow = `<ellipse cx="${sc[0]}" cy="${sc[1] + S * 0.6}" rx="${N * S * 0.78}" ry="${N * S * 0.22}" fill="url(#shadow)"/>`;

  const body = [shadow, ...out.slice(0), poolSvg, ...core, ...flag, ...debris].join('');
  // bounds of the chunk for framing (corners of the base slab + tree/core heights)
  const pts = [P(0, 0, 3), P(N, 0, 0), P(0, N, 0), P(N, N, 0), P(0, 0, detail ? 9 : 7), P(N, N, -1.4)];
  const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
  return { body, box: [minX, minY, maxX - minX, maxY - minY] };
}

const DEFS = `
<radialGradient id="sky" cx="62%" cy="22%" r="95%">
  <stop offset="0" stop-color="#ffe2a3"/>
  <stop offset=".22" stop-color="#f3a466"/>
  <stop offset=".52" stop-color="#3f7d73"/>
  <stop offset="1" stop-color="#0d1f19"/>
</radialGradient>
<radialGradient id="sun" cx="50%" cy="50%" r="50%">
  <stop offset="0" stop-color="#fff6d8" stop-opacity=".95"/>
  <stop offset=".35" stop-color="#ffd38a" stop-opacity=".45"/>
  <stop offset="1" stop-color="#ffb060" stop-opacity="0"/>
</radialGradient>
<radialGradient id="vignette" cx="50%" cy="45%" r="75%">
  <stop offset=".6" stop-color="#000" stop-opacity="0"/>
  <stop offset="1" stop-color="#03100b" stop-opacity=".55"/>
</radialGradient>
<linearGradient id="water" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#9fe8ff"/>
  <stop offset=".5" stop-color="#46c1ec"/>
  <stop offset="1" stop-color="#2a93cf"/>
</linearGradient>
<linearGradient id="fall" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#7fd8f7" stop-opacity=".95"/>
  <stop offset=".7" stop-color="#bdefff" stop-opacity=".75"/>
  <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
</linearGradient>
<radialGradient id="mist"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<radialGradient id="bloom"><stop offset="0" stop-color="#ffd27a" stop-opacity=".95"/><stop offset=".3" stop-color="#ff7a30" stop-opacity=".45"/><stop offset="1" stop-color="#ff5a1f" stop-opacity="0"/></radialGradient>
<radialGradient id="blast"><stop offset="0" stop-color="#fff1c4" stop-opacity=".9"/><stop offset=".35" stop-color="#ff9a45" stop-opacity=".45"/><stop offset="1" stop-color="#ff6a2b" stop-opacity="0"/></radialGradient>
<radialGradient id="shadow"><stop offset="0" stop-color="#02120c" stop-opacity=".55"/><stop offset="1" stop-color="#02120c" stop-opacity="0"/></radialGradient>
<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#fff" stop-opacity=".16"/>
  <stop offset=".45" stop-color="#fff" stop-opacity="0"/>
</linearGradient>`;

/**
 * @param {object} o
 * @param {number} o.fill   fraction of the canvas the diorama spans
 * @param {boolean} o.rounded  rounded-square tile (for "any" icons) vs full bleed (maskable / iOS)
 * @param {boolean} o.detail   full diorama vs the simplified favicon scene
 */
function svg({ fill, rounded, detail }) {
  const V = 512;
  const { body, box } = renderScene(detail);
  const [bx, by, bw, bh] = box;
  const k = (V * fill) / Math.max(bw, bh);
  const tx = V / 2 - (bx + bw / 2) * k;
  const ty = V / 2 - (by + bh / 2) * k + V * 0.01;
  const rx = rounded ? V * 0.225 : 0;
  const clip = `<clipPath id="tile"><rect width="${V}" height="${V}" rx="${rx}"/></clipPath>`;
  const sun = detail
    ? `<circle cx="${V * 0.7}" cy="${V * 0.2}" r="${V * 0.3}" fill="url(#sun)"/>`
    : `<circle cx="${V * 0.72}" cy="${V * 0.18}" r="${V * 0.34}" fill="url(#sun)"/>`;
  // soft drifting voxel motes (fireflies / pollen)
  const motes = detail
    ? [[0.16, 0.2, 7], [0.26, 0.12, 5], [0.86, 0.46, 6], [0.12, 0.62, 4], [0.9, 0.78, 5], [0.42, 0.08, 4]]
        .map(([x, y, s]) => `<rect x="${x * V}" y="${y * V}" width="${s}" height="${s}" rx="1" fill="#fff4cf" opacity=".55" transform="rotate(45 ${x * V} ${y * V})"/>`)
        .join('')
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${V} ${V}" width="${V}" height="${V}">
<defs>${DEFS}${clip}</defs>
<g clip-path="url(#tile)">
<rect width="${V}" height="${V}" fill="url(#sky)"/>${sun}${motes}
<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(4)})">${body}</g>
<rect width="${V}" height="${V}" fill="url(#vignette)"/>
${rounded ? `<rect width="${V}" height="${V}" fill="url(#gloss)"/><rect x="1.5" y="1.5" width="${V - 3}" height="${V - 3}" rx="${rx - 1.5}" fill="none" stroke="#fff" stroke-opacity=".12" stroke-width="3"/>` : ''}
</g></svg>`;
}

// ---------- outputs ----------
const OUT = 'public';
mkdirSync(`${OUT}/icons`, { recursive: true });
const variants = {
  any: svg({ fill: 0.8, rounded: true, detail: true }),
  // maskable: full bleed, art kept inside the 80% safe circle
  maskable: svg({ fill: 0.66, rounded: false, detail: true }),
  // iOS rounds it itself: full bleed, a touch more breathing room
  apple: svg({ fill: 0.8, rounded: false, detail: true }),
  // tiny sizes: simpler, chunkier diorama so it still reads at 16px
  small: svg({ fill: 0.9, rounded: true, detail: false }),
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
