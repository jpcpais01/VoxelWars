import * as THREE from 'three';
import { GRAVITY, VOXEL, WX, WY, WZ } from '../core/config';
import { hash3 } from '../core/noise';
import { Debris, Particles } from '../render/effects';
import { shared } from '../render/shaderlib';
import { createVoxelMaterial } from '../render/voxelMaterial';
import { M, MATS } from './materials';
import { greedyMesh } from './mesher';
import { World } from './World';

export interface DestructionEvents {
  onBarrel(x: number, y: number, z: number, size: number): void;
  onBodyImpact(x: number, y: number, z: number, size: number, minX: number, minZ: number, maxX: number, maxZ: number, isTree: boolean): void;
  onTopple(x: number, y: number, z: number, isTree: boolean): void;
}

/** voxels per 0.4 m cube: event sizes and limits were tuned in 0.4 m voxels */
const VK3 = (VOXEL / 0.4) ** 3;
/** reference size for debris chunks (metres), so they don't shrink with the voxel grid */
const DEB = 0.32;
/** finer voxels are weaker: a bullet now chips 0.2 m cubes, plus a little around them */
const HP_K = 0.45;

const LEAF = new Uint8Array(256);
MATS.forEach((d, i) => { if (d.kind === 'leaf') LEAF[i] = 1; });

const linearColor = (m: number, out = new THREE.Color()) => {
  const p = shared.uPalette.value[m];
  if (!p) return out.setRGB(0.5, 0.5, 0.5);
  const j = 1 + (Math.random() - 0.5) * 2 * p.w;
  return out.setRGB(p.x * j, p.y * j, p.z * j);
};

class FallingBody {
  /** rotates about the pivot; the voxel mesh inside it is offset to the body's local origin */
  mesh = new THREE.Group();
  voxMesh: THREE.Mesh;
  local: Float32Array; // voxel centre positions relative to pivot (metres)
  mats: Uint8Array;
  samples: number[] = [];
  pivot = new THREE.Vector3();
  quat = new THREE.Quaternion();
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  spin = new THREE.Vector3();
  topple: boolean;
  hinge = new THREE.Vector3();
  axis = new THREE.Vector3();
  theta = 0;
  omega = 0.35;
  height: number;
  age = 0;
  isTree: boolean;
  done = false;
  private tmpQ = new THREE.Quaternion();

