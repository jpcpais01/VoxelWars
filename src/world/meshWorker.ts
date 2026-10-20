/// <reference lib="webworker" />
// Off-main-thread meshing and sky-light baking. The main thread copies a padded chunk volume
// (about 75 KB), we return the packed vertex streams as transferables.
import { greedyMesh, grassMesh } from './mesher';
import { computeSky, SKY_D, SKY_H, SKY_W } from './skyLight';
import { WX, WZ } from '../core/config';

export type WorkerIn =
  | { type: 'init'; grass: Uint8Array }
  | { type: 'chunk'; job: number; key: number; vol: Uint8Array; sx: number; sy: number; sz: number; ox: number; oz: number }
  | { type: 'sky'; job: number; top: Uint8Array; i0: number; i1: number; j0: number; j1: number };

export type WorkerOut =
  | { type: 'chunk'; job: number; key: number; positions: Uint8Array; data: Uint8Array; indices: Uint16Array | Uint32Array; vertexCount: number; gPos: Float32Array; gCol: Uint8Array; gCount: number }
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
    const md = greedyMesh(m.vol, m.sx, m.sy, m.sz);
    const dens = grass;
    const gd = grassMesh(m.vol, m.sx, m.sy, m.sz, m.ox, m.oz, (wx, wz) => {
      if (!dens || wx < 0 || wz < 0 || wx >= WX || wz >= WZ) return 0;
      return dens[wx * WZ + wz] / 255;
    });
    const out: WorkerOut = {
      type: 'chunk',
      job: m.job,
      key: m.key,
      positions: md.positions,
      data: md.data,
      indices: md.indices,
      vertexCount: md.vertexCount,
      gPos: gd.positions,
      gCol: gd.colors,
      gCount: gd.vertexCount,
    };
    ctx.postMessage(out, [md.positions.buffer, md.data.buffer, md.indices.buffer, gd.positions.buffer, gd.colors.buffer]);
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
