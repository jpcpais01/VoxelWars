import { VOXEL } from '../core/config';
import { hash3 } from '../core/noise';
import { M } from './materials';

/**
 * Greedy mesher with per-vertex ambient occlusion.
 * Works on a padded volume (1 voxel border on every side) so every neighbour lookup is a
 * plain array read. Faces are merged only when material and all four AO corners match,
 * which keeps flat ground cheap while preserving soft contact shadows everywhere.
 */

/**
 * Packed vertex stream, 8 bytes per vertex:
 *  positions: x, y, z in whole voxels relative to the volume's interior origin, plus a spare byte
 *  data: material, AO, face (0..5 = +x,-x,+y,-y,+z,-z), spare
 * Normals are rebuilt from the face index in the shader, so there is no normal stream at all.
 */
export interface MeshData {
  positions: Uint8Array;
  data: Uint8Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
}

export interface GrassData {
  positions: Float32Array;
  colors: Uint8Array; // rgb + wind weight
  vertexCount: number;
}

class Grow {
  pos = new Uint8Array(1 << 18);
  dat = new Uint8Array(1 << 18);
  idx = new Uint32Array(1 << 18);
  v = 0;
  i = 0;
  reset() {
    this.v = 0;
    this.i = 0;
  }
  ensure(nv: number, ni: number) {
    if ((this.v + nv) * 4 > this.pos.length) {
      const n = Math.max(this.pos.length * 2, (this.v + nv) * 4);
      const p = new Uint8Array(n);
      p.set(this.pos);
      this.pos = p;
      const d = new Uint8Array(n);
      d.set(this.dat);
      this.dat = d;
    }
    if (this.i + ni > this.idx.length) {
      const n = Math.max(this.idx.length * 2, this.i + ni);
      const p = new Uint32Array(n);
      p.set(this.idx);
      this.idx = p;
    }
  }
}

const G = new Grow();

const AO_CURVE = [0, 1, 2, 3];

/**
 * @param vol padded volume, layout (x * sz + z) * sy + y, interior dimensions at most 255
 * @param sx,sy,sz padded dimensions
 * Output positions are in voxels relative to interior cell (0,0,0); the mesh transform places them.
 */
export function greedyMesh(vol: Uint8Array, sx: number, sy: number, sz: number): MeshData {
  G.reset();
  const n = [sx - 2, sy - 2, sz - 2];
  const strides = [sz * sy, 1, sy]; // x, y, z strides in padded volume
  const maxMask = Math.max(n[0] * n[1], n[1] * n[2], n[0] * n[2]);
  const mask = new Int32Array(maxMask);
  const pos = [0, 0, 0];

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const nu = n[u];
    const nv = n[v];
    const sd = strides[d];
    const su = strides[u];
    const sv = strides[v];
    for (let s = -1; s <= 1; s += 2) {
      const face = d * 2 + (s > 0 ? 0 : 1);
      for (let i = 0; i < n[d]; i++) {
        // build mask
        let mi = 0;
        for (let b = 0; b < nv; b++) {
          for (let a = 0; a < nu; a++, mi++) {
            pos[d] = i + 1;
            pos[u] = a + 1;
            pos[v] = b + 1;
            const p = pos[0] * strides[0] + pos[1] + pos[2] * strides[2];
            const m = vol[p];
            if (m === 0) {
              mask[mi] = 0;
              continue;
            }
            const q = p + s * sd;
            if (vol[q] !== 0) {
              mask[mi] = 0;
              continue;
            }
            // AO corners around q in plane (u,v)
            const um = vol[q - su] !== 0 ? 1 : 0;
            const up = vol[q + su] !== 0 ? 1 : 0;
            const vm = vol[q - sv] !== 0 ? 1 : 0;
            const vp = vol[q + sv] !== 0 ? 1 : 0;
            const cmm = vol[q - su - sv] !== 0 ? 1 : 0;
            const cpm = vol[q + su - sv] !== 0 ? 1 : 0;
            const cpp = vol[q + su + sv] !== 0 ? 1 : 0;
            const cmp = vol[q - su + sv] !== 0 ? 1 : 0;
            const a0 = um && vm ? 0 : 3 - (um + vm + cmm);
            const a1 = up && vm ? 0 : 3 - (up + vm + cpm);
            const a2 = up && vp ? 0 : 3 - (up + vp + cpp);
            const a3 = um && vp ? 0 : 3 - (um + vp + cmp);
            mask[mi] = m | (a0 << 8) | (a1 << 10) | (a2 << 12) | (a3 << 14);
          }
        }
        // greedy merge
        mi = 0;
        for (let b = 0; b < nv; b++) {
          for (let a = 0; a < nu; ) {
            const key = mask[mi];
            if (key === 0) {
              a++;
              mi++;
              continue;
            }
            let w = 1;
            while (a + w < nu && mask[mi + w] === key) w++;
            let h = 1;
            outer: for (; b + h < nv; h++) {
              const row = mi + h * nu;
              for (let k = 0; k < w; k++) if (mask[row + k] !== key) break outer;
            }
            emitQuad(d, u, v, s, face, i, a, b, w, h, key);
            for (let hh = 0; hh < h; hh++) {
              const row = mi + hh * nu;
              for (let k = 0; k < w; k++) mask[row + k] = 0;
            }
            a += w;
            mi += w;
          }
        }
      }
    }
  }

  const vc = G.v;
  const positions = G.pos.slice(0, vc * 4);
  const data = G.dat.slice(0, vc * 4);
  const indices = vc > 65535 ? G.idx.slice(0, G.i) : Uint16Array.from(G.idx.subarray(0, G.i));
  return { positions, data, indices, vertexCount: vc };
}