  constructor(voxels: number[], world: World, scene: THREE.Scene, dir: THREE.Vector3) {
    let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1, maxY = -1, maxZ = -1;
    let cx = 0, cy = 0, cz = 0;
    const coords: number[] = [];
    let leaves = 0, wood = 0;
    this.mats = new Uint8Array(voxels.length);
    voxels.forEach((idx, i) => {
      const y = idx % WY;
      const t = (idx / WY) | 0;
      const z = t % WZ;
      const x = (t / WZ) | 0;
      coords.push(x, y, z);
      const m = world.vox[idx];
      this.mats[i] = m;
      if (MATS[m].kind === 'leaf') leaves++;
      if (MATS[m].kind === 'wood') wood++;
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
      cx += x; cy += y; cz += z;
    });
    const n = voxels.length;
    this.isTree = leaves + wood > n * 0.8 && wood > 3;
    this.pivot.set(((cx / n) + 0.5) * VOXEL, ((cy / n) + 0.5) * VOXEL, ((cz / n) + 0.5) * VOXEL);
    const sx = maxX - minX + 1, sy = maxY - minY + 1, sz = maxZ - minZ + 1;
    this.height = sy * VOXEL;
    const PX = sx + 2, PY = sy + 2, PZ = sz + 2;
    const vol = new Uint8Array(PX * PY * PZ);
    this.local = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = coords[i * 3], y = coords[i * 3 + 1], z = coords[i * 3 + 2];
      vol[((x - minX + 1) * PZ + (z - minZ + 1)) * PY + (y - minY + 1)] = this.mats[i];
      this.local[i * 3] = (x + 0.5) * VOXEL - this.pivot.x;
      this.local[i * 3 + 1] = (y + 0.5) * VOXEL - this.pivot.y;
      this.local[i * 3 + 2] = (z + 0.5) * VOXEL - this.pivot.z;
    }
    // remove from the world
    for (let i = 0; i < n; i++) world.set(coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2], 0);
    const md = greedyMesh(vol, PX, PY, PZ);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(md.positions, 4, false));
    geo.setAttribute('aData', new THREE.BufferAttribute(md.data, 4, false));
    geo.setIndex(new THREE.BufferAttribute(md.indices, 1));
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(sx, sy, sz));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    const origin = new THREE.Vector3(minX * VOXEL, minY * VOXEL, minZ * VOXEL);
    this.voxMesh = new THREE.Mesh(geo, createVoxelMaterial({ offset: origin.clone() }));
    this.voxMesh.castShadow = true;
    this.voxMesh.receiveShadow = true;
    this.voxMesh.scale.setScalar(VOXEL);
    this.voxMesh.position.copy(origin).sub(this.pivot);
    this.mesh.add(this.voxMesh);
    this.mesh.position.copy(this.pivot);
    scene.add(this.mesh);
    this.pos.copy(this.pivot);

    // sample points: extremes + random spread
    const pickExtreme = (k: number, sign: number) => {
      let best = 0, bv = -1e9;
      for (let i = 0; i < n; i++) {
        const v = this.local[i * 3 + k] * sign;
        if (v > bv) { bv = v; best = i; }
      }
      return best;
    };
    for (let k = 0; k < 3; k++) for (const s of [-1, 1]) this.samples.push(pickExtreme(k, s));
    const step = Math.max(1, Math.floor(n / 40));
    for (let i = 0; i < n; i += step) this.samples.push(i);

    const tall = sy > Math.max(sx, sz) * 1.5 && sy * VOXEL >= 2.4;
    this.topple = tall;
    if (tall) {
      const d = dir.clone().setY(0);
      if (d.lengthSq() < 1e-4) d.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      d.normalize();
      this.axis.set(0, 1, 0).cross(d).normalize();
      const half = VOXEL * 0.75;
      this.hinge.set(this.pivot.x + d.x * half, minY * VOXEL - VOXEL, this.pivot.z + d.z * half);
      this.omega = 0.3 + Math.random() * 0.25;
    } else {
      this.vel.set(dir.x * 1.5, 0, dir.z * 1.5);
      this.spin.set((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.8);
    }
  }

  worldOf(i: number, out: THREE.Vector3) {
    out.set(this.local[i * 3], this.local[i * 3 + 1], this.local[i * 3 + 2]).applyQuaternion(this.quat).add(this.pos);
    return out;
  }

  update(dt: number, world: World): boolean {
    this.age += dt;
    const v = new THREE.Vector3();
    if (this.topple) {
      const L = Math.max(1, this.height);
      this.omega += (3 * GRAVITY) / (2 * L) * Math.sin(this.theta + 0.06) * dt * 0.55;
      this.theta += this.omega * dt;
      this.quat.setFromAxisAngle(this.axis, this.theta);
      // position: rotate pivot about hinge
      this.pos.copy(this.pivot).sub(this.hinge).applyQuaternion(this.quat).add(this.hinge);
      // small initial drop into the cut gap
      this.pos.y -= Math.min(this.age * 1.5, VOXEL);
      let hit = this.theta > 1.5;
      if (!hit) {
        for (const i of this.samples) {
          this.worldOf(i, v);
          if (v.distanceTo(this.hinge) < 1.6) continue;
          if (world.solidAt(v.x, v.y, v.z) || v.y < 0.5) {
            hit = true;
            break;
          }
        }
      }
      this.mesh.position.copy(this.pos);
      this.mesh.quaternion.copy(this.quat);
      return hit || this.age > 6;
    }
    this.vel.y -= GRAVITY * dt;
    const prev = this.pos.clone();
    this.pos.addScaledVector(this.vel, dt);
    this.tmpQ.setFromEuler(new THREE.Euler(this.spin.x * dt, this.spin.y * dt, this.spin.z * dt));
    this.quat.premultiply(this.tmpQ);
    let hit = false;
    for (const i of this.samples) {
      this.worldOf(i, v);
      if (world.solidAt(v.x, v.y - VOXEL * 0.4, v.z) || v.y < 0.4) {
        hit = true;
        break;
      }
    }
    if (hit) this.pos.copy(prev);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);
    return hit || this.age > 5;
  }
}

export class Destruction {
  private seeds = new Set<number>();
  private bodies: FallingBody[] = [];
  private q = new Int32Array(65536);
  lastDir = new THREE.Vector3(1, 0, 0);
  private tmpC = new THREE.Color();
  barrelsPending: { x: number; y: number; z: number; size: number; t: number }[] = [];

