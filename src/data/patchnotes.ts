// Player-facing patch notes. One group per hour (UTC), newest first, at most 5 entries per group.
export interface PatchGroup {
  hour: string;
  title: string;
  entries: string[];
}

export const PATCH_NOTES: PatchGroup[] = [
  {
    hour: '2026-10-20 · 17:00 UTC',
    title: 'Next Level: Light, Water and Glory',
    entries: [
      'New sky lighting: the whole valley now bakes how much open sky every spot can see, so forest floors sit in soft shade under the canopy, bunker interiors go dim, and cliffs and walls shade what is next to them. Soldiers pick it up too, plus a gentle rim light so they stand out from the ground.',
      'The river flows: waves now ride the current, the lake swirls slowly around the island, white rapids streak through fast shallow water, and mist drifts low over the valley. Pick Morning, Golden hour (long shadows, warm light) or Overcast before each match.',
      'Big performance upgrade: world geometry is 2.4x lighter, meshing after explosions runs on background threads so destruction no longer hitches, shaders skip hidden pixels everywhere outside the x-ray cutout, and shadows adapt under heavy load. The camera also pulls back a little to show more of the battlefield.',
      'Every play now scores: eliminations, headshots, assists, multi-kills (double, triple, rampage), kill streaks, ending streaks and core damage all pop up as you earn them, with floating damage numbers on every hit. Choose Recruit, Regular or Veteran bots and a 10, 15 or 20 minute match. Bots are also toned down on every difficulty: they take longer to react when they spot you, turn and track slower, miss more and fire in shorter, looser bursts.',
      'Redesigned menus: a match setup panel, your service record across matches, loading-screen tips, and a new end screen with your match stats, the MVP and awards like Top gun, Sharpshooter, Siege breaker and Demolitionist. Plus a brand new app icon: a floating chunk of Pinewater Valley with its pine, a waterfall spilling off the edge, the glowing enemy core and a freshly blasted corner, crisp on every home screen, tab and dock. Fixed: opening Settings or Loadout from the pause menu no longer leaves the pause screen in the way, and it comes back when you close them.',
    ],
  },
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
