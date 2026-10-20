import { VOXEL, WATER_Y, WX, WZ } from '../core/config';
import { World } from '../world/World';

/**
 * 2.5D navigation grid. Each cell covers 2x2 voxel columns (0.8 m). Cells store the standable
 * floor height; edges allow stepping one voxel (or two with a jump at extra cost).
 */
export const NAV_CELL = 2;
export const NW = WX / NAV_CELL;
export const ND = WZ / NAV_CELL;
const CELL_M = NAV_CELL * VOXEL;
const BLOCKED = 255;

export interface NavPoint {
  x: number;
  z: number;
  jump?: boolean;
}

class Heap {
  private idx: Int32Array;
  private f: Float32Array;
  size = 0;
  constructor(cap: number) {
    this.idx = new Int32Array(cap);
    this.f = new Float32Array(cap);
  }
  clear() {
    this.size = 0;
  }
  push(i: number, f: number) {
    let k = this.size++;
    if (k >= this.idx.length) {
      const ni = new Int32Array(this.idx.length * 2);
      ni.set(this.idx);
      this.idx = ni;
      const nf = new Float32Array(this.f.length * 2);
      nf.set(this.f);
      this.f = nf;
    }
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.f[p] <= f) break;
      this.idx[k] = this.idx[p];
      this.f[k] = this.f[p];
      k = p;
    }
    this.idx[k] = i;
    this.f[k] = f;
  }
  pop(): number {
    const top = this.idx[0];
    const li = this.idx[--this.size];
    const lf = this.f[this.size];
    let k = 0;
    for (;;) {
      let c = k * 2 + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.f[c + 1] < this.f[c]) c++;
      if (this.f[c] >= lf) break;
      this.idx[k] = this.idx[c];
      this.f[k] = this.f[c];
      k = c;
    }
    this.idx[k] = li;
    this.f[k] = lf;
    return top;
  }
}

export class Nav {
  readonly h = new Uint8Array(NW * ND); // floor in voxels, 255 = blocked
  readonly cost = new Float32Array(NW * ND);
  private g = new Float32Array(NW * ND);
  private from = new Int32Array(NW * ND);
  private stamp = new Uint32Array(NW * ND);
  private closed = new Uint32Array(NW * ND);
  private search = 1;
  private heap = new Heap(4096);
  /** temporary extra cost (danger) written by AI, decays over time */
  readonly danger = new Float32Array(NW * ND);

  constructor(private world: World) {
    for (let x = 0; x < NW; x++) for (let z = 0; z < ND; z++) this.computeCell(x, z);
  }

  computeCell(cx: number, cz: number) {
    const w = this.world;
    let mn = 255, mx = 0;
    for (let a = 0; a < NAV_CELL; a++)
      for (let b = 0; b < NAV_CELL; b++) {
        const f = w.floor[(cx * NAV_CELL + a) * WZ + (cz * NAV_CELL + b)];
        if (f < mn) mn = f;
        if (f > mx) mx = f;
      }
    const k = cx * ND + cz;
    if (mx - mn > 2 || mx >= 60) {
      this.h[k] = BLOCKED;
      return;
    }
    this.h[k] = mx;
    const depth = WATER_Y - mx * VOXEL;
    let c = 1;
    if (depth > 0) c += depth > 0.9 ? 6 : depth > 0.4 ? 2.5 : 0.8;
    if (mx - mn > 0) c += 0.3;
    this.cost[k] = c;
  }

  updateColumns(cols: number[]) {
    const done = new Set<number>();
    for (const c of cols) {
      const x = ((c / WZ) | 0) / NAV_CELL | 0;
      const z = (c % WZ) / NAV_CELL | 0;
      const k = x * ND + z;
      if (done.has(k)) continue;
      done.add(k);
      this.computeCell(x, z);
    }
  }

  cellOf(px: number, pz: number) {
    const x = Math.max(0, Math.min(NW - 1, Math.floor(px / CELL_M)));
    const z = Math.max(0, Math.min(ND - 1, Math.floor(pz / CELL_M)));
    return x * ND + z;
  }

  walkable(k: number) {
    return this.h[k] !== BLOCKED;
  }

