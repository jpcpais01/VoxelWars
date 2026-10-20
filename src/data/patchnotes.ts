// Player-facing patch notes. One group per hour (UTC), newest first, at most 5 entries per group.
export interface PatchGroup {
  hour: string;
  title: string;
  entries: string[];
}

export const PATCH_NOTES: PatchGroup[] = [
  {
    hour: '2026-10-20 · 20:00 UTC',
    title: 'Full Screen',
    entries: [
      'New fullscreen button in the top-right corner of the menus and the pause screen; on phones it also turns the game sideways. Fixed: after a refused mouse capture (most often resuming right after Esc), looking around no longer stops at the edge of the screen, which was easiest to hit in F11 fullscreen. The game now shows Click to aim and captures the mouse on your next click.',
      'Brand new app icon: a voxel soldier in a combat helmet and orange goggles, standing in front of a setting voxel sun. It stays bold and readable from your home screen down to a tiny browser tab. Already installed the app? The new icon shows up once your device refreshes it.',
    ],
  },
  {
    hour: '2026-10-20 · 19:00 UTC',
    title: 'Twice as Fine',
    entries: [
      'The whole world is now built from voxels half the size: 20 cm blocks instead of 40 cm, eight times as many in the same valley. Hills roll in gentle steps, riverbanks slope into sand and mud, rock outcrops show layered strata, and both halves of the map are now an exact mirror of each other, lake shoreline included.',
      'Every building is rebuilt at the new detail. The HQ bunkers have panel joints, a blast door, firing slits, roof vents, an antenna and dish, lamps at the entrance, staggered sandbag walls, steel hedgehogs, a braced watchtower with a ladder and a supply depot under a camo net. The cabins get log walls, a fireplace, furniture, a porch, a fenced yard, hay bales and a well, and the ruins, island tower, bridges and docks are all new too.',
      'A new forest: tapered pines, broad oaks with branching limbs, birches with dark bark marks, berry bushes, ferns that sway in the wind, fallen logs, stumps, mossy boulders and pebbles.',
      'Smooth at any distance: the world now draws in three levels of detail, full detail around you and lighter versions further away, so the finer world runs about as fast as the old one. Settings quality also sets how far full detail reaches.',
      'Destruction at the new scale: bullets chip 20 cm blocks and crack the ones around them, explosions carve smoother craters, and trees only hold each other up through their trunks now, so a tree you cut down topples even when its crown touches a neighbour and takes just its own leaves with it. Fixed: Thunder RPG rockets no longer burst a step out of the tube and hurt you; they fly until they hit something.',
    ],
  },
  {
    hour: '2026-10-20 · 18:00 UTC',
    title: 'Through Your Own Eyes',
    entries: [
      'VoxelWars is now first person. Click the game to capture the mouse and look around freely; WASD moves relative to where you face. Settings has new Look sensitivity and Field of view sliders. On phones, the left thumb moves, a drag on the right looks, and a gentle aim assist slows and nudges your view onto nearby enemies.',
      'Every weapon is rebuilt from 1 cm voxels: receivers with ejection ports and rails, curved mags, wood stocks, a fluted sniper barrel, a spinning six-barrel Buzzsaw, a revolving Thumper drum and a Thunder RPG with its warhead peeking out. Every attachment shows on the gun, and bots carry the same models.',
      'Your gun lives in your hands now: gloved hands and team-coloured sleeves, walk bob, look sway, recoil that kicks the view, reloads that drop and swap the magazine, pump and bolt cycling, and a real muzzle flash. Aim down iron sights, red dots and holo reticles; 3x, 8x and thermal optics zoom in behind a proper scope.',
      'The valley at eye level: a new sky with a sun disc and drifting clouds that match the cloud shadows on the ground, haze that melts into the horizon, sharp shadows that follow your view, soft blur only in the far distance, grass that fades out gently, and a murky tint under the river.',
      'Combat follows the crosshair: shots leave from your eye along your aim with a true round spread, grenades fly along your view, hit indicators and sound panning follow where you face, the minimap shows your view cone, and when you go down the camera rises to watch whoever got you.',
    ],
  },
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
