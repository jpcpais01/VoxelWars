import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { greedyMesh, MeshData } from '../world/mesher';
import { Build, WeaponDef } from './weapons';

/**
 * Fine voxel weapon models (0.5 cm voxels) built procedurally from each weapon's shape and
 * its attachments, then greedy-meshed with baked AO. The fine models fill the loadout preview
 * and, with hands and animated parts, become the first-person viewmodel; bots carry a 1 cm copy
 * of the same recipe (lod 1), which is all a gun needs a few metres away.
 *
 * Gun space: metres, +Z along the barrel, +Y up, origin at the top of the pistol grip.
 * The shooter's right side is -X (so ejection ports and bolt handles live there).
 * Recipes are written in metres, so they read the same at either resolution.
 */
export const GV = 0.005;
const LOD_RES = [GV, 0.01];

export type PartName = 'body' | 'mag' | 'pump' | 'rotor' | 'warhead' | 'cyl';
const PART_IDS: PartName[] = ['body', 'mag', 'pump', 'rotor', 'warhead', 'cyl'];

export interface GunPart {
  name: PartName;
  geo: THREE.BufferGeometry;
  pivot: THREE.Vector3;
}

export interface GunModel {
  key: string;
  parts: GunPart[];
  /** all parts in one geometry, for third-person rigs and previews */
  merged: THREE.BufferGeometry;
  muzzle: THREE.Vector3;
  /** where the eye sits when aiming down sights (on the sight axis, at the rear of the sight) */
  sight: THREE.Vector3;
  /** optical magnification while aiming */
  zoom: number;
  /** high-power optics replace the view with a scope overlay */
  scoped: boolean;
  reticle: 'dot' | 'holo' | null;
  /** centre of the reflex window (where the collimated reticle is drawn) */
  lens: THREE.Vector3;
  /** half width / height of that window, and its corner radius (= half size for a round lens) */
  lensHalf: THREE.Vector2;
  lensRound: number;
  gripR: THREE.Vector3;
  gripL: THREE.Vector3;
  /** where the off hand goes to swap magazines */
  magAt: THREE.Vector3;
  /** visual weight 0..1 (sway, ADS speed) */
  heft: number;
}

// ------------------------------------------------------------------------------ voxel grid
interface Pal {
  col: number;
  spec: number;
  glow: number;
}

// working volume in gun space (metres); hands reach furthest back and to the sides
const X_MIN = -0.2, X_MAX = 0.2, Y_MIN = -0.34, Y_MAX = 0.3, Z_MIN = -0.56, Z_MAX = 1.62;
/** the mesher packs positions into bytes, so long parts are meshed in slabs along Z */
const SLAB = 240;

class VoxGrid {
  readonly ia: number;
  readonly ib: number;
  readonly ja: number;
  readonly jb: number;
  readonly ka: number;
  readonly kb: number;
  readonly ny: number;
  readonly nz: number;
  readonly mat: Uint8Array;
  readonly part: Uint8Array;
  pal: Pal[] = [{ col: 0, spec: 0, glow: 0 }];
  cur = 0;
  /** index box every write touched (i0, i1, j0, j1, k0, k1), so resets only clear that */
  private dirty = [0, -1, 0, -1, 0, -1];
  /** index box of each part's solid cells (loose: whole fill boxes) */
  private pb = PART_IDS.map(() => [0, -1, 0, -1, 0, -1]);

  constructor(readonly res: number) {
    this.ia = Math.round(X_MIN / res);
    this.ib = Math.round(X_MAX / res);
    this.ja = Math.round(Y_MIN / res);
    this.jb = Math.round(Y_MAX / res);
    this.ka = Math.round(Z_MIN / res);
    this.kb = Math.round(Z_MAX / res);
    this.ny = this.jb - this.ja + 1;
    this.nz = this.kb - this.ka + 1;
    const n = (this.ib - this.ia + 1) * this.ny * this.nz;
    this.mat = new Uint8Array(n);
    this.part = new Uint8Array(n);
  }
  reset() {
    const d = this.dirty;
    if (d[1] >= d[0]) {
      for (let i = d[0]; i <= d[1]; i++)
        for (let k = d[4]; k <= d[5]; k++) {
          const a = this.at(i, d[2], k);
          this.mat.fill(0, a, a + d[3] - d[2] + 1);
          this.part.fill(0, a, a + d[3] - d[2] + 1);
        }
    }
    this.dirty = [0, -1, 0, -1, 0, -1];
    this.pb = PART_IDS.map(() => [0, -1, 0, -1, 0, -1]);
    this.pal = [{ col: 0, spec: 0, glow: 0 }];
    this.cur = 0;
  }
  c(col: number, spec = 0.25, glow = 0): number {
    let i = this.pal.findIndex((p) => p.col === col && p.spec === spec && p.glow === glow);
    if (i < 0) {
      i = this.pal.length;
      this.pal.push({ col, spec, glow });
    }
    return i;
  }
  /** palette entry like i but brighter or darker */
  shade(i: number, k: number) {
    const p = this.pal[i];
    return this.c(lighten(p.col, k), p.spec, p.glow);
  }
  setPart(p: PartName) {
    this.cur = PART_IDS.indexOf(p);
  }
  /** nearest cell centre to v (for single-voxel plates and posts) */
  sn(v: number) {
    return Math.round(v / this.res) * this.res;
  }
  private at(i: number, j: number, k: number) {
    return ((i - this.ia) * this.nz + (k - this.ka)) * this.ny + (j - this.ja);
  }
  private grow(b: number[], i0: number, i1: number, j0: number, j1: number, k0: number, k1: number) {
    if (b[1] < b[0]) {
      b[0] = i0, b[1] = i1, b[2] = j0, b[3] = j1, b[4] = k0, b[5] = k1;
      return;
    }
    b[0] = Math.min(b[0], i0), b[1] = Math.max(b[1], i1);
    b[2] = Math.min(b[2], j0), b[3] = Math.max(b[3], j1);
    b[4] = Math.min(b[4], k0), b[5] = Math.max(b[5], k1);
  }
  /** fill cells whose centre lies inside [x0,x1]x[y0,y1]x[z0,z1] and passes the predicate */
  fill(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: number | ((x: number, y: number, z: number) => number)) {
    const e = 1e-4, R = this.res;
    const i0 = Math.max(this.ia, Math.ceil((x0 - e) / R)), i1 = Math.min(this.ib, Math.floor((x1 + e) / R));
    const j0 = Math.max(this.ja, Math.ceil((y0 - e) / R)), j1 = Math.min(this.jb, Math.floor((y1 + e) / R));
    const k0 = Math.max(this.ka, Math.ceil((z0 - e) / R)), k1 = Math.min(this.kb, Math.floor((z1 + e) / R));
    if (i0 > i1 || j0 > j1 || k0 > k1) return;
    const fn = typeof c === 'function' ? c : null;
    let solid = false;
    for (let i = i0; i <= i1; i++)
      for (let k = k0; k <= k1; k++) {
        let a = this.at(i, j0, k);
        for (let j = j0; j <= j1; j++, a++) {
          let v = fn ? fn(i * R, j * R, k * R) : (c as number);
          if (v < 0) continue;
          if (v > 255) v = this.c(v); // raw hex colours are accepted too
          this.mat[a] = v;
          this.part[a] = v ? this.cur : 0;
          if (v) solid = true;
        }
      }
    this.grow(this.dirty, i0, i1, j0, j1, k0, k1);
    if (solid) this.grow(this.pb[this.cur], i0, i1, j0, j1, k0, k1);
  }
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: number) {
    this.fill(x0, x1, y0, y1, z0, z1, c);
  }
  /** box centred on x = 0 */
  boxc(w: number, y0: number, y1: number, z0: number, z1: number, c: number) {
    this.fill(-w / 2, w / 2, y0, y1, z0, z1, c);
  }
  /** cylinder along Z through (cx, cy); rIn > 0 makes a tube */
  cylZ(cx: number, cy: number, r: number, z0: number, z1: number, c: number, rIn = 0) {
    const t = this.res * 0.2;
    const r2 = (r + t) ** 2, ri2 = rIn > 0 ? (rIn - t) ** 2 : -1;
    this.fill(cx - r, cx + r, cy - r, cy + r, z0, z1, (x, y) => {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      return d <= r2 && d > ri2 ? c : -1;
    });
  }
  cylX(cy: number, cz: number, r: number, x0: number, x1: number, c: number, rIn = 0) {
    const t = this.res * 0.2;
    const r2 = (r + t) ** 2, ri2 = rIn > 0 ? (rIn - t) ** 2 : -1;
    this.fill(x0, x1, cy - r, cy + r, cz - r, cz + r, (_x, y, z) => {
      const d = (y - cy) ** 2 + (z - cz) ** 2;
      return d <= r2 && d > ri2 ? c : -1;
    });
  }
  cylY(cx: number, cz: number, r: number, y0: number, y1: number, c: number, rIn = 0) {
    const t = this.res * 0.2;
    const r2 = (r + t) ** 2, ri2 = rIn > 0 ? (rIn - t) ** 2 : -1;
    this.fill(cx - r, cx + r, y0, y1, cz - r, cz + r, (x, _y, z) => {
      const d = (x - cx) ** 2 + (z - cz) ** 2;
      return d <= r2 && d > ri2 ? c : -1;
    });
  }
  /** oriented box: centre, unit length axis d, half length, half width (x-ish), half height */
  obb(cx: number, cy: number, cz: number, d: THREE.Vector3, hl: number, hw: number, hh: number, c: number, round = 0) {
    const up = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const sx = new THREE.Vector3().crossVectors(up, d).normalize();
    const sy = new THREE.Vector3().crossVectors(d, sx).normalize();
    // tight world-axis bounds of the oriented box
    const ex = Math.abs(d.x) * hl + Math.abs(sx.x) * hw + Math.abs(sy.x) * hh;
    const ey = Math.abs(d.y) * hl + Math.abs(sx.y) * hw + Math.abs(sy.y) * hh;
    const ez = Math.abs(d.z) * hl + Math.abs(sx.z) * hw + Math.abs(sy.z) * hh;
    this.fill(cx - ex, cx + ex, cy - ey, cy + ey, cz - ez, cz + ez, (x, y, z) => {
      const px = x - cx, py = y - cy, pz = z - cz;
      const l = px * d.x + py * d.y + pz * d.z;
      const u = px * sx.x + py * sx.y + pz * sx.z;
      const v = px * sy.x + py * sy.y + pz * sy.z;
      if (Math.abs(l) > hl || Math.abs(u) > hw || Math.abs(v) > hh) return -1;
      if (round > 0) {
        const du = Math.max(0, Math.abs(u) - (hw - round)), dv = Math.max(0, Math.abs(v) - (hh - round));
        if (du * du + dv * dv > round * round) return -1;
      }
      return c;
    });
  }

  /** greedy-mesh one part into a lit, vertex-coloured geometry relative to its pivot */
  meshPart(pid: number, pivot: THREE.Vector3): THREE.BufferGeometry | null {
    const b = this.pb[pid];
    if (b[1] < b[0]) return null;
    // tighten the loose box to the part's actual cells
    let i0 = 1e9, i1 = -1e9, j0 = 1e9, j1 = -1e9, k0 = 1e9, k1 = -1e9;
    for (let i = b[0]; i <= b[1]; i++)
      for (let k = b[4]; k <= b[5]; k++) {
        let a = this.at(i, b[2], k);
        for (let j = b[2]; j <= b[3]; j++, a++) {
          if (!this.mat[a] || this.part[a] !== pid) continue;
          if (i < i0) i0 = i;
          if (i > i1) i1 = i;
          if (j < j0) j0 = j;
          if (j > j1) j1 = j;
          if (k < k0) k0 = k;
          if (k > k1) k1 = k;
        }
      }
    if (i1 < i0) return null;
    const slabs: { md: MeshData; k0: number }[] = [];
    const sx = i1 - i0 + 3, sy = j1 - j0 + 3;
    for (let ks = k0; ks <= k1; ks += SLAB) {
      const ke = Math.min(k1, ks + SLAB - 1);
      const sz = ke - ks + 3;
      const vol = new Uint8Array(sx * sy * sz);
      // one cell of real neighbours on each side of the slab, so seams stay closed and lit alike
      for (let i = i0; i <= i1; i++)
        for (let k = Math.max(this.ka, ks - 1); k <= Math.min(this.kb, ke + 1); k++) {
          let a = this.at(i, j0, k);
          let o = ((i - i0 + 1) * sz + (k - ks + 1)) * sy + 1;
          for (let j = j0; j <= j1; j++, a++, o++) if (this.mat[a] && this.part[a] === pid) vol[o] = this.mat[a];
        }
      const md = greedyMesh(vol, sx, sy, sz);
      if (md.vertexCount) slabs.push({ md, k0: ks });
    }
    let n = 0, ni = 0;
    for (const s of slabs) {
      n += s.md.vertexCount;
      ni += s.md.indices.length;
    }
    if (!n) return null;
    const R = this.res;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), fin = new Float32Array(n * 2);
    const idx = n > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    const tc = new THREE.Color();
    const cols = this.pal.map((p) => new THREE.Color(p.col));
    let v0 = 0, w = 0;
    for (const { md, k0: ks } of slabs) {
      for (let s = 0; s < md.vertexCount; s++) {
        const v = v0 + s;
        pos[v * 3] = (i0 + md.positions[s * 4] - 0.5) * R - pivot.x;
        pos[v * 3 + 1] = (j0 + md.positions[s * 4 + 1] - 0.5) * R - pivot.y;
        pos[v * 3 + 2] = (ks + md.positions[s * 4 + 2] - 0.5) * R - pivot.z;
        const m = md.data[s * 4], ao = md.data[s * 4 + 1] / 255, face = md.data[s * 4 + 2];
        const ax = face >> 1, sg = face & 1 ? -1 : 1;
        nor[v * 3 + ax] = sg;
        const p = this.pal[m];
        tc.copy(cols[m]).multiplyScalar(p.glow > 0 ? 1 : 0.5 + 0.5 * ao * ao);
        col[v * 3] = tc.r;
        col[v * 3 + 1] = tc.g;
        col[v * 3 + 2] = tc.b;
        fin[v * 2] = p.spec;
        fin[v * 2 + 1] = p.glow;
      }
      for (let q = 0; q < md.indices.length; q++) idx[w++] = md.indices[q] + v0;
      v0 += md.vertexCount;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aFin', new THREE.BufferAttribute(fin, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }
}

