// Weapon & attachment definitions. Every gun is available to everyone; attachments are per slot.

export type Slot = 'optic' | 'muzzle' | 'barrel' | 'magazine' | 'underbarrel' | 'stock' | 'ammo';
export const SLOT_NAMES: Record<Slot, string> = {
  optic: 'Optic',
  muzzle: 'Muzzle',
  barrel: 'Barrel',
  magazine: 'Magazine',
  underbarrel: 'Underbarrel',
  stock: 'Stock',
  ammo: 'Ammo',
};

export interface Stats {
  damage: number;
  pellets: number;
  rpm: number;
  auto: boolean;
  mag: number;
  reserve: number;
  reload: number;
  hipSpread: number;
  adsSpread: number;
  recoil: number;
  range: number;
  velocity: number;
  gravity: number;
  struct: number;
  moveMul: number;
  adsMoveMul: number;
  adsZoom: number;
  spinUp: number;
  explosive: number; // blast radius in metres (0 = none)
  blastDamage: number;
  voxRadius: number; // voxel destruction radius in metres
  projectile: 'bullet' | 'rocket' | 'grenade';
  fuse: number; // grenade bounce fuse (0 = impact)
  suppressed: boolean;
  laser: boolean;
  thermal: boolean;
  tracer: boolean;
  loud: number;
  pierce: number;
}

export interface WeaponDef {
  id: string;
  name: string;
  category: string;
  blurb: string;
  base: Stats;
  slots: Partial<Record<Slot, string[]>>;
  model: GunShape;
  sound: { body: number; crack: number; thump: number; decay: number };
}

export interface GunShape {
  length: number; // receiver length
  barrel: number;
  bore: number;
  stock: number;
  mag: 'box' | 'drum' | 'tube' | 'cylinder' | 'belt' | 'none' | 'curved';
  color: number;
  accent: number;
  bulky?: boolean;
  tube?: boolean;
  rotary?: boolean;
}

export interface Mod {
  damage?: number;
  pellets?: number;
  rpm?: number;
  mag?: number;
  reload?: number;
  hipSpread?: number;
  adsSpread?: number;
  recoil?: number;
  range?: number;
  velocity?: number;
  struct?: number;
  moveMul?: number;
  adsMoveMul?: number;
  adsZoomAdd?: number;
  explosive?: number;
  blastDamage?: number;
  voxRadius?: number;
  set?: Partial<Stats>;
}

export interface Attachment {
  id: string;
  name: string;
  slot: Slot;
  desc: string;
  mod: Mod;
}

const S = (o: Partial<Stats> & Pick<Stats, 'damage' | 'rpm' | 'mag' | 'reload'>): Stats => ({
  pellets: 1,
  auto: true,
  reserve: 4,
  hipSpread: 0.05,
  adsSpread: 0.015,
  recoil: 0.012,
  range: 35,
  velocity: 230,
  gravity: 0,
  struct: 1,
  moveMul: 1,
  adsMoveMul: 0.62,
  adsZoom: 5,
  spinUp: 0,
  explosive: 0,
  blastDamage: 0,
  voxRadius: 0,
  projectile: 'bullet',
  fuse: 0,
  suppressed: false,
  laser: false,
  thermal: false,
  tracer: false,
  loud: 1,
  pierce: 0,
  ...o,
});

