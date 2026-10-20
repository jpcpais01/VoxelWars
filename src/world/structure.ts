// Structural integrity, run off the main thread on a box of voxels around fresh damage.
//
// Each check treats a piece of a structure as a rigid block resting on the voxels it still
// touches across one plane, and asks whether those few bonds can carry it:
//  - loose:   the piece touches nothing that leads to the ground (the old flood fill)
//  - crush:   too much weight for the cross-section left under it (a tower on a thin neck)
//  - tip:     the weight sits off-centre over what's left, so the far side of the cut tears open
//             (a notched trunk falls toward the notch, a half-blown wall leans out and goes)
//  - bend:    a piece held only from the side snaps at its root (balconies, branches, a bridge
//             deck whose pier is gone); stiffness grows with depth², like a real beam
//  - shear:   a side-held piece is simply too heavy for its bonds
// Stresses come from the classic eccentric-load formula σ = W/A + W·eᵀI⁻¹r over the support
// cells, so the shape of what's left matters, not just how many voxels there are.
// Leaves never carry load: their weight is handed to the nearest wood, and they fall with it.
import { WY } from '../core/config';
import { MATS } from './materials';

/** per-material weight and bond strengths (in "stone voxel weights" per bond) */
export const MASS = new Float32Array(256);
export const COMP = new Float32Array(256);
export const TENS = new Float32Array(256);
export const SHEAR = new Float32Array(256);
export const LEAF = new Uint8Array(256);
/** wood, and the foliage trees grow (not bushes, ferns or ivy) */
export const WOOD = new Uint8Array(256);
export const CROWN = new Uint8Array(256);
/** indestructible materials (bedrock) hold everything they touch */
export const FIXED = new Uint8Array(256);

{
  const set = (m: number, mass: number, c: number, t: number, v: number) => {
    MASS[m] = mass; COMP[m] = c; TENS[m] = t; SHEAR[m] = v;
  };
  MATS.forEach((d, i) => {
    if (!d) return;
    if (i > 0 && d.hp <= 0) FIXED[i] = 1;
    if (d.kind === 'wood') WOOD[i] = 1;
    if (d.kind === 'leaf' && !/bush|fern/.test(d.name)) CROWN[i] = 1;
    switch (d.kind) {
      case 'stone': set(i, 1, 320, 60, 70); break;
      case 'ground': set(i, 0.85, 150, 5, 15); break;
      case 'build': set(i, 0.85, 400, 40, 70); break;
      case 'metal': set(i, 1.6, 3000, 2500, 800); break;
      case 'wood': set(i, 0.45, 300, 380, 60); break;
      case 'leaf': set(i, 0.012, 0, 0, 0); LEAF[i] = 1; break;
      case 'soft': set(i, 0.5, 100, 10, 10); break;
      case 'glow': set(i, 0.5, 200, 50, 50); break;
    }
  });
  // a few materials that don't behave like their family
  const by = (name: string) => MATS.findIndex((d) => d?.name === name);
  const hay = by('hay'), canvas = by('canvas'), moss = by('moss'), crate = by('crate'), barrel = by('fuel barrel');
  if (hay > 0) set(hay, 0.15, 40, 5, 5);
  if (canvas > 0) set(canvas, 0.1, 200, 400, 60);
  if (moss > 0) set(moss, 0.2, 60, 5, 5);
  if (crate > 0) set(crate, 0.3, 150, 80, 30);
  if (barrel > 0) set(barrel, 0.6, 300, 200, 80);
  const roofs = [by('roof tiles'), by('slate roof')];
  for (const r of roofs) if (r > 0) set(r, 0.6, 300, 50, 60);
  const trim = by('trim');
  if (trim > 0) set(trim, 0.6, 300, 120, 60);
}

export interface StructJob {
  id: number;
  /** world voxel coordinates of the box's low corner; the box always spans the full height */
  x0: number;
  z0: number;
  sx: number;
  sz: number;
  /** sx*sz*WY voxels, index (lx*sz + lz)*WY + y */
  vox: Uint8Array;
  /** natural terrain height per column: voxels below it are held by the ground */
  ground: Uint8Array;
  /** local x,y,z of voxels destroyed since the last check: planes are tried through their bounds */
  removed: Int16Array;
  /** local x,y,z of rubble that just landed: only checked for being loose */
  rubble: Int16Array;
  /** 1 where a voxel is settled rubble: a heap holds itself up, so only the loose check sees it */
  rubbleMask: Uint8Array;
}