const grids = new Map<number, VoxGrid>();
/** the grid the current recipe draws into */
let G: VoxGrid;
function useGrid(res: number) {
  let g = grids.get(res);
  if (!g) grids.set(res, (g = new VoxGrid(res)));
  G = g;
  G.reset();
  G.setPart('body');
}

/** true on the first `duty` fraction of every `period` metres (ribs, slots, knurling) */
function band(v: number, period: number, duty = 0.5) {
  const f = v / period + 1e-3;
  return f - Math.floor(f) < duty;
}

// ------------------------------------------------------------------------------ palette
const DARK = 0x464b52;
const BLACK = 0x33373c;
const STEEL = 0x60656b;
const BRASS = 0xc9a24a;
const GLASS = 0x1d3340;
const RUBBER = 0x161718;
const TRITIUM = 0x8dff6e;
const FIBRE = 0xff5a26;

function lighten(c: number, k: number) {
  const col = new THREE.Color(c);
  col.multiplyScalar(k);
  return col.getHex();
}

interface Ctx {
  def: WeaponDef;
  build: Build;
  L: number;
  B: number;
  bore: number;
  rw: number;
  top: number;
  yb: number;
  zR0: number;
  zR1: number;
  tip: number;
  rail: number;
  C: number;
  C2: number;
  A: number;
  D: number;
  K: number;
  S: number;
  meta: Omit<GunModel, 'key' | 'parts' | 'merged'>;
}

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------------------ shared parts
/** picatinny rail on top between z0 and z1: narrow spine, wide flanges, slotted crown */
function rail(cx: Ctx, z0: number, z1: number, w = 0.022) {
  const g = G, t = cx.top;
  g.boxc(w - 0.008, t, t + 0.012, z0, z1, cx.D);
  g.boxc(w, t + 0.004, t + 0.011, z0, z1, cx.D);
  g.fill(-w / 2, w / 2, t + 0.008, t + 0.012, z0 + 0.004, z1 - 0.004, (_x, _y, z) => (band(z - z0, 0.01, 0.5) ? 0 : -1));
}

function pistolGrip(cx: Ctx, z = 0, rake = 0.32, len = 0.11, col = cx.K) {
  const g = G;
  const tex = g.shade(col, 0.82);
  g.fill(-0.017, 0.017, -len, 0.005, z - 0.08, z + 0.05, (x, y, zz) => {
    const zc = z + 0.004 + y * rake;
    const dz = zz - zc;
    const base = y < -len + 0.01;
    const hw = base ? 0.0165 : 0.013;
    // rounded-rectangle section, a touch fuller at the palm swell
    const hz = 0.021 + (base ? 0.003 : 0) + Math.max(0, 0.003 - Math.abs(y + len * 0.45) * 0.08);
    const ex = Math.abs(x) / hw, ez = Math.abs(dz) / hz;
    if (ex ** 4 + ez ** 4 > 1) return -1;
    // finger grooves along the front strap
    if (!base && dz > hz - 0.005 && y < -0.018 && y > -len + 0.018 && band(y + 0.018, 0.022, 0.32)) return -1;
    // stippled side panels
    if (!base && Math.abs(x) > hw - 0.004 && Math.abs(dz) < hz - 0.006 && y < -0.012 && y > -len + 0.016) return band(y + zz, 0.01) ? tex : col;
    return col;
  });
}

function triggerGroup(cx: Ctx, z = 0, y0 = 0) {
  const g = G;
  // guard: thin loop from the grip to the front of the trigger well
  g.boxc(0.01, y0 - 0.034, y0 - 0.029, z + 0.022, z + 0.085, cx.D);
  g.boxc(0.01, y0 - 0.034, y0, z + 0.079, z + 0.085, cx.D);
  // curved trigger blade
  g.fill(0, 0, y0 - 0.026, y0, z + 0.035, z + 0.065, (_x, y, zz) => (Math.abs(zz - (z + 0.05 + (y - y0 + 0.013) ** 2 * 20)) < 0.004 ? cx.S : -1));
}

/**
 * Rear aperture: a one-voxel-thin octagonal ghost ring in the XY plane on a slim stem. The
 * opening is wide on purpose: up close it frames the target instead of hiding it.
 */
function aperture(cx: Ctx, x0: number, yS: number, z: number, yBase: number) {
  const g = G, zr = g.sn(z), HOLE = 0.018, RIM = 0.023;
  g.fill(x0 - RIM, x0 + RIM, yBase, yS + RIM, zr, zr, (x, y) => {
    const ax = Math.abs(x - x0), ay = Math.abs(y - yS);
    const n = Math.max(ax, ay, (ax + ay) * Math.SQRT1_2);
    if (n <= HOLE) return -1;
    if (n <= RIM) return cx.D;
    return ax <= 0.0075 && y < yS ? cx.D : -1;
  });
}

/**
 * Front sight: a one-voxel post whose glowing tip cell is centred on the sight axis (so the aim
 * point is the dot), flanked by two thin protective ears.
 */
function frontPost(cx: Ctx, x0: number, yS: number, z: number, yBase: number, tip = TRITIUM, ears = true) {
  const g = G, zf = g.sn(z), xs = g.sn(x0);
  g.fill(xs, xs, yBase, yS, zf, zf, (_x, y) => (y > yS - g.res * 0.5 ? g.c(tip, 0.3, 0.45) : cx.D));
  if (!ears) return;
  g.box(xs - 0.0175, xs - 0.0125, yBase, yS + 0.006, zf - 0.005, zf + 0.005, cx.D);
  g.box(xs + 0.0125, xs + 0.0175, yBase, yS + 0.006, zf - 0.005, zf + 0.005, cx.D);
}

/** rifle iron sights on the rail (folded flat when an optic is mounted) */
function ironSights(cx: Ctx, zRear: number, zFront: number, fold: boolean, frontFrom = cx.yb) {
  const g = G, D = cx.D, K = cx.K, rail = cx.rail;
  const yS = g.sn(rail + 0.028);
  const zr = g.sn(zRear + 0.016);
  const zf = g.sn(zFront - 0.012);
  if (fold) {
    // flip-up back-up sights folded flat under the optic
    g.boxc(0.022, rail, rail + 0.005, zRear, zRear + 0.026, D);
    g.boxc(0.016, rail + 0.005, rail + 0.009, zRear + 0.004, zRear + 0.022, K);
    g.boxc(0.016, Math.min(rail, frontFrom), rail + 0.005, zf - 0.012, zf + 0.008, D);
    g.boxc(0.012, rail + 0.005, rail + 0.009, zf - 0.016, zf + 0.004, K);
    return yS;
  }
  // rear: rail clamp with a cross bolt and a windage drum, then the aperture plate
  g.boxc(0.024, rail, rail + 0.005, zRear, zRear + 0.03, D);
  g.boxc(0.014, rail + 0.005, rail + 0.009, zRear + 0.004, zr + 0.008, D);
  g.cylX(rail + 0.0025, zRear + 0.024, 0.0025, -0.014, 0.014, cx.S);
  g.cylX(rail + 0.008, zr + 0.007, 0.005, -0.019, -0.012, K);
  aperture(cx, 0, yS, zr, rail + 0.005);
  // front: tower up from the barrel, a base plate, then post and ears
  g.fill(-0.008, 0.008, frontFrom, rail + 0.005, zf - 0.014, zf + 0.01, (x, y, z) => (Math.abs(x) > 0.005 && y > rail - 0.006 && (z < zf - 0.009 || z > zf + 0.005) ? -1 : D));
  g.boxc(0.036, rail + 0.002, rail + 0.006, zf - 0.006, zf + 0.006, D);
  frontPost(cx, 0, yS, zf, rail + 0.006);
  cx.meta.sight.set(0, yS, zr);
  cx.meta.zoom = 1.15;
  return yS;
}

