import { VOXEL, WX, WY, WZ } from '../core/config';
import { Simplex, clamp, hash2, hash3, lerp, mulberry32, smoothstep } from '../core/noise';
import { M } from './materials';
import { World } from './World';

/**
 * Forest & river map. Everything here is in voxel units unless noted.
 * The layout is point-symmetric around the map centre so both teams get a fair map,
 * while foliage and micro detail stay organic.
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
  /** water flow field, (WX/2) x (WZ/2) texels, RG = flow x/z * 0.5 + 0.5, index i * (WZ/2) + j */
  flow: Uint8Array;
}

const C = (WX - 1) / 2; // 191.5
const mirror = (p: V2): V2 => ({ x: WX - 1 - p.x, z: WZ - 1 - p.z });
export const WATER_VOX = 10; // columns with surface height <= this are under water

type Prog = (p: number, label: string) => Promise<void>;

export async function generateWorld(world: World, seed: number, progress: Prog): Promise<MapInfo> {
  const rng = mulberry32(seed);
  const sn = new Simplex(rng);
  const sn2 = new Simplex(rng);
  const sym2 = (f: (x: number, z: number) => number, x: number, z: number) => (f(x, z) + f(WX - 1 - x, WZ - 1 - z)) * 0.5;

  // ---------------------------------------------------------------- river
  const n1 = (x: number) => sn.noise2(x / 45, 7.3);
  const riverZ = (x: number) => C + 26 * Math.sin((x - C) / 58) + 9 * (n1(x) - n1(WX - 1 - x));
  const riverHW = (x: number) => 7.5 + 1.8 * (sn2.noise2(x / 30, 3.1) + sn2.noise2((WX - 1 - x) / 30, 3.1));
  const riverDist = (x: number, z: number) => {
    const zr = riverZ(x);
    const slope = (riverZ(x + 1) - riverZ(x - 1)) * 0.5;
    return Math.abs(z - zr) / Math.sqrt(1 + slope * slope);
  };
  const lakeD = (x: number, z: number) => {
    const dx = (x - C) / 31;
    const dz = (z - C) / 21;
    const a = Math.atan2(dz, dx);
    const wob = 1 + 0.12 * Math.sin(a * 3 + 1.3) + 0.06 * Math.sin(a * 5 + 0.4);
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
  const pathField = new Float32Array(WX * WZ).fill(99);
  for (const path of allPaths) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - 8)), x1 = Math.min(WX - 1, Math.ceil(Math.max(a.x, b.x) + 8));
      const z0 = Math.max(0, Math.floor(Math.min(a.z, b.z) - 8)), z1 = Math.min(WZ - 1, Math.ceil(Math.max(a.z, b.z) + 8));
      for (let x = x0; x <= x1; x++)
        for (let z = z0; z <= z1; z++) {
          const d = segDist(x, z, a, b) + sn.noise2(x / 6, z / 6) * 1.1;
          const k = x * WZ + z;
          if (d < pathField[k]) pathField[k] = d;
        }
    }
  }

  // ---------------------------------------------------------------- heightmap
  const H = new Float32Array(WX * WZ);
  const surf = new Uint8Array(WX * WZ);
  const forest = new Float32Array(WX * WZ);
  const rockMask = new Float32Array(WX * WZ);
  const waterMask = new Uint8Array(WX * WZ);
  const BASE_H = 19;
  const BASE_R = 40;

  const fb = (x: number, z: number) => sn.fbm2(x / 95, z / 95, 3);
  const fm = (x: number, z: number) => sn.fbm2(x / 33, z / 33, 3);
  const ff = (x: number, z: number) => sn2.noise2(x / 11, z / 11);
  const fr = (x: number, z: number) => sn2.ridge2(x / 46 + 10, z / 46 - 4, 3);
  const fforest = (x: number, z: number) => sn2.fbm2(x / 70 + 50, z / 70 + 50, 3);

  for (let x = 0; x < WX; x++) {
    if (x % 32 === 0) await progress(0.02 + (x / WX) * 0.18, 'Shaping the valley');
    for (let z = 0; z < WZ; z++) {
      const k = x * WZ + z;
      let h = 17 + 7 * sym2(fb, x, z) * 1.4 + 2.2 * sym2(fm, x, z) * 1.4 + 0.7 * sym2(ff, x, z);
      const rd = riverDist(x, z);
      const hw = riverHW(x);
      const ld = lakeD(x, z);
      // broad valley toward the river
      h -= 5 * (1 - smoothstep(0, 90, rd));
      // border hills
      const edge = Math.min(x, z, WX - 1 - x, WZ - 1 - z);
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
      h = lerp(BASE_H + sn.noise2(x / 9, z / 9) * 0.4, h, smoothstep(BASE_R - 8, BASE_R + 14, db));
      // bridge ramps
      for (const br of [westBridge, eastBridge]) {
        const bdx = Math.abs(x - br.x);
        const bdz = Math.abs(z - br.z);
        if (bdx < 7 && bdz < hw + 18 && !inRiver) {
          const t = smoothstep(4, 7, bdx) + smoothstep(hw + 8, hw + 18, bdz);
          h = lerp(12, h, clamp(t, 0, 1));
        }
      }
      H[k] = clamp(h, 2, WY - 8);
      forest[k] = fforest(x, z);
      waterMask[k] = h <= WATER_VOX + 0.5 ? 1 : 0;
    }
  }

  // ---------------------------------------------------------------- surface materials + fill
  await progress(0.22, 'Laying soil and stone');
  const flowerN = (x: number, z: number) => sn.noise2(x / 14 + 99, z / 14 - 40);
  for (let x = 0; x < WX; x++) {
    for (let z = 0; z < WZ; z++) {
      const k = x * WZ + z;
      const h = Math.round(H[k]);
      H[k] = h;
      const rd = riverDist(x, z);
      const hw = riverHW(x);
      const ld = lakeD(x, z);
      const pd = pathField[k];
      let s: number = M.GRASS;
      const nearWater = rd < hw + 2.5 + sn.noise2(x / 5, z / 5) * 1.5 || ld < 1.12;
      if (h <= WATER_VOX) s = h <= 8 ? M.GRAVEL : hash2(x, z, 3) < 0.5 ? M.SAND : M.GRAVEL;
      else if (nearWater && h <= 12) s = sn.noise2(x / 7, z / 7) > 0.35 ? M.MUD : M.SAND;
      else if (rockMask[k] > 0.25) s = sn.noise2(x / 8, z / 8) > 0 ? M.MOSSY : M.STONE;
      else if (pd < 2.2) s = M.PATH;
      else if (pd < 3 && hash2(x, z, 9) < 0.5) s = M.PATH;
      else if (flowerN(x, z) > 0.62 && forest[k] < 0.1) s = M.FLOWER_BED;
      // steep columns become cliff faces
      let maxN = 0;
      if (x > 0 && x < WX - 1 && z > 0 && z < WZ - 1) {
        maxN = Math.max(Math.abs(H[k + WZ] - h), Math.abs(H[k - WZ] - h), Math.abs(H[k + 1] - h), Math.abs(H[k - 1] - h));
      }
      if (maxN >= 4 && s !== M.PATH && h > WATER_VOX) s = rockMask[k] > 0.1 ? M.CLIFF : s;
      surf[k] = s;
      const base = k * WY;
      world.vox[base] = M.BEDROCK;
      const dirtDepth = s === M.SAND || s === M.GRAVEL ? 2 : 3;
      for (let y = 1; y < h; y++) {
        let m: number;
        if (y === h - 1) m = s;
        else if (y >= h - 1 - dirtDepth) m = s === M.SAND ? M.SAND : s === M.GRAVEL ? M.GRAVEL : s === M.STONE || s === M.MOSSY || s === M.CLIFF ? M.STONE : M.DIRT;
        else m = y < 4 ? M.CLIFF : M.STONE;
        // clay band for nicer crater walls
        if (m === M.STONE && y > h - 7 && hash3(x, y, z, 5) < 0.35) m = M.CLAY;
        world.vox[base + y] = m;
      }
    }
  }

  const groundTop = (x: number, z: number) => {
    // first air above highest solid
    if (x < 0 || z < 0 || x >= WX || z >= WZ) return 0;
    const base = (x * WZ + z) * WY;
    for (let y = WY - 1; y >= 0; y--) if (world.vox[base + y] !== 0) return y + 1;
    return 1;
  };

  // ---------------------------------------------------------------- builders
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
      world.put(x, this.oy + ly, z, m);
    }
    box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number | ((x: number, y: number, z: number) => number)) {
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++) this.set(x, y, z, typeof m === 'number' ? m : m(x, y, z));
    }
    /** fill solid from terrain up to (excluding) ly=0 and clear above, across footprint */
    foundation(x0: number, z0: number, x1: number, z1: number, mat: number, clearH: number) {
      for (let x = x0; x <= x1; x++)
        for (let z = z0; z <= z1; z++) {
          const [wx, wz] = this.w(x, z);
          for (let y = 1; y < this.oy; y++) if (world.get(wx, y, wz) === 0) world.put(wx, y, wz, mat);
          for (let y = this.oy; y < this.oy + clearH; y++) world.put(wx, y, wz, M.AIR);
        }
    }
  }

  const putIfAir = (x: number, y: number, z: number, m: number) => {
    if (x < 0 || z < 0 || x >= WX || z >= WZ || y <= 0 || y >= WY) return;
    const i = (x * WZ + z) * WY + y;
    if (world.vox[i] === 0) world.vox[i] = m;
  };

  // ---------------------------------------------------------------- base
  const coreLocal = { x: 12, z: 9 };
  const buildBase = (team: 0 | 1) => {
    const center = team === 0 ? blueBase : redBase;
    const rot = team === 0 ? 0 : 2;
    const paint = team === 0 ? M.TEAM_BLUE : M.TEAM_RED;
    const glow = team === 0 ? M.GLOW_BLUE : M.GLOW_RED;
    const ox = team === 0 ? center.x - 12 : center.x + 12;
    const oz = team === 0 ? center.z - 9 : center.z + 9;
    const oy = BASE_H;
    const b = new B(ox, oy, oz, rot);
    // HQ bunker 24 x 18, front faces local -z (toward enemy)
    b.foundation(-1, -1, 24, 18, M.CONCRETE_DARK, 14);
    b.box(-1, -1, -1, 24, -1, 18, M.CONCRETE_DARK); // slab
    for (let x = 0; x <= 23; x++)
      for (let z = 0; z <= 17; z++) {
        const wall = x <= 1 || x >= 22 || z <= 1 || z >= 16;
        if (!wall) continue;
        for (let y = 0; y < 10; y++) {
          const outer = x === 0 || x === 23 || z === 0 || z === 17;
          let m: number = M.CONCRETE;
          if (outer && (y === 7 || y === 8)) m = paint;
          if (outer && y === 0) m = M.CONCRETE_DARK;
          b.set(x, y, z, m);
        }
      }
    // openings
    b.box(9, 0, 0, 14, 6, 1, M.AIR); // front door
    b.box(10, 0, 16, 13, 5, 17, M.AIR); // back door
    for (const sx of [3, 4, 19, 20]) b.box(sx, 4, 0, sx, 5, 1, M.AIR); // front slits
    for (const sz of [5, 6, 11, 12]) {
      b.box(0, 4, sz, 1, 5, sz, M.AIR);
      b.box(22, 4, sz, 23, 5, sz, M.AIR);
    }
    // roof
    b.box(-1, 10, -1, 24, 11, 18, M.CONCRETE_DARK);
    for (let x = -1; x <= 24; x++) {
      b.set(x, 12, -1, M.METAL);
      b.set(x, 12, 18, M.METAL);
    }
    for (let z = -1; z <= 18; z++) {
      b.set(-1, 12, z, M.METAL);
      b.set(24, 12, z, M.METAL);
    }
    // roof sandbags + antenna + vents
    b.box(4, 12, 2, 8, 13, 3, M.SANDBAG);
    b.box(15, 12, 2, 19, 13, 3, M.SANDBAG);
    b.box(20, 12, 13, 20, 22, 13, M.METAL);
    b.box(19, 21, 13, 21, 21, 13, M.METAL);
    b.box(3, 12, 12, 6, 13, 15, M.STEEL_DARK);
    // door lights
    b.set(8, 7, 0, glow);
    b.set(15, 7, 0, glow);
    b.set(9, 6, 16, glow);
    b.set(14, 6, 16, glow);
    // floor markings
    b.box(2, -1, 2, 21, -1, 15, M.CONCRETE);
    b.box(9, -1, 6, 14, -1, 12, M.STEEL_DARK);
    b.box(10, -1, 7, 13, -1, 11, M.METAL);
    // interior crates
    b.box(2, 0, 12, 4, 2, 14, M.CRATE);
    b.box(19, 0, 2, 21, 1, 4, M.CRATE);
    b.box(19, 2, 3, 20, 3, 4, M.CRATE);

    // sandbag perimeter arcs (local coords relative to base center, front = -z)
    const cb = new B(center.x, oy, center.z, rot);
    const arc = (r: number, a0: number, a1: number, hgt: number) => {
      for (let a = a0; a <= a1; a += 0.5 / r) {
        const lx = Math.round(Math.sin(a) * r);
        const lz = Math.round(-Math.cos(a) * r);
        for (let t = 0; t < 2; t++) {
          const tx = Math.round(Math.sin(a) * (r + t));
          const tz = Math.round(-Math.cos(a) * (r + t));
          const [wx, wz] = cb.w(tx, tz);
          const g = groundTop(wx, wz);
          for (let y = 0; y < hgt; y++) world.put(wx, g + y, wz, M.SANDBAG);
        }
        void lx;
        void lz;
      }
    };
    arc(27, -0.95, -0.38, 4);
    arc(27, 0.38, 0.95, 4);
    arc(27, -2.2, -1.35, 3);
    arc(27, 1.35, 2.2, 3);
    arc(20, -0.18, 0.18, 4); // inner front shield
    // tank traps (steel hedgehogs) in front
    const hedgehog = (lx: number, lz: number) => {
      const [wx, wz] = cb.w(lx, lz);
      const g = groundTop(wx, wz);
      for (let i = -2; i <= 2; i++) {
        world.put(wx + i, g + 2 + i, wz, M.STEEL_DARK);
        world.put(wx + i, g + 2 - i, wz, M.STEEL_DARK);
        world.put(wx, g + 2 + i, wz + i, M.STEEL_DARK);
      }
    };
    for (const p of [[-18, -36], [-6, -38], [7, -37], [19, -35], [-30, -26], [31, -27]]) hedgehog(p[0], p[1]);
    // watchtower (back left)
    const tw = new B(center.x, oy, center.z, rot);
    const tx0 = -24, tz0 = 14;
    for (const [px, pz] of [[0, 0], [5, 0], [0, 5], [5, 5]]) tw.box(tx0 + px, 0, tz0 + pz, tx0 + px, 15, tz0 + pz, M.PLANK_DARK);
    tw.box(tx0 - 1, 16, tz0 - 1, tx0 + 6, 16, tz0 + 6, M.PLANK);
    for (let i = -1; i <= 6; i++) {
      tw.set(tx0 + i, 17, tz0 - 1, M.PLANK_DARK);
      tw.set(tx0 + i, 17, tz0 + 6, M.PLANK_DARK);
      tw.set(tx0 - 1, 17, tz0 + i, M.PLANK_DARK);
      tw.set(tx0 + 6, 17, tz0 + i, M.PLANK_DARK);
    }
    for (const [px, pz] of [[-1, -1], [6, -1], [-1, 6], [6, 6]]) tw.box(tx0 + px, 18, tz0 + pz, tx0 + px, 20, tz0 + pz, M.PLANK_DARK);
    tw.box(tx0 - 2, 21, tz0 - 2, tx0 + 7, 21, tz0 + 7, paint);
    tw.box(tx0, 22, tz0, tx0 + 5, 22, tz0 + 5, paint);
    // cross braces
    for (let i = 0; i < 5; i++) {
      tw.set(tx0 + i, 4 + i, tz0, M.PLANK_DARK);
      tw.set(tx0 + 5 - i, 9 + i, tz0 + 5, M.PLANK_DARK);
    }
    // supply depot (right side): crates + explosive barrels
    const sx0 = 22, sz0 = 4;
    const sp = new B(center.x, oy, center.z, rot);
    sp.box(sx0, 0, sz0, sx0 + 2, 2, sz0 + 2, M.CRATE);
    sp.box(sx0 + 3, 0, sz0, sx0 + 5, 1, sz0 + 2, M.CRATE);
    sp.box(sx0, 0, sz0 + 4, sx0 + 1, 3, sz0 + 5, M.BARREL);
    sp.box(sx0 + 3, 0, sz0 + 5, sx0 + 3, 1, sz0 + 5, M.BARREL);
    sp.box(sx0 + 5, 0, sz0 + 4, sx0 + 5, 1, sz0 + 4, M.BARREL);
    sp.box(sx0 - 1, 0, sz0 + 8, sx0 + 5, 0, sz0 + 9, M.STEEL_DARK);
    sp.box(sx0, 1, sz0 + 8, sx0 + 4, 1, sz0 + 9, M.CRATE);
    // tents at back
    const tent = (lx: number, lz: number) => {
      for (let k = 0; k < 5; k++) {
        sp.box(lx - 4 + k, k, lz, lx - 4 + k, k, lz + 8, M.CANVAS);
        sp.box(lx + 4 - k, k, lz, lx + 4 - k, k, lz + 8, M.CANVAS);
      }
      sp.box(lx, 4, lz, lx, 4, lz + 8, M.CANVAS);
      sp.box(lx - 3, 0, lz + 8, lx + 3, 3, lz + 8, M.AIR);
      sp.set(lx, 3, lz + 8, paint);
    };
    tent(-12, 18);
    tent(12, 20);
    // flag pole base
    sp.box(-1, 0, -16, 1, 0, -14, M.CONCRETE_DARK);
    sp.box(0, 1, -15, 0, 1, -15, M.METAL);

    // record info
    const [cwx, cwz] = b.w(coreLocal.x, coreLocal.z);
    const [fwx, fwz] = cb.w(0, -15);
    return {
      core: { x: (cwx + 0.5) * VOXEL, z: (cwz + 0.5) * VOXEL },
      coreY: oy * VOXEL,
      flag: { x: (fwx + 0.5) * VOXEL, y: (oy + 1) * VOXEL, z: (fwz + 0.5) * VOXEL },
      spawns: [-9, -4, 0, 4, 9].map((lx, i) => {
        const [wx, wz] = cb.w(lx, 24 + (i % 2) * 3);
        return { x: (wx + 0.5) * VOXEL, z: (wz + 0.5) * VOXEL };
      }),
      defend: [
        [-16, -24], [16, -24], [0, -17], [-24, -6], [24, -6], [-10, -12], [10, -12], [-20, 6], [20, 8],
      ].map(([lx, lz]) => {
        const [wx, wz] = cb.w(lx, lz);
        return { x: (wx + 0.5) * VOXEL, z: (wz + 0.5) * VOXEL };
      }),
      supply: (() => {
        const [wx, wz] = cb.w(sx0 + 2, sz0 + 12);
        return { x: (wx + 0.5) * VOXEL, z: (wz + 0.5) * VOXEL };
      })(),
    };
  };

  // ---------------------------------------------------------------- bridges
  const buildBridge = (br: V2) => {
    const bx = Math.round(br.x);
    const zc = Math.round(br.z);
    const hw = Math.ceil(riverHW(bx)) + 6;
    const deckY = 11;
    for (let z = zc - hw; z <= zc + hw; z++) {
      for (let x = bx - 3; x <= bx + 3; x++) {
        world.put(x, deckY, z, (z & 1) === 0 ? M.PLANK : M.PLANK_DARK);
        for (let y = deckY + 1; y < deckY + 7; y++) world.put(x, y, z, M.AIR);
      }
      // rails
      if ((z - zc) % 3 === 0) {
        world.put(bx - 4, deckY + 1, z, M.PLANK_DARK);
        world.put(bx + 4, deckY + 1, z, M.PLANK_DARK);
        world.put(bx - 4, deckY + 2, z, M.PLANK_DARK);
        world.put(bx + 4, deckY + 2, z, M.PLANK_DARK);
      }
      world.put(bx - 4, deckY + 3, z, M.PLANK);
      world.put(bx + 4, deckY + 3, z, M.PLANK);
      world.put(bx - 4, deckY, z, M.PLANK_DARK);
      world.put(bx + 4, deckY, z, M.PLANK_DARK);
      // pillars
      if ((z - zc) % 6 === 0) {
        for (const px of [bx - 4, bx + 4]) {
          for (let y = 1; y < deckY; y++) if (world.get(px, y, z) === 0) world.put(px, y, z, M.PLANK_DARK);
        }
      }
      // fill under the deck ends so the ramps are solid
      for (let x = bx - 4; x <= bx + 4; x++) for (let y = 1; y < deckY; y++) if (world.get(x, y, z) === 0 && y >= 10) world.put(x, y, z, M.DIRT);
    }
  };

  // ---------------------------------------------------------------- cabin
  const buildCabin = (c: V2, rot: number, roof: number) => {
    // pick floor level as max ground over footprint
    let fy = 0;
    const probe = new B(c.x, 0, c.z, rot);
    for (let x = -1; x <= 16; x++)
      for (let z = -1; z <= 12; z++) {
        const [wx, wz] = probe.w(x, z);
        fy = Math.max(fy, groundTop(wx, wz));
      }
    const b = new B(c.x, fy, c.z, rot);
    b.foundation(-2, -2, 17, 13, M.STONE, 18);
    b.box(-1, -1, -1, 16, -1, 12, (x, _y, z) => (x === -1 || x === 16 || z === -1 || z === 12 ? M.MOSSY : M.PLANK_DARK));
    for (let x = 0; x <= 15; x++)
      for (let z = 0; z <= 11; z++) {
        const edge = x === 0 || x === 15 || z === 0 || z === 11;
        if (!edge) continue;
        const corner = (x === 0 || x === 15) && (z === 0 || z === 11);
        for (let y = 0; y < 7; y++) b.set(x, y, z, corner ? M.LOG_END : y % 2 === 0 ? M.OAK_BARK : M.PLANK_DARK);
      }
    b.box(6, 0, 0, 8, 4, 0, M.AIR); // door
    b.box(6, 5, 0, 8, 5, 0, M.WHITE_TRIM);
    for (const wx of [2, 12]) {
      b.box(wx, 2, 0, wx + 1, 3, 0, M.AIR);
      b.box(wx - 1, 1, 0, wx + 2, 1, 0, M.WHITE_TRIM);
      b.box(wx, 2, 11, wx + 1, 3, 11, M.AIR);
      b.box(wx - 1, 1, 11, wx + 2, 1, 11, M.WHITE_TRIM);
    }
    b.box(0, 2, 5, 0, 3, 6, M.AIR);
    b.box(15, 2, 5, 15, 3, 6, M.AIR);
    // gable roof along x, slopes toward ±z
    for (let k = 0; k <= 6; k++) {
      const y = 7 + k;
      const zs = k - 1, zn = 12 - k;
      for (let x = -1; x <= 16; x++) {
        if (zs <= zn) {
          b.set(x, y, zs, roof);
          b.set(x, y, zs + 1, roof);
          b.set(x, y, zn, roof);
          b.set(x, y, zn - 1, roof);
        }
      }
      // gable walls
      for (let z = zs + 2; z <= zn - 2; z++) {
        b.set(0, y, z, M.PLANK);
        b.set(15, y, z, M.PLANK);
      }
    }
    b.box(-1, 13, 5, 16, 13, 6, roof);
    // chimney
    b.box(12, 0, 8, 13, 15, 9, M.BRICK);
    // interior
    b.box(3, 0, 7, 6, 1, 9, M.PLANK);
    b.box(10, 0, 2, 11, 1, 3, M.CRATE);
    // porch + fence garden
    b.box(4, -1, -4, 10, -1, -2, M.PLANK);
    for (let x = -6; x <= 21; x++) {
      for (const z of [-12, 18]) {
        const [wx, wz] = b.w(x, z);
        const g = groundTop(wx, wz);
        if (x % 3 === 0) {
          world.put(wx, g, wz, M.PLANK_DARK);
          world.put(wx, g + 1, wz, M.PLANK_DARK);
        }
        world.put(wx, g + 1, wz, M.PLANK);
      }
    }
    // hay bales & flower beds in garden
    for (const [hx, hz] of [[-4, -8], [-4, -6], [19, 15], [17, 15]]) {
      const [wx, wz] = b.w(hx, hz);
      const g = groundTop(wx, wz);
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let y = 0; y < 2; y++) world.put(wx + i, g + y, wz + j, M.HAY);
    }
    for (let x = 0; x <= 15; x++)
      for (let z = -9; z <= -6; z++) {
        const [wx, wz] = b.w(x, z);
        const g = groundTop(wx, wz) - 1;
        if (world.get(wx, g, wz) === M.GRASS || world.get(wx, g, wz) === M.PATH) world.put(wx, g, wz, x % 4 === 3 ? M.MUD : M.FLOWER_BED);
      }
    // woodpile
    const [lx, lz] = b.w(17, 4);
    const g = groundTop(lx, lz);
    for (let i = 0; i < 4; i++) for (let y = 0; y < 2; y++) world.put(lx, g + y, lz + i, M.LOG_END);
  };

  // ---------------------------------------------------------------- ruin
  const buildRuin = (c: V2, rot: number) => {
    const probe = new B(c.x, 0, c.z, rot);
    let fy = 99;
    for (let x = 0; x < 14; x++)
      for (let z = 0; z < 10; z++) {
        const [wx, wz] = probe.w(x, z);
        fy = Math.min(fy, groundTop(wx, wz));
      }
    const b = new B(c.x, fy, c.z, rot);
    for (let x = 0; x < 14; x++)
      for (let z = 0; z < 10; z++) {
        const edge = x === 0 || x === 13 || z === 0 || z === 9;
        const [wx, wz] = b.w(x, z);
        for (let y = 0; y < 3; y++) if (world.get(wx, fy + y - 1, wz) === 0) world.put(wx, fy + y - 1, wz, M.STONE);
        if (!edge) continue;
        const hgt = Math.floor(3 + 6 * Math.max(0, sn.noise2(x / 4 + c.x, z / 4 + c.z) + 0.4));
        for (let y = 0; y < hgt; y++) {
          if (hash3(wx, y, wz, 3) < 0.07 && y > 2) continue;
          b.set(x, y, z, hash3(wx, y, wz, 8) < 0.35 ? M.MOSSY : y === 0 ? M.CLIFF : M.STONE);
        }
      }
    b.box(5, 0, 0, 7, 4, 0, M.AIR);
    b.box(13, 1, 4, 13, 3, 5, M.AIR);
    // fallen rubble
    for (let i = 0; i < 18; i++) {
      const rx = -2 + Math.floor(hash2(i, c.x, 4) * 18);
      const rz = -3 + Math.floor(hash2(i, c.z, 5) * 16);
      const [wx, wz] = b.w(rx, rz);
      const g = groundTop(wx, wz);
      world.put(wx, g, wz, hash2(i, 3) < 0.5 ? M.MOSSY : M.STONE);
    }
  };

  // ---------------------------------------------------------------- island tower
  const buildTower = () => {
    const cx = Math.round(C), cz = Math.round(C);
    const g = groundTop(cx, cz);
    for (let x = -6; x <= 6; x++)
      for (let z = -6; z <= 6; z++) {
        const r = Math.hypot(x, z);
        if (r > 5.6) continue;
        const wall = r > 3.7;
        const hgt = 22 + Math.floor(sn.noise2(Math.atan2(z, x) * 1.3, 4) * 7);
        for (let y = g - 2; y < g + (wall ? hgt : 0); y++) {
          if (wall && hash3(cx + x, y, cz + z, 11) < 0.04) continue;
          world.put(cx + x, y, cz + z, hash3(cx + x, y, cz + z, 2) < 0.3 ? M.MOSSY : M.STONE);
        }
        if (!wall) world.put(cx + x, g - 1, cz + z, M.PLANK_DARK);
      }
    // doors facing north and south
    for (const s of [-1, 1]) for (let x = -1; x <= 1; x++) for (let y = 0; y < 5; y++) for (let d = 3; d <= 6; d++) world.put(cx + x, g + y, cz + s * d, M.AIR);
    // windows
    for (const a of [0.8, 2.4, 4.0, 5.6]) for (let y = 10; y < 13; y++) world.put(cx + Math.round(Math.cos(a) * 4.6), g + y, cz + Math.round(Math.sin(a) * 4.6), M.AIR);
  };

  // ---------------------------------------------------------------- docks + boats
  const buildDock = (side: 1 | -1) => {
    const x0 = Math.round(C) + side * 14;
    let z = Math.round(C) + side * 26;
    // walk toward the lake until water
    let guard = 0;
    while (groundTop(x0, z) > WATER_VOX + 1 && guard++ < 40) z -= side;
    const zEnd = z - side * 9;
    for (let zz = z + side * 3; zz !== zEnd; zz -= side) {
      for (let x = x0 - 2; x <= x0 + 2; x++) world.put(x, 11, zz, M.PLANK);
      if ((zz - z) % 3 === 0) for (const px of [x0 - 2, x0 + 2]) for (let y = 1; y < 11; y++) if (world.get(px, y, zz) === 0) world.put(px, y, zz, M.PLANK_DARK);
    }
    // little rowboat beside the dock
    const bx = x0 + 5 * side, bz = zEnd + side * 3;
    for (let i = -4; i <= 4; i++)
      for (let j = -2; j <= 2; j++) {
        const inside = Math.abs(j) < 2 && Math.abs(i) < 4;
        const tip = Math.abs(i) === 4 && Math.abs(j) > 0;
        if (tip) continue;
        world.put(bx + j, 10, bz + i, M.BOAT);
        if (!inside) world.put(bx + j, 11, bz + i, M.BOAT);
      }
    world.put(bx, 11, bz, M.PLANK);
    world.put(bx - 1, 11, bz, M.PLANK);
    world.put(bx + 1, 11, bz, M.PLANK);
  };

  await progress(0.3, 'Raising the bases');
  const baseBlue = buildBase(0);
  const baseRed = buildBase(1);
  buildBridge(westBridge);
  buildBridge(eastBridge);
  await progress(0.34, 'Building cabins and ruins');
  buildCabin(cabinBlue, 0, M.ROOF_RED);
  buildCabin(mirror(cabinBlue), 2, M.ROOF_SLATE);
  buildRuin(ruinBlue, 1);
  buildRuin(mirror(ruinBlue), 3);
  buildTower();
  buildDock(1);
  buildDock(-1);

  // keep-out mask for vegetation
  const keepOut = (x: number, z: number) => {
    const k = x * WZ + z;
    if (pathField[k] < 4) return true;
    if (Math.hypot(x - blueBase.x, z - blueBase.z) < BASE_R + 4) return true;
    if (Math.hypot(x - redBase.x, z - redBase.z) < BASE_R + 4) return true;
    for (const c of [cabinBlue, mirror(cabinBlue)]) if (Math.hypot(x - c.x, z - c.z) < 30) return true;
    for (const c of [ruinBlue, mirror(ruinBlue)]) if (Math.hypot(x - c.x, z - c.z) < 16) return true;
    for (const br of [westBridge, eastBridge]) if (Math.abs(x - br.x) < 10 && Math.abs(z - br.z) < 30) return true;
    return false;
  };

  // ---------------------------------------------------------------- vegetation
  await progress(0.38, 'Growing the forest');
  const trunk = (x: number, y0: number, z: number, h: number, thick: boolean, mat: number) => {
    for (let y = y0 - 1; y < y0 + h; y++) {
      world.put(x, y, z, mat);
      if (thick) {
        world.put(x + 1, y, z, mat);
        world.put(x, y, z + 1, mat);
        world.put(x + 1, y, z + 1, mat);
      }
    }
    // root flare
    if (thick) {
      for (const [dx, dz] of [[-1, 0], [2, 1], [0, -1], [1, 2]]) {
        putIfAir(x + dx, y0, z + dz, mat);
      }
    } else {
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) if (hash3(x + dx, y0, z + dz, 4) < 0.5) putIfAir(x + dx, y0, z + dz, mat);
    }
  };

  const pine = (x: number, y0: number, z: number, r: () => number) => {
    const h = 17 + Math.floor(r() * 9);
    const thick = h > 22;
    trunk(x, y0, z, h - 2, thick, M.PINE_BARK);
    const cs = y0 + 4 + Math.floor(r() * 3);
    const top = y0 + h + 2;
    const maxR = 5 + r() * 2 + (thick ? 1 : 0);
    const cx = x + (thick ? 0.5 : 0), cz = z + (thick ? 0.5 : 0);
    for (let y = cs; y <= top; y++) {
      const t = (y - cs) / (top - cs);
      const tier = ((y - cs) % 4) / 3;
      const rr = Math.max(0.6, (1 - t) * maxR * (0.62 + 0.38 * (1 - tier)));
      const ri = Math.ceil(rr);
      for (let dx = -ri; dx <= ri + 1; dx++)
        for (let dz = -ri; dz <= ri + 1; dz++) {
          const d = Math.hypot(dx - (cx - x), dz - (cz - z));
          if (d > rr + 0.3) continue;
          if (d > rr - 0.8 && hash3(x + dx, y, z + dz, 21) < 0.35) continue;
          putIfAir(x + dx, y, z + dz, M.PINE_LEAF);
        }
    }
  };

  const blob = (cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, mat: number, rough = 0.35) => {
    for (let x = Math.floor(cx - rx - 1); x <= cx + rx + 1; x++)
      for (let y = Math.floor(cy - ry - 1); y <= cy + ry + 1; y++)
        for (let z = Math.floor(cz - rz - 1); z <= cz + rz + 1; z++) {
          const d = Math.hypot((x - cx) / rx, (y - cy) / ry, (z - cz) / rz);
          const n = sn.noise3(x / 3.2, y / 3.2, z / 3.2) * rough;
          if (d + n < 1) putIfAir(x, y, z, mat);
        }
  };

  const oak = (x: number, y0: number, z: number, r: () => number, leaf: number) => {
    const h = 8 + Math.floor(r() * 4);
    trunk(x, y0, z, h, true, M.OAK_BARK);
    const top = y0 + h;
    const n = 3 + Math.floor(r() * 3);
    blob(x + 0.5, top + 2.5, z + 0.5, 5.2, 3.6, 5.2, leaf);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const d = 3 + r() * 2.5;
      const bx = x + Math.cos(a) * d, bz = z + Math.sin(a) * d;
      const by = top + r() * 3 - 1;
      // branch
      for (let s = 0; s <= 1; s += 0.2) {
        world.put(Math.round(lerp(x, bx, s)), Math.round(lerp(top - 2, by, s)), Math.round(lerp(z, bz, s)), M.OAK_BARK);
      }
      blob(bx, by + 1.5, bz, 3.4 + r() * 1.4, 2.6 + r(), 3.4 + r() * 1.4, leaf);
    }
  };

  const birch = (x: number, y0: number, z: number, r: () => number) => {
    const h = 12 + Math.floor(r() * 5);
    for (let y = y0 - 1; y < y0 + h; y++) world.put(x, y, z, hash3(x, y, z, 6) < 0.18 ? M.PINE_BARK : M.BIRCH_BARK);
    blob(x, y0 + h - 1, z, 3.2, 4.6, 3.2, M.BIRCH_LEAF, 0.45);
    blob(x + 1, y0 + h - 4, z - 1, 2.4, 2.2, 2.4, M.BIRCH_LEAF, 0.45);
  };

  const bush = (x: number, y0: number, z: number, r: () => number) => {
    blob(x, y0 + 0.6, z, 1.8 + r() * 1.6, 1.4 + r() * 0.9, 1.8 + r() * 1.6, M.BUSH, 0.5);
  };

  const log = (x: number, y0: number, z: number, r: () => number) => {
    const len = 7 + Math.floor(r() * 8);
    const alongX = r() < 0.5;
    for (let i = 0; i < len; i++) {
      const end = i === 0 || i === len - 1;
      for (let a = 0; a < 2; a++)
        for (let y = 0; y < 2; y++) {
          const wx = alongX ? x + i : x + a;
          const wz = alongX ? z + a : z + i;
          world.put(wx, y0 + y, wz, end ? M.LOG_END : M.OAK_BARK);
        }
    }
    // a little moss
    for (let i = 1; i < len - 1; i += 3) {
      const wx = alongX ? x + i : x;
      const wz = alongX ? z : z + i;
      putIfAir(wx, y0 + 2, wz, M.BUSH);
    }
  };

  const boulder = (x: number, y0: number, z: number, r: () => number) => {
    const s = 1.8 + r() * 3.2;
    blob(x, y0 + s * 0.2, z, s * (1 + r() * 0.5), s * 0.8, s * (1 + r() * 0.5), r() < 0.5 ? M.MOSSY : M.STONE, 0.3);
  };

  const cell = 12;
  const vr = mulberry32(seed ^ 0x9e3779b9);
  for (let gx = 0; gx < WX; gx += cell) {
    if (gx % 44 === 0) await progress(0.38 + (gx / WX) * 0.22, 'Growing the forest');
    for (let gz = 0; gz < WZ; gz += cell) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const x = gx + Math.floor(vr() * cell);
        const z = gz + Math.floor(vr() * cell);
        if (x < 3 || z < 3 || x >= WX - 4 || z >= WZ - 4) continue;
        const k = x * WZ + z;
        if (keepOut(x, z)) continue;
        const s = surf[k];
        const y0 = groundTop(x, z);
        if (y0 <= WATER_VOX + 1) continue;
        const f = forest[k];
        const edge = Math.min(x, z, WX - 1 - x, WZ - 1 - z);
        const dens = clamp(0.25 + f * 1.25 + (edge < 26 ? 0.6 : 0), 0, 0.95);
        const roll = vr();
        if (s === M.GRASS || s === M.FLOWER_BED || s === M.MUD) {
          if (roll < dens * (attempt === 0 ? 0.92 : 0.3)) {
            const rd = riverDist(x, z);
            const kind = vr();
            if (rd < riverHW(x) + 12 && kind < 0.55) birch(x, y0, z, vr);
            else if (kind < 0.5) pine(x, y0, z, vr);
            else {
              const leafRoll = hash2(x, z, 17);
              const leaf = leafRoll < 0.1 ? M.AUTUMN_LEAF : leafRoll < 0.16 ? M.RED_LEAF : M.OAK_LEAF;
              oak(x, y0, z, vr, leaf);
            }
          } else if (roll < dens + 0.18) bush(x, y0, z, vr);
          else if (roll < dens + 0.22) log(x, y0, z, vr);
          else if (roll < dens + 0.26) boulder(x, y0, z, vr);
        } else if (s === M.STONE || s === M.MOSSY || s === M.CLIFF) {
          if (roll < 0.25) boulder(x, y0, z, vr);
          else if (roll < 0.4) pine(x, y0, z, vr);
        }
      }
    }
  }
  // a few showcase trees near the lake & the island
  const isr = mulberry32(seed + 5);
  for (const [ix, iz] of [[-3, -2], [3, 2]]) {
    const x = Math.round(C) + ix * 1, z = Math.round(C) + iz * 1;
    void x;
    void z;
  }
  {
    const x = Math.round(C) + 5, z = Math.round(C) - 4;
    birch(x, groundTop(x, z), z, isr);
    const x2 = Math.round(C) - 5, z2 = Math.round(C) + 4;
    birch(x2, groundTop(x2, z2), z2, isr);
  }
  // flowers/bushes ring around bases (soft decoration)
  for (const bc of [blueBase, redBase]) {
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const r = BASE_R + 6 + hash2(i, bc.x) * 8;
      const x = Math.round(bc.x + Math.cos(a) * r), z = Math.round(bc.z + Math.sin(a) * r);
      if (x < 2 || z < 2 || x >= WX - 2 || z >= WZ - 2) continue;
      if (pathField[x * WZ + z] < 4) continue;
      const y0 = groundTop(x, z);
      if (y0 <= WATER_VOX + 1) continue;
      if (hash2(i, bc.z) < 0.6) bush(x, y0, z, isr);
      else boulder(x, y0, z, isr);
    }
  }

  // ---------------------------------------------------------------- finalize
  await progress(0.62, 'Settling the dust');
  world.computeAllColumns();
  const grassDensity = new Uint8Array(WX * WZ);
  for (let x = 0; x < WX; x++)
    for (let z = 0; z < WZ; z++) {
      const k = x * WZ + z;
      const f = forest[k];
      const meadow = 1 - smoothstep(-0.2, 0.35, f);
      const nearPath = smoothstep(2, 6, pathField[k]);
      grassDensity[k] = Math.round(clamp(0.1 + meadow * 0.38 + sn.noise2(x / 9, z / 9) * 0.08, 0, 1) * nearPath * 255);
    }

  const toM = (p: V2): V2 => ({ x: (p.x + 0.5) * VOXEL, z: (p.z + 0.5) * VOXEL });
  const W = pathW.map(toM), E = pathE.map(toM), Cn = pathC.map(toM);
  const mirM = (p: V2): V2 => ({ x: WX * VOXEL - p.x, z: WZ * VOXEL - p.z });
  const blueCore = baseBlue.core, redCore = baseRed.core;
  const lanesBlue = [
    [...W, ...E.map(mirM).reverse(), redCore],
    [...Cn, ...Cn.map(mirM).reverse(), redCore],
    [...E, ...W.map(mirM).reverse(), redCore],
  ];
  const lanesRed = lanesBlue.map((l) => [...l.slice(0, -1).map(mirM), blueCore]);

  // ---------------------------------------------------------------- water flow field
  // the river runs west to east; the lake turns it into a slow swirl around the island
  const FW = WX >> 1, FD = WZ >> 1;
  const fx = new Float32Array(FW * FD), fz = new Float32Array(FW * FD);
  for (let i = 0; i < FW; i++)
    for (let j = 0; j < FD; j++) {
      const x = i * 2 + 1, z = j * 2 + 1;
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
    riverZ: (xm: number) => riverZ(xm / VOXEL) * VOXEL,
    waterMask,
    menuOrbit: { x: C * VOXEL, z: C * VOXEL },
  };
}
