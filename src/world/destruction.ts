import * as THREE from 'three';
import { GRAVITY, VOXEL, WATER_Y, WX, WY, WZ } from '../core/config';
import { hash3 } from '../core/noise';
import { Debris, Particles } from '../render/effects';
import { shared } from '../render/shaderlib';
import { createVoxelMaterial } from '../render/voxelMaterial';
import { M, MATS } from './materials';
import { greedyMesh } from './mesher';
import { Fail, type StructBody } from './structure';
import { StructureMonitor, type StructBox } from './structureMonitor';
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

const LEAFY = new Uint8Array(256);
MATS.forEach((d, i) => { if (d.kind === 'leaf') LEAFY[i] = 1; });
/** empty or foliage: falling chunks crash straight through leaves */
const soft = (m: number) => m === 0 || LEAFY[m] === 1;

const linearColor = (m: number, out = new THREE.Color()) => {
  const p = shared.uPalette.value[m];
  if (!p) return out.setRGB(0.5, 0.5, 0.5);
  const j = 1 + (Math.random() - 0.5) * 2 * p.w;
  return out.setRGB(p.x * j, p.y * j, p.z * j);
};

/** how a piece leaves its support */
export interface BodyMotion {
  /** edge it pivots over (world metres); null when it just drops */
  hinge: THREE.Vector3 | null;
  /** horizontal direction it leans toward */
  dir: THREE.Vector3;
  /** angle (radians) at which it tears free of the hinge and flies */
  release: number;
  /** metres it slumps into a crushed support before pivoting */
  sink: number;
}

const _v = new THREE.Vector3();
const _r = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Vector3();
const _eq = new THREE.Quaternion();
const _g = new THREE.Vector3(0, -GRAVITY, 0);

/**
 * A rigid chunk of voxels: it pivots over the edge it was left standing on, tears free and flies
 * with the momentum it picked up, and breaks apart when it lands hard.
 */
export class FallingBody {
  /** network id (online matches) */
  nid = 0;
  /** placed at the centre of mass and rotated; the voxel mesh inside is offset to the grid corner */
  mesh = new THREE.Group();
  voxMesh: THREE.Mesh;
  /** voxel coordinates in the body's own grid (its corner at 0) */
  grid: Int16Array;
  mats: Uint8Array;
  /** voxel centres relative to the centre of mass (metres, body frame) */
  local: Float32Array;
  pivotLocal = new THREE.Vector3();
  dims = new THREE.Vector3();
  samples: number[] = [];
  pos = new THREE.Vector3();
  quat = new THREE.Quaternion();
  vel = new THREE.Vector3();
  spin = new THREE.Vector3();
  prevPos = new THREE.Vector3();
  prevQuat = new THREE.Quaternion();
  hinged = false;
  hinge = new THREE.Vector3();
  axis = new THREE.Vector3();
  theta = 0;
  omega = 0;
  release = 0.6;
  private q0 = new THREE.Quaternion();
  private p0 = new THREE.Vector3();
  private sink = 0;
  private sunk = 0;
  /** squared radius of gyration (m²) and bounding radius (m) */
  gyr2: number;
  radius: number;
  height: number;
  age = 0;
  wet = false;
  /** a tall piece dropped off its foot: when it first lands it keels over the edge it hit */
  pivotOnLand = false;
  isTree: boolean;
  solidFrac: number;

