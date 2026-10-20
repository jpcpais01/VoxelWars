// Player-facing patch notes. One group per hour (UTC), newest first, at most 5 entries per group.
export interface PatchGroup {
  hour: string;
  title: string;
  entries: string[];
}

export const PATCH_NOTES: PatchGroup[] = [
  {
    hour: '2026-10-20 · 21:00 UTC',
    title: 'Things Fall Down',
    entries: [
      'Real structural collapse. Buildings, towers, rocks and trees no longer need to be cut loose completely to fall: every piece now has to carry its own weight on whatever is left under it. Blow out most of a tower\'s base and the whole top comes down; take out one side and it leans over and topples that way; notch a trunk and the tree falls toward the notch; shoot away the posts under a balcony, a bridge deck or a branch and it snaps off at the root. Stone is strong under weight but cracks when pulled, wood bends and holds, and heavier pieces need more left under them.',
      'Falling pieces move like one solid chunk: they pivot over the last edge holding them, tear free, tumble, smash through foliage and smash into whatever they land on, then burst into big chunks and rubble that roll on and settle into a heap. All the checking happens in the background near the damage, so it costs nothing while you fight. Also fixed a few trees that grew on top of other trees\' crowns, boulders and fallen logs that hovered over slopes, and gappy branches that held their leaves by a corner.',
    ],
  },
  {
    hour: '2026-10-20 · 20:00 UTC',
    title: 'Bigger Blasts, Better Sound, Finer Guns',
    entries: [
      'All-new sound, guns first. Every weapon has its own layered voice: the supersonic crack, the muzzle blast, the punch you feel in your chest and its own action clacking, from the snappy Hornet SMG to the booming Longbow, the hollow thoonk of the Thumper and the roar of an RPG launch. Suppressors turn shots into a muffled pfft where you hear the bolt cycle, and a muzzle brake really barks. Sound now comes from where it happens: it moves around you as you turn, gets darker, wetter and later the further away it is (it travels at the real speed of sound, so a distant fight rumbles in after the flash), echoes back off the valley and sounds muffled behind walls. Enemy bullets snap and whiz past your head, rockets roar past with a doppler sweep and the Buzzsaw motor whines up before it fires.',
      'Every detail has a sound. Magazines click out and seat home, bolts and pumps cycle between shots, casings tinkle onto the ground, the Magnum dumps its brass, the LMG belt rattles, shotgun shells go in one at a time, and a reload goes quiet if you swap away. Footsteps change with the ground (grass, dirt, gravel, sand, stone, wood, metal and water) and your gear jingles when you run. Explosions crack, boom and roll like thunder while debris rains down, and one right next to you dulls your hearing and leaves your ears ringing. The forest is alive with a babbling river, gusts through the leaves, crickets and eight kinds of birds that fall silent and scatter when the shooting starts. Plus new hit, headshot and kill sounds, a heartbeat when you are badly hurt, and fresh menu, armoury and victory sounds.',
      'Bigger, better blasts: a white-hot flash, a fireball that bursts outward and burns down to embers, a hot shock ring, streaking sparks and a ring of dust thrown off the ground, with much less smoke hanging around afterwards. Craters are no longer perfect balls either: every blast tears a lumpy, irregular hole, blasts on the ground dig wide shallow bowls, wood and leaves give way further than stone and steel, and loose bits crumble off the rim.',
      'Every weapon is rebuilt from voxels half the size (5 mm): crisper receivers, stippled grips, slotted rails, birdcage flash hiders, knurled suppressors, a fluted revolver cylinder with brass case heads and finer attachments all round. Iron sights are now a thin ghost ring with a slim front post and a glowing tritium tip right on your aim point (a fibre-optic bead on the Breacher, a notch and orange blade on the Magnum). Red dot and holo reticles are razor sharp at any resolution and stay pinned to where the gun points, and anything behind the rear sight no longer clutters the view while aiming.',
      'New fullscreen button in the top-right corner of the menus and the pause screen; on phones it also turns the game sideways. Fixed: after a refused mouse capture (most often resuming right after Esc), looking around no longer stops at the edge of the screen, which was easiest to hit in F11 fullscreen. The game now shows Click to aim and captures the mouse on your next click. Plus a brand new app icon: a real in-game shot of Pinewater Valley, with the ruined island tower rising from the lake among the trees in the morning light. It stays bold and readable from your home screen down to a tiny browser tab. Already installed the app? The new icon shows up once your device refreshes it.',
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