/** optic on the rail; returns true if it provides the sight picture */
function optic(cx: Ctx, z0: number) {
  const g = G;
  const o = cx.build.optic ?? 'iron';
  const base = cx.rail;
  const D = cx.D, K = cx.K, S = cx.S;
  /** rail clamp with a cross bolt and a thumb nut on the left */
  const clamp = (za: number, zb: number, w: number, h: number) => {
    g.boxc(w, base, base + h, za, zb, D);
    g.boxc(w + 0.006, base, base + 0.004, za + 0.002, zb - 0.002, D);
    g.cylX(base + 0.002, (za + zb) / 2, 0.0025, -w / 2 - 0.004, w / 2 + 0.004, S);
    g.cylX(base + 0.002, (za + zb) / 2, 0.004, w / 2 + 0.003, w / 2 + 0.007, K);
  };
  switch (o) {
    case 'reddot': {
      // compact reflex sight: a squared-off tube with rounded corners (it stays clean at this
      // voxel size where a round tube would turn into a cog), thin walls and three small dials
      const r = 0.021, ri = 0.0165;
      const y = g.sn(base + 0.013 + r);
      const sq = (x: number, yy: number, h: number) => (Math.abs(x) / h) ** 4 + (Math.abs(yy - y) / h) ** 4;
      clamp(z0 + 0.008, z0 + 0.048, 0.024, 0.006);
      g.boxc(0.018, base + 0.005, y - r + 0.003, z0 + 0.012, z0 + 0.044, D);
      g.fill(-r - 0.002, r + 0.002, y - r - 0.002, y + r + 0.002, z0, z0 + 0.056, (x, yy, z) => {
        if (sq(x, yy, ri) <= 1) return -1;
        if (sq(x, yy, r) <= 1) return D;
        return z > z0 + 0.048 && sq(x, yy, r + 0.002) <= 1 ? K : -1; // objective lip
      });
      g.cylY(0, z0 + 0.028, 0.0065, y + r - 0.003, y + r + 0.006, K); // elevation
      g.cylX(y, z0 + 0.028, 0.0065, -r - 0.006, -r + 0.003, K); // windage
      g.cylX(y - 0.002, z0 + 0.026, 0.0085, r - 0.003, r + 0.007, K); // brightness dial
      g.fill(r + 0.004, r + 0.008, y - 0.011, y + 0.007, z0 + 0.017, z0 + 0.035, (_x, yy, z) => (Math.hypot(yy - y + 0.002, z - z0 - 0.026) < 0.0095 && band(yy + z, 0.01) ? D : -1));
      cx.meta.sight.set(0, y, z0 - 0.01);
      cx.meta.lens.set(0, y, z0 + 0.052);
      cx.meta.lensHalf.set(ri, ri);
      cx.meta.lensRound = ri * 0.55;
      cx.meta.reticle = 'dot';
      cx.meta.zoom = 1.3;
      return true;
    }
    case 'holo': {
      // holographic sight: battery body on the rail, an open window framed by a thin hood
      const wx = 0.0175;
      const y0 = base + 0.012, y1 = base + 0.05;
      const y = (y0 + y1) / 2;
      const zh0 = z0 + 0.026, zh1 = z0 + 0.09;
      clamp(z0 + 0.05, z0 + 0.08, 0.026, 0.004);
      g.fill(-0.017, 0.017, base + 0.004, y0, z0, zh1, (x, yy, z) => (Math.abs(x) > 0.013 && yy > y0 - 0.003 && z < zh0 ? -1 : D));
      g.boxc(0.026, base + 0.004, y0 - 0.002, z0 - 0.004, z0, K); // rear buttons
      g.box(0.017, 0.021, base + 0.004, y0 - 0.003, z0 + 0.006, z0 + 0.022, K); // side buttons
      g.fill(-wx - 0.005, wx + 0.005, y0, y1 + 0.005, zh0, zh1, (x, yy) => {
        const ax = Math.abs(x);
        if (ax <= wx && yy <= y1) return -1; // window
        if (ax > wx && yy > y1) return -1; // rounded hood corners
        return D;
      });
      g.boxc(0.028, y1 + 0.004, y1 + 0.006, zh0 + 0.004, zh1 - 0.004, K); // hood top pad
      cx.meta.sight.set(0, y, z0);
      cx.meta.lens.set(0, y, zh1 - 0.003);
      cx.meta.lensHalf.set(wx, (y1 - y0) / 2);
      cx.meta.lensRound = 0.003;
      cx.meta.reticle = 'holo';
      cx.meta.zoom = 1.25;
      return true;
    }
    case 'acog': {
      const y = g.sn(base + 0.032);
      clamp(z0 + 0.03, z0 + 0.12, 0.022, 0.012);
      g.cylZ(0, y, 0.02, z0 + 0.012, z0 + 0.13, D, 0.014);
      g.cylZ(0, y, 0.0255, z0 + 0.118, z0 + 0.16, D, 0.019); // objective bell
      g.cylZ(0, y, 0.022, z0 - 0.004, z0 + 0.016, K, 0.014); // eyepiece
      g.boxc(0.008, y + 0.019, y + 0.024, z0 + 0.03, z0 + 0.11, g.c(0x2fd060, 0.4, 0.5)); // fibre optic
      g.cylY(0, z0 + 0.07, 0.006, y + 0.018, y + 0.026, K);
      g.cylX(y, z0 + 0.07, 0.006, -0.026, -0.018, K);
      g.cylZ(0, y, 0.019, z0 + 0.156, z0 + 0.156, g.c(GLASS, 1));
      cx.meta.sight.set(0, y, z0 - 0.04);
      cx.meta.zoom = 3;
      cx.meta.scoped = true;
      return true;
    }
    case 'scope8': {
      const y = g.sn(base + 0.034);
      // rings
      for (const zr of [z0 + 0.02, z0 + 0.14]) {
        g.boxc(0.022, base, y - 0.01, zr, zr + 0.02, D);
        g.cylZ(0, y, 0.0185, zr, zr + 0.02, D, 0.014);
        g.cylX(y + 0.012, zr + 0.01, 0.0025, -0.012, 0.012, S);
      }
      g.cylZ(0, y, 0.015, z0 - 0.03, z0 + 0.22, K, 0.01); // main tube
      g.cylZ(0, y, 0.026, z0 + 0.21, z0 + 0.28, K, 0.02); // objective bell
      g.fill(-0.022, 0.022, y - 0.022, y + 0.022, z0 + 0.18, z0 + 0.21, (x, yy, z) => (Math.hypot(x, yy - y) <= 0.015 + (z - z0 - 0.18) * 0.37 ? K : -1));
      g.cylZ(0, y, 0.021, z0 - 0.08, z0 - 0.025, K, 0.015); // eyepiece
      g.cylZ(0, y, 0.022, z0 - 0.09, z0 - 0.078, RUBBER, 0.016);
      g.cylY(0, z0 + 0.09, 0.011, y + 0.013, y + 0.031, D); // elevation turret
      g.cylY(0, z0 + 0.09, 0.012, y + 0.026, y + 0.032, g.c(lighten(STEEL, 0.9), 0.8));
      g.cylX(y, z0 + 0.09, 0.011, -0.033, -0.013, D); // windage turret
      g.cylX(y, z0 + 0.09, 0.009, 0.013, 0.029, D); // parallax knob
      g.cylZ(0, y, 0.0215, z0 + 0.278, z0 + 0.278, g.c(GLASS, 1));
      cx.meta.sight.set(0, y, z0 - 0.12);
      cx.meta.zoom = 7;
      cx.meta.scoped = true;
      return true;
    }
    case 'thermal': {
      const y = g.sn(base + 0.034);
      const body = g.c(0x34413a, 0.3);
      clamp(z0 + 0.05, z0 + 0.12, 0.03, 0.006);
      g.fill(-0.025, 0.025, base + 0.006, base + 0.06, z0 + 0.01, z0 + 0.15, (x, yy) => (Math.abs(x) > 0.02 && (yy > base + 0.055 || yy < base + 0.011) ? -1 : body));
      g.cylZ(0, y, 0.021, z0 + 0.15, z0 + 0.175, K); // lens housing
      g.cylZ(0, y, 0.017, z0 + 0.176, z0 + 0.176, g.c(0x6a3a20, 1, 0.25));
      g.cylZ(0, y, 0.017, z0 - 0.035, z0 + 0.01, RUBBER, 0.011); // eyecup
      g.box(0.025, 0.031, base + 0.02, base + 0.042, z0 + 0.04, z0 + 0.1, K); // battery door
      for (const zb of [z0 + 0.04, z0 + 0.06, z0 + 0.08]) g.cylY(-0.008 + (zb - z0 - 0.06) * 0.4, zb, 0.0045, base + 0.058, base + 0.064, K);
      cx.meta.sight.set(0, y, z0 - 0.06);
      cx.meta.zoom = 3.5;
      cx.meta.scoped = true;
      return true;
    }
  }
  return false;
}

/** barrel from zFrom to the tip, with the build's barrel variant; returns the tip */
function barrel(cx: Ctx, zFrom: number, r: number) {
  const b = cx.build.barrel;
  let tip = cx.tip;
  if (b === 'short') tip = zFrom + (tip - zFrom) * 0.72;
  if (b === 'long') tip += 0.12;
  const rr = b === 'heavy' ? r * 1.45 : r;
  G.cylZ(0, cx.yb, rr, zFrom, tip, cx.D);
  if (b === 'heavy') G.fill(-rr - 0.004, rr + 0.004, cx.yb - rr - 0.004, cx.yb + rr + 0.004, zFrom + 0.02, tip - 0.03, (x, y, z) => (Math.hypot(x, y - cx.yb) <= rr + 0.004 && band(z - zFrom, 0.03, 0.3) ? cx.S : -1));
  if (b === 'rifled') G.fill(-rr - 0.003, rr + 0.003, cx.yb - rr - 0.003, cx.yb + rr + 0.003, zFrom + 0.01, tip - 0.01, (x, y, z) => (Math.hypot(x, y - cx.yb) <= rr + 0.003 && band(z - zFrom, 0.05, 0.2) ? cx.S : -1));
  cx.tip = tip;
  return tip;
}