  constructor(grid: Int16Array, mats: Uint8Array, corner: THREE.Vector3, quat: THREE.Quaternion, scene: THREE.Scene, readonly gen: number, readonly colorOffset: THREE.Vector3) {
    this.grid = grid;
    this.mats = mats;
    const n = mats.length;
    let sx = 0, sy = 0, sz = 0, cx = 0, cy = 0, cz = 0, leaves = 0, wood = 0;
    for (let i = 0; i < n; i++) {
      const x = grid[i * 3], y = grid[i * 3 + 1], z = grid[i * 3 + 2];
      if (x + 1 > sx) sx = x + 1;
      if (y + 1 > sy) sy = y + 1;
      if (z + 1 > sz) sz = z + 1;
      cx += x; cy += y; cz += z;
      const k = MATS[mats[i]].kind;
      if (k === 'leaf') leaves++;
      else if (k === 'wood') wood++;
    }
    this.isTree = leaves + wood > n * 0.8 && wood > 3;
    this.solidFrac = 1 - leaves / n;
    this.dims.set(sx, sy, sz);
    this.height = sy * VOXEL;
    this.pivotLocal.set((cx / n + 0.5) * VOXEL, (cy / n + 0.5) * VOXEL, (cz / n + 0.5) * VOXEL);
    const PX = sx + 2, PY = sy + 2, PZ = sz + 2;
    const vol = new Uint8Array(PX * PY * PZ);
    this.local = new Float32Array(n * 3);
    let r2 = 0, g2 = 0;
    for (let i = 0; i < n; i++) {
      const x = grid[i * 3], y = grid[i * 3 + 1], z = grid[i * 3 + 2];
      vol[((x + 1) * PZ + (z + 1)) * PY + (y + 1)] = mats[i];
      const lx = (x + 0.5) * VOXEL - this.pivotLocal.x, ly = (y + 0.5) * VOXEL - this.pivotLocal.y, lz = (z + 0.5) * VOXEL - this.pivotLocal.z;
      this.local[i * 3] = lx;
      this.local[i * 3 + 1] = ly;
      this.local[i * 3 + 2] = lz;
      const d2 = lx * lx + ly * ly + lz * lz;
      g2 += d2;
      if (d2 > r2) r2 = d2;
    }
    this.gyr2 = g2 / n;
    this.radius = Math.sqrt(r2) + VOXEL;
    const md = greedyMesh(vol, PX, PY, PZ);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(md.positions, 4, false));
    geo.setAttribute('aData', new THREE.BufferAttribute(md.data, 4, false));
    geo.setIndex(new THREE.BufferAttribute(md.indices, 1));
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(sx, sy, sz));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    this.voxMesh = new THREE.Mesh(geo, createVoxelMaterial({ offset: colorOffset.clone() }));
    this.voxMesh.castShadow = true;
    this.voxMesh.receiveShadow = true;
    this.voxMesh.scale.setScalar(VOXEL);
    this.voxMesh.position.copy(this.pivotLocal).negate();
    this.mesh.add(this.voxMesh);
    this.quat.copy(quat);
    this.pos.copy(this.pivotLocal).applyQuaternion(quat).add(corner);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);
    scene.add(this.mesh);

    // contact probes: the extremes in 26 directions, plus a spread through the body
    const dirs: number[][] = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) if (a || b || c) dirs.push([a, b, c]);
    for (const [a, b, c] of dirs) {
      let best = 0, bv = -1e9;
      for (let i = 0; i < n; i++) {
        const v = this.local[i * 3] * a + this.local[i * 3 + 1] * b + this.local[i * 3 + 2] * c;
        if (v > bv) { bv = v; best = i; }
      }
      if (!this.samples.includes(best)) this.samples.push(best);
    }
    const step = Math.max(1, Math.floor(n / 48));
    for (let i = (step >> 1); i < n; i += step) this.samples.push(i);
  }

  /** lifts a piece out of the world */
  static fromWorld(voxels: number[], world: World, scene: THREE.Scene): FallingBody {
    let minX = 1e9, minY = 1e9, minZ = 1e9;
    const n = voxels.length;
    const coords = new Int32Array(n * 3);
    const mats = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const idx = voxels[i];
      const y = idx % WY, t = (idx / WY) | 0, z = t % WZ, x = (t / WZ) | 0;
      coords[i * 3] = x; coords[i * 3 + 1] = y; coords[i * 3 + 2] = z;
      mats[i] = world.vox[idx];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
    }
    const grid = new Int16Array(n * 3);
    world.quiet = true;
    for (let i = 0; i < n; i++) {
      grid[i * 3] = coords[i * 3] - minX;
      grid[i * 3 + 1] = coords[i * 3 + 1] - minY;
      grid[i * 3 + 2] = coords[i * 3 + 2] - minZ;
      world.set(coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2], 0);
    }
    world.quiet = false;
    const corner = new THREE.Vector3(minX * VOXEL, minY * VOXEL, minZ * VOXEL);
    return new FallingBody(grid, mats, corner, new THREE.Quaternion(), scene, 0, corner);
  }

  /** the outermost point of its lowest layers along `d` (world metres): where it pivots over */
  baseEdge(d: THREE.Vector3, out: THREE.Vector3) {
    const n = this.mats.length;
    let best = -1e9;
    for (let i = 0; i < n; i++) {
      if (this.grid[i * 3 + 1] > 2) continue;
      const v = this.local[i * 3] * d.x + this.local[i * 3 + 2] * d.z;
      if (v > best) best = v;
    }
    const bottom = -this.pivotLocal.y;
    return out.set(this.pos.x + d.x * (best + VOXEL * 0.5), this.pos.y + bottom, this.pos.z + d.z * (best + VOXEL * 0.5));
  }

  setMotion(m: BodyMotion) {
    if (m.hinge) {
      this.hinged = true;
      this.hinge.copy(m.hinge);
      this.axis.set(0, 1, 0).cross(m.dir).normalize();
      this.release = m.release;
      this.omega = 0.25 + Math.random() * 0.2;
      this.q0.copy(this.quat);
      this.p0.copy(this.pos);
      this.vel.set(0, 0, 0);
      this.spin.set(0, 0, 0);
    } else {
      this.vel.set(m.dir.x * 0.6, 0, m.dir.z * 0.6);
      this.spin.set((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.5);
    }
    this.sink = m.sink;
  }

  worldOf(i: number, out: THREE.Vector3) {
    return out.set(this.local[i * 3], this.local[i * 3 + 1], this.local[i * 3 + 2]).applyQuaternion(this.quat).add(this.pos);
  }

  /** true when a probe point sits inside the world */
  private touches(world: World, skipNear: number) {
    for (const i of this.samples) {
      this.worldOf(i, _v);
      if (skipNear > 0) {
        // while it pivots, its foot grinds over the edge it stands on: only the rest can hit things
        _r.copy(_v).sub(this.hinge);
        const along = _r.dot(this.axis);
        const off = _r.lengthSq() - along * along;
        if (off < skipNear * skipNear) continue;
        if (this.theta < 0.3 && _v.y < this.hinge.y + 0.4) continue;
      }
      if (_v.y < 0.3 || !soft(world.get(Math.floor(_v.x / VOXEL), Math.floor(_v.y / VOXEL), Math.floor(_v.z / VOXEL)))) return true;
    }
    return false;
  }

  /** advances the body; true when it hit something this step (it is left just short of contact) */
  update(dt: number, world: World): boolean {
    this.age += dt;
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    if (this.hinged) {
      // a support that gave way under it first lets it slump
      if (this.sunk < this.sink) {
        const d = Math.min(this.sink - this.sunk, dt * 2.2);
        this.sunk += d;
        this.hinge.y -= d;
        this.p0.y -= d;
      }
      _r.copy(this.pos).sub(this.hinge);
      // gravity's torque about the hinge edge, over the moment of inertia about it
      const tau = _v.copy(_r).cross(_g).dot(this.axis);
      this.omega += (tau / (_r.lengthSq() + this.gyr2)) * dt;
      this.omega = Math.min(this.omega, 6);
      this.theta += this.omega * dt;
      _q.setFromAxisAngle(this.axis, this.theta);
      this.quat.copy(_q).multiply(this.q0);
      this.pos.copy(this.p0).sub(this.hinge).applyQuaternion(_q).add(this.hinge);
      const skip = Math.max(1.2, this.radius * 0.25);
      _r.copy(this.pos).sub(this.hinge);
      const r0 = _e.copy(_r);
      if (this.touches(world, skip)) {
        _r.copy(r0);
        this.vel.copy(this.axis).cross(_r).multiplyScalar(this.omega);
        this.spin.copy(this.axis).multiplyScalar(this.omega);
        this.refine(world, skip);
        this.syncMesh();
        return true;
      }
      if (this.theta > this.release) {
        // tears free of the edge and keeps the momentum it built up
        _r.copy(this.pos).sub(this.hinge);
        this.vel.copy(this.axis).cross(_r).multiplyScalar(this.omega);
        this.spin.copy(this.axis).multiplyScalar(this.omega);
        this.hinged = false;
      }
      this.syncMesh();
      return this.age > 9;
    }
    this.vel.y -= GRAVITY * dt;
    if (this.pos.y < WATER_Y) {
      // water drags it down slowly
      const k = Math.exp(-2.5 * dt);
      this.vel.multiplyScalar(k);
      this.spin.multiplyScalar(k);
      this.wet = true;
    }
    this.pos.addScaledVector(this.vel, dt);
    const s = this.spin.length();
    if (s > 1e-5) {
      _q.setFromAxisAngle(_v.copy(this.spin).divideScalar(s), s * dt);
      this.quat.premultiply(_q);
    }
    if (this.touches(world, 0)) {
      this.refine(world, 0);
      this.syncMesh();
      return true;
    }
    this.syncMesh();
    return this.age > 9;
  }

  /** after a step that ended inside something: back up to just short of the contact */
  private refine(world: World, skipNear: number) {
    const endPos = _e.copy(this.pos);
    const endQuat = _eq.copy(this.quat);
    let lo = 0, hi = 1;
    for (let k = 0; k < 5; k++) {
      const t = (lo + hi) * 0.5;
      this.pos.lerpVectors(this.prevPos, endPos, t);
      this.quat.slerpQuaternions(this.prevQuat, endQuat, t);
      if (this.touches(world, skipNear)) hi = t;
      else lo = t;
    }
    this.pos.lerpVectors(this.prevPos, endPos, lo);
    this.quat.slerpQuaternions(this.prevQuat, endQuat, lo);
  }

  /** average of the probes resting on something (world metres) */
  contactPoint(world: World, out: THREE.Vector3) {
    out.set(0, 0, 0);
    let n = 0, low = 1e9;
    const lowP = new THREE.Vector3();
    for (const i of this.samples) {
      this.worldOf(i, _v);
      if (_v.y < low) { low = _v.y; lowP.copy(_v); }
      const y = _v.y - VOXEL * 0.6;
      if (y < 0.3 || !soft(world.get(Math.floor(_v.x / VOXEL), Math.floor(y / VOXEL), Math.floor(_v.z / VOXEL)))) {
        out.add(_v);
        n++;
      }
    }
    return n ? out.divideScalar(n) : out.copy(lowP);
  }

  /** speed of the hardest-moving probe */
  impactSpeed() {
    return this.vel.length() + this.spin.length() * this.radius * 0.6;
  }

  syncMesh() {
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.mesh);
    this.voxMesh.geometry.dispose();
    (this.voxMesh.material as THREE.Material).dispose();
  }
}