  constructor(
    private world: World,
    private scene: THREE.Scene,
    private particles: Particles,
    private debris: Debris,
    private ev: DestructionEvents,
  ) {}

  private addSeeds(x: number, y: number, z: number) {
    const w = this.world;
    if (x > 0) this.seeds.add(w.idx(x - 1, y, z));
    if (x < WX - 1) this.seeds.add(w.idx(x + 1, y, z));
    if (z > 0) this.seeds.add(w.idx(x, y, z - 1));
    if (z < WZ - 1) this.seeds.add(w.idx(x, y, z + 1));
    if (y > 0) this.seeds.add(w.idx(x, y - 1, z));
    if (y < WY - 1) this.seeds.add(w.idx(x, y + 1, z));
  }

  private removeVoxel(x: number, y: number, z: number, m: number) {
    this.world.set(x, y, z, 0);
    this.addSeeds(x, y, z);
    if (MATS[m].explosive) this.triggerBarrel(x, y, z);
  }

  private triggerBarrel(x: number, y: number, z: number) {
    // remove the whole connected barrel and queue one explosion
    const w = this.world;
    const stack = [[x, y, z]];
    let n = 1, sx = x, sy = y, sz = z;
    const seen = new Set<number>();
    while (stack.length && n < 64 / VK3) {
      const [a, b, c] = stack.pop()!;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nx = a + dx, ny = b + dy, nz = c + dz;
        if (!w.inBounds(nx, ny, nz)) continue;
        const i = w.idx(nx, ny, nz);
        if (seen.has(i) || w.vox[i] !== M.BARREL) continue;
        seen.add(i);
        w.set(nx, ny, nz, 0);
        this.addSeeds(nx, ny, nz);
        stack.push([nx, ny, nz]);
        sx += nx; sy += ny; sz += nz; n++;
      }
    }
    this.barrelsPending.push({ x: ((sx / n) + 0.5) * VOXEL, y: ((sy / n) + 0.5) * VOXEL, z: ((sz / n) + 0.5) * VOXEL, size: n * VK3, t: 0.12 + Math.random() * 0.1 });
  }

  /** Bullet impact on a voxel (plus a little splash around it). Returns true if it broke. */
  damageVoxel(x: number, y: number, z: number, amount: number, dir: THREE.Vector3): boolean {
    const broke = this.hitVoxel(x, y, z, amount, dir, true);
    // spread a share of the hit into the surface around it and the voxel behind
    const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
    const axis = ax > ay && ax > az ? 0 : ay > az ? 1 : 2;
    const s = axis === 0 ? Math.sign(dir.x) : axis === 1 ? Math.sign(dir.y) : Math.sign(dir.z);
    for (let k = 0; k < 3; k++) {
      if (k === axis) continue;
      for (const d of [-1, 1]) this.hitVoxel(x + (k === 0 ? d : 0), y + (k === 1 ? d : 0), z + (k === 2 ? d : 0), amount * 0.3, dir, false);
    }
    this.hitVoxel(x + (axis === 0 ? s : 0), y + (axis === 1 ? s : 0), z + (axis === 2 ? s : 0), amount * 0.4, dir, false);
    return broke;
  }

  private hitVoxel(x: number, y: number, z: number, amount: number, dir: THREE.Vector3, chips: boolean): boolean {
    const w = this.world;
    if (!w.inBounds(x, y, z)) return false;
    const i = w.idx(x, y, z);
    const m = w.vox[i];
    if (m === 0) return false;
    const hp = MATS[m].hp * HP_K;
    if (hp <= 0) return false;
    const acc = (w.damage.get(i) ?? 0) + amount;
    if (acc < hp) {
      w.damage.set(i, acc);
      return false;
    }
    this.lastDir.copy(dir);
    this.removeVoxel(x, y, z, m);
    const c = linearColor(m, this.tmpC);
    const leafy = MATS[m].kind === 'leaf';
    const n = chips ? (leafy ? 3 : 2) : Math.random() < 0.5 ? 1 : 0;
    for (let k = 0; k < n; k++) {
      this.debris.spawn(
        (x + 0.5) * VOXEL, (y + 0.5) * VOXEL, (z + 0.5) * VOXEL,
        -dir.x * 2 + (Math.random() - 0.5) * 3, 2 + Math.random() * 3, -dir.z * 2 + (Math.random() - 0.5) * 3,
        DEB * (leafy ? 0.3 : 0.45), c, leafy ? 3 : 4, leafy,
      );
    }
    return true;
  }

  /** Spherical carve. Returns number of voxels removed. */
  carve(cx: number, cy: number, cz: number, r: number, debrisBudget = 90): number {
    const w = this.world;
    const ir = r / VOXEL;
    const vx = cx / VOXEL, vy = cy / VOXEL, vz = cz / VOXEL;
    const x0 = Math.max(0, Math.floor(vx - ir - 2)), x1 = Math.min(WX - 1, Math.ceil(vx + ir + 2));
    const y0 = Math.max(1, Math.floor(vy - ir - 2)), y1 = Math.min(WY - 1, Math.ceil(vy + ir + 2));
    const z0 = Math.max(0, Math.floor(vz - ir - 2)), z1 = Math.min(WZ - 1, Math.ceil(vz + ir + 2));
    let removed = 0;
    const cands: number[] = [];
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++)
        for (let y = y0; y <= y1; y++) {
          const i = w.idx(x, y, z);
          const m = w.vox[i];
          if (m === 0) continue;
          const dx = x + 0.5 - vx, dy = y + 0.5 - vy, dz = z + 0.5 - vz;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) / ir;
          const jitter = hash3(x, y, z, 99) * 0.3;
          const hp = MATS[m].hp;
          if (hp <= 0) continue;
          const resist = hp >= 14 ? 0.18 : hp >= 10 ? 0.08 : 0;
          if (d < 1 - jitter * 0.6 - resist) {
            cands.push(i);
          } else if (d < 1.35) {
            // scorch / loosen the rim
            if (m === M.GRASS || m === M.FLOWER_BED) w.set(x, y, z, M.DIRT);
            else if ((m === M.SAND || m === M.PATH) && hash3(x, y, z, 7) < 0.5) w.set(x, y, z, M.MUD);
            else if (d < 1.15 && hp > 0) {
              const acc = (w.damage.get(i) ?? 0) + hp * 0.5;
              w.damage.set(i, acc);
            }
          }
        }
    const keepDebris = Math.min(1, debrisBudget / Math.max(1, cands.length));
    const removedAt: number[] = [];
    for (const i of cands) {
      const m = w.vox[i];
      if (m === 0) continue;
      const y = i % WY;
      const t = (i / WY) | 0;
      const z = t % WZ;
      const x = (t / WZ) | 0;
      if (Math.random() < keepDebris) {
        const px = (x + 0.5) * VOXEL, py = (y + 0.5) * VOXEL, pz = (z + 0.5) * VOXEL;
        const dx = px - cx, dy = py - cy + 0.5, dz = pz - cz;
        const l = Math.hypot(dx, dy, dz) + 0.1;
        const sp = 6 + Math.random() * 9;
        const leafy = MATS[m].kind === 'leaf';
        this.debris.spawn(px, py, pz, (dx / l) * sp, (dy / l) * sp + 4, (dz / l) * sp, DEB * (0.5 + Math.random() * 0.45), linearColor(m, this.tmpC), 5, leafy);
      }
      w.set(x, y, z, 0);
      if (MATS[m].explosive) this.triggerBarrel(x, y, z);
      removedAt.push(x, y, z);
      removed++;
    }
    // only the crater's shell can have lost its support: seed the flood fill from there
    const vox = w.vox;
    for (let k = 0; k < removedAt.length; k += 3) {
      const x = removedAt[k], y = removedAt[k + 1], z = removedAt[k + 2];
      const i = w.idx(x, y, z);
      if (x > 0 && vox[i - WZ * WY]) this.seeds.add(i - WZ * WY);
      if (x < WX - 1 && vox[i + WZ * WY]) this.seeds.add(i + WZ * WY);
      if (z > 0 && vox[i - WY]) this.seeds.add(i - WY);
      if (z < WZ - 1 && vox[i + WY]) this.seeds.add(i + WY);
      if (y > 0 && vox[i - 1]) this.seeds.add(i - 1);
      if (y < WY - 1 && vox[i + 1]) this.seeds.add(i + 1);
    }
    return removed;
  }

  /**
   * Foliage owned by a falling structure: a multi-source BFS through leaves near it, started at the
   * same time from every leaf touching this structure and from every leaf touching other support.
   */
  private claimFoliage(body: Set<number>, touch: number[]) {
    const vox = this.world.vox;
    let x0 = WX, x1 = 0, z0 = WZ, z1 = 0, y0 = WY, y1 = 0;
    for (const i of body) {
      const y = i % WY, t = (i / WY) | 0, z = t % WZ, x = (t / WZ) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const M_ = 24;
    x0 = Math.max(0, x0 - M_); x1 = Math.min(WX - 1, x1 + M_);
    z0 = Math.max(0, z0 - M_); z1 = Math.min(WZ - 1, z1 + M_);
    y0 = Math.max(1, y0 - 4); y1 = Math.min(WY - 2, y1 + M_);
    const owner = new Map<number, number>();
    const q: number[] = [];
    for (const l of touch) if (!owner.has(l)) { owner.set(l, 1); q.push(l); }
    const SX = WZ * WY;
    const nOff = [SX, -SX, WY, -WY, 1, -1];
    // rival sources: leaves in the box resting on anything solid that isn't this body
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const col = (x * WZ + z) * WY;
        for (let y = y0; y <= y1; y++) {
          const i = col + y;
          if (LEAF[vox[i]] !== 1 || owner.has(i)) continue;
          for (const o of nOff) {
            const n = i + o;
            const m = vox[n];
            if (m !== 0 && LEAF[m] !== 1 && !body.has(n)) {
              owner.set(i, 2);
              q.push(i);
              break;
            }
          }
        }
      }
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      const own = owner.get(i)!;
      const y = i % WY, t = (i / WY) | 0, z = t % WZ, x = (t / WZ) | 0;
      if (x <= x0 || x >= x1 || z <= z0 || z >= z1 || y <= y0 || y >= y1) continue;
      for (const o of nOff) {
        const n = i + o;
        if (LEAF[vox[n]] !== 1 || owner.has(n)) continue;
        owner.set(n, own);
        q.push(n);
      }
    }
    for (const [i, own] of owner) if (own === 1) body.add(i);
  }

  /**
   * Flood fill from seeds; anything not connected to bedrock becomes a falling body.
   * Leaves never carry load: support only travels through solid material, so trees whose crowns
   * touch don't hold each other up. A toppling tree takes the foliage nearer its own wood than
   * any other support, which is how crowns are split between neighbours.
   */
  private processSeeds() {
    if (this.seeds.size === 0) return;
    const w = this.world;
    const vox = w.vox;
    const grounded = new Set<number>();
    const heldLeaves = new Set<number>();
    const LIMIT = 5200 / VK3;
    const ground = w.ground;
    const seeds = [...this.seeds];
    this.seeds.clear();
    const SX = WZ * WY;
    const nbs = (idx: number, out: number[]) => {
      const y = idx % WY;
      const t = (idx / WY) | 0;
      const z = t % WZ;
      const x = (t / WZ) | 0;
      out[0] = x > 0 ? idx - SX : -1;
      out[1] = x < WX - 1 ? idx + SX : -1;
      out[2] = z > 0 ? idx - WY : -1;
      out[3] = z < WZ - 1 ? idx + WY : -1;
      out[4] = y > 0 ? idx - 1 : -1;
      out[5] = y < WY - 1 ? idx + 1 : -1;
    };
    const nb = [0, 0, 0, 0, 0, 0];
    for (const s of seeds) {
      if (vox[s] === 0 || grounded.has(s) || heldLeaves.has(s)) continue;
      const leafSeed = LEAF[vox[s]] === 1;
      const visited = new Set<number>([s]);
      const touchLeaves: number[] = [];
      const q = this.q;
      let head = 0, tail = 0;
      q[tail++] = s;
      let isGround = false;
      while (head < tail && !isGround) {
        const idx = q[head++];
        const y = idx % WY;
        // anything inside the original terrain is held by the ground itself
        if (y <= 1 || y < ground[(idx / WY) | 0]) { isGround = true; break; }
        nbs(idx, nb);
        for (const n of nb) {
          if (n < 0 || vox[n] === 0 || visited.has(n)) continue;
          const leaf = LEAF[vox[n]] === 1;
          if (leafSeed) {
            // a loose clump of foliage is held as soon as it touches anything solid
            if (!leaf || heldLeaves.has(n)) { isGround = true; break; }
          } else if (leaf) {
            touchLeaves.push(n);
            continue;
          } else if (grounded.has(n)) { isGround = true; break; }
          visited.add(n);
          if (tail >= q.length) { isGround = true; break; }
          q[tail++] = n;
        }
        if (visited.size > LIMIT) isGround = true;
      }
      if (isGround) {
        const into = leafSeed ? heldLeaves : grounded;
        for (const v of visited) into.add(v);
        continue;
      }
      if (!leafSeed && touchLeaves.length) this.claimFoliage(visited, touchLeaves);
      const list = [...visited];
      if (list.length < 7 / VK3) {
        // crumbs: a few chunks of debris, the rest just goes
        let chips = 6;
        for (const i of list) {
          const y = i % WY, t = (i / WY) | 0, z = t % WZ, x = (t / WZ) | 0;
          const m = vox[i];
          if (chips-- > 0) this.debris.spawn((x + 0.5) * VOXEL, (y + 0.5) * VOXEL, (z + 0.5) * VOXEL, (Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2, DEB * 0.9, linearColor(m, this.tmpC), 4, MATS[m].kind === 'leaf');
          w.set(x, y, z, 0);
        }
        continue;
      }
      // the packed vertex format holds coordinates up to 255 voxels; anything longer stays put
      let lo = 1e9, hi = -1, lo2 = 1e9, hi2 = -1;
      for (const i of list) {
        const t = (i / WY) | 0, z = t % WZ, x = (t / WZ) | 0;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
        if (z < lo2) lo2 = z;
        if (z > hi2) hi2 = z;
      }
      if (hi - lo > 250 || hi2 - lo2 > 250) continue;
      const body = new FallingBody(list, w, this.scene, this.lastDir);
      this.bodies.push(body);
      this.ev.onTopple(body.pivot.x, body.pivot.y, body.pivot.z, body.isTree);
    }
  }

  private settle(b: FallingBody) {
    const w = this.world;
    const v = new THREE.Vector3();
    const n = b.mats.length;
    let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9;
    let debrisLeft = 110;
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < n; i++) {
      b.worldOf(i, v);
      const m = b.mats[i];
      const kind = MATS[m].kind;
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
      sx += v.x; sy += v.y; sz += v.z;
      const keep = kind === 'leaf' ? 0.72 : 0.86;
      if (Math.random() > keep) {
        if (debrisLeft-- > 0) this.debris.spawn(v.x, v.y, v.z, (Math.random() - 0.5) * 4, 2 + Math.random() * 3, (Math.random() - 0.5) * 4, DEB * 0.7, linearColor(m, this.tmpC), 4, kind === 'leaf');
        continue;
      }
      let x = Math.floor(v.x / VOXEL), y = Math.floor(v.y / VOXEL), z = Math.floor(v.z / VOXEL);
      if (!w.inBounds(x, Math.max(1, y), z)) continue;
      y = Math.max(1, y);
      for (let k = 0; k < 6; k++) {
        if (y + k < WY && w.get(x, y + k, z) === 0) {
          w.set(x, y + k, z, m);
          break;
        }
      }
    }
    this.scene.remove(b.mesh);
    b.voxMesh.geometry.dispose();
    (b.voxMesh.material as THREE.Material).dispose();
    const cx = sx / n, cy = sy / n, cz = sz / n;
    for (let i = 0; i < 10; i++) this.particles.dust(cx + (Math.random() - 0.5) * (maxX - minX), cy, cz + (Math.random() - 0.5) * (maxZ - minZ), 0.55, 0.5, 0.42, 2, 2);
    this.ev.onBodyImpact(cx, cy, cz, n * VK3, minX, minZ, maxX, maxZ, b.isTree);
  }

  update(dt: number) {
    this.processSeeds();
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      if (b.update(dt, this.world)) {
        this.settle(b);
        this.bodies.splice(i, 1);
      }
    }
    for (let i = this.barrelsPending.length - 1; i >= 0; i--) {
      const p = this.barrelsPending[i];
      p.t -= dt;
      if (p.t <= 0) {
        this.barrelsPending.splice(i, 1);
        this.ev.onBarrel(p.x, p.y, p.z, p.size);
      }
    }
  }

  get activeBodies() {
    return this.bodies.length;
  }
}