function muzzleDevice(cx: Ctx, r: number) {
  const g = G;
  const mz = cx.build.muzzle;
  const t = cx.tip, y = cx.yb;
  let end = t;
  if (mz === 'suppressor') {
    const R = Math.max(0.018, r * 1.9);
    g.cylZ(0, y, R, t, t + 0.16, BLACK);
    g.fill(-R - 0.003, R + 0.003, y - R - 0.003, y + R + 0.003, t, t + 0.026, (x, yy, z) => (Math.hypot(x, yy - y) <= R + 0.0025 && (z < t + 0.008 || band(z - t, 0.006, 0.5)) ? cx.D : -1)); // knurled mount
    g.cylZ(0, y, R + 0.002, t + 0.145, t + 0.16, cx.D);
    g.cylZ(0, y, R * 0.55, t + 0.16, t + 0.16, cx.D, r * 0.6);
    end = t + 0.16;
  } else if (mz === 'compensator') {
    const R = r * 1.5;
    g.cylZ(0, y, R, t, t + 0.05, cx.D);
    // three ports through the top
    g.fill(-0.005, 0.005, y + r * 0.4, y + R + 0.002, t + 0.01, t + 0.044, (_x, _y, z) => (band(z - t - 0.01, 0.012, 0.42) ? 0 : -1));
    end = t + 0.05;
  } else if (mz === 'brake') {
    const w = r * 2.2, h = r * 1.35;
    g.fill(-w, w, y - h, y + h, t, t + 0.06, (x, yy, z) => {
      if (Math.abs(x) > w - 0.003 && Math.abs(yy - y) > h - 0.003) return -1;
      // side baffles with open ports between them
      if (Math.abs(x) > r * 1.1 && Math.abs(yy - y) < h - 0.004 && z > t + 0.008 && z < t + 0.054 && band(z - t - 0.008, 0.012, 0.55)) return 0;
      return cx.A;
    });
    end = t + 0.06;
  } else if (mz === 'flashhider') {
    const R = r * 1.4;
    g.cylZ(0, y, R, t, t + 0.045, cx.D);
    // birdcage slots at the four diagonals, closed at the bottom
    g.fill(-R - 0.002, R + 0.002, y - R - 0.002, y + R + 0.002, t + 0.014, t + 0.045, (x, yy) => {
      const a = Math.atan2(yy - y, x);
      if (Math.hypot(x, yy - y) < r * 0.5 || a < -0.6 && a > -2.5) return -1;
      const s = Math.abs(((a + Math.PI * 2) % (Math.PI / 2)) - Math.PI / 4);
      return s < 0.3 ? 0 : -1;
    });
    end = t + 0.045;
  } else if (mz === 'choke') {
    // duckbill: flattens the pattern into a wide, low fan
    g.fill(-r * 1.9, r * 1.9, y - r * 0.9, y + r * 0.9, t, t + 0.06, (x, yy, z) => {
      const k = (z - t) / 0.06;
      if (Math.abs(yy - y) > r * (0.9 - 0.4 * k)) return -1;
      if (Math.abs(x) > r * (1.1 + 0.8 * k)) return -1;
      return cx.D;
    });
    g.fill(-r * 1.5, r * 1.5, y - 0.002, y + 0.002, t + 0.03, t + 0.06, 0);
    end = t + 0.06;
  } else {
    g.cylZ(0, y, r * 1.18, t - 0.012, t, cx.D); // crown
  }
  // bore
  g.cylZ(0, y, Math.max(0.0045, r * 0.45), end - 0.01, end, 0);
  cx.meta.muzzle.set(0, y, end + 0.01);
}

function underbarrel(cx: Ctx, z: number, yBot: number) {
  const g = G;
  const u = cx.build.underbarrel;
  const K = cx.K;
  if (u === 'vgrip') {
    g.boxc(0.024, yBot - 0.006, yBot, z - 0.022, z + 0.022, cx.D); // rail clamp
    g.fill(-0.0145, 0.0145, yBot - 0.088, yBot - 0.005, z - 0.017, z + 0.017, (x, y, zz) => {
      const r = Math.hypot(x, (zz - z) * 0.92);
      if (r > 0.0145 - Math.max(0, y - yBot + 0.012) * 0.2) return -1;
      if (y < yBot - 0.08) return cx.D; // end cap
      return r > 0.011 && band(y, 0.01, 0.34) ? g.shade(K, 0.75) : K;
    });
    cx.meta.gripL.set(0, yBot - 0.045, z);
  } else if (u === 'agrip') {
    g.fill(-0.013, 0.013, yBot - 0.042, yBot, z - 0.055, z + 0.035, (x, y, zz) => {
      if (zz - z < -0.05 + (yBot - y) * 1.2 || zz - z > 0.03 - (yBot - y) * 0.6) return -1;
      if (Math.abs(x) > 0.009 && y < yBot - 0.036) return -1;
      return band(zz, 0.012, 0.25) && Math.abs(x) > 0.009 ? g.shade(K, 0.75) : K;
    });
    cx.meta.gripL.set(0, yBot - 0.03, z - 0.02);
  } else if (u === 'laser') {
    g.fill(-0.013, 0.013, yBot - 0.03, yBot, z, z + 0.06, (x, y) => (Math.abs(x) > 0.009 && y < yBot - 0.026 ? -1 : K));
    g.cylZ(0, yBot - 0.017, 0.006, z + 0.06, z + 0.063, cx.S);
    g.cylZ(0, yBot - 0.017, 0.003, z + 0.063, z + 0.063, g.c(0xff2a22, 0.5, 1));
    g.box(-0.019, -0.013, yBot - 0.024, yBot - 0.008, z + 0.01, z + 0.03, cx.D); // switch
  } else if (u === 'bipod') {
    g.boxc(0.03, yBot - 0.014, yBot, z + 0.04, z + 0.07, cx.D);
    g.cylX(yBot - 0.01, z + 0.055, 0.004, -0.02, 0.02, cx.S);
    for (const sx of [-1, 1]) {
      const x0 = sx > 0 ? 0.006 : -0.016, x1 = sx > 0 ? 0.016 : -0.006;
      g.box(x0, x1, yBot - 0.018, yBot - 0.008, z - 0.18, z + 0.05, cx.D);
      g.box(x0 + 0.002 * sx, x1 - 0.002 * sx, yBot - 0.016, yBot - 0.01, z - 0.12, z - 0.02, cx.S); // extension leg
      g.box(sx > 0 ? 0.004 : -0.018, sx > 0 ? 0.018 : -0.004, yBot - 0.022, yBot - 0.006, z - 0.19, z - 0.17, RUBBER);
    }
  }
}

/** magazine for box/curved types, as its own part so reloads can drop it */
function boxMag(cx: Ctx, z: number, y0: number, curved: boolean, w: number, d: number, len: number) {
  const g = G;
  const mag = cx.build.magazine ?? 'stdmag';
  g.setPart('mag');
  const col = cx.K;
  const ribC = g.c(lighten(BLACK, 1.5), 0.2);
  if (mag === 'drum') {
    g.boxc(w, y0 - 0.03, y0, z - d / 2, z + d / 2, col);
    for (const sx of [-1, 1]) {
      const xa = sx > 0 ? 0.006 : -0.038, xb = sx > 0 ? 0.038 : -0.006;
      g.cylX(y0 - 0.075, z + 0.01, 0.06, xa, xb, cx.D);
      g.cylX(y0 - 0.075, z + 0.01, 0.061, sx > 0 ? 0.031 : -0.038, sx > 0 ? 0.038 : -0.031, cx.K, 0.054); // rim
      g.cylX(y0 - 0.075, z + 0.01, 0.022, sx > 0 ? 0.036 : -0.043, sx > 0 ? 0.043 : -0.036, cx.A);
      g.cylX(y0 - 0.075, z + 0.01, 0.008, sx > 0 ? 0.042 : -0.046, sx > 0 ? 0.046 : -0.042, cx.S); // winding key
    }
    g.boxc(0.012, y0 - 0.14, y0 - 0.02, z - 0.04, z + 0.06, cx.D);
    cx.meta.magAt.set(0, y0 - 0.08, z);
  } else {
    const L = mag === 'extmag' ? len * 1.45 : mag === 'fastmag' ? len * 0.95 : len;
    g.fill(-w / 2 - 0.003, w / 2 + 0.003, y0 - L - 0.012, y0, z - d / 2 - 0.03, z + d / 2 + 0.06, (x, y, zz) => {
      const dy = y0 - y;
      const zc = z + (curved ? dy * dy * 1.6 : dy * 0.06);
      const dz = zz - zc;
      // base plate with a lip
      if (dy > L) return Math.abs(dz) <= d / 2 + 0.004 && Math.abs(x) <= w / 2 + 0.002 ? cx.D : -1;
      if (Math.abs(dz) > d / 2 || Math.abs(x) > w / 2) return -1;
      // pressed ribs down the sides, a spine down the back
      if (Math.abs(x) >= w / 2 - 0.003 && Math.abs(dz) < d / 2 - 0.007 && dy > 0.02 && band(dy, 0.035, 0.2)) return ribC;
      if (dz < -d / 2 + 0.004 && Math.abs(x) > w / 2 - 0.004) return g.shade(col, 0.85);
      return col;
    });
    if (mag === 'fastmag') {
      const dy = L + 0.012, zc = z + (curved ? dy * dy * 1.6 : dy * 0.06);
      g.boxc(0.008, y0 - dy - 0.025, y0 - dy, zc - 0.01, zc + 0.01, g.c(0xd04a2a, 0.2)); // pull loop
      g.boxc(0.008, y0 - dy - 0.025, y0 - dy - 0.015, zc - 0.005, zc + 0.005, 0);
    }
    const dy = L * 0.6;
    cx.meta.magAt.set(0, y0 - dy, z + (curved ? dy * dy * 1.6 : 0));
  }
  g.setPart('body');
}

