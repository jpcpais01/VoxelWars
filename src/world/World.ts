import { CHUNK, CLEARANCE_VOX, CX, VOXEL, WX, WY, WZ } from '../core/config';
import { M, MATS } from './materials';

export interface RayHit {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  dist: number;
  px: number;
  py: number;
  pz: number;
  mat: number;
}

export const newHit = (): RayHit => ({ x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, dist: 0, px: 0, py: 0, pz: 0, mat: 0 });

/**
 * Dense voxel grid. Column-major layout: index = (x * WZ + z) * WY + y so a vertical
 * column is contiguous, which makes floor scans and meshing copies cache friendly.
 */
export class World {
  readonly vox = new Uint8Array(WX * WY * WZ);
  readonly damage = new Map<number, number>();
  /** Standable floor height (in voxels) per column: lowest gap with enough headroom. */
  readonly floor = new Uint8Array(WX * WZ);
  /** Highest solid voxel + 1 per column. */
  readonly top = new Uint8Array(WX * WZ);
  /** Natural terrain height per column as generated: voxels below it are held by the ground. */
  readonly ground = new Uint8Array(WX * WZ);
  readonly dirtyChunks = new Set<number>();
  readonly changedColumns = new Set<number>();
  version = 0;
  /** every runtime edit is reported here (the online host relays them to its peers) */
  onEdit: ((i: number, m: number, quiet: boolean) => void) | null = null;
  /** edits made while this is set move voxels rather than break them (no debris on the far side) */
  quiet = false;

  idx(x: number, y: number, z: number) {
    return (x * WZ + z) * WY + y;
  }

  inBounds(x: number, y: number, z: number) {
    return x >= 0 && y >= 0 && z >= 0 && x < WX && y < WY && z < WZ;
  }

  get(x: number, y: number, z: number): number {
    if (y < 0) return M.BEDROCK;
    if (y >= WY) return M.AIR;
    if (x < 0 || z < 0 || x >= WX || z >= WZ) return M.CLIFF;
    return this.vox[(x * WZ + z) * WY + y];
  }

  /** Raw write used by the generator (no bookkeeping). */
  put(x: number, y: number, z: number, m: number) {
    if (x < 0 || y < 0 || z < 0 || x >= WX || y >= WY || z >= WZ) return;
    this.vox[(x * WZ + z) * WY + y] = m;
  }

  /** Runtime write: keeps chunk meshes, floors and listeners in sync. */
  set(x: number, y: number, z: number, m: number) {
    if (x < 0 || y < 0 || z < 0 || x >= WX || y >= WY || z >= WZ) return;
    const i = (x * WZ + z) * WY + y;
    if (this.vox[i] === m) return;
    this.vox[i] = m;
    this.damage.delete(i);
    if (this.onEdit) this.onEdit(i, m, this.quiet);
    this.markDirty(x, z);
    this.changedColumns.add(x * WZ + z);
  }

  markDirty(x: number, z: number) {
    const cx = (x / CHUNK) | 0;
    const cz = (z / CHUNK) | 0;
    const lx = x - cx * CHUNK;
    const lz = z - cz * CHUNK;
    this.dirtyChunks.add(cx + cz * CX);
    const ex = lx === 0 ? -1 : lx === CHUNK - 1 ? 1 : 0;
    const ez = lz === 0 ? -1 : lz === CHUNK - 1 ? 1 : 0;
    if (ex) this.addChunk(cx + ex, cz);
    if (ez) this.addChunk(cx, cz + ez);
    if (ex && ez) this.addChunk(cx + ex, cz + ez);
  }

  private addChunk(cx: number, cz: number) {
    if (cx < 0 || cz < 0 || cx >= CX || cz >= WZ / CHUNK) return;
    this.dirtyChunks.add(cx + cz * CX);
  }

  /** Recomputes floor/top for columns touched since the last call; returns them. */
  flushColumns(): number[] {
    if (this.changedColumns.size === 0) return [];
    const cols = [...this.changedColumns];
    this.changedColumns.clear();
    for (const c of cols) this.computeColumn((c / WZ) | 0, c % WZ);
    this.version++;
    return cols;
  }

  computeColumn(x: number, z: number) {
    const base = (x * WZ + z) * WY;
    const v = this.vox;
    let top = 0;
    for (let y = WY - 1; y >= 0; y--) {
      if (v[base + y] !== 0) {
        top = y + 1;
        break;
      }
    }
    let floor = top;
    for (let y = 1; y < top; y++) {
      if (v[base + y - 1] !== 0 && v[base + y] === 0) {
        let r = 0;
        while (y + r < WY && v[base + y + r] === 0 && r < CLEARANCE_VOX) r++;
        if (r >= CLEARANCE_VOX || y + r >= WY) {
          floor = y;
          break;
        }
      }
    }
    this.top[x * WZ + z] = top;
    this.floor[x * WZ + z] = floor;
  }

  computeAllColumns() {
    for (let x = 0; x < WX; x++) for (let z = 0; z < WZ; z++) this.computeColumn(x, z);
  }

