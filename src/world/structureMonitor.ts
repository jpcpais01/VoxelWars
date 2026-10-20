import { WX, WY, WZ } from '../core/config';
import { solveStructure, type StructBody, type StructJob, type StructResult } from './structure';
import { World } from './World';

/** voxels of context kept around damage on each side: the structure being judged must fit inside */
const MARGIN = 36;
/** damage this close together is judged in one box */
const JOIN = 10;
const MAX_EXTENT = 64;

interface Cluster {
  x0: number; x1: number; z0: number; z1: number;
  removed: number[];
  rubble: number[];
  quiet: number;
  age: number;
}

export interface StructBox {
  x0: number;
  z0: number;
  sx: number;
  sz: number;
}

/**
 * Gathers damage into clusters and has a worker judge each one: after a short pause (so a
 * burst of fire or a blast is judged once), the box of voxels around it is copied over and the
 * worker answers with the pieces whose support gave way.
 */
export class StructureMonitor {
  private clusters: Cluster[] = [];
  private worker: Worker | null = null;
  private inFlight: StructBox | null = null;
  private jobId = 0;
  private pending: { res: StructResult; box: StructBox }[] = [];
  /** debug: jobs run and the last one's cost */
  jobs = 0;
  lastWork = 0;
  lastMs = 0;
  private sentAt = 0;

  constructor(private world: World) {
    try {
      this.worker = new Worker(new URL('./structureWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<StructResult>) => this.onResult(e.data);
      this.worker.onerror = () => {
        this.worker = null;
        this.inFlight = null;
      };
    } catch {
      this.worker = null; // judged on the main thread instead
    }
  }

  /** world indices of settled rubble */
  private rubbleSet = new Set<number>();

  /** a voxel was destroyed */
  damaged(x: number, y: number, z: number) {
    this.rubbleSet.delete((x * WZ + z) * WY + y);
    this.add(x, y, z, false);
  }

  /** a voxel of settled rubble was placed: only checked for hanging loose */
  landed(x: number, y: number, z: number) {
    this.rubbleSet.add((x * WZ + z) * WY + y);
    this.add(x, y, z, true);
  }

  /** a voxel was lifted out of the world (it's falling now) */
  lifted(i: number) {
    this.rubbleSet.delete(i);
  }

  get busy() {
    return this.inFlight !== null || this.clusters.length > 0;
  }

  private add(x: number, y: number, z: number, rubble: boolean) {
    for (const c of this.clusters) {
      if (x < c.x0 - JOIN || x > c.x1 + JOIN || z < c.z0 - JOIN || z > c.z1 + JOIN) continue;
      const nx0 = Math.min(c.x0, x), nx1 = Math.max(c.x1, x), nz0 = Math.min(c.z0, z), nz1 = Math.max(c.z1, z);
      if (nx1 - nx0 > MAX_EXTENT || nz1 - nz0 > MAX_EXTENT) continue;
      c.x0 = nx0; c.x1 = nx1; c.z0 = nz0; c.z1 = nz1;
      (rubble ? c.rubble : c.removed).push(x, y, z);
      c.quiet = 0;
      return;
    }
    const c: Cluster = { x0: x, x1: x, z0: z, z1: z, removed: [], rubble: [], quiet: 0, age: 0 };
    (rubble ? c.rubble : c.removed).push(x, y, z);
    this.clusters.push(c);
  }

  /** advances timers, sends the next job; returns finished results to apply */
  update(dt: number): { res: StructResult; box: StructBox }[] {
    // results go out before anything new is sent, so the next box already lacks those pieces
    if (this.pending.length) {
      const out = this.pending;
      this.pending = [];
      return out;
    }
    for (const c of this.clusters) {
      c.quiet += dt;
      c.age += dt;
    }
    // a stuck worker shouldn't freeze collapses forever
    if (this.inFlight && performance.now() - this.sentAt > 3000) {
      this.worker?.terminate();
      this.worker = null;
      this.inFlight = null;
    }
    if (!this.inFlight && this.clusters.length) {
      // judge once the burst settles (or it has been going on for a while)
      let pick = -1;
      for (let i = 0; i < this.clusters.length; i++) {
        const c = this.clusters[i];
        if (c.quiet < 0.06 && c.age < 0.35) continue;
        if (pick < 0 || c.age > this.clusters[pick].age) pick = i;
      }
      if (pick >= 0) {
        const c = this.clusters.splice(pick, 1)[0];
        this.send(c);
      }
    }
    return [];
  }

  private send(c: Cluster) {
    const w = this.world;
    const x0 = Math.max(0, c.x0 - MARGIN), x1 = Math.min(WX - 1, c.x1 + MARGIN);
    const z0 = Math.max(0, c.z0 - MARGIN), z1 = Math.min(WZ - 1, c.z1 + MARGIN);
    const sx = x1 - x0 + 1, sz = z1 - z0 + 1;
    const vox = new Uint8Array(sx * sz * WY);
    const ground = new Uint8Array(sx * sz);
    for (let lx = 0; lx < sx; lx++)
      for (let lz = 0; lz < sz; lz++) {
        const col = (x0 + lx) * WZ + z0 + lz;
        vox.set(w.vox.subarray(col * WY, col * WY + WY), (lx * sz + lz) * WY);
        ground[lx * sz + lz] = w.ground[col];
      }
    const loc = (a: number[]) => {
      const o = new Int16Array(a.length);
      for (let k = 0; k < a.length; k += 3) {
        o[k] = a[k] - x0;
        o[k + 1] = a[k + 1];
        o[k + 2] = a[k + 2] - z0;
      }
      return o;
    };
    const rubbleMask = new Uint8Array(sx * sz * WY);
    for (const i of this.rubbleSet) {
      const y = i % WY, col = (i / WY) | 0, x = (col / WZ) | 0, z = col - x * WZ;
      if (x < x0 || x > x1 || z < z0 || z > z1) continue;
      if (w.vox[i] === 0) {
        this.rubbleSet.delete(i);
        continue;
      }
      rubbleMask[((x - x0) * sz + z - z0) * WY + y] = 1;
    }
    const job: StructJob = { id: ++this.jobId, x0, z0, sx, sz, vox, ground, removed: loc(c.removed), rubble: loc(c.rubble), rubbleMask };
    this.inFlight = { x0, z0, sx, sz };
    this.sentAt = performance.now();
    this.jobs++;
    if (this.worker) {
      this.worker.postMessage(job, [vox.buffer, ground.buffer, job.removed.buffer, job.rubble.buffer, rubbleMask.buffer]);
    } else {
      this.onResult(solveStructure(job));
    }
  }

  private onResult(res: StructResult) {
    const box = this.inFlight;
    this.inFlight = null;
    if (!box) return;
    this.lastWork = res.work;
    this.lastMs = performance.now() - this.sentAt;
    if (res.bodies.length) this.pending.push({ res, box });
  }

  /** world voxel index of a body's local index */
  static toWorld(box: StructBox, i: number) {
    const y = i % WY;
    const col = (i / WY) | 0;
    const lx = (col / box.sz) | 0, lz = col - lx * box.sz;
    return ((box.x0 + lx) * WZ + box.z0 + lz) * WY + y;
  }
}

export type { StructBody };