function stock(cx: Ctx, kind: 'adjust' | 'fold' | 'precision' | 'wood' | 'lmg' | 'skeleton') {
  const g = G;
  const s = cx.build.stock;
  const z0 = cx.zR0;
  const len = cx.def.model.stock * (s === 'lightstock' ? 0.85 : 1);
  const yb = cx.yb;
  if (len <= 0) return;
  if (s === 'nostock') {
    g.cylZ(0, yb - 0.006, 0.014, z0 - 0.03, z0, cx.D);
    g.cylZ(0, yb - 0.006, 0.016, z0 - 0.036, z0 - 0.03, RUBBER);
    return;
  }
  const heavy = s === 'heavystock';
  const light = s === 'lightstock';
  const bodyC = heavy ? cx.A : kind === 'wood' ? cx.C : cx.K;
  const zE = z0 - len;
  if (kind === 'fold' || (light && kind !== 'wood')) {
    // wire / skeleton stock
    for (const sx of [-1, 1]) g.box(sx > 0 ? 0.009 : -0.015, sx > 0 ? 0.015 : -0.009, yb - 0.003, yb + 0.004, zE, z0, cx.D);
    g.box(-0.015, 0.015, yb - 0.075, yb + 0.01, zE, zE + 0.01, cx.D);
    g.box(-0.015, 0.015, yb - 0.075, yb - 0.065, zE + 0.01, zE + len * 0.55, cx.D);
    g.box(-0.012, 0.012, yb - 0.07, yb + 0.004, zE + 0.004, zE + 0.006, 0);
    g.box(-0.018, 0.018, yb - 0.078, yb + 0.013, zE - 0.008, zE, RUBBER);
    g.cylX(yb, z0 - 0.006, 0.006, -0.018, 0.018, cx.S); // hinge
    return;
  }
  if (kind === 'adjust') {
    g.cylZ(0, yb - 0.008, 0.0135, zE + 0.04, z0, cx.D); // buffer tube
    g.fill(-0.012, 0.012, yb - 0.026, yb - 0.02, zE + 0.05, z0 - 0.01, (_x, _y, z) => (band(z, 0.016, 0.4) ? cx.D : -1)); // position notches
    g.cylZ(0, yb - 0.008, 0.016, z0 - 0.012, z0, cx.D); // castle nut
    g.fill(-0.019, 0.019, yb - 0.075, yb + 0.022, zE, zE + len * 0.62, (x, y, z) => {
      const t = (z - zE) / (len * 0.62);
      const yTop = yb + 0.022 - t * 0.004;
      const yBot = yb - 0.075 + t * 0.055;
      if (y > yTop || y < yBot) return -1;
      if (Math.abs(x) > 0.015 && (y > yTop - 0.004 || y < yBot + 0.004)) return -1;
      // sling slot and a recessed side panel
      if (y < yBot + 0.012 && y > yBot + 0.004 && t > 0.12 && t < 0.32) return 0;
      if (Math.abs(x) > 0.016 && y > yBot + 0.012 && y < yTop - 0.012 && t > 0.15 && t < 0.85) return g.shade(bodyC, 0.82);
      return bodyC;
    });
    if (heavy) g.boxc(0.03, yb + 0.022, yb + 0.034, zE + 0.03, zE + len * 0.5, cx.A); // cheek riser
    g.fill(-0.02, 0.02, yb - 0.078, yb + 0.024, zE - 0.012, zE, (x, y) => (Math.abs(x) > 0.016 && (y > yb + 0.02 || y < yb - 0.074) ? -1 : band(y, 0.008, 0.3) ? g.c(lighten(RUBBER, 1.6), 0.05) : RUBBER));
    // lever under the tube
    g.boxc(0.01, yb - 0.03, yb - 0.022, zE + len * 0.62, zE + len * 0.7, cx.D);
    return;
  }
  if (kind === 'precision' || kind === 'lmg' || kind === 'skeleton') {
    const hb = kind === 'lmg' ? 0.03 : 0;
    g.fill(-0.017, 0.017, yb - 0.085 - hb, yb + 0.03, zE, z0, (x, y, z) => {
      const t = (z - zE) / len;
      const yTop = yb + 0.028;
      const yBot = yb - 0.085 - hb + t * 0.05;
      if (y > yTop || y < yBot) return -1;
      // lightening window
      if (y > yBot + 0.018 && y < yTop - 0.03 && t > 0.18 && t < 0.82) return -1;
      if (Math.abs(x) > 0.013 && (y > yTop - 0.004 || y < yBot + 0.004)) return -1;
      return bodyC;
    });
    if (kind === 'precision') {
      g.boxc(0.03, yb + 0.03, yb + 0.042, zE + 0.03, zE + len * 0.55, heavy ? cx.A : cx.C); // cheek piece
      g.cylY(-0.008, zE + len * 0.5, 0.004, yb + 0.022, yb + 0.034, cx.S);
      g.cylY(-0.008, zE + 0.05, 0.004, yb + 0.022, yb + 0.034, cx.S);
      g.boxc(0.012, yb - 0.115, yb - 0.08, zE + 0.03, zE + 0.045, cx.D); // monopod spike
      g.cylY(0, zE + 0.0375, 0.008, yb - 0.12, yb - 0.112, RUBBER);
    }
    g.fill(-0.019, 0.019, yb - 0.09 - hb, yb + 0.032, zE - 0.012, zE, (x, y) => (Math.abs(x) > 0.015 && (y > yb + 0.028 || y < yb - 0.086 - hb) ? -1 : RUBBER));
    return;
  }
  // wood
  const grain = g.shade(heavy ? cx.A : cx.C, 0.88);
  g.fill(-0.02, 0.02, yb - 0.1, yb + 0.02, zE, z0, (x, y, z) => {
    const t = (z - zE) / len;
    const yTop = yb + 0.018 - t * 0.012;
    const yBot = yb - 0.1 + t * 0.09;
    if (y > yTop || y < yBot) return -1;
    const w = 0.014 + (1 - t) * 0.005;
    if (Math.abs(x) > w) return -1;
    if (Math.abs(x) > w - 0.004 && (y > yTop - 0.005 || y < yBot + 0.005)) return -1;
    // long grain streaks
    return band(y + Math.sin(z * 60) * 0.004, 0.012, 0.18) ? grain : heavy ? cx.A : cx.C;
  });
  g.cylX(yb - 0.075, zE + 0.05, 0.005, -0.017, 0.017, cx.S); // sling swivel
  g.fill(-0.017, 0.017, yb - 0.098, yb + 0.02, zE - 0.012, zE, (x, y) => (Math.abs(x) > 0.013 && (y > yb + 0.016 || y < yb - 0.094) ? -1 : RUBBER));
}

// ------------------------------------------------------------------------------ recipes
function rifle(cx: Ctx) {
  const g = G;
  const id = cx.def.id;
  // the receiver is the rear part of the body; the handguard covers the rest
  cx.zR1 = cx.zR0 + cx.L * (id === 'lmg' ? 0.66 : id === 'smg' ? 0.72 : 0.58);
  const { zR0, zR1, rw, top, yb, D, K, C, C2, A } = cx;
  const lowerTop = 0.04;
  const zLow1 = Math.min(zR1, 0.22);
  // lower receiver with a flared magwell
  g.fill(-rw / 2, rw / 2, 0, lowerTop, zR0 + 0.02, zLow1, (x, y, z) => (Math.abs(x) > rw / 2 - 0.003 && y < 0.004 && (z < 0.06 || z > 0.17) ? -1 : C));
  g.boxc(rw + 0.006, -0.002, 0.006, 0.065, 0.165, C);
  g.boxc(rw - 0.01, lowerTop - 0.004, lowerTop, zR0 + 0.02, zLow1, g.shade(C, 0.8));
  // upper receiver with chamfered top edges
  g.fill(-rw / 2, rw / 2, lowerTop, top, zR0, zR1, (x, y) => (Math.abs(x) > rw / 2 - 0.004 && y > top - 0.004 ? -1 : C2));
  g.boxc(rw + 0.004, lowerTop + 0.004, lowerTop + 0.011, zR0 + 0.02, zR1 - 0.02, C); // seam ridge
  // ejection port (right side) with the bolt carrier showing through, dust cover hinge below
  g.box(-rw / 2, -rw / 2 + 0.006, lowerTop + 0.014, top - 0.016, 0.07, 0.15, 0);
  g.box(-rw / 2 + 0.006, -rw / 2 + 0.01, lowerTop + 0.014, top - 0.016, 0.07, 0.15, cx.S);
  g.fill(-rw / 2 + 0.006, -rw / 2 + 0.01, lowerTop + 0.022, lowerTop + 0.03, 0.08, 0.14, (_x, _y, z) => (band(z, 0.02, 0.5) ? g.shade(cx.S, 0.7) : -1));
  g.box(-rw / 2 - 0.003, -rw / 2, lowerTop + 0.011, lowerTop + 0.014, 0.068, 0.152, D);
  if (id === 'ar') g.box(-rw / 2 - 0.008, -rw / 2, top - 0.022, top - 0.008, 0.052, 0.068, C2); // brass deflector
  // forward assist + charging handle
  g.cylZ(-rw / 2 - 0.006, top - 0.022, 0.006, -0.002, 0.034, D);
  g.boxc(0.012, top - 0.012, top, zR0 - 0.016, zR0 + 0.01, D);
  g.boxc(0.032, top - 0.012, top - 0.004, zR0 - 0.02, zR0 - 0.012, D);
  // selector, bolt catch, mag release (accents)
  g.cylX(0.025, -0.022, 0.004, rw / 2, rw / 2 + 0.003, cx.S);
  g.box(rw / 2, rw / 2 + 0.004, 0.022, 0.028, -0.034, -0.012, A);
  g.box(rw / 2, rw / 2 + 0.003, 0.016, 0.034, 0.03, 0.044, D);
  g.cylX(0.012, 0.068, 0.0045, -rw / 2 - 0.004, -rw / 2, A);
  // takedown pins
  for (const z of [zR0 + 0.035, zLow1 - 0.02]) g.cylX(0.022, z, 0.0035, -rw / 2 - 0.002, rw / 2 + 0.002, cx.S);
  pistolGrip(cx, 0, 0.32, 0.11);
  triggerGroup(cx, 0, 0);

  // handguard
  const hgEnd = zR1 + (cx.tip - zR1) * (id === 'smg' ? 0.85 : 0.62);
  const hgR = id === 'lmg' ? 0.036 : id === 'smg' ? 0.024 : 0.028;
  if (id === 'dmr') {
    // wooden fore-end with a steel cap
    const grain = g.shade(C, 0.88);
    g.fill(-0.022, 0.022, yb - 0.04, yb + 0.018, zR1, hgEnd, (x, y, z) => {
      if (Math.abs(x) > 0.018 && (y > yb + 0.014 || y < yb - 0.036)) return -1;
      if (y > yb + 0.008 && Math.abs(x) < 0.012) return -1; // barrel channel
      return band(y + Math.sin(z * 40) * 0.003, 0.011, 0.2) ? grain : C;
    });
    g.cylZ(0, yb, 0.02, hgEnd, hgEnd + 0.02, D);
  } else if (id === 'sniper') {
    // flat-sided chassis fore-end with lightening cuts
    g.fill(-0.022, 0.022, yb - 0.04, yb + 0.022, zR1, hgEnd, (x, y) => (Math.abs(x) > 0.018 && (y > yb + 0.018 || y < yb - 0.036) ? -1 : C));
    g.fill(-0.023, 0.023, yb - 0.028, yb + 0.01, zR1 + 0.03, hgEnd - 0.03, (x, _y, z) => (Math.abs(x) > 0.018 && band(z - zR1 - 0.03, 0.06, 0.5) ? 0 : -1));
  } else {
    g.fill(-hgR, hgR, yb - hgR, yb + hgR, zR1, hgEnd, (x, y, z) => {
      const ax = Math.abs(x), ay = Math.abs(y - yb);
      if (ax + ay > hgR * 1.35) return -1; // octagon
      // vent slots along the sides
      if (ax > hgR - 0.006 && ay < hgR * 0.45 && z > zR1 + 0.02 && z < hgEnd - 0.02 && band(z - zR1, 0.025, 0.42)) return -1;
      if (y < yb - hgR + 0.004 && z > zR1 + 0.02 && z < hgEnd - 0.02 && band(z - zR1, 0.04, 0.5)) return g.shade(A, 0.75);
      return A;
    });
    g.cylZ(0, yb, hgR * 0.95, hgEnd - 0.004, hgEnd, D); // end cap
    if (id === 'lmg') {
      // heavy barrel shroud with cooling holes; carry handle offset to the left, clear of the sights
      g.cylZ(0, yb, 0.024, hgEnd, cx.tip - 0.08, D);
      g.fill(-0.025, 0.025, yb - 0.025, yb + 0.025, hgEnd + 0.01, cx.tip - 0.09, (x, y, z) => (Math.hypot(x, y - yb) > 0.019 && Math.abs(y - yb) < 0.011 && band(z - hgEnd, 0.02, 0.4) ? 0 : -1));
      g.box(0.03, 0.04, yb + 0.006, top + 0.012, hgEnd - 0.12, hgEnd - 0.106, D);
      g.box(0.03, 0.04, yb + 0.006, top + 0.012, hgEnd - 0.02, hgEnd - 0.006, D);
      g.box(0.032, 0.05, top + 0.004, top + 0.018, hgEnd - 0.12, hgEnd - 0.006, K);
    }
  }
  const tip = barrel(cx, hgEnd - 0.02, cx.bore * 0.32);
  if (id === 'sniper') {
    // fluted barrel
    const r = cx.bore * 0.32;
    g.fill(-r, r, yb - r, yb + r, hgEnd + 0.04, tip - 0.06, (x, y) => {
      const a = Math.atan2(y - yb, x);
      return Math.hypot(x, y - yb) > r * 0.72 && Math.abs(((a + Math.PI * 2) % (Math.PI / 3)) - Math.PI / 6) < 0.22 ? 0 : -1;
    });
  }
  // gas block
  if (id !== 'sniper' && id !== 'dmr') {
    g.cylZ(0, yb, cx.bore * 0.32 + 0.008, hgEnd, hgEnd + 0.025, D);
    g.cylX(yb + 0.004, hgEnd + 0.0125, 0.003, -0.012, 0.012, cx.S);
  }
  muzzleDevice(cx, cx.bore * 0.32);

  // rail and sights
  if (id !== 'dmr') rail(cx, zR0 + 0.01, id === 'smg' || id === 'lmg' ? zR1 : hgEnd - 0.01);
  else rail(cx, zR0 + 0.04, zR0 + 0.22);
  const hasOptic = optic(cx, id === 'smg' ? zR0 + 0.04 : zR0 + 0.07);
  const zFront = id === 'lmg' ? tip - 0.1 : id === 'sniper' ? hgEnd - 0.005 : id === 'dmr' ? hgEnd + 0.012 : hgEnd - 0.005;
  ironSights(cx, zR0 + 0.01, zFront, hasOptic, id === 'lmg' ? yb + 0.02 : yb);

  // magazine
  if (id === 'lmg') {
    g.setPart('mag');
    // belt box on the left with a brass belt feeding the receiver
    g.fill(0.03, 0.09, -0.11, 0.0, 0.03, 0.16, (x, y, z) => (x > 0.087 && y < -0.02 && y > -0.09 && z > 0.06 && z < 0.13 ? cx.D : y > -0.004 ? cx.D : x > 0.085 && band(y, 0.03, 0.15) ? g.shade(cx.A, 0.8) : cx.A));
    g.fill(rw / 2 - 0.004, 0.032, 0.0, 0.03, 0.06, 0.12, (x, y, z) => (y > x * 0.5 - 0.01 ? (band(z, 0.012, 0.6) ? g.c(BRASS, 0.9) : -1) : -1));
    g.setPart('body');
    // feed cover with latch
    g.boxc(rw + 0.004, top, top + 0.012, zR0 + 0.03, 0.18, D);
    g.boxc(0.012, top + 0.012, top + 0.018, zR0 + 0.03, zR0 + 0.05, cx.S);
    cx.meta.magAt.set(0.06, -0.05, 0.1);
  } else if (id === 'smg') {
    boxMag(cx, 0.1, 0, false, 0.022, 0.034, 0.13);
  } else if (id === 'sniper') {
    boxMag(cx, 0.08, 0, false, 0.03, 0.06, 0.05);
    // bolt handle on the right
    g.box(-rw / 2 - 0.03, -rw / 2, top - 0.022, top - 0.014, -0.03, -0.022, cx.S);
    g.fill(-rw / 2 - 0.05, -rw / 2 - 0.026, top - 0.042, top - 0.018, -0.038, -0.012, (x, y, z) => (Math.hypot(x + rw / 2 + 0.04, y - top + 0.03, z + 0.025) < 0.012 ? D : -1));
  } else if (id === 'dmr') {
    boxMag(cx, 0.1, 0, false, 0.03, 0.058, 0.085);
    g.box(-rw / 2 - 0.012, -rw / 2, lowerTop + 0.012, lowerTop + 0.022, 0.12, 0.2, cx.S); // op rod
    g.box(-rw / 2 - 0.02, -rw / 2 - 0.012, lowerTop + 0.01, lowerTop + 0.024, 0.19, 0.2, cx.S);
  } else {
    boxMag(cx, 0.115, 0, true, 0.026, 0.06, 0.15);
  }

  // stock
  stock(cx, id === 'smg' ? 'fold' : id === 'sniper' ? 'precision' : id === 'dmr' ? 'wood' : id === 'lmg' ? 'lmg' : 'adjust');
  underbarrel(cx, zR1 + (hgEnd - zR1) * 0.45, yb - hgR - 0.002);
  if (!cx.build.underbarrel || cx.build.underbarrel === 'nounder' || cx.build.underbarrel === 'laser' || cx.build.underbarrel === 'bipod')
    cx.meta.gripL.set(0, yb - hgR - 0.012, zR1 + (hgEnd - zR1) * 0.55);
  if (id === 'lmg' || id === 'sniper') {
    // folded bipod on heavy guns is part of their look even without the attachment
    if (cx.build.underbarrel !== 'bipod') {
      g.boxc(0.024, yb - hgR - 0.012, yb - hgR, hgEnd - 0.06, hgEnd - 0.02, D);
      g.cylX(yb - hgR - 0.006, hgEnd - 0.04, 0.004, -0.014, 0.014, cx.S);
    }
  }
}