  /** Floor height in metres at world position. */
  floorAt(px: number, pz: number): number {
    const x = Math.floor(px / VOXEL);
    const z = Math.floor(pz / VOXEL);
    if (x < 0 || z < 0 || x >= WX || z >= WZ) return 0;
    return this.floor[x * WZ + z] * VOXEL;
  }

  /** Highest ground under a point that is at or below `py` (metres). */
  groundBelow(px: number, py: number, pz: number): number {
    const x = Math.floor(px / VOXEL);
    const z = Math.floor(pz / VOXEL);
    if (x < 0 || z < 0 || x >= WX || z >= WZ) return 0;
    let y = Math.min(WY - 1, Math.floor(py / VOXEL));
    const base = (x * WZ + z) * WY;
    for (; y >= 0; y--) if (this.vox[base + y] !== 0) return (y + 1) * VOXEL;
    return 0;
  }

  solidAt(px: number, py: number, pz: number): boolean {
    return this.get(Math.floor(px / VOXEL), Math.floor(py / VOXEL), Math.floor(pz / VOXEL)) !== 0;
  }

  boxSolid(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
    const x0 = Math.floor(minX / VOXEL), x1 = Math.floor((maxX - 1e-4) / VOXEL);
    const y0 = Math.floor(minY / VOXEL), y1 = Math.floor((maxY - 1e-4) / VOXEL);
    const z0 = Math.floor(minZ / VOXEL), z1 = Math.floor((maxZ - 1e-4) / VOXEL);
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++)
        for (let y = y0; y <= y1; y++) if (this.get(x, y, z) !== 0) return true;
    return false;
  }

  /** Highest solid top inside a box footprint between minY and maxY (metres), or -1. */
  boxTop(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
    const x0 = Math.floor(minX / VOXEL), x1 = Math.floor((maxX - 1e-4) / VOXEL);
    const y0 = Math.floor(minY / VOXEL), y1 = Math.floor((maxY - 1e-4) / VOXEL);
    const z0 = Math.floor(minZ / VOXEL), z1 = Math.floor((maxZ - 1e-4) / VOXEL);
    let best = -1;
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++)
        for (let y = y1; y >= y0; y--)
          if (this.get(x, y, z) !== 0) {
            if (y > best) best = y;
            break;
          }
    return best < 0 ? -1 : (best + 1) * VOXEL;
  }

  /**
   * Amanatides-Woo voxel traversal. Direction must be normalised. Coordinates in metres.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, out: RayHit): boolean {
    const inv = 1 / VOXEL;
    let x = Math.floor(ox * inv);
    let y = Math.floor(oy * inv);
    let z = Math.floor(oz * inv);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tDX = dx !== 0 ? Math.abs(VOXEL / dx) : Infinity;
    const tDY = dy !== 0 ? Math.abs(VOXEL / dy) : Infinity;
    const tDZ = dz !== 0 ? Math.abs(VOXEL / dz) : Infinity;
    let tMX = dx !== 0 ? ((dx > 0 ? (x + 1) * VOXEL - ox : ox - x * VOXEL) / Math.abs(dx)) : Infinity;
    let tMY = dy !== 0 ? ((dy > 0 ? (y + 1) * VOXEL - oy : oy - y * VOXEL) / Math.abs(dy)) : Infinity;
    let tMZ = dz !== 0 ? ((dz > 0 ? (z + 1) * VOXEL - oz : oz - z * VOXEL) / Math.abs(dz)) : Infinity;
    let nx = 0, ny = 0, nz = 0;
    let t = 0;
    const vox = this.vox;
    for (let i = 0; i < 4096; i++) {
      if (y >= WY && dy >= 0) return false;
      if (x >= 0 && z >= 0 && x < WX && z < WZ && y < WY) {
        const m = y < 0 ? M.BEDROCK : vox[(x * WZ + z) * WY + y];
        if (m !== 0) {
          out.x = x; out.y = y; out.z = z;
          out.nx = nx; out.ny = ny; out.nz = nz;
          out.dist = t;
          out.px = ox + dx * t; out.py = oy + dy * t; out.pz = oz + dz * t;
          out.mat = m;
          return true;
        }
      } else if ((x < -1 && dx <= 0) || (z < -1 && dz <= 0) || (x > WX && dx >= 0) || (z > WZ && dz >= 0)) return false;
      if (tMX < tMY) {
        if (tMX < tMZ) { t = tMX; x += stepX; tMX += tDX; nx = -stepX; ny = 0; nz = 0; }
        else { t = tMZ; z += stepZ; tMZ += tDZ; nx = 0; ny = 0; nz = -stepZ; }
      } else {
        if (tMY < tMZ) { t = tMY; y += stepY; tMY += tDY; nx = 0; ny = -stepY; nz = 0; }
        else { t = tMZ; z += stepZ; tMZ += tDZ; nx = 0; ny = 0; nz = -stepZ; }
      }
      if (t > maxDist) return false;
    }
    return false;
  }

  /** True when the straight segment a→b is unobstructed by voxels. */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number, hit = scratchHit): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-4) return true;
    return !this.raycast(ax, ay, az, dx / d, dy / d, dz / d, d - 0.05, hit);
  }

  hpOf(m: number) {
    return MATS[m]?.hp ?? 1;
  }
}

const scratchHit = newHit();
