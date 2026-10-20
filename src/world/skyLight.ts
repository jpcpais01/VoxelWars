import { WX, WY, WZ } from '../core/config';

/**
 * Large-scale sky visibility ("heightfield GI"): a coarse 3D grid (one cell per 2x2x2 voxels)
 * storing how much open sky each point of the world sees. Built from the column heightfield with
 * horizon-based occlusion in 8 directions plus an overhead cover term, so canopies, roofs, cliffs
 * and bunker interiors all darken the ambient light that reaches them. One trilinear texture fetch
 * per fragment replaces what would otherwise need screen-space AO.
 */
export const SKY_W = WX >> 1;
export const SKY_H = WY >> 1;
export const SKY_D = WZ >> 1;

const DIRS: [number, number][] = [];
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  DIRS.push([Math.cos(a), Math.sin(a)]);
}
const STEPS = [1, 2, 3, 5, 7, 10];

/** Column tops (highest solid + 1, in voxels) downsampled to the coarse grid: max and mean. */
function coarseTops(top: Uint8Array) {
  const hmax = new Float32Array(SKY_W * SKY_D);
  const hmean = new Float32Array(SKY_W * SKY_D);
  for (let i = 0; i < SKY_W; i++)
    for (let j = 0; j < SKY_D; j++) {
      const x = i * 2, z = j * 2;
      const a = top[x * WZ + z], b = top[(x + 1) * WZ + z], c = top[x * WZ + z + 1], d = top[(x + 1) * WZ + z + 1];
      hmax[i * SKY_D + j] = Math.max(a, b, c, d);
      hmean[i * SKY_D + j] = (a + b + c + d) * 0.25;
    }
  return { hmax, hmean };
}

/**
 * Fills `out` (layout x + z * SKY_W + y * SKY_W * SKY_D, values 0..255) for coarse columns in
 * [i0, i1) x [j0, j1). Pass the full range for the initial build.
 */
export function computeSky(top: Uint8Array, out: Uint8Array, i0 = 0, i1 = SKY_W, j0 = 0, j1 = SKY_D) {
  const { hmax, hmean } = coarseTops(top);
  const neigh = new Float32Array(DIRS.length * STEPS.length);
  const dist = new Float32Array(STEPS.length);
  for (let k = 0; k < STEPS.length; k++) dist[k] = STEPS[k] * 2; // in voxels
  const layer = SKY_W * SKY_D;
  for (let i = i0; i < i1; i++) {
    for (let j = j0; j < j1; j++) {
      // gather horizon heights once per column
      let hiAround = 0;
      for (let d = 0; d < DIRS.length; d++) {
        const [dx, dz] = DIRS[d];
        for (let k = 0; k < STEPS.length; k++) {
          const ni = Math.round(i + dx * STEPS[k]);
          const nj = Math.round(j + dz * STEPS[k]);
          // off-map: the border hills continue the edge column
          const ci = ni < 0 ? 0 : ni >= SKY_W ? SKY_W - 1 : ni;
          const cj = nj < 0 ? 0 : nj >= SKY_D ? SKY_D - 1 : nj;
          const h = hmax[ci * SKY_D + cj];
          neigh[d * STEPS.length + k] = h;
          if (h > hiAround) hiAround = h;
        }
      }
      const selfMean = hmean[i * SKY_D + j];
      const selfMax = hmax[i * SKY_D + j];
      for (let cy = 0; cy < SKY_H; cy++) {
        const y = cy * 2 + 1; // cell centre in voxels
        let vis = 1;
        if (y < hiAround || y < selfMax) {
          let occ = 0;
          for (let d = 0; d < DIRS.length; d++) {
            let best = 0;
            for (let k = 0; k < STEPS.length; k++) {
              const s = (neigh[d * STEPS.length + k] - y) / dist[k];
              if (s > best) best = s;
            }
            occ += best / Math.sqrt(1 + best * best); // sine of the horizon angle
          }
          vis = 1 - (occ / DIRS.length) * 0.9;
          // overhead cover (canopy, roof, bridge): strongest when close above
          const above = selfMean - y;
          if (above > 0.5) {
            const cover = Math.min(1, above / 2) * (0.55 + 0.45 * Math.exp(-above / 30));
            vis *= 1 - 0.62 * cover;
          }
        }
        out[i + j * SKY_W + cy * layer] = Math.max(0, Math.min(255, Math.round(vis * 255)));
      }
    }
  }
}