const cU = [0, 1, 1, 0];
const cV = [0, 0, 1, 1];
const pp = [0, 0, 0];

function emitQuad(
  d: number,
  u: number,
  v: number,
  s: number,
  face: number,
  i: number,
  a: number,
  b: number,
  w: number,
  h: number,
  key: number,
) {
  G.ensure(4, 6);
  const mat = key & 255;
  const ao = [(key >> 8) & 3, (key >> 10) & 3, (key >> 12) & 3, (key >> 14) & 3];
  const base = G.v;
  const plane = i + (s > 0 ? 1 : 0);
  for (let c = 0; c < 4; c++) {
    pp[d] = plane;
    pp[u] = a + cU[c] * w;
    pp[v] = b + cV[c] * h;
    const di = G.v * 4;
    G.pos[di] = pp[0];
    G.pos[di + 1] = pp[1];
    G.pos[di + 2] = pp[2];
    G.pos[di + 3] = 0;
    G.dat[di] = mat;
    G.dat[di + 1] = AO_CURVE[ao[c]] * 85;
    G.dat[di + 2] = face;
    G.dat[di + 3] = 0;
    G.v++;
  }
  const flip = ao[0] + ao[2] > ao[1] + ao[3];
  const I = G.idx;
  let k = G.i;
  if (s > 0) {
    if (!flip) {
      I[k++] = base; I[k++] = base + 1; I[k++] = base + 2;
      I[k++] = base; I[k++] = base + 2; I[k++] = base + 3;
    } else {
      I[k++] = base + 1; I[k++] = base + 2; I[k++] = base + 3;
      I[k++] = base + 1; I[k++] = base + 3; I[k++] = base;
    }
  } else {
    if (!flip) {
      I[k++] = base; I[k++] = base + 2; I[k++] = base + 1;
      I[k++] = base; I[k++] = base + 3; I[k++] = base + 2;
    } else {
      I[k++] = base + 1; I[k++] = base + 3; I[k++] = base + 2;
      I[k++] = base + 1; I[k++] = base; I[k++] = base + 3;
    }
  }
  G.i = k;
}

// ---------------------------------------------------------------------------
// Chunk builds: level-of-detail meshes and grass from one copy of the fine voxels.

/** LOD l meshes 2^l x 2^l x 2^l voxel blocks as one cell */
export const LOD_LEVELS = 3;
/** fine voxels of padding on each horizontal side of a chunk copy (enough for the coarsest LOD) */
export const CHUNK_PAD = 1 << (LOD_LEVELS - 1);
/** coarse cells of wall kept on chunk borders so neighbours at another LOD never show a crack */
const SKIRT = 3;

export interface ChunkBuild {
  meshes: { lod: number; mesh: MeshData }[];
  grass: GrassData | null;
}

let lodVol = new Uint8Array(0);
const counts = new Uint16Array(256);
/** trunks, posts and poles: thinner than a coarse cell, but they hold things up, so they survive downsampling */
const THIN = new Uint8Array(256);
for (const m of [M.OAK_BARK, M.PINE_BARK, M.BIRCH_BARK, M.PLANK_DARK, M.STEEL_DARK, M.LOG_END]) THIN[m] = 1;

/**
 * Padded (1 cell) volume for one LOD, downsampled from the fine chunk copy.
 * A coarse cell is solid when at least 3/8 of its block is, and takes the most common material
 * of the highest occupied layer, so grass stays on top of hills and roofs keep their tiles.
 */
