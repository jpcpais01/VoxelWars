import * as THREE from 'three';
import { CHUNK, CX, CZ, VOXEL, WX, WY, WZ } from '../core/config';
import { createGrassMaterial, createVoxelMaterial } from '../render/voxelMaterial';
import { shared } from '../render/shaderlib';
import { buildChunk, CHUNK_PAD, LOD_LEVELS } from './mesher';
import { computeSky, SKY_CELL, SKY_D, SKY_H, SKY_W } from './skyLight';
import type { MeshOut, WorkerIn, WorkerOut } from './meshWorker';
import { World } from './World';

const PAD = CHUNK_PAD;
const FX = CHUNK + PAD * 2;
const VOL_SIZE = FX * FX * WY;
const CHUNK_M = CHUNK * VOXEL;
/** camera distance (metres, to the chunk footprint) where each LOD takes over */
const LOD_START = [0, 22, 64];
/** grass is only ever drawn this close (the shader fades it out before) */
const GRASS_R = 54;

interface Chunk {
  key: number;
  cx: number;
  cz: number;
  /** bumps whenever the chunk's voxels change */
  ver: number;
  slots: (THREE.Mesh | null)[];
  slotVer: number[];
  shown: number;
  dist: number;
  want: number;
  grass: THREE.Mesh | null;
  grassVer: number;
  busy: number;
  near: boolean;
}

interface ChunkResult {
  key: number;
  ver: number;
  meshes: MeshOut[];
  gPos: Float32Array | null;
  gCol: Uint8Array | null;
  gCount: number;
}

/**
 * Owns the chunk meshes. Every chunk keeps up to three meshes: full 0.2 m detail near the camera,
 * 0.4 m blocks in the middle distance and 0.8 m blocks far away, rebuilt on a worker pool from one
 * copy of the voxels whenever the camera or destruction needs them. Coarse meshes keep short
 * skirts on their borders so no crack opens between neighbours at different detail.
 * Also owns the baked sky-visibility volume that every world shader samples.
 */
export class ChunkManager {
  readonly group = new THREE.Group();
  /** with the dithered x-ray cutout (only near the player and cursor, because discard defeats early-z) */
  readonly material = createVoxelMaterial();
  readonly materialSolid = createVoxelMaterial({ cutout: false });
  readonly grassMaterial = createGrassMaterial();
  private chunks: Chunk[] = [];
  grassEnabled = true;
  totalVerts = 0;
  /** detail distance multiplier (quality setting) */
  lodScale = 1;
  private view: THREE.Vector3 | null = null;

  private workers: Worker[] = [];
  private nextWorker = 0;
  private jobId = 0;
  private inFlight = 0;
  private waiters = new Map<number, { done?: (r: WorkerOut) => void; fallback: () => void }>();
  private maxInFlight = 6;

  readonly skyData = new Uint8Array(SKY_W * SKY_H * SKY_D);
  readonly skyTex: THREE.Data3DTexture;
  private skyDirty: [number, number, number, number] | null = null; // coarse i0,i1,j0,j1
  private skyBusy = false;
  private skyT = 0;