export const ATTACHMENTS: Attachment[] = [
  // optics
  { id: 'iron', name: 'Iron Sights', slot: 'optic', desc: 'Clean and simple.', mod: {} },
  { id: 'reddot', name: 'Red Dot', slot: 'optic', desc: 'Tighter aim, slightly longer look-ahead.', mod: { adsSpread: 0.85, adsZoomAdd: 2 } },
  { id: 'holo', name: 'Holo Sight', slot: 'optic', desc: 'Snappy target acquisition from the hip.', mod: { hipSpread: 0.9, adsSpread: 0.9, adsMoveMul: 1.05 } },
  { id: 'acog', name: '3× Scope', slot: 'optic', desc: 'See further when aiming. Slower while scoped.', mod: { adsSpread: 0.7, adsZoomAdd: 8, adsMoveMul: 0.85 } },
  { id: 'scope8', name: '8× Sniper Scope', slot: 'optic', desc: 'Huge look-ahead and pinpoint aim. Shows a laser line.', mod: { adsSpread: 0.45, adsZoomAdd: 18, adsMoveMul: 0.7, set: { laser: true } } },
  { id: 'thermal', name: 'Thermal Optic', slot: 'optic', desc: 'Scoped: enemies glow through foliage and smoke.', mod: { adsSpread: 0.85, adsZoomAdd: 6, adsMoveMul: 0.9, set: { thermal: true } } },
  // muzzles
  { id: 'nomuzzle', name: 'Bare Muzzle', slot: 'muzzle', desc: 'No muzzle device.', mod: {} },
  { id: 'suppressor', name: 'Suppressor', slot: 'muzzle', desc: 'Hidden from the minimap, heard only up close. Slightly less range.', mod: { damage: 0.93, range: 0.85, set: { suppressed: true, loud: 0.25 } } },
  { id: 'compensator', name: 'Compensator', slot: 'muzzle', desc: 'Strong recoil control.', mod: { recoil: 0.72, hipSpread: 1.05 } },
  { id: 'brake', name: 'Muzzle Brake', slot: 'muzzle', desc: 'Even less recoil, but very loud.', mod: { recoil: 0.62, set: { loud: 1.6 } } },
  { id: 'flashhider', name: 'Flash Hider', slot: 'muzzle', desc: 'Light recoil reduction, hides your flash.', mod: { recoil: 0.9, adsSpread: 0.95 } },
  { id: 'choke', name: 'Duckbill Choke', slot: 'muzzle', desc: 'Tighter pellet spread, longer reach.', mod: { hipSpread: 0.65, adsSpread: 0.6, range: 1.3 } },
  // barrels
  { id: 'stdbarrel', name: 'Standard Barrel', slot: 'barrel', desc: 'Factory barrel.', mod: {} },
  { id: 'short', name: 'Short Barrel', slot: 'barrel', desc: 'Faster movement and hip fire, less range.', mod: { moveMul: 1.05, hipSpread: 0.88, range: 0.8, velocity: 0.9 } },
  { id: 'long', name: 'Long Barrel', slot: 'barrel', desc: 'More range, velocity and precision. Heavier.', mod: { range: 1.3, velocity: 1.2, adsSpread: 0.85, moveMul: 0.95 } },
  { id: 'heavy', name: 'Heavy Barrel', slot: 'barrel', desc: 'Harder hits and steadier, but heavy.', mod: { damage: 1.1, recoil: 0.85, moveMul: 0.92, reload: 1.05 } },
  { id: 'rifled', name: 'Rifled Tube', slot: 'barrel', desc: 'Projectiles fly much faster.', mod: { velocity: 1.6, moveMul: 0.95 } },
  // magazines
  { id: 'stdmag', name: 'Standard Mag', slot: 'magazine', desc: 'Factory capacity.', mod: {} },
  { id: 'extmag', name: 'Extended Mag', slot: 'magazine', desc: '+50% capacity, slower reload.', mod: { mag: 1.5, reload: 1.15 } },
  { id: 'drum', name: 'Drum Mag', slot: 'magazine', desc: 'Double capacity, slow reload, heavier.', mod: { mag: 2, reload: 1.4, moveMul: 0.94 } },
  { id: 'fastmag', name: 'Fast Mag', slot: 'magazine', desc: 'Much quicker reloads, slightly smaller.', mod: { reload: 0.68, mag: 0.9 } },
  // underbarrel
  { id: 'nounder', name: 'None', slot: 'underbarrel', desc: 'Nothing under the barrel.', mod: {} },
  { id: 'vgrip', name: 'Vertical Grip', slot: 'underbarrel', desc: 'Less recoil.', mod: { recoil: 0.8 } },
  { id: 'agrip', name: 'Angled Grip', slot: 'underbarrel', desc: 'Move faster while aiming.', mod: { adsMoveMul: 1.18, recoil: 0.92 } },
  { id: 'laser', name: 'Laser Sight', slot: 'underbarrel', desc: 'Much tighter hip fire. Visible beam.', mod: { hipSpread: 0.68, set: { laser: true } } },
  { id: 'bipod', name: 'Bipod', slot: 'underbarrel', desc: 'Rock steady when aiming, slow to move.', mod: { adsSpread: 0.65, recoil: 0.7, adsMoveMul: 0.75 } },
  // stocks
  { id: 'stdstock', name: 'Standard Stock', slot: 'stock', desc: 'Balanced.', mod: {} },
  { id: 'lightstock', name: 'Light Stock', slot: 'stock', desc: 'Move faster, more kick.', mod: { moveMul: 1.06, recoil: 1.15 } },
  { id: 'heavystock', name: 'Heavy Stock', slot: 'stock', desc: 'Less kick, a bit slower.', mod: { recoil: 0.8, moveMul: 0.96 } },
  { id: 'nostock', name: 'No Stock', slot: 'stock', desc: 'Fastest handling, wild when aiming.', mod: { moveMul: 1.09, hipSpread: 0.9, adsSpread: 1.3 } },
  // ammo
  { id: 'fmj', name: 'Full Metal Jacket', slot: 'ammo', desc: 'Standard rounds.', mod: {} },
  { id: 'ap', name: 'Armor Piercing', slot: 'ammo', desc: 'Chews through walls and cover. Punches through leaves.', mod: { struct: 2.4, damage: 0.93, set: { pierce: 1 } } },
  { id: 'hp', name: 'Hollow Point', slot: 'ammo', desc: 'More damage to soldiers, barely scratches walls.', mod: { damage: 1.18, struct: 0.45, range: 0.85 } },
  { id: 'he', name: 'HE Rounds', slot: 'ammo', desc: 'Tiny blasts on impact. Fewer rounds, slower fire.', mod: { damage: 0.85, mag: 0.6, rpm: 0.85, explosive: 0.9, blastDamage: 14, voxRadius: 0.7 } },
  { id: 'tracer', name: 'Tracer Rounds', slot: 'ammo', desc: 'Bright tracers; enemies you hit are marked for your team.', mod: { set: { tracer: true } } },
  { id: 'buck', name: 'Buckshot', slot: 'ammo', desc: 'Nine pellets of pure argument.', mod: {} },
  { id: 'slug', name: 'Slug', slot: 'ammo', desc: 'One heavy slug. Long reach, huge wall damage.', mod: { pellets: 1 / 9, damage: 6.2, hipSpread: 0.25, adsSpread: 0.15, range: 2.6, struct: 4 } },
  { id: 'flechette', name: 'Flechette', slot: 'ammo', desc: 'More, thinner darts with better reach.', mod: { pellets: 14 / 9, damage: 0.68, range: 1.4, hipSpread: 0.85 } },
  { id: 'hetip', name: 'HE Warhead', slot: 'ammo', desc: 'Balanced blast.', mod: {} },
  { id: 'breach', name: 'Breaching Warhead', slot: 'ammo', desc: 'Carves enormous holes in terrain and buildings.', mod: { voxRadius: 1.7, blastDamage: 0.7, explosive: 0.85 } },
  { id: 'fragwar', name: 'Frag Warhead', slot: 'ammo', desc: 'Deadlier to soldiers, smaller craters.', mod: { blastDamage: 1.3, explosive: 1.2, voxRadius: 0.6 } },
  { id: 'impact', name: 'Impact Grenades', slot: 'ammo', desc: 'Explode on contact.', mod: {} },
  { id: 'bounce', name: 'Bouncing Grenades', slot: 'ammo', desc: 'Bounce around corners, burst after 1.2 s. Bigger blast.', mod: { blastDamage: 1.15, explosive: 1.1, set: { fuse: 1.2 } } },
];

