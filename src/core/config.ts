// World dimensions are in voxels. One voxel is VOXEL metres.
export const VOXEL = 0.4;
export const WX = 384;
export const WY = 64;
export const WZ = 384;
export const CHUNK = 32;
export const CX = WX / CHUNK;
export const CZ = WZ / CHUNK;

export const MAP_W = WX * VOXEL; // 153.6 m
export const MAP_D = WZ * VOXEL;

// Water surface height (metres). Columns whose floor is below this are wet.
export const WATER_Y = 4.3;

export const GRAVITY = 24;

// Characters
export const SOLDIER_RADIUS = 0.32;
export const SOLDIER_HEIGHT = 1.75;
export const EYE_HEIGHT = 1.5;
export const CHEST_HEIGHT = 1.2;
export const STEP_HEIGHT = 0.45;
export const CLEARANCE_VOX = 5; // voxels of headroom needed to stand

export const TEAM_BLUE = 0;
export const TEAM_RED = 1;
export type Team = 0 | 1;

export const TEAM_COLORS = ['#3d8bff', '#ff4d3d'] as const;
export const TEAM_NAMES = ['BLUE', 'RED'] as const;

export const CORE_HP = 2600;
export const RESPAWN_TIME = 6;
export const MATCH_TIME = 15 * 60;
