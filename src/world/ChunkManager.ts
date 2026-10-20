import * as THREE from 'three';
import { CHUNK, CX, CZ, VOXEL, WX, WY, WZ } from '../core/config';
import { createGrassMaterial, createVoxelMaterial } from '../render/voxelMaterial';
import { greedyMesh, grassMesh } from './mesher';
import { World } from './World';

const PAD = CHUNK + 2;
const PY = WY + 2;

export class ChunkManager {
  readonly group = new THREE.Group();
  readonly material = createVoxelMaterial();
  readonly grassMaterial = createGrassMaterial();
  private meshes: (THREE.Mesh | null)[] = [];
  private grass: (THREE.Mesh | null)[] = [];
  private vol = new Uint8Array(PAD * PAD * PY);
  grassEnabled = true;
  totalVerts = 0;

  constructor(private world: World, private grassDensity: Uint8Array) {
    this.group.name = 'chunks';
    this.meshes = new Array(CX * CZ).fill(null);
    this.grass = new Array(CX * CZ).fill(null);
  }

  private fill(cx: number, cz: number) {
    const w = this.world;
    const vol = this.vol;
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

  build(cx: number, cz: number) {
    const key = cx + cz * CX;
    this.fill(cx, cz);
    // interior cell (0,0,0) of the padded volume is world voxel (cx*CHUNK, 0, cz*CHUNK)
    const md = greedyMesh(this.vol, PAD, PY, PAD, cx * CHUNK, 0, cz * CHUNK);
    let mesh = this.meshes[key];
    if (mesh) {
      this.totalVerts -= (mesh.geometry.getAttribute('position')?.count ?? 0);
      mesh.geometry.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(md.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(md.normals, 3, true));
    geo.setAttribute('aData', new THREE.BufferAttribute(md.data, 4, false));
    geo.setIndex(new THREE.BufferAttribute(md.indices, 1));
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(cx * CHUNK * VOXEL, 0, cz * CHUNK * VOXEL),
      new THREE.Vector3((cx + 1) * CHUNK * VOXEL, WY * VOXEL, (cz + 1) * CHUNK * VOXEL),
    );
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    this.totalVerts += md.vertexCount;
    if (!mesh) {
      mesh = new THREE.Mesh(geo, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = `chunk ${cx},${cz}`;
      this.meshes[key] = mesh;
      this.group.add(mesh);
    } else mesh.geometry = geo;

    // grass
    let gm = this.grass[key];
    if (gm) {
      gm.geometry.dispose();
    }
    const dens = this.grassDensity;
    const gd = grassMesh(this.vol, PAD, PY, PAD, cx * CHUNK, cz * CHUNK, (wx, wz) => {
      if (wx < 0 || wz < 0 || wx >= WX || wz >= WZ) return 0;
      return dens[wx * WZ + wz] / 255;
    });
    if (gd.vertexCount > 0) {
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.BufferAttribute(gd.positions, 3));
      gg.setAttribute('aCol', new THREE.BufferAttribute(gd.colors, 4, true));
      gg.boundingBox = geo.boundingBox.clone();
      gg.boundingSphere = geo.boundingSphere.clone();
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
    for (let cz = 0; cz < CZ; cz++) {
      for (let cx = 0; cx < CX; cx++) this.build(cx, cz);
      await progress((cz + 1) / CZ);
    }
    this.world.dirtyChunks.clear();
  }

  /** Remesh dirty chunks within a time budget (ms). */
  update(budgetMs = 4) {
    const dirty = this.world.dirtyChunks;
    if (dirty.size === 0) return;
    const t0 = performance.now();
    for (const key of dirty) {
      dirty.delete(key);
      this.build(key % CX, (key / CX) | 0);
      if (performance.now() - t0 > budgetMs) break;
    }
  }

  setGrass(on: boolean) {
    this.grassEnabled = on;
    for (const g of this.grass) if (g) g.visible = on;
  }
}