export const enum Fail {
  Loose = 0,
  Crush = 1,
  Tip = 2,
  Bend = 3,
  Shear = 4,
}

export interface StructBody {
  /** local voxel indices (solid voxels and the leaves they carry) */
  idx: Int32Array;
  /** materials as they were in the job's box, so stale results can be rejected */
  mats: Uint8Array;
  kind: Fail;
  /** hinge point in local voxel units (the edge it pivots over) */
  hx: number;
  hy: number;
  hz: number;
  /** horizontal fall direction (0,0 when it just drops) */
  dx: number;
  dz: number;
  /** how far past its limit the weakest bond was */
  ratio: number;
}

export interface StructResult {
  id: number;
  bodies: StructBody[];
  /** voxel visits, for the debug overlay */
  work: number;
}

/** strength of a bond through a shared edge, relative to a shared face */
const EDGE_W = 0.3;
/** pieces bigger than this are assumed to be held by something outside the box */
const MAX_PART = 90000;
const MAX_ROUNDS = 6;

class Scratch {
  cap = 0;
  stamp = new Int32Array(0);
  owner = new Int32Array(0);
  extra = new Float32Array(0);
  inBody = new Uint8Array(0);
  stack = new Int32Array(0);
  part = new Int32Array(0);
  best = new Int32Array(0);
  gen = 1;

  ensure(n: number) {
    if (n <= this.cap) {
      this.owner.fill(-1, 0, n);
      this.extra.fill(0, 0, n);
      this.inBody.fill(0, 0, n);
      return;
    }
    this.cap = n;
    this.stamp = new Int32Array(n);
    this.owner = new Int32Array(n).fill(-1);
    this.extra = new Float32Array(n);
    this.inBody = new Uint8Array(n);
    this.stack = new Int32Array(Math.min(n, MAX_PART * 6 + 64));
    this.part = new Int32Array(MAX_PART + 8);
    this.best = new Int32Array(MAX_PART + 8);
    this.gen = 1;
  }

  nextStamp() {
    if (this.gen > 0x3fff0000) {
      this.stamp.fill(0);
      this.gen = 1;
    }
    return ++this.gen;
  }
}

const scratch = new Scratch();

interface Part {
  n: number;
  mass: number;
  cx: number;
  cy: number;
  cz: number;
}