function lodVolume(fine: Uint8Array, fx: number, fy: number, fz: number, pad: number, n: number, lod: number) {
  const f = 1 << lod;
  const cn = n >> lod, cy = fy >> lod;
  const px = cn + 2, py = cy + 2, pz = cn + 2;
  const size = px * py * pz;
  if (lodVol.length < size) lodVol = new Uint8Array(size);
  const vol = lodVol;
  const need = Math.ceil((f * f * f * 3) / 8);
  for (let a = 0; a < px; a++) {
    const x0 = pad + (a - 1) * f;
    for (let c = 0; c < pz; c++) {
      const z0 = pad + (c - 1) * f;
      const dst = (a * pz + c) * py;
      vol[dst] = 1; // below bedrock
      vol[dst + py - 1] = 0;
      for (let b = 1; b <= cy; b++) {
        const y0 = (b - 1) * f;
        if (f === 1) {
          vol[dst + b] = fine[(x0 * fz + z0) * fy + y0];
          continue;
        }
        let solid = 0;
        let topY = -1;
        let thin = 0, thinM = 0;
        for (let i = 0; i < f; i++)
          for (let k = 0; k < f; k++) {
            const col = ((x0 + i) * fz + z0 + k) * fy + y0;
            for (let j = 0; j < f; j++) {
              const m = fine[col + j];
              if (m !== 0) {
                solid++;
                if (j > topY) topY = j;
                if (THIN[m]) {
                  thin++;
                  thinM = m;
                }
              }
            }
          }
        if (solid < need) {
          // a one-voxel trunk running through the block keeps it, so far trees don't float
          vol[dst + b] = thin >= f ? thinM : 0;
          continue;
        }
        // most common material in the highest occupied layer
        let best = 0, bestN = 0;
        for (let i = 0; i < f; i++)
          for (let k = 0; k < f; k++) {
            const m = fine[((x0 + i) * fz + z0 + k) * fy + y0 + topY];
            if (m === 0) continue;
            const c2 = ++counts[m];
            if (c2 > bestN) {
              bestN = c2;
              best = m;
            }
          }
        for (let i = 0; i < f; i++)
          for (let k = 0; k < f; k++) counts[fine[((x0 + i) * fz + z0 + k) * fy + y0 + topY]] = 0;
        vol[dst + b] = best;
      }
    }
  }
  if (lod > 0) {
    // skirts: drop the top few cells of every border column so the chunk keeps its own edge walls
    for (let a = 0; a < px; a++)
      for (let c = 0; c < pz; c++) {
        if (a !== 0 && c !== 0 && a !== px - 1 && c !== pz - 1) continue;
        const dst = (a * pz + c) * py;
        let t = py - 2;
        while (t > 0 && vol[dst + t] === 0) t--;
        for (let y = Math.max(1, t - SKIRT + 1); y <= t; y++) vol[dst + y] = 0;
      }
  }
  return { vol, px, py, pz };
}

/**
 * @param fine raw world copy, layout (x * fz + z) * fy + y, with `pad` extra columns on each
 *   horizontal side and the full world height (fy) with no vertical padding
 * @param lods bitmask of LOD levels to mesh
 */
export function buildChunk(
  fine: Uint8Array,
  fx: number,
  fy: number,
  fz: number,
  pad: number,
  lods: number,
  withGrass: boolean,
  ox: number,
  oz: number,
  density: (wx: number, wz: number) => number,
): ChunkBuild {
  const n = fx - pad * 2;
  const meshes: ChunkBuild['meshes'] = [];
  for (let lod = 0; lod < LOD_LEVELS; lod++) {
    if (!(lods & (1 << lod))) continue;
    const v = lodVolume(fine, fx, fy, fz, pad, n, lod);
    meshes.push({ lod, mesh: greedyMesh(v.vol, v.px, v.py, v.pz) });
  }
  return { meshes, grass: withGrass ? grassMesh(fine, fx, fy, fz, pad, ox, oz, density) : null };
}

// ---------------------------------------------------------------------------
// Grass tufts: stylised low-poly blades scattered on exposed grass tops.

let gPos = new Float32Array(1 << 16);
let gCol = new Uint8Array(1 << 16);

const FLOWER_COLORS = [
  [250, 246, 235],
  [255, 214, 74],
  [190, 120, 230],
  [255, 120, 150],
  [120, 180, 255],
];

/** tufts are authored per 0.4 m column: thin them out on finer grids */
const TUFT_K = (VOXEL / 0.4) ** 2;