export const ATT: Record<string, Attachment> = Object.fromEntries(ATTACHMENTS.map((a) => [a.id, a]));

export const WEAPONS: WeaponDef[] = [
  {
    id: 'ar',
    name: 'VX-4 Carbine',
    category: 'Assault Rifle',
    blurb: 'Reliable all-rounder that does a bit of everything.',
    base: S({ damage: 24, rpm: 660, mag: 30, reload: 2.0, hipSpread: 0.05, adsSpread: 0.013, recoil: 0.011, range: 36, velocity: 240, struct: 1 }),
    slots: {
      optic: ['iron', 'reddot', 'holo', 'acog', 'thermal'],
      muzzle: ['nomuzzle', 'suppressor', 'compensator', 'flashhider', 'brake'],
      barrel: ['stdbarrel', 'short', 'long', 'heavy'],
      magazine: ['stdmag', 'extmag', 'drum', 'fastmag'],
      underbarrel: ['nounder', 'vgrip', 'agrip', 'laser'],
      stock: ['stdstock', 'lightstock', 'heavystock'],
      ammo: ['fmj', 'ap', 'hp', 'tracer', 'he'],
    },
    model: { length: 0.5, barrel: 0.3, bore: 0.05, stock: 0.22, mag: 'curved', color: 0x2d3238, accent: 0x6b7a5a },
    sound: { body: 900, crack: 0.9, thump: 0.7, decay: 0.16 },
  },
  {
    id: 'smg',
    name: 'Hornet SMG',
    category: 'Submachine Gun',
    blurb: 'Blistering fire rate and speed. Lethal up close.',
    base: S({ damage: 17, rpm: 920, mag: 34, reload: 1.6, hipSpread: 0.055, adsSpread: 0.026, recoil: 0.009, range: 18, velocity: 190, struct: 0.6, moveMul: 1.08, adsMoveMul: 0.75, adsZoom: 3 }),
    slots: {
      optic: ['iron', 'reddot', 'holo'],
      muzzle: ['nomuzzle', 'suppressor', 'compensator', 'flashhider'],
      magazine: ['stdmag', 'extmag', 'drum', 'fastmag'],
      underbarrel: ['nounder', 'vgrip', 'agrip', 'laser'],
      stock: ['stdstock', 'lightstock', 'nostock'],
      ammo: ['fmj', 'hp', 'ap', 'tracer'],
    },
    model: { length: 0.36, barrel: 0.14, bore: 0.045, stock: 0.16, mag: 'box', color: 0x24282d, accent: 0xd8a83a },
    sound: { body: 1300, crack: 0.75, thump: 0.45, decay: 0.1 },
  },
  {
    id: 'lmg',
    name: 'Bulwark LMG',
    category: 'Light Machine Gun',
    blurb: 'Huge belt, suppressive fire, shreds cover.',
    base: S({ damage: 26, rpm: 620, mag: 90, reload: 4.4, hipSpread: 0.075, adsSpread: 0.02, recoil: 0.012, range: 42, velocity: 250, struct: 1.4, moveMul: 0.84, adsMoveMul: 0.5, adsZoom: 7, reserve: 2 }),
    slots: {
      optic: ['iron', 'reddot', 'holo', 'acog', 'thermal'],
      muzzle: ['nomuzzle', 'suppressor', 'compensator', 'brake'],
      barrel: ['stdbarrel', 'short', 'heavy', 'long'],
      magazine: ['stdmag', 'fastmag', 'drum'],
      underbarrel: ['bipod', 'vgrip', 'nounder'],
      ammo: ['fmj', 'ap', 'tracer', 'he'],
    },
    model: { length: 0.62, barrel: 0.4, bore: 0.06, stock: 0.24, mag: 'belt', color: 0x3a3f35, accent: 0x7d6a45, bulky: true },
    sound: { body: 750, crack: 1.0, thump: 0.9, decay: 0.2 },
  },
  {
    id: 'shotgun',
    name: 'Breacher 12',
    category: 'Shotgun',
    blurb: 'Pump-action door opener. Pellets wreck walls.',
    base: S({ damage: 14, pellets: 9, rpm: 72, auto: false, mag: 6, reload: 2.8, hipSpread: 0.13, adsSpread: 0.095, recoil: 0.06, range: 11, velocity: 170, struct: 1.7, adsZoom: 2, adsMoveMul: 0.8 }),
    slots: {
      optic: ['iron', 'reddot', 'holo'],
      muzzle: ['nomuzzle', 'choke', 'suppressor'],
      barrel: ['stdbarrel', 'short', 'long'],
      magazine: ['stdmag', 'extmag', 'fastmag'],
      stock: ['stdstock', 'nostock', 'heavystock'],
      ammo: ['buck', 'slug', 'flechette'],
    },
    model: { length: 0.42, barrel: 0.36, bore: 0.065, stock: 0.24, mag: 'tube', color: 0x3b2a20, accent: 0x2b2e33 },
    sound: { body: 500, crack: 1.1, thump: 1.4, decay: 0.32 },
  },
  {
    id: 'sniper',
    name: 'Longbow .338',
    category: 'Sniper Rifle',
    blurb: 'Bolt action. One shot, one story.',
    base: S({ damage: 112, rpm: 44, auto: false, mag: 5, reload: 3.2, hipSpread: 0.11, adsSpread: 0.0012, recoil: 0.08, range: 140, velocity: 560, struct: 3.2, moveMul: 0.92, adsMoveMul: 0.45, adsZoom: 9, pierce: 1 }),
    slots: {
      optic: ['scope8', 'acog', 'thermal', 'reddot'],
      muzzle: ['nomuzzle', 'suppressor', 'brake'],
      barrel: ['stdbarrel', 'long', 'short'],
      magazine: ['stdmag', 'extmag', 'fastmag'],
      stock: ['stdstock', 'heavystock', 'lightstock'],
      ammo: ['fmj', 'ap', 'he', 'tracer'],
    },
    model: { length: 0.55, barrel: 0.55, bore: 0.05, stock: 0.3, mag: 'box', color: 0x4a5640, accent: 0x2a2d30 },
    sound: { body: 600, crack: 1.4, thump: 1.2, decay: 0.45 },
  },
  {
    id: 'dmr',
    name: 'Ranger DMR',
    category: 'Marksman Rifle',
    blurb: 'Fast semi-auto precision at mid range.',
    base: S({ damage: 46, rpm: 320, auto: false, mag: 15, reload: 2.4, hipSpread: 0.06, adsSpread: 0.005, recoil: 0.03, range: 75, velocity: 400, struct: 1.7, adsMoveMul: 0.55, adsZoom: 7 }),
    slots: {
      optic: ['iron', 'reddot', 'acog', 'scope8', 'thermal'],
      muzzle: ['nomuzzle', 'suppressor', 'compensator', 'brake'],
      barrel: ['stdbarrel', 'long', 'heavy'],
      magazine: ['stdmag', 'extmag', 'fastmag'],
      underbarrel: ['nounder', 'vgrip', 'bipod', 'laser'],
      ammo: ['fmj', 'ap', 'hp', 'tracer'],
    },
    model: { length: 0.52, barrel: 0.42, bore: 0.05, stock: 0.26, mag: 'box', color: 0x5b4a36, accent: 0x2d3034 },
    sound: { body: 700, crack: 1.2, thump: 0.9, decay: 0.3 },
  },
  {
    id: 'revolver',
    name: 'Magnum .44',
    category: 'Revolver',
    blurb: 'Six heavy rounds. Light, fast, honest.',
    base: S({ damage: 56, rpm: 170, auto: false, mag: 6, reload: 2.5, hipSpread: 0.03, adsSpread: 0.01, recoil: 0.05, range: 30, velocity: 270, struct: 1.8, moveMul: 1.1, adsMoveMul: 0.85, adsZoom: 3, reserve: 6 }),
    slots: {
      optic: ['iron', 'reddot', 'holo'],
      barrel: ['stdbarrel', 'short', 'long'],
      underbarrel: ['nounder', 'laser'],
      ammo: ['fmj', 'hp', 'ap', 'he'],
    },
    model: { length: 0.2, barrel: 0.16, bore: 0.045, stock: 0, mag: 'cylinder', color: 0x9aa1a8, accent: 0x5a3a28 },
    sound: { body: 650, crack: 1.3, thump: 1.1, decay: 0.3 },
  },
  {
    id: 'rocket',
    name: 'Thunder RPG',
    category: 'Rocket Launcher',
    blurb: 'Rewrites the map. Huge craters, falls trees, cracks bunkers.',
    base: S({ damage: 0, rpm: 50, auto: false, mag: 1, reload: 2.6, hipSpread: 0.02, adsSpread: 0.006, recoil: 0.1, range: 200, velocity: 46, struct: 0, moveMul: 0.88, adsMoveMul: 0.5, adsZoom: 8, reserve: 5, explosive: 4.2, blastDamage: 125, voxRadius: 2.8, projectile: 'rocket' }),
    slots: {
      optic: ['iron', 'reddot', 'acog'],
      barrel: ['stdbarrel', 'rifled'],
      ammo: ['hetip', 'breach', 'fragwar'],
    },
    model: { length: 0.4, barrel: 0.5, bore: 0.13, stock: 0, mag: 'none', color: 0x4d5a3a, accent: 0xb0412e, tube: true, bulky: true },
    sound: { body: 300, crack: 0.5, thump: 1.6, decay: 0.6 },
  },
  {
    id: 'gl',
    name: 'Thumper GL',
    category: 'Grenade Launcher',
    blurb: 'Lob explosives over cover and into windows.',
    base: S({ damage: 0, rpm: 100, auto: false, mag: 6, reload: 3.4, hipSpread: 0.03, adsSpread: 0.012, recoil: 0.06, range: 60, velocity: 24, gravity: 1, struct: 0, moveMul: 0.94, adsMoveMul: 0.6, adsZoom: 7, reserve: 3, explosive: 3.2, blastDamage: 85, voxRadius: 1.9, projectile: 'grenade' }),
    slots: {
      optic: ['iron', 'reddot', 'holo'],
      barrel: ['stdbarrel', 'rifled', 'short'],
      magazine: ['stdmag', 'fastmag', 'extmag'],
      ammo: ['impact', 'bounce'],
    },
    model: { length: 0.34, barrel: 0.24, bore: 0.1, stock: 0.2, mag: 'drum', color: 0x5c5a3a, accent: 0x2c2f33, bulky: true },
    sound: { body: 220, crack: 0.3, thump: 1.3, decay: 0.25 },
  },
  {
    id: 'minigun',
    name: 'Buzzsaw',
    category: 'Rotary Cannon',
    blurb: 'Needs a moment to spin up. Then nothing stands.',
    base: S({ damage: 15, rpm: 1700, mag: 180, reload: 5.2, hipSpread: 0.07, adsSpread: 0.045, recoil: 0.004, range: 30, velocity: 230, struct: 0.9, moveMul: 0.76, adsMoveMul: 0.55, adsZoom: 4, spinUp: 0.55, reserve: 2 }),
    slots: {
      barrel: ['stdbarrel', 'short', 'heavy'],
      magazine: ['stdmag', 'drum', 'fastmag'],
      underbarrel: ['nounder', 'laser', 'agrip'],
      ammo: ['fmj', 'ap', 'tracer', 'he'],
    },
    model: { length: 0.5, barrel: 0.42, bore: 0.11, stock: 0, mag: 'drum', color: 0x2f3338, accent: 0xc89b3c, rotary: true, bulky: true },
    sound: { body: 1100, crack: 0.7, thump: 0.6, decay: 0.08 },
  },
];

