// Voxel material table. Colours are authored in sRGB.
// `hp` is how much structural damage a voxel absorbs before it breaks (0 = indestructible).
// `vary` is per-voxel colour jitter strength, `bevel` the edge darkening strength in the shader.

export const M = {
  AIR: 0,
  BEDROCK: 1,
  DIRT: 2,
  GRASS: 3,
  SAND: 4,
  GRAVEL: 5,
  STONE: 6,
  CLIFF: 7,
  MOSSY: 8,
  OAK_BARK: 9,
  PINE_BARK: 10,
  BIRCH_BARK: 11,
  OAK_LEAF: 12,
  PINE_LEAF: 13,
  BIRCH_LEAF: 14,
  AUTUMN_LEAF: 15,
  RED_LEAF: 16,
  PLANK: 17,
  PLANK_DARK: 18,
  ROOF_RED: 19,
  ROOF_SLATE: 20,
  BRICK: 21,
  CONCRETE: 22,
  CONCRETE_DARK: 23,
  METAL: 24,
  SANDBAG: 25,
  TEAM_BLUE: 26,
  TEAM_RED: 27,
  CRATE: 28,
  HAY: 29,
  BUSH: 30,
  PATH: 31,
  BARREL: 32,
  WHITE_TRIM: 33,
  LOG_END: 34,
  CLAY: 35,
  MUD: 36,
  FLOWER_BED: 37,
  STEEL_DARK: 38,
  GLOW_BLUE: 39,
  GLOW_RED: 40,
  CANVAS: 41,
  BOAT: 42,
} as const;

export const MAT_COUNT = 43;

export interface MatDef {
  name: string;
  color: number;
  hp: number;
  vary: number;
  bevel: number;
  kind: 'ground' | 'stone' | 'wood' | 'leaf' | 'build' | 'metal' | 'soft' | 'glow';
  explosive?: boolean;
}

const D = (name: string, color: number, hp: number, vary: number, bevel: number, kind: MatDef['kind'], explosive = false): MatDef => ({
  name,
  color,
  hp,
  vary,
  bevel,
  kind,
  explosive,
});

export const MATS: MatDef[] = [];
MATS[M.AIR] = D('air', 0x000000, 0, 0, 0, 'soft');
MATS[M.BEDROCK] = D('bedrock', 0x3b3a3c, 0, 0.08, 0.5, 'stone');
MATS[M.DIRT] = D('dirt', 0x7a5236, 4, 0.1, 0.25, 'ground');
MATS[M.GRASS] = D('grass', 0x6fae3e, 4, 0.08, 0.12, 'ground');
MATS[M.SAND] = D('sand', 0xe0c98f, 3, 0.06, 0.15, 'ground');
MATS[M.GRAVEL] = D('gravel', 0x8f8a7d, 5, 0.16, 0.3, 'ground');
MATS[M.STONE] = D('stone', 0x8e9196, 12, 0.1, 0.45, 'stone');
MATS[M.CLIFF] = D('cliff', 0x6d6a6a, 14, 0.12, 0.5, 'stone');
MATS[M.MOSSY] = D('mossy stone', 0x7d8a6c, 11, 0.12, 0.45, 'stone');
MATS[M.OAK_BARK] = D('oak bark', 0x6b4a2f, 6, 0.1, 0.35, 'wood');
MATS[M.PINE_BARK] = D('pine bark', 0x5a3a28, 6, 0.1, 0.35, 'wood');
MATS[M.BIRCH_BARK] = D('birch bark', 0xe8e2d2, 5, 0.18, 0.35, 'wood');
MATS[M.OAK_LEAF] = D('oak leaves', 0x4f9a35, 1, 0.14, 0.2, 'leaf');
MATS[M.PINE_LEAF] = D('pine needles', 0x2f6b3b, 1, 0.12, 0.2, 'leaf');
MATS[M.BIRCH_LEAF] = D('birch leaves', 0x9cc23f, 1, 0.14, 0.2, 'leaf');
MATS[M.AUTUMN_LEAF] = D('autumn leaves', 0xe8962a, 1, 0.16, 0.2, 'leaf');
MATS[M.RED_LEAF] = D('maple leaves', 0xd9482b, 1, 0.16, 0.2, 'leaf');
MATS[M.PLANK] = D('planks', 0xb88a55, 5, 0.08, 0.5, 'wood');
MATS[M.PLANK_DARK] = D('dark planks', 0x7c5534, 5, 0.08, 0.5, 'wood');
MATS[M.ROOF_RED] = D('roof tiles', 0xb5482f, 4, 0.08, 0.55, 'build');
MATS[M.ROOF_SLATE] = D('slate roof', 0x4c5a6a, 5, 0.08, 0.55, 'build');
MATS[M.BRICK] = D('brick', 0xa95a3e, 8, 0.12, 0.55, 'build');
MATS[M.CONCRETE] = D('concrete', 0xb9b7ae, 12, 0.05, 0.4, 'build');
MATS[M.CONCRETE_DARK] = D('dark concrete', 0x7f817d, 14, 0.05, 0.4, 'build');
MATS[M.METAL] = D('metal', 0x8d979e, 18, 0.04, 0.6, 'metal');
MATS[M.SANDBAG] = D('sandbags', 0xb7a678, 7, 0.1, 0.6, 'soft');
MATS[M.TEAM_BLUE] = D('blue paint', 0x2f6fe0, 10, 0.04, 0.4, 'build');
MATS[M.TEAM_RED] = D('red paint', 0xd8392b, 10, 0.04, 0.4, 'build');
MATS[M.CRATE] = D('crate', 0xa2773f, 3, 0.06, 0.7, 'wood');
MATS[M.HAY] = D('hay', 0xe2bf55, 1, 0.1, 0.3, 'soft');
MATS[M.BUSH] = D('bush', 0x3c8a35, 1, 0.14, 0.2, 'leaf');
MATS[M.PATH] = D('trail', 0x9a7a52, 4, 0.1, 0.18, 'ground');
MATS[M.BARREL] = D('fuel barrel', 0xc8322a, 2, 0.02, 0.6, 'metal', true);
MATS[M.WHITE_TRIM] = D('trim', 0xece6d8, 6, 0.03, 0.5, 'build');
MATS[M.LOG_END] = D('log', 0xc79a62, 6, 0.08, 0.4, 'wood');
MATS[M.CLAY] = D('clay', 0xa86d4a, 5, 0.08, 0.25, 'ground');
MATS[M.MUD] = D('mud', 0x5b4632, 4, 0.08, 0.15, 'ground');
MATS[M.FLOWER_BED] = D('flowers', 0x6fae3e, 2, 0.08, 0.12, 'ground');
MATS[M.STEEL_DARK] = D('dark steel', 0x3c4249, 22, 0.04, 0.6, 'metal');
MATS[M.GLOW_BLUE] = D('blue light', 0x6fd2ff, 6, 0.0, 0.2, 'glow');
MATS[M.GLOW_RED] = D('red light', 0xff8a5c, 6, 0.0, 0.2, 'glow');
MATS[M.CANVAS] = D('canvas', 0x6f7448, 2, 0.06, 0.3, 'soft');
MATS[M.BOAT] = D('boat paint', 0x2f8f8a, 4, 0.05, 0.5, 'wood');

export const isLeaf = (m: number) => MATS[m]?.kind === 'leaf';