export function solveStructure(job: StructJob): StructResult {
  const { sx, sz, vox, ground, rubbleMask } = job;
  const N = sx * sz * WY;
  const S = scratch;
  S.ensure(N);
  const { stamp, owner, extra, inBody } = S;
  const SXs = sz * WY; // index step along x
  let work = 0;

  const edgeCol = (col: number) => {
    const lx = (col / sz) | 0, lz = col - lx * sz;
    return lx === 0 || lz === 0 || lx === sx - 1 || lz === sz - 1;
  };
  const anchored = (i: number) => {
    const y = i % WY;
    const col = (i / WY) | 0;
    return y <= 1 || y < ground[col] || edgeCol(col) || FIXED[vox[i]] === 1;
  };
  const solid = (i: number) => {
    const m = vox[i];
    return m !== 0 && LEAF[m] === 0;
  };
  const coord = (i: number, axis: number) => {
    if (axis === 1) return i % WY;
    const col = (i / WY) | 0;
    return axis === 0 ? (col / sz) | 0 : col % sz;
  };
  // face neighbours plus the 12 edge neighbours: voxel stairs (roofs, thin branches) hold together
  // through their shared edges, just more weakly. The last one pushed is explored first, so -y goes
  // last and a search from anything standing finds the ground fast.
  const NB: { o: number; dx: number; dy: number; dz: number; w: number }[] = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) {
        const k = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (k === 2) NB.push({ o: dx * SXs + dy + dz * WY, dx, dy, dz, w: EDGE_W });
      }
  for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]])
    NB.push({ o: dx * SXs + dy + dz * WY, dx, dy, dz, w: 1 });
  const offs = [1, SXs, -SXs, WY, -WY, -1];
  const inBox = (i: number, o: number) => {
    const y = i % WY;
    if (o === 1) return y < WY - 1;
    if (o === -1) return y > 0;
    const col = (i / WY) | 0;
    const lx = (col / sz) | 0, lz = col - lx * sz;
    if (o === SXs) return lx < sx - 1;
    if (o === -SXs) return lx > 0;
    if (o === WY) return lz < sz - 1;
    return lz > 0;
  };

  // ------------------------------------------------------------------ leaves: who carries them
  // Tree foliage goes to the nearest wood it can reach through leaves first, so a crown leaning on
  // a wall still belongs to its tree; whatever's left (bushes, ivy, loose clumps) goes to the
  // nearest solid voxel of any kind.
  const leafList: number[] = [];
  {
    const q: number[] = [];
    const spread = (from: number, onlyCrown: boolean) => {
      for (let h = from; h < q.length; h++) {
        const i = q[h];
        for (const o of offs) {
          if (!inBox(i, o)) continue;
          const n = i + o;
          const m = vox[n];
          if (LEAF[m] !== 1 || owner[n] >= 0 || (onlyCrown && CROWN[m] !== 1)) continue;
          owner[n] = owner[i];
          q.push(n);
        }
      }
    };
    for (let col = 0; col < sx * sz; col++) {
      const base = col * WY;
      for (let y = 1; y < WY - 1; y++) {
        const i = base + y;
        const m = vox[i];
        if (LEAF[m] !== 1) continue;
        leafList.push(i);
        if (CROWN[m] !== 1) continue;
        for (const o of offs) {
          if (!inBox(i, o)) continue;
          if (WOOD[vox[i + o]] === 1) {
            owner[i] = i + o;
            q.push(i);
            break;
          }
        }
      }
    }
    spread(0, true);
    const start = q.length;
    for (const i of leafList) {
      if (owner[i] >= 0) continue;
      for (const o of offs) {
        if (!inBox(i, o)) continue;
        if (solid(i + o)) {
          owner[i] = i + o;
          q.push(i);
          break;
        }
      }
    }
    spread(start, false);
    for (const l of leafList) if (owner[l] >= 0) extra[owner[l]] += MASS[vox[l]];
    work += leafList.length;
  }

  // ------------------------------------------------------------------ seeds and planes
  const seeds: number[] = [];
  let ax0 = 1e9, ax1 = -1e9, ay0 = 1e9, ay1 = -1e9, az0 = 1e9, az1 = -1e9;
  const r = job.removed;
  for (let k = 0; k < r.length; k += 3) {
    const x = r[k], y = r[k + 1], z = r[k + 2];
    if (x < 0 || z < 0 || x >= sx || z >= sz || y < 0 || y >= WY) continue;
    if (x < ax0) ax0 = x;
    if (x > ax1) ax1 = x;
    if (y < ay0) ay0 = y;
    if (y > ay1) ay1 = y;
    if (z < az0) az0 = z;
    if (z > az1) az1 = z;
    const i = (x * sz + z) * WY + y;
    for (const nb of NB) {
      const nx = x + nb.dx, ny = y + nb.dy, nz = z + nb.dz;
      if (nx < 0 || nz < 0 || nx >= sx || nz >= sz || ny < 0 || ny >= WY) continue;
      if (vox[i + nb.o] !== 0) seeds.push(i + nb.o);
    }
  }
  const rb = job.rubble;
  for (let k = 0; k < rb.length; k += 3) {
    const x = rb[k], y = rb[k + 1], z = rb[k + 2];
    if (x < 0 || z < 0 || x >= sx || z >= sz || y < 0 || y >= WY) continue;
    const i = (x * sz + z) * WY + y;
    if (vox[i] !== 0) seeds.push(i);
  }
  const hasPlanes = ax1 >= ax0;

  // ------------------------------------------------------------------ explore one piece
  // axis -1: no plane. Otherwise the piece is restricted to one side of the plane between
  // L-1 and L (side +1: coord >= L, side -1: coord < L) and the bonds across it are its support.
  const part = S.part;
  // support bonds across the plane: position in plane coordinates, materials, bond weight
  const supU: number[] = [], supV: number[] = [], supA: number[] = [], supB: number[] = [], supW: number[] = [];
  const P: Part = { n: 0, mass: 0, cx: 0, cy: 0, cz: 0 };
  const explore = (seed: number, axis: number, side: number, L: number, passStamp: number): boolean => {
    const me = S.nextStamp();
    const stack = S.stack;
    let sp = 0;
    stack[sp++] = seed;
    stamp[seed] = me;
    P.n = 0; P.mass = 0; P.cx = 0; P.cy = 0; P.cz = 0;
    supU.length = 0; supV.length = 0; supA.length = 0; supB.length = 0; supW.length = 0;
    const edge = axis < 0 ? -2 : side > 0 ? L : L - 1;
    const across = -side;
    while (sp > 0) {
      const i = stack[--sp];
      work++;
      if (anchored(i)) return false;
      if (P.n >= MAX_PART) return false;
      part[P.n++] = i;
      const m = vox[i];
      const w = MASS[m] + extra[i];
      const y = i % WY, col = (i / WY) | 0, lx = (col / sz) | 0, lz = col - lx * sz;
      P.mass += w; P.cx += lx * w; P.cy += y * w; P.cz += lz * w;
      const c = axis < 0 ? -1 : axis === 1 ? y : axis === 0 ? lx : lz;
      for (const nb of NB) {
        const nx = lx + nb.dx, ny = y + nb.dy, nz = lz + nb.dz;
        if (nx < 0 || nz < 0 || nx >= sx || nz >= sz || ny < 0 || ny >= WY) continue;
        const n = i + nb.o;
        const nm = vox[n];
        if (nm === 0 || LEAF[nm] === 1 || (axis >= 0 && rubbleMask[n] === 1)) continue;
        if (c === edge && (axis === 1 ? nb.dy : axis === 0 ? nb.dx : nb.dz) === across) {
          // the neighbour across the plane is support, not part of the piece
          if (axis === 1) {
            supU.push(lz + 0.5 + nb.dz * 0.5);
            supV.push(lx + 0.5 + nb.dx * 0.5);
          } else {
            supU.push((axis === 0 ? lz + nb.dz * 0.5 : lx + nb.dx * 0.5) + 0.5);
            supV.push(y + 0.5 + nb.dy * 0.5);
          }
          supA.push(m);
          supB.push(nm);
          supW.push(nb.w);
          continue;
        }
        const s = stamp[n];
        if (s === me) continue;
        if (s > passStamp) return false; // touches a piece already found to be held
        stamp[n] = me;
        if (sp >= stack.length) return false;
        stack[sp++] = n;
      }
    }
    return true;
  };

  /**
   * Plastic capacity of a bond line along one direction: every half cell can push up to C or
   * pull up to T. Fill the cells furthest along `p` with compression first (the side the weight
   * leans toward) until they carry `force`, everything else pulls: the result is the largest
   * moment the section can hold about the origin of `p`. Weak bonds (moss, a dirt seam) just
   * contribute little, they don't decide the whole section on their own.
   */
  const cells: { p: number; c: number; t: number }[] = [];
  const maxMoment = (force: number): number => {
    cells.sort((a, b) => b.p - a.p);
    let total = 0, M = 0;
    for (const c of cells) {
      total -= c.t;
      M -= c.t * c.p;
    }
    for (const c of cells) {
      const room = force - total;
      if (room <= 0) break;
      const inc = c.c + c.t;
      const d = Math.min(inc, room);
      total += d;
      M += d * c.p;
    }
    return total < force - 1e-6 ? -Infinity : M;
  };
  const pushCell = (p: number, m1: number, m2: number, w: number) => {
    const C = Math.min(COMP[m1], COMP[m2]) * 0.5 * w, T = Math.min(TENS[m1], TENS[m2]) * 0.5 * w;
    cells.push({ p: p + 0.25, c: C, t: T }, { p: p - 0.25, c: C, t: T });
  };

  /** how far past breaking the support of the piece just explored is (>1 breaks) */
  const hinge = { x: 0, y: 0, z: 0, dx: 0, dz: 0, kind: Fail.Loose };
  const evaluate = (axis: number, side: number, L: number): number => {
    const A = supU.length;
    if (A === 0) {
      hinge.kind = Fail.Loose;
      hinge.dx = 0; hinge.dz = 0;
      return Infinity;
    }
    const W = P.mass;
    const mx = P.cx / W + 0.5, mz = P.cz / W + 0.5; // centre of mass, voxel units
    // bond-weighted centroid of the support
    let cu = 0, cv = 0, ws = 0;
    for (let k = 0; k < A; k++) {
      cu += supU[k] * supW[k]; cv += supV[k] * supW[k]; ws += supW[k];
    }
    cu /= ws; cv /= ws;
    const us = supU, vs = supV;
    cells.length = 0;
    if (axis === 1) {
      // floor cut: the weight pushes down off-centre by e. Crushing needs more than every bond can
      // take; tipping needs a bigger lean than the bonds can hold back by pulling on the far side.
      const eu = mz - cu, ev = mx - cv;
      const el = Math.hypot(eu, ev);
      const nu = el > 1e-4 ? eu / el : 1, nv = el > 1e-4 ? ev / el : 0;
      let sumC = 0;
      let bestDot = -1e9, hu = cu, hv = cv;
      for (let k = 0; k < A; k++) {
        const m1 = supA[k], m2 = supB[k];
        sumC += Math.min(COMP[m1], COMP[m2]) * supW[k];
        const d = (us[k] - cu) * nu + (vs[k] - cv) * nv;
        pushCell(d, m1, m2, supW[k]);
        if (d > bestDot) { bestDot = d; hu = us[k]; hv = vs[k]; }
      }
      const crushR = W / sumC;
      let tipR = 0;
      if (crushR < 1 && el > 1e-3) {
        const Mmax = maxMoment(W);
        tipR = Mmax > 0 ? (W * el) / Mmax : Infinity;
      }
      hinge.kind = tipR >= crushR ? Fail.Tip : Fail.Crush;
      if (el > 0.35) {
        hinge.dx = nv; hinge.dz = nu;
        hinge.x = hv + nv * 0.5; hinge.z = hu + nu * 0.5;
      } else {
        hinge.dx = 0; hinge.dz = 0;
        hinge.x = cv; hinge.z = cu;
      }
      hinge.y = L;
      return Math.max(tipR, crushR);
    }
    // side cut: the piece hangs off the plane, so its bonds shear and bend (top pulls, bottom pushes)
    let vMin = 1e9, sumV = 0;
    for (let k = 0; k < A; k++) {
      const m1 = supA[k], m2 = supB[k];
      sumV += Math.min(SHEAR[m1], SHEAR[m2]) * supW[k];
      pushCell(vs[k] - cv, m1, m2, supW[k]);
      if (vs[k] < vMin) vMin = vs[k];
    }
    const lever = Math.max(0, ((axis === 0 ? mx : mz) - L) * side);
    const shearR = W / sumV;
    // no net push across the plane: the most moment the bonds can make with tension on top
    const Mmax = maxMoment(0);
    const bendR = lever > 0 ? (Mmax > 0 ? (W * lever) / Mmax : Infinity) : 0;
    hinge.kind = bendR >= shearR ? Fail.Bend : Fail.Shear;
    if (axis === 0) {
      hinge.x = L; hinge.z = cu; hinge.dx = side; hinge.dz = 0;
    } else {
      hinge.z = L; hinge.x = cu; hinge.dx = 0; hinge.dz = side;
    }
    hinge.y = vMin - 0.5;
    if (hinge.kind === Fail.Shear) { hinge.dx = 0; hinge.dz = 0; }
    return Math.max(bendR, shearR);
  };

  // ------------------------------------------------------------------ rounds
  const bodies: StructBody[] = [];
  let live = seeds.slice();

  const takeBody = (list: Int32Array | number[], n: number, kind: Fail, h: typeof hinge, ratio: number) => {
    const idx: number[] = [];
    for (let k = 0; k < n; k++) {
      const i = list[k];
      if (vox[i] === 0) continue;
      inBody[i] = 1;
      idx.push(i);
    }
    for (const l of leafList) {
      if (vox[l] === 0) continue;
      const o = owner[l];
      if (o >= 0 && inBody[o] === 1) idx.push(l);
    }
    const mats = new Uint8Array(idx.length);
    const newSeeds: number[] = [];
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      mats[k] = vox[i];
    }
    // collect what it was resting on before it goes, so the stump is checked next round
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      if (LEAF[vox[i]] === 1) continue;
      for (const o of offs) {
        if (!inBox(i, o)) continue;
        const nb = i + o;
        if (vox[nb] !== 0 && inBody[nb] === 0) newSeeds.push(nb);
      }
    }
    for (const i of idx) vox[i] = 0;
    bodies.push({ idx: Int32Array.from(idx), mats, kind, hx: h.x, hy: h.y, hz: h.z, dx: h.dx, dz: h.dz, ratio });
    return newSeeds;
  };

  for (let round = 0; round < MAX_ROUNDS && live.length; round++) {
    let next: number[] = [];
    // loose pieces first
    {
      const pass = S.nextStamp();
      for (const s of live) {
        if (vox[s] === 0 || stamp[s] > pass) continue;
        if (LEAF[vox[s]] === 1) {
          const o = owner[s];
          if (o >= 0 && vox[o] !== 0) continue;
          // a clump of foliage nothing solid holds
          const me = S.nextStamp();
          const q = [s];
          stamp[s] = me;
          for (let h = 0; h < q.length && q.length < MAX_PART; h++) {
            const i = q[h];
            work++;
            for (const o2 of offs) {
              if (!inBox(i, o2)) continue;
              const n = i + o2;
              if (LEAF[vox[n]] !== 1 || stamp[n] === me) continue;
              stamp[n] = me;
              q.push(n);
            }
          }
          hinge.dx = 0; hinge.dz = 0;
          next.push(...takeBody(q, q.length, Fail.Loose, hinge, Infinity));
          continue;
        }
        if (!explore(s, -1, 0, 0, pass)) continue;
        hinge.dx = 0; hinge.dz = 0;
        hinge.x = P.cx / P.mass + 0.5; hinge.y = 0; hinge.z = P.cz / P.mass + 0.5;
        next.push(...takeBody(part, P.n, Fail.Loose, hinge, Infinity));
      }
    }
    if (next.length || !hasPlanes) {
      live = live.filter((i) => vox[i] !== 0).concat(next);
      if (!next.length) break;
      continue;
    }
    // then every plane through the damage: keep the single weakest piece this round
    let bestR = 1, bestN = 0;
    const bh = { ...hinge };
    const tryPlane = (axis: number, side: number, L: number) => {
      const pass = S.nextStamp();
      for (const s of live) {
        if (vox[s] === 0 || LEAF[vox[s]] === 1 || rubbleMask[s] === 1 || stamp[s] > pass) continue;
        const c = coord(s, axis);
        if (side > 0 ? c < L : c >= L) continue;
        if (!explore(s, axis, side, L, pass)) continue;
        const ratio = evaluate(axis, side, L);
        if (ratio > bestR) {
          bestR = ratio;
          bestN = P.n;
          S.best.set(part.subarray(0, P.n));
          Object.assign(bh, hinge);
        }
      }
    };
    // a big crater gets a handful of evenly spread cuts per axis rather than one per voxel layer
    const levels = (lo: number, hi: number, max: number, cb: (L: number) => void) => {
      const step = Math.max(1, Math.ceil((hi - lo + 1) / max));
      for (let L = lo; L <= hi; L += step) cb(L);
    };
    levels(Math.max(2, ay0 - 1), Math.min(WY - 1, ay1 + 2), 12, (L) => tryPlane(1, 1, L));
    levels(Math.max(1, ax0 - 1), Math.min(sx - 1, ax1 + 2), 7, (L) => {
      tryPlane(0, 1, L);
      tryPlane(0, -1, L);
    });
    levels(Math.max(1, az0 - 1), Math.min(sz - 1, az1 + 2), 7, (L) => {
      tryPlane(2, 1, L);
      tryPlane(2, -1, L);
    });
    if (bestN === 0) break;
    next = takeBody(S.best, bestN, bh.kind, bh, bestR);
    live = live.filter((i) => vox[i] !== 0).concat(next);
  }
  return { id: job.id, bodies, work };
}
