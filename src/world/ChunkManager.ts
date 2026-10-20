import * as THREE from 'three';
import { CHUNK, CX, CZ, VOXEL, WX, WY, WZ } from '../core/config';
import { createGrassMaterial, createVoxelMaterial } from '../render/voxelMaterial';
import { shared } from '../render/shaderlib';
import { greedyMesh, grassMesh } from './mesher';
import { computeSky, SKY_D, SKY_H, SKY_W } from './skyLight';
import type { WorkerIn, WorkerOut } from './meshWorker';
import { World } from './World';

const PAD = CHUNK + 2;
const PY = WY + 2;
const VOL_SIZE = PAD * PAD * PY;

interface ChunkResult {
  key: number;
  positions: Uint8Array;
  data: Uint8Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  gPos: Float32Array;
  gCol: Uint8Array;
  gCount: number;
}

/**
 * Owns the chunk meshes. Meshing runs on a small worker pool so destruction never stalls a
 * frame; the main thread only copies the padded volume out and uploads the packed result.
 * Also owns the baked sky-visibility volume that every world shader samples.
 */
export class ChunkManager {
  readonly group = new THREE.Group();
  /** with the dithered x-ray cutout (only near the player and cursor, because discard defeats early-z) */
  readonly material = createVoxelMaterial();
  readonly materialSolid = createVoxelMaterial({ cutout: false });
  readonly grassMaterial = createGrassMaterial();
  private meshes: (THREE.Mesh | null)[] = [];
  private grass: (THREE.Mesh | null)[] = [];
  grassEnabled = true;
  totalVerts = 0;

  private workers: Worker[] = [];
  private nextWorker = 0;
  private jobId = 0;
  private inFlight = new Map<number, number>(); // chunk key -> job id
  private waiters = new Map<number, { done?: (r: WorkerOut) => void; fallback: () => void }>();
  private maxInFlight = 6;

  readonly skyData = new Uint8Array(SKY_W * SKY_H * SKY_D);
  readonly skyTex: THREE.Data3DTexture;
  private skyDirty: [number, number, number, number] | null = null; // coarse i0,i1,j0,j1
  private skyBusy = false;
  private skyT = 0;

