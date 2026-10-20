import { FLOW_RES, VOXEL, WATER_Y, WX, WY, WZ } from '../core/config';
import { Simplex, clamp, hash2, hash3, lerp, mulberry32, smoothstep } from '../core/noise';
import { M } from './materials';
import { World } from './World';

/**
 * Forest & river map.
 * The big shapes (river, lake, paths, base sites, hills) are laid out on a 0.4 m layout grid that
 * is point-symmetric around the map centre, so both teams get a fair map. The world itself is
 * carved at full voxel resolution: heights are interpolated from the layout and given fine relief,
 * and every building, prop and plant is built voxel by voxel. Structure code is in voxels.
 */

export interface V2 {
  x: number;
  z: number;
}

export interface MapInfo {
  /** metres */
  cores: [V2, V2];
  coreY: [number, number];
  spawns: [V2[], V2[]];
  /** lanes per team, in metres, from own base to enemy core */
  lanes: [V2[][], V2[][]];
  defendSpots: [V2[], V2[]];
  supply: [V2, V2];
  flags: [{ x: number; y: number; z: number }, { x: number; y: number; z: number }];
  grassDensity: Uint8Array;
  riverZ: (xMetres: number) => number;
  waterMask: Uint8Array;
  menuOrbit: V2;
  /** water flow field, FLOW_RES x FLOW_RES texels, RG = flow x/z * 0.5 + 0.5, index i * FLOW_RES + j */
  flow: Uint8Array;
}

/** voxels per layout unit */
const S = Math.round(0.4 / VOXEL);
const LW = WX / S;
const LD = WZ / S;
/** metres per layout unit */
const LV = VOXEL * S;
const C = (LW - 1) / 2; // layout centre, 191.5
const mirror = (p: V2): V2 => ({ x: LW - 1 - p.x, z: LD - 1 - p.z });
/** point mirror in voxel space */
const mf = (p: V2): V2 => ({ x: WX - 1 - p.x, z: WZ - 1 - p.z });
/** columns whose surface height is at or below this are under water */
export const WATER_VOX = Math.floor(WATER_Y / VOXEL);
const WATER_L = 10;

type Prog = (p: number, label: string) => Promise<void>;