export const WEAPON: Record<string, WeaponDef> = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));

export type Build = Partial<Record<Slot, string>>;

export function defaultBuild(def: WeaponDef): Build {
  const b: Build = {};
  for (const [slot, list] of Object.entries(def.slots) as [Slot, string[]][]) b[slot] = list[0];
  return b;
}

export function computeStats(def: WeaponDef, build: Build): Stats {
  const s: Stats = { ...def.base };
  let zoomAdd = 0;
  for (const [slot, id] of Object.entries(build) as [Slot, string][]) {
    if (!def.slots[slot]?.includes(id)) continue;
    const a = ATT[id];
    if (!a) continue;
    const m = a.mod;
    if (m.damage) s.damage *= m.damage;
    if (m.pellets) s.pellets = Math.max(1, Math.round(s.pellets * m.pellets));
    if (m.rpm) s.rpm *= m.rpm;
    if (m.mag) s.mag = Math.max(1, Math.round(s.mag * m.mag));
    if (m.reload) s.reload *= m.reload;
    if (m.hipSpread) s.hipSpread *= m.hipSpread;
    if (m.adsSpread) s.adsSpread *= m.adsSpread;
    if (m.recoil) s.recoil *= m.recoil;
    if (m.range) s.range *= m.range;
    if (m.velocity) s.velocity *= m.velocity;
    if (m.struct) s.struct *= m.struct;
    if (m.moveMul) s.moveMul *= m.moveMul;
    if (m.adsMoveMul) s.adsMoveMul *= m.adsMoveMul;
    if (m.adsZoomAdd) zoomAdd += m.adsZoomAdd;
    if (m.explosive) s.explosive = s.explosive > 0 ? s.explosive * m.explosive : m.explosive;
    if (m.blastDamage) s.blastDamage = s.blastDamage > 0 ? s.blastDamage * m.blastDamage : m.blastDamage;
    if (m.voxRadius) s.voxRadius = s.voxRadius > 0 ? s.voxRadius * m.voxRadius : m.voxRadius;
    if (m.set) Object.assign(s, m.set);
  }
  s.adsZoom += zoomAdd;
  return s;
}

