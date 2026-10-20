// World dimensions are in voxels. One voxel is VOXEL metres.
export const VOXEL = 0.2;
export const WX = 768;
export const WY = 128;
export const WZ = 768;
/** chunks stay 12.8 m wide: 64 voxels across, the full world height tall */
export const CHUNK = 64;
export const CX = WX / CHUNK;
export const CZ = WZ / CHUNK;

export const MAP_W = WX * VOXEL; // 153.6 m
export const MAP_D = WZ * VOXEL;
/** water flow field texels per side (0.8 m each) */
export const FLOW_RES = Math.round(MAP_W / 0.8);

// Water surface height (metres). Columns whose floor is below this are wet.
export const WATER_Y = 4.3;

export const GRAVITY = 24;

// Characters
export const SOLDIER_RADIUS = 0.32;
export const SOLDIER_HEIGHT = 1.75;
export const EYE_HEIGHT = 1.5;
export const CHEST_HEIGHT = 1.2;
export const STEP_HEIGHT = 0.45;
export const CLEARANCE_VOX = 10; // voxels of headroom needed to stand (2 m)

export const TEAM_BLUE = 0;
export const TEAM_RED = 1;
export type Team = 0 | 1;

export const TEAM_COLORS = ['#3d8bff', '#ff4d3d'] as const;
export const TEAM_NAMES = ['BLUE', 'RED'] as const;

export const CORE_HP = 2600;
export const RESPAWN_TIME = 6;
export const MATCH_TIME = 15 * 60;