function shotgun(cx: Ctx) {
  const g = G;
  const { zR0, zR1, rw, top, yb, D, K, C, A } = cx;
  // receiver (metal) with rounded top edges and a polished side flat
  g.fill(-rw / 2, rw / 2, -0.005, top, zR0, zR1, (x, y) => {
    const ax = Math.abs(x);
    if (ax > rw / 2 - 0.004 && y > top - 0.008) return -1;
    if (ax > rw / 2 - 0.008 && y > top - 0.003) return -1;
    return y > 0.025 && y < top - 0.02 && ax > rw / 2 - 0.003 ? g.shade(A, 1.15) : A;
  });
  g.box(-rw / 2, -rw / 2 + 0.006, 0.04, top - 0.016, 0.03, 0.12, 0); // ejection port
  g.box(-rw / 2 + 0.006, -rw / 2 + 0.01, 0.04, top - 0.016, 0.03, 0.12, cx.S);
  g.cylX(0.02, 0.065, 0.0035, -rw / 2 - 0.002, rw / 2 + 0.002, cx.S); // trigger pins
  g.cylX(0.02, -0.03, 0.0035, -rw / 2 - 0.002, rw / 2 + 0.002, cx.S);
  // side saddle with shells on the left
  g.box(rw / 2, rw / 2 + 0.006, 0.016, top - 0.008, zR0 + 0.03, zR0 + 0.142, K);
  for (let i = 0; i < 4; i++) {
    const z = zR0 + 0.044 + i * 0.027;
    g.cylY(rw / 2 + 0.016, z, 0.0105, 0.022, top - 0.022, g.c(0xb8302a, 0.2));
    g.cylY(rw / 2 + 0.016, z, 0.0105, top - 0.022, top - 0.01, g.c(BRASS, 0.9));
    g.cylY(rw / 2 + 0.016, z, 0.004, top - 0.01, top - 0.01, g.shade(g.c(BRASS, 0.9), 0.7));
  }
  pistolGrip(cx, 0, 0.34, 0.11, K);
  triggerGroup(cx, 0, 0);
  const br = cx.bore * 0.3;
  const tip = barrel(cx, zR1 - 0.01, br);
  // low vent rib along the barrel
  g.boxc(0.008, yb + br, yb + br + 0.005, zR1, tip - 0.012, D);
  g.fill(-0.004, 0.004, yb + br + 0.005, yb + br + 0.009, zR1, tip - 0.012, (_x, _y, z) => (band(z - zR1, 0.02, 0.35) ? D : -1));
  // magazine tube with a cap and a barrel clamp
  const mag = cx.build.magazine;
  const tubeEnd = zR1 + (tip - zR1) * (mag === 'extmag' ? 0.98 : 0.78);
  g.cylZ(0, yb - 0.034, 0.014, zR1, tubeEnd, D);
  g.cylZ(0, yb - 0.034, 0.016, tubeEnd - 0.014, tubeEnd, cx.S);
  g.boxc(0.012, yb - 0.026, yb - 0.008, tubeEnd - 0.03, tubeEnd - 0.016, D);
  // pump fore-end (animated) with grip grooves
  g.setPart('pump');
  const pz0 = zR1 + 0.03, pz1 = zR1 + 0.03 + Math.min(0.17, (tip - zR1) * 0.45);
  g.fill(-0.025, 0.025, yb - 0.06, yb - 0.008, pz0, pz1, (x, y, z) => {
    const r = Math.hypot(x, (y - (yb - 0.034)) * 1.2);
    if (r > 0.025) return -1;
    if (z < pz0 + 0.008 || z > pz1 - 0.008) return r > 0.023 ? -1 : C;
    return band(z - pz0, 0.01, 0.4) && r > 0.021 ? g.shade(C, 0.72) : C;
  });
  g.setPart('body');
  cx.meta.gripL.set(0, yb - 0.05, (pz0 + pz1) / 2);
  cx.meta.magAt.set(0, yb - 0.05, zR1 + 0.01);
  muzzleDevice(cx, br);
  const hasOpt = !!cx.build.optic && cx.build.optic !== 'iron';
  if (hasOpt) {
    rail(cx, zR0 + 0.02, zR1 - 0.02);
    optic(cx, zR0 + 0.04);
  } else {
    // ghost ring on the receiver, fibre-optic blade on a ramp at the muzzle
    const yS = g.sn(top + 0.026);
    const zr = g.sn(zR0 + 0.03);
    g.boxc(0.026, top - 0.002, top + 0.004, zR0 + 0.01, zR0 + 0.05, D);
    aperture(cx, 0, yS, zr, top + 0.002);
    const zf = g.sn(tip - 0.03);
    g.fill(-0.006, 0.006, yb + br, yS - 0.005, zf - 0.03, zf + 0.004, (x, y, z) => (y < yb + br + 0.006 || (z > zf - 0.003 + (y - yS) * 0.6 && Math.abs(x) <= 0.004) ? D : -1));
    frontPost(cx, 0, yS, zf, yb + br, FIBRE, false);
    // a fat fibre-optic bead: quick to find for a gun that is pointed more than aimed
    g.fill(-0.005, 0.005, yS - 0.006, yS, zf - 0.006, zf, (x, y) => (Math.abs(x) > 0.001 && y > yS - 0.001 ? -1 : g.c(FIBRE, 0.3, 0.5)));
    cx.meta.sight.set(0, yS, zr);
    cx.meta.zoom = 1.12;
  }
  stock(cx, 'wood');
  underbarrel(cx, pz1 + 0.02, yb - 0.05);
}

