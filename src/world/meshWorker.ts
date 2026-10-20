/// <reference lib="webworker" />
// Off-main-thread meshing and sky-light baking. The main thread copies a chunk's fine voxels
// (with a little padding), we return packed vertex streams for each requested LOD as transferables.
import { buildChunk } from './mesher';
import { computeSky, SKY_D, SKY_H, SKY_W } from './skyLight';
import { WX, WZ } from '../core/config';

export interface MeshOut {
  lod: number;
  positions: Uint8Array;
  data: Uint8Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
}

export type WorkerIn =
  | { type: 'init'; grass: Uint8Array }
  | { type: 'chunk'; job: number; key: number; ver: number; vol: Uint8Array; sx: number; sy: number; sz: number; pad: number; lods: number; grass: boolean; ox: number; oz: number }
  | { type: 'sky'; job: number; top: Uint8Array; i0: number; i1: number; j0: number; j1: number };

export type WorkerOut =
  | { type: 'chunk'; job: number; key: number; ver: number; meshes: MeshOut[]; gPos: Float32Array | null; gCol: Uint8Array | null; gCount: number }
  | { type: 'sky'; job: number; data: Uint8Array; i0: number; i1: number; j0: number; j1: number };

let grass: Uint8Array | null = null;
let skyBuf: Uint8Array | null = null;
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  if (m.type === 'init') {
    grass = m.grass;
    return;
  }
  if (m.type === 'chunk') {
    const dens = grass;
    const b = buildChunk(m.vol, m.sx, m.sy, m.sz, m.pad, m.lods, m.grass, m.ox, m.oz, (wx, wz) => {
      if (!dens || wx < 0 || wz < 0 || wx >= WX || wz >= WZ) return 0;
      return dens[wx * WZ + wz] / 255;
    });
    const meshes: MeshOut[] = b.meshes.map((x) => ({ lod: x.lod, ...x.mesh }));
    const transfer: Transferable[] = [];
    for (const x of meshes) transfer.push(x.positions.buffer, x.data.buffer, x.indices.buffer);
    if (b.grass) transfer.push(b.grass.positions.buffer, b.grass.colors.buffer);
    const out: WorkerOut = {
      type: 'chunk',
      job: m.job,
      key: m.key,
      ver: m.ver,
      meshes,
      gPos: b.grass?.positions ?? null,
      gCol: b.grass?.colors ?? null,
      gCount: b.grass?.vertexCount ?? 0,
    };
    ctx.postMessage(out, transfer);
    return;
  }
  if (m.type === 'sky') {
    if (!skyBuf) skyBuf = new Uint8Array(SKY_W * SKY_H * SKY_D);
    computeSky(m.top, skyBuf, m.i0, m.i1, m.j0, m.j1);
    // return only the rows we touched (per layer, the [i0,i1) x [j0,j1) rectangle)
    const w = m.i1 - m.i0, d = m.j1 - m.j0;
    const data = new Uint8Array(w * d * SKY_H);
    for (let y = 0; y < SKY_H; y++)
      for (let j = 0; j < d; j++) {
        const src = m.i0 + (m.j0 + j) * SKY_W + y * SKY_W * SKY_D;
        data.set(skyBuf.subarray(src, src + w), (y * d + j) * w);
      }
    const out: WorkerOut = { type: 'sky', job: m.job, data, i0: m.i0, i1: m.i1, j0: m.j0, j1: m.j1 };
    ctx.postMessage(out, [data.buffer]);
  }
};
