// Player-facing patch notes. One group per hour (UTC), newest first, at most 5 entries per group.
export interface PatchGroup {
  hour: string;
  title: string;
  entries: string[];
}

export const PATCH_NOTES: PatchGroup[] = [
  {
    hour: '2026-10-20 · 16:00 UTC',
    title: 'Opening Day: Pinewater Valley',
    entries: [
      'VoxelWars is here: a 5v5 fight across Pinewater Valley, a hand-shaped forest with a winding river, a lake island tower, cabins, ruins and two fortified bases. Destroy the enemy core to win.',
      'Almost everything is destructible. Shoot out a trunk and the tree topples, blow the walls out from under a roof and it collapses, and fuel barrels chain-react.',
      '10 weapons with zero preset classes: carbine, SMG, LMG, shotgun, sniper, DMR, revolver, rocket launcher, grenade launcher and a spin-up rotary cannon. Each one has its own attachment slots (optics, muzzles, barrels, mags, grips, stocks, ammo), plus a choice of frag, smoke, demo charge or medkit.',
      'Squad bots that pick lanes, regroup before river crossings, take cover, peek, flush you out with grenades, guard their core and lay siege to yours.',
      'A new rendering engine: volumetric river water with refraction, reflections, caustics and foam, soft sun shadows through swaying canopies, ambient occlusion on every voxel, a miniature tilt-shift lens and dynamic resolution to keep things smooth.',
    ],
  },
];