function revolver(cx: Ctx) {
  const g = G;
  const { yb, D, C, A } = cx;
  const S = C; // stainless frame
  const Sd = g.shade(S, 0.82);
  const cy = 0.036; // cylinder axis
  // frame: rounded back, window for the cylinder, top strap
  g.fill(-0.011, 0.011, -0.004, 0.072, -0.042, 0.03, (x, y, z) => {
    if (z < -0.026 && y > 0.05 && Math.hypot(z + 0.026, y - 0.05) > 0.022) return -1;
    if (Math.abs(x) > 0.008 && (y > 0.068 || y < 0.0)) return -1;
    if (Math.abs(x) <= 0.004 && z < -0.03 && y > 0.044) return -1; // hammer slot
    return S;
  });
  g.fill(-0.011, 0.011, 0.064, 0.074, 0.03, 0.09, (x, y) => (Math.abs(x) > 0.007 && y > 0.07 ? -1 : S));
  g.boxc(0.022, -0.004, 0.008, 0.03, 0.09, S);
  g.boxc(0.022, -0.004, 0.074, 0.088, 0.09, S); // front of the window
  g.box(0.011, 0.014, 0.024, 0.034, -0.01, 0.006, Sd); // cylinder release
  g.cylX(0.03, -0.02, 0.003, -0.012, 0.012, cx.S);
  // grip (wood) raked back with checkered panels and a medallion
  G.fill(-0.016, 0.016, -0.1, 0.0, -0.1, 0.03, (x, y, z) => {
    const zc = -0.012 + y * 0.5;
    const dz = z - zc;
    const hz = 0.019 + (y < -0.09 ? 0.002 : 0);
    const hw = 0.014;
    if ((Math.abs(x) / hw) ** 4 + (Math.abs(dz) / hz) ** 4 > 1) return -1;
    if (y > -0.012) return S;
    if (Math.abs(x) > 0.01 && Math.abs(dz) < 0.012 && y < -0.02 && y > -0.085) {
      if (Math.hypot(dz, y + 0.034) < 0.0045) return g.c(BRASS, 0.8);
      return band(y - dz, 0.008) !== band(y + dz, 0.008) ? g.shade(A, 0.78) : A;
    }
    return A;
  });
  // hammer with a checkered spur
  // hammer with a checkered spur, kept under the sight line
  g.boxc(0.006, 0.048, 0.07, -0.046, -0.036, D);
  g.fill(-0.005, 0.005, 0.06, 0.07, -0.064, -0.042, (_x, y, z) => (y > 0.06 + (z + 0.064) * 0.2 ? (band(z, 0.006) ? g.shade(D, 0.7) : D) : -1));
  triggerGroup(cx, -0.045, 0.006);
  // cylinder (rotates): flutes, chambers, bolt notches
  g.setPart('cyl');
  const cylC = g.c(lighten(STEEL, 1.15), 0.9);
  g.cylZ(0, cy, 0.0245, 0.034, 0.086, cylC);
  g.cylZ(0, cy, 0.022, 0.034, 0.037, g.shade(cylC, 0.75));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    g.cylZ(Math.cos(a) * 0.027, cy + Math.sin(a) * 0.027, 0.007, 0.043, 0.077, 0); // flutes
    const b = a + Math.PI / 6;
    g.cylZ(Math.cos(b) * 0.015, cy + Math.sin(b) * 0.015, 0.005, 0.081, 0.086, 0); // chambers
    g.cylZ(Math.cos(b) * 0.015, cy + Math.sin(b) * 0.015, 0.005, 0.034, 0.035, g.c(BRASS, 0.9)); // case heads
  }
  g.cylZ(0, cy, 0.004, 0.084, 0.087, cx.S);
  g.setPart('body');
  // barrel with top rib and full-length ejector shroud
  const tip = barrel(cx, 0.09, 0.011);
  g.boxc(0.022, yb - 0.006, yb + 0.014, 0.09, tip, S);
  g.boxc(0.01, yb + 0.014, yb + 0.02, 0.09, tip, S);
  g.fill(-0.011, 0.011, yb - 0.03, yb - 0.006, 0.09, tip - 0.006, (x, y) => (Math.abs(x) > 0.007 && y < yb - 0.026 ? -1 : S));
  g.box(0.0105, 0.0115, yb - 0.004, yb + 0.012, 0.11, tip - 0.02, Sd); // side flat line
  g.box(-0.0115, -0.0105, yb - 0.004, yb + 0.012, 0.11, tip - 0.02, Sd);
  // sights: square rear notch on the top strap, ramped front blade with an orange insert;
  // the blade tip sits on the sight axis level with the notch shoulders
  const yS = g.sn(yb + 0.03);
  const zfB = g.sn(tip - 0.012);
  g.fill(-0.005, 0.005, yb + 0.014, yS, zfB - 0.03, zfB + 0.002, (x, y, z) => {
    if (z < zfB - 0.002 + (y - yS) * 1.6) return -1; // ramp
    if (Math.abs(x) > 0.001) return -1;
    return y > yS - 0.012 && z > zfB - 0.006 ? g.c(FIBRE, 0.3, 0.45) : S;
  });
  g.fill(-0.012, 0.012, 0.074, yS, -0.034, -0.02, (x) => (Math.abs(x) < 0.006 ? -1 : D)); // rear notch
  muzzleDevice(cx, 0.011);
  cx.top = 0.072;
  cx.rail = cx.top + 0.012;
  if (cx.build.optic && cx.build.optic !== 'iron') rail(cx, 0.03, 0.09, 0.022);
  const has = optic(cx, 0.0);
  if (!has) {
    cx.meta.sight.set(0, yS, -0.027);
    cx.meta.zoom = 1.12;
  }
  underbarrel(cx, 0.12, yb - 0.03);
  cx.meta.gripL.set(0.012, -0.065, -0.02);
  cx.meta.magAt.set(0, cy, 0.06);
}

function launcher(cx: Ctx) {
  const g = G;
  const { L, B, D, K, C, A } = cx;
  const yt = 0.09;
  const z0 = -0.27, z1 = L + B - 0.25;
  // launch tube with a bell at the back and a wrapped heat shield
  g.cylZ(0, yt, 0.045, z0 + 0.08, z1, C, 0.034);
  g.fill(-0.07, 0.07, yt - 0.07, yt + 0.07, z0, z0 + 0.08, (x, y, z) => {
    const r = 0.045 + (z0 + 0.08 - z) * 0.3;
    const d = Math.hypot(x, y - yt);
    return d <= r && d > r - 0.007 ? (z < z0 + 0.006 ? A : D) : -1;
  });
  g.cylZ(0, yt, 0.049, 0.0, 0.26, G.shade(C, 0.7), 0.044);
  g.fill(-0.051, 0.051, yt - 0.051, yt + 0.051, 0.0, 0.26, (x, y, z) => (Math.hypot(x, y - yt) > 0.046 && band(z, 0.04, 0.22) ? D : -1));
  g.cylZ(0, yt, 0.05, z1 - 0.03, z1, A, 0.034);
  g.fill(-0.051, 0.051, yt - 0.051, yt + 0.051, z1 - 0.03, z1, (x, y, z) => (Math.hypot(x, y - yt) > 0.047 && band(z, 0.012, 0.4) ? g.shade(A, 0.75) : -1));
  // grips
  pistolGrip(cx, 0, 0.18, 0.1, K);
  g.boxc(0.024, -0.005, yt - 0.04, -0.03, 0.06, D);
  triggerGroup(cx, -0.01, 0);
  g.fill(-0.016, 0.016, -0.09, yt - 0.04, 0.2, 0.25, (x, y, z) => (Math.hypot(x, z - 0.225) < 0.017 - (y < -0.084 ? 0 : 0.002) ? (band(y, 0.022, 0.3) && Math.abs(x) > 0.01 ? g.shade(K, 0.8) : K) : -1));
  // iron sights on brackets off the left of the tube, clear of the heat shield
  const sx = g.sn(0.085), yS = g.sn(yt + 0.045);
  const zr = g.sn(0.062), zf = g.sn(0.33);
  for (const z of [zr, zf]) g.box(0.04, sx + 0.004, yt - 0.006, yt + 0.006, z - 0.012, z + 0.012, D); // brackets
  g.box(sx - 0.006, sx + 0.004, yt - 0.005, yt + 0.005, zr, zf, D); // sight bar
  aperture(cx, sx, yS, zr, yt + 0.005);
  frontPost(cx, sx, yS, zf, yt + 0.005);
  // warhead peeking from the muzzle (hidden while empty)
  g.setPart('warhead');
  g.cylZ(0, yt, 0.032, z1 - 0.06, z1 + 0.02, g.c(0x3c4632, 0.3));
  g.fill(-0.05, 0.05, yt - 0.05, yt + 0.05, z1 + 0.02, z1 + 0.16, (x, y, z) => {
    const t = (z - z1 - 0.02) / 0.14;
    const r = 0.048 * Math.sqrt(Math.max(0, 1 - t * t * 0.9)) * (t < 0.15 ? 0.75 + t * 1.6 : 1);
    const d = Math.hypot(x, y - yt);
    if (d > r) return -1;
    if (t > 0.82) return g.c(0x2a2c2e, 0.5);
    return t > 0.3 && t < 0.36 ? g.shade(A, 0.7) : A;
  });
  g.setPart('body');
  cx.top = yt + 0.04;
  cx.rail = cx.top + 0.012;
  const hasOpt = !!cx.build.optic && cx.build.optic !== 'iron';
  if (hasOpt) {
    g.boxc(0.02, yt + 0.03, cx.top, 0.1, 0.2, D);
    rail(cx, 0.06, 0.22);
  }
  const has = optic(cx, 0.08);
  if (!has) {
    cx.meta.sight.set(sx, yS, zr);
    cx.meta.zoom = 1.15;
  }
  cx.meta.muzzle.set(0, yt, z1 + 0.18);
  cx.meta.gripL.set(0, -0.04, 0.225);
  cx.meta.magAt.set(0, yt, z1 + 0.06);
}

function grenadeLauncher(cx: Ctx) {
  const g = G;
  const { yb, D, K, C, A } = cx;
  // frame
  g.fill(-0.02, 0.02, -0.01, 0.03, -0.1, 0.06, (x, y) => (Math.abs(x) > 0.016 && (y > 0.026 || y < -0.006) ? -1 : C));
  pistolGrip(cx, 0, 0.3, 0.1, K);
  triggerGroup(cx, -0.01, -0.005);
  // revolving drum
  g.setPart('cyl');
  const cy = yb - 0.025;
  g.cylZ(0, cy, 0.068, 0.06, 0.2, A);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.cylZ(Math.cos(a) * 0.04, cy + Math.sin(a) * 0.04, 0.019, 0.195, 0.2, 0);
    g.cylZ(Math.cos(a) * 0.04, cy + Math.sin(a) * 0.04, 0.016, 0.199, 0.2, g.c(0x8a8f6a, 0.3)); // grenade noses
    g.cylZ(Math.cos(a + 0.52) * 0.068, cy + Math.sin(a + 0.52) * 0.068, 0.012, 0.09, 0.17, 0);
  }
  for (let z = 0.08; z < 0.19; z += 0.035) g.cylZ(0, cy, 0.07, z, z + 0.006, D);
  g.setPart('body');
  g.cylZ(0, cy, 0.016, 0.03, 0.06, D); // spindle
  g.cylZ(0, cy, 0.02, 0.2, 0.215, D);
  // barrel
  const tip = barrel(cx, 0.2, 0.034);
  g.cylZ(0, yb, 0.026, tip - 0.01, tip, 0);
  g.boxc(0.02, yb + 0.034, yb + 0.044, 0.2, tip, D);
  // front grip under the barrel
  g.fill(-0.016, 0.016, yb - 0.12, yb - 0.03, 0.23, 0.27, (x, y, z) => (Math.hypot(x, z - 0.25) < 0.017 ? (band(y, 0.02, 0.3) && Math.abs(x) > 0.01 ? g.shade(K, 0.8) : K) : -1));
  // quadrant sight housing on the right
  g.box(-0.05, -0.036, yb + 0.02, yb + 0.07, 0.05, 0.08, D);
  g.cylX(yb + 0.045, 0.065, 0.012, -0.054, -0.05, g.c(lighten(STEEL, 0.9), 0.8));
  muzzleDevice(cx, 0.034);
  cx.top = 0.106;
  cx.rail = cx.top + 0.012;
  g.boxc(0.026, 0.03, cx.top, -0.07, -0.05, D);
  g.boxc(0.026, 0.096, cx.top, -0.07, 0.24, D);
  rail(cx, -0.06, 0.2, 0.026);
  const has = optic(cx, 0.0);
  ironSights(cx, -0.06, 0.2, has, cx.rail);
  stock(cx, 'fold');
  cx.meta.gripL.set(0, yb - 0.075, 0.25);
  cx.meta.magAt.set(0, cy, 0.13);
}