export class Destruction {
  private bodies: FallingBody[] = [];
  /** judges what's left standing after damage, off the main thread */
  readonly structure: StructureMonitor;
  lastDir = new THREE.Vector3(1, 0, 0);
  /** debug: the last pieces that gave way (kind, voxels, how far past its limit) */
  readonly log: { kind: Fail; n: number; ratio: number; taken: number }[] = [];
  private tmpC = new THREE.Color();
  barrelsPending: { x: number; y: number; z: number; size: number; t: number }[] = [];
  /** online host: told whenever a falling piece appears or is gone for good */
  onBodyAdd: ((b: FallingBody) => void) | null = null;
  onBodyEnd: ((b: FallingBody) => void) | null = null;
  /** online peer: the host decides what breaks and falls; pieces here only follow its reports */
  puppet = false;
  readonly puppets = new Map<number, FallingBody>();
  /** recent blasts on a peer, so the voxels they knock out fly away from them */
  private blasts: { x: number; y: number; z: number; r: number; t: number }[] = [];
  private clock = 0;

  constructor(
    private world: World,
    private scene: THREE.Scene,
    private particles: Particles,
    private debris: Debris,
    private ev: DestructionEvents,
  ) {
    this.structure = new StructureMonitor(world);
  }

  private removeVoxel(x: number, y: number, z: number, m: number) {
    this.world.set(x, y, z, 0);
    this.structure.damaged(x, y, z);
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
        this.structure.damaged(nx, ny, nz);
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
    // every blast gets its own shape: a few broad lobes make it lopsided and stretched
    const lobes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const u = Math.random() * 2 - 1, t = Math.random() * 6.283, h = Math.sqrt(1 - u * u);
      lobes.push(h * Math.cos(t), u, h * Math.sin(t), (Math.random() - 0.5) * 0.36, (Math.random() - 0.5) * 0.5);
    }
    const ox = (Math.random() * 4096) | 0, oz = (Math.random() * 4096) | 0;
    // on (or just above) the ground the blast vents sideways: a wide, shallow bowl instead of a ball
    let below = 0;
    const scanX = Math.floor(vx), scanZ = Math.floor(vz);
    while (below < ir && w.get(scanX, Math.floor(vy) - below, scanZ) === 0) below++;
    const flat = Math.max(0, 1 - below / Math.max(1, ir * 0.9));
    const ext = 1 + flat * 0.15;
    const x0 = Math.max(0, Math.floor(vx - ir * ext - 2)), x1 = Math.min(WX - 1, Math.ceil(vx + ir * ext + 2));
    const y0 = Math.max(1, Math.floor(vy - ir - 2)), y1 = Math.min(WY - 1, Math.ceil(vy + ir + 2));
    const z0 = Math.max(0, Math.floor(vz - ir * ext - 2)), z1 = Math.min(WZ - 1, Math.ceil(vz + ir * ext + 2));
    let removed = 0;
    const cands: number[] = [];
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++)
        for (let y = y0; y <= y1; y++) {
          const i = w.idx(x, y, z);
          const m = w.vox[i];
          if (m === 0) continue;
          const hp = MATS[m].hp;
          if (hp <= 0) continue;
          let dx = x + 0.5 - vx, dy = y + 0.5 - vy, dz = z + 0.5 - vz;
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          const nx = dx / len, ny = dy / len, nz = dz / len;
          let shape = 1;
          for (let k = 0; k < 15; k += 5) {
            const c = nx * lobes[k] + ny * lobes[k + 1] + nz * lobes[k + 2];
            shape += lobes[k + 3] * c + lobes[k + 4] * (c * c - 0.33);
          }
          if (dy < 0) dy *= 1 + flat * 0.8;
          dx /= ext;
          dz /= ext;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) / ir;
          // soft things go further than stone and steel
          const reach = Math.max(0.68, Math.min(1.1, 1.12 - hp * 0.02));
          // chunky breakup at two voxel scales so the rim is jagged, not stair-stepped
          const rough = (hash3((x >> 1) + ox, y >> 1, (z >> 1) + oz, 17) - 0.5) * 0.22 + (hash3(x + ox, y, z + oz, 99) - 0.5) * 0.1;
          const edge = reach * shape + rough - 0.05;
          if (d < edge) {
            cands.push(i);
          } else if (d < edge + 0.2 && MATS[m].kind !== 'metal' && hash3(x + oz, y, z + ox, 5) < 0.22) {
            // loose rim: a few voxels just past the edge are knocked out too
            cands.push(i);
          } else if (d < edge + 0.4) {
            // scorch / loosen the rim
            if (m === M.GRASS || m === M.FLOWER_BED) w.set(x, y, z, M.DIRT);
            else if ((m === M.SAND || m === M.PATH) && hash3(x, y, z, 7) < 0.5) w.set(x, y, z, M.MUD);
            else if (d < edge + 0.15) {
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
    // the crater is judged for what it leaves hanging
    for (let k = 0; k < removedAt.length; k += 3) this.structure.damaged(removedAt[k], removedAt[k + 1], removedAt[k + 2]);
    return removed;
  }

  /** a piece the structural check says has given way: lift it out and set it moving */
  private release(sb: StructBody, box: StructBox) {
    const w = this.world;
    const vox = w.vox;
    // the world may have moved on while the worker was thinking: only take what's still there
    const list: number[] = [];
    for (let k = 0; k < sb.idx.length; k++) {
      const wi = StructureMonitor.toWorld(box, sb.idx[k]);
      if (vox[wi] === sb.mats[k] && vox[wi] !== 0) list.push(wi);
    }
    if (this.log.length > 40) this.log.shift();
    if (sb.idx.length >= 7 / VK3) this.log.push({ kind: sb.kind, n: sb.idx.length, ratio: sb.ratio, taken: list.length });
    if (list.length === 0 || list.length < sb.idx.length * 0.5) return;
    if (list.length < 7 / VK3) {
      // crumbs: a few chunks of debris, the rest just goes
      let chips = 6;
      for (const i of list) {
        const y = i % WY, t = (i / WY) | 0, z = t % WZ, x = (t / WZ) | 0;
        const m = vox[i];
        if (chips-- > 0) this.debris.spawn((x + 0.5) * VOXEL, (y + 0.5) * VOXEL, (z + 0.5) * VOXEL, (Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2, DEB * 0.9, linearColor(m, this.tmpC), 4, MATS[m].kind === 'leaf');
        w.set(x, y, z, 0);
        this.structure.damaged(x, y, z);
      }
      return;
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
    if (hi - lo > 250 || hi2 - lo2 > 250) return;
    if (sb.kind === Fail.Crush) this.crushSupport(sb, box, list);
    for (const i of list) this.structure.lifted(i);
    const body = FallingBody.fromWorld(list, w, this.scene);
    const dir = new THREE.Vector3(sb.dx, 0, sb.dz);
    if (dir.lengthSq() < 1e-4) {
      dir.copy(this.lastDir).setY(0);
      if (dir.lengthSq() < 1e-4) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    }
    dir.normalize();
    const d = body.dims;
    const tall = d.y > Math.max(d.x, d.z) * 1.3 && body.height >= 2;
    const hingeAt = new THREE.Vector3((box.x0 + sb.hx) * VOXEL, sb.hy * VOXEL, (box.z0 + sb.hz) * VOXEL);
    const motion: BodyMotion = { hinge: null, dir, release: 0.6, sink: 0 };
    switch (sb.kind) {
      case Fail.Tip:
        // leans out over the last edge still holding it
        motion.hinge = hingeAt;
        motion.release = tall ? 0.75 : 0.45;
        break;
      case Fail.Bend:
        // snaps at the root and swings down off it
        motion.hinge = hingeAt;
        motion.release = 0.35;
        break;
      case Fail.Crush:
        // anything about as tall as it is wide goes over once its foot gives way
        if (tall || (d.y >= Math.max(d.x, d.z) * 0.8 && body.height >= 2)) {
          motion.hinge = body.baseEdge(dir, new THREE.Vector3());
          motion.release = 0.8;
          motion.sink = VOXEL * 3;
        }
        break;
      case Fail.Loose:
        if (tall) {
          // a trunk cut clean through goes over rather than straight down
          motion.hinge = body.baseEdge(dir, new THREE.Vector3());
          motion.release = 0.8;
          motion.sink = VOXEL;
        } else if (d.y >= Math.max(d.x, d.z) * 0.8 && body.height >= 2) {
          // a block cut off at its foot drops onto the stump and keels over the edge it lands on
          body.pivotOnLand = true;
        }
        break;
      case Fail.Shear:
        break;
    }
    body.setMotion(motion);
    this.bodies.push(body);
    this.onBodyAdd?.(body);
    this.ev.onTopple(body.pos.x, body.pos.y, body.pos.z, body.isTree);
  }

  /** a crushed support doesn't survive: the last few voxels under the piece burst into rubble */
  private crushSupport(sb: StructBody, box: StructBox, list: number[]) {
    const w = this.world;
    const L = Math.round(sb.hy);
    const cols = new Set<number>();
    for (const i of list) {
      const y = i % WY;
      if (y < L + 2) cols.add((i / WY) | 0);
    }
    let chips = 40;
    for (const col of cols) {
      const x = (col / WZ) | 0, z = col % WZ;
      for (let y = L - 3; y < L; y++) {
        if (y <= 1 || y < w.ground[col]) continue;
        const m = w.get(x, y, z);
        if (m === 0 || MATS[m].hp <= 0) continue;
        if (chips-- > 0) this.debris.spawn((x + 0.5) * VOXEL, (y + 0.5) * VOXEL, (z + 0.5) * VOXEL, (Math.random() - 0.5) * 6, 1 + Math.random() * 3, (Math.random() - 0.5) * 6, DEB * 0.6, linearColor(m, this.tmpC), 4, false);
        w.set(x, y, z, 0);
        this.structure.damaged(x, y, z);
      }
    }
    void box;
  }

  /** it hit something: big hard chunks break apart on a heavy landing, the rest comes to rest */
  private impact(b: FallingBody) {
    if (b.pivotOnLand && b.age < 9) {
      b.pivotOnLand = false;
      const c = b.contactPoint(this.world, new THREE.Vector3());
      // it tips away from where it touched down, about that point
      const dir = new THREE.Vector3(b.pos.x - c.x, 0, b.pos.z - c.z);
      if (dir.lengthSq() < 0.09) dir.copy(this.lastDir).setY(0);
      if (dir.lengthSq() < 1e-4) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      dir.normalize();
      const hinge = b.baseEdge(dir.clone().negate(), new THREE.Vector3());
      hinge.y = Math.min(hinge.y, c.y);
      b.setMotion({ hinge: c.lengthSq() > 0 ? c.setY(hinge.y) : hinge, dir, release: 0.8, sink: 0 });
      b.omega = 0.5;
      for (let i = 0; i < 8; i++) this.particles.dust(c.x + (Math.random() - 0.5) * 2, c.y, c.z + (Math.random() - 0.5) * 2, 0.55, 0.5, 0.42, 1.5, 1.5);
      this.bodies.push(b);
      return;
    }
    const speed = b.impactSpeed();
    const n = b.mats.length;
    // what it lands on takes the blow too
    if (!b.isTree && b.solidFrac > 0.5 && speed > 5 && !b.wet) {
      const r = Math.min(1.5, 0.3 * Math.cbrt(n * VK3) * Math.min(1, speed / 12));
      if (r > 0.45) {
        const v = new THREE.Vector3();
        let low = 0, ly = 1e9;
        for (const i of b.samples) {
          b.worldOf(i, v);
          if (v.y < ly) { ly = v.y; low = i; }
        }
        b.worldOf(low, v);
        this.carve(v.x, v.y - 0.15, v.z, r, 24);
      }
    }
    // the first hard landing breaks it up; a chunk only breaks again if it falls a long way
    const hard = b.gen === 0 ? speed > 4.5 : b.gen < 2 && b.age > 0.3 && speed > 10;
    if (!b.isTree && b.solidFrac > 0.5 && n >= 160 && hard && b.age < 9) this.shatter(b, speed);
    else this.settle(b);
  }

  /** splits a body into a few chunks (nearest of k random cores) that tumble on apart */
  private shatter(b: FallingBody, speed: number) {
    const n = b.mats.length;
    const k = Math.max(2, Math.min(9, Math.round(n / 260) + 1));
    const cores: number[] = [];
    for (let i = 0; i < k; i++) cores.push((Math.random() * n) | 0);
    const g = b.grid;
    const owner = new Uint8Array(n);
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = 1e9;
      for (let c = 0; c < k; c++) {
        const j = cores[c];
        const dx = g[i * 3] - g[j * 3], dy = g[i * 3 + 1] - g[j * 3 + 1], dz = g[i * 3 + 2] - g[j * 3 + 2];
        // a little noise makes the cracks ragged instead of flat Voronoi faces
        const d = dx * dx + dy * dy + dz * dz + hash3(g[i * 3] >> 1, g[i * 3 + 1] >> 1, g[i * 3 + 2] >> 1, c + 40) * 9;
        if (d < bd) { bd = d; best = c; }
      }
      owner[i] = best;
      counts[best]++;
    }
    const v = new THREE.Vector3();
    const rel = new THREE.Vector3();
    let debrisLeft = 90;
    let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9, sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < n; i++) {
      b.worldOf(i, v);
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
      sx += v.x; sy += v.y; sz += v.z;
    }
    const kick = Math.min(1, speed / 10);
    for (let c = 0; c < k; c++) {
      const cnt = counts[c];
      if (cnt === 0) continue;
      if (cnt < 24) {
        for (let i = 0; i < n; i++) {
          if (owner[i] !== c || debrisLeft-- <= 0) continue;
          b.worldOf(i, v);
          this.debris.spawn(v.x, v.y, v.z, (Math.random() - 0.5) * 6, 2 + Math.random() * 4, (Math.random() - 0.5) * 6, DEB * 0.75, linearColor(b.mats[i], this.tmpC), 5, MATS[b.mats[i]].kind === 'leaf');
        }
        continue;
      }
      let mx = 1e9, my = 1e9, mz = 1e9;
      for (let i = 0; i < n; i++) {
        if (owner[i] !== c) continue;
        mx = Math.min(mx, g[i * 3]); my = Math.min(my, g[i * 3 + 1]); mz = Math.min(mz, g[i * 3 + 2]);
      }
      const sub = new Int16Array(cnt * 3);
      const mats = new Uint8Array(cnt);
      let j = 0;
      for (let i = 0; i < n; i++) {
        if (owner[i] !== c) continue;
        // a share of the voxels on every crack face is ground to dust
        if (Math.random() < 0.06 && debrisLeft-- > 0) {
          b.worldOf(i, v);
          this.debris.spawn(v.x, v.y, v.z, (Math.random() - 0.5) * 5, 1 + Math.random() * 4, (Math.random() - 0.5) * 5, DEB * 0.55, linearColor(b.mats[i], this.tmpC), 4, false);
        }
        sub[j * 3] = g[i * 3] - mx; sub[j * 3 + 1] = g[i * 3 + 1] - my; sub[j * 3 + 2] = g[i * 3 + 2] - mz;
        mats[j++] = b.mats[i];
      }
      // the chunk's grid corner, carried through the parent's pose
      const corner = rel.set(mx * VOXEL, my * VOXEL, mz * VOXEL).sub(b.pivotLocal).applyQuaternion(b.quat).add(b.pos).clone();
      const colorOffset = b.colorOffset.clone().add(new THREE.Vector3(mx * VOXEL, my * VOXEL, mz * VOXEL));
      const f = new FallingBody(sub, mats, corner, b.quat, this.scene, b.gen + 1, colorOffset);
      // its own velocity at that point, mostly killed by the hit, plus a burst away from the middle
      const r = v.copy(f.pos).sub(b.pos);
      const pv = new THREE.Vector3().copy(b.spin).cross(r).add(b.vel).multiplyScalar(0.3);
      const out = r.clone().setY(0);
      if (out.lengthSq() < 1e-4) out.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      out.normalize().multiplyScalar((1.2 + Math.random() * 2.4) * kick);
      f.vel.set(pv.x + out.x, Math.abs(b.vel.y) * 0.15 + (1 + Math.random() * 2.5) * kick, pv.z + out.z);
      f.spin.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3).multiplyScalar(kick);
      // nudge it up off the surface it hit so it doesn't start inside it
      f.pos.y += VOXEL * 0.5;
      this.bodies.push(f);
      this.onBodyAdd?.(f);
    }
    b.dispose(this.scene);
    this.onBodyEnd?.(b);
    const cx = sx / n, cy = sy / n, cz = sz / n;
    for (let i = 0; i < 16; i++) this.particles.dust(cx + (Math.random() - 0.5) * (maxX - minX), cy, cz + (Math.random() - 0.5) * (maxZ - minZ), 0.55, 0.5, 0.42, 2.5, 2.5);
    this.ev.onBodyImpact(cx, cy, cz, n * VK3, minX, minZ, maxX, maxZ, false);
  }

  /** puts a body back into the voxel grid where it lies */
  private settle(b: FallingBody) {
    const w = this.world;
    const v = new THREE.Vector3();
    const n = b.mats.length;
    let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9;
    let debrisLeft = 110;
    let sx = 0, sy = 0, sz = 0;
    const cells: number[] = [];
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
      const x = Math.floor(v.x / VOXEL), z = Math.floor(v.z / VOXEL);
      const y = Math.max(1, Math.floor(v.y / VOXEL));
      if (!w.inBounds(x, y, z)) continue;
      cells.push(x, y, z, m);
    }
    // it stopped a hair above whatever it hit: lower the whole pile until something touches
    let drop = 3;
    for (let k = 0; k < cells.length && drop > 0; k += 4) {
      const x = cells[k], y = cells[k + 1], z = cells[k + 2];
      let free = 0;
      while (free < drop && y - free - 1 >= 0 && soft(w.get(x, y - free - 1, z))) free++;
      if (free < drop) drop = free;
    }
    for (let k = 0; k < cells.length; k += 4) {
      const x = cells[k], y = cells[k + 1] - drop, z = cells[k + 2], m = cells[k + 3];
      for (let j = 0; j < 6; j++) {
        if (y + j < WY && soft(w.get(x, y + j, z))) {
          w.set(x, y + j, z, m);
          // rubble that ends up hanging off an edge drops again
          this.structure.landed(x, y + j, z);
          break;
        }
      }
    }
    b.dispose(this.scene);
    this.onBodyEnd?.(b);
    const cx = sx / n, cy = sy / n, cz = sz / n;
    for (let i = 0; i < 10; i++) this.particles.dust(cx + (Math.random() - 0.5) * (maxX - minX), cy, cz + (Math.random() - 0.5) * (maxZ - minZ), 0.55, 0.5, 0.42, 2, 2);
    this.ev.onBodyImpact(cx, cy, cz, n * VK3, minX, minZ, maxX, maxZ, b.isTree);
  }

  update(dt: number) {
    this.clock += dt;
    if (this.puppet) return;
    for (const { res, box } of this.structure.update(dt)) for (const sb of res.bodies) this.release(sb, box);
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      if (b.update(dt, this.world)) {
        this.bodies.splice(i, 1);
        this.impact(b);
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
    return this.bodies.length + this.puppets.size;
  }

  /** pieces in flight right now (the host streams their poses) */
  get flying(): readonly FallingBody[] {
    return this.bodies;
  }

  // ------------------------------------------------------------------ online peer side
  /** a piece the host set falling: drawn here, posed from the host's stream */
  addPuppet(nid: number, grid: Int16Array, mats: Uint8Array, gen: number, colorOffset: THREE.Vector3, pos: THREE.Vector3, quat: THREE.Quaternion) {
    this.dropPuppet(nid);
    const b = new FallingBody(grid, mats, new THREE.Vector3(), quat, this.scene, gen, colorOffset);
    b.nid = nid;
    b.pos.copy(pos);
    b.quat.copy(quat);
    b.syncMesh();
    this.puppets.set(nid, b);
    return b;
  }

  dropPuppet(nid: number) {
    const b = this.puppets.get(nid);
    if (!b) return;
    b.dispose(this.scene);
    this.puppets.delete(nid);
  }

  /** a blast the host reported: voxels it knocks out in the next moments fly away from it */
  noteBlast(x: number, y: number, z: number, r: number) {
    this.blasts.push({ x, y, z, r, t: this.clock });
    if (this.blasts.length > 12) this.blasts.shift();
  }

  /** applies the host's voxel edits; broken voxels throw a little debris */
  applyRemote(idx: Uint32Array, mats: Uint8Array, fx: boolean) {
    const w = this.world;
    const vox = w.vox;
    let budget = fx ? 70 : 0;
    const now = this.clock;
    this.blasts = this.blasts.filter((b) => now - b.t < 0.8);
    for (let k = 0; k < idx.length; k++) {
      const raw = idx[k];
      const quiet = raw >= 0x80000000;
      const i = raw & 0x7fffffff;
      const m = mats[k];
      const old = vox[i];
      const y = i % WY, t = (i / WY) | 0, z = t % WZ, x = (t / WZ) | 0;
      w.set(x, y, z, m);
      if (quiet || m !== 0 || old === 0 || budget <= 0 || !MATS[old]) continue;
      const px = (x + 0.5) * VOXEL, py = (y + 0.5) * VOXEL, pz = (z + 0.5) * VOXEL;
      let vx = (Math.random() - 0.5) * 3, vy = 2 + Math.random() * 3, vz = (Math.random() - 0.5) * 3;
      let blast = false;
      for (const b of this.blasts) {
        const dx = px - b.x, dy = py - b.y + 0.5, dz = pz - b.z;
        const l = Math.hypot(dx, dy, dz);
        if (l > b.r + 1.2) continue;
        const sp = (6 + Math.random() * 9) / (l + 0.1);
        vx = dx * sp;
        vy = dy * sp + 4;
        vz = dz * sp;
        blast = true;
        break;
      }
      if (!blast && Math.random() < 0.5) continue;
      budget--;
      const leafy = MATS[old].kind === 'leaf';
      this.debris.spawn(px, py, pz, vx, vy, vz, DEB * (blast ? 0.5 + Math.random() * 0.45 : leafy ? 0.3 : 0.45), linearColor(old, this.tmpC), blast ? 5 : leafy ? 3 : 4, leafy);
    }
  }
}