export async function generateWorld(world: World, seed: number, progress: Prog): Promise<MapInfo> {
  const rng = mulberry32(seed);
  const sn = new Simplex(rng);
  const sn2 = new Simplex(rng);
  const vox = world.vox;
  const sym2 = (f: (x: number, z: number) => number, x: number, z: number) => (f(x, z) + f(LW - 1 - x, LD - 1 - z)) * 0.5;
  const symF = (f: (x: number, z: number) => number, x: number, z: number) => (f(x, z) + f(WX - 1 - x, WZ - 1 - z)) * 0.5;

  // ================================================================ layout (0.4 m units)
  // ---------------------------------------------------------------- river
  const n1 = (x: number) => sn.noise2(x / 45, 7.3);
  const riverZ = (x: number) => C + 26 * Math.sin((x - C) / 58) + 9 * (n1(x) - n1(LW - 1 - x));
  const riverHW = (x: number) => 7.5 + 1.8 * (sn2.noise2(x / 30, 3.1) + sn2.noise2((LW - 1 - x) / 30, 3.1));
  const riverDist = (x: number, z: number) => {
    const zr = riverZ(x);
    const slope = (riverZ(x + 1) - riverZ(x - 1)) * 0.5;
    return Math.abs(z - zr) / Math.sqrt(1 + slope * slope);
  };
  const lakeD = (x: number, z: number) => {
    const dx = (x - C) / 31;
    const dz = (z - C) / 21;
    const a = Math.atan2(dz, dx);
    // even harmonics only, so the shoreline survives the half turn
    const wob = 1 + 0.12 * Math.sin(a * 2 + 1.3) + 0.06 * Math.sin(a * 4 + 0.4);
    return Math.sqrt(dx * dx + dz * dz) / wob;
  };
  const islandD = (x: number, z: number) => Math.hypot((x - C) / 7.5, (z - C) / 6.5);

  // ---------------------------------------------------------------- key locations (Blue half, mirrored for Red)
  const blueBase: V2 = { x: 192, z: 340 };
  const redBase = mirror(blueBase);
  const bridgeX = 88;
  const westBridge: V2 = { x: bridgeX, z: riverZ(bridgeX) };
  const eastBridge = mirror(westBridge);
  const cabinBlue: V2 = { x: 300, z: 282 };
  const ruinBlue: V2 = { x: 70, z: 296 };

  // paths (Blue side), from base gates to crossings
  const pathW: V2[] = [
    { x: 172, z: 316 },
    { x: 150, z: 300 },
    { x: 122, z: 290 },
    { x: 100, z: 270 },
    { x: bridgeX, z: westBridge.z + 26 },
    { x: bridgeX, z: westBridge.z + 12 },
  ];
  const pathE: V2[] = [
    { x: 212, z: 316 },
    { x: 236, z: 302 },
    { x: 268, z: 296 },
    { x: 288, z: 276 },
    { x: eastBridge.x, z: eastBridge.z + 30 },
    { x: eastBridge.x, z: eastBridge.z + 12 },
  ];
  const pathC: V2[] = [
    { x: 192, z: 312 },
    { x: 186, z: 284 },
    { x: 196, z: 258 },
    { x: 190, z: 236 },
    { x: 192, z: 222 },
  ];
  const allPaths: V2[][] = [pathW, pathE, pathC, pathW.map(mirror), pathE.map(mirror), pathC.map(mirror)];
  // small trail to cabin
  allPaths.push([{ x: 268, z: 296 }, { x: 284, z: 290 }, { x: cabinBlue.x - 6, z: cabinBlue.z + 4 }]);
  allPaths.push([{ x: 268, z: 296 }, { x: 284, z: 290 }, { x: cabinBlue.x - 6, z: cabinBlue.z + 4 }].map(mirror));

  const segDist = (px: number, pz: number, a: V2, b: V2) => {
    const abx = b.x - a.x, abz = b.z - a.z;
    const t = clamp(((px - a.x) * abx + (pz - a.z) * abz) / (abx * abx + abz * abz), 0, 1);
    return Math.hypot(px - (a.x + abx * t), pz - (a.z + abz * t));
  };

  // path distance field (coarse stamp, only near segments)
  const pathField = new Float32Array(LW * LD).fill(99);
  for (const path of allPaths) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - 8)), x1 = Math.min(LW - 1, Math.ceil(Math.max(a.x, b.x) + 8));
      const z0 = Math.max(0, Math.floor(Math.min(a.z, b.z) - 8)), z1 = Math.min(LD - 1, Math.ceil(Math.max(a.z, b.z) + 8));
      for (let x = x0; x <= x1; x++)
        for (let z = z0; z <= z1; z++) {
          const d = segDist(x, z, a, b) + sym2((p, q) => sn.noise2(p / 6, q / 6), x, z) * 1.1;
          const k = x * LD + z;
          if (d < pathField[k]) pathField[k] = d;
        }
    }
  }

  // ---------------------------------------------------------------- layout heightmap
  const HL = new Float32Array(LW * LD);
  const forest = new Float32Array(LW * LD);
  const rockMask = new Float32Array(LW * LD);
  const edgeL = new Float32Array(LW * LD); // distance outside the river's edge
  const lakeL = new Float32Array(LW * LD);
  const BASE_H = 19;
  const BASE_R = 40;

  const fb = (x: number, z: number) => sn.fbm2(x / 95, z / 95, 3);
  const fm = (x: number, z: number) => sn.fbm2(x / 33, z / 33, 3);
  const ff = (x: number, z: number) => sn2.noise2(x / 11, z / 11);
  const fr = (x: number, z: number) => sn2.ridge2(x / 46 + 10, z / 46 - 4, 3);
  const fforest = (x: number, z: number) => sn2.fbm2(x / 70 + 50, z / 70 + 50, 3);

  for (let x = 0; x < LW; x++) {
    if (x % 32 === 0) await progress(0.02 + (x / LW) * 0.14, 'Shaping the valley');
    for (let z = 0; z < LD; z++) {
      const k = x * LD + z;
      let h = 17 + 7 * sym2(fb, x, z) * 1.4 + 2.2 * sym2(fm, x, z) * 1.4 + 0.7 * sym2(ff, x, z);
      const rd = riverDist(x, z);
      const hw = riverHW(x);
      const ld = lakeD(x, z);
      // broad valley toward the river
      h -= 5 * (1 - smoothstep(0, 90, rd));
      // border hills
      const edge = Math.min(x, z, LW - 1 - x, LD - 1 - z);
      let raise = Math.pow(1 - smoothstep(0, 30, edge), 2) * (16 + 8 * sym2(fr, x, z));
      raise *= smoothstep(hw + 3, hw + 26, rd);
      h += raise;
      // rocky outcrops
      const ro = sym2(fr, x, z);
      const baseDB = Math.min(Math.hypot(x - blueBase.x, z - blueBase.z), Math.hypot(x - redBase.x, z - redBase.z));
      let rock = 0;
      if (ro > 0.8 && rd > hw + 10 && baseDB > BASE_R + 10 && pathField[k] > 6 && ld > 1.5) {
        rock = smoothstep(0.8, 0.93, ro);
        h += rock * 9;
      }
      rockMask[k] = rock;
      // river channel + banks
      const bankW = 9 + 9 * (sym2((a, b) => sn.noise2(a / 40 + 30, b / 40), x, z) + 1);
      const inRiver = rd < hw;
      const lakeIn = ld < 1;
      let bed = 99;
      if (inRiver) {
        const t = rd / hw;
        bed = 10.4 - 2.6 * (1 - t * t);
      }
      if (lakeIn) {
        const lb = 10.4 - 4.6 * (1 - ld * ld);
        bed = Math.min(bed, lb);
      }
      if (bed < 99) {
        h = bed;
      } else {
        const d = Math.min(rd - hw, (ld - 1) * 24);
        const bank = 11.2 + Math.max(0, d) * 0.05;
        h = lerp(bank, Math.max(h, bank), smoothstep(0, bankW, d));
      }
      // island
      const isl = islandD(x, z);
      if (isl < 1.6) h = Math.max(h, lerp(13.6, 10, smoothstep(0.55, 1.6, isl)));
      // ford stones around the island (shallow crossing)
      if (lakeIn && Math.abs(x - C) < 5 && isl > 1) h = Math.max(h, 10.2);
      // base plateaus
      const bl = Math.hypot(x - blueBase.x, z - blueBase.z);
      const rdb = Math.hypot(x - redBase.x, z - redBase.z);
      const db = Math.min(bl, rdb);
      h = lerp(BASE_H + sym2((p, q) => sn.noise2(p / 9, q / 9), x, z) * 0.4, h, smoothstep(BASE_R - 8, BASE_R + 14, db));
      // bridge ramps
      for (const br of [westBridge, eastBridge]) {
        const bdx = Math.abs(x - br.x);
        const bdz = Math.abs(z - br.z);
        if (bdx < 7 && bdz < hw + 18 && !inRiver) {
          const t = smoothstep(4, 7, bdx) + smoothstep(hw + 8, hw + 18, bdz);
          h = lerp(12, h, clamp(t, 0, 1));
        }
      }
      HL[k] = clamp(h, 2, WY / S - 8);
      forest[k] = fforest(x, z);
      edgeL[k] = rd - hw;
      lakeL[k] = ld;
    }
  }

  // bilinear sample of a layout field at a voxel column (voxel centres map exactly onto the layout)
  const OFF = (S - 1) / (2 * S);
  const bil = (f: Float32Array, X: number, Z: number) => {
    const lx = X / S - OFF, lz = Z / S - OFF;
    const x0 = clamp(Math.floor(lx), 0, LW - 2), z0 = clamp(Math.floor(lz), 0, LD - 2);
    const tx = clamp(lx - x0, 0, 1), tz = clamp(lz - z0, 0, 1);
    const k = x0 * LD + z0;
    return (f[k] * (1 - tx) + f[k + LD] * tx) * (1 - tz) + (f[k + 1] * (1 - tx) + f[k + LD + 1] * tx) * tz;
  };
  const Lk = (X: number, Z: number) => ((X / S) | 0) * LD + ((Z / S) | 0);

  // ================================================================ terrain at full resolution
  await progress(0.17, 'Carving the slopes');
  const N = WX * WZ;
  const Hf = new Uint8Array(N);
  const surf = new Uint8Array(N);
  const waterMask = new Uint8Array(N);
  const relief = (x: number, z: number) => sn2.noise2(x / 15, z / 15) * 0.75 + sn.noise2(x / 6, z / 6) * 0.3;
  const crag = (x: number, z: number) => sn2.ridge2(x / 10 + 3, z / 10 - 7, 2) - 0.5;
  const bridgesF = [westBridge, eastBridge];
  for (let X = 0; X < WX; X++) {
    if (X % 96 === 0) await progress(0.17 + (X / WX) * 0.05, 'Carving the slopes');
    for (let Z = 0; Z < WZ; Z++) {
      let h = bil(HL, X, Z) * S;
      const pf = bil(pathField, X, Z);
      const ed = bil(edgeL, X, Z);
      const ldv = bil(lakeL, X, Z);
      const rock = bil(rockMask, X, Z);
      const lx = X / S, lz = Z / S;
      const db = Math.min(Math.hypot(lx - blueBase.x, lz - blueBase.z), Math.hypot(lx - redBase.x, lz - redBase.z));
      // gentle fine relief on open ground; plateaus, trails, banks and ramps stay smooth
      let rough = smoothstep(1.5, 4, pf) * smoothstep(0.5, 4, ed) * smoothstep(BASE_R - 4, BASE_R + 12, db) * smoothstep(1.05, 1.3, ldv);
      for (const br of bridgesF) if (Math.abs(lx - br.x) < 12 && Math.abs(lz - br.z) < 44) rough *= smoothstep(7, 12, Math.abs(lx - br.x));
      if (rough > 0) h += rough * symF(relief, X, Z);
      if (rock > 0.02) h += rock * symF(crag, X, Z) * 5;
      Hf[X * WZ + Z] = clamp(Math.round(h), 4, WY - 20);
    }
  }

  await progress(0.22, 'Laying soil and stone');
  const flowerN = (x: number, z: number) => sn.noise2(x / 14 + 99, z / 14 - 40);
  const strataN = (x: number, z: number) => sn2.noise2(x / 40 + 7, z / 40 + 3) * 3;
  for (let X = 0; X < WX; X++) {
    for (let Z = 0; Z < WZ; Z++) {
      const k = X * WZ + Z;
      const h = Hf[k];
      const lx = X / S, lz = Z / S;
      const pf = bil(pathField, X, Z);
      const ed = bil(edgeL, X, Z);
      const ldv = bil(lakeL, X, Z);
      const rock = bil(rockMask, X, Z);
      const fo = forest[Lk(X, Z)];
      let s: number = M.GRASS;
      const nearWater = ed < 2.5 + sn.noise2(lx / 5, lz / 5) * 1.5 || ldv < 1.12;
      if (h <= WATER_VOX) s = h <= WATER_VOX - 5 ? M.GRAVEL : hash2(X >> 1, Z >> 1, 3) < 0.5 ? M.SAND : M.GRAVEL;
      else if (nearWater && h <= WATER_VOX + 3) s = sn.noise2(lx / 7, lz / 7) > 0.35 ? M.MUD : hash2(X, Z, 12) < 0.12 ? M.GRAVEL : M.SAND;
      else if (rock > 0.25) s = sn.noise2(lx / 8, lz / 8) > 0 ? M.MOSSY : M.STONE;
      else if (pf < 2.2) s = hash2(X, Z, 21) < 0.06 ? M.GRAVEL : M.PATH;
      else if (pf < 3 && hash2(X >> 1, Z >> 1, 9) < 0.5) s = M.PATH;
      else if (flowerN(lx, lz) > 0.62 && fo < 0.1) s = M.FLOWER_BED;
      // steep columns become cliff faces
      let maxN = 0;
      if (X > 0 && X < WX - 1 && Z > 0 && Z < WZ - 1) {
        maxN = Math.max(Math.abs(Hf[k + WZ] - h), Math.abs(Hf[k - WZ] - h), Math.abs(Hf[k + 1] - h), Math.abs(Hf[k - 1] - h));
      }
      const steep = maxN >= 4 && s !== M.PATH && h > WATER_VOX;
      if (steep) s = rock > 0.1 ? M.CLIFF : s;
      surf[k] = s;
      world.ground[k] = h;
      waterMask[k] = h <= WATER_VOX ? 1 : 0;
      const base = k * WY;
      vox[base] = M.BEDROCK;
      const sandy = s === M.SAND || s === M.GRAVEL;
      const rocky = s === M.STONE || s === M.MOSSY || s === M.CLIFF || steep;
      const dirtDepth = sandy ? 4 : 6;
      const so = strataN(lx, lz);
      for (let y = 1; y < h; y++) {
        let m: number;
        if (y === h - 1) m = s;
        else if (y >= h - 1 - dirtDepth && !rocky) m = s === M.SAND ? M.SAND : s === M.GRAVEL ? M.GRAVEL : M.DIRT;
        else if (y < 8) m = M.CLIFF;
        else {
          // layered rock: bands of dark cliff and grey stone show in every cut and crater
          const band = Math.floor((y + so) / 3) % 4;
          m = band === 0 ? M.CLIFF : band === 2 && rocky ? M.MOSSY : M.STONE;
          // clay pockets for nicer crater walls
          if (m === M.STONE && y > h - 14 && hash3(X >> 1, y >> 1, Z >> 1, 5) < 0.35) m = M.CLAY;
        }
        vox[base + y] = m;
      }
    }
  }

  const groundTop = (x: number, z: number) => {
    // first air above highest solid
    if (x < 0 || z < 0 || x >= WX || z >= WZ) return 0;
    const base = (x * WZ + z) * WY;
    for (let y = WY - 1; y >= 0; y--) if (vox[base + y] !== 0) return y + 1;
    return 1;
  };
  const put = (x: number, y: number, z: number, m: number) => {
    if (x < 0 || y < 0 || z < 0 || x >= WX || y >= WY || z >= WZ) return;
    vox[(x * WZ + z) * WY + y] = m;
  };
  const get = (x: number, y: number, z: number) => world.get(x, y, z);
  const putIfAir = (x: number, y: number, z: number, m: number) => {
    if (x < 0 || z < 0 || x >= WX || z >= WZ || y <= 0 || y >= WY) return;
    const i = (x * WZ + z) * WY + y;
    if (vox[i] === 0) vox[i] = m;
  };

  // smooth value noise for organic shapes (cheaper than simplex and plenty for foliage)
  const vn3 = (x: number, y: number, z: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let fx = x - xi, fy = y - yi, fz = z - zi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    fz = fz * fz * (3 - 2 * fz);
    const a = lerp(hash3(xi, yi, zi, 71), hash3(xi + 1, yi, zi, 71), fx);
    const b = lerp(hash3(xi, yi + 1, zi, 71), hash3(xi + 1, yi + 1, zi, 71), fx);
    const c = lerp(hash3(xi, yi, zi + 1, 71), hash3(xi + 1, yi, zi + 1, 71), fx);
    const d = lerp(hash3(xi, yi + 1, zi + 1, 71), hash3(xi + 1, yi + 1, zi + 1, 71), fx);
    return lerp(lerp(a, b, fy), lerp(c, d, fy), fz) * 2 - 1;
  };

  /** thick 3D line (radius in voxels, may taper from r0 to r1) */
  const line3 = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r0: number, r1: number, m: number, onlyAir = false) => {
    const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const n = Math.max(1, Math.ceil(len * 2));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const px = lerp(x0, x1, t), py = lerp(y0, y1, t), pz = lerp(z0, z1, t);
      const r = lerp(r0, r1, t);
      const ri = Math.ceil(r);
      for (let dx = -ri; dx <= ri; dx++)
        for (let dy = -ri; dy <= ri; dy++)
          for (let dz = -ri; dz <= ri; dz++) {
            const x = Math.floor(px + dx), y = Math.floor(py + dy), z = Math.floor(pz + dz);
            // at least ~0.74 voxels wide, so thin branches stay face-connected and carry their leaves
            if ((x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2 + (z + 0.5 - pz) ** 2 > Math.max(0.55, r * r)) continue;
            if (onlyAir) putIfAir(x, y, z, m);
            else put(x, y, z, m);
          }
    }
  };

  /**
   * Organic blob: an ellipsoid whose surface is pushed around by value noise. Only the shell
   * is noised, so big canopies stay cheap; `holes` frays the outer layer like real foliage.
   */
  const blob = (cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, mat: number, rough = 0.32, holes = 0, accent = 0, accentMat = 0) => {
    const g = 1 + rough;
    for (let x = Math.floor(cx - rx * g); x <= Math.ceil(cx + rx * g); x++)
      for (let z = Math.floor(cz - rz * g); z <= Math.ceil(cz + rz * g); z++)
        for (let y = Math.floor(cy - ry * g); y <= Math.ceil(cy + ry * g); y++) {
          const ex = (x + 0.5 - cx) / rx, ey = (y + 0.5 - cy) / ry, ez = (z + 0.5 - cz) / rz;
          let d = Math.sqrt(ex * ex + ey * ey + ez * ez);
          if (d > g) continue;
          if (d > 1 - rough) d += vn3(x * 0.17, y * 0.17, z * 0.17) * rough;
          if (d >= 1) continue;
          if (d > 0.78) {
            const hh = hash3(x, y, z, 31);
            if (hh < holes) continue;
            if (accent && hh > 1 - accent) {
              putIfAir(x, y, z, accentMat);
              continue;
            }
          }
          putIfAir(x, y, z, mat);
        }
  };

  /** horizontal disc (float centre) */
  const disc = (cx: number, cz: number, y: number, r: number, m: number | ((x: number, z: number, d: number) => number), onlyAir = false) => {
    const r2 = r * r;
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
      for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
        const d2 = (x + 0.5 - cx) ** 2 + (z + 0.5 - cz) ** 2;
        if (d2 > r2) continue;
        const mm = typeof m === 'number' ? m : m(x, z, Math.sqrt(d2));
        if (mm < 0) continue;
        if (onlyAir) putIfAir(x, y, z, mm);
        else put(x, y, z, mm);
      }
  };

  // ================================================================ builders
  class B {
    constructor(public ox: number, public oy: number, public oz: number, public rot: number) {}
    w(lx: number, lz: number): [number, number] {
      switch (this.rot & 3) {
        case 0: return [this.ox + lx, this.oz + lz];
        case 1: return [this.ox - lz, this.oz + lx];
        case 2: return [this.ox - lx, this.oz - lz];
        default: return [this.ox + lz, this.oz - lx];
      }
    }
    set(lx: number, ly: number, lz: number, m: number) {
      const [x, z] = this.w(lx, lz);
      put(x, this.oy + ly, z, m);
    }
    setIfAir(lx: number, ly: number, lz: number, m: number) {
      const [x, z] = this.w(lx, lz);
      putIfAir(x, this.oy + ly, z, m);
    }
    get(lx: number, ly: number, lz: number) {
      const [x, z] = this.w(lx, lz);
      return get(x, this.oy + ly, z);
    }
    box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number | ((x: number, y: number, z: number) => number)) {
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++) {
            const mm = typeof m === 'number' ? m : m(x, y, z);
            if (mm >= 0) this.set(x, y, z, mm);
          }
    }
    line(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number) {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), 1);
      for (let i = 0; i <= n; i++) this.set(Math.round(lerp(x0, x1, i / n)), Math.round(lerp(y0, y1, i / n)), Math.round(lerp(z0, z1, i / n)), m);
    }
    /** ground height (relative to oy) under a local column */
    ground(lx: number, lz: number) {
      const [x, z] = this.w(lx, lz);
      return groundTop(x, z) - this.oy;
    }
    /** fill solid from terrain up to (excluding) ly=0 and clear above, across footprint */
    foundation(x0: number, z0: number, x1: number, z1: number, mat: number, clearH: number) {
      for (let x = x0; x <= x1; x++)
        for (let z = z0; z <= z1; z++) {
          const [wx, wz] = this.w(x, z);
          for (let y = 1; y < this.oy; y++) if (get(wx, y, wz) === 0) put(wx, y, wz, mat);
          for (let y = this.oy; y < this.oy + clearH; y++) put(wx, y, wz, M.AIR);
        }
    }
  }

  /** wooden crate: dark frame on every edge, plank faces with a diagonal brace */
  const crate = (b: B, x0: number, y0: number, z0: number, sx: number, sy: number, sz: number) => {
    const x1 = x0 + sx - 1, y1 = y0 + sy - 1, z1 = z0 + sz - 1;
    b.box(x0, y0, z0, x1, y1, z1, (x, y, z) => {
      const ex = x === x0 || x === x1, ey = y === y0 || y === y1, ez = z === z0 || z === z1;
      if ((ex && ey) || (ex && ez) || (ey && ez)) return M.PLANK_DARK;
      // brace across the side faces
      if ((ez && x - x0 === y - y0) || (ex && z - z0 === y - y0)) return M.PLANK_DARK;
      return M.CRATE;
    });
  };

  /** fuel drum: red body, dark rings, a steel lid with a bung */
  const barrel = (b: B, cx: number, y0: number, cz: number) => {
    for (let y = 0; y < 5; y++)
      for (let x = -2; x <= 1; x++)
        for (let z = -2; z <= 1; z++) {
          const d = Math.hypot(x + 0.5, z + 0.5);
          if (d > 1.9) continue;
          const rim = d > 1.2;
          let m: number = M.BARREL;
          if (rim && (y === 1 || y === 3)) m = M.STEEL_DARK;
          if (y === 4) m = rim ? M.STEEL_DARK : x === 0 && z === 0 ? M.METAL : M.BARREL;
          b.set(cx + x, y0 + y, cz + z, m);
        }
  };

  /** a run of stacked sandbags with rounded ends, along local x */
  const sandbagRun = (b: B, x0: number, x1: number, z0: number, y0: number, rows: number, depth = 3) => {
    for (let r = 0; r < rows; r++) {
      const off = r % 2 === 0 ? 0 : 2;
      for (let x = x0; x <= x1; x++) {
        const p = (x - x0 + off) % 4;
        for (let d = 0; d < depth; d++) {
          // bag ends are pinched: drop the top corners of each bag
          const edgeD = d === 0 || d === depth - 1;
          if (p === 0 && edgeD && r === rows - 1) continue;
          b.set(x, y0 + r * 2, z0 + d, M.SANDBAG);
          if (!(p === 0 && edgeD)) b.set(x, y0 + r * 2 + 1, z0 + d, M.SANDBAG);
        }
      }
    }
  };

  // ================================================================ base
  const buildBase = (team: 0 | 1) => {
    const blueC: V2 = { x: blueBase.x * S, z: blueBase.z * S };
    const center = team === 0 ? blueC : mf(blueC);
    const rot = team === 0 ? 0 : 2;
    const paint = team === 0 ? M.TEAM_BLUE : M.TEAM_RED;
    const glow = team === 0 ? M.GLOW_BLUE : M.GLOW_RED;
    const blueO: V2 = { x: blueC.x - 24, z: blueC.z - 18 };
    const o = team === 0 ? blueO : mf(blueO);
    const oy = BASE_H * S;
    const b = new B(o.x, oy, o.z, rot);
    // HQ bunker 48 x 36 (9.6 x 7.2 m), front faces local -z (toward the enemy)
    b.foundation(-5, -5, 52, 40, M.CONCRETE_DARK, 30);
    b.box(-3, -2, -3, 50, -1, 38, M.CONCRETE_DARK); // slab
    // floor tiles inside
    b.box(4, -1, 4, 43, -1, 31, (x, _y, z) => ((x - 4) % 6 === 0 || (z - 4) % 6 === 0 ? M.CONCRETE_DARK : M.CONCRETE));
    for (let x = 0; x <= 47; x++)
      for (let z = 0; z <= 35; z++) {
        const wall = x <= 3 || x >= 44 || z <= 3 || z >= 32;
        if (!wall) continue;
        const outer = x === 0 || x === 47 || z === 0 || z === 35;
        const inner = !outer && (x === 3 || x === 44 || z === 3 || z === 32);
        const along = z === 0 || z === 35 ? x : z;
        const corner = (x <= 3 || x >= 44) && (z <= 3 || z >= 32);
        for (let y = 0; y < 20; y++) {
          let m: number = M.CONCRETE;
          if (y < 2) m = M.CONCRETE_DARK;
          if (outer && y >= 14 && y <= 16) m = paint;
          if (outer && y === 13) m = M.WHITE_TRIM;
          if (inner && y < 6) m = M.CONCRETE_DARK;
          if (corner) m = y >= 14 && y <= 16 && outer ? paint : M.CONCRETE_DARK;
          // recessed panel joints on the outer skin
          if (outer && !corner && along % 8 === 0 && y >= 2 && y < 13) m = M.AIR;
          if (outer && !corner && y === 7) m = M.AIR;
          b.set(x, y, z, m);
        }
      }
    // plinth course and corner buttresses
    for (let x = -1; x <= 48; x++) {
      b.set(x, 0, -1, M.CONCRETE_DARK);
      b.set(x, 0, 36, M.CONCRETE_DARK);
    }
    for (let z = -1; z <= 36; z++) {
      b.set(-1, 0, z, M.CONCRETE_DARK);
      b.set(48, 0, z, M.CONCRETE_DARK);
    }
    for (const [cx, cz] of [[-1, -1], [46, -1], [-1, 34], [46, 34]]) b.box(cx, 0, cz, cx + 2, 19, cz + 2, M.CONCRETE_DARK);

    // front blast door: steel frame, hazard lintel, the door slid open along the face
    b.box(18, 0, 0, 29, 13, 3, M.AIR);
    b.box(17, 0, 0, 17, 14, 3, M.STEEL_DARK);
    b.box(30, 0, 0, 30, 14, 3, M.STEEL_DARK);
    b.box(17, 14, 0, 30, 15, 3, M.STEEL_DARK);
    for (let x = 17; x <= 30; x++) b.set(x, 15, 0, ((x >> 1) & 1) === 0 ? M.HAZARD : M.STEEL_DARK);
    b.box(31, 0, -1, 42, 13, -1, (x, y) => ((x === 31 || x === 42 || y === 0 || y === 13) ? M.STEEL_DARK : y % 4 === 2 && x % 3 === 0 ? M.METAL : M.STEEL_DARK));
    b.box(16, 14, -1, 43, 14, -1, M.METAL);
    // back door
    b.box(20, 0, 32, 27, 11, 35, M.AIR);
    b.box(19, 0, 32, 19, 12, 35, M.STEEL_DARK);
    b.box(28, 0, 32, 28, 12, 35, M.STEEL_DARK);
    b.box(19, 12, 32, 28, 12, 35, M.STEEL_DARK);
    // firing slits with steel lips
    for (const [x0, x1] of [[5, 11], [36, 42]]) {
      b.box(x0, 9, 0, x1, 10, 3, M.AIR);
      b.box(x0 - 1, 8, -1, x1 + 1, 8, -1, M.METAL);
      b.box(x0 - 1, 11, 0, x1 + 1, 11, 0, M.STEEL_DARK);
    }
    for (const [z0, z1] of [[9, 14], [22, 27]]) {
      b.box(0, 9, z0, 3, 10, z1, M.AIR);
      b.box(44, 9, z0, 47, 10, z1, M.AIR);
      b.box(-1, 8, z0 - 1, -1, 8, z1 + 1, M.METAL);
      b.box(48, 8, z0 - 1, 48, 8, z1 + 1, M.METAL);
    }
    // roof slab, parapet with steel coping and drain gaps
    b.box(-2, 20, -2, 49, 22, 37, M.CONCRETE_DARK);
    b.box(-1, 22, -1, 48, 22, 36, M.CONCRETE);
    for (let x = -2; x <= 49; x++)
      for (let z = -2; z <= 37; z++) {
        const edge = x <= -1 || x >= 48 || z <= -1 || z >= 36;
        if (!edge) continue;
        const along = x <= -1 || x >= 48 ? z : x;
        if (along % 12 === 5) continue;
        b.set(x, 23, z, M.CONCRETE);
        b.set(x, 24, z, M.CONCRETE);
        b.set(x, 25, z, x === -2 || x === 49 || z === -2 || z === 37 ? M.METAL : M.CONCRETE_DARK);
      }
    // roof sandbag nests
    sandbagRun(b, 7, 17, 2, 23, 2);
    sandbagRun(b, 30, 40, 2, 23, 2);
    // antenna mast with cross bars and a beacon
    b.box(41, 23, 28, 41, 45, 28, M.METAL);
    b.box(39, 41, 28, 43, 41, 28, M.METAL);
    b.box(40, 36, 28, 42, 36, 28, M.METAL);
    b.box(40, 23, 27, 42, 23, 29, M.STEEL_DARK);
    b.set(41, 46, 28, glow);
    // dish on a short post
    b.box(34, 23, 28, 34, 26, 28, M.STEEL_DARK);
    b.box(32, 27, 27, 36, 30, 27, (x, y) => (Math.abs(x - 34) + Math.abs(y - 28.5) < 3.2 ? M.WHITE_TRIM : -1));
    // vents with grilles
    b.box(6, 23, 24, 12, 25, 30, (x, y, z) => (y === 25 ? (z % 2 === 0 ? M.STEEL_DARK : M.METAL) : x === 6 || x === 12 ? M.STEEL_DARK : (y + z) % 2 === 0 ? M.STEEL_DARK : M.METAL));
    b.box(16, 23, 26, 20, 24, 30, M.STEEL_DARK);
    b.box(17, 25, 27, 19, 25, 29, M.METAL);
    // door lamps
    for (const lx of [15, 32]) {
      b.set(lx, 13, -1, glow);
      b.set(lx, 14, -1, M.STEEL_DARK);
    }
    for (const lx of [17, 30]) {
      b.set(lx, 10, 36, glow);
      b.set(lx, 11, 36, M.STEEL_DARK);
    }
    // core pad: hazard frame, steel deck
    b.box(16, -1, 10, 31, -1, 25, (x, _y, z) => (((x + z) >> 1) % 2 === 0 ? M.HAZARD : M.STEEL_DARK));
    b.box(18, -1, 12, 29, -1, 23, M.STEEL_DARK);
    b.box(20, -1, 14, 27, -1, 21, M.METAL);
    // ceiling light strips
    b.box(10, 19, 9, 37, 19, 9, M.LAMP);
    b.box(10, 19, 26, 37, 19, 26, M.LAMP);
    // interior: crates, ammo racks, a terminal
    crate(b, 5, 0, 24, 6, 6, 6);
    crate(b, 5, 6, 25, 4, 4, 4);
    crate(b, 37, 0, 5, 6, 5, 6);
    crate(b, 38, 5, 6, 4, 4, 4);
    for (const z0 of [8, 16]) {
      b.box(4, 0, z0, 6, 9, z0 + 5, (x, y, z) => (y % 4 === 0 || z === z0 || z === z0 + 5 ? M.STEEL_DARK : -1));
      for (let y = 1; y <= 5; y += 4) b.box(4, y, z0 + 1, 5, y + 1, z0 + 4, (_x, _y, z) => (z % 2 === 0 ? M.HAZARD : paint));
    }
    b.box(40, 0, 18, 43, 7, 22, M.STEEL_DARK);
    b.box(40, 4, 19, 40, 6, 21, glow);

    // sandbag perimeter arcs (local coords relative to base center, front = -z)
    const cb = new B(center.x, oy, center.z, rot);
    const arc = (r: number, a0: number, a1: number, hgt: number) => {
      // every column once, so the wall sits on the ground instead of stacking on itself
      const seen = new Set<number>();
      for (let a = a0; a <= a1; a += 0.35 / r) {
        for (let t = 0; t < 3; t++) {
          const tx = Math.round(Math.sin(a) * (r + t));
          const tz = Math.round(-Math.cos(a) * (r + t));
          const [wx, wz] = cb.w(tx, tz);
          if (seen.has(wx * WZ + wz)) continue;
          seen.add(wx * WZ + wz);
          const g = world.ground[wx * WZ + wz];
          for (let y = 0; y < hgt; y++) {
            // staggered bags two voxels high; seams are pinched in on both faces and on top
            const row = y >> 1;
            const seg = (a * r) / 4 + (row % 2) * 0.5;
            const seam = Math.abs(seg - Math.round(seg)) < 0.13;
            const topOfRow = (y & 1) === 1;
            if (seam && t !== 1 && topOfRow) continue;
            if (y === hgt - 1 && t !== 1 && (seam || hash2(wx, wz, 77) < 0.25)) continue;
            put(wx, g + y, wz, M.SANDBAG);
          }
        }
      }
    };
    arc(54, -0.95, -0.38, 8);
    arc(54, 0.38, 0.95, 8);
    arc(54, -2.2, -1.35, 6);
    arc(54, 1.35, 2.2, 6);
    arc(40, -0.18, 0.18, 8); // inner front shield
    // tank traps (steel hedgehogs) in front
    const hedgehog = (lx: number, lz: number) => {
      const [wx, wz] = cb.w(lx, lz);
      const g = groundTop(wx, wz);
      const c = wx + 0.5, cy = g + 4.5, cz = wz + 0.5;
      line3(c - 4.5, cy - 4.5, cz, c + 4.5, cy + 4.5, cz, 0.75, 0.75, M.STEEL_DARK);
      line3(c - 4.5, cy + 4.5, cz, c + 4.5, cy - 4.5, cz, 0.75, 0.75, M.STEEL_DARK);
      line3(c, cy - 4.5, cz - 4.5, c, cy + 4.5, cz + 4.5, 0.75, 0.75, M.RUST);
    };
    for (const p of [[-36, -72], [-12, -76], [14, -74], [38, -70], [-60, -52], [62, -54]]) hedgehog(p[0], p[1]);

    // watchtower (back left): braced posts, plank platform, railing, pyramid roof
    const tw = new B(center.x, oy, center.z, rot);
    const tx0 = -48, tz0 = 28;
    const posts = [[0, 0], [10, 0], [0, 10], [10, 10]];
    for (const [px, pz] of posts) tw.box(tx0 + px, -2, tz0 + pz, tx0 + px + 1, 31, tz0 + pz + 1, M.PLANK_DARK);
    // X braces on all four sides
    for (const [ax, az, bx2, bz] of [[0, 0, 10, 0], [0, 10, 10, 10], [0, 0, 0, 10], [10, 0, 10, 10]]) {
      for (const [y0, y1] of [[2, 16], [16, 30]]) {
        tw.line(tx0 + ax, y0, tz0 + az, tx0 + bx2, y1, tz0 + bz, M.PLANK_DARK);
        tw.line(tx0 + bx2, y0, tz0 + bz, tx0 + ax, y1, tz0 + az, M.PLANK_DARK);
      }
    }
    tw.box(tx0 - 2, 32, tz0 - 2, tx0 + 13, 33, tz0 + 13, (x) => ((x - tx0) % 3 === 0 ? M.PLANK_DARK : M.PLANK));
    for (let i = -2; i <= 13; i++)
      for (const [x, z] of [[tx0 + i, tz0 - 2], [tx0 + i, tz0 + 13], [tx0 - 2, tz0 + i], [tx0 + 13, tz0 + i]]) {
        tw.set(x, 36, z, M.PLANK);
        if ((i + 2) % 5 === 0) for (let y = 34; y <= 35; y++) tw.set(x, y, z, M.PLANK_DARK);
        else tw.set(x, 34, z, M.PLANK_DARK);
      }
    for (const [px, pz] of [[-2, -2], [13, -2], [-2, 13], [13, 13]]) tw.box(tx0 + px, 34, tz0 + pz, tx0 + px, 43, tz0 + pz, M.PLANK_DARK);
    for (let k = 0; k < 5; k++) tw.box(tx0 - 4 + k * 2, 44 + k, tz0 - 4 + k * 2, tx0 + 15 - k * 2, 44 + k, tz0 + 15 - k * 2, k % 2 === 0 ? paint : M.PLANK_DARK);
    tw.set(tx0 + 5, 49, tz0 + 5, M.METAL);
    // ladder on the back face
    for (let y = 0; y < 32; y++) {
      tw.set(tx0 + 3, y, tz0 + 12, M.PLANK_DARK);
      tw.set(tx0 + 7, y, tz0 + 12, M.PLANK_DARK);
      if (y % 3 === 1) tw.box(tx0 + 4, y, tz0 + 12, tx0 + 6, y, tz0 + 12, M.PLANK);
    }

    // supply depot (right side): crates, fuel drums, a pallet stack under a camo net
    const sp = new B(center.x, oy, center.z, rot);
    const sx0 = 44, sz0 = 8;
    crate(sp, sx0, 0, sz0, 6, 6, 6);
    crate(sp, sx0 + 6, 0, sz0, 6, 4, 6);
    crate(sp, sx0 + 1, 6, sz0 + 1, 4, 4, 4);
    barrel(sp, sx0 + 2, 0, sz0 + 10);
    barrel(sp, sx0 + 6, 0, sz0 + 10);
    barrel(sp, sx0 + 4, 0, sz0 + 14);
    barrel(sp, sx0 + 4, 5, sz0 + 12);
    barrel(sp, sx0 + 10, 0, sz0 + 12);
    sp.box(sx0 - 2, 0, sz0 + 17, sx0 + 11, 0, sz0 + 20, (x) => (x % 3 === 2 ? -1 : M.PLANK_DARK));
    crate(sp, sx0 - 1, 1, sz0 + 17, 5, 4, 4);
    crate(sp, sx0 + 5, 1, sz0 + 17, 5, 4, 4);
    crate(sp, sx0 + 2, 5, sz0 + 17, 5, 3, 4);
    for (const [px, pz] of [[-4, -2], [16, -2], [-4, 24], [16, 24]]) sp.box(sx0 + px, 0, sz0 + pz, sx0 + px, 13, sz0 + pz, M.PLANK_DARK);
    for (let x = -5; x <= 17; x++)
      for (let z = -3; z <= 25; z++) {
        const sag = Math.round(1.6 * Math.sin(((x + 5) / 22) * Math.PI) * Math.sin(((z + 3) / 28) * Math.PI));
        if (hash2(x + sx0, z + sz0, 44) < 0.22) continue;
        const [wx, wz] = sp.w(sx0 + x, sz0 + z);
        // a canvas sheet with leafy tufts tucked into it (leaves alone can't hold the net together)
        put(wx, oy + 14 - sag, wz, M.CANVAS);
        if (hash2(x, z, 45) < 0.5) putIfAir(wx, oy + 15 - sag, wz, M.BUSH);
      }

    // tents at back: smooth canvas slopes, ridge pole, team patch, cots inside
    const tent = (lx: number, lz: number) => {
      for (let k = 0; k < 10; k++) {
        sp.box(lx - 10 + k, k, lz, lx - 9 + k, k, lz + 17, M.CANVAS);
        sp.box(lx + 9 - k, k, lz, lx + 10 - k, k, lz + 17, M.CANVAS);
        sp.box(lx - 9 + k, k, lz, lx + 9 - k, k, lz, M.CANVAS);
      }
      sp.box(lx, 10, lz - 1, lx, 10, lz + 18, M.PLANK_DARK);
      sp.box(lx - 5, 0, lz + 17, lx + 5, 6, lz + 17, (x, y) => (Math.abs(x - lx) + y < 9 ? M.AIR : -1));
      sp.box(lx - 1, 7, lz + 17, lx + 1, 8, lz + 17, paint);
      sp.box(lx - 6, 0, lz + 4, lx - 3, 1, lz + 13, (_x, y) => (y === 0 ? M.PLANK_DARK : M.CANVAS));
      sp.box(lx + 3, 0, lz + 4, lx + 6, 1, lz + 13, (_x, y) => (y === 0 ? M.PLANK_DARK : M.CANVAS));
      for (const s of [-1, 1]) sp.set(lx + s * 12, 0, lz + 2, M.PLANK_DARK);
    };
    tent(-24, 36);
    tent(24, 40);
    // flag pole with a waving team flag
    sp.box(-3, 0, -33, 3, 1, -27, M.CONCRETE_DARK);
    sp.box(0, 2, -30, 0, 38, -30, M.METAL);
    sp.set(0, 39, -30, M.WHITE_TRIM);
    for (let x = 1; x <= 11; x++)
      for (let y = 31; y <= 37; y++) {
        const wave = Math.round(Math.sin(x * 0.7) * 0.9);
        sp.set(x, y - (x > 8 ? 1 : 0), -30 + wave, y === 34 ? M.WHITE_TRIM : paint);
      }
    // lamp posts at the gate
    for (const lx of [-14, 14]) {
      sp.box(lx, 0, -44, lx, 14, -44, M.STEEL_DARK);
      sp.box(lx - 1, 15, -44, lx + 1, 15, -44, M.STEEL_DARK);
      sp.set(lx, 14, -44, M.LAMP);
    }

    // record info
    const [cwx, cwz] = b.w(24, 18);
    const [fwx, fwz] = cb.w(0, -30);
    const toM = (wx: number, wz: number): V2 => ({ x: (wx + 0.5) * VOXEL, z: (wz + 0.5) * VOXEL });
    return {
      core: toM(cwx, cwz),
      coreY: oy * VOXEL,
      flag: { x: (fwx + 0.5) * VOXEL, y: (oy + 2) * VOXEL, z: (fwz + 0.5) * VOXEL },
      spawns: [-18, -8, 0, 8, 18].map((lx, i) => {
        const [wx, wz] = cb.w(lx, 48 + (i % 2) * 6);
        return toM(wx, wz);
      }),
      defend: [
        [-32, -48], [32, -48], [0, -34], [-48, -12], [48, -12], [-20, -24], [20, -24], [-40, 12], [40, 16],
      ].map(([lx, lz]) => {
        const [wx, wz] = cb.w(lx, lz);
        return toM(wx, wz);
      }),
      supply: (() => {
        const [wx, wz] = cb.w(sx0 + 4, sz0 + 24);
        return toM(wx, wz);
      })(),
    };
  };

  // ================================================================ bridges
  const bridgeHW = Math.ceil(riverHW(Math.round(westBridge.x)) * S) + 12;
  const buildBridge = (b: B) => {
    const deck = 23; // walking surface at 4.8 m
    for (let z = -bridgeHW; z <= bridgeHW; z++) {
      const ends = Math.abs(z) > bridgeHW - 14;
      for (let x = -9; x <= 9; x++) for (let y = deck + 1; y < deck + 14; y++) b.set(x, y, z, M.AIR);
      // deck boards with darker seams, joists beneath
      for (let x = -7; x <= 7; x++) {
        b.set(x, deck, z, z % 3 === 0 ? M.PLANK_DARK : hash2(x >> 2, z, 61) < 0.15 ? M.LOG_END : M.PLANK);
        if (x === -6 || x === 0 || x === 6) b.set(x, deck - 1, z, M.PLANK_DARK);
      }
      // fascia beams
      for (const x of [-8, 8]) {
        b.set(x, deck, z, M.PLANK_DARK);
        b.set(x, deck - 1, z, M.PLANK_DARK);
      }
      // railing: posts, mid rail, top rail
      for (const x of [-8, 8]) {
        b.set(x, deck + 5, z, M.PLANK);
        b.set(x, deck + 3, z, M.PLANK_DARK);
        if (z % 6 === 0) for (let y = deck + 1; y <= deck + 4; y++) b.set(x, y, z, M.PLANK_DARK);
      }
      // pillars down to the bed with cross bracing
      if (z % 12 === 0) {
        b.box(-7, deck - 2, z, 7, deck - 2, z, M.PLANK_DARK);
        for (const x of [-8, 8]) for (let y = 1; y < deck - 1; y++) if (b.get(x, y - b.oy, z) === 0) b.set(x, y - b.oy, z, M.LOG_END);
        const gl = b.ground(-8, z), gr = b.ground(8, z);
        const low = Math.max(gl, gr) + b.oy;
        if (deck - 3 - low > 4) {
          b.line(-7, low - b.oy + 1, z, 7, deck - 3 - b.oy, z, M.PLANK_DARK);
          b.line(7, low - b.oy + 1, z, -7, deck - 3 - b.oy, z, M.PLANK_DARK);
        }
      }
      // solid ramps where the bank comes up to the deck
      if (ends)
        for (let x = -8; x <= 8; x++) {
          const g = b.ground(x, z) + b.oy;
          if (g >= deck - 5) for (let y = g; y < deck; y++) if (b.get(x, y - b.oy, z) === 0) b.set(x, y - b.oy, z, M.DIRT);
        }
    }
  };

  // ================================================================ cabin
  const buildCabin = (o: V2, rot: number, roof: number) => {
    // floor level: highest ground over the footprint
    let fy = 0;
    const probe = new B(o.x, 0, o.z, rot);
    for (let x = -2; x <= 33; x++)
      for (let z = -2; z <= 25; z++) {
        const [wx, wz] = probe.w(x, z);
        fy = Math.max(fy, groundTop(wx, wz));
      }
    const b = new B(o.x, fy, o.z, rot);
    b.foundation(-4, -10, 35, 27, M.STONE, 40);
    // stone footing and floorboards
    b.box(-2, -2, -2, 33, -1, 25, (x, y, z) => {
      const rim = x <= -1 || x >= 32 || z <= -1 || z >= 24;
      if (rim) return ((x + z + y) & 3) === 0 ? M.MOSSY : M.STONE;
      return y === -1 ? (x % 4 === 0 ? M.PLANK_DARK : M.PLANK) : M.STONE;
    });
    // log walls: alternate courses run long at the corners so the ends interlock
    for (let y = 0; y < 14; y++) {
      const log = y >> 1;
      const lower = (y & 1) === 0;
      const alongX = log % 2 === 0;
      for (let x = -2; x <= 33; x++)
        for (let z = -2; z <= 25; z++) {
          const front = z === 0 || z === 1, back = z === 22 || z === 23;
          const left = x === 0 || x === 1, right = x === 30 || x === 31;
          let on = false, end = false;
          if (front || back) {
            if (alongX) on = x >= -2 && x <= 33;
            else on = x >= 2 && x <= 29;
            end = x < 0 || x > 31;
          }
          if (left || right) {
            if (!alongX) on = on || (z >= -2 && z <= 25);
            else on = on || (z >= 2 && z <= 21);
            end = end || z < 0 || z > 23;
          }
          if (!on) continue;
          const outerFace = z === 0 || z === 23 || x === 0 || x === 31;
          // chinked lower row: recessed outside so each log reads round
          if (lower && y > 0 && outerFace && !end) {
            b.set(x, y, z, M.AIR);
            continue;
          }
          b.set(x, y, z, end ? M.LOG_END : lower ? M.PLANK_DARK : M.OAK_BARK);
        }
    }
    // door with trim, leaf swung open inside
    b.box(13, 0, 0, 17, 10, 1, M.AIR);
    b.box(12, 0, 0, 12, 11, 0, M.PLANK);
    b.box(18, 0, 0, 18, 11, 0, M.PLANK);
    b.box(12, 11, 0, 18, 11, 0, M.PLANK);
    b.box(19, 0, 2, 23, 10, 2, (x, y) => (y === 5 || x === 19 ? M.PLANK_DARK : M.PLANK));
    // windows: trimmed frames, cross mullions, sills and shutters
    const window = (wx: number, wz: number, face: 'z0' | 'z1' | 'x0' | 'x1') => {
      for (let u = -3; u <= 3; u++)
        for (let v = 3; v <= 9; v++) {
          const frame = Math.abs(u) === 3 || v === 3 || v === 9;
          const mull = u === 0 || v === 6;
          const m = frame ? M.WHITE_TRIM : mull ? M.WHITE_TRIM : M.AIR;
          for (let d = 0; d < 2; d++) {
            if (face === 'z0') b.set(wx + u, v, d, d === 1 && !frame && mull ? M.AIR : m);
            if (face === 'z1') b.set(wx + u, v, 23 - d, d === 1 && !frame && mull ? M.AIR : m);
            if (face === 'x0') b.set(d, v, wz + u, d === 1 && !frame && mull ? M.AIR : m);
            if (face === 'x1') b.set(31 - d, v, wz + u, d === 1 && !frame && mull ? M.AIR : m);
          }
        }
      // sill and shutters
      for (let u = -4; u <= 4; u++) {
        if (face === 'z0') b.set(wx + u, 2, -1, M.WHITE_TRIM);
        if (face === 'z1') b.set(wx + u, 2, 24, M.WHITE_TRIM);
      }
      for (const s of [-1, 1])
        for (let v = 3; v <= 9; v++)
          for (let u = 4; u <= 6; u++) {
            const m = v === 6 ? M.PLANK : M.PLANK_DARK;
            if (face === 'z0') b.set(wx + s * u, v, -1, m);
            if (face === 'z1') b.set(wx + s * u, v, 24, m);
          }
    };
    window(6, 0, 'z0');
    window(25, 0, 'z0');
    window(6, 0, 'z1');
    window(25, 0, 'z1');
    window(0, 11, 'x0');
    window(0, 12, 'x1');
    // gable roof along x: 1:1 slope, deep overhangs, fascia boards and a ridge cap
    for (let k = 0; k <= 13; k++) {
      const y = 14 + k;
      const zs = k - 3, zn = 26 - k;
      if (zs + 1 > zn - 1) break;
      const m = k === 0 ? M.PLANK_DARK : roof;
      for (let x = -3; x <= 34; x++) {
        const edge = x === -3 || x === 34;
        b.set(x, y, zs, edge ? M.PLANK_DARK : m);
        b.set(x, y, zs + 1, edge ? M.PLANK_DARK : m);
        b.set(x, y, zn, edge ? M.PLANK_DARK : m);
        b.set(x, y, zn - 1, edge ? M.PLANK_DARK : m);
      }
      // gable walls: vertical boards
      for (let z = zs + 2; z <= zn - 2; z++) {
        const board = z % 3 === 0 ? M.PLANK_DARK : M.PLANK;
        b.set(0, y, z, board);
        b.set(1, y, z, board);
        b.set(30, y, z, board);
        b.set(31, y, z, board);
      }
    }
    b.box(-3, 26, 11, 34, 26, 12, M.PLANK_DARK);
    // round attic vents in the gables
    for (const x of [0, 1, 30, 31]) b.box(x, 18, 10, x, 20, 13, (_x, y, z) => (Math.abs(z - 11.5) + Math.abs(y - 19) < 2.2 ? M.AIR : -1));
    // chimney: brick courses with mortar, stone cap
    b.box(24, -1, 16, 27, 31, 19, (x, y, z) => {
      const course = Math.floor(y / 3);
      if (((y % 3) + 3) % 3 === 2) return M.MORTAR;
      const u = x === 24 || x === 27 ? z : x;
      return (u + course * 2) % 4 === 0 ? M.MORTAR : M.BRICK;
    });
    b.box(23, 32, 15, 28, 32, 20, M.STONE);
    b.box(25, 29, 17, 26, 32, 18, M.AIR);
    // fireplace with embers
    b.box(22, 0, 14, 29, 5, 15, (x, y) => (x >= 24 && x <= 27 && y <= 3 ? M.AIR : y === 5 ? M.PLANK_DARK : M.STONE));
    b.box(25, 0, 16, 26, 2, 17, M.AIR);
    b.box(25, 0, 16, 26, 0, 16, M.LAMP);
    // furniture: table, benches, bed, crate, lantern
    b.box(6, 4, 10, 12, 4, 14, M.PLANK);
    for (const [x, z] of [[6, 10], [12, 10], [6, 14], [12, 14]]) b.box(x, 0, z, x, 3, z, M.PLANK_DARK);
    b.box(6, 2, 8, 12, 2, 8, M.PLANK_DARK);
    b.box(6, 2, 16, 12, 2, 16, M.PLANK_DARK);
    b.box(3, 0, 16, 8, 1, 21, (_x, y) => (y === 0 ? M.PLANK_DARK : M.CANVAS));
    b.box(3, 2, 20, 8, 2, 21, M.WHITE_TRIM);
    crate(b, 20, 0, 4, 4, 4, 4);
    b.set(9, 5, 12, M.LAMP);
    // porch deck, posts, lean-to roof, door lantern
    b.box(8, -1, -9, 22, -1, -1, (_x, _y, z) => (z % 2 === 0 ? M.PLANK_DARK : M.PLANK));
    for (const x of [8, 22]) b.box(x, 0, -9, x, 11, -9, M.PLANK_DARK);
    for (let z = -10; z <= -1; z++) {
      const y = 13 - Math.floor((-z - 1) / 3);
      b.box(6, y, z, 24, y, z, z === -10 ? M.PLANK_DARK : roof);
    }
    b.set(20, 9, -1, M.LAMP);
    b.set(20, 10, -1, M.STEEL_DARK);
    // fenced yard with a gate gap toward the trail
    const fenceSeen = new Set<number>();
    const fence = (x0: number, z0: number, x1: number, z1: number, gap: [number, number] | null) => {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
      for (let i = 0; i <= n; i++) {
        const x = x0 + Math.sign(x1 - x0) * i, z = z0 + Math.sign(z1 - z0) * i;
        if (gap && i >= gap[0] && i <= gap[1]) continue;
        const [wx, wz] = b.w(x, z);
        if (fenceSeen.has(wx * WZ + wz)) continue; // shared corner posts
        fenceSeen.add(wx * WZ + wz);
        const g = groundTop(wx, wz);
        if (i % 6 === 0) for (let y = 0; y < 6; y++) put(wx, g + y, wz, M.PLANK_DARK);
        put(wx, g + 2, wz, M.PLANK);
        put(wx, g + 4, wz, M.PLANK);
      }
    };
    fence(-12, -24, 43, -24, [20, 31]);
    fence(-12, 36, 43, 36, null);
    fence(-12, -24, -12, 36, null);
    fence(43, -24, 43, 36, [36, 44]);
    // round hay bales
    const bale = (lx: number, lz: number) => {
      const [wx, wz] = b.w(lx, lz);
      const g = groundTop(wx, wz);
      for (let i = 0; i < 5; i++)
        for (let y = 0; y < 6; y++)
          for (let j = -3; j <= 2; j++) if (Math.hypot(y + 0.5 - 3, j + 0.5) < 3.1) put(wx + i, g + y, wz + j, M.HAY);
    };
    bale(-8, -16);
    bale(-8, -9);
    bale(36, 30);
    bale(30, 30);
    // flower beds with mud furrows
    for (let x = 0; x <= 31; x++)
      for (let z = -18; z <= -12; z++) {
        const [wx, wz] = b.w(x, z);
        const g = groundTop(wx, wz) - 1;
        if (get(wx, g, wz) === M.GRASS || get(wx, g, wz) === M.PATH) put(wx, g, wz, x % 8 === 7 ? M.MUD : M.FLOWER_BED);
      }
    // woodpile: a pyramid of split logs under the eaves
    for (let row = 0; row < 3; row++)
      for (let i = 0; i < 3 - row; i++) {
        const ly = row * 2, lz0 = 6 + i * 2 + row;
        for (let z = 0; z < 2; z++)
          for (let y = 0; y < 2; y++)
            for (let x = 34; x <= 41; x++) {
              const [wx, wz] = b.w(x, lz0 + z);
              put(wx, b.oy + ly + y, wz, x === 34 || x === 41 ? M.LOG_END : M.OAK_BARK);
            }
      }
    // stone well
    const [wx0, wz0] = b.w(-6, 4);
    const wg = groundTop(wx0, wz0);
    for (let x = -3; x <= 3; x++)
      for (let z = -3; z <= 3; z++) {
        const d = Math.hypot(x, z);
        if (d > 3.4) continue;
        if (d > 2.1) for (let y = 0; y < 4; y++) put(wx0 + x, wg + y, wz0 + z, (x + z + y) % 3 === 0 ? M.MOSSY : M.STONE);
        else for (let y = -3; y < 4; y++) put(wx0 + x, wg + y, wz0 + z, y < -1 ? M.MUD : M.AIR);
      }
    for (const s of [-3, 3]) for (let y = 4; y < 10; y++) put(wx0 + s, wg + y, wz0, M.PLANK_DARK);
    for (let x = -4; x <= 4; x++) {
      put(wx0 + x, wg + 10, wz0, M.PLANK_DARK);
      put(wx0 + x, wg + 10, wz0 - 1, roof);
      put(wx0 + x, wg + 10, wz0 + 1, roof);
      put(wx0 + x, wg + 9, wz0 - 2, roof);
      put(wx0 + x, wg + 9, wz0 + 2, roof);
    }
  };

  // ================================================================ ruin
  const buildRuin = (o: V2, rot: number) => {
    const probe = new B(o.x, 0, o.z, rot);
    let fy = 999;
    for (let x = 0; x < 28; x++)
      for (let z = 0; z < 20; z++) {
        const [wx, wz] = probe.w(x, z);
        fy = Math.min(fy, groundTop(wx, wz));
      }
    const b = new B(o.x, fy, o.z, rot);
    // flagstone floor
    for (let x = 0; x < 28; x++)
      for (let z = 0; z < 20; z++) {
        const [wx, wz] = b.w(x, z);
        for (let y = -2; y < 2; y++) if (get(wx, fy + y - 1, wz) === 0) put(wx, fy + y - 1, wz, M.STONE);
        if (hash2(x >> 2, z >> 2, 7) < 0.3) put(wx, fy - 1, wz, M.MOSSY);
      }
    // walls of staggered stone blocks, broken off at uneven heights
    for (let x = 0; x < 28; x++)
      for (let z = 0; z < 20; z++) {
        const edge = x <= 1 || x >= 26 || z <= 1 || z >= 18;
        if (!edge) continue;
        const [wx, wz] = b.w(x, z);
        const u = x <= 1 || x >= 26 ? z : x;
        const hgt = Math.floor(6 + 12 * Math.max(0, sn.noise2(x / 8 + o.x, z / 8 + o.z) + 0.4));
        for (let y = 0; y < hgt; y++) {
          const row = y >> 1;
          const block = Math.floor((u + (row % 2) * 2) / 4);
          const bh = hash3(block, row, x <= 1 || x >= 26 ? x : z, 3 + (wx & 0));
          if (bh < 0.06 && y > 4) continue;
          // the topmost course crumbles block by block
          if (y >= hgt - 2 && bh < 0.45) continue;
          b.set(x, y, z, bh < 0.3 ? M.MOSSY : bh < 0.38 ? M.CLIFF : y === 0 ? M.CLIFF : M.STONE);
        }
      }
    // arched door and window
    const arch = (x0: number, w: number, y0: number, h: number, setFn: (u: number, y: number) => void) => {
      const r = w / 2;
      for (let u = 0; u < w; u++)
        for (let y = y0; y < y0 + h + r; y++) {
          const du = u + 0.5 - r;
          if (y < y0 + h || Math.hypot(du, y - (y0 + h)) < r) setFn(x0 + u, y);
        }
    };
    arch(10, 6, 0, 8, (u, y) => {
      b.set(u, y, 0, M.AIR);
      b.set(u, y, 1, M.AIR);
    });
    arch(8, 4, 4, 4, (u, y) => {
      b.set(26, y, u, M.AIR);
      b.set(27, y, u, M.AIR);
    });
    arch(14, 4, 5, 3, (u, y) => {
      b.set(u, y, 18, M.AIR);
      b.set(u, y, 19, M.AIR);
    });
    // fallen column drum, rubble and ferns
    const [cx0, cz0] = b.w(8, 10);
    for (let i = 0; i < 9; i++)
      for (let y = 0; y < 4; y++)
        for (let z = -2; z <= 1; z++) if (Math.hypot(y + 0.5 - 2, z + 0.5) < 2.1) put(cx0 + i, fy + y, cz0 + z, i === 0 || i === 8 ? M.CLIFF : M.STONE);
    for (let i = 0; i < 26; i++) {
      const rx = -4 + Math.floor(hash2(i, o.x, 4) * 36);
      const rz = -6 + Math.floor(hash2(i, o.z, 5) * 32);
      const [wx, wz] = b.w(rx, rz);
      const g = groundTop(wx, wz);
      const m = hash2(i, 3) < 0.5 ? M.MOSSY : M.STONE;
      const big = hash2(i, 9) < 0.4;
      put(wx, g, wz, m);
      put(wx + 1, g, wz, m);
      if (big) {
        put(wx, g, wz + 1, m);
        put(wx + 1, g, wz + 1, m);
        put(wx, g + 1, wz, m);
      }
    }
  };

  // ================================================================ island tower
  const buildTower = () => {
    const cxF = WX / 2, czF = WZ / 2; // map centre in voxel-edge coordinates
    const ix = cxF - 0.5, iz = czF - 0.5;
    const g = Math.max(groundTop(Math.floor(ix), Math.floor(iz)), groundTop(Math.ceil(ix), Math.ceil(iz)));
    const R0 = 7.4, R1 = 11.4;
    for (let x = Math.floor(cxF - 13); x <= Math.ceil(cxF + 13); x++)
      for (let z = Math.floor(czF - 13); z <= Math.ceil(czF + 13); z++) {
        const dx = x + 0.5 - cxF, dz = z + 0.5 - czF;
        const r = Math.hypot(dx, dz);
        if (r > R1) continue;
        const wall = r > R0;
        const ang = Math.atan2(dz, dx);
        // symmetric under the half turn so both teams see the same silhouette
        const hgt = 44 + Math.floor((sn.noise2(Math.cos(ang * 2) * 1.3, Math.sin(ang * 2) * 1.3 + 4) + 0.2) * 14);
        const seg = Math.floor(((ang + Math.PI) / (Math.PI * 2)) * 48);
        const merlon = seg % 2 === 0 ? 2 : 0;
        const top = wall ? hgt + (r > R1 - 2 ? merlon : 0) : 0;
        for (let y = g - 4; y < g + top; y++) {
          const row = (y - g) >> 1;
          const block = Math.floor(seg / 2 + (row % 2) * 0.5);
          const bh = hash3(block, row, 7, 12);
          if (wall && y > g + 4 && bh < 0.03) continue;
          const mossy = bh < 0.32 * (1 - smoothstep(0, 40, y - g)) + 0.08;
          put(x, y, z, mossy ? M.MOSSY : bh > 0.9 ? M.CLIFF : M.STONE);
        }
        if (!wall) put(x, g - 1, z, ((Math.floor(dx + 20) >> 1) & 1) === 0 ? M.PLANK_DARK : M.PLANK);
        // ivy streaks down the outer face
        if (wall && r > R1 - 1 && hash2(seg, 3, 5) < 0.3) {
          const len = 6 + Math.floor(hash2(seg, 4, 5) * 20);
          for (let y = g + hgt - 8 - len; y < g + hgt - 8; y++) {
            const ox = Math.round(dx / r), oz = Math.round(dz / r);
            if (hash3(x, y, z, 8) < 0.7) putIfAir(x + ox, y, z + oz, M.BUSH);
          }
        }
      }
    // arched doors north and south
    for (const s of [-1, 1])
      for (let x = -3; x <= 2; x++)
        for (let y = 0; y < 13; y++) {
          const du = x + 0.5;
          if (y >= 10 && Math.hypot(du, y - 10) > 3) continue;
          for (let d = 6; d <= 13; d++) put(Math.floor(cxF + x), g + y, Math.floor(czF - 0.5 + s * (d + 0.5)), M.AIR);
        }
    // arrow slits
    for (const a of [0.8, 2.4, 4.0, 5.6, 0.8 + Math.PI, 2.4 + Math.PI])
      for (let y = 20; y < 27; y++)
        for (let d = 6; d <= 12; d++) {
          const x = Math.floor(cxF + Math.cos(a) * (d + 0.5)), z = Math.floor(czF + Math.sin(a) * (d + 0.5));
          put(x, g + y, z, M.AIR);
          put(x, g + y + (y === 26 ? 1 : 0), z, M.AIR);
        }
  };

  // ================================================================ docks + boats
  const buildDock = (b: B) => {
    // walk toward the lake (local -z) until water
    let z = 0;
    let guard = 0;
    while (b.ground(0, z) + b.oy > WATER_VOX + 2 && guard++ < 80) z--;
    const zEnd = z - 18;
    for (let zz = z + 6; zz >= zEnd; zz--) {
      for (let x = -5; x <= 5; x++) {
        b.set(x, 23, zz, zz % 3 === 0 ? M.PLANK_DARK : M.PLANK);
        b.set(x, 22, zz, x === -5 || x === 5 || x === 0 ? M.PLANK_DARK : M.AIR);
        for (let y = 24; y < 30; y++) b.set(x, y, zz, M.AIR);
      }
      if ((zz - z) % 6 === 0)
        for (const px of [-5, 5]) for (let y = 1; y < 22; y++) if (b.get(px, y, zz) === 0) b.set(px, y, zz, M.LOG_END);
    }
    for (const px of [-5, 5]) b.box(px, 24, zEnd, px, 25, zEnd, M.LOG_END);
    // rowboat moored beside the dock
    const bx = 11, bz = zEnd + 8;
    for (let i = -9; i <= 9; i++) {
      const hw = 4.6 * Math.sqrt(Math.max(0, 1 - (i / 9.6) ** 2));
      for (let j = -5; j <= 5; j++) {
        const d = Math.abs(j + 0.5 * Math.sign(j)) - 0.5;
        if (d > hw) continue;
        const side = d > hw - 1.2;
        b.set(bx + j, 20, bz + i, M.BOAT);
        b.set(bx + j, 21, bz + i, side ? M.BOAT : M.AIR);
        if (side) b.set(bx + j, 22, bz + i, M.PLANK_DARK);
      }
    }
    for (const i of [-4, 3]) b.box(bx - 3, 21, bz + i, bx + 3, 21, bz + i, M.PLANK);
    b.line(bx - 2, 22, bz - 6, bx + 3, 22, bz + 6, M.PLANK_DARK);
    // mooring line post
    b.box(6, 24, bz, 6, 25, bz, M.LOG_END);
  };

  await progress(0.3, 'Raising the bases');
  const baseBlue = buildBase(0);
  const baseRed = buildBase(1);
  const wbF: V2 = { x: Math.round(westBridge.x * S), z: Math.round(westBridge.z * S) };
  const ebF = mf(wbF);
  buildBridge(new B(wbF.x, 0, wbF.z, 0));
  buildBridge(new B(ebF.x, 0, ebF.z, 2));
  await progress(0.34, 'Building cabins and ruins');
  const cabinF: V2 = { x: cabinBlue.x * S, z: cabinBlue.z * S };
  buildCabin(cabinF, 0, M.ROOF_RED);
  buildCabin(mf(cabinF), 2, M.ROOF_SLATE);
  const ruinF: V2 = { x: ruinBlue.x * S, z: ruinBlue.z * S };
  buildRuin(ruinF, 1);
  buildRuin(mf(ruinF), 3);
  buildTower();
  const dockF: V2 = { x: Math.round(C * S) + 28, z: Math.round(C * S) + 52 };
  buildDock(new B(dockF.x, 0, dockF.z, 0));
  buildDock(new B(WX - 1 - dockF.x, 0, WZ - 1 - dockF.z, 2));

  // keep-out mask for vegetation (layout units)
  const keepOut = (X: number, Z: number) => {
    const x = X / S, z = Z / S;
    if (pathField[Lk(X, Z)] < 4) return true;
    if (Math.hypot(x - blueBase.x, z - blueBase.z) < BASE_R + 4) return true;
    if (Math.hypot(x - redBase.x, z - redBase.z) < BASE_R + 4) return true;
    for (const c of [cabinBlue, mirror(cabinBlue)]) if (Math.hypot(x - c.x, z - c.z) < 30) return true;
    for (const c of [ruinBlue, mirror(ruinBlue)]) if (Math.hypot(x - c.x, z - c.z) < 16) return true;
    for (const br of [westBridge, eastBridge]) if (Math.abs(x - br.x) < 10 && Math.abs(z - br.z) < 30) return true;
    return false;
  };

  // ================================================================ vegetation
  await progress(0.38, 'Growing the forest');

  /** round trunk tapering from r0 to r1, with a root flare and a few surface roots */
  const trunk = (cx: number, cz: number, y0: number, h: number, r0: number, r1: number, mat: number, roots = 0) => {
    for (let y = y0 - 2; y < y0 + h; y++) {
      const t = clamp((y - y0) / h, 0, 1);
      const flare = y - y0 < 4 ? (4 - Math.max(0, y - y0)) * 0.28 * r0 : 0;
      disc(cx, cz, y, lerp(r0, r1, t) + flare, mat);
    }
    for (let i = 0; i < roots; i++) {
      const a = (i / roots) * Math.PI * 2 + hash2(cx, cz, 2) * 6;
      const len = r0 + 3 + hash2(i, cx, 3) * 3;
      line3(cx, y0 + 0.6, cz, cx + Math.cos(a) * len, y0 - 0.4, cz + Math.sin(a) * len, 0.9, 0.5, mat, true);
    }
  };

  const pine = (x: number, y0: number, z: number, r: () => number) => {
    const h = 34 + Math.floor(r() * 18);
    const thick = h > 44;
    const cx = x + 0.5, cz = z + 0.5;
    trunk(cx, cz, y0, h - 4, thick ? 1.9 : 1.4, 0.7, M.PINE_BARK, thick ? 4 : 0);
    const cs = y0 + 8 + Math.floor(r() * 6);
    const top = y0 + h + 4;
    const maxR = 9 + r() * 4 + (thick ? 2 : 0);
    const tierH = 6 + Math.floor(r() * 2);
    for (let y = cs; y <= top; y++) {
      const t = (y - cs) / (top - cs);
      const tier = ((y - cs) % tierH) / (tierH - 1);
      // each tier flares wide at its base and draws in toward the next
      const rr = Math.max(0.7, (1 - t) * maxR * (0.5 + 0.5 * (1 - tier)) + (t > 0.93 ? 0 : 0.4));
      const ri = Math.ceil(rr) + 1;
      for (let dx = -ri; dx <= ri; dx++)
        for (let dz = -ri; dz <= ri; dz++) {
          const d = Math.hypot(dx, dz);
          if (d > rr + 0.4) continue;
          const wx = x + dx, wz = z + dz;
          if (d > rr - 1.2 && hash3(wx, y, wz, 21) < 0.38) continue;
          putIfAir(wx, y, wz, M.PINE_LEAF);
          // the rim of each tier droops a voxel
          if (tier < 0.2 && d > rr - 1.6 && d > 2) putIfAir(wx, y - 1, wz, M.PINE_LEAF);
        }
    }
  };

  const oak = (x: number, y0: number, z: number, r: () => number, leaf: number) => {
    const h = 15 + Math.floor(r() * 8);
    const cx = x + 0.5, cz = z + 0.5;
    trunk(cx, cz, y0, h + 2, 2.3, 1.6, M.OAK_BARK, 5);
    const top = y0 + h;
    blob(cx, top + 5, cz, 10 + r() * 2, 7 + r() * 1.5, 10 + r() * 2, leaf, 0.34, 0.3);
    const n = 4 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r() * 0.8;
      const d = 7 + r() * 5;
      const bx = cx + Math.cos(a) * d, bz = cz + Math.sin(a) * d;
      const by = top - 1 + r() * 6;
      const sy = top - 5 + r() * 3;
      line3(cx, sy, cz, bx, by, bz, 1.3, 0.7, M.OAK_BARK);
      blob(bx, by + 3, bz, 6 + r() * 3, 4.5 + r() * 2, 6 + r() * 3, leaf, 0.36, 0.32);
    }
  };

  const birch = (x: number, y0: number, z: number, r: () => number) => {
    const h = 26 + Math.floor(r() * 10);
    const cx = x + 0.5, cz = z + 0.5;
    for (let y = y0 - 2; y < y0 + h; y++) {
      const rr = y - y0 < h * 0.55 ? 1.1 : 0.6;
      disc(cx, cz, y, rr, (wx, wz) => (hash3(wx, y >> 1, wz, 6) < 0.16 || hash2(y, wx + wz, 5) < 0.05 ? M.PINE_BARK : M.BIRCH_BARK));
    }
    const side = r() < 0.5 ? 1 : -1;
    line3(cx, y0 + h * 0.6, cz, cx + side * 4, y0 + h * 0.85, cz - 2, 0.6, 0.4, M.BIRCH_BARK);
    blob(cx, y0 + h - 2, cz, 6, 9.5, 6, M.BIRCH_LEAF, 0.42, 0.38);
    blob(cx + side * 3.5, y0 + h - 8, cz - 2, 4.5, 4.5, 4.5, M.BIRCH_LEAF, 0.42, 0.38);
  };

  const bush = (x: number, y0: number, z: number, r: () => number) => {
    const berries = r() < 0.22;
    blob(x + 0.5, y0 + 1.5, z + 0.5, 3.5 + r() * 3, 2.8 + r() * 1.8, 3.5 + r() * 3, M.BUSH, 0.45, 0.22, berries ? 0.05 : 0, M.RED_LEAF);
  };

  const fern = (x: number, y0: number, z: number) => {
    const n = 4 + Math.floor(hash2(x, z, 81) * 3);
    putIfAir(x, y0, z, M.FERN);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + hash2(x, z, 82) * 3;
      const len = 2.5 + hash2(i, x + z, 83) * 2;
      for (let s = 1; s <= len; s++) {
        const y = y0 + (s < len * 0.6 ? 1 : 0) + (s === 1 ? 0 : 0);
        putIfAir(Math.round(x + Math.cos(a) * s), y, Math.round(z + Math.sin(a) * s), M.FERN);
      }
    }
  };

  const log = (x: number, y0: number, z: number, r: () => number) => {
    const len = 14 + Math.floor(r() * 16);
    const alongX = r() < 0.5;
    const rad = 2 + r() * 0.7;
    for (let i = 0; i < len; i++) {
      const end = i === 0 || i === len - 1;
      for (let a = -3; a <= 3; a++)
        for (let y = 0; y < 6; y++) {
          const d = Math.hypot(a + 0.5 - 0.5, y + 0.5 - rad);
          if (d > rad) continue;
          const wx = alongX ? x + i : x + a;
          const wz = alongX ? z + a : z + i;
          const m = end ? (d > rad - 0.9 ? M.OAK_BARK : M.LOG_END) : M.OAK_BARK;
          put(wx, y0 + y, wz, m);
        }
      // moss and the odd fern on top
      if (!end && hash2(i, x + z, 3) < 0.45) {
        const wx = alongX ? x + i : x, wz = alongX ? z : z + i;
        putIfAir(wx, y0 + Math.ceil(rad * 2) , wz, M.MOSS);
      }
    }
    // bank soil up under it where the slope falls away, so it lies on the ground along its length
    for (let i = 0; i < len; i++)
      for (let a = -3; a <= 3; a++) {
        const wx = alongX ? x + i : x + a, wz = alongX ? z + a : z + i;
        if (wx < 0 || wz < 0 || wx >= WX || wz >= WZ) continue;
        const base = (wx * WZ + wz) * WY;
        const gr = world.ground[wx * WZ + wz];
        let low = -1;
        for (let y = gr; y < y0 + 6 && y < WY; y++) if (vox[base + y] === M.OAK_BARK || vox[base + y] === M.LOG_END) { low = y; break; }
        if (low < 0 || low - gr > 8) continue;
        for (let y = gr; y < low; y++) if (vox[base + y] === 0) vox[base + y] = M.DIRT;
      }
    // a broken branch stub
    const si = 3 + Math.floor(r() * (len - 6));
    const sx = alongX ? x + si : x, sz = alongX ? z : z + si;
    line3(sx + 0.5, y0 + rad * 2, sz + 0.5, sx + 0.5 + (alongX ? 0 : 2), y0 + rad * 2 + 3, sz + 0.5 + (alongX ? 2 : 0), 0.6, 0.5, M.OAK_BARK, true);
  };

  const boulder = (x: number, y0: number, z: number, r: () => number) => {
    const s = 3.5 + r() * 6;
    const cx = x + 0.5, cy = y0 + s * 0.25, cz = z + 0.5;
    const rx = s * (1 + r() * 0.5), ry = s * 0.75, rz = s * (1 + r() * 0.5);
    const mossy = r() < 0.6;
    const g = 1.3;
    for (let bx = Math.floor(cx - rx * g); bx <= Math.ceil(cx + rx * g); bx++)
      for (let bz = Math.floor(cz - rz * g); bz <= Math.ceil(cz + rz * g); bz++)
        for (let by = Math.floor(cy - ry * g); by <= Math.ceil(cy + ry * g); by++) {
          const ex = (bx + 0.5 - cx) / rx, ey = (by + 0.5 - cy) / ry, ez = (bz + 0.5 - cz) / rz;
          let d = Math.sqrt(ex * ex + ey * ey + ez * ez);
          if (d > g) continue;
          if (d > 0.7) d += vn3(bx * 0.2, by * 0.2, bz * 0.2) * 0.3;
          if (d >= 1) continue;
          // facets: flatten the crown a little so rocks read as rock, not blobs
          if (ey > 0.72) continue;
          let m: number = ey < -0.2 ? M.CLIFF : M.STONE;
          if (mossy && ey > 0.25 && d > 0.6) m = hash3(bx, by, bz, 4) < 0.7 ? M.MOSS : M.MOSSY;
          putIfAir(bx, by, bz, m);
        }
    // seat it: fill the gaps under its belly down to the slope so it rests on the ground, not on a
    // few voxels (an overhanging lobe would otherwise snap off the moment anything nearby breaks)
    for (let bx = Math.floor(cx - rx * g); bx <= Math.ceil(cx + rx * g); bx++)
      for (let bz = Math.floor(cz - rz * g); bz <= Math.ceil(cz + rz * g); bz++) {
        if (bx < 0 || bz < 0 || bx >= WX || bz >= WZ) continue;
        const base = (bx * WZ + bz) * WY;
        const gr = world.ground[bx * WZ + bz];
        let low = -1;
        for (let by = gr; by <= Math.ceil(cy + ry * g) && by < WY; by++) {
          const m = vox[base + by];
          if (m === M.STONE || m === M.CLIFF || m === M.MOSSY) { low = by; break; }
        }
        if (low < 0 || low - gr > 8) continue;
        for (let by = gr; by < low; by++) if (vox[base + by] === 0) vox[base + by] = M.CLIFF;
      }
  };

  const stump = (x: number, y0: number, z: number, r: () => number) => {
    const h = 2 + Math.floor(r() * 3);
    for (let y = y0 - 1; y < y0 + h; y++) disc(x + 0.5, z + 0.5, y, 2.2, (wx, wz, d) => (y === y0 + h - 1 && d < 1.4 ? M.LOG_END : M.OAK_BARK));
    if (r() < 0.5) {
      putIfAir(x + 3, y0, z, M.WHITE_TRIM);
      putIfAir(x + 3, y0 + 1, z, M.ROOF_RED);
    }
  };

  const pebbles = (x: number, y0: number, z: number, r: () => number) => {
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const px = x + Math.floor(r() * 5) - 2, pz = z + Math.floor(r() * 5) - 2;
      const g = groundTop(px, pz);
      if (Math.abs(g - y0) > 2) continue;
      putIfAir(px, g, pz, r() < 0.5 ? M.STONE : M.GRAVEL);
    }
  };

  const cell = 24;
  const vr = mulberry32(seed ^ 0x9e3779b9);
  for (let gx = 0; gx < WX; gx += cell) {
    if (gx % 96 === 0) await progress(0.38 + (gx / WX) * 0.22, 'Growing the forest');
    for (let gz = 0; gz < WZ; gz += cell) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const x = gx + Math.floor(vr() * cell);
        const z = gz + Math.floor(vr() * cell);
        if (x < 6 || z < 6 || x >= WX - 8 || z >= WZ - 8) continue;
        const k = x * WZ + z;
        if (keepOut(x, z)) continue;
        const s = surf[k];
        const y0 = groundTop(x, z);
        if (y0 <= WATER_VOX + 2) continue;
        // something already grows here: planting on top of it left trees standing on other crowns
        if (y0 > world.ground[k]) continue;
        const f = forest[Lk(x, z)];
        const lx = x / S, lz = z / S;
        const edge = Math.min(lx, lz, LW - 1 - lx, LD - 1 - lz);
        const dens = clamp(0.25 + f * 1.25 + (edge < 26 ? 0.6 : 0), 0, 0.95);
        const roll = vr();
        if (s === M.GRASS || s === M.FLOWER_BED || s === M.MUD) {
          if (roll < dens * (attempt === 0 ? 0.92 : 0.3)) {
            const rd = riverDist(lx, lz);
            const kind = vr();
            if (rd < riverHW(lx) + 12 && kind < 0.55) birch(x, y0, z, vr);
            else if (kind < 0.5) pine(x, y0, z, vr);
            else {
              const leafRoll = hash2(x >> 1, z >> 1, 17);
              const leaf = leafRoll < 0.1 ? M.AUTUMN_LEAF : leafRoll < 0.16 ? M.RED_LEAF : M.OAK_LEAF;
              oak(x, y0, z, vr, leaf);
            }
          } else if (roll < dens + 0.18) bush(x, y0, z, vr);
          else if (roll < dens + 0.22) log(x, y0, z, vr);
          else if (roll < dens + 0.26) boulder(x, y0, z, vr);
          else if (roll < dens + 0.29) stump(x, y0, z, vr);
        } else if (s === M.STONE || s === M.MOSSY || s === M.CLIFF) {
          if (roll < 0.25) boulder(x, y0, z, vr);
          else if (roll < 0.4) pine(x, y0, z, vr);
        }
      }
      // undergrowth: ferns under the canopy, pebbles everywhere
      for (let attempt = 0; attempt < 4; attempt++) {
        const x = gx + Math.floor(vr() * cell);
        const z = gz + Math.floor(vr() * cell);
        if (x < 4 || z < 4 || x >= WX - 4 || z >= WZ - 4) continue;
        const k = x * WZ + z;
        const s = surf[k];
        const y0 = groundTop(x, z);
        if (y0 <= WATER_VOX + 1 || pathField[Lk(x, z)] < 2.5) continue;
        if (get(x, y0 - 1, z) !== s) continue; // something already stands here
        const f = forest[Lk(x, z)];
        const roll = vr();
        if ((s === M.GRASS || s === M.MUD) && roll < 0.2 + f * 0.6 && !keepOut(x, z)) fern(x, y0, z);
        else if (roll > 0.82) pebbles(x, y0, z, vr);
      }
    }
  }
  // a few showcase birches on the island
  const isr = mulberry32(seed + 5);
  {
    const x = Math.round(C * S) + 12, z = Math.round(C * S) - 9;
    birch(x, world.ground[x * WZ + z], z, isr);
    const x2 = WX - 1 - x, z2 = WZ - 1 - z;
    birch(x2, world.ground[x2 * WZ + z2], z2, isr);
  }
  // flowers/bushes ring around bases (soft decoration)
  for (const bc of [blueBase, redBase]) {
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2;
      const r = BASE_R + 6 + hash2(i, bc.x) * 8;
      const x = Math.round((bc.x + Math.cos(a) * r) * S), z = Math.round((bc.z + Math.sin(a) * r) * S);
      if (x < 4 || z < 4 || x >= WX - 4 || z >= WZ - 4) continue;
      if (pathField[Lk(x, z)] < 4) continue;
      const y0 = groundTop(x, z);
      if (y0 <= WATER_VOX + 2 || y0 > world.ground[x * WZ + z]) continue;
      if (hash2(i, bc.z) < 0.6) bush(x, y0, z, isr);
      else boulder(x, y0, z, isr);
    }
  }

  // ================================================================ finalize
  await progress(0.62, 'Settling the dust');
  world.computeAllColumns();
  const grassDensity = new Uint8Array(WX * WZ);
  for (let x = 0; x < WX; x++)
    for (let z = 0; z < WZ; z++) {
      const k = x * WZ + z;
      const f = forest[Lk(x, z)];
      const meadow = 1 - smoothstep(-0.2, 0.35, f);
      const nearPath = smoothstep(2, 6, bil(pathField, x, z));
      grassDensity[k] = Math.round(clamp(0.1 + meadow * 0.38 + sn.noise2(x / 18, z / 18) * 0.08, 0, 1) * nearPath * 255);
    }

  const toM = (p: V2): V2 => ({ x: (p.x + 0.5) * LV, z: (p.z + 0.5) * LV });
  const W = pathW.map(toM), E = pathE.map(toM), Cn = pathC.map(toM);
  const mirM = (p: V2): V2 => ({ x: LW * LV - p.x, z: LD * LV - p.z });
  const blueCore = baseBlue.core, redCore = baseRed.core;
  const lanesBlue = [
    [...W, ...E.map(mirM).reverse(), redCore],
    [...Cn, ...Cn.map(mirM).reverse(), redCore],
    [...E, ...W.map(mirM).reverse(), redCore],
  ];
  const lanesRed = lanesBlue.map((l) => [...l.slice(0, -1).map(mirM), blueCore]);

  // ---------------------------------------------------------------- water flow field
  // the river runs west to east; the lake turns it into a slow swirl around the island
  const FW = FLOW_RES, FD = FLOW_RES;
  const fs = LW / FW; // layout units per flow texel
  const fx = new Float32Array(FW * FD), fz = new Float32Array(FW * FD);
  for (let i = 0; i < FW; i++)
    for (let j = 0; j < FD; j++) {
      const x = (i + 0.5) * fs, z = (j + 0.5) * fs;
      const slope = (riverZ(x + 1) - riverZ(x - 1)) * 0.5;
      const inv = 1 / Math.sqrt(1 + slope * slope);
      const hw = riverHW(x);
      const rd = riverDist(x, z);
      const narrow = clamp(8.5 / hw, 0.7, 1.35);
      const along = clamp(1 - Math.pow(rd / (hw + 2.5), 2), 0, 1) * narrow;
      let vx = inv * along, vz = slope * inv * along;
      const ld = lakeD(x, z);
      const lw = 1 - smoothstep(0.75, 1.25, ld);
      if (lw > 0) {
        const dx = x - C, dz = z - C;
        const r = Math.hypot(dx, dz) + 1e-3;
        let lx = 0.45 + (-dz / r) * 0.35, lz = (dx / r) * 0.35;
        const isl = islandD(x, z);
        if (isl < 2.2) {
          const push = (2.2 - isl) * 0.4;
          lx += (dx / r) * push;
          lz += (dz / r) * push;
        }
        vx = lerp(vx, lx * 0.55, lw);
        vz = lerp(vz, lz * 0.55, lw);
      }
      fx[i * FD + j] = vx;
      fz[i * FD + j] = vz;
    }
  const flow = new Uint8Array(FW * FD * 2);
  for (let i = 0; i < FW; i++)
    for (let j = 0; j < FD; j++) {
      // 5x5 box blur keeps the field smooth across banks
      let sx = 0, sz = 0, n = 0;
      for (let a = -2; a <= 2; a++)
        for (let b = -2; b <= 2; b++) {
          const ii = i + a, jj = j + b;
          if (ii < 0 || jj < 0 || ii >= FW || jj >= FD) continue;
          sx += fx[ii * FD + jj];
          sz += fz[ii * FD + jj];
          n++;
        }
      const k = i * FD + j;
      flow[k * 2] = Math.round(clamp(sx / n * 0.5 + 0.5, 0, 1) * 255);
      flow[k * 2 + 1] = Math.round(clamp(sz / n * 0.5 + 0.5, 0, 1) * 255);
    }
  void WATER_L;

  return {
    flow,
    cores: [blueCore, redCore],
    coreY: [baseBlue.coreY, baseRed.coreY],
    spawns: [baseBlue.spawns, baseRed.spawns],
    lanes: [lanesBlue, lanesRed],
    defendSpots: [baseBlue.defend, baseRed.defend],
    supply: [baseBlue.supply, baseRed.supply],
    flags: [baseBlue.flag, baseRed.flag],
    grassDensity,
    riverZ: (xm: number) => riverZ(xm / LV - 0.5) * LV + 0.5 * LV,
    waterMask,
    menuOrbit: { x: (C + 0.5) * LV, z: (C + 0.5) * LV },
  };
}