function minigun(cx: Ctx) {
  const g = G;
  const { yb, D, K, C, A } = cx;
  // motor housing
  g.fill(-0.045, 0.045, -0.02, 0.1, -0.12, 0.16, (x, y, z) => {
    if (Math.abs(x) > 0.04 && (y > 0.094 || y < -0.014)) return -1;
    if (Math.abs(x) > 0.043 && y > 0.02 && y < 0.08 && z < 0.06 && band(z, 0.012, 0.4)) return D; // vents
    return C;
  });
  g.boxc(0.06, 0.1, 0.112, -0.1, 0.12, D);
  g.cylX(0.05, -0.08, 0.02, -0.048, -0.045, D); // motor cap
  // top carry handle with a ring-and-post sight along it
  g.boxc(0.014, 0.112, 0.16, -0.06, -0.045, D);
  g.boxc(0.014, 0.112, 0.16, 0.08, 0.095, D);
  g.boxc(0.022, 0.15, 0.17, -0.06, 0.095, K);
  const yS = g.sn(0.2), zr = g.sn(-0.05), zf = g.sn(0.088);
  aperture(cx, 0, yS, zr, 0.168);
  frontPost(cx, 0, yS, zf, 0.168);
  // rear grip + trigger
  pistolGrip(cx, -0.02, 0.2, 0.1, K);
  // ammo feed chute from the left with brass
  g.box(0.045, 0.07, -0.01, 0.07, -0.02, 0.1, A);
  g.fill(0.07, 0.11, -0.12, 0.04, 0.0, 0.08, (x, y, z) => (y < 0.04 - (x - 0.07) * 2.2 && Math.abs(z - 0.04) < 0.03 && band(y, 0.012, 0.6) ? g.c(BRASS, 0.9) : -1));
  // rotor: barrels, clamps and the front ring (spins)
  g.setPart('rotor');
  const z0 = 0.16, tip = cx.tip;
  g.cylZ(0, yb, 0.042, z0, z0 + 0.06, D);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.cylZ(Math.cos(a) * 0.026, yb + Math.sin(a) * 0.026, 0.009, z0, tip, D);
    g.cylZ(Math.cos(a) * 0.026, yb + Math.sin(a) * 0.026, 0.0045, tip - 0.006, tip, 0);
  }
  g.cylZ(0, yb, 0.04, tip - 0.13, tip - 0.11, A, 0.034);
  g.cylZ(0, yb, 0.04, tip - 0.03, tip - 0.01, cx.S, 0.034);
  g.setPart('body');
  // side grip for the off hand
  g.box(0.045, 0.06, 0.02, 0.06, 0.12, 0.14, D);
  g.fill(0.06, 0.1, 0.0, 0.08, 0.12, 0.15, (x, y, z) => (Math.hypot(y - 0.04, z - 0.135) < 0.016 ? (band(x, 0.016, 0.3) ? g.shade(K, 0.8) : K) : -1));
  underbarrel(cx, 0.06, -0.02);
  cx.meta.sight.set(0, yS, zr);
  cx.meta.zoom = 1.1;
  cx.meta.muzzle.set(0, yb, tip + 0.02);
  cx.meta.gripL.set(0.08, 0.04, 0.135);
  cx.meta.magAt.set(0.08, -0.04, 0.04);
}

// ------------------------------------------------------------------------------ assembly
const cache = new Map<string, GunModel>();

export function buildKey(def: WeaponDef, build: Build) {
  const slots = Object.keys(build).sort().map((k) => `${k}:${build[k as keyof Build]}`).join(',');
  return `${def.id}|${slots}`;
}

/**
 * The weapon's voxel model, built once per build and cached. lod 0 is the fine 0.5 cm model for
 * the viewmodel and previews; lod 1 is the 1 cm copy bots carry around the map.
 */
export function gunModel(def: WeaponDef, build: Build, lod: 0 | 1 = 0): GunModel {
  const key = buildKey(def, build) + (lod ? '|lod1' : '');
  const hit = cache.get(key);
  if (hit) return hit;
  const m = def.model;
  useGrid(LOD_RES[lod]);
  const bulky = !!m.bulky;
  const C = G.c(m.color, 0.35);
  const ctx: Ctx = {
    def,
    build,
    L: m.length,
    B: m.barrel,
    bore: m.bore,
    rw: def.id === 'lmg' ? 0.07 : bulky ? 0.06 : def.id === 'smg' ? 0.046 : 0.05,
    top: def.id === 'lmg' ? 0.1 : def.id === 'smg' ? 0.08 : 0.085,
    yb: 0.058,
    zR0: -0.08,
    zR1: m.length - 0.08,
    tip: m.length - 0.08 + m.barrel,
    rail: 0,
    C,
    C2: G.c(lighten(m.color, 1.12), 0.4),
    A: G.c(m.accent, 0.3),
    D: G.c(DARK, 0.65),
    K: G.c(BLACK, 0.2),
    S: G.c(STEEL, 0.9),
    meta: {
      muzzle: V3(0, 0.058, m.length - 0.08 + m.barrel),
      sight: V3(0, 0.11, -0.06),
      zoom: 1.15,
      scoped: false,
      reticle: null,
      lens: V3(),
      lensHalf: new THREE.Vector2(),
      lensRound: 0,
      gripR: V3(0, -0.04, -0.01),
      gripL: V3(0, 0.02, 0.3),
      magAt: V3(0, -0.06, 0.1),
      heft: Math.min(1, Math.max(0, (1.05 - def.base.moveMul) * 3.5)),
    },
  };
  if (def.id === 'dmr' || def.id === 'shotgun') ctx.C = G.c(m.color, 0.12); // wooden furniture
  ctx.rail = ctx.top + 0.012;
  if (m.tube) launcher(ctx);
  else if (def.id === 'revolver') revolver(ctx);
  else if (def.id === 'shotgun') shotgun(ctx);
  else if (def.id === 'gl') grenadeLauncher(ctx);
  else if (m.rotary) minigun(ctx);
  else rifle(ctx);

  const parts: GunPart[] = [];
  const pivots: Record<PartName, THREE.Vector3> = {
    body: V3(0, 0, 0),
    mag: ctx.meta.magAt.clone(),
    pump: V3(0, 0, 0),
    rotor: V3(0, ctx.yb, 0),
    warhead: V3(0, 0, 0),
    cyl: V3(0, def.id === 'gl' ? ctx.yb - 0.025 : 0.036, 0),
  };
  for (const p of Object.values(pivots)) p.set(G.sn(p.x), G.sn(p.y), G.sn(p.z));
  PART_IDS.forEach((name, pid) => {
    const geo = G.meshPart(pid, pivots[name]);
    if (geo) parts.push({ name, geo, pivot: pivots[name] });
  });
  const merged = mergeGeometries(
    parts.map((p) => p.geo.clone().translate(p.pivot.x, p.pivot.y, p.pivot.z)),
    false,
  )!;
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  const model: GunModel = { key, parts, merged, ...ctx.meta };
  cache.set(key, model);
  return model;
}

// ------------------------------------------------------------------------------ hands
const handCache = new Map<string, { right: THREE.BufferGeometry; left: THREE.BufferGeometry }>();

/**
 * Gloved hands and sleeves for the viewmodel. The right hand wraps the pistol grip, the left
 * holds the fore-end; each forearm runs back and down out of view.
 */
export function handModels(gun: GunModel, team: 0 | 1) {
  const key = `${team}`;
  const hit = handCache.get(key);
  if (hit) return hit;
  const sleeve = team === 0 ? 0x4a5a46 : 0x7a6a4a;
  const cuff = team === 0 ? 0x3d7fe6 : 0xe0483a;
  const glove = 0x2b2a26;
  const knuckle = 0x3a3832;
  const build = (side: 1 | -1) => {
    useGrid(GV);
    const S = G.c(sleeve, 0.08), Cf = G.c(cuff, 0.15), Gl = G.c(glove, 0.18), Kn = G.c(knuckle, 0.25);
    const fold = G.c(lighten(sleeve, 0.82), 0.08);
    // hand at the origin; forearm back toward the camera corner
    const dir = side === 1 ? new THREE.Vector3(-0.42, -0.5, -0.76).normalize() : new THREE.Vector3(0.5, -0.5, -0.71).normalize();
    // fist with knuckle pads and finger seams
    G.fill(-0.04, 0.04, -0.05, 0.035, -0.05, 0.05, (x, y, z) => {
      const r = Math.hypot(x / 0.038, y / 0.032, z / 0.045);
      if (r > 1) return -1;
      const outside = side === 1 ? x < -0.026 : x > 0.026;
      if (outside && y > 0.0 && band(z + 0.05, 0.022, 0.6)) return Kn;
      if (outside && y < 0.0 && band(y, 0.016, 0.25)) return G.shade(Gl, 0.8);
      return Gl;
    });
    // thumb along the far side
    G.obb(side === 1 ? 0.024 : -0.024, 0.02, 0.02, new THREE.Vector3(0, 0.25, 1).normalize(), 0.028, 0.011, 0.011, Gl, 0.006);
    // wrist + sleeve
    const wl = 0.03, sl = 0.3;
    G.obb(dir.x * (0.04 + wl / 2), dir.y * (0.04 + wl / 2), dir.z * (0.04 + wl / 2), dir, wl / 2, 0.026, 0.026, Gl, 0.01);
    const c0 = 0.04 + wl;
    G.obb(dir.x * (c0 + 0.015), dir.y * (c0 + 0.015), dir.z * (c0 + 0.015), dir, 0.015, 0.038, 0.038, Cf, 0.012);
    G.obb(dir.x * (c0 + 0.03 + sl / 2), dir.y * (c0 + 0.03 + sl / 2), dir.z * (c0 + 0.03 + sl / 2), dir, sl / 2, 0.042, 0.04, S, 0.016);
    // sleeve folds
    for (let t = 0.06; t < sl; t += 0.07) {
      const c = c0 + 0.03 + t;
      G.obb(dir.x * c, dir.y * c, dir.z * c, dir, 0.005, 0.044, 0.042, fold, 0.016);
    }
    return G.meshPart(0, new THREE.Vector3())!;
  };
  const res = { right: build(1), left: build(-1) };
  handCache.set(key, res);
  void gun;
  return res;
}
