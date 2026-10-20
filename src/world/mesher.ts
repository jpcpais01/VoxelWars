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

export function grassMesh(
  vol: Uint8Array,
  sx: number,
  sy: number,
  sz: number,
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

  for (let lx = 1; lx < sx - 1; lx++) {
    for (let lz = 1; lz < sz - 1; lz++) {
      const colBase = (lx * sz + lz) * sy;
      let ty = -1;
      for (let y = sy - 2; y >= 1; y--) {
        if (vol[colBase + y] !== 0) {
          ty = y;
          break;
        }
      }
      if (ty < 0) continue;
      const m = vol[colBase + ty];
      if (m !== M.GRASS && m !== M.FLOWER_BED) continue;
      const wx = lx - 1 + ox;
      const wz = lz - 1 + oz;
      const wy = ty - 1; // interior y == world y (chunks start at 0)
      const dens = density(wx, wz) * (m === M.FLOWER_BED ? 1.4 : 1);
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
