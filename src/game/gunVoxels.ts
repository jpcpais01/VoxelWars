import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { greedyMesh } from '../world/mesher';
import { Build, WeaponDef } from './weapons';

/**
 * Fine voxel weapon models (1 cm voxels) built procedurally from each weapon's shape and
 * its attachments, then greedy-meshed with baked AO. The same models arm the bots, fill the
 * loadout preview and, with hands and animated parts, become the first-person viewmodel.
 *
 * Gun space: metres, +Z along the barrel, +Y up, origin at the top of the pistol grip.
 * The shooter's right side is -X (so ejection ports and bolt handles live there).
 */
export const GV = 0.01;

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
  lens: THREE.Vector3;
  lensR: number;
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

const XI = 15, YI0 = -36, YI1 = 34, ZI0 = -90, ZI1 = 200;
const NX = XI * 2 + 1, NY = YI1 - YI0 + 1, NZ = ZI1 - ZI0 + 1;

class VoxGrid {
  mat = new Uint8Array(NX * NY * NZ);
  part = new Uint8Array(NX * NY * NZ);
  pal: Pal[] = [{ col: 0, spec: 0, glow: 0 }];
  cur = 0;
  reset() {
    this.mat.fill(0);
    this.part.fill(0);
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
  private at(i: number, j: number, k: number) {
    return ((i + XI) * NZ + (k - ZI0)) * NY + (j - YI0);
  }
  /** fill cells whose centre lies inside [x0,x1]x[y0,y1]x[z0,z1] and passes the predicate */
  fill(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: number | ((x: number, y: number, z: number) => number)) {
    const e = 1e-4;
    const i0 = Math.max(-XI, Math.ceil((x0 - e) / GV)), i1 = Math.min(XI, Math.floor((x1 + e) / GV));
    const j0 = Math.max(YI0, Math.ceil((y0 - e) / GV)), j1 = Math.min(YI1, Math.floor((y1 + e) / GV));
    const k0 = Math.max(ZI0, Math.ceil((z0 - e) / GV)), k1 = Math.min(ZI1, Math.floor((z1 + e) / GV));
    const fn = typeof c === 'function' ? c : null;
    for (let i = i0; i <= i1; i++)
      for (let k = k0; k <= k1; k++)
        for (let j = j0; j <= j1; j++) {
          let v = fn ? fn(i * GV, j * GV, k * GV) : (c as number);
          if (v < 0) continue;
          if (v > 255) v = this.c(v); // raw hex colours are accepted too
          const a = this.at(i, j, k);
          this.mat[a] = v;
          this.part[a] = v ? this.cur : 0;
        }
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
    const r2 = (r + 0.002) ** 2, ri2 = rIn > 0 ? (rIn - 0.002) ** 2 : -1;
    this.fill(cx - r, cx + r, cy - r, cy + r, z0, z1, (x, y) => {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      return d <= r2 && d > ri2 ? c : -1;
    });
  }
  cylX(cy: number, cz: number, r: number, x0: number, x1: number, c: number, rIn = 0) {
    const r2 = (r + 0.002) ** 2, ri2 = rIn > 0 ? (rIn - 0.002) ** 2 : -1;
    this.fill(x0, x1, cy - r, cy + r, cz - r, cz + r, (_x, y, z) => {
      const d = (y - cy) ** 2 + (z - cz) ** 2;
      return d <= r2 && d > ri2 ? c : -1;
    });
  }
  cylY(cx: number, cz: number, r: number, y0: number, y1: number, c: number) {
    const r2 = (r + 0.002) ** 2;
    this.fill(cx - r, cx + r, y0, y1, cz - r, cz + r, (x, _y, z) => ((x - cx) ** 2 + (z - cz) ** 2 <= r2 ? c : -1));
  }
  /** oriented box: centre, unit length axis d, half length, half width (x-ish), half height */
  obb(cx: number, cy: number, cz: number, d: THREE.Vector3, hl: number, hw: number, hh: number, c: number, round = 0) {
    const up = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const sx = new THREE.Vector3().crossVectors(up, d).normalize();
    const sy = new THREE.Vector3().crossVectors(d, sx).normalize();
    const R = hl + hw + hh;
    this.fill(cx - R, cx + R, cy - R, cy + R, cz - R, cz + R, (x, y, z) => {
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
  get(x: number, y: number, z: number) {
    const i = Math.round(x / GV), j = Math.round(y / GV), k = Math.round(z / GV);
    if (i < -XI || i > XI || j < YI0 || j > YI1 || k < ZI0 || k > ZI1) return 0;
    return this.mat[this.at(i, j, k)];
  }

  /** greedy-mesh one part into a lit, vertex-coloured geometry relative to its pivot */
  meshPart(pid: number, pivot: THREE.Vector3): THREE.BufferGeometry | null {
    let i0 = 1e9, i1 = -1e9, j0 = 1e9, j1 = -1e9, k0 = 1e9, k1 = -1e9;
    for (let i = -XI; i <= XI; i++)
      for (let k = ZI0; k <= ZI1; k++) {
        const base = this.at(i, YI0, k);
        for (let jj = 0; jj < NY; jj++) {
          if (!this.mat[base + jj] || this.part[base + jj] !== pid) continue;
          const j = jj + YI0;
          if (i < i0) i0 = i;
          if (i > i1) i1 = i;
          if (j < j0) j0 = j;
          if (j > j1) j1 = j;
          if (k < k0) k0 = k;
          if (k > k1) k1 = k;
        }
      }
    if (i1 < i0) return null;
    const sx = i1 - i0 + 3, sy = j1 - j0 + 3, sz = k1 - k0 + 3;
    const vol = new Uint8Array(sx * sy * sz);
    for (let i = i0; i <= i1; i++)
      for (let k = k0; k <= k1; k++)
        for (let j = j0; j <= j1; j++) {
          const a = this.at(i, j, k);
          if (this.mat[a] && this.part[a] === pid) vol[((i - i0 + 1) * sz + (k - k0 + 1)) * sy + (j - j0 + 1)] = this.mat[a];
        }
    const md = greedyMesh(vol, sx, sy, sz);
    const n = md.vertexCount;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), fin = new Float32Array(n * 2);
    const tc = new THREE.Color();
    const cols = this.pal.map((p) => new THREE.Color(p.col));
    for (let v = 0; v < n; v++) {
      pos[v * 3] = (i0 + md.positions[v * 4] - 0.5) * GV - pivot.x;
      pos[v * 3 + 1] = (j0 + md.positions[v * 4 + 1] - 0.5) * GV - pivot.y;
      pos[v * 3 + 2] = (k0 + md.positions[v * 4 + 2] - 0.5) * GV - pivot.z;
      const m = md.data[v * 4], ao = md.data[v * 4 + 1] / 255, face = md.data[v * 4 + 2];
      const ax = face >> 1, s = face & 1 ? -1 : 1;
      nor[v * 3 + ax] = s;
      const p = this.pal[m];
      tc.copy(cols[m]).multiplyScalar(p.glow > 0 ? 1 : 0.5 + 0.5 * ao * ao);
      col[v * 3] = tc.r;
      col[v * 3 + 1] = tc.g;
      col[v * 3 + 2] = tc.b;
      fin[v * 2] = p.spec;
      fin[v * 2 + 1] = p.glow;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aFin', new THREE.BufferAttribute(fin, 2));
    geo.setIndex(new THREE.BufferAttribute(n > 65535 ? new Uint32Array(md.indices) : new Uint16Array(md.indices), 1));
    geo.computeBoundingSphere();
    return geo;
  }
}

const G = new VoxGrid();

// ------------------------------------------------------------------------------ palette
const DARK = 0x464b52;
const BLACK = 0x33373c;
const STEEL = 0x60656b;
const BRASS = 0xc9a24a;
const GLASS = 0x1d3340;
const WOOD = 0x6b4a2e;
const RUBBER = 0x161718;

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
/** picatinny rail on top between z0 and z1 */
function rail(cx: Ctx, z0: number, z1: number, w = 0.03) {
  const g = G;
  g.boxc(w - 0.01, cx.top, cx.top + 0.005, z0, z1, cx.D);
  g.fill(-w / 2, w / 2, cx.top + 0.01, cx.top + 0.012, z0, z1, (_x, _y, z) => (Math.round(z / GV) % 2 === 0 ? cx.D : -1));
  g.fill(-w / 2, w / 2, cx.top + 0.006, cx.top + 0.009, z0, z1, cx.D);
}

function pistolGrip(cx: Ctx, z = 0, rake = 0.32, len = 0.11, col = cx.K) {
  G.fill(-0.016, 0.016, -len, 0.005, z - 0.08, z + 0.04, (x, y, zz) => {
    const zc = z + 0.004 + y * rake;
    const dz = zz - zc;
    if (Math.abs(dz) > 0.022) return -1;
    if (Math.abs(x) > 0.011 && Math.abs(dz) > 0.016) return -1; // rounded edges
    if (dz > 0.016 && y < -0.02 && Math.round(y / GV) % 3 === 0) return -1; // finger grooves
    if (y < -len + 0.012 && Math.abs(x) <= 0.016) return col; // flared base
    return Math.abs(x) <= 0.013 || y < -len + 0.012 ? col : -1;
  });
}

function triggerGroup(cx: Ctx, z = 0, y0 = 0) {
  const g = G;
  g.boxc(0.012, y0 - 0.034, y0 - 0.026, z + 0.03, z + 0.085, cx.D);
  g.boxc(0.012, y0 - 0.034, y0, z + 0.078, z + 0.086, cx.D);
  // curved trigger blade
  g.fill(0, 0, y0 - 0.024, y0, z + 0.04, z + 0.06, (_x, y, zz) => (Math.abs(zz - (z + 0.05 + (y - y0 + 0.012) ** 2 * 18)) < 0.006 ? cx.S : -1));
}

function ironSights(cx: Ctx, zRear: number, zFront: number, fold = false) {
  const g = G;
  const yS = cx.rail + 0.022;
  if (fold) {
    // low folded back-up sights when an optic is mounted
    g.boxc(0.024, cx.rail, cx.rail + 0.008, zRear, zRear + 0.03, cx.D);
    g.boxc(0.02, cx.rail, cx.rail + 0.008, zFront - 0.03, zFront, cx.D);
    return yS;
  }
  // rear aperture
  g.boxc(0.03, cx.rail, cx.rail + 0.01, zRear, zRear + 0.03, cx.D);
  g.fill(-0.015, 0.015, cx.rail + 0.01, yS + 0.012, zRear + 0.006, zRear + 0.016, (x, y) => (Math.abs(x) <= 0.005 && Math.abs(y - yS) <= 0.005 ? -1 : cx.D));
  // front post with protective ears
  g.boxc(0.028, cx.rail, cx.rail + 0.01, zFront - 0.02, zFront, cx.D);
  g.boxc(0, cx.rail + 0.01, yS, zFront - 0.012, zFront - 0.006, cx.D);
  g.box(-0.014, -0.01, cx.rail + 0.01, yS + 0.004, zFront - 0.016, zFront - 0.004, cx.D);
  g.box(0.01, 0.014, cx.rail + 0.01, yS + 0.004, zFront - 0.016, zFront - 0.004, cx.D);
  cx.meta.sight.set(0, yS, zRear + 0.01);
  cx.meta.zoom = 1.15;
  return yS;
}

/** optic on the rail; returns true if it provides the sight picture */
function optic(cx: Ctx, z0: number) {
  const g = G;
  const o = cx.build.optic ?? 'iron';
  const base = cx.rail;
  const D = cx.D, K = cx.K;
  switch (o) {
    case 'reddot': {
      const y = base + 0.032, r = 0.021;
      g.boxc(0.024, base, base + 0.014, z0 + 0.01, z0 + 0.05, D);
      g.cylZ(0, y, r, z0, z0 + 0.06, D, 0.0155);
      g.box(-0.024, -0.02, y - 0.006, y + 0.006, z0 + 0.02, z0 + 0.035, K); // brightness knob
      cx.meta.sight.set(0, y, z0 - 0.01);
      cx.meta.lens.set(0, y, z0 + 0.057);
      cx.meta.lensR = 0.016;
      cx.meta.reticle = 'dot';
      cx.meta.zoom = 1.3;
      return true;
    }
    case 'holo': {
      const y = base + 0.03;
      g.boxc(0.042, base, base + 0.012, z0, z0 + 0.09, D);
      g.fill(-0.021, 0.021, base + 0.012, base + 0.052, z0 + 0.03, z0 + 0.09, (x, yy) => (Math.abs(x) <= 0.015 && yy <= base + 0.046 ? -1 : D));
      g.box(-0.021, 0.021, base + 0.004, base + 0.01, z0 + 0.0, z0 + 0.025, K); // buttons
      cx.meta.sight.set(0, y, z0 + 0.0);
      cx.meta.lens.set(0, y, z0 + 0.087);
      cx.meta.lensR = 0.016;
      cx.meta.reticle = 'holo';
      cx.meta.zoom = 1.25;
      return true;
    }
    case 'acog': {
      const y = base + 0.032;
      g.boxc(0.024, base, base + 0.012, z0 + 0.03, z0 + 0.12, D);
      g.cylZ(0, y, 0.02, z0, z0 + 0.15, D, 0.012);
      g.cylZ(0, y, 0.025, z0 + 0.12, z0 + 0.16, D, 0.017);
      g.boxc(0.01, y + 0.02, y + 0.026, z0 + 0.03, z0 + 0.11, g.c(0x2fd060, 0.4, 0.5)); // fibre optic
      g.cylZ(0, y, 0.017, z0 + 0.155, z0 + 0.155, g.c(GLASS, 1));
      cx.meta.sight.set(0, y, z0 - 0.04);
      cx.meta.zoom = 3;
      cx.meta.scoped = true;
      return true;
    }
    case 'scope8': {
      const y = base + 0.034;
      g.boxc(0.026, base, base + 0.02, z0 + 0.02, z0 + 0.04, D);
      g.boxc(0.026, base, base + 0.02, z0 + 0.14, z0 + 0.16, D);
      g.cylZ(0, y, 0.018, z0 - 0.04, z0 + 0.22, K, 0.01);
      g.cylZ(0, y, 0.026, z0 + 0.2, z0 + 0.28, K, 0.018);
      g.cylZ(0, y, 0.022, z0 - 0.08, z0 - 0.03, K, 0.014);
      g.cylY(0, z0 + 0.09, 0.012, y + 0.016, y + 0.034, D); // elevation turret
      g.cylX(y, z0 + 0.09, 0.012, -0.036, -0.016, D); // windage turret
      g.cylZ(0, y, 0.022, z0 + 0.275, z0 + 0.275, g.c(GLASS, 1));
      cx.meta.sight.set(0, y, z0 - 0.12);
      cx.meta.zoom = 7;
      cx.meta.scoped = true;
      return true;
    }
    case 'thermal': {
      const y = base + 0.034;
      g.boxc(0.05, base, base + 0.058, z0 + 0.01, z0 + 0.15, g.c(0x34413a, 0.3));
      g.boxc(0.03, base + 0.012, base + 0.05, z0 + 0.15, z0 + 0.17, K);
      g.boxc(0.022, base + 0.016, base + 0.046, z0 + 0.171, z0 + 0.171, g.c(0x6a3a20, 1, 0.25));
      g.boxc(0.034, base + 0.012, base + 0.05, z0 - 0.03, z0 + 0.01, RUBBER);
      g.box(0.025, 0.032, base + 0.02, base + 0.04, z0 + 0.04, z0 + 0.09, K);
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
  if (b === 'heavy') for (let z = zFrom + 0.02; z < tip - 0.03; z += 0.03) G.cylZ(0, cx.yb, rr + 0.004, z, z + 0.008, cx.S);
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
    g.cylZ(0, y, R + 0.003, t, t + 0.02, cx.D);
    g.cylZ(0, y, R + 0.002, t + 0.14, t + 0.16, cx.D);
    g.cylZ(0, y, r * 0.8, t + 0.16, t + 0.16, 0);
    end = t + 0.16;
  } else if (mz === 'compensator') {
    g.cylZ(0, y, r * 1.5, t, t + 0.05, cx.D);
    g.fill(-0.006, 0.006, y + r * 0.6, y + r * 1.6, t + 0.012, t + 0.04, (_x, _y, z) => (Math.round(z / GV) % 2 ? 0 : -1));
    end = t + 0.05;
  } else if (mz === 'brake') {
    g.fill(-r * 2.2, r * 2.2, y - r * 1.4, y + r * 1.4, t, t + 0.06, (x, _y, z) => (Math.abs(x) > r * 1.2 && Math.round(z / GV) % 2 ? 0 : cx.A));
    end = t + 0.06;
  } else if (mz === 'flashhider') {
    g.cylZ(0, y, r * 1.35, t, t + 0.045, cx.D);
    g.fill(-r * 1.4, r * 1.4, y - r * 1.4, y + r * 1.4, t + 0.015, t + 0.045, (x, yy) => (Math.abs(x) < 0.004 || Math.abs(yy - y) < 0.004 ? 0 : -1));
    end = t + 0.045;
  } else if (mz === 'choke') {
    g.fill(-r * 1.9, r * 1.9, y - r * 0.9, y + r * 0.9, t, t + 0.06, cx.D);
    end = t + 0.06;
  } else {
    g.cylZ(0, y, r * 1.15, t - 0.012, t, cx.D);
  }
  // bore
  g.cylZ(0, y, Math.max(0.004, r * 0.45), end - 0.004, end, 0);
  cx.meta.muzzle.set(0, y, end + 0.01);
}

function underbarrel(cx: Ctx, z: number, yBot: number) {
  const g = G;
  const u = cx.build.underbarrel;
  const K = cx.K;
  if (u === 'vgrip') {
    g.fill(-0.014, 0.014, yBot - 0.085, yBot, z - 0.016, z + 0.016, (x, y, zz) => {
      const r = Math.hypot(x, (zz - z) * 0.9);
      if (r > 0.015) return -1;
      return Math.round(y / GV) % 3 === 0 && r > 0.012 ? cx.D : K;
    });
    cx.meta.gripL.set(0, yBot - 0.045, z);
  } else if (u === 'agrip') {
    g.fill(-0.013, 0.013, yBot - 0.04, yBot, z - 0.05, z + 0.03, (_x, y, zz) => (zz - z > -0.05 + (yBot - y) * 1.2 && zz - z < 0.03 - (yBot - y) * 0.6 ? K : -1));
    cx.meta.gripL.set(0, yBot - 0.03, z - 0.02);
  } else if (u === 'laser') {
    g.boxc(0.026, yBot - 0.03, yBot, z, z + 0.06, K);
    g.boxc(0.012, yBot - 0.022, yBot - 0.012, z + 0.06, z + 0.062, g.c(0xff2a22, 0.5, 1));
    g.box(-0.02, -0.013, yBot - 0.024, yBot - 0.008, z + 0.01, z + 0.03, cx.D);
  } else if (u === 'bipod') {
    g.boxc(0.03, yBot - 0.014, yBot, z + 0.04, z + 0.07, cx.D);
    for (const sx of [-1, 1]) {
      g.box(sx > 0 ? 0.006 : -0.016, sx > 0 ? 0.016 : -0.006, yBot - 0.018, yBot - 0.008, z - 0.18, z + 0.05, cx.D);
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
  const ribC = g.c(lighten(BLACK, 1.6), 0.2);
  if (mag === 'drum') {
    g.boxc(w, y0 - 0.03, y0, z - d / 2, z + d / 2, col);
    for (const sx of [-1, 1]) {
      g.cylX(y0 - 0.075, z + 0.01, 0.06, sx > 0 ? 0.006 : -0.038, sx > 0 ? 0.038 : -0.006, cx.D);
      g.cylX(y0 - 0.075, z + 0.01, 0.022, sx > 0 ? 0.036 : -0.042, sx > 0 ? 0.042 : -0.036, cx.A);
    }
    g.boxc(0.012, y0 - 0.14, y0 - 0.02, z - 0.04, z + 0.06, cx.D);
    cx.meta.magAt.set(0, y0 - 0.08, z);
  } else {
    const L = mag === 'extmag' ? len * 1.45 : mag === 'fastmag' ? len * 0.95 : len;
    g.fill(-w / 2, w / 2, y0 - L - 0.012, y0, z - d / 2 - 0.03, z + d / 2 + 0.06, (x, y, zz) => {
      const dy = y0 - y;
      const zc = z + (curved ? dy * dy * 1.6 : dy * 0.06);
      const dz = zz - zc;
      if (dy > L) return Math.abs(dz) <= d / 2 + 0.004 && Math.abs(x) <= w / 2 ? cx.D : -1; // base plate
      if (Math.abs(dz) > d / 2) return -1;
      if (Math.abs(x) >= w / 2 - 0.002 && Math.round(dy / GV) % 4 === 0 && Math.abs(dz) < d / 2 - 0.006) return ribC;
      return col;
    });
    if (mag === 'fastmag') {
      const dy = L + 0.012, zc = z + (curved ? dy * dy * 1.6 : dy * 0.06);
      g.boxc(0.008, y0 - dy - 0.025, y0 - dy, zc - 0.01, zc + 0.01, g.c(0xd04a2a, 0.2)); // pull loop
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
    for (const sx of [-1, 1]) g.box(sx > 0 ? 0.008 : -0.016, sx > 0 ? 0.016 : -0.008, yb - 0.004, yb + 0.006, zE, z0, cx.D);
    g.box(-0.016, 0.016, yb - 0.075, yb + 0.012, zE, zE + 0.012, cx.D);
    g.box(-0.016, 0.016, yb - 0.075, yb - 0.062, zE + 0.012, zE + len * 0.55, cx.D);
    g.box(-0.018, 0.018, yb - 0.078, yb + 0.014, zE - 0.008, zE, RUBBER);
    return;
  }
  if (kind === 'adjust') {
    g.cylZ(0, yb - 0.008, 0.014, zE + 0.04, z0, cx.D); // buffer tube
    g.fill(-0.019, 0.019, yb - 0.075, yb + 0.022, zE, zE + len * 0.62, (x, y, z) => {
      const t = (z - zE) / (len * 0.62);
      const yTop = yb + 0.022 - t * 0.004;
      const yBot = yb - 0.075 + t * 0.055;
      if (y > yTop || y < yBot) return -1;
      if (Math.abs(x) > 0.015 && (y > yTop - 0.004 || y < yBot + 0.004)) return -1;
      return bodyC;
    });
    if (heavy) g.boxc(0.03, yb + 0.022, yb + 0.034, zE + 0.03, zE + len * 0.5, cx.A); // cheek riser
    g.boxc(0.04, yb - 0.078, yb + 0.024, zE - 0.012, zE, RUBBER);
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
      g.boxc(0.01, yb + 0.03, yb + 0.034, zE + len * 0.55, zE + len * 0.6, cx.S);
      g.boxc(0.012, yb - 0.115, yb - 0.08, zE + 0.03, zE + 0.045, cx.D); // monopod spike
    }
    g.boxc(0.038, yb - 0.09 - hb, yb + 0.032, zE - 0.012, zE, RUBBER);
    return;
  }
  // wood
  g.fill(-0.02, 0.02, yb - 0.1, yb + 0.02, zE, z0, (x, y, z) => {
    const t = (z - zE) / len;
    const yTop = yb + 0.018 - t * 0.012;
    const yBot = yb - 0.1 + t * 0.09;
    if (y > yTop || y < yBot) return -1;
    const w = 0.014 + (1 - t) * 0.005;
    if (Math.abs(x) > w) return -1;
    if (Math.abs(x) > w - 0.004 && (y > yTop - 0.005 || y < yBot + 0.005)) return -1;
    return heavy ? cx.A : cx.C;
  });
  g.boxc(0.034, yb - 0.098, yb + 0.02, zE - 0.012, zE, RUBBER);
}

// ------------------------------------------------------------------------------ recipes
function rifle(cx: Ctx) {
  const g = G;
  const id = cx.def.id;
  // the receiver is the rear part of the body; the handguard covers the rest
  cx.zR1 = cx.zR0 + cx.L * (id === 'lmg' ? 0.66 : id === 'smg' ? 0.72 : 0.58);
  const { zR0, zR1, rw, top, yb, D, K, C, C2, A } = cx;
  const lowerTop = 0.04;
  // lower receiver + magwell
  g.boxc(rw, 0, lowerTop, zR0 + 0.02, Math.min(zR1, 0.22), C);
  g.boxc(rw - 0.01, lowerTop - 0.004, lowerTop, zR0 + 0.02, Math.min(zR1, 0.22), G.shade(C, 0.8));
  // upper receiver
  g.boxc(rw, lowerTop, top, zR0, zR1, C2);
  g.boxc(rw + 0.004, lowerTop + 0.004, lowerTop + 0.012, zR0 + 0.02, zR1 - 0.02, C); // seam ridge
  // ejection port (right side) with the bolt carrier showing through
  g.box(-rw / 2, -rw / 2 + 0.006, lowerTop + 0.012, top - 0.016, 0.07, 0.15, 0);
  g.box(-rw / 2 + 0.008, -rw / 2 + 0.012, lowerTop + 0.012, top - 0.016, 0.07, 0.15, cx.S);
  // forward assist + charging handle
  g.box(-rw / 2 - 0.012, -rw / 2, top - 0.03, top - 0.012, 0.0, 0.03, D);
  g.boxc(0.026, top - 0.012, top + 0.002, zR0 - 0.018, zR0 + 0.01, D);
  // selector + mag release (accent)
  g.box(rw / 2, rw / 2 + 0.006, 0.02, 0.03, -0.03, -0.012, A);
  g.box(-rw / 2 - 0.004, -rw / 2, 0.006, 0.016, 0.06, 0.075, A);
  // takedown pins
  for (const z of [zR0 + 0.035, Math.min(zR1, 0.22) - 0.02]) g.cylX(0.022, z, 0.004, -rw / 2 - 0.002, rw / 2 + 0.002, cx.S);
  pistolGrip(cx, 0, 0.32, 0.11);
  triggerGroup(cx, 0, 0);

  // handguard
  const hgEnd = zR1 + (cx.tip - zR1) * (id === 'smg' ? 0.85 : 0.62);
  const hgR = id === 'lmg' ? 0.036 : id === 'smg' ? 0.024 : 0.028;
  if (id === 'dmr') {
    // wooden fore-end
    g.fill(-0.022, 0.022, yb - 0.04, yb + 0.018, zR1, hgEnd, (x, y) => (Math.abs(x) > 0.018 && (y > yb + 0.014 || y < yb - 0.036) ? -1 : C));
    g.cylZ(0, yb, 0.02, hgEnd, hgEnd + 0.02, D);
  } else if (id === 'sniper') {
    // flat-sided chassis fore-end
    g.boxc(0.044, yb - 0.04, yb + 0.022, zR1, hgEnd, C);
    g.fill(-0.023, 0.023, yb - 0.03, yb + 0.012, zR1 + 0.03, hgEnd - 0.03, (x, _y, z) => (Math.abs(x) > 0.019 && Math.round(z / GV) % 6 < 3 ? 0 : -1));
  } else {
    g.fill(-hgR, hgR, yb - hgR, yb + hgR, zR1, hgEnd, (x, y, z) => {
      const ax = Math.abs(x), ay = Math.abs(y - yb);
      if (ax + ay > hgR * 1.35) return -1; // octagon
      // vent slots along the sides
      if (ax > hgR - 0.006 && ay < hgR * 0.45 && Math.round(z / GV) % 5 < 2 && z > zR1 + 0.02 && z < hgEnd - 0.02) return -1;
      return A;
    });
    if (id === 'lmg') {
      // heavy barrel shroud with cooling holes and a carry handle
      g.cylZ(0, yb, 0.024, hgEnd, cx.tip - 0.08, D);
      g.fill(-0.025, 0.025, yb - 0.025, yb + 0.025, hgEnd + 0.01, cx.tip - 0.09, (x, y, z) => (Math.hypot(x, y - yb) > 0.02 && Math.round(z / GV) % 4 === 0 && Math.abs(y - yb) < 0.01 ? 0 : -1));
      g.boxc(0.012, yb + hgR - 0.004, top + 0.05, hgEnd - 0.12, hgEnd - 0.1, D);
      g.boxc(0.012, yb + hgR - 0.004, top + 0.05, hgEnd - 0.02, hgEnd, D);
      g.boxc(0.016, top + 0.04, top + 0.056, hgEnd - 0.12, hgEnd, K);
    }
  }
  const tip = barrel(cx, hgEnd - 0.02, cx.bore * 0.32);
  if (id === 'sniper') {
    // fluted barrel
    for (const a of [0, 1, 2, 3, 4, 5]) {
      const ang = (a / 6) * Math.PI * 2;
      const r = cx.bore * 0.32;
      g.box(Math.cos(ang) * r - 0.003, Math.cos(ang) * r + 0.003, yb + Math.sin(ang) * r - 0.003, yb + Math.sin(ang) * r + 0.003, hgEnd + 0.04, tip - 0.06, 0);
    }
  }
  // gas block / front sight base
  if (id !== 'sniper' && id !== 'dmr') g.cylZ(0, yb, cx.bore * 0.32 + 0.008, hgEnd, hgEnd + 0.025, D);
  muzzleDevice(cx, cx.bore * 0.32);

  // rail and sights
  if (id !== 'dmr') rail(cx, zR0 + 0.01, id === 'smg' || id === 'lmg' ? zR1 : hgEnd - 0.01);
  else rail(cx, zR0 + 0.04, zR0 + 0.22);
  const hasOptic = optic(cx, id === 'smg' ? zR0 + 0.04 : zR0 + 0.07);
  ironSights(cx, zR0 + 0.01, hgEnd - 0.005, hasOptic);

  // magazine
  if (id === 'lmg') {
    g.setPart('mag');
    // belt box on the left with a brass belt feeding the receiver
    g.box(0.03, 0.09, -0.11, 0.0, 0.03, 0.16, cx.A);
    g.box(0.03, 0.092, -0.004, 0.004, 0.03, 0.16, D);
    g.box(0.088, 0.094, -0.09, -0.02, 0.06, 0.13, D);
    g.fill(rw / 2 - 0.004, 0.032, 0.0, 0.03, 0.06, 0.12, (x, y, z) => (Math.round(z / GV) % 2 === 0 && y > x * 0.5 - 0.01 ? g.c(BRASS, 0.9) : -1));
    g.setPart('body');
    // feed cover
    g.boxc(rw + 0.004, top, top + 0.012, zR0 + 0.03, 0.18, D);
    g.boxc(0.012, top + 0.012, top + 0.02, zR0 + 0.03, zR0 + 0.05, cx.S);
    cx.meta.magAt.set(0.06, -0.05, 0.1);
  } else if (id === 'smg') {
    boxMag(cx, 0.1, 0, false, 0.022, 0.034, 0.13);
  } else if (id === 'sniper') {
    boxMag(cx, 0.08, 0, false, 0.03, 0.06, 0.05);
    // bolt handle on the right
    g.box(-rw / 2 - 0.03, -rw / 2, top - 0.022, top - 0.012, -0.03, -0.02, cx.S);
    g.cylX(top - 0.03, -0.025, 0.012, -rw / 2 - 0.05, -rw / 2 - 0.03, D);
  } else if (id === 'dmr') {
    boxMag(cx, 0.1, 0, false, 0.03, 0.058, 0.085);
    g.box(-rw / 2 - 0.014, -rw / 2, lowerTop + 0.01, lowerTop + 0.022, 0.12, 0.2, cx.S); // op rod
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
    if (cx.build.underbarrel !== 'bipod') g.boxc(0.024, yb - hgR - 0.012, yb - hgR, hgEnd - 0.06, hgEnd - 0.02, D);
  }
}

function shotgun(cx: Ctx) {
  const g = G;
  const { zR0, zR1, rw, top, yb, D, K, C, A } = cx;
  // receiver (metal)
  g.fill(-rw / 2, rw / 2, -0.005, top, zR0, zR1, (x, y) => (Math.abs(x) > rw / 2 - 0.004 && y > top - 0.006 ? -1 : A));
  g.box(-rw / 2, -rw / 2 + 0.006, 0.04, top - 0.016, 0.03, 0.12, 0); // ejection port
  g.box(-rw / 2 + 0.008, -rw / 2 + 0.012, 0.04, top - 0.016, 0.03, 0.12, cx.S);
  // side saddle with shells on the left
  g.box(rw / 2, rw / 2 + 0.008, 0.02, top - 0.01, zR0 + 0.03, zR0 + 0.14, K);
  for (let i = 0; i < 4; i++) {
    const z = zR0 + 0.04 + i * 0.026;
    g.cylY(rw / 2 + 0.016, z, 0.01, 0.02, top - 0.02, g.c(0xb8302a, 0.2));
    g.cylY(rw / 2 + 0.016, z, 0.01, top - 0.02, top - 0.01, g.c(BRASS, 0.9));
  }
  pistolGrip(cx, 0, 0.34, 0.11, K);
  triggerGroup(cx, 0, 0);
  const tip = barrel(cx, zR1 - 0.01, cx.bore * 0.3);
  // vent rib + bead
  g.boxc(0.01, yb + cx.bore * 0.3, yb + cx.bore * 0.3 + 0.008, zR1, tip - 0.01, D);
  g.boxc(0, yb + cx.bore * 0.3 + 0.008, yb + cx.bore * 0.3 + 0.016, tip - 0.014, tip - 0.006, g.c(0xf4f0e0, 0.6, 0.3));
  // magazine tube
  const mag = cx.build.magazine;
  const tubeEnd = zR1 + (tip - zR1) * (mag === 'extmag' ? 0.98 : 0.78);
  g.cylZ(0, yb - 0.034, 0.014, zR1, tubeEnd, D);
  g.cylZ(0, yb - 0.034, 0.016, tubeEnd - 0.012, tubeEnd, cx.S);
  // pump fore-end (animated)
  g.setPart('pump');
  const pz0 = zR1 + 0.03, pz1 = zR1 + 0.03 + Math.min(0.17, (tip - zR1) * 0.45);
  g.fill(-0.024, 0.024, yb - 0.058, yb - 0.008, pz0, pz1, (x, y, z) => {
    if (Math.hypot(x, (y - (yb - 0.034)) * 1.2) > 0.025) return -1;
    return Math.round(z / GV) % 3 === 0 && Math.abs(x) > 0.019 ? G.shade(C, 0.75) : C;
  });
  g.setPart('body');
  cx.meta.gripL.set(0, yb - 0.05, (pz0 + pz1) / 2);
  cx.meta.magAt.set(0, yb - 0.05, zR1 + 0.01);
  muzzleDevice(cx, cx.bore * 0.3);
  rail(cx, zR0 + 0.02, zR1 - 0.02);
  const has = optic(cx, zR0 + 0.04);
  if (!has) {
    cx.meta.sight.set(0, yb + cx.bore * 0.3 + 0.014, zR0 + 0.0);
    cx.meta.zoom = 1.12;
  }
  stock(cx, 'wood');
  underbarrel(cx, pz1 + 0.02, yb - 0.05);
}

function revolver(cx: Ctx) {
  const g = G;
  const { yb, D, C, A } = cx;
  const S = C; // stainless frame
  const cy = 0.036; // cylinder axis
  // frame: rounded back, window for the cylinder, top strap
  g.fill(-0.011, 0.011, -0.004, 0.072, -0.04, 0.03, (_x, y, z) => (z < -0.026 && y > 0.05 && Math.hypot(z + 0.026, y - 0.05) > 0.022 ? -1 : S));
  g.boxc(0.022, 0.06, 0.074, 0.03, 0.09, S);
  g.boxc(0.022, -0.004, 0.012, 0.03, 0.09, S);
  // grip (wood) raked back with panel lines
  G.fill(-0.015, 0.015, -0.1, 0.0, -0.1, 0.03, (x, y, z) => {
    const zc = -0.012 + y * 0.5;
    const dz = z - zc;
    if (Math.abs(dz) > 0.019) return -1;
    if (Math.abs(x) > 0.011 && Math.abs(dz) > 0.013) return -1;
    if (Math.abs(x) > 0.013) return -1;
    if (y > -0.012) return S;
    return Math.abs(x) > 0.009 && Math.round((y - z) / GV) % 3 === 0 ? G.shade(A, 0.8) : A;
  });
  // hammer
  g.boxc(0, 0.05, 0.078, -0.045, -0.034, D);
  g.boxc(0.01, 0.074, 0.082, -0.058, -0.042, D);
  triggerGroup(cx, -0.045, 0.006);
  // cylinder (rotates)
  g.setPart('cyl');
  g.cylZ(0, cy, 0.027, 0.032, 0.088, G.shade(S, 0.85));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    g.cylZ(Math.cos(a) * 0.028, cy + Math.sin(a) * 0.028, 0.007, 0.04, 0.08, 0); // flutes
    const b = a + Math.PI / 6;
    g.cylZ(Math.cos(b) * 0.016, cy + Math.sin(b) * 0.016, 0.005, 0.086, 0.088, 0); // chambers
  }
  g.setPart('body');
  // barrel with top rib and full-length ejector shroud
  const tip = barrel(cx, 0.09, 0.011);
  g.boxc(0.022, yb - 0.006, yb + 0.014, 0.09, tip, S);
  g.boxc(0.01, yb + 0.014, yb + 0.02, 0.09, tip, S);
  g.boxc(0.018, yb - 0.03, yb - 0.006, 0.09, tip - 0.006, S);
  g.boxc(0, yb + 0.02, yb + 0.03, tip - 0.016, tip - 0.006, g.c(0xff6a2a, 0.3, 0.4)); // front blade insert
  g.fill(-0.011, 0.011, 0.074, 0.082, -0.03, -0.02, (x) => (Math.abs(x) < 0.003 ? -1 : D)); // rear notch
  muzzleDevice(cx, 0.011);
  cx.top = 0.072;
  cx.rail = cx.top + 0.012;
  if (cx.build.optic && cx.build.optic !== 'iron') rail(cx, 0.03, 0.09, 0.022);
  const has = optic(cx, 0.0);
  if (!has) {
    cx.meta.sight.set(0, yb + 0.026, -0.03);
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
  // launch tube with a bell at the back and a heat shield
  g.cylZ(0, yt, 0.045, z0 + 0.08, z1, C, 0.034);
  g.fill(-0.07, 0.07, yt - 0.07, yt + 0.07, z0, z0 + 0.08, (x, y, z) => {
    const r = 0.045 + (z0 + 0.08 - z) * 0.3;
    const d = Math.hypot(x, y - yt);
    return d <= r && d > r - 0.008 ? D : -1;
  });
  g.cylZ(0, yt, 0.049, 0.0, 0.26, G.shade(C, 0.7), 0.044);
  for (let z = 0.02; z < 0.26; z += 0.04) g.cylZ(0, yt, 0.05, z, z + 0.01, D, 0.045);
  g.cylZ(0, yt, 0.05, z1 - 0.03, z1, A, 0.034);
  // grips
  pistolGrip(cx, 0, 0.18, 0.1, K);
  g.boxc(0.024, -0.005, yt - 0.04, -0.03, 0.06, D);
  triggerGroup(cx, -0.01, 0);
  g.fill(-0.016, 0.016, -0.09, yt - 0.04, 0.2, 0.25, (x, _y, z) => (Math.hypot(x, z - 0.225) < 0.018 ? K : -1));
  // flip-up sight frame on the left
  const sx = 0.05;
  g.box(sx - 0.004, sx + 0.004, yt - 0.01, yt + 0.06, 0.06, 0.07, D);
  g.box(sx - 0.004, sx + 0.004, yt + 0.035, yt + 0.06, 0.05, 0.07, D);
  g.box(sx - 0.004, sx + 0.004, yt + 0.042, yt + 0.054, 0.0, 0.06, 0);
  g.box(sx - 0.003, sx + 0.003, yt, yt + 0.06, 0.32, 0.33, D);
  g.box(sx - 0.008, sx + 0.008, yt + 0.02, yt + 0.024, 0.32, 0.33, D);
  g.box(0.04, 0.05, yt - 0.006, yt + 0.006, 0.05, 0.34, D);
  // warhead peeking from the muzzle (hidden while empty)
  g.setPart('warhead');
  g.cylZ(0, yt, 0.032, z1 - 0.06, z1 + 0.02, g.c(0x3c4632, 0.3));
  g.fill(-0.05, 0.05, yt - 0.05, yt + 0.05, z1 + 0.02, z1 + 0.16, (x, y, z) => {
    const t = (z - z1 - 0.02) / 0.14;
    const r = 0.048 * Math.sqrt(Math.max(0, 1 - t * t * 0.9)) * (t < 0.15 ? 0.75 + t * 1.6 : 1);
    return Math.hypot(x, y - yt) <= r ? (t > 0.82 ? g.c(0x2a2c2e, 0.5) : A) : -1;
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
  cx.meta.sight.set(has ? cx.meta.sight.x : sx, has ? cx.meta.sight.y : yt + 0.048, has ? cx.meta.sight.z : -0.02);
  if (!has) cx.meta.zoom = 1.15;
  cx.meta.muzzle.set(0, yt, z1 + 0.18);
  cx.meta.gripL.set(0, -0.04, 0.225);
  cx.meta.magAt.set(0, yt, z1 + 0.06);
}

function grenadeLauncher(cx: Ctx) {
  const g = G;
  const { yb, D, K, C, A } = cx;
  // frame
  g.boxc(0.04, -0.01, 0.03, -0.1, 0.06, C);
  pistolGrip(cx, 0, 0.3, 0.1, K);
  triggerGroup(cx, -0.01, -0.005);
  // revolving drum
  g.setPart('cyl');
  const cy = yb - 0.025;
  g.cylZ(0, cy, 0.068, 0.06, 0.2, A);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.cylZ(Math.cos(a) * 0.04, cy + Math.sin(a) * 0.04, 0.019, 0.195, 0.2, 0);
    g.cylZ(Math.cos(a + 0.52) * 0.068, cy + Math.sin(a + 0.52) * 0.068, 0.012, 0.09, 0.17, 0);
  }
  for (let z = 0.08; z < 0.19; z += 0.035) g.cylZ(0, cy, 0.07, z, z + 0.008, D);
  g.setPart('body');
  g.cylZ(0, cy, 0.016, 0.03, 0.06, D); // spindle
  // barrel
  const tip = barrel(cx, 0.2, 0.034);
  g.cylZ(0, yb, 0.026, tip - 0.01, tip, 0);
  g.boxc(0.02, yb + 0.034, yb + 0.044, 0.2, tip, D);
  // front grip under the barrel
  g.fill(-0.016, 0.016, yb - 0.12, yb - 0.03, 0.23, 0.27, (x, _y, z) => (Math.hypot(x, z - 0.25) < 0.017 ? K : -1));
  // quadrant sight on the right
  g.box(-0.05, -0.036, yb + 0.02, yb + 0.07, 0.05, 0.08, D);
  g.box(-0.046, -0.04, yb + 0.05, yb + 0.06, 0.08, 0.12, D);
  muzzleDevice(cx, 0.034);
  cx.top = 0.106;
  cx.rail = cx.top + 0.012;
  g.boxc(0.026, 0.03, cx.top, -0.07, -0.05, D);
  g.boxc(0.026, 0.096, cx.top, -0.07, 0.24, D);
  rail(cx, -0.06, 0.2, 0.026);
  const has = optic(cx, 0.0);
  if (!has) {
    cx.meta.sight.set(-0.043, yb + 0.062, 0.03);
    cx.meta.zoom = 1.15;
  }
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
    if (Math.abs(x) > 0.043 && Math.round(z / GV) % 3 === 0 && y > 0.02 && y < 0.08 && z < 0.06) return D; // vents
    return C;
  });
  g.boxc(0.06, 0.1, 0.112, -0.1, 0.12, D);
  // top carry handle
  g.boxc(0.014, 0.112, 0.16, -0.06, -0.045, D);
  g.boxc(0.014, 0.112, 0.16, 0.08, 0.095, D);
  g.boxc(0.022, 0.15, 0.17, -0.06, 0.095, K);
  // rear grip + trigger
  pistolGrip(cx, -0.02, 0.2, 0.1, K);
  // ammo feed chute from the left with brass
  g.box(0.045, 0.07, -0.01, 0.07, -0.02, 0.1, A);
  g.fill(0.07, 0.11, -0.12, 0.04, 0.0, 0.08, (x, y, z) => (y < 0.04 - (x - 0.07) * 2.2 && y > -0.12 + (0.11 - x) * 0 && Math.round(y / GV) % 2 === 0 && Math.abs(z - 0.04) < 0.03 ? g.c(BRASS, 0.9) : -1));
  // rotor: barrels, clamps and the front ring (spins)
  g.setPart('rotor');
  const z0 = 0.16, tip = cx.tip;
  g.cylZ(0, yb, 0.042, z0, z0 + 0.06, D);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.cylZ(Math.cos(a) * 0.026, yb + Math.sin(a) * 0.026, 0.009, z0, tip, D);
    g.cylZ(Math.cos(a) * 0.026, yb + Math.sin(a) * 0.026, 0.004, tip - 0.004, tip, 0);
  }
  g.cylZ(0, yb, 0.04, tip - 0.13, tip - 0.11, A, 0.034);
  g.cylZ(0, yb, 0.04, tip - 0.03, tip - 0.01, cx.S, 0.034);
  g.setPart('body');
  // side grip for the off hand
  g.box(0.045, 0.06, 0.02, 0.06, 0.12, 0.14, D);
  g.fill(0.06, 0.1, 0.0, 0.08, 0.12, 0.15, (x, y, z) => (Math.hypot(y - 0.04, z - 0.135) < 0.016 ? K : -1));
  underbarrel(cx, 0.06, -0.02);
  cx.meta.sight.set(0, 0.185, -0.06);
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

export function gunModel(def: WeaponDef, build: Build): GunModel {
  const key = buildKey(def, build);
  const hit = cache.get(key);
  if (hit) return hit;
  const m = def.model;
  G.reset();
  G.setPart('body');
  const bulky = !!m.bulky;
  const C = G.c(m.color, 0.35);
  const ctx: Ctx = {
    def,
    build,
    L: m.length,
    B: m.barrel,
    bore: m.bore,
    rw: def.id === 'lmg' ? 0.07 : bulky ? 0.06 : def.id === 'smg' ? 0.046 : 0.05,
    top: def.id === 'lmg' ? 0.1 : def.id === 'smg' ? 0.078 : 0.085,
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
      lensR: 0,
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
  for (const p of Object.values(pivots)) p.set(Math.round(p.x / GV) * GV, Math.round(p.y / GV) * GV, Math.round(p.z / GV) * GV);
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
  const key = `${gun.key}|${team}`;
  const hit = handCache.get(key);
  if (hit) return hit;
  const sleeve = team === 0 ? 0x4a5a46 : 0x7a6a4a;
  const cuff = team === 0 ? 0x3d7fe6 : 0xe0483a;
  const glove = 0x2b2a26;
  const knuckle = 0x3a3832;
  const build = (side: 1 | -1) => {
    G.reset();
    G.setPart('body');
    const S = G.c(sleeve, 0.08), Cf = G.c(cuff, 0.15), Gl = G.c(glove, 0.18), Kn = G.c(knuckle, 0.25);
    // hand at the origin; forearm back toward the camera corner
    const dir = side === 1 ? new THREE.Vector3(-0.42, -0.5, -0.76).normalize() : new THREE.Vector3(0.5, -0.5, -0.71).normalize();
    // fist
    G.fill(-0.04, 0.04, -0.05, 0.035, -0.05, 0.05, (x, y, z) => {
      const r = Math.hypot(x / 0.038, y / 0.032, z / 0.045);
      if (r > 1) return -1;
      // knuckle ridge on the outside
      const outside = side === 1 ? x < -0.026 : x > 0.026;
      if (outside && y > 0.0 && Math.round(z / GV) % 2 === 0) return Kn;
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
      G.obb(dir.x * c, dir.y * c, dir.z * c, dir, 0.006, 0.044, 0.042, G.c(lighten(sleeve, 0.82), 0.08), 0.016);
    }
    return G.meshPart(0, new THREE.Vector3())!;
  };
  const res = { right: build(1), left: build(-1) };
  handCache.set(key, res);
  void gun;
  return res;
}