export function grassMesh(
  vol: Uint8Array,
  sx: number,
  sy: number,
  sz: number,
  pad: number,
  ox: number,
  oz: number,
  density: (wx: number, wz: number) => number,
): GrassData {
  let v = 0;
  const push = (x: number, y: number, z: number, r: number, g: number, b: number, wind: number) => {
    if ((v + 1) * 3 > gPos.length) {
      const p = new Float32Array(gPos.length * 2);
      p.set(gPos);
      gPos = p;
      const c = new Uint8Array(gCol.length * 2);
      c.set(gCol);
      gCol = c;
    }
    gPos[v * 3] = x;
    gPos[v * 3 + 1] = y;
    gPos[v * 3 + 2] = z;
    gCol[v * 4] = r;
    gCol[v * 4 + 1] = g;
    gCol[v * 4 + 2] = b;
    gCol[v * 4 + 3] = wind;
    v++;
  };
  if (gCol.length < (gPos.length / 3) * 4) gCol = new Uint8Array((gPos.length / 3) * 4);

  for (let lx = pad; lx < sx - pad; lx++) {
    for (let lz = pad; lz < sz - pad; lz++) {
      const colBase = (lx * sz + lz) * sy;
      let ty = -1;
      for (let y = sy - 1; y >= 1; y--) {
        if (vol[colBase + y] !== 0) {
          ty = y;
          break;
        }
      }
      if (ty < 0) continue;
      const m = vol[colBase + ty];
      if (m !== M.GRASS && m !== M.FLOWER_BED) continue;
      const wx = lx - pad + ox;
      const wz = lz - pad + oz;
      const wy = ty; // chunks span the full height, so local y == world y
      const dens = density(wx, wz) * (m === M.FLOWER_BED ? 1.4 : 1) * TUFT_K;
      const hsh = hash3(wx, wy, wz, 77);
      if (hsh > dens) continue;
      const tufts = m === M.FLOWER_BED ? 2 : 1;
      for (let t = 0; t < tufts; t++) {
        const h2 = hash3(wx, t, wz, 13);
        const h3 = hash3(wz, t, wx, 29);
        const cx = (wx + 0.2 + h2 * 0.6) * VOXEL;
        const cz = (wz + 0.2 + h3 * 0.6) * VOXEL;
        const cy = (wy + 1) * VOXEL;
        const blades = 4 + ((h2 * 3) | 0);
        const tall = 0.55 + density(wz, wx) * 0.4;
        for (let k = 0; k < blades; k++) {
          const ang = (k / blades) * Math.PI * 2 + h3 * 6.28;
          const hb = (0.16 + hash3(wx, k, wz, 5) * 0.22) * tall;
          const lean = 0.05 + hash3(wz, k, wx, 9) * 0.08;
          const bx = cx + Math.cos(ang) * 0.04;
          const bz = cz + Math.sin(ang) * 0.04;
          const px = -Math.sin(ang) * 0.035;
          const pz = Math.cos(ang) * 0.035;
          const shade = 0.75 + hash3(k, wx, wz, 3) * 0.35;
          push(bx - px, cy, bz - pz, 74 * shade, 124 * shade, 40 * shade, 0);
          push(bx + px, cy, bz + pz, 74 * shade, 124 * shade, 40 * shade, 0);
          const tr = Math.min(255, 158 * shade), tg = Math.min(255, 212 * shade), tb = Math.min(255, 84 * shade);
          push(bx + Math.cos(ang) * lean, cy + hb, bz + Math.sin(ang) * lean, tr, tg, tb, 255);
        }
        if (m === M.FLOWER_BED || hsh < dens * 0.08) {
          const fc = FLOWER_COLORS[(hash3(wx, wz, 1, 41) * FLOWER_COLORS.length) | 0];
          const fy = cy + 0.22 + h2 * 0.1;
          const s = 0.06;
          // small diamond head (two triangles, crossed)
          push(cx - s, fy, cz, fc[0], fc[1], fc[2], 200);
          push(cx + s, fy, cz, fc[0], fc[1], fc[2], 200);
          push(cx, fy + s * 1.4, cz, fc[0], fc[1], fc[2], 220);
          push(cx, fy, cz - s, fc[0], fc[1], fc[2], 200);
          push(cx, fy, cz + s, fc[0], fc[1], fc[2], 200);
          push(cx, fy + s * 1.4, cz, fc[0], fc[1], fc[2], 220);
          // stem
          push(cx - 0.012, cy, cz, 60, 110, 40, 0);
          push(cx + 0.012, cy, cz, 60, 110, 40, 0);
          push(cx, fy, cz, 70, 130, 50, 200);
        }
      }
    }
  }
  return { positions: gPos.slice(0, v * 3), colors: gCol.slice(0, v * 4), vertexCount: v };
}