/** Normalised 0..1 ratings for the loadout UI. */
export function ratings(s: Stats) {
  const dps = (s.damage * s.pellets + s.blastDamage) * (s.rpm / 60);
  return [
    { label: 'Damage', v: Math.min(1, (s.damage * s.pellets + s.blastDamage) / 130) },
    { label: 'Fire rate', v: Math.min(1, s.rpm / 1700) },
    { label: 'Firepower', v: Math.min(1, dps / 420) },
    { label: 'Accuracy', v: Math.max(0, Math.min(1, 1 - s.adsSpread / 0.1)) },
    { label: 'Range', v: Math.min(1, s.range / 140) },
    { label: 'Handling', v: Math.min(1, (s.moveMul - 0.7) / 0.45) },
    { label: 'Destruction', v: Math.min(1, (s.struct * s.pellets * (s.rpm / 600) + s.voxRadius * 3) / 8) },
    { label: 'Capacity', v: Math.min(1, s.mag / 120) },
  ];
}

export type ItemId = 'frag' | 'smoke' | 'c4' | 'medkit';
export const ITEMS: { id: ItemId; name: string; count: number; desc: string }[] = [
  { id: 'frag', name: 'Frag Grenade', count: 3, desc: 'Cooked, thrown, bounced. Big blast that cracks cover.' },
  { id: 'smoke', name: 'Smoke Grenade', count: 2, desc: 'Thick cloud that blocks enemy sight lines for 14 s.' },
  { id: 'c4', name: 'Demo Charge', count: 2, desc: 'Sticks to whatever it hits. Press again to detonate. Levels buildings.' },
  { id: 'medkit', name: 'Field Medkit', count: 2, desc: 'Heals 70 HP over two seconds.' },
];