  constructor(private world: World, private grassDensity: Uint8Array) {
    this.group.name = 'chunks';
    for (let cz = 0; cz < CZ; cz++)
      for (let cx = 0; cx < CX; cx++)
        this.chunks.push({
          key: cx + cz * CX,
          cx,
          cz,
          ver: 0,
          slots: new Array(LOD_LEVELS).fill(null),
          slotVer: new Array(LOD_LEVELS).fill(-1),
          shown: -1,
          dist: 0,
          want: 1,
          grass: null,
          grassVer: -1,
          busy: 0,
          near: false,
        });
    this.skyData.fill(255);
    this.skyTex = new THREE.Data3DTexture(this.skyData, SKY_W, SKY_D, SKY_H);
    this.skyTex.format = THREE.RedFormat;
    this.skyTex.type = THREE.UnsignedByteType;
    this.skyTex.magFilter = THREE.LinearFilter;
    this.skyTex.minFilter = THREE.LinearFilter;
    this.skyTex.wrapS = this.skyTex.wrapT = this.skyTex.wrapR = THREE.ClampToEdgeWrapping;
    this.skyTex.unpackAlignment = 1;
    this.skyTex.needsUpdate = true;
    shared.tSky.value = this.skyTex;

    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<WorkerOut>) => this.onResult(e.data);
        w.onerror = () => this.dropWorkers();
        w.postMessage({ type: 'init', grass: grassDensity } satisfies WorkerIn);
        this.workers.push(w);
      }
    } catch {
      this.workers = []; // fall back to meshing on the main thread
    }
  }

  /** the camera whose distance decides each chunk's detail */
  setView(v: THREE.Vector3) {
    this.view = v;
  }

  // --------------------------------------------------------------------------- meshing
  private fill(cx: number, cz: number, vol: Uint8Array) {
    const w = this.world;
    const x0 = cx * CHUNK - PAD;
    const z0 = cz * CHUNK - PAD;
    for (let lx = 0; lx < FX; lx++) {
      // outside the map we replicate the edge column so borders get no faces and no AO seams
      const wx = Math.min(WX - 1, Math.max(0, x0 + lx));
      for (let lz = 0; lz < FX; lz++) {
        const wz = Math.min(WZ - 1, Math.max(0, z0 + lz));
        const src = (wx * WZ + wz) * WY;
        vol.set(w.vox.subarray(src, src + WY), (lx * FX + lz) * WY);
      }
    }
  }

  private post(msg: WorkerIn & { job: number }, transfer: Transferable[], fallback: () => void, done?: (r: WorkerOut) => void) {
    this.waiters.set(msg.job, { done, fallback });
    const w = this.workers[this.nextWorker++ % this.workers.length];
    w.postMessage(msg, transfer);
  }

  private onResult(r: WorkerOut) {
    const wait = this.waiters.get(r.job);
    if (!wait) return; // already handled by the fallback
    this.waiters.delete(r.job);
    if (r.type === 'chunk') {
      const c = this.chunks[r.key];
      if (c.busy === r.job) {
        c.busy = 0;
        this.inFlight--;
      }
      this.apply(r);
    } else this.applySky(r.data, r.i0, r.i1, r.j0, r.j1);
    wait.done?.(r);
  }

  /** A worker failed to load or crashed: finish everything on the main thread from now on. */
  private dropWorkers() {
    if (!this.workers.length) return;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    for (const c of this.chunks) c.busy = 0;
    this.inFlight = 0;
    this.skyBusy = false;
    const pending = [...this.waiters.values()];
    this.waiters.clear();
    for (const p of pending) p.fallback();
  }

  private density = (wx: number, wz: number) => (wx < 0 || wz < 0 || wx >= WX || wz >= WZ ? 0 : this.grassDensity[wx * WZ + wz] / 255);

  /** Queue a build of the given LODs (bitmask); resolves when the geometry is live. */
  private request(c: Chunk, lods: number, grass: boolean): Promise<void> {
    if (!this.workers.length) {
      this.buildSync(c, lods, grass);
      return Promise.resolve();
    }
    const vol = new Uint8Array(VOL_SIZE);
    this.fill(c.cx, c.cz, vol);
    const job = ++this.jobId;
    c.busy = job;
    this.inFlight++;
    const ver = c.ver;
    return new Promise((res) =>
      this.post(
        { type: 'chunk', job, key: c.key, ver, vol, sx: FX, sy: WY, sz: FX, pad: PAD, lods, grass, ox: c.cx * CHUNK, oz: c.cz * CHUNK },
        [vol.buffer],
        () => {
          this.buildSync(c, lods, grass);
          res();
        },
        () => res(),
      ),
    );
  }

  private scratch = new Uint8Array(VOL_SIZE);
  private buildSync(c: Chunk, lods: number, grass: boolean) {
    this.fill(c.cx, c.cz, this.scratch);
    const b = buildChunk(this.scratch, FX, WY, FX, PAD, lods, grass, c.cx * CHUNK, c.cz * CHUNK, this.density);
    this.apply({
      key: c.key,
      ver: c.ver,
      meshes: b.meshes.map((m) => ({ lod: m.lod, ...m.mesh })),
      gPos: b.grass?.positions ?? null,
      gCol: b.grass?.colors ?? null,
      gCount: b.grass?.vertexCount ?? 0,
    });
  }

  private apply(r: ChunkResult) {
    const c = this.chunks[r.key];
    const ox = c.cx * CHUNK_M, oz = c.cz * CHUNK_M;
    for (const m of r.meshes) {
      const lod = m.lod;
      if (r.ver < c.slotVer[lod]) continue; // an even newer build already landed
      let mesh = c.slots[lod];
      if (mesh) mesh.geometry.dispose();
      const geo = new THREE.BufferGeometry();
      // 4 bytes position + 4 bytes data per vertex; the mesh transform scales cells to metres
      geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 4, false));
      geo.setAttribute('aData', new THREE.BufferAttribute(m.data, 4, false));
      geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
      geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(CHUNK >> lod, WY >> lod, CHUNK >> lod));
      geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
      if (!mesh) {
        mesh = new THREE.Mesh(geo, c.near ? this.material : this.materialSolid);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.position.set(ox, 0, oz);
        mesh.scale.setScalar(VOXEL * (1 << lod));
        mesh.updateMatrix();
        mesh.name = `chunk ${c.cx},${c.cz} lod${lod}`;
        mesh.visible = false;
        c.slots[lod] = mesh;
        this.group.add(mesh);
      } else mesh.geometry = geo;
      c.slotVer[lod] = r.ver;
    }
    this.pickShown(c);

    if (r.gPos && r.ver >= c.grassVer) {
      let gm = c.grass;
      if (gm) gm.geometry.dispose();
      c.grassVer = r.ver;
      if (r.gCount > 0) {
        const gg = new THREE.BufferGeometry();
        gg.setAttribute('position', new THREE.BufferAttribute(r.gPos, 3));
        gg.setAttribute('aCol', new THREE.BufferAttribute(r.gCol!, 4, true));
        gg.boundingBox = new THREE.Box3(new THREE.Vector3(ox, 0, oz), new THREE.Vector3(ox + CHUNK_M, WY * VOXEL, oz + CHUNK_M));
        gg.boundingSphere = gg.boundingBox.getBoundingSphere(new THREE.Sphere());
        if (!gm) {
          gm = new THREE.Mesh(gg, this.grassMaterial);
          gm.receiveShadow = true;
          gm.castShadow = false;
          gm.matrixAutoUpdate = false;
          gm.visible = this.grassEnabled;
          c.grass = gm;
          this.group.add(gm);
        } else gm.geometry = gg;
      } else if (gm) {
        this.group.remove(gm);
        c.grass = null;
      }
    }
  }

  /** Show the wanted LOD if it exists, otherwise the closest level that does. */
  private pickShown(c: Chunk) {
    let show = -1;
    if (c.slots[c.want]) show = c.want;
    else
      for (let d = 1; d < LOD_LEVELS && show < 0; d++) {
        if (c.slots[c.want + d]) show = c.want + d;
        else if (c.slots[c.want - d]) show = c.want - d;
      }
    if (show === c.shown) return;
    if (c.shown >= 0 && c.slots[c.shown]) c.slots[c.shown]!.visible = false;
    if (show >= 0) c.slots[show]!.visible = true;
    c.shown = show;
  }

  async buildAll(progress: (p: number) => Promise<void>) {
    let done = 0;
    const total = this.chunks.length;
    const all: Promise<void>[] = [];
    let tick = Promise.resolve();
    for (const c of this.chunks)
      all.push(
        this.request(c, 0b110, true).then(() => {
          done++;
          if (done % 12 === 0) tick = progress(done / total);
        }),
      );
    // on the main-thread fallback each request already finished synchronously
    await Promise.all(all);
    await tick;
    this.world.dirtyChunks.clear();
  }

  /** Bake the whole sky-visibility volume (in parallel strips across the worker pool). */
  async buildSky() {
    if (!this.workers.length) {
      computeSky(this.world.top, this.skyData);
      this.skyTex.needsUpdate = true;
      return;
    }
    const strips = this.workers.length;
    const jobs: Promise<WorkerOut>[] = [];
    for (let s = 0; s < strips; s++) {
      const i0 = Math.floor((s * SKY_W) / strips), i1 = Math.floor(((s + 1) * SKY_W) / strips);
      const top = this.world.top.slice();
      const job = ++this.jobId;
      jobs.push(
        new Promise((res) =>
          this.post({ type: 'sky', job, top, i0, i1, j0: 0, j1: SKY_D }, [top.buffer], () => {
            computeSky(this.world.top, this.skyData, i0, i1, 0, SKY_D);
            this.skyTex.needsUpdate = true;
            res(null as unknown as WorkerOut);
          }, res),
        ),
      );
    }
    await Promise.all(jobs);
  }

  private applySky(data: Uint8Array, i0: number, i1: number, j0: number, j1: number) {
    const w = i1 - i0, d = j1 - j0;
    for (let y = 0; y < SKY_H; y++)
      for (let j = 0; j < d; j++) {
        const dst = i0 + (j0 + j) * SKY_W + y * SKY_W * SKY_D;
        this.skyData.set(data.subarray((y * d + j) * w, (y * d + j + 1) * w), dst);
      }
    this.skyTex.needsUpdate = true;
  }

  /** World columns changed (voxel units): re-bake the sky around them soon. */
  markSky(cols: number[]) {
    const R = 11; // coarse radius the horizon search reaches
    for (const c of cols) {
      const i = (((c / WZ) | 0) / SKY_CELL) | 0, j = ((c % WZ) / SKY_CELL) | 0;
      const b = this.skyDirty;
      if (!b) this.skyDirty = [i - R, i + R + 1, j - R, j + R + 1];
      else {
        b[0] = Math.min(b[0], i - R);
        b[1] = Math.max(b[1], i + R + 1);
        b[2] = Math.min(b[2], j - R);
        b[3] = Math.max(b[3], j + R + 1);
      }
    }
  }

  private cands: { c: Chunk; lods: number; grass: boolean; p: number }[] = [];

  /**
   * Pick each chunk's detail from the camera distance, remesh what is missing or stale (nearest
   * first, off-thread) and refresh the sky volume at a gentle cadence.
   */
  update(dt = 1 / 60) {
    const dirty = this.world.dirtyChunks;
    if (dirty.size) {
      for (const key of dirty) this.chunks[key].ver++;
      dirty.clear();
    }
    const v = this.view;
    const k = this.lodScale;
    let verts = 0;
    const cands = this.cands;
    cands.length = 0;
    for (const c of this.chunks) {
      let want = 1;
      if (v) {
        const x0 = c.cx * CHUNK_M, z0 = c.cz * CHUNK_M;
        const dx = Math.max(0, x0 - v.x, v.x - x0 - CHUNK_M);
        const dz = Math.max(0, z0 - v.z, v.z - z0 - CHUNK_M);
        const d = Math.hypot(dx, dz, Math.max(0, v.y - 20));
        c.dist = d;
        // a couple of metres of hysteresis so a chunk on the boundary doesn't flip every step
        want = 0;
        for (let l = 1; l < LOD_LEVELS; l++) if (d > LOD_START[l] * k + (c.shown >= 0 ? (c.shown >= l ? -2.5 : 2.5) : 0)) want = l;
      } else c.dist = 1e9;
      c.want = want;
      this.pickShown(c);
      if (c.shown >= 0) verts += c.slots[c.shown]!.geometry.getAttribute('position').count;
      // drop full-detail meshes well behind the camera's detail ring
      if (v && c.slots[0] && c.dist > LOD_START[1] * k + 30) {
        const m = c.slots[0]!;
        this.group.remove(m);
        m.geometry.dispose();
        c.slots[0] = null;
        c.slotVer[0] = -1;
        this.pickShown(c);
      }
      if (c.busy) continue;
      let lods = 0;
      let p = c.dist;
      if (c.slotVer[want] !== c.ver) lods |= 1 << want;
      // build full detail a little before the camera gets there
      if (v && want > 0 && c.dist < LOD_START[1] * k + 10 && c.slotVer[0] !== c.ver) {
        lods |= 1;
        if (!(lods & (1 << want))) p += 40;
      }
      const grass = c.dist < GRASS_R && c.grassVer !== c.ver;
      if (!lods && !grass) continue;
      if (!lods) lods = 1 << want;
      // the shown mesh is stale (destruction) or missing: those go first
      if (c.shown < 0 || c.slotVer[c.shown] !== c.ver) p -= 1000;
      cands.push({ c, lods, grass, p });
    }
    this.totalVerts = verts;

    if (cands.length) {
      cands.sort((a, b) => a.p - b.p);
      if (!this.workers.length) {
        const t0 = performance.now();
        for (const q of cands) {
          this.buildSync(q.c, q.lods, q.grass);
          if (performance.now() - t0 > 4) break;
        }
      } else
        for (const q of cands) {
          if (this.inFlight >= this.maxInFlight) break;
          void this.request(q.c, q.lods, q.grass);
        }
    }

    this.skyT -= dt;
    if (this.skyDirty && !this.skyBusy && this.skyT <= 0) {
      const [a, b, c, d] = this.skyDirty;
      this.skyDirty = null;
      this.skyT = 0.35;
      const i0 = Math.max(0, a), i1 = Math.min(SKY_W, b), j0 = Math.max(0, c), j1 = Math.min(SKY_D, d);
      if (!this.workers.length) {
        computeSky(this.world.top, this.skyData, i0, i1, j0, j1);
        this.skyTex.needsUpdate = true;
      } else {
        this.skyBusy = true;
        const top = this.world.top.slice();
        const job = ++this.jobId;
        this.post(
          { type: 'sky', job, top, i0, i1, j0, j1 },
          [top.buffer],
          () => {
            computeSky(this.world.top, this.skyData, i0, i1, j0, j1);
            this.skyTex.needsUpdate = true;
          },
          () => (this.skyBusy = false),
        );
      }
    }
  }

  /**
   * Only chunks near the player or the cursor need the cutout shader; everything else keeps a
   * discard-free shader so the GPU can reject hidden fragments before shading them.
   */
  updateCutout(ax: number, az: number, ar: number, bx: number, bz: number, br: number) {
    const half = CHUNK_M / 2;
    for (const c of this.chunks) {
      const mx = c.cx * CHUNK_M + half, mz = c.cz * CHUNK_M + half;
      const near = (ar > 0 && Math.max(Math.abs(mx - ax), Math.abs(mz - az)) < half + ar) || (br > 0 && Math.max(Math.abs(mx - bx), Math.abs(mz - bz)) < half + br);
      if (near === c.near) continue;
      c.near = near;
      for (const m of c.slots) if (m) m.material = near ? this.material : this.materialSolid;
    }
  }

  /** Make both shader variants exist before the first frame so neither compiles mid-game. */
  primeMaterials() {
    let flip = false;
    for (const c of this.chunks) {
      c.near = flip = !flip;
      for (const m of c.slots) if (m) m.material = c.near ? this.material : this.materialSolid;
    }
  }

  /** grass only exists close to the camera (blades also fade out in the shader before this) */
  cullGrass(x: number, z: number, r = 46) {
    const half = CHUNK_M / 2;
    const lim = (r + half * 1.42) ** 2;
    for (const c of this.chunks) {
      const g = c.grass;
      if (!g) continue;
      const mx = c.cx * CHUNK_M + half, mz = c.cz * CHUNK_M + half;
      g.visible = this.grassEnabled && (mx - x) ** 2 + (mz - z) ** 2 < lim;
    }
  }

  /** baked open-sky visibility (0..1) at a world point */
  skyAt(x: number, y: number, z: number) {
    const s = SKY_CELL * VOXEL;
    const i = Math.min(SKY_W - 1, Math.max(0, Math.floor(x / s)));
    const j = Math.min(SKY_D - 1, Math.max(0, Math.floor(z / s)));
    const k = Math.min(SKY_H - 1, Math.max(0, Math.floor(y / s)));
    return this.skyData[i + j * SKY_W + k * SKY_W * SKY_D] / 255;
  }

  setGrass(on: boolean) {
    this.grassEnabled = on;
    for (const c of this.chunks) if (c.grass) c.grass.visible = on;
  }
}