  constructor(private world: World, private grassDensity: Uint8Array) {
    this.group.name = 'chunks';
    this.meshes = new Array(CX * CZ).fill(null);
    this.grass = new Array(CX * CZ).fill(null);
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

  // --------------------------------------------------------------------------- meshing
  private fill(cx: number, cz: number, vol: Uint8Array) {
    const w = this.world;
    const x0 = cx * CHUNK - 1;
    const z0 = cz * CHUNK - 1;
    for (let lx = 0; lx < PAD; lx++) {
      // outside the map we replicate the edge column so borders get no faces and no AO seams
      const wx = Math.min(WX - 1, Math.max(0, x0 + lx));
      for (let lz = 0; lz < PAD; lz++) {
        const wz = Math.min(WZ - 1, Math.max(0, z0 + lz));
        const dst = (lx * PAD + lz) * PY;
        vol[dst] = 1; // below bedrock
        const src = (wx * WZ + wz) * WY;
        vol.set(w.vox.subarray(src, src + WY), dst + 1);
        vol[dst + PY - 1] = 0;
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
      if (this.inFlight.get(r.key) === r.job) this.inFlight.delete(r.key);
      this.apply(r);
    } else this.applySky(r.data, r.i0, r.i1, r.j0, r.j1);
    wait.done?.(r);
  }

  /** A worker failed to load or crashed: finish everything on the main thread from now on. */
  private dropWorkers() {
    if (!this.workers.length) return;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.inFlight.clear();
    this.skyBusy = false;
    const pending = [...this.waiters.values()];
    this.waiters.clear();
    for (const p of pending) p.fallback();
  }

  /** Queue a chunk for meshing; resolves when its geometry is live. */
  private request(cx: number, cz: number): Promise<void> {
    const key = cx + cz * CX;
    if (!this.workers.length) {
      this.buildSync(cx, cz);
      return Promise.resolve();
    }
    const vol = new Uint8Array(VOL_SIZE);
    this.fill(cx, cz, vol);
    const job = ++this.jobId;
    this.inFlight.set(key, job);
    return new Promise((res) =>
      this.post(
        { type: 'chunk', job, key, vol, sx: PAD, sy: PY, sz: PAD, ox: cx * CHUNK, oz: cz * CHUNK },
        [vol.buffer],
        () => {
          this.buildSync(cx, cz);
          res();
        },
        () => res(),
      ),
    );
  }

  private scratch = new Uint8Array(VOL_SIZE);
  private buildSync(cx: number, cz: number) {
    this.fill(cx, cz, this.scratch);
    const md = greedyMesh(this.scratch, PAD, PY, PAD);
    const dens = this.grassDensity;
    const gd = grassMesh(this.scratch, PAD, PY, PAD, cx * CHUNK, cz * CHUNK, (wx, wz) => (wx < 0 || wz < 0 || wx >= WX || wz >= WZ ? 0 : dens[wx * WZ + wz] / 255));
    this.apply({ key: cx + cz * CX, ...md, gPos: gd.positions, gCol: gd.colors, gCount: gd.vertexCount });
  }

  private apply(r: ChunkResult) {
    const key = r.key;
    const cx = key % CX, cz = (key / CX) | 0;
    let mesh = this.meshes[key];
    if (mesh) {
      this.totalVerts -= mesh.geometry.getAttribute('position')?.count ?? 0;
      mesh.geometry.dispose();
    }
    const geo = new THREE.BufferGeometry();
    // 4 bytes position + 4 bytes data per vertex; the mesh transform scales voxels to metres
    geo.setAttribute('position', new THREE.BufferAttribute(r.positions, 4, false));
    geo.setAttribute('aData', new THREE.BufferAttribute(r.data, 4, false));
    geo.setIndex(new THREE.BufferAttribute(r.indices, 1));
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(CHUNK, WY, CHUNK));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    this.totalVerts += r.vertexCount;
    if (!mesh) {
      mesh = new THREE.Mesh(geo, this.materialSolid);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.position.set(cx * CHUNK * VOXEL, 0, cz * CHUNK * VOXEL);
      mesh.scale.setScalar(VOXEL);
      mesh.updateMatrix();
      mesh.name = `chunk ${cx},${cz}`;
      this.meshes[key] = mesh;
      this.group.add(mesh);
    } else mesh.geometry = geo;
    mesh.visible = r.vertexCount > 0;

    let gm = this.grass[key];
    if (gm) gm.geometry.dispose();
    if (r.gCount > 0) {
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.BufferAttribute(r.gPos, 3));
      gg.setAttribute('aCol', new THREE.BufferAttribute(r.gCol, 4, true));
      gg.boundingBox = new THREE.Box3(new THREE.Vector3(cx * CHUNK * VOXEL, 0, cz * CHUNK * VOXEL), new THREE.Vector3((cx + 1) * CHUNK * VOXEL, WY * VOXEL, (cz + 1) * CHUNK * VOXEL));
      gg.boundingSphere = gg.boundingBox.getBoundingSphere(new THREE.Sphere());
      if (!gm) {
        gm = new THREE.Mesh(gg, this.grassMaterial);
        gm.receiveShadow = true;
        gm.castShadow = false;
        gm.matrixAutoUpdate = false;
        gm.visible = this.grassEnabled;
        this.grass[key] = gm;
        this.group.add(gm);
      } else gm.geometry = gg;
    } else if (gm) {
      this.group.remove(gm);
      this.grass[key] = null;
    }
  }

  async buildAll(progress: (p: number) => Promise<void>) {
    let done = 0;
    const total = CX * CZ;
    const all: Promise<void>[] = [];
    let tick = Promise.resolve();
    for (let cz = 0; cz < CZ; cz++)
      for (let cx = 0; cx < CX; cx++)
        all.push(
          this.request(cx, cz).then(() => {
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
      const i = (((c / WZ) | 0) >> 1), j = ((c % WZ) >> 1);
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

  /** Remesh dirty chunks (off-thread) and refresh the sky volume at a gentle cadence. */
  update(dt = 1 / 60) {
    const dirty = this.world.dirtyChunks;
    if (dirty.size) {
      if (!this.workers.length) {
        const t0 = performance.now();
        for (const key of dirty) {
          dirty.delete(key);
          this.buildSync(key % CX, (key / CX) | 0);
          if (performance.now() - t0 > 4) break;
        }
      } else {
        for (const key of dirty) {
          if (this.inFlight.size >= this.maxInFlight) break;
          if (this.inFlight.has(key)) continue; // newer data goes out once this one lands
          dirty.delete(key);
          void this.request(key % CX, (key / CX) | 0);
        }
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
    const half = (CHUNK * VOXEL) / 2;
    for (let k = 0; k < this.meshes.length; k++) {
      const m = this.meshes[k];
      if (!m) continue;
      const mx = (k % CX) * CHUNK * VOXEL + half, mz = ((k / CX) | 0) * CHUNK * VOXEL + half;
      const near = (ar > 0 && Math.max(Math.abs(mx - ax), Math.abs(mz - az)) < half + ar) || (br > 0 && Math.max(Math.abs(mx - bx), Math.abs(mz - bz)) < half + br);
      m.material = near ? this.material : this.materialSolid;
    }
  }

  /** Make both shader variants exist before the first frame so neither compiles mid-game. */
  primeMaterials() {
    let flip = false;
    for (const m of this.meshes) if (m) m.material = (flip = !flip) ? this.material : this.materialSolid;
  }

  setGrass(on: boolean) {
    this.grassEnabled = on;
    for (const g of this.grass) if (g) g.visible = on;
  }
}