export interface Loadout {
  primary: { id: string; build: Build };
  secondary: { id: string; build: Build };
  item: ItemId;
}

export function randomLoadout(rng: () => number, prefer?: string): Loadout {
  const pick = (exclude?: string) => {
    let def = WEAPONS[(rng() * WEAPONS.length) | 0];
    if (prefer && !exclude) def = WEAPON[prefer] ?? def;
    while (def.id === exclude) def = WEAPONS[(rng() * WEAPONS.length) | 0];
    const build: Build = {};
    for (const [slot, list] of Object.entries(def.slots) as [Slot, string[]][]) build[slot] = list[(rng() * list.length) | 0];
    return { id: def.id, build };
  };
  const primary = pick();
  // secondaries lean toward sidearms / launchers so bots carry a varied kit
  const secondaryPool = ['revolver', 'smg', 'rocket', 'gl', 'shotgun'];
  let sid = secondaryPool[(rng() * secondaryPool.length) | 0];
  if (sid === primary.id) sid = 'revolver' === primary.id ? 'smg' : 'revolver';
  const sdef = WEAPON[sid];
  const sbuild: Build = {};
  for (const [slot, list] of Object.entries(sdef.slots) as [Slot, string[]][]) sbuild[slot] = list[(rng() * list.length) | 0];
  const items: ItemId[] = ['frag', 'frag', 'smoke', 'c4', 'medkit'];
  return { primary, secondary: { id: sid, build: sbuild }, item: items[(rng() * items.length) | 0] };
}