  /** nearest walkable cell to a world position (spiral search) */
  nearestWalkable(px: number, pz: number, maxR = 8): number {
    const cx = Math.floor(px / CELL_M), cz = Math.floor(pz / CELL_M);
    for (let r = 0; r <= maxR; r++)
      for (let dx = -r; dx <= r; dx++)
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = cx + dx, z = cz + dz;
          if (x < 0 || z < 0 || x >= NW || z >= ND) continue;
          const k = x * ND + z;
          if (this.h[k] !== BLOCKED) return k;
        }
    return -1;
  }

  private edge(a: number, b: number): number {
    const ha = this.h[a], hb = this.h[b];
    if (hb === BLOCKED) return -1;
    const d = hb - ha;
    if (d > 2) return -1;
    if (d < -6) return -1;
    return d === 2 ? 3 : d < -2 ? 1.5 : 1;
  }

  findPath(sx: number, sz: number, tx: number, tz: number, maxExpand = 14000): NavPoint[] | null {
    let start = this.cellOf(sx, sz);
    if (!this.walkable(start)) start = this.nearestWalkable(sx, sz, 3);
    let goal = this.cellOf(tx, tz);
    if (!this.walkable(goal)) goal = this.nearestWalkable(tx, tz, 6);
    if (start < 0 || goal < 0) return null;
    const sid = ++this.search;
    const gx = (goal / ND) | 0, gz = goal % ND;
    const hfun = (k: number) => {
      const x = (k / ND) | 0, z = k % ND;
      const dx = Math.abs(x - gx), dz = Math.abs(z - gz);
      return (Math.max(dx, dz) + 0.414 * Math.min(dx, dz)) * 1.15;
    };
    this.heap.clear();
    this.g[start] = 0;
    this.stamp[start] = sid;
    this.from[start] = -1;
    this.heap.push(start, hfun(start));
    let best = start, bestH = hfun(start);
    let expanded = 0;
    while (this.heap.size > 0) {
      const cur = this.heap.pop();
      if (this.closed[cur] === sid) continue;
      this.closed[cur] = sid;
      if (cur === goal) {
        best = cur;
        break;
      }
      if (++expanded > maxExpand) break;
      const hh = hfun(cur);
      if (hh < bestH) {
        bestH = hh;
        best = cur;
      }
      const x = (cur / ND) | 0, z = cur % ND;
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue;
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= NW || nz >= ND) continue;
          const n = nx * ND + nz;
          if (this.closed[n] === sid) continue;
          const e = this.edge(cur, n);
          if (e < 0) continue;
          if (dx && dz) {
            // no corner cutting
            if (this.edge(cur, x * ND + nz) < 0 || this.edge(cur, nx * ND + z) < 0) continue;
          }
          const step = (dx && dz ? 1.414 : 1) * e * (this.cost[n] + this.danger[n]);
          const ng = this.g[cur] + step;
          if (this.stamp[n] !== sid || ng < this.g[n]) {
            this.stamp[n] = sid;
            this.g[n] = ng;
            this.from[n] = cur;
            this.heap.push(n, ng + hfun(n));
          }
        }
    }
    // reconstruct
    const cells: number[] = [];
    let c = best;
    let guard = 0;
    while (c >= 0 && guard++ < 20000) {
      cells.push(c);
      if (c === start) break;
      c = this.from[c];
    }
    cells.reverse();
    return this.smooth(cells);
  }

  private lineClear(a: number, b: number) {
    const ax = (a / ND) | 0, az = a % ND, bx = (b / ND) | 0, bz = b % ND;
    const n = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
    let prev = a;
    for (let i = 1; i <= n; i++) {
      const x = Math.round(ax + ((bx - ax) * i) / n);
      const z = Math.round(az + ((bz - az) * i) / n);
      const k = x * ND + z;
      if (k === prev) continue;
      if (this.edge(prev, k) !== 1) return false;
      if (this.cost[k] > 2.5 && this.cost[a] <= 2.5) return false;
      prev = k;
    }
    return true;
  }

  private smooth(cells: number[]): NavPoint[] {
    const pts: NavPoint[] = [];
    if (cells.length === 0) return pts;
    let anchor = 0;
    const toPt = (k: number, jump = false): NavPoint => ({ x: (((k / ND) | 0) + 0.5) * CELL_M, z: ((k % ND) + 0.5) * CELL_M, jump });
    for (let i = 1; i < cells.length; i++) {
      const jumpEdge = this.h[cells[i]] - this.h[cells[i - 1]] >= 2;
      if (jumpEdge) {
        pts.push(toPt(cells[i - 1]));
        pts.push(toPt(cells[i], true));
        anchor = i;
        continue;
      }
      if (!this.lineClear(cells[anchor], cells[i])) {
        pts.push(toPt(cells[i - 1]));
        anchor = i - 1;
      }
    }
    pts.push(toPt(cells[cells.length - 1]));
    return pts;
  }

  floorM(k: number) {
    return this.h[k] * VOXEL;
  }

  decay(dt: number) {
    const d = this.danger;
    const f = Math.exp(-dt * 0.08);
    for (let i = 0; i < d.length; i += 1) if (d[i] > 0.01) d[i] *= f;
      else d[i] = 0;
  }

  addDanger(px: number, pz: number, amount: number, radius = 4) {
    const cx = Math.floor(px / CELL_M), cz = Math.floor(pz / CELL_M);
    const r = Math.ceil(radius / CELL_M);
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) {
        const x = cx + dx, z = cz + dz;
        if (x < 0 || z < 0 || x >= NW || z >= ND) continue;
        const f = 1 - Math.hypot(dx, dz) / (r + 1);
        if (f > 0) this.danger[x * ND + z] = Math.min(6, this.danger[x * ND + z] + amount * f);
      }
  }
}
