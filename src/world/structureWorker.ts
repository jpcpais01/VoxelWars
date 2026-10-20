/// <reference lib="webworker" />
// Structural checks off the main thread: one box of voxels in, the pieces that give way out.
import { solveStructure, type StructJob, type StructResult } from './structure';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<StructJob>) => {
  const out: StructResult = solveStructure(e.data);
  const transfer: Transferable[] = [];
  for (const b of out.bodies) transfer.push(b.idx.buffer, b.mats.buffer);
  ctx.postMessage(out, transfer);
};
